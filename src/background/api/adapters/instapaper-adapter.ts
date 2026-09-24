import * as v from "valibot";
import { instapaperConfigSchema, instapaperSettingsSchema } from "../../../utils/settings-schemas";
export { instapaperConfigSchema, instapaperSettingsSchema };
import type { Article } from "../../../types/common";
import { logger } from "../../../utils/logger";
import { type TokenManager, type TokenRefreshConfig, tokenManager } from "../../token-manager";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";

export type InstapaperSettings = v.InferInput<typeof instapaperSettingsSchema>;
export type InstapaperConfig = v.InferInput<typeof instapaperConfigSchema>;

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
  error_code: v.number(),
  message: v.string(),
});

const instapaperMetaSchema = v.object({
  type: v.literal("meta"),
});

const instapaperResponseItemSchema = v.union([
  instapaperBookmarkSchema,
  instapaperUserSchema,
  instapaperErrorSchema,
  instapaperMetaSchema,
]);

const instapaperSaveResponseSchema = v.array(instapaperResponseItemSchema);

/** RFC 3986 percent-encoding required by OAuth 1.0a (RFC 5849 §3.6); encodeURIComponent leaves !'()* bare. */
const percentEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const instapaperSyncResponseSchema = v.object({
  user: instapaperUserSchema,
  bookmarks: v.array(instapaperBookmarkSchema),
  highlights: v.optional(v.array(v.unknown())), // We don't use highlights
  delete_ids: v.optional(v.array(v.number())),
});

interface InstapaperBookmark {
  type: "bookmark";
  bookmark_id: number;
  url: string;
  title: string;
  description?: string | null;
  tags?: { id: number; name: string }[];
  time?: number;
  image_url?: string | null;
  progress?: number;
  progress_timestamp?: number;
  private_source?: string | null;
}

interface InstapaperError {
  type: "error";
  error_code: number;
  message: string;
}

export class InstapaperAdapter implements ReadItLaterAPI<InstapaperSettings>, TokenizedAdapter {
  constructor(public readonly tokens: TokenManager = tokenManager) {}

  public readonly displayName = "Instapaper";
  private apiUrl = "https://www.instapaper.com";
  private config!: InstapaperConfig;
  private accessToken: string | null = null;
  private accessTokenSecret: string | null = null;
  formConfig = [
    { name: "consumerKey", label: "OAuth Consumer Key" },
    { name: "consumerSecret", label: "OAuth Consumer Secret" },
    { name: "username", label: "Instapaper Username" },
    { name: "password", label: "Instapaper Password" },
  ];

  getServiceName(): string {
    return "instapaper";
  }

  getTokenRefreshConfig(): TokenRefreshConfig {
    throw new Error("Instapaper uses OAuth 1.0a, no refresh configuration available");
  }

  createTokenMetadata(_tokenData: Record<string, unknown>) {
    const now = Date.now();
    return {
      accessToken: this.accessToken || "",
      refreshToken: "", // No refresh token for OAuth 1.0a
      tokenType: "OAuth",
      // Instapaper OAuth 1.0a tokens don't technically expire, but we set 1 year
      // to trigger periodic re-authentication as a security best practice
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
      issuedAt: now,
      scope: undefined,
      refreshCount: 0,
    };
  }

  getBaseUrl(): string {
    return this.apiUrl;
  }

  getAuthEndpoint(): string {
    return `${this.apiUrl}/api/1/oauth/access_token`;
  }

  async reAuthenticate(): Promise<void> {
    logger.info(`Performing full re-authentication for ${this.getServiceName()}`);
    await this.authenticate();
  }
  async initialize(settings: InstapaperSettings): Promise<void> {
    this.config = settings.apiConfig;
    await this.authenticate();
  }

  /**
   * Instapaper xAuth Authentication
   *
   * Instapaper uses xAuth (OAuth 1.0a extension) which exchanges username/password
   * directly for an access token without user redirect flow.
   *
   * This is the ONLY way to obtain Instapaper access tokens according to their API.
   *
   * API: https://www.instapaper.com/api
   */
  private async authenticate(): Promise<void> {
    const url = this.getAuthEndpoint();
    const xAuthParams = {
      x_auth_username: this.config.username,
      x_auth_password: this.config.password || "",
      x_auth_mode: "client_auth",
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: await this._oauthHeader(url, xAuthParams, "", ""),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(xAuthParams),
    });
    if (!response.ok) {
      throw new Error("Failed to authenticate with Instapaper");
    }
    const tokenData = await response.text();
    const params = new URLSearchParams(tokenData);
    this.accessToken = params.get("oauth_token");
    this.accessTokenSecret = params.get("oauth_token_secret");
    if (!this.accessToken || !this.accessTokenSecret) {
      throw new Error("Failed to obtain Instapaper access token");
    }

