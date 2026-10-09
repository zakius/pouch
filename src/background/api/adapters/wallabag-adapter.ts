import { logger } from "../../../utils/logger";
import { Effect, Semaphore } from "effect";
import * as v from "valibot";
import { wallabagConfigSchema, wallabagSettingsSchema } from "../../../utils/settings-schemas";
import { TokenManager, parseOAuthToken, tokenManager } from "../../token-manager";
import {
  checkHostPermission,
  requestJson,
  validate,
  type EffectRequest,
} from "../effect-api-client";
import {
  ConfigurationFailure,
  CredentialsFailure,
  HttpFailure,
  storageHealthy,
  type EffectAdapter,
  type AcquisitionError,
} from "../effect-adapter";
import type { Article } from "../../../types/common";
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";
export { wallabagConfigSchema, wallabagSettingsSchema };
export type WallabagSettings = v.InferInput<typeof wallabagSettingsSchema>;
export type WallabagConfig = v.InferInput<typeof wallabagConfigSchema>;
const wallabagTagSchema = v.object({
  id: v.number(),
  name: v.string(),
});

const wallabagItemSchema = v.object({
  id: v.union([
    v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    v.pipe(v.string(), v.regex(/^\d+$/)),
  ]),
  title: v.string(),
  url: v.string(),
  created_at: v.string(),
  tags: v.optional(v.array(wallabagTagSchema)),
  content: v.optional(v.nullable(v.string())),
  excerpt: v.optional(v.string()),
  domain_name: v.optional(v.string()),
  is_archived: v.optional(v.union([v.boolean(), v.number()])),
  is_starred: v.optional(v.union([v.boolean(), v.number()])),
  language: v.optional(v.nullable(v.string())),
  reading_time: v.optional(v.number()),
  preview_picture: v.optional(v.nullable(v.string())),
  user_name: v.optional(v.string()),
  user_email: v.optional(v.string()),
  user_id: v.optional(v.number()),
});

const wallabagErrorSchema = v.object({
  error: v.string(),
  error_description: v.optional(v.string()),
  message: v.optional(v.string()),
});

const wallabagSaveResponseSchema = v.union([wallabagItemSchema, wallabagErrorSchema]);

