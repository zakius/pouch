import { Effect } from "effect";
import * as v from "valibot";
import { linkwardenConfigSchema, linkwardenSettingsSchema } from "../../../utils/settings-schemas";
export { linkwardenConfigSchema, linkwardenSettingsSchema };
import type { Article } from "../../../types/common";
import { logger } from "../../../utils/logger";
import { requestJson, validate } from "../effect-api-client";
import {
  ConfigurationFailure,
  IncompleteSnapshotFailure,
  ProviderFailure,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
  type TransportError,
} from "../effect-adapter";
import type { SavingArticle, SyncMode, SyncOptions } from "../read-it-later-adapter";

export type LinkwardenSettings = v.InferInput<typeof linkwardenSettingsSchema>;
export type LinkwardenConfig = v.InferInput<typeof linkwardenConfigSchema>;

const LINKWARDEN_MAX_NAME_LENGTH = 2048;
const FULL_SYNC_IDLE_MS = 86_400_000;
const FULL_SYNC_OVERDUE_MS = 2 * FULL_SYNC_IDLE_MS;
const LINKWARDEN_COLLECTION_NOT_ACCESSIBLE = "Collection is not accessible.";

/** Linkwarden's Prisma `Link`: uploaded PDFs and images have no `url`. */
const linkwardenLinkSchema = v.object({
  id: v.number(),
  name: v.string(),
  url: v.nullable(v.string()),
  createdAt: v.string(),
});
/** POST /api/v1/links and DELETE /api/v1/links/:id answer `{response: Link}`. */
const linkwardenLinkResponseSchema = v.object({ response: linkwardenLinkSchema });
/** GET /api/v1/search; `nextCursor` is the last link id of a full page, or null. */
const linkwardenPageSchema = v.object({
  data: v.object({
    links: v.array(linkwardenLinkSchema),
    nextCursor: v.nullable(v.number()),
  }),
});
/** Every Linkwarden route rejects with `{response: "<message>"}`. */
const linkwardenErrorSchema = v.object({ response: v.string() });

type LinkwardenLink = v.InferOutput<typeof linkwardenLinkSchema>;

/** Error messages may echo request data, so only the rejection itself is kept. */
const providerFailure = (operation: string) => (data: unknown) =>
  v.is(linkwardenErrorSchema, data) ? new ProviderFailure(operation) : undefined;

/**
 * Linkwarden returns HTTP 401 with `"Collection is not accessible."` when deleting a link
 * in a shared collection without delete permission or one already deleted remotely.
 */
const deleteUnauthorizedFailure = (data: unknown) =>
  v.is(linkwardenErrorSchema, data) && data.response === LINKWARDEN_COLLECTION_NOT_ACCESSIBLE
    ? new ProviderFailure("linkwarden.delete", 401)
    : undefined;

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
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  url.pathname = `${pathname}/api/v1`;
  return url.toString();
};

const toArticle = (item: LinkwardenLink, url: string): Article => ({
  id: item.id,
  title: item.name,
  url,
  created_at: item.createdAt,
});

