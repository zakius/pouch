import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const raindropConfigSchema = z.object({
	apiKey: z.string(),
});

export const raindropSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("raindrop"),
	apiConfig: raindropConfigSchema,
});

export type RaindropSettings = z.infer<typeof raindropSettingsSchema>;
export type RaindropConfig = z.infer<typeof raindropConfigSchema>;

// Zod schemas for API responses based on official documentation
const raindropItemSchema = z.object({
	_id: z.number(),
	title: z.string(),
	link: z.string(),
	created: z.string(),
	cover: z.string().nullable().optional(),
	tags: z.array(z.string()),
	// Additional fields that may be present
	excerpt: z.string().nullable().optional(),
	type: z.string().nullable().optional(),
	domain: z.string().nullable().optional(),
	lastUpdate: z.string().nullable().optional(),
	important: z.union([z.boolean(), z.number()]).optional(),
	collection: z
		.object({
			$id: z.number(),
		})
		.optional(),
});

// Error response schemas based on official documentation
const raindropErrorSchema = z.object({
	result: z.literal(false),
	error: z.union([z.number(), z.string()]).optional(),
	errorMessage: z.string().optional(),
});

const raindropSuccessResponseSchema = z.object({
	result: z.literal(true),
});

const raindropSaveResponseSchema = z.union([
	raindropSuccessResponseSchema.extend({
		item: raindropItemSchema,
	}),
	raindropErrorSchema,
]);

const raindropDeleteResponseSchema = z.union([
	raindropSuccessResponseSchema,
	raindropErrorSchema,
]);

const raindropSyncResponseSchema = z.union([
	raindropSuccessResponseSchema.extend({
		items: z.array(raindropItemSchema),
		count: z.number().optional(),
	}),
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

export class RaindropAdapter implements ReadItLaterAPI<RaindropSettings> {
	public readonly displayName = "Raindrop.io";
	private apiUrl = "https://api.raindrop.io/rest/v1";
	private apiKey = "";
	private readonly LOW_RATE_LIMIT_THRESHOLD = 10;
	formConfig = [{ name: "apiKey", label: "API Key (Test Token)" }];
	async initialize(settings: RaindropSettings): Promise<void> {
		const config = settings.apiConfig;
		this.apiKey = config.apiKey;
	}
	async testConnection(): Promise<boolean> {
		try {
			const response = await this._fetchWithRateLimit(
				`${this.apiUrl}/collections`,
				{
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
					},
				},
			);
			return response.ok;
		} catch (error) {
			console.error("Raindrop connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this._fetchWithRateLimit(`${this.apiUrl}/raindrop`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				link: article.url,
				title: article.title,
			}),
		});
		const data = await response.json();
		const validatedData = raindropSaveResponseSchema.parse(data);
		if (!validatedData.result) {
			throw new Error(
				`Failed to save article: ${validatedData.errorMessage || "API returned an error"}`,
			);
		}
		return this.mapArticle(validatedData.item);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await this._fetchWithRateLimit(
			`${this.apiUrl}/raindrop/${id}`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
				},
			},
		);
		const data = await response.json();
		const validatedData = raindropDeleteResponseSchema.parse(data);
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
			const response = await this._fetchWithRateLimit(
				`${this.apiUrl}/raindrops/0?page=${page}&perpage=${perPage}&sort=-created`,
				{
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
					},
				},
			);
			const data = await response.json();
			const validatedData = raindropSyncResponseSchema.parse(data);
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
