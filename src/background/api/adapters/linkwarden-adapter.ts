import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
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

export const linkwardenConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  token: v.string(),
});

export const linkwardenSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("linkwarden"),
  apiConfig: linkwardenConfigSchema,
});

export type LinkwardenSettings = v.InferInput<typeof linkwardenSettingsSchema>;
export type LinkwardenConfig = v.InferInput<typeof linkwardenConfigSchema>;

const linkwardenItemSchema = v.object({
  id: v.number(),
  name: v.string(),
  url: v.string(),
  createdAt: v.string(),
  image: v.optional(v.nullable(v.string())),
  description: v.optional(v.nullable(v.string())),
  collectionId: v.optional(v.number()),
  tags: v.optional(
    v.array(
      v.object({
        id: v.number(),
        name: v.string(),
      }),
    ),
  ),
  status: v.optional(v.nullable(v.string())),
  archived: v.optional(v.union([v.boolean(), v.number()])),
});

const linkwardenErrorSchema = v.object({
  error: v.string(),
  message: v.optional(v.string()),
  status: v.optional(v.number()),
});

const linkwardenSaveResponseSchema = v.union([
  v.object({
    response: linkwardenItemSchema,
  }),
  linkwardenErrorSchema,
]);

const linkwardenSyncResponseSchema = v.union([
  v.object({
    response: v.object({
      data: v.array(linkwardenItemSchema),
    }),
  }),
  linkwardenErrorSchema,
]);

interface LinkwardenItem {
  id: number;
  name: string;
  url: string;
  createdAt: string;
  image?: string | null;
  description?: string | null;
  collectionId?: number;
  tags?: { id: number; name: string }[];
  status?: string | null;
  archived?: boolean | number;
}

export class LinkwardenAdapter implements ReadItLaterAPI<LinkwardenSettings>, TokenizedAdapter {
  public readonly displayName = "Linkwarden";
  private apiUrl: string = "";
  private token: string = "";
  private apiClient!: ApiClient;
  formConfig = [
    { name: "url", label: "API URL" },
    { name: "token", label: "API Token" },
  ];

  getServiceName(): string {
    return "linkwarden";
  }

  getTokenRefreshConfig(): TokenRefreshConfig {
    throw new Error("Linkwarden uses static API tokens, no refresh configuration available");
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

  async initialize(settings: LinkwardenSettings): Promise<void> {
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
      return await this.apiClient.testConnection("/api/v1/links");
    } catch (error) {
      console.error("Linkwarden connection test failed:", error);
      return false;
    }
  }
  async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.apiClient.post("/api/v1/links", {
      url: article.url,
      name: article.title,
    });
    const validatedData = v.parse(linkwardenSaveResponseSchema, response.data);

    if ("error" in validatedData) {
      throw new Error(`Failed to save article: ${validatedData.message || validatedData.error}`);
    }

    return this.mapArticle(validatedData.response);
  }
  async deleteArticle(id: number): Promise<void> {
    await this.apiClient.delete(`/api/v1/links/${id}`);
  }
  async sync(options?: SyncOptions): Promise<SyncResult> {
    // Build query parameters based on sync options
    const queryParams = new URLSearchParams();

    // Add incremental sync support if lastSyncTimestamp is provided
    if (options?.lastSyncTimestamp && options.mode === "update") {
      queryParams.set("createdAfter", options.lastSyncTimestamp);
    }

    const url = queryParams.toString()
      ? `/api/v1/links?${queryParams.toString()}`
      : "/api/v1/links";

    const response = await this.apiClient.get(url);
    const validatedData = v.parse(linkwardenSyncResponseSchema, response.data);

    if ("error" in validatedData) {
      throw new Error(`Failed to sync articles: ${validatedData.message || validatedData.error}`);
    }

    const articles = validatedData.response.data.map((item) => this.mapArticle(item));
    const mode = options?.mode || "overwrite";

    return {
      articles,
      mode,
      metadata: {
        totalFetched: articles.length,
        totalProcessed: articles.length,
        lastSyncTimestamp: new Date().toISOString(),
        apiVersion: "1.0",
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

  private mapArticle(item: LinkwardenItem): Article {
    return {
      id: item.id,
      title: item.name,
      url: item.url,
      created_at: item.createdAt,
    };
  }
}
