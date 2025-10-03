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

export const raindropConfigSchema = v.object({
	apiKey: v.string(),
});

export const raindropSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("raindrop"),
		apiConfig: raindropConfigSchema,
	}),
]);

export type RaindropSettings = v.Input<typeof raindropSettingsSchema>;
export type RaindropConfig = v.Input<typeof raindropConfigSchema>;

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
	collection: v.optional(
		v.object({
			$id: v.number(),
		}),
	),
});

const raindropErrorSchema = v.object({
	result: v.literal(false),
	error: v.optional(v.union([v.number(), v.string()])),
	errorMessage: v.optional(v.string()),
});

const raindropSuccessResponseSchema = v.object({
	result: v.literal(true),
});

const raindropSaveResponseSchema = v.union([
	v.merge([
		raindropSuccessResponseSchema,
		v.object({
			item: raindropItemSchema,
		}),
	]),
	raindropErrorSchema,
]);

const raindropDeleteResponseSchema = v.union([
	raindropSuccessResponseSchema,
	raindropErrorSchema,
]);

const raindropSyncResponseSchema = v.union([
	v.merge([
		raindropSuccessResponseSchema,
		v.object({
			items: v.array(raindropItemSchema),
			count: v.optional(v.number()),
		}),
	]),
	raindropErrorSchema,
]);

interface RaindropItem {
	_id: number;
	title: string;
	link: string;
	created: string;
	cover?: string | null;
	tags: string[];
	excerpt?: string | null;
	type?: string | null;
	domain?: string | null;
	lastUpdate?: string | null;
	important?: boolean | number;
	collection?: {
		$id: number;
	};
}

export class RaindropAdapter
	implements ReadItLaterAPI<RaindropSettings>, TokenizedAdapter
{
	public readonly displayName = "Raindrop.io";
	private apiUrl = "https://api.raindrop.io/rest/v1";
	private apiKey = "";
	private apiClient!: ApiClient;
	formConfig = [{ name: "apiKey", label: "API Key (Test Token)" }];

	getServiceName(): string {
		return "raindrop";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		throw new Error(
			"Raindrop uses static API keys, no refresh configuration available",
		);
	}

	createTokenMetadata(_tokenData: Record<string, unknown>) {
		const now = Date.now();
		return {
			accessToken: this.apiKey,
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

	async initialize(settings: RaindropSettings): Promise<void> {
		const config = settings.apiConfig;
		this.apiKey = config.apiKey;

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
			return await this.apiClient.testConnection("/collections");
		} catch (error) {
			console.error("Raindrop connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.apiClient.post("/raindrop", {
			link: article.url,
			title: article.title,
		});
		const validatedData = v.parse(raindropSaveResponseSchema, response.data);
		if (!validatedData.result) {
			throw new Error(
				`Failed to save article: ${validatedData.errorMessage || "API returned an error"}`,
			);
		}
		return this.mapArticle(validatedData.item);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await this.apiClient.delete(`/raindrop/${id}`);
		const validatedData = v.parse(raindropDeleteResponseSchema, response.data);
		if (!validatedData.result) {
			throw new Error(
				`Failed to delete article: ${validatedData.errorMessage || "API returned an error"}`,
			);
		}
	}
	async sync(options?: SyncOptions): Promise<SyncResult> {
		const perPage = 50;
		let allArticles: Article[] = [];
		let page = 0;
		let totalPages = 1;
		let totalFetched = 0;

		// Build query parameters based on sync options
		const queryParams = new URLSearchParams({
			page: "0",
			perpage: perPage.toString(),
			sort: "-created",
		});

		// Add incremental sync support if lastSyncTimestamp is provided
		if (options?.lastSyncTimestamp && options.mode === "update") {
			queryParams.set("search", `created:>${options.lastSyncTimestamp}`);
		}

		do {
			queryParams.set("page", page.toString());
			const response = await this.apiClient.get(
				`/raindrops/0?${queryParams.toString()}`,
			);
			const validatedData = v.parse(raindropSyncResponseSchema, response.data);
			if (!validatedData.result) {
				throw new Error(
					`Failed to get articles: ${validatedData.errorMessage || "API returned an error"}`,
				);
			}
			const articles = validatedData.items.map((item: RaindropItem) =>
				this.mapArticle(item),
			);
			allArticles = allArticles.concat(articles);
			totalFetched += articles.length;

			if (page === 0) {
				totalPages = Math.ceil((validatedData.count || 0) / perPage);
			}
			page++;
		} while (page < totalPages);

		const mode = options?.mode || "overwrite";

		return {
			articles: allArticles,
			mode,
			metadata: {
				totalFetched,
				totalProcessed: allArticles.length,
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
	private mapArticle(item: RaindropItem): Article {
		return {
			id: item._id,
			title: item.title,
			url: item.link,
			created_at: item.created,
		};
	}
}
