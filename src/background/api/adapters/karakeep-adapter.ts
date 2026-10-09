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
  runOperation,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";

export type KarakeepSettings = v.InferInput<typeof karakeepSettingsSchema>;
export type KarakeepConfig = v.InferInput<typeof karakeepConfigSchema>;

const formConfig = [
  { name: "url", label: "API URL" },
  { name: "token", label: "API Token" },
];

/** Karakeep's OpenAPI `Bookmark`: link bookmarks carry `url`, text and asset bookmarks may carry `sourceUrl`. */
const karakeepBookmarkSchema = v.object({
  id: v.string(),
  createdAt: v.string(),
  title: v.optional(v.nullable(v.string())),
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

const toArticle = (item: KarakeepBookmark, url: string): Article => ({
  id: item.id,
  title: item.title ?? item.content.title ?? url,
  url,
  created_at: item.createdAt,
});

/** The static API token never enters TokenManager, so it cannot reach refresh or token removal. */
export const createKarakeepAdapter = Effect.fn("karakeep.acquire")(function* (
  settings: KarakeepSettings,
) {
  const parsed = v.safeParse(karakeepSettingsSchema, settings);
  const token = parsed.success ? parsed.output.apiConfig.token.trim() : "";
  // A missing token must not degrade into an unauthenticated request.
  if (!parsed.success || !token || /[\r\n]/.test(token))
    return yield* Effect.fail(new ConfigurationFailure("karakeep.acquire"));
  // The configured URL is the API base, for example https://host/api/v1.
  const apiUrl = parsed.output.apiConfig.url.replace(/\/+$/, "");
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
    displayName: "Karakeep",
    formConfig,
    saveArticle: Effect.fn("karakeep.save")(function* (article: SavingArticle) {
      // 201 creates the bookmark; 200 returns the existing bookmark for the same URL.
      const data = yield* request("karakeep.save", "/bookmarks", {
        mutation: "save",
        confirms: karakeepBookmarkSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "link", url: article.url, title: article.title }),
        },
      });
      const saved = yield* validate(karakeepBookmarkSchema, data, "karakeep.save");
      return toArticle(saved, saved.content.url ?? article.url);
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
     * requested mode. Bookmarks without a URL (plain notes) are not articles.
     */
    sync: Effect.fn("karakeep.sync")(function* (_options?: SyncOptions) {
      const query = new URLSearchParams({ limit: "100" });
      const seen = new Set<string>();
      const articles: Article[] = [];
      for (let page = 0; ; page++) {
        // Keeps the one-request-per-second pacing of the shared client this replaces.
        if (page > 0) yield* Effect.sleep(1000);
        const data = yield* request("karakeep.sync", `/bookmarks?${query.toString()}`);
        const result = yield* validate(karakeepPageSchema, data, "karakeep.sync");
        for (const item of result.bookmarks) {
          const url = item.content.url ?? item.content.sourceUrl;
          if (url) articles.push(toArticle(item, url));
        }
        if (result.nextCursor === null) break;
        // A revisited cursor would never end; overwriting from a partial listing would drop articles.
        if (seen.has(result.nextCursor))
          return yield* Effect.fail(new IncompleteSnapshotFailure("karakeep.sync"));
        seen.add(result.nextCursor);
        query.set("cursor", result.nextCursor);
      }
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
      const data = yield* request("karakeep.testConnection", "/bookmarks?limit=1", {
        timeoutMs: 10000,
      });
      yield* validate(karakeepPageSchema, data, "karakeep.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: KarakeepSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;

/** Legacy entry point removed with the remaining Promise callers in #81. */
export class KarakeepAdapter implements ReadItLaterAPI<KarakeepSettings> {
  readonly displayName = "Karakeep";
  readonly formConfig = formConfig;
  private ready: EffectAdapter | undefined;
  async initialize(settings: KarakeepSettings): Promise<void> {
    this.ready = await runOperation(createKarakeepAdapter(settings));
  }
  private api(): EffectAdapter {
    if (!this.ready) throw new ConfigurationFailure("karakeep.acquire");
    return this.ready;
  }
  testConnection(): Promise<boolean> {
    return runOperation(this.api().testConnection);
  }
  saveArticle(article: SavingArticle): Promise<Article> {
    return runOperation(this.api().saveArticle(article));
  }
  deleteArticle(id: number | string): Promise<void> {
    return runOperation(this.api().deleteArticle(id));
  }
  sync(options?: SyncOptions): Promise<SyncResult> {
    return runOperation(this.api().sync(options));
  }
}