const wallabagSyncResponseSchema = v.union([
  v.object({
    _embedded: v.object({
      items: v.array(wallabagItemSchema),
    }),
    _links: v.optional(
      v.object({
        first: v.optional(v.object({ href: v.string() })),
        last: v.optional(v.object({ href: v.string() })),
        self: v.optional(v.object({ href: v.string() })),
      }),
    ),
    limit: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    page: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    pages: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    total: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  wallabagErrorSchema,
]);

export const createWallabagAdapter = Effect.fn("wallabag.acquire")(function* (
  settings: WallabagSettings,
  tokens: TokenManager = tokenManager,
) {
  const parsed = v.safeParse(wallabagSettingsSchema, settings);
  if (
    !parsed.success ||
    !parsed.output.apiConfig.password ||
    !parsed.output.apiConfig.clientId ||
    !parsed.output.apiConfig.clientSecret ||
    !parsed.output.apiConfig.username
  )
    return yield* Effect.fail(new ConfigurationFailure("wallabag.acquire"));
  const config = { ...parsed.output.apiConfig };
  const baseUrl = config.url.replace(/\/$/, "");
  const tokenUrl = `${baseUrl}/oauth/v2/token`;
  const generation = yield* tokens.bindAccount("wallabag", JSON.stringify(config));
  const owned = Effect.try({
    try: () => tokens.assertAccount("wallabag", generation),
    catch: () => new CredentialsFailure("wallabag.account"),
  });
  yield* checkHostPermission(baseUrl, "wallabag.acquire");
  yield* owned;
  tokens.setRefreshConfigProvider("wallabag", () => ({
    serviceName: "wallabag",
    refreshUrl: tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: tokens.getTokenMetadata("wallabag")?.refreshToken ?? "",
  }));
  const authenticate = Effect.gen(function* () {
    yield* owned;
    const data = yield* requestJson({
      operation: "wallabag.authenticate",
      url: tokenUrl,
      responseKind: "token",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          username: config.username,
          password: config.password || "",
        }),
      },
    });
    const token = yield* parseOAuthToken(data, "wallabag.authenticate");
    const now = Date.now();
    yield* tokens.storeToken(
      "wallabag",
      {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? "",
        tokenType: token.token_type ?? "Bearer",
        expiresAt: now + (token.expires_in ?? 3600) * 1000,
        issuedAt: now,
        scope: token.scope ?? undefined,
        refreshCount: 0,
      },
      "succeeded",
      "authentication",
      generation,
    );
  });
  const onAuthRejected = (authorization: string | undefined) =>
    Effect.gen(function* () {
      yield* owned;
      const token = tokens.getTokenMetadata("wallabag");
      if (token && !token.refreshToken && authorization === `Bearer ${token.accessToken}`)
        yield* tokens.discardRejectedToken("wallabag", token);
    });
  const recoverAuth = Effect.gen(function* () {
    yield* owned;
    const result = yield* tokens.refreshToken("wallabag");
    yield* owned;
    if (result.success) return;
    if (result.requiresReauth) return yield* authenticate;
    return yield* Effect.fail(result.failure ?? new CredentialsFailure("wallabag.refresh"));
  });
  if (!tokens.getTokenMetadata("wallabag")) yield* authenticate;
  const authorization = Effect.gen(function* () {
    yield* owned;
    const access = yield* tokens.getAccessToken("wallabag");
    yield* owned;
    if (!access) return yield* Effect.fail(new CredentialsFailure("wallabag.request"));
    // Wallabag issues token_type "bearer" but its OAuth server only matches "Bearer".
    return `Bearer ${access}`;
  });
  const pacing = yield* Semaphore.make(1);
  let lastRequestTime = 0;
  const beforeAttempt = pacing.withPermit(
    Effect.gen(function* () {
      yield* Effect.sleep(Math.max(0, 1000 - (Date.now() - lastRequestTime)));
      yield* storageHealthy;
      lastRequestTime = Date.now();
    }),
  );
  const request = (
    endpoint: string,
    options: Omit<EffectRequest, "url" | "authorization" | "recoverAuth">,
  ) =>
    requestJson({
      ...options,
      url: `${baseUrl}${endpoint}`,
      authorization,
      recoverAuth,
      onAuthRejected,
      beforeAttempt,
      authRetries: 2,
    });
  const toArticle = (item: v.InferOutput<typeof wallabagItemSchema>): Article => ({
    id: String(item.id),
    title: item.title,
    url: item.url,
    created_at: item.created_at,
  });
  const page = Effect.fn("wallabag.page")(function* (params: URLSearchParams) {
    const data = yield* request(`/api/entries.json?${params}`, { operation: "wallabag.sync" });
    const parsed = yield* validate(wallabagSyncResponseSchema, data, "wallabag.sync");
    if ("error" in parsed) return yield* Effect.fail(new HttpFailure("wallabag.sync", 200));
    return parsed;
  });
  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("wallabag.save")(function* (article: SavingArticle) {
      const data = yield* request("/api/entries.json", {
        operation: "wallabag.save",
        mutation: "save",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: article.url, title: article.title }),
        },
      });
      const parsed = yield* validate(wallabagSaveResponseSchema, data, "wallabag.save");
      if ("error" in parsed) return yield* Effect.fail(new HttpFailure("wallabag.save", 200));
      return toArticle(parsed);
    }),
    deleteArticle: Effect.fn("wallabag.delete")(function* (id: number | string) {
      yield* request(`/api/entries/${encodeURIComponent(String(id))}.json`, {
        operation: "wallabag.delete",
        mutation: "delete",
        init: { method: "DELETE" },
      });
    }),
    sync: Effect.fn("wallabag.sync")(function* (options?: SyncOptions) {
      const elapsed = options?.lastFullSyncTimestamp
        ? Date.now() - options.lastFullSyncTimestamp
        : undefined;
      const mode =
        options?.mode ??
        (elapsed === undefined || (elapsed >= 86400000 && options?.isBrowserIdle)
          ? "overwrite"
          : "update");
      const reason = options?.mode
        ? "explicit_mode"
        : elapsed === undefined
          ? "first_sync"
          : mode === "overwrite"
            ? "24h_idle"
            : "incremental";
      logger.info("Wallabag sync mode decision", {
        mode,
        reason,
        timeSinceLastFullSync: elapsed,
        isBrowserIdle: options?.isBrowserIdle,
      });
      const params = new URLSearchParams({ page: "1", perPage: "30", detail: "metadata" });
      // Wallabag's since filter excludes deletions; only a full snapshot reconciles them.
      if (mode === "update" && options?.lastSyncTimestamp)
        params.set("since", String(Math.floor(Date.parse(options.lastSyncTimestamp) / 1000)));
      const first = yield* page(params);
      const articles = first._embedded.items.map(toArticle);
      const totalPages = Math.ceil(first.total / 30);
      for (let index = 2; index <= totalPages; index++) {
        params.set("page", String(index));
        const next = yield* page(params);
        articles.push(...next._embedded.items.map(toArticle));
      }
      return {
        articles,
        mode,
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
      const data = yield* request("/api/entries.json?page=1&perPage=1", {
        operation: "wallabag.testConnection",
        timeoutMs: 10000,
      });
      const parsed = yield* validate(wallabagSyncResponseSchema, data, "wallabag.testConnection");
      if ("error" in parsed)
        return yield* Effect.fail(new HttpFailure("wallabag.testConnection", 200));
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  // Invalidation during the acquisition's own token persistence must not return a ready adapter.
  yield* owned;
  return adapter;
}) satisfies (
  settings: WallabagSettings,
  tokens?: TokenManager,
) => Effect.Effect<EffectAdapter, AcquisitionError>;