    const tokenMetadata = this.createTokenMetadata({});
    await this.tokens.storeToken(this.getServiceName(), tokenMetadata);
  }
  async testConnection(): Promise<boolean> {
    try {
      await this._makeSignedRequest("/api/1/bookmarks/list", { limit: 1 });
      return true;
    } catch (error) {
      logger.error("Instapaper connection test failed:", error);
      return false;
    }
  }

  public async cleanup(): Promise<void> {
    await this.tokens.clearToken(this.getServiceName());
  }

  public getTokenHealth(): {
    isValid: boolean;
    expiresAt?: string;
    refreshCount?: number;
  } {
    const health = this.tokens.getTokenHealth();
    return health[this.getServiceName()] || { isValid: false };
  }
  async saveArticle(article: SavingArticle): Promise<Article> {
    const params = { url: article.url, title: article.title };
    const data = await this._makeSignedRequest("/api/1/bookmarks/add", params);
    const validatedData = v.parse(instapaperSaveResponseSchema, data);

    // Filter to find bookmark and error
    const savedBookmark = (validatedData as (InstapaperBookmark | InstapaperError)[]).find(
      (item) => item.type === "bookmark",
    ) as InstapaperBookmark | undefined;

    const error = (validatedData as (InstapaperBookmark | InstapaperError)[]).find(
      (item) => item.type === "error",
    ) as InstapaperError | undefined;

    if (error) {
      throw new Error(`Failed to save article: ${error.message} (Error ${error.error_code})`);
    }

    if (!savedBookmark) {
      throw new Error("Failed to save article to Instapaper: No bookmark returned");
    }

    return this.mapArticle(savedBookmark);
  }
  async deleteArticle(id: number): Promise<void> {
    await this._makeSignedRequest("/api/1/bookmarks/delete", {
      bookmark_id: id,
    });
  }
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
   * the API ignored "have" and retrieval cannot advance, so sync fails
   * explicitly and the caller keeps its previous cache.
   *
   * API: https://www.instapaper.com/api
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    const limit = 500;
    const articlesById = new Map<number, Article>();
    let pageBookmarks: InstapaperBookmark[] = [];

    const mode = options?.mode || "overwrite";

    do {
      const params: Record<string, unknown> = { limit };
      if (articlesById.size > 0) params.have = [...articlesById.keys()].join(",");
      const data = await this._makeSignedRequest("/api/1/bookmarks/list", params);
      const validatedData = v.parse(instapaperSyncResponseSchema, data);
      pageBookmarks = validatedData.bookmarks;

      const newBookmarks = pageBookmarks.filter((item) => !articlesById.has(item.bookmark_id));
      if (pageBookmarks.length === limit && newBookmarks.length === 0) {
        throw new Error(
          "Instapaper sync cannot retrieve a complete snapshot: the API returned a full page of already-seen bookmarks",
        );
      }

      for (const item of newBookmarks) {
        articlesById.set(item.bookmark_id, this.mapArticle(item));
      }

      // Rate limiting: Instapaper doesn't publish rate limits,
      // but 1 second between requests is conservative
      if (pageBookmarks.length === limit) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } while (pageBookmarks.length === limit);

    const allArticles = [...articlesById.values()];

    return {
      articles: allArticles,
      mode,
      metadata: {
        totalFetched: allArticles.length,
        totalProcessed: allArticles.length,
        lastSyncTimestamp: new Date().toISOString(),
        apiVersion: "1.0",
      },
    };
  }
  private mapArticle(item: InstapaperBookmark): Article {
    return {
      id: item.bookmark_id,
      title: item.title,
      url: item.url,
      created_at: item.time ? new Date(item.time * 1000).toISOString() : new Date().toISOString(),
    };
  }
  /**
   * OAuth 1.0a Signature Generation for Instapaper
   *
   * Instapaper requires OAuth 1.0a signatures for all API requests.
   *
   * Process:
   * 1. Collect all parameters (request params + OAuth params)
   * 2. Sort parameters alphabetically and URL-encode them
   * 3. Create signature base string: METHOD&url&encoded_params
   * 4. Generate HMAC-SHA1 signature using: consumerSecret&accessTokenSecret
   * 5. Add signature to OAuth Authorization header
   *
   * Requirements:
   * - Only HMAC-SHA1 signature method supported
   * - HTTPS required on all endpoints
   * - All requests via POST method
   * - Parameters in POST body, not query string
   * - OAuth params in Authorization header, not body/query
   *
   * API: https://www.instapaper.com/api
   */
  private async _makeSignedRequest(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.config || !this.accessToken || !this.accessTokenSecret) {
      throw new Error("Instapaper adapter not initialized");
    }
    const baseUrl = `${this.apiUrl}${endpoint}`;
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: await this._oauthHeader(
          baseUrl,
          params,
          this.accessToken,
          this.accessTokenSecret,
        ),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params as Record<string, string>),
    });
    if (!response.ok) {
      throw new Error(`Instapaper API Error: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  /** OAuth 1.0a HMAC-SHA1 Authorization header for a POST to `url`. An empty token is omitted (xAuth). */
  private async _oauthHeader(
    url: string,
    params: Record<string, unknown>,
    token: string,
    tokenSecret: string,
  ): Promise<string> {
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.config.consumerKey,
      oauth_nonce: Math.random().toString(36).substring(2),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      ...(token ? { oauth_token: token } : {}),
      oauth_version: "1.0",
    };
    const allParams: Record<string, unknown> = { ...params, ...oauthParams };
    const paramString = Object.keys(allParams)
      .sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(String(allParams[key]))}`)
      .join("&");
    const signatureBaseString = `POST&${percentEncode(url)}&${percentEncode(paramString)}`;
    const signingKey = `${percentEncode(this.config.consumerSecret)}&${percentEncode(tokenSecret)}`;
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
}
