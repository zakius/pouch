import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import { logger } from "../../../utils/logger";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import { type ApiClient, createApiClient } from "../api-client";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";

export const linkaceConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  token: v.string(),
});

export const linkaceSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("linkace"),
  apiConfig: linkaceConfigSchema,
});

export type LinkaceSettings = v.InferInput<typeof linkaceSettingsSchema>;
export type LinkaceConfig = v.InferInput<typeof linkaceConfigSchema>;

const linkaceTagSchema = v.object({
  id: v.number(),
  name: v.string(),
});

const linkaceListSchema = v.object({
  id: v.number(),
  name: v.string(),
});

const linkaceLinkSchema = v.object({
  id: v.number(),
  url: v.string(),
  title: v.string(),
  description: v.optional(v.nullable(v.string())),
  created_at: v.string(),
  updated_at: v.optional(v.nullable(v.string())),
  lists: v.optional(v.array(linkaceListSchema)),
  tags: v.optional(v.array(linkaceTagSchema)),
  visibility: v.optional(v.number()),
  check_disabled: v.optional(v.union([v.boolean(), v.number()])),
  status: v.optional(v.number()),
  icon: v.optional(v.nullable(v.string())),
  thumbnail: v.optional(v.nullable(v.string())),
});

const linkaceErrorSchema = v.object({
  message: v.string(),
  errors: v.optional(v.record(v.string(), v.array(v.string()))),
});

const linkaceSaveResponseSchema = v.union([
  v.object({
    data: linkaceLinkSchema,
  }),
  linkaceErrorSchema,
]);

const linkaceSyncResponseSchema = v.union([
  v.object({
    data: v.array(linkaceLinkSchema),
    links: v.optional(
      v.object({
        first: v.optional(v.string()),
        last: v.optional(v.string()),
        prev: v.optional(v.string()),
        next: v.optional(v.string()),
      }),
    ),
    meta: v.optional(
      v.object({
        current_page: v.number(),
        from: v.optional(v.number()),
        last_page: v.number(),
        per_page: v.number(),
        to: v.optional(v.number()),
        total: v.number(),
      }),
    ),
  }),
  linkaceErrorSchema,
]);

interface LinkaceLink {
  id: number;
  url: string;
  title: string;
  description?: string | null;
  created_at: string;
  updated_at?: string | null;
  lists?: { id: number; name: string }[];
  tags?: { id: number; name: string }[];
  visibility?: number;
  check_disabled?: boolean | number;
  status?: number;
  icon?: string | null;
  thumbnail?: string | null;
}

export class LinkaceAdapter implements ReadItLaterAPI<LinkaceSettings>, TokenizedAdapter {
  public readonly displayName = "LinkAce";
  private apiUrl: string = "";
  private token: string = "";
  private apiClient!: ApiClient;

  formConfig = [
    { name: "url", label: "API URL" },
    { name: "token", label: "API Token" },
  ];

  getServiceName(): string {
    return "linkace";
  }

  getTokenRefreshConfig(): TokenRefreshConfig {
    throw new Error("LinkAce uses static API tokens, no refresh configuration available");
  }

  createTokenMetadata(_tokenData: Record<string, unknown>) {
    const now = Date.now();
    return {
      accessToken: this.token,
      refreshToken: "", // No refresh token for static API keys
      tokenType: "Bearer",
      expiresAt: now + 365 * 24 * 60 * 60 * 1000, // 1 year from now (effectively never expires)
      issuedAt: now,
      scope: undefined,
      refreshCount: 0,
    };
  }

  getBaseUrl(): string {
    return this.apiUrl;
  }

  getAuthEndpoint(): string {
    return "";
  }

  async initialize(settings: LinkaceSettings): Promise<void> {
    this.apiUrl = settings.apiConfig.url;
    this.token = settings.apiConfig.token;

    const tokenMetadata = this.createTokenMetadata({});
    await tokenManager.storeToken(this.getServiceName(), tokenMetadata);

    this.apiClient = createApiClient(this, {
      baseUrl: this.apiUrl,
      rateLimit: {
        delayMs: 1000,
        maxRetries: 3,
        lowLimitThreshold: 10,
      },
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      return await this.apiClient.testConnection("/api/v2/links?per_page=1");
    } catch (error) {
      logger.error("LinkAce connection test failed:", error);
      return false;
    }
  }

  async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.apiClient.post("/api/v2/links", {
      url: article.url,
      title: article.title,
      visibility: 1, // LinkAce visibility: 1 = public, 2 = internal, 3 = private
      check_disabled: false,
    });
    const validatedData = v.parse(linkaceSaveResponseSchema, response.data);

    if ("message" in validatedData) {
      throw new Error(`Failed to save article: ${validatedData.message}`);
    }

    return this.mapArticle(validatedData.data);
  }

  async deleteArticle(id: number): Promise<void> {
    await this.apiClient.delete(`/api/v2/links/${id}`);
  }

  /**
   * LinkAce Sync (DOCUMENTED INCREMENTAL SUPPORT)
   *
   * LinkAce API supports incremental sync via created_after parameter
   * API docs: https://api-docs.linkace.org/
   *
   * PARAMETER: created_after
   * - Format: ISO 8601 timestamp string
   * - Filters links created after this timestamp
   *
   * LIMITATIONS:
   * - Deletion tracking: UNKNOWN (not documented)
   * - Update tracking: UNKNOWN (not documented)
   *
   * STRATEGY:
   * - Use incremental sync for speed
   * - Perform periodic full syncs to catch potential deletions
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    const perPage = 30;
    const allArticles: Article[] = [];
    let currentPage = 1;
    let hasMorePages = true;
    let totalFetched = 0;

    // Build base query parameters
    const baseParams = new URLSearchParams({
      per_page: perPage.toString(),
    });

    // LinkAce documents created_after parameter for incremental sync
    // Format: ISO 8601 timestamp string
    if (options?.lastSyncTimestamp && options.mode === "update") {
      baseParams.set("created_after", options.lastSyncTimestamp);
      logger.debug("Using LinkAce incremental sync with created_after parameter", {
        lastSyncTimestamp: options.lastSyncTimestamp,
      });
    }

    while (hasMorePages) {
      baseParams.set("page", currentPage.toString());
      const response = await this.apiClient.get(`/api/v2/links?${baseParams.toString()}`);
      const validatedData = v.parse(linkaceSyncResponseSchema, response.data);

      if ("message" in validatedData) {
        throw new Error(`Failed to sync articles: ${validatedData.message}`);
      }

      const pageArticles = validatedData.data.map((item: LinkaceLink) => this.mapArticle(item));
      allArticles.push(...pageArticles);
      totalFetched += pageArticles.length;

      if (validatedData.meta) {
        hasMorePages = currentPage < validatedData.meta.last_page;
      } else {
        hasMorePages = validatedData.data.length === perPage;
      }

      currentPage++;
    }

    const mode = options?.mode || "overwrite";

    return {
      articles: allArticles,
      mode,
      metadata: {
        totalFetched,
        totalProcessed: allArticles.length,
        lastSyncTimestamp: new Date().toISOString(),
        apiVersion: "2.0",
      },
    };
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

  private mapArticle(item: LinkaceLink): Article {
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      created_at: item.created_at,
    };
  }
}
