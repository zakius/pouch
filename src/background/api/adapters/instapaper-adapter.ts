import { Effect } from "effect";
import * as v from "valibot";
import { instapaperConfigSchema, instapaperSettingsSchema } from "../../../utils/settings-schemas";
export { instapaperConfigSchema, instapaperSettingsSchema };
import type { Article } from "../../../types/common";
import { TokenManager, tokenManager } from "../../token-manager";
import { requestJson, validate } from "../effect-api-client";
import {
  BrowserFailure,
  ConfigurationFailure,
  CredentialsFailure,
  IncompleteSnapshotFailure,
  InvalidResponseFailure,
  ProviderFailure,
  RateLimitFailure,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type { SavingArticle, SyncOptions } from "../read-it-later-adapter";

export type InstapaperSettings = v.InferInput<typeof instapaperSettingsSchema>;
export type InstapaperConfig = v.InferInput<typeof instapaperConfigSchema>;

const apiUrl = "https://www.instapaper.com";

const instapaperTagSchema = v.object({
  id: v.number(),
  name: v.string(),
});

const instapaperBookmarkSchema = v.object({
  type: v.literal("bookmark"),
  bookmark_id: v.number(),
  url: v.string(),
  title: v.string(),
  description: v.optional(v.nullable(v.string())),
  tags: v.optional(v.array(instapaperTagSchema)),
  time: v.optional(v.number()),
  image_url: v.optional(v.nullable(v.string())),
  progress: v.optional(v.number()),
  progress_timestamp: v.optional(v.number()),
  private_source: v.optional(v.nullable(v.string())),
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

const instapaperMetaSchema = v.object({
  type: v.literal("meta"),
});

const instapaperSaveResponseSchema = v.array(
  v.union([
    instapaperBookmarkSchema,
    instapaperUserSchema,
    instapaperErrorSchema,
    instapaperMetaSchema,
  ]),
);

const instapaperSyncResponseSchema = v.object({
  user: instapaperUserSchema,
  bookmarks: v.array(instapaperBookmarkSchema),
  highlights: v.optional(v.array(v.unknown())), // We don't use highlights
  delete_ids: v.optional(v.array(v.number())),
});

type InstapaperBookmark = v.InferOutput<typeof instapaperBookmarkSchema>;

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
    oauth_nonce: Math.random().toString(36).substring(2),
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
  title: item.title,
  url: item.url,
  created_at: item.time ? new Date(item.time * 1000).toISOString() : new Date().toISOString(),
});

export const createInstapaperAdapter = Effect.fn("instapaper.acquire")(function* (
  settings: InstapaperSettings,
  tokens: TokenManager = tokenManager,
) {
  const parsed = v.safeParse(instapaperSettingsSchema, settings);
  if (
    !parsed.success ||
    !parsed.output.apiConfig.consumerKey ||
    !parsed.output.apiConfig.consumerSecret ||
    !parsed.output.apiConfig.username
  )
    return yield* Effect.fail(new ConfigurationFailure("instapaper.acquire"));
  const config = { ...parsed.output.apiConfig };
  const consumer = { key: config.consumerKey, secret: config.consumerSecret };
  const generation = yield* tokens.bindAccount("instapaper", JSON.stringify(config));
  const owned = Effect.try({
    try: () => tokens.assertAccount("instapaper", generation),
    catch: () => new CredentialsFailure("instapaper.account"),
  });
  // Signing runs per attempt, so every request gets a fresh nonce and timestamp.
  const signedRequest = (
    operation: string,
    endpoint: string,
    params: Record<string, string>,
    options: {
      token?: OAuthCredentials;
      mutation?: "save" | "delete";
      timeoutMs?: number;
      format?: "text";
    } = {},
  ) => {
    const url = `${apiUrl}${endpoint}`;
    return requestJson({
      operation,
      url,
      mutation: options.mutation,
      timeoutMs: options.timeoutMs,
      format: options.format,
      providerFailure: providerFailure(operation),
      authorization: owned.pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => oauthHeader(url, params, consumer, options.token),
            catch: () => new BrowserFailure(operation, "crypto"),
          }),
        ),
      ),
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      },
    });
  };

  // xAuth exchanges the username and password for an access token without a redirect flow.
  const body = yield* signedRequest(
    "instapaper.authenticate",
    "/api/1/oauth/access_token",
    {
      x_auth_username: config.username,
      x_auth_password: config.password ?? "",
      x_auth_mode: "client_auth",
    },
    { format: "text" },
  );
  const tokenParams = new URLSearchParams(typeof body === "string" ? body : "");
  const key = tokenParams.get("oauth_token");
  const secret = tokenParams.get("oauth_token_secret");
  if (!key || !secret)
    return yield* Effect.fail(new InvalidResponseFailure("instapaper.authenticate", "token"));
  const token = { key, secret };
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

  const request = (
    operation: string,
    endpoint: string,
    params: Record<string, string>,
    options: { mutation?: "save" | "delete"; timeoutMs?: number } = {},
  ) => signedRequest(operation, endpoint, params, { ...options, token });

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("instapaper.save")(function* (article: SavingArticle) {
      const data = yield* request(
        "instapaper.save",
        "/api/1/bookmarks/add",
        { url: article.url, title: article.title },
        { mutation: "save" },
      );
      const items = yield* validate(instapaperSaveResponseSchema, data, "instapaper.save");
      const saved = items.find((item): item is InstapaperBookmark => item.type === "bookmark");
      if (!saved) return yield* Effect.fail(new InvalidResponseFailure("instapaper.save"));
      return toArticle(saved);
    }),
    deleteArticle: Effect.fn("instapaper.delete")(function* (id: number | string) {
      yield* request(
        "instapaper.delete",
        "/api/1/bookmarks/delete",
        { bookmark_id: String(id) },
        { mutation: "delete" },
      );
    }),
    /**
     * Instapaper Sync (FULL SNAPSHOT)
     *
     * bookmarks/list returns at most `limit` bookmarks and has no cursor. Paging
     * works through "have": every request after the first sends the IDs seen so
     * far (comma-separated), and the API leaves those out of the response. The
     * loop stops at the first page shorter than `limit`.
     *
     * delete_ids is ignored: each sync is a full snapshot, so removed bookmarks
     * simply drop out. A full page containing only already-seen bookmarks means
     * the API ignored "have" and retrieval cannot advance, so sync fails with
     * IncompleteSnapshotFailure and the caller keeps its previous cache.
     */
    sync: Effect.fn("instapaper.sync")(function* (options?: SyncOptions) {
      const limit = 500;
      const articlesById = new Map<number, Article>();
      for (;;) {
        const params: Record<string, string> = { limit: String(limit) };
        if (articlesById.size > 0) params.have = [...articlesById.keys()].join(",");
        const data = yield* request("instapaper.sync", "/api/1/bookmarks/list", params);
        const page = yield* validate(instapaperSyncResponseSchema, data, "instapaper.sync");
        const fresh = page.bookmarks.filter((item) => !articlesById.has(item.bookmark_id));
        if (page.bookmarks.length >= limit && fresh.length === 0)
          return yield* Effect.fail(new IncompleteSnapshotFailure("instapaper.sync"));
        for (const item of fresh) articlesById.set(item.bookmark_id, toArticle(item));
        if (page.bookmarks.length < limit) break;
        // Instapaper publishes no rate limit; one second between pages is conservative.
        yield* Effect.sleep(1000);
      }
      const articles = [...articlesById.values()];
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
