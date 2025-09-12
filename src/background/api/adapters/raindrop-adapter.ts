import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
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

// Valibot schemas for API responses based on official documentation
const raindropItemSchema = v.object({
	_id: v.number(),
	title: v.string(),
	link: v.string(),
	created: v.string(),
	cover: v.optional(v.nullable(v.string())),
	tags: v.array(v.string()),
	// Additional fields that may be present
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

// Error response schemas based on official documentation
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
	private readonly LOW_RATE_LIMIT_THRESHOLD = 10;
	formConfig = [{ name: "apiKey", label: "API Key (Test Token)" }];

	// TokenizedAdapter interface implementation
	getServiceName(): string {
		return "raindrop";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		// Raindrop uses static API keys, no refresh needed
		throw new Error(
			"Raindrop uses static API keys, no refresh configuration available",
		);
	}

	createTokenMetadata(_tokenData: Record<string, unknown>) {
		// For static tokens, create a simple metadata structure
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
		// Raindrop doesn't have a traditional auth endpoint
		return "";
	}

	async initialize(settings: RaindropSettings): Promise<void> {
		const config = settings.apiConfig;
		this.apiKey = config.apiKey;

		// Store the static token in the token manager
		const tokenMetadata = this.createTokenMetadata({});
		tokenManager.storeToken(this.getServiceName(), tokenMetadata);
	}
	private async makeAuthenticatedRequest(
		url: string,
		options: RequestInit = {},
	): Promise<Response> {
		const accessToken = await tokenManager.getAccessToken(
			this.getServiceName(),
		);

		return this._fetchWithRateLimit(url, {
			...options,
			headers: {
				...options.headers,
				Authorization: `Bearer ${accessToken}`,
			},
		});
	}

	async testConnection(): Promise<boolean> {
		try {
			const response = await this.makeAuthenticatedRequest(
				`${this.apiUrl}/collections`,
			);
			return response.ok;
		} catch (error) {
			console.error("Raindrop connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.makeAuthenticatedRequest(
			`${this.apiUrl}/raindrop`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					link: article.url,
					title: article.title,
				}),
			},
		);
		const data = await response.json();
		const validatedData = v.parse(raindropSaveResponseSchema, data);
		if (!validatedData.result) {
			throw new Error(
				`Failed to save article: ${validatedData.errorMessage || "API returned an error"}`,
			);
		}
		return this.mapArticle(validatedData.item);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await this.makeAuthenticatedRequest(
			`${this.apiUrl}/raindrop/${id}`,
			{
				method: "DELETE",
			},
		);
		const data = await response.json();
		const validatedData = v.parse(raindropDeleteResponseSchema, data);
		if (!validatedData.result) {
			throw new Error(
				`Failed to delete article: ${validatedData.errorMessage || "API returned an error"}`,
			);
		}
	}
	async sync(): Promise<Article[]> {
		const perPage = 50;
		let allArticles: Article[] = [];
		let page = 0;
		let totalPages = 1;
		do {
			const response = await this.makeAuthenticatedRequest(
				`${this.apiUrl}/raindrops/0?page=${page}&perpage=${perPage}&sort=-created`,
			);
			const data = await response.json();
			const validatedData = v.parse(raindropSyncResponseSchema, data);
			if (!validatedData.result) {
				throw new Error(
					`Failed to get articles: ${validatedData.errorMessage || "API returned an error"}`,
				);
			}
			const articles = validatedData.items.map((item: RaindropItem) =>
				this.mapArticle(item),
			);
			allArticles = allArticles.concat(articles);
			if (page === 0) {
				totalPages = Math.ceil((validatedData.count || 0) / perPage);
			}
			page++;
		} while (page < totalPages);
		return allArticles;
	}

	// Cleanup method to clear tokens when adapter is no longer needed
	public cleanup(): void {
		tokenManager.clearToken(this.getServiceName());
	}

	// Method to get token health information for debugging
	public getTokenHealth(): {
		isValid: boolean;
		expiresAt?: string;
		refreshCount?: number;
	} {
		const health = tokenManager.getTokenHealth();
		return health[this.getServiceName()] || { isValid: false };
	}

	private async _fetchWithRateLimit(
		url: string,
		options: RequestInit,
		retryCount = 3,
	): Promise<Response> {
		for (let i = 0; i < retryCount; i++) {
			const response = await fetch(url, options);
			if (response.status === 429) {
				const retryAfterHeader = response.headers.get("Retry-After");
				const rateLimitResetHeader = response.headers.get("X-RateLimit-Reset");
				let delay = 1000 * (i + 1);
				if (retryAfterHeader) {
					delay = parseInt(retryAfterHeader, 10) * 1000;
				} else if (rateLimitResetHeader) {
					const resetTime = parseInt(rateLimitResetHeader, 10) * 1000;
					delay = Math.max(0, resetTime - Date.now());
				}
				console.warn(`Rate limit hit. Retrying after ${delay}ms.`);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			if (!response.ok) {
				throw new Error(`API request failed: ${response.statusText}`);
			}
			const remaining = response.headers.get("X-RateLimit-Remaining");
			if (
				remaining &&
				parseInt(remaining, 10) < this.LOW_RATE_LIMIT_THRESHOLD
			) {
				const reset = response.headers.get("X-RateLimit-Reset");
				if (reset) {
					const delay = Math.max(0, parseInt(reset, 10) * 1000 - Date.now());
					console.warn(
						`Approaching rate limit. Pausing for ${delay}ms to allow reset.`,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
			return response;
		}
		throw new Error(
			"Request failed after multiple retries due to rate limiting.",
		);
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
