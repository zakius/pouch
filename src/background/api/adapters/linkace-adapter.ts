import { Effect } from "effect";
import * as v from "valibot";
import { linkaceConfigSchema, linkaceSettingsSchema } from "../../../utils/settings-schemas";
export { linkaceConfigSchema, linkaceSettingsSchema };
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
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";

export type LinkaceSettings = v.InferInput<typeof linkaceSettingsSchema>;
export type LinkaceConfig = v.InferInput<typeof linkaceConfigSchema>;

const linkaceLinkSchema = v.object({
  id: v.number(),
  url: v.string(),
  title: v.string(),
  description: v.optional(v.nullable(v.string())),
  created_at: v.string(),
  updated_at: v.optional(v.nullable(v.string())),
  lists: v.optional(v.array(v.object({ id: v.number(), name: v.string() }))),
  tags: v.optional(v.array(v.object({ id: v.number(), name: v.string() }))),
  visibility: v.optional(v.number()),
  check_disabled: v.optional(v.union([v.boolean(), v.number()])),
  status: v.optional(v.number()),
  icon: v.optional(v.nullable(v.string())),
  thumbnail: v.optional(v.nullable(v.string())),
});
const linkaceErrorSchema = v.object({ message: v.string() });
/** LinkAce answers a created link either wrapped in `data` or as the bare link. */
const linkaceSaveResponseSchema = v.union([
  v.object({ data: linkaceLinkSchema }),
  linkaceLinkSchema,
]);
/** Page totals come from `meta`, from Laravel's flat paginator fields, or not at all. */
const linkacePageSchema = v.object({
  data: v.array(linkaceLinkSchema),
  last_page: v.optional(v.number()),
  meta: v.optional(v.object({ last_page: v.number() })),
});

type LinkaceLink = v.InferOutput<typeof linkaceLinkSchema>;

/** A `message` envelope without `data` is a definitive rejection; the message may echo request data. */
const providerFailure = (operation: string) => (data: unknown) =>
  v.is(linkaceErrorSchema, data) && !("data" in data) ? new ProviderFailure(operation) : undefined;

const toArticle = (item: LinkaceLink): Article => ({
  id: item.id,
  title: item.title,
  url: item.url,
  created_at: item.created_at,
});

/** The static API token never enters TokenManager, so it cannot reach refresh or token removal. */
export const createLinkaceAdapter = Effect.fn("linkace.acquire")(function* (
  settings: LinkaceSettings,
) {
  const parsed = v.safeParse(linkaceSettingsSchema, settings);
  const token = parsed.success ? parsed.output.apiConfig.token.trim() : "";
  // A missing token must not degrade into an unauthenticated request.
  if (!parsed.success || !token || /[\r\n]/.test(token))
    return yield* Effect.fail(new ConfigurationFailure("linkace.acquire"));
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
      // Without it Laravel answers rejected authentication with a login redirect, not 401.
      init: {
        ...options.init,
        headers: {
          Accept: "application/json",
          ...(options.init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      },
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      authorization,
      providerFailure: providerFailure(operation),
      confirms: confirms && ((data) => v.is(confirms, data)),
    });
  };

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("linkace.save")(function* (article: SavingArticle) {
      const data = yield* request("linkace.save", "/api/v2/links", {
        mutation: "save",
        confirms: linkaceSaveResponseSchema,
        init: {
          method: "POST",
          body: JSON.stringify({
            url: article.url,
            title: article.title,
            visibility: 1, // 1 = public, 2 = internal, 3 = private
            check_disabled: false,
          }),
        },
      });
      const saved = yield* validate(linkaceSaveResponseSchema, data, "linkace.save");
      return toArticle("data" in saved ? saved.data : saved);
    }),
    deleteArticle: Effect.fn("linkace.delete")(function* (id: number | string) {
      yield* request("linkace.delete", `/api/v2/links/${encodeURIComponent(String(id))}`, {
        mutation: "delete",
        init: { method: "DELETE" },
      });
    }),
    /**
     * Update sync sends `created_after`, but LinkAce's link list does not honour it and
     * returns every link; the repository merges the full listing either way.
     *
     * Without a page total, a short page ends the listing. A non-empty page of only
     * already-seen links means the server ignored `page`, so sync fails instead of looping.
     */
    sync: Effect.fn("linkace.sync")(function* (options?: SyncOptions) {
      const perPage = 30;
      const query = new URLSearchParams({ per_page: String(perPage) });
      if (options?.lastSyncTimestamp && options.mode === "update") {
        query.set("created_after", options.lastSyncTimestamp);
        logger.debug("Sending LinkAce created_after (not honoured by the list endpoint)", {
          lastSyncTimestamp: options.lastSyncTimestamp,
        });
      }
      const articles: Article[] = [];
      const seen = new Set<number>();
      for (let page = 1; ; page++) {
        // Keeps the one-request-per-second pacing of the shared client this replaces.
        if (page > 1) yield* Effect.sleep(1000);
        query.set("page", String(page));
        const data = yield* request("linkace.sync", `/api/v2/links?${query.toString()}`);
        const result = yield* validate(linkacePageSchema, data, "linkace.sync");
        if (result.data.length > 0 && result.data.every((item) => seen.has(item.id)))
          return yield* Effect.fail(new IncompleteSnapshotFailure("linkace.sync"));
        for (const item of result.data) seen.add(item.id);
        articles.push(...result.data.map(toArticle));
        const lastPage = result.meta?.last_page ?? result.last_page;
        if (lastPage === undefined ? result.data.length !== perPage : page >= lastPage) break;
      }
      return {
        articles,
        mode: options?.mode ?? "overwrite",
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "2.0",
        },
      };
    }),
    testConnection: Effect.gen(function* () {
      const data = yield* request("linkace.testConnection", "/api/v2/links?per_page=1", {
        timeoutMs: 10000,
      });
      yield* validate(linkacePageSchema, data, "linkace.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  return adapter;
}) satisfies (settings: LinkaceSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;
