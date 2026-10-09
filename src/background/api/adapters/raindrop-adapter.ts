import { Effect } from "effect";
import * as v from "valibot";
import { raindropConfigSchema, raindropSettingsSchema } from "../../../utils/settings-schemas";
export { raindropConfigSchema, raindropSettingsSchema };
import type { Article } from "../../../types/common";
import { logger } from "../../../utils/logger";
import { requestJson, validate } from "../effect-api-client";
import {
  ConfigurationFailure,
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

export type RaindropSettings = v.InferInput<typeof raindropSettingsSchema>;
export type RaindropConfig = v.InferInput<typeof raindropConfigSchema>;

const apiUrl = "https://api.raindrop.io/rest/v1";
const formConfig = [{ name: "apiKey", label: "API Key (Test Token)" }];

const raindropItemSchema = v.object({
  _id: v.number(),
  title: v.string(),
  link: v.string(),
  created: v.string(),
  cover: v.optional(v.nullable(v.string())),
  tags: v.array(v.string()),
  excerpt: v.optional(v.nullable(v.string())),
  type: v.optional(v.nullable(v.string())),
  domain: v.optional(v.nullable(v.string())),
  lastUpdate: v.optional(v.nullable(v.string())),
  important: v.optional(v.union([v.boolean(), v.number()])),
  collection: v.optional(v.object({ $id: v.number() })),
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

/** result=false is a definitive rejection; only a numeric error code is kept. */
const providerFailure = (operation: string) => (data: unknown) => {
  const parsed = v.safeParse(raindropErrorSchema, data);
  if (!parsed.success) return undefined;
  const { error } = parsed.output;
  return new ProviderFailure(operation, typeof error === "number" ? error : undefined);
};

const toArticle = (item: RaindropItem): Article => ({
  id: item._id,
  title: item.title,
  url: item.link,
  created_at: item.created,
});

/** The static API key never enters TokenManager, so it cannot reach refresh or token removal. */
export const createRaindropAdapter = Effect.fn("raindrop.acquire")(function* (
  settings: RaindropSettings,
) {
  const parsed = v.safeParse(raindropSettingsSchema, settings);
  const apiKey = parsed.success ? parsed.output.apiConfig.apiKey.trim() : "";
  if (!apiKey || /[\r\n]/.test(apiKey))
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
    displayName: "Raindrop.io",
    formConfig,
    saveArticle: Effect.fn("raindrop.save")(function* (article: SavingArticle) {
      const data = yield* request("raindrop.save", "/raindrop", {
        mutation: "save",
        confirms: raindropSaveResponseSchema,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ link: article.url, title: article.title }),
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
     * Raindrop Incremental Sync (PARTIAL SUPPORT)
     *
     * Raindrop supports incremental sync via search parameter with special syntax.
     * This is NOT a dedicated API parameter, but a search feature.
     *
     * LIMITATIONS:
     * - Only filters by creation date (created:>TIMESTAMP)
     * - Does NOT track deletions (deleted raindrops remain in local cache)
     * - Does NOT track updates to existing raindrops
     *
     * SEARCH SYNTAX: created:>UNIX_TIMESTAMP
     * - Timestamp must be Unix timestamp in SECONDS, not milliseconds
     * - API docs: https://developer.raindrop.io/
     *
     * STRATEGY:
     * - Use incremental sync for quick updates between periodic full syncs
     * - Perform full sync every 24-48 hours to catch deletions
     *
     * The first page's count fixes the page total; a missing count stops after page 0.
     */
    sync: Effect.fn("raindrop.sync")(function* (options?: SyncOptions) {
      const perPage = 50;
      const query = new URLSearchParams({
        page: "0",
        perpage: String(perPage),
        sort: "-created",
      });
      if (options?.lastSyncTimestamp && options.mode === "update") {
        const unixTimestamp = Math.floor(new Date(options.lastSyncTimestamp).getTime() / 1000);
        query.set("search", `created:>${unixTimestamp}`);
        logger.debug("Using Raindrop incremental sync with search syntax", {
          lastSyncTimestamp: options.lastSyncTimestamp,
          unixTimestamp,
        });
      }
      const articles: Article[] = [];
      let totalPages = 1;
      for (let page = 0; page < totalPages; page++) {
        // Raindrop allows 120 requests per minute; one second between pages stays well below it.
        if (page > 0) yield* Effect.sleep(1000);
        query.set("page", String(page));
        const data = yield* request("raindrop.sync", `/raindrops/0?${query.toString()}`);
        const result = yield* validate(raindropSyncResponseSchema, data, "raindrop.sync");
        articles.push(...result.items.map(toArticle));
        if (page === 0) totalPages = Math.ceil((result.count ?? 0) / perPage);
      }
      return {
        articles,
        mode: options?.mode ?? "overwrite",
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "1.0",
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

/** Legacy entry point removed with the remaining Promise callers in #81. */
export class RaindropAdapter implements ReadItLaterAPI<RaindropSettings> {
  readonly displayName = "Raindrop.io";
  readonly formConfig = formConfig;
  private ready: EffectAdapter | undefined;
  async initialize(settings: RaindropSettings): Promise<void> {
    this.ready = await runOperation(createRaindropAdapter(settings));
  }
  private api(): EffectAdapter {
    if (!this.ready) throw new ConfigurationFailure("raindrop.acquire");
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
