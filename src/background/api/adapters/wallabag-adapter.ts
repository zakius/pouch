import { assertStorageHealthy, storageShutdownSignal } from "../../../utils/fatal-storage";
import * as v from "valibot";
import { wallabagConfigSchema, wallabagSettingsSchema } from "../../../utils/settings-schemas";
export { wallabagConfigSchema, wallabagSettingsSchema };
import type { Article } from "../../../types/common";
import { logger } from "../../../utils/logger";
import { type TokenManager, type TokenRefreshConfig, tokenManager } from "../../token-manager";
import { type ApiClient, createApiClient } from "../api-client";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncMode,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";

export type WallabagSettings = v.InferInput<typeof wallabagSettingsSchema>;
export type WallabagConfig = v.InferInput<typeof wallabagConfigSchema>;

const wallabagTagSchema = v.object({
  id: v.number(),
  name: v.string(),
});

const wallabagItemSchema = v.object({
  id: v.number(),
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

const wallabagTokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.union([v.string(), v.null_()])),
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
    limit: v.number(),
    page: v.number(),
    pages: v.number(),
    total: v.number(),
  }),
  wallabagErrorSchema,
]);

interface WallabagItem {
  id: number;
  title: string;
  url: string;
  created_at: string;
  tags?: { id: number; name: string }[];
  content?: string | null;
  excerpt?: string;
  domain_name?: string;
  is_archived?: boolean | number;
  is_starred?: boolean | number;
  language?: string | null;
  reading_time?: number;
  preview_picture?: string | null;
  user_name?: string;
  user_email?: string;
  user_id?: number;
}

export class WallabagAdapter implements ReadItLaterAPI<WallabagSettings>, TokenizedAdapter {
  constructor(public readonly tokens: TokenManager = tokenManager) {}

  public readonly displayName = "Wallabag";
  private apiUrl: string = "";
  private config!: WallabagConfig;
  private apiClient!: ApiClient;
  formConfig = [
    { name: "url", label: "API URL" },
    { name: "clientId", label: "Client ID" },
    { name: "clientSecret", label: "Client Secret" },
    { name: "username", label: "Username" },
    { name: "password", label: "Password" },
  ];

  getServiceName(): string {
    return "wallabag";
  }

  getTokenRefreshConfig(): TokenRefreshConfig {
    return {
      serviceName: this.getServiceName(),
      refreshUrl: `${this.apiUrl}/oauth/v2/token`,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.tokens.getTokenMetadata(this.getServiceName())?.refreshToken || "",
    };
  }

