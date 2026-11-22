import { Effect } from "effect";
import * as v from "valibot";
import { raindropConfigSchema, raindropSettingsSchema } from "../../../utils/settings-schemas";
export { raindropConfigSchema, raindropSettingsSchema };
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
} from "../effect-adapter";
import type { SavingArticle, SyncMode, SyncOptions } from "../read-it-later-adapter";

export type RaindropSettings = v.InferInput<typeof raindropSettingsSchema>;
export type RaindropConfig = v.InferInput<typeof raindropConfigSchema>;

const apiUrl = "https://api.raindrop.io/rest/v1";
const RAINDROP_SYNC_PER_PAGE = 50;
const RAINDROP_PAGE_DELAY_MS = 500;
const RAINDROP_UPDATE_OVERLAP_MS = 120_000;
const FULL_SYNC_IDLE_MS = 86_400_000;
const FULL_SYNC_OVERDUE_MS = 2 * FULL_SYNC_IDLE_MS;

const raindropItemSchema = v.object({
  _id: v.number(),
  title: v.nullish(v.string()),
  link: v.string(),
  created: v.string(),
});

const raindropErrorSchema = v.object({
  result: v.literal(false),
  error: v.optional(v.unknown()),
});
const raindropSuccessSchema = v.object({ result: v.literal(true) });
const raindropSaveResponseSchema = v.object({
  result: v.literal(true),
  item: raindropItemSchema,
});
const raindropSyncResponseSchema = v.object({
  result: v.literal(true),
  items: v.array(raindropItemSchema),
  count: v.optional(v.number()),
});

type RaindropItem = v.InferOutput<typeof raindropItemSchema>;

function isValidApiKey(value: string): boolean {
  if (!value || /[^\x21-\x7e]/.test(value)) return false;
  try {
    new Headers({ Authorization: `Bearer ${value}` });
    return true;
  } catch {
    return false;
  }
}

/** result=false is a definitive rejection; only a numeric error code is kept. */
const providerFailure = (operation: string) => (data: unknown) => {
  const parsed = v.safeParse(raindropErrorSchema, data);
  if (!parsed.success) return undefined;
  const { error } = parsed.output;
  return new ProviderFailure(operation, typeof error === "number" ? error : undefined);
};

const toArticle = (item: RaindropItem): Article => ({
  id: item._id,
  title: item.title?.trim() || item.link,
  url: item.link,
  created_at: item.created,
});

/** The static API key never enters TokenManager, so it cannot reach refresh or token removal. */
export const createRaindropAdapter = Effect.fn("raindrop.acquire")(function* (
  settings: RaindropSettings,
) {
  const parsed = v.safeParse(raindropSettingsSchema, settings);
  const apiKey = parsed.success ? parsed.output.apiConfig.apiKey.trim() : "";
  if (!isValidApiKey(apiKey))
    return yield* Effect.fail(new ConfigurationFailure("raindrop.acquire"));
  const authorization = Effect.succeed(`Bearer ${apiKey}`);

  const request = (
    operation: string,
    endpoint: string,
    options: {
      init?: RequestInit;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      /** Mutations confirm success only on this shape; anything else leaves the outcome unknown. */
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
    saveArticle: Effect.fn("raindrop.save")(function* (article: SavingArticle) {
      const title = article.title.trim();
      const data = yield* request("raindrop.save", "/raindrop", {
        mutation: "save",
        confirms: raindropSaveResponseSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            link: article.url,
            pleaseParse: {},
            ...(title ? { title } : {}),
          }),
        },
      });
      const saved = yield* validate(raindropSaveResponseSchema, data, "raindrop.save");
      return toArticle(saved.item);
    }),
    deleteArticle: Effect.fn("raindrop.delete")(function* (id: number | string) {
      yield* request("raindrop.delete", `/raindrop/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        confirms: raindropSuccessSchema,
        init: { method: "DELETE" },
      });
    }),
    /**
     * Raindrop Hybrid Incremental Sync
     *
     * Raindrop's `created:` search operator only supports calendar dates (YYYY-MM-DD),
     * not timestamps. Incremental sync instead paginates `sort=-created` (newest first)
     * and stops early once items older than `lastSyncTimestamp - 2 min` are reached.
     *
     * LIMITATIONS:
     * - Incremental sync only catches newly created raindrops (not deletions or edits to older items)
     * - Periodic full syncs run at 24h when idle (or forced at 48h) to reconcile deletions
     */
    sync: Effect.fn("raindrop.sync")(function* (options?: SyncOptions) {
      const parsedLastSyncMs = options?.lastSyncTimestamp
        ? Date.parse(options.lastSyncTimestamp)
        : Number.NaN;
      const hasValidLastSync = Number.isFinite(parsedLastSyncMs);
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

      logger.info("Raindrop sync mode decision", {
        mode,
        reason,
        timeSinceLastFullSync: elapsed,
        isBrowserIdle: options?.isBrowserIdle,
      });

      const cutoffMs =
        mode === "update" ? parsedLastSyncMs - RAINDROP_UPDATE_OVERLAP_MS : undefined;
      const query = new URLSearchParams({
        page: "0",
        perpage: String(RAINDROP_SYNC_PER_PAGE),
        sort: "-created",
      });
      const seenIds = new Set<number>();
      const articlesById = new Map<number, Article>();
      for (let page = 0; ; page++) {
        // Raindrop allows 120 requests per minute (2 req/sec); 500ms between pages stays within it.
        if (page > 0) yield* Effect.sleep(RAINDROP_PAGE_DELAY_MS);
        query.set("page", String(page));
        const data = yield* request("raindrop.sync", `/raindrops/0?${query.toString()}`);
        const result = yield* validate(raindropSyncResponseSchema, data, "raindrop.sync");
        if (
          page === 0 &&
          mode === "overwrite" &&
          result.items.length === 0 &&
          result.count !== undefined &&
          result.count > 0
        ) {
          return yield* Effect.fail(new IncompleteSnapshotFailure("raindrop.sync"));
        }
        let newIdsOnPage = 0;
        let reachedCutoff = false;
        for (const item of result.items) {
          if (!seenIds.has(item._id)) {
            seenIds.add(item._id);
            newIdsOnPage++;
          }
          if (cutoffMs !== undefined) {
            const createdMs = Date.parse(item.created);
            if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
              reachedCutoff = true;
              continue;
            }
          }
          articlesById.set(item._id, toArticle(item));
        }
        if (result.items.length >= RAINDROP_SYNC_PER_PAGE && newIdsOnPage === 0) {
          return yield* Effect.fail(new IncompleteSnapshotFailure("raindrop.sync"));
        }
        if (reachedCutoff || result.items.length < RAINDROP_SYNC_PER_PAGE) break;
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
      const data = yield* request("raindrop.testConnection", "/collections", { timeoutMs: 10000 });
      yield* validate(raindropSuccessSchema, data, "raindrop.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: RaindropSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;
