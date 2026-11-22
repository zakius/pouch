import { Cause, Effect, Exit, Fiber } from "effect";
import * as v from "valibot";
import { storageShutdownSignal } from "../../../utils/fatal-storage";
import { logger } from "../../../utils/logger";
import { instapaperConfigSchema, instapaperSettingsSchema } from "../../../utils/settings-schemas";
export { instapaperConfigSchema, instapaperSettingsSchema };
import type { Article } from "../../../types/common";
import type { TokenManager } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import { requestJson, validate } from "../effect-api-client";
import {
  BrowserFailure,
  ConfigurationFailure,
  CredentialsFailure,
  InvalidResponseFailure,
  ProviderFailure,
  RateLimitFailure,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
  type TransportError,
} from "../effect-adapter";
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";

export type InstapaperSettings = v.InferInput<typeof instapaperSettingsSchema>;
export type InstapaperConfig = v.InferInput<typeof instapaperConfigSchema>;

const apiUrl = "https://www.instapaper.com";
const INSTAPAPER_V1_LIST_LIMIT = 500;

const instapaperBookmarkSchema = v.object({
  type: v.literal("bookmark"),
  bookmark_id: v.number(),
  url: v.string(),
  title: v.nullish(v.string()),
  time: v.nullish(v.number()),
});

const instapaperUserSchema = v.object({
  type: v.literal("user"),
  user_id: v.number(),
  username: v.string(),
});

const instapaperErrorSchema = v.object({
  type: v.literal("error"),
  error_code: v.pipe(v.number(), v.safeInteger()),
});

const instapaperDeleteResponseSchema = v.pipe(v.array(v.unknown()), v.maxLength(0));

const instapaperSyncResponseSchema = v.object({
  user: instapaperUserSchema,
  bookmarks: v.array(instapaperBookmarkSchema),
  highlights: v.optional(v.unknown()), // Unused
  delete_ids: v.optional(v.unknown()), // Unused
});

type InstapaperBookmark = v.InferOutput<typeof instapaperBookmarkSchema>;

const findSavedBookmark = (data: unknown): InstapaperBookmark | undefined => {
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    const parsed = v.safeParse(instapaperBookmarkSchema, item);
    if (parsed.success) return parsed.output;
  }
  return undefined;
};

/** RFC 3986 percent-encoding required by OAuth 1.0a (RFC 5849 §3.6); encodeURIComponent leaves !'()* bare. */
const percentEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

interface OAuthCredentials {
  key: string;
  secret: string;
}

/**
 * OAuth 1.0a HMAC-SHA1 Authorization header for a POST to `url`. Without a token (xAuth) the
 * oauth_token parameter is omitted and the signing key ends in an empty token secret.
 *
 * Instapaper requires: HMAC-SHA1 only, HTTPS, POST for every request, parameters in the
 * form body, and OAuth parameters in the Authorization header.
 *
 * API: https://www.instapaper.com/api
 */