/** The static API token never enters TokenManager, so it cannot reach refresh or token removal. */
export const createLinkwardenAdapter = Effect.fn("linkwarden.acquire")(function* (
  settings: LinkwardenSettings,
) {
  const parsed = v.safeParse(linkwardenSettingsSchema, settings);
  const token = parsed.success ? parsed.output.apiConfig.token.trim() : "";
  const apiUrl = parsed.success ? normalizeApiUrl(parsed.output.apiConfig.url) : undefined;
  // A missing token or non-HTTP(S) URL must not degrade into an unauthenticated or unsafe request.
  if (!parsed.success || !token || /[\r\n]/.test(token) || !apiUrl)
    return yield* Effect.fail(new ConfigurationFailure("linkwarden.acquire"));
  const authorization = Effect.succeed(`Bearer ${token}`);

  const request = (
    operation: string,
    endpoint: string,
    options: {
      init?: RequestInit;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      confirms?: v.GenericSchema;
      classifyUnauthorized?: (data: unknown) => TransportError | undefined;
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
      classifyUnauthorized: options.classifyUnauthorized,
      confirms: confirms && ((data) => v.is(confirms, data)),
    });
  };

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("linkwarden.save")(function* (article: SavingArticle) {
      const name = article.title.trim().slice(0, LINKWARDEN_MAX_NAME_LENGTH);
      // A duplicate URL is a 409 rejection when the user prevents duplicate links.
      const data = yield* request("linkwarden.save", "/links", {
        mutation: "save",
        confirms: linkwardenLinkResponseSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: article.url, ...(name ? { name } : {}) }),
        },
      });
      const saved = yield* validate(linkwardenLinkResponseSchema, data, "linkwarden.save");
      return toArticle(saved.response, saved.response.url ?? article.url);
    }),
    deleteArticle: Effect.fn("linkwarden.delete")(function* (id: number | string) {
      yield* request("linkwarden.delete", `/links/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        confirms: linkwardenLinkResponseSchema,
        classifyUnauthorized: deleteUnauthorizedFailure,
        init: { method: "DELETE" },
      });
    }),
    /**
     * Linkwarden Hybrid Incremental Sync
     *
     * Linkwarden's `GET /api/v1/search?sort=0` orders strictly by `id desc` (no pinned-first
     * ordering) and has no created-since or modified-since filter. Incremental sync stops
     * paginating early as soon as any link on a page has `id <= maxKnownNumericId`.
     *
     * LIMITATIONS:
     * - Incremental sync only catches newly created links (not deletions or edits to older links)
     * - Periodic full syncs run at 24h when idle (or forced at 48h) to reconcile deletions
     * - Uploaded files without a URL are not articles
     */
    sync: Effect.fn("linkwarden.sync")(function* (options?: SyncOptions) {
      const maxKnownNumericId =
        typeof options?.maxKnownNumericId === "number" &&
        Number.isSafeInteger(options.maxKnownNumericId) &&
        options.maxKnownNumericId > 0
          ? options.maxKnownNumericId
          : undefined;
      const lastFullSyncTimestamp = options?.lastFullSyncTimestamp;
      const elapsed =
        typeof lastFullSyncTimestamp === "number" &&
        Number.isFinite(lastFullSyncTimestamp) &&
        lastFullSyncTimestamp > 0
          ? Date.now() - lastFullSyncTimestamp
          : undefined;
      // Full syncs wait for idle, but not past 48h: an always-active browser would never reconcile deletions.
      const overdue = elapsed !== undefined && elapsed >= FULL_SYNC_OVERDUE_MS;

      let mode: SyncMode;
      let reason: string;
      if (options?.mode === "overwrite") {
        mode = "overwrite";
        reason = "explicit_mode";
      } else if (options?.mode === "update") {
        if (maxKnownNumericId !== undefined) {
          mode = "update";
          reason = "explicit_mode";
        } else {
          mode = "overwrite";
          reason = "missing_known_id";
        }
      } else if (elapsed === undefined || maxKnownNumericId === undefined) {
        mode = "overwrite";
        reason = "first_sync";
      } else if (overdue) {
        mode = "overwrite";
        reason = "48h_overdue";
      } else if (elapsed >= FULL_SYNC_IDLE_MS && options?.isBrowserIdle) {
        mode = "overwrite";
        reason = "24h_idle";
      } else {
        mode = "update";
        reason = "incremental";
      }

      logger.info("Linkwarden sync mode decision", {
        mode,
        reason,
        timeSinceLastFullSync: elapsed,
        isBrowserIdle: options?.isBrowserIdle,
        maxKnownNumericId,
      });

      const stopAtId = mode === "update" ? maxKnownNumericId : undefined;
      const query = new URLSearchParams({ sort: "0" });
      const seenCursors = new Set<number>();
      const articlesById = new Map<number, Article>();
      for (;;) {
        const data = yield* request("linkwarden.sync", `/search?${query.toString()}`);
        const result = yield* validate(linkwardenPageSchema, data, "linkwarden.sync");
        let reachedKnown = false;
        for (const item of result.data.links) {
          if (stopAtId !== undefined && item.id <= stopAtId) {
            reachedKnown = true;
            continue;
          }
          if (item.url) articlesById.set(item.id, toArticle(item, item.url));
        }
        if (reachedKnown) break;
        const cursor = result.data.nextCursor;
        if (cursor === null) break;
        // A revisited cursor would never end; overwriting from a partial listing would drop articles.
        if (seenCursors.has(cursor))
          return yield* Effect.fail(new IncompleteSnapshotFailure("linkwarden.sync"));
        seenCursors.add(cursor);
        query.set("cursor", String(cursor));
      }
      const articles = [...articlesById.values()];
      return {
        articles,
        mode,
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "1.0",
          syncDecision: {
            reason,
            wasFullSync: mode === "overwrite",
            timeSinceLastFullSync: elapsed,
            isBrowserIdle: options?.isBrowserIdle,
          },
        },
      };
    }),
    testConnection: Effect.gen(function* () {
      const data = yield* request("linkwarden.testConnection", "/search?pinnedOnly=true", {
        timeoutMs: 10000,
      });
      yield* validate(linkwardenPageSchema, data, "linkwarden.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: LinkwardenSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;
