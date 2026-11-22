import { logger } from "../../../utils/logger";
import { Cause, Effect, Exit, Fiber } from "effect";
import * as v from "valibot";
import { reportRemoteOutcome, storageShutdownSignal } from "../../../utils/fatal-storage";
import { wallabagConfigSchema, wallabagSettingsSchema } from "../../../utils/settings-schemas";
import type { TokenManager } from "../../token-manager";
import { parseOAuthToken, tokenManager } from "../../token-manager";
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
  recordMutationSuccess,
  storageHealthy,
  type EffectAdapter,
  type AcquisitionError,
  type TransportError,
} from "../effect-adapter";
import type { Article } from "../../../types/common";
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";
export { wallabagConfigSchema, wallabagSettingsSchema };
export type WallabagSettings = v.InferInput<typeof wallabagSettingsSchema>;
export type WallabagConfig = v.InferInput<typeof wallabagConfigSchema>;

const WALLABAG_SYNC_PER_PAGE = 150;
const WALLABAG_SINCE_OVERLAP_SECONDS = 120;
const wallabagItemSchema = v.object({
  id: v.union([
    v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    v.pipe(v.string(), v.regex(/^\d+$/)),
  ]),
  title: v.nullish(v.string()),
  url: v.nullish(v.string()),
  given_url: v.nullish(v.string()),
  created_at: v.string(),
});

