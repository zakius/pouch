import { Effect } from "effect";
import * as v from "valibot";
import { karakeepConfigSchema, karakeepSettingsSchema } from "../../../utils/settings-schemas";
export { karakeepConfigSchema, karakeepSettingsSchema };
import type { Article } from "../../../types/common";
import { requestJson, validate } from "../effect-api-client";
import {
  ConfigurationFailure,
  IncompleteSnapshotFailure,
  ProviderFailure,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";

export type KarakeepSettings = v.InferInput<typeof karakeepSettingsSchema>;
export type KarakeepConfig = v.InferInput<typeof karakeepConfigSchema>;

/** Karakeep's OpenAPI `Bookmark`: link bookmarks carry `url`, text and asset bookmarks may carry `sourceUrl`. */
const karakeepBookmarkSchema = v.object({
  id: v.string(),
  createdAt: v.string(),
  title: v.optional(v.nullable(v.string())),
  archived: v.optional(v.boolean()),
  content: v.object({
    type: v.string(),
    url: v.optional(v.string()),
    sourceUrl: v.optional(v.nullable(v.string())),
    title: v.optional(v.nullable(v.string())),
  }),
});
const karakeepPageSchema = v.object({
  bookmarks: v.array(karakeepBookmarkSchema),
  nextCursor: v.nullable(v.string()),
});
/** The documented `{code, message}` error and the request validator's `{success: false}` body. */
const karakeepErrorSchema = v.union([
  v.object({ code: v.string(), message: v.string() }),
  v.object({ success: v.literal(false) }),
]);

type KarakeepBookmark = v.InferOutput<typeof karakeepBookmarkSchema>;

/** Error bodies may echo request data, so only the rejection itself is kept. */
const providerFailure = (operation: string) => (data: unknown) =>
  v.is(karakeepErrorSchema, data) ? new ProviderFailure(operation) : undefined;

const KARAKEEP_MAX_TITLE_LENGTH = 1000;

const normalizeApiUrl = (rawUrl: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.toLowerCase().endsWith("/api/v1") ? pathname : `${pathname}/api/v1`;
  return url.toString();
};

const toArticle = (item: KarakeepBookmark, url: string): Article => ({
  id: item.id,
  title: item.title?.trim() || item.content.title?.trim() || url,
  url,
  created_at: item.createdAt,
});

/** The static API token never enters TokenManager, so it cannot reach refresh or token removal. */
export const createKarakeepAdapter = Effect.fn("karakeep.acquire")(function* (
  settings: KarakeepSettings,
) {
  const parsed = v.safeParse(karakeepSettingsSchema, settings);
  const token = parsed.success ? parsed.output.apiConfig.token.trim() : "";
  const apiUrl = parsed.success ? normalizeApiUrl(parsed.output.apiConfig.url) : undefined;
  const includeArchived = parsed.success && parsed.output.apiConfig.includeArchived === true;
  // A missing token or non-HTTP(S) URL must not degrade into an unauthenticated or unsafe request.
  if (!parsed.success || !token || /[\r\n]/.test(token) || !apiUrl)
    return yield* Effect.fail(new ConfigurationFailure("karakeep.acquire"));
  const authorization = Effect.succeed(`Bearer ${token}`);

  const request = (
    operation: string,
    endpoint: string,
    options: {
      init?: RequestInit;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      confirms?: v.GenericSchema;
    } = {},
  ) => {
    const { confirms } = options;
    return requestJson({
      operation,
      url: `${apiUrl}${endpoint}`,
      init: options.init,
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      authorization,
      providerFailure: providerFailure(operation),
      confirms: confirms && ((data) => v.is(confirms, data)),
    });
  };

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("karakeep.save")(function* (article: SavingArticle) {
      const title = article.title.trim().slice(0, KARAKEEP_MAX_TITLE_LENGTH);
      // 201 creates the bookmark; 200 returns the existing bookmark for the same URL.
      // Omit empty titles so saving a bare link never clears an existing title on Karakeep v0.33.1+.
      const data = yield* request("karakeep.save", "/bookmarks", {
        mutation: "save",
        confirms: karakeepBookmarkSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "link",
            url: article.url,
            ...(title ? { title } : {}),
          }),
        },
      });
      const saved = yield* validate(karakeepBookmarkSchema, data, "karakeep.save");
      // Pre-v0.33.1 Karakeep returns a 200 duplicate still marked archived: true; unarchive it when
      // archived bookmarks are excluded from sync so the re-saved item does not vanish on next sync.
      if (!includeArchived && saved.archived === true) {
        yield* request("karakeep.save", `/bookmarks/${encodeURIComponent(saved.id)}`, {
          mutation: "save",
          init: {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: false }),
          },
        });
      }
      return toArticle(saved, saved.content.url || article.url);
    }),
    deleteArticle: Effect.fn("karakeep.delete")(function* (id: number | string) {
      yield* request("karakeep.delete", `/bookmarks/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        init: { method: "DELETE" },
      });
    }),
    /**
     * Karakeep's GET /bookmarks has no created-since or modified-since filter, so every sync
     * walks the whole cursor-paginated listing and returns overwrite mode regardless of the
     * requested mode. Excludes archived bookmarks (`archived=false`) unless `includeArchived` is
     * enabled. Bookmarks without a URL (plain notes) are not articles.
     */
    sync: Effect.fn("karakeep.sync")(function* (_options?: SyncOptions) {
      const query = new URLSearchParams({ limit: "100", includeContent: "false" });
      if (!includeArchived) query.set("archived", "false");
      const seen = new Set<string>();
      const articlesById = new Map<string, Article>();
      for (;;) {
        const data = yield* request("karakeep.sync", `/bookmarks?${query.toString()}`);
        const result = yield* validate(karakeepPageSchema, data, "karakeep.sync");
        for (const item of result.bookmarks) {
          const url = item.content.url || item.content.sourceUrl;
          if (url) articlesById.set(item.id, toArticle(item, url));
        }
        if (result.nextCursor === null) break;
        // A revisited cursor would never end; overwriting from a partial listing would drop articles.
        if (seen.has(result.nextCursor))
          return yield* Effect.fail(new IncompleteSnapshotFailure("karakeep.sync"));
        seen.add(result.nextCursor);
        query.set("cursor", result.nextCursor);
      }
      const articles = [...articlesById.values()];
      return {
        articles,
        mode: "overwrite" as const,
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "1.0",
        },
      };
    }),
    testConnection: Effect.gen(function* () {
      const data = yield* request(
        "karakeep.testConnection",
        "/bookmarks?limit=1&includeContent=false",
        {
          timeoutMs: 10000,
        },
      );
      yield* validate(karakeepPageSchema, data, "karakeep.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: KarakeepSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;