export async function oauthHeader(
  url: string,
  params: Record<string, string>,
  consumer: OAuthCredentials,
  token?: OAuthCredentials,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    ...(token ? { oauth_token: token.key } : {}),
    oauth_version: "1.0",
  };
  const allParams: Record<string, string> = { ...params, ...oauthParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join("&");
  const signatureBaseString = `POST&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(consumer.secret)}&${percentEncode(token?.secret ?? "")}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signatureBaseString),
  );
  oauthParams.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `OAuth ${Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(", ")}`;
}

const providerFailure = (operation: string) => (data: unknown) => {
  for (const item of Array.isArray(data) ? data : [data]) {
    const parsed = v.safeParse(instapaperErrorSchema, item);
    // 1040: rate limit exceeded; nothing was applied. Instapaper sends no retry delay.
    if (parsed.success && parsed.output.error_code === 1040)
      return new RateLimitFailure(operation, 1000);
    if (parsed.success) return new ProviderFailure(operation, parsed.output.error_code);
  }
  return undefined;
};

const toArticle = (item: InstapaperBookmark): Article => ({
  id: item.bookmark_id,
  title: item.title?.trim() || item.url,
  url: item.url,
  created_at: item.time ? new Date(item.time * 1000).toISOString() : new Date().toISOString(),
});

export const createInstapaperAdapter = Effect.fn("instapaper.acquire")(function* (
  settings: InstapaperSettings,
  tokens: TokenManager = tokenManager,
) {
  const parsed = v.safeParse(instapaperSettingsSchema, settings);
  if (!parsed.success) return yield* Effect.fail(new ConfigurationFailure("instapaper.acquire"));
  const consumerKey = parsed.output.apiConfig.consumerKey.trim();
  const consumerSecret = parsed.output.apiConfig.consumerSecret.trim();
  const username = parsed.output.apiConfig.username.trim();
  if (!consumerKey || !consumerSecret || !username)
    return yield* Effect.fail(new ConfigurationFailure("instapaper.acquire"));
  // Do not trim password: Instapaper accounts may have empty or whitespace-significant passwords.
  const config = {
    ...parsed.output.apiConfig,
    consumerKey,
    consumerSecret,
    username,
  };
  const consumer = { key: config.consumerKey, secret: config.consumerSecret };
  const generation = yield* tokens.bindAccount("instapaper", JSON.stringify(config));
  const owned = Effect.try({
    try: () => tokens.assertAccount("instapaper", generation),
    catch: () => new CredentialsFailure("instapaper.account"),
  });

  let token: OAuthCredentials | undefined;

  // Signing runs per attempt, so every request gets a fresh nonce and timestamp.
  const signedRequest = (
    operation: string,
    endpoint: string,
    params: Record<string, string>,
    options: {
      useToken?: boolean;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      format?: "text";
      authRetries?: number;
      recoverAuth?: Effect.Effect<void, TransportError>;
      confirms?: (data: unknown) => boolean;
      onSign?: (usedToken: OAuthCredentials | undefined) => void;
    } = {},
  ) => {
    const url = `${apiUrl}${endpoint}`;
    return requestJson({
      operation,
      url,
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      format: options.format,
      authRetries: options.authRetries,
      recoverAuth: options.recoverAuth,
      confirms: options.confirms,
      providerFailure: providerFailure(operation),
      authorization: Effect.gen(function* () {
        yield* owned;
        const currentToken = options.useToken ? token : undefined;
        if (options.useToken && !currentToken) {
          return yield* Effect.fail(new CredentialsFailure(operation));
        }
        options.onSign?.(currentToken);
        return yield* Effect.tryPromise({
          try: () => oauthHeader(url, params, consumer, currentToken),
          catch: () => new BrowserFailure(operation, "crypto"),
        });
      }),
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      },
    });
  };

  // xAuth exchanges the username and password for an access token without a redirect flow.
  const runAuthenticate: Effect.Effect<void, TransportError> = Effect.gen(function* () {
    yield* owned;
    const body = yield* signedRequest(
      "instapaper.authenticate",
      "/api/1/oauth/access_token",
      {
        x_auth_username: config.username,
        x_auth_password: config.password ?? "",
        x_auth_mode: "client_auth",
      },
      { format: "text", useToken: false },
    );
    const tokenParams = new URLSearchParams(typeof body === "string" ? body : "");
    const key = tokenParams.get("oauth_token");
    const secret = tokenParams.get("oauth_token_secret");
    if (!key || !secret)
      return yield* Effect.fail(new InvalidResponseFailure("instapaper.authenticate", "token"));
    const nextToken: OAuthCredentials = { key, secret };
    const now = Date.now();
    // OAuth 1.0a tokens do not expire; one year prompts periodic re-authentication. The secret stays in memory.
    yield* tokens.storeToken(
      "instapaper",
      {
        accessToken: key,
        refreshToken: "",
        tokenType: "OAuth",
        expiresAt: now + 365 * 24 * 60 * 60 * 1000,
        issuedAt: now,
        refreshCount: 0,
      },
      "succeeded",
      "authentication",
      generation,
    );
    yield* owned;
    token = nextToken;
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
            logger.error("Instapaper authentication died:", Cause.pretty(exit.cause));
          if (authFiber === fiber) authFiber = undefined;
        });
        return Fiber.join(fiber);
      }),
    );
  });

  yield* authenticate;

  const request = (
    operation: string,
    endpoint: string,
    params: Record<string, string>,
    options: {
      mutation?: "save" | "delete";
      timeoutMs?: number;
      confirms?: (data: unknown) => boolean;
    } = {},
  ) =>
    Effect.suspend(() => {
      let attemptedToken: OAuthCredentials | undefined;
      return signedRequest(operation, endpoint, params, {
        ...options,
        useToken: true,
        authRetries: 1,
        onSign: (usedToken) => {
          attemptedToken = usedToken;
        },
        recoverAuth: Effect.gen(function* () {
          yield* owned;
          if (attemptedToken !== undefined && token !== undefined && token !== attemptedToken) {
            return;
          }
          yield* authenticate;
        }),
      });
    });

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("instapaper.save")(function* (article: SavingArticle) {
      const params: Record<string, string> = {
        url: article.url,
        resolve_final_url: article.resolveFinalUrl ? "1" : "0",
      };
      if (article.title.trim()) params.title = article.title;
      const data = yield* request("instapaper.save", "/api/1/bookmarks/add", params, {
        mutation: "save",
        confirms: (payload) => findSavedBookmark(payload) !== undefined,
      });
      const saved = findSavedBookmark(data);
      if (!saved) return yield* Effect.fail(new InvalidResponseFailure("instapaper.save"));
      return toArticle(saved);
    }),
    deleteArticle: Effect.fn("instapaper.delete")(function* (id: number | string) {
      const data = yield* request(
        "instapaper.delete",
        "/api/1/bookmarks/delete",
        { bookmark_id: String(id) },
        {
          mutation: "delete",
          confirms: (payload) => Array.isArray(payload) && payload.length === 0,
        },
      );
      yield* validate(instapaperDeleteResponseSchema, data, "instapaper.delete");
    }),
    /**
     * Instapaper API v1 Sync (FULL SNAPSHOT, capped at 500 unread bookmarks)
     *
     * Per official Instapaper v1 docs, /api/1/bookmarks/list always operates within
     * the top `limit` (max 500) unread bookmarks; `have` is a delta exclusion filter
     * within that window, not a pagination cursor past 500. Every sync fetches the
     * top 500 unread bookmarks in a single request and always returns "overwrite"
     * mode so removed or archived bookmarks are reconciled.
     */
    sync: Effect.fn("instapaper.sync")(function* (_options?: SyncOptions) {
      const data = yield* request("instapaper.sync", "/api/1/bookmarks/list", {
        limit: String(INSTAPAPER_V1_LIST_LIMIT),
      });
      const page = yield* validate(instapaperSyncResponseSchema, data, "instapaper.sync");
      if (page.bookmarks.length >= INSTAPAPER_V1_LIST_LIMIT) {
        logger.warn(
          `Instapaper API v1 returned ${page.bookmarks.length} unread bookmarks, reaching the ${INSTAPAPER_V1_LIST_LIMIT}-item unread listing cap; older unread bookmarks beyond ${INSTAPAPER_V1_LIST_LIMIT} cannot be listed by v1.`,
        );
      }
      const articlesById = new Map<number, Article>();
      for (const item of page.bookmarks) {
        if (!articlesById.has(item.bookmark_id)) {
          articlesById.set(item.bookmark_id, toArticle(item));
        }
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
        "instapaper.testConnection",
        "/api/1/bookmarks/list",
        { limit: "1" },
        { timeoutMs: 10000 },
      );
      yield* validate(instapaperSyncResponseSchema, data, "instapaper.testConnection");
      yield* storageHealthy;
      return true as const;
    }),
  };
  yield* storageHealthy;
  // Invalidation during the acquisition's own token persistence must not return a ready adapter.
  yield* owned;
  return adapter;
}) satisfies (
  settings: InstapaperSettings,
  tokens?: TokenManager,
) => Effect.Effect<EffectAdapter, AcquisitionError>;