const wallabagErrorSchema = v.object({
  error: v.string(),
  error_description: v.optional(v.string()),
  message: v.optional(v.string()),
});

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
  const baseUrl = config.url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
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
  const runAuthenticate: Effect.Effect<void, TransportError> = Effect.gen(function* () {
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
  let authFiber: Fiber.Fiber<void, TransportError> | undefined;
  const authenticate: Effect.Effect<void, TransportError> = Effect.suspend(() => {
    if (authFiber) return Fiber.join(authFiber);
    return Effect.forkDetach(runAuthenticate).pipe(
      Effect.flatMap((fiber) => {
        if (authFiber) {
          fiber.interruptUnsafe();
          return Fiber.join(authFiber);
        }
        authFiber = fiber;
        const shutdown = storageShutdownSignal();
        const stop = () => fiber.interruptUnsafe();
        shutdown.addEventListener("abort", stop, { once: true });
        if (shutdown.aborted) stop();
        fiber.addObserver((exit) => {
          shutdown.removeEventListener("abort", stop);
          if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
            logger.error("Wallabag authentication died:", Cause.pretty(exit.cause));
          if (authFiber === fiber) authFiber = undefined;
        });
        return Fiber.join(fiber);
      }),
    );
  });
  const onAuthRejected = (authorization: string | undefined) =>
    Effect.gen(function* () {
      yield* owned;
      const token = tokens.getTokenMetadata("wallabag");
      if (token && !token.refreshToken && authorization === `Bearer ${token.accessToken}`)
        yield* tokens.discardRejectedToken("wallabag", token);
    });
  const hasRotatedToken = (rejectedAuthorization: string | undefined) => {
    const current = tokens.getTokenMetadata("wallabag");
    if (!current || Date.now() >= current.expiresAt) return false;
    return (
      rejectedAuthorization === undefined ||
      `Bearer ${current.accessToken}` !== rejectedAuthorization
    );
  };
  const recoverAuth = (getRejectedAuthorization: () => string | undefined) =>
    Effect.gen(function* () {
      yield* owned;
      const rejectedAuthorization = getRejectedAuthorization();
      if (hasRotatedToken(rejectedAuthorization)) return;
      const result = yield* tokens.refreshToken("wallabag");
      yield* owned;
      if (result.success) return;
      if (hasRotatedToken(rejectedAuthorization)) return;
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
  const request = (
    endpoint: string,
    options: Omit<EffectRequest, "url" | "authorization" | "recoverAuth">,
  ) =>
    Effect.suspend(() => {
      let rejectedAuthorization: string | undefined;
      return requestJson({
        ...options,
        url: `${baseUrl}${endpoint}`,
        authorization: Effect.gen(function* () {
          rejectedAuthorization = undefined;
          return yield* authorization;
        }),
        recoverAuth: recoverAuth(() => rejectedAuthorization),
        onAuthRejected: (header) =>
          Effect.gen(function* () {
            rejectedAuthorization = header;
            yield* onAuthRejected(header);
          }),
        authRetries: 2,
      });
    });
  const toArticle = (
    item: v.InferOutput<typeof wallabagItemSchema>,
    url: string,
    fallbackGivenUrl?: string,
  ): Article => {
    const candidateGivenUrl = item.given_url?.trim();
    const fallback = fallbackGivenUrl?.trim();
    const givenUrl =
      candidateGivenUrl && candidateGivenUrl !== url
        ? candidateGivenUrl
        : fallback && fallback !== url
          ? fallback
          : undefined;
    return {
      id: String(item.id),
      title: item.title?.trim() || url,
      url,
      ...(givenUrl ? { givenUrl } : {}),
      created_at: item.created_at,
    };
  };
  const toArticles = (items: readonly v.InferOutput<typeof wallabagItemSchema>[]) => {
    const result: Article[] = [];
    for (const item of items) {
      const url = item.url?.trim() || item.given_url?.trim();
      if (url) result.push(toArticle(item, url));
    }
    return result;
  };
  const page = Effect.fn("wallabag.page")(function* (params: URLSearchParams) {
    const data = yield* request(`/api/entries.json?${params}`, { operation: "wallabag.sync" });
    const parsed = yield* validate(wallabagSyncResponseSchema, data, "wallabag.sync");
    if ("error" in parsed) return yield* Effect.fail(new HttpFailure("wallabag.sync", 200));
    return parsed;
  });
  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("wallabag.save")(function* (article: SavingArticle) {
      // Wallabag 2.7+ treats an empty title as null, overwriting the scraped title.
      const body = article.title.trim()
        ? { url: article.url, title: article.title }
        : { url: article.url };
      const data = yield* request("/api/entries.json", {
        operation: "wallabag.save",
        mutation: "save",
        timeoutMs: 60_000,
        confirms: (payload) => v.is(wallabagItemSchema, payload),
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      });
      const parsed = yield* validate(wallabagItemSchema, data, "wallabag.save");
      const url = parsed.url?.trim() || parsed.given_url?.trim() || article.url;
      return toArticle(parsed, url, article.url);
    }),
    deleteArticle: Effect.fn("wallabag.delete")(function* (id: number | string) {
      yield* request(`/api/entries/${encodeURIComponent(String(id))}.json`, {
        operation: "wallabag.delete",
        mutation: "delete",
        init: { method: "DELETE" },
      }).pipe(
        Effect.catchIf(
          (error) => error instanceof HttpFailure && error.status === 404,
          () =>
            Effect.gen(function* () {
              reportRemoteOutcome("delete", "succeeded");
              yield* recordMutationSuccess("delete");
              yield* storageHealthy;
            }),
        ),
      );
    }),
    sync: Effect.fn("wallabag.sync")(function* (options?: SyncOptions) {
      const elapsed = options?.lastFullSyncTimestamp
        ? Date.now() - options.lastFullSyncTimestamp
        : undefined;
      // Full syncs wait for idle, but not past 48h: an always-active browser would never reconcile deletions.
      const overdue = elapsed !== undefined && elapsed >= 2 * 86400000;
      const mode =
        options?.mode ??
        (elapsed === undefined || overdue || (elapsed >= 86400000 && options?.isBrowserIdle)
          ? "overwrite"
          : "update");
      const reason = options?.mode
        ? "explicit_mode"
        : elapsed === undefined
          ? "first_sync"
          : overdue
            ? "48h_overdue"
            : mode === "overwrite"
              ? "24h_idle"
              : "incremental";
      logger.info("Wallabag sync mode decision", {
        mode,
        reason,
        timeSinceLastFullSync: elapsed,
        isBrowserIdle: options?.isBrowserIdle,
      });
      const params = new URLSearchParams({
        page: "1",
        perPage: String(WALLABAG_SYNC_PER_PAGE),
        detail: "metadata",
        sort: "created",
        order: "asc",
      });
      // Wallabag's since filter excludes deletions; only a full snapshot reconciles them.
      if (mode === "update" && options?.lastSyncTimestamp) {
        const parsedMs = Date.parse(options.lastSyncTimestamp);
        if (Number.isFinite(parsedMs)) {
          const since = Math.max(0, Math.floor(parsedMs / 1000) - WALLABAG_SINCE_OVERLAP_SECONDS);
          params.set("since", String(since));
        }
      }
      const first = yield* page(params);
      const articlesById = new Map<string, Article>();
      const collect = (items: readonly v.InferOutput<typeof wallabagItemSchema>[]) => {
        for (const article of toArticles(items)) {
          articlesById.set(String(article.id), article);
        }
      };
      collect(first._embedded.items);
      let totalPages = first.pages;
      if (first._embedded.items.length > 0) {
        for (let index = 2; index <= totalPages; index++) {
          params.set("page", String(index));
          const next = yield* page(params).pipe(
            Effect.catchIf(
              (error) => error instanceof HttpFailure && error.status === 404,
              () => Effect.succeed(null),
            ),
          );
          if (!next || next._embedded.items.length === 0) break;
          collect(next._embedded.items);
          totalPages = next.pages;
        }
      }
      const articles = [...articlesById.values()];
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
      const data = yield* request("/api/entries.json?page=1&perPage=1&detail=metadata", {
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