  createTokenMetadata(tokenData: v.InferOutput<typeof wallabagTokenResponseSchema>) {
    const now = Date.now();
    const expiresIn = tokenData.expires_in || 3600; // Default to 1 hour

    const tokenType = tokenData.token_type
      ? tokenData.token_type.charAt(0).toUpperCase() + tokenData.token_type.slice(1).toLowerCase()
      : "Bearer";

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || "",
      tokenType: tokenType,
      expiresAt: now + expiresIn * 1000,
      issuedAt: now,
      scope: tokenData.scope || undefined,
      refreshCount: 0,
    };
  }

  getBaseUrl(): string {
    return this.apiUrl;
  }

  getAuthEndpoint(): string {
    return `${this.apiUrl}/oauth/v2/token`;
  }

  async reAuthenticate(): Promise<void> {
    logger.info(`Performing full re-authentication for ${this.getServiceName()}`);
    await this.authenticate();
  }
  async initialize(settings: WallabagSettings): Promise<void> {
    this.config = settings.apiConfig;
    this.apiUrl = this.config.url;

    // Wallabag OAuth2 requires password for grant_type=password authentication flow
    // Even for accounts without passwords, a value must be provided (any non-empty string works)
    if (!this.config.password) {
      throw new Error("Password is required for Wallabag OAuth2 password grant authentication");
    }

    await this.authenticate();

    this.apiClient = createApiClient(this, {
      baseUrl: this.apiUrl,
      rateLimit: {
        delayMs: 1000,
        maxRetries: 3,
        lowLimitThreshold: 10,
      },
    });
  }

  private async authenticate(): Promise<void> {
    const requestBody = new URLSearchParams({
      grant_type: "password",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password || "",
    });

    assertStorageHealthy();
    const response = await fetch(this.getAuthEndpoint(), {
      signal: storageShutdownSignal(),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to authenticate with Wallabag API: ${response.status} ${errorText}`);
    }

    const tokenData = (await response.json()) as Record<string, unknown>;

    if (tokenData.error) {
      const errorMessage =
        (tokenData.error_description as string) ||
        (tokenData.message as string) ||
        (tokenData.error as string);
      throw new Error(`Wallabag authentication failed: ${errorMessage}`);
    }

    let validatedTokenData: v.InferOutput<typeof wallabagTokenResponseSchema>;
    try {
      validatedTokenData = v.parse(wallabagTokenResponseSchema, tokenData);
    } catch (validationError: unknown) {
      logger.error("Validation error for Wallabag token response:", validationError);
      throw new Error(
        `Invalid token response from Wallabag API: ${validationError instanceof Error ? validationError.message : "Unknown validation error"}`,
      );
    }

    const tokenMetadata = this.createTokenMetadata(validatedTokenData);
    await this.tokens.storeToken(this.getServiceName(), tokenMetadata);

    logger.debug("Wallabag authentication successful", {
      tokenType: tokenMetadata.tokenType,
      expiresAt: new Date(tokenMetadata.expiresAt).toISOString(),
      scope: tokenMetadata.scope,
    });
  }

  public async cleanup(): Promise<void> {
    await this.apiClient.clearToken();
  }

  public getTokenHealth(): {
    isValid: boolean;
    expiresAt?: string;
    refreshCount?: number;
  } {
    return this.apiClient.getTokenHealth();
  }

  async testConnection(): Promise<boolean> {
    try {
      return await this.apiClient.testConnection("/api/entries.json?page=1&perPage=1");
    } catch (error) {
      logger.error("Wallabag connection test failed:", error);
      return false;
    }
  }
  async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.apiClient.post("/api/entries.json", {
      url: article.url,
      title: article.title,
    });
    const validatedData = v.parse(wallabagSaveResponseSchema, response.data);

    if ("error" in validatedData) {
      throw new Error(
        `Failed to save article: ${validatedData.error_description || validatedData.message || validatedData.error}`,
      );
    }

    return this.mapArticle(validatedData);
  }
  async deleteArticle(id: number): Promise<void> {
    await this.apiClient.delete(`/api/entries/${id}.json`);
  }

  /**
   * Wallabag Sync Mode Decision (HYBRID APPROACH)
   *
   * Wallabag supports two sync modes:
   *
   * === FULL SYNC (overwrite) ===
   * - Fetches ALL entries from server
   * - Replaces local cache completely
   * - Catches additions, updates, AND deletions
   * - Used for: first sync, periodic rebuild (>24h since last full sync)
   *
   * === INCREMENTAL SYNC (update) ===
   * - Uses "since" parameter (Unix timestamp in seconds)
   * - Fetches only entries modified/created after timestamp
   * - LIMITATION: Does NOT track deletions
   * - Used for: quick updates when recent full sync (<24h ago)
   *
   * === STRATEGY ===
   * - First sync → FULL (baseline)
   * - Last full sync >24h ago + browser idle → FULL (catch deletions)
   * - Otherwise → INCREMENTAL (fast update)
   *
   * This hybrid approach ensures:
   * - Fast syncs during active use (incremental)
   * - Complete data consistency (periodic full syncs)
   * - Efficient bandwidth usage
   *
   * API: https://doc.wallabag.org/developer/api/
   *
   * IMPORTANT: Deletion Tracking
   * - Wallabag's "since" parameter does NOT track deletions
   * - If an entry is deleted on server, incremental sync won't know
   * - Solution: Periodic full syncs (every 24h when idle) catch deletions
   * - by comparing the full list from server with local cache
   */
  private makeSyncDecision(options?: SyncOptions): {
    mode: SyncMode;
    reason: string;
    timeSinceLastFullSync?: number;
  } {
    // If mode is explicitly provided, use it
    if (options?.mode) {
      return {
        mode: options.mode,
        reason: "explicit_mode",
        timeSinceLastFullSync: options.lastFullSyncTimestamp
          ? Date.now() - options.lastFullSyncTimestamp
          : undefined,
      };
    }

    // If no last full sync timestamp, this is the first sync
    if (!options?.lastFullSyncTimestamp) {
      return {
        mode: "overwrite",
        reason: "first_sync",
      };
    }

    const now = Date.now();
    const timeSinceLastFullSync = now - options.lastFullSyncTimestamp;
    const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    // Do full sync if more than 24h since last full sync AND browser is idle
    if (timeSinceLastFullSync >= twentyFourHours && options.isBrowserIdle) {
      return {
        mode: "overwrite",
        reason: "24h_idle",
        timeSinceLastFullSync,
      };
    }

    // Otherwise do incremental sync
    return {
      mode: "update",
      reason: "incremental",
      timeSinceLastFullSync,
    };
  }
  async sync(options?: SyncOptions): Promise<SyncResult> {
    // Make sync mode decision based on provided data
    const syncDecision = this.makeSyncDecision(options);
    const mode = syncDecision.mode;

    logger.info("Wallabag sync decision:", {
      mode,
      reason: syncDecision.reason,
      timeSinceLastFullSync: syncDecision.timeSinceLastFullSync,
      isBrowserIdle: options?.isBrowserIdle,
    });

    const perPage = 30;
    const allArticles: Article[] = [];
    let totalFetched = 0;

    // Build query parameters based on sync options
    const baseParams = (() => {
      const params = new URLSearchParams({
        page: "1",
        perPage: perPage.toString(),
        detail: "metadata",
      });

      /**
       * Wallabag Incremental Sync Implementation
       *
       * The "since" parameter filters entries by modification/creation time
       * Expected format: Unix timestamp in SECONDS (not milliseconds!)
       *
       * CRITICAL LIMITATION:
       * - Does NOT return entries deleted on server
       * - Deleted entries only caught during full sync
       *
       * Therefore, we use periodic full syncs (every 24h when idle)
       */
      if (options?.lastSyncTimestamp && mode === "update") {
        // Convert ISO timestamp to Unix seconds
        const unixTimestamp = Math.floor(new Date(options.lastSyncTimestamp).getTime() / 1000);
        params.set("since", unixTimestamp.toString());
        logger.debug("Using Wallabag incremental sync with since parameter", {
          lastSyncTimestamp: options.lastSyncTimestamp,
          unixTimestamp,
          mode,
        });
      }

      return params;
    })();

    const firstResponse = await this.apiClient.get(`/api/entries.json?${baseParams.toString()}`);

    const validatedFirstData = (() => {
      try {
        return v.parse(wallabagSyncResponseSchema, firstResponse.data);
      } catch (validationError) {
        logger.error("Wallabag API response validation failed:", {
          error: validationError,
          responseData: firstResponse.data,
          url: `/api/entries.json?${baseParams.toString()}`,
        });
        throw validationError;
      }
    })();

    if ("error" in validatedFirstData) {
      throw new Error(
        `Failed to get articles: ${validatedFirstData.error_description || validatedFirstData.message || validatedFirstData.error}`,
      );
    }

    const firstPageArticles = validatedFirstData._embedded.items.map((item: WallabagItem) =>
      this.mapArticle(item),
    );
    allArticles.push(...firstPageArticles);
    totalFetched += firstPageArticles.length;

    const total = validatedFirstData.total;
    const totalPages = Math.ceil(total / perPage);

    const additionalPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);

    for (const page of additionalPages) {
      const pageParams = new URLSearchParams(baseParams);
      pageParams.set("page", page.toString());

      const response = await this.apiClient.get(`/api/entries.json?${pageParams.toString()}`);

      const validatedData = (() => {
        try {
          return v.parse(wallabagSyncResponseSchema, response.data);
        } catch (validationError) {
          logger.error("Wallabag API pagination response validation failed:", {
            error: validationError,
            responseData: response.data,
            url: `/api/entries.json?${pageParams.toString()}`,
            page,
          });
          throw validationError;
        }
      })();

      if ("error" in validatedData) {
        throw new Error(
          `Failed to get articles: ${validatedData.error_description || validatedData.message || validatedData.error}`,
        );
      }

      const pageArticles = validatedData._embedded.items.map((item: WallabagItem) =>
        this.mapArticle(item),
      );
      allArticles.push(...pageArticles);
      totalFetched += pageArticles.length;
    }

    return {
      articles: allArticles,
      mode,
      metadata: {
        totalFetched,
        totalProcessed: allArticles.length,
        lastSyncTimestamp: new Date().toISOString(),
        apiVersion: "2.0",
        syncDecision: {
          reason: syncDecision.reason,
          wasFullSync: mode === "overwrite",
          timeSinceLastFullSync: syncDecision.timeSinceLastFullSync,
          isBrowserIdle: options?.isBrowserIdle,
        },
      },
    };
  }
  private mapArticle(item: WallabagItem): Article {
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      created_at: item.created_at,
    };
  }
}
