import { Effect } from "effect";
import * as v from "valibot";
import { reportRemoteOutcome } from "../../../utils/fatal-storage";
import { logger } from "../../../utils/logger";
import { instapaperConfigSchema, instapaperSettingsSchema } from "../../../utils/settings-schemas";
export { instapaperConfigSchema, instapaperSettingsSchema };
import type { Article } from "../../../types/common";
import type { TokenManager } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import { requestJson, validate } from "../effect-api-client";
import {
  ConfigurationFailure,
  HttpFailure,
  IncompleteSnapshotFailure,
  ProviderFailure,
  RateLimitFailure,
  recordMutationSuccess,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type { SavingArticle, SyncMode, SyncOptions } from "../read-it-later-adapter";

export type InstapaperSettings = v.InferInput<typeof instapaperSettingsSchema>;
export type InstapaperConfig = v.InferInput<typeof instapaperConfigSchema>;

const apiUrl = "https://www.instapaper.com/api/2";
const INSTAPAPER_V2_SYNC_LIMIT = 500;
const INSTAPAPER_UPDATE_OVERLAP_SECONDS = 120;
const FULL_SYNC_IDLE_MS = 86_400_000;
const FULL_SYNC_OVERDUE_MS = 2 * FULL_SYNC_IDLE_MS;

/** Instapaper API v2 `Bookmark` object (`https://www.instapaper.com/api/2/openapi.json`). */
const instapaperBookmarkSchema = v.object({
  id: v.number(),
  url: v.nullish(v.string()),
  title: v.nullish(v.string()),
  time: v.nullish(v.number()),
  archived: v.optional(v.boolean()),
});

/** Instapaper API v2 `BookmarkList` response (`GET /api/2/bookmarks`). */
const instapaperBookmarkListSchema = v.object({
  bookmarks: v.array(instapaperBookmarkSchema),
  total: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  deleted_ids: v.optional(v.array(v.number())),
});

/** Instapaper API v2 `Error` envelope (`{ error: { code, message } }`). */
const instapaperErrorSchema = v.object({
  error: v.object({
    code: v.pipe(v.number(), v.safeInteger()),
    message: v.string(),
  }),
});

type InstapaperBookmark = v.InferOutput<typeof instapaperBookmarkSchema>;

function isValidBearerToken(value: string): boolean {
  if (!value || /[^\x21-\x7e]/.test(value)) return false;
  try {
    new Headers({ Authorization: `Bearer ${value}` });
    return true;
  } catch {
    return false;
  }
}

/** Error messages may echo request data or be reworded over time, so only the numeric code is kept. */
const providerFailure = (operation: string) => (data: unknown) => {
  const parsed = v.safeParse(instapaperErrorSchema, data);
  if (!parsed.success) return undefined;
  if (parsed.output.error.code === 429) return new RateLimitFailure(operation, 1000);
  return new ProviderFailure(operation, parsed.output.error.code);
};

const toArticle = (item: InstapaperBookmark, url: string, fallbackTimeMs = 0): Article => ({
  id: item.id,
  title: item.title?.trim() || url,
  url,
  created_at:
    typeof item.time === "number"
      ? new Date(item.time * 1000).toISOString()
      : new Date(fallbackTimeMs).toISOString(),
});

/**
 * Instapaper API v2 adapter using OAuth 2 / personal Bearer tokens.
 *
 * New v2 configurations never enter TokenManager or store user passwords. For seamless migration
 * from API v1, if `apiConfig.token` is missing/empty, an existing persisted v1 `oauth_token` in
 * `TokenManager` is reused directly as a v2 Bearer token (per Instapaper's v2 migration guide).
 */
export const createInstapaperAdapter = Effect.fn("instapaper.acquire")(function* (
  settings: InstapaperSettings,
  tokens: TokenManager = tokenManager,
) {
  const parsed = v.safeParse(instapaperSettingsSchema, settings);
  if (!parsed.success) return yield* Effect.fail(new ConfigurationFailure("instapaper.acquire"));

  const configuredToken = parsed.output.apiConfig.token?.trim() ?? "";
  const token =
    configuredToken || (tokens.getTokenMetadata("instapaper")?.accessToken?.trim() ?? "");
  if (!isValidBearerToken(token))
    return yield* Effect.fail(new ConfigurationFailure("instapaper.acquire"));

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
    const headers = new Headers(options.init?.headers);
    headers.set("Accept", "application/json");
    if (options.init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return requestJson({
      operation,
      url: `${apiUrl}${endpoint}`,
      init: {
        ...options.init,
        headers,
      },
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      authorization,
      providerFailure: providerFailure(operation),
      confirms: confirms && ((data) => v.is(confirms, data)),
    });
  };

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("instapaper.save")(function* (article: SavingArticle) {
      const title = article.title.trim();
      const data = yield* request("instapaper.save", "/bookmarks", {
        mutation: "save",
        confirms: instapaperBookmarkSchema,
        init: {
          method: "POST",
          body: JSON.stringify({
            url: article.url,
            canonicalize: Boolean(article.resolveFinalUrl),
            ...(title ? { title } : {}),
          }),
        },
      });
      const saved = yield* validate(instapaperBookmarkSchema, data, "instapaper.save");
      return toArticle(saved, saved.url?.trim() || article.url, Date.now());
    }),
    deleteArticle: Effect.fn("instapaper.delete")(function* (id: number | string) {
      yield* request("instapaper.delete", `/bookmarks/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        init: { method: "DELETE" },
      }).pipe(
        Effect.catchIf(
          (error) =>
            (error instanceof HttpFailure && error.status === 404) ||
            (error instanceof ProviderFailure && error.providerCode === 404),
          () =>
            Effect.gen(function* () {
              reportRemoteOutcome("delete", "succeeded");
              yield* recordMutationSuccess("delete");
              yield* storageHealthy;
            }),
        ),
      );
    }),
    /**
     * Instapaper API v2 Hybrid Sync (`offset`/`total` full snapshots + `since`/`deleted_ids` incremental)
     *
     * - Full `"overwrite"` sync paginates `GET /api/2/bookmarks?section=home&limit=500&offset=<n>`
     *   until `offset >= total`, removing API v1's 500-bookmark ceiling.
     * - Incremental `"update"` sync passes `since=<unix>` (with a 120s clock-skew overlap),
     *   advances `offset` by `bookmarks.length + deleted_ids.length` per page, treats `deleted_ids`
     *   and `archived: true` items as removals from the unread list, and stops when a page returns
     *   fewer than `limit` combined items or `offset >= total`.
     * - Periodic full syncs run at 24h when idle (or forced at 48h) as a reconciliation safety net.
     */
    sync: Effect.fn("instapaper.sync")(function* (options?: SyncOptions) {
      const parsedLastSyncMs = options?.lastSyncTimestamp
        ? Date.parse(options.lastSyncTimestamp)
        : Number.NaN;
      const hasValidLastSync = Number.isFinite(parsedLastSyncMs) && parsedLastSyncMs > 0;
      const lastFullSyncTimestamp = options?.lastFullSyncTimestamp;
      const elapsed =
        typeof lastFullSyncTimestamp === "number" &&
        Number.isFinite(lastFullSyncTimestamp) &&
        lastFullSyncTimestamp > 0
          ? Date.now() - lastFullSyncTimestamp
          : undefined;
      const overdue = elapsed !== undefined && elapsed >= FULL_SYNC_OVERDUE_MS;

      let mode: SyncMode;
      let reason: string;
      if (options?.mode === "overwrite") {
        mode = "overwrite";
        reason = "explicit_mode";
      } else if (options?.mode === "update") {
        if (hasValidLastSync) {
          mode = "update";
          reason = "explicit_mode";
        } else {
          mode = "overwrite";
          reason = "missing_last_sync";
        }
      } else if (elapsed === undefined || !hasValidLastSync) {
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

      logger.info("Instapaper sync mode decision", {
        mode,
        reason,
        timeSinceLastFullSync: elapsed,
        isBrowserIdle: options?.isBrowserIdle,
      });

      const query = new URLSearchParams({
        limit: String(INSTAPAPER_V2_SYNC_LIMIT),
        offset: "0",
      });
      if (mode === "update") {
        const since = Math.max(
          1,
          Math.floor(parsedLastSyncMs / 1000) - INSTAPAPER_UPDATE_OVERLAP_SECONDS,
        );
        query.set("since", String(since));
      } else {
        query.set("section", "home");
      }

      const seenBookmarkIds = new Set<number>();
      const seenDeletedIds = new Set<number>();
      const articlesById = new Map<number, Article>();
      const deletedIdSet = new Set<number>();

      let offset = 0;
      for (;;) {
        query.set("offset", String(offset));
        const data = yield* request("instapaper.sync", `/bookmarks?${query.toString()}`);
        const page = yield* validate(instapaperBookmarkListSchema, data, "instapaper.sync");

        const pageDeletedIds = mode === "update" ? (page.deleted_ids ?? []) : [];
        const received = page.bookmarks.length + pageDeletedIds.length;
        if (received === 0) {
          if (offset < page.total) {
            return yield* Effect.fail(new IncompleteSnapshotFailure("instapaper.sync"));
          }
          break;
        }

        let newItemsOnPage = 0;
        for (const item of page.bookmarks) {
          if (!seenBookmarkIds.has(item.id)) {
            seenBookmarkIds.add(item.id);
            newItemsOnPage++;
            if (mode === "update" && item.archived === true) {
              deletedIdSet.add(item.id);
              articlesById.delete(item.id);
            } else if (!deletedIdSet.has(item.id)) {
              const url = item.url?.trim();
              if (url) {
                articlesById.set(item.id, toArticle(item, url));
              }
            }
          }
        }
        for (const deletedId of pageDeletedIds) {
          if (!seenDeletedIds.has(deletedId)) {
            seenDeletedIds.add(deletedId);
            newItemsOnPage++;
          }
          deletedIdSet.add(deletedId);
          articlesById.delete(deletedId);
        }

        if (newItemsOnPage === 0) {
          return yield* Effect.fail(new IncompleteSnapshotFailure("instapaper.sync"));
        }

        offset += received;
        if (mode === "update") {
          if (received < INSTAPAPER_V2_SYNC_LIMIT || offset >= page.total) break;
        } else {
          if (offset >= page.total) break;
        }
      }

      const articles = [...articlesById.values()];
      const deletedIds = mode === "update" && deletedIdSet.size > 0 ? [...deletedIdSet] : undefined;
      return {
        articles,
        mode,
        ...(deletedIds ? { deletedIds } : {}),
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "2.0",
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
      const data = yield* request("instapaper.testConnection", "/bookmarks?limit=1", {
        timeoutMs: 10000,
      });
      yield* validate(instapaperBookmarkListSchema, data, "instapaper.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };

  yield* storageHealthy;
  return adapter;
}) satisfies (
  settings: InstapaperSettings,
  tokens?: TokenManager,
) => Effect.Effect<EffectAdapter, AcquisitionError>;
