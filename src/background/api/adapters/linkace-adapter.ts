import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";
import { createApiClient, type ApiClient } from "../api-client";

export const linkaceConfigSchema = v.object({
	url: v.string([v.url()]),
	token: v.string(),
});

export const linkaceSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("linkace"),
		apiConfig: linkaceConfigSchema,
	}),
]);

export type LinkaceSettings = v.Input<typeof linkaceSettingsSchema>;
export type LinkaceConfig = v.Input<typeof linkaceConfigSchema>;

// Valibot schemas for API responses based on LinkAce API documentation
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
	// Additional fields that may be present
	lists: v.optional(v.array(linkaceListSchema)),
	tags: v.optional(v.array(linkaceTagSchema)),
	visibility: v.optional(v.number()),
	check_disabled: v.optional(v.union([v.boolean(), v.number()])),
	status: v.optional(v.number()),
	icon: v.optional(v.nullable(v.string())),
	thumbnail: v.optional(v.nullable(v.string())),
});

// Error response schemas
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

export class LinkaceAdapter
	implements ReadItLaterAPI<LinkaceSettings>, TokenizedAdapter
{
	public readonly displayName = "LinkAce";
	private apiUrl: string = "";
	private token: string = "";
	private apiClient!: ApiClient;

	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];

	// TokenizedAdapter interface implementation
	getServiceName(): string {
		return "linkace";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		// LinkAce uses static API tokens, no refresh needed
		throw new Error(
			"LinkAce uses static API tokens, no refresh configuration available",
		);
	}

	createTokenMetadata(_tokenData: Record<string, unknown>) {
		// For static tokens, create a simple metadata structure
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
		// LinkAce doesn't have a traditional auth endpoint
		return "";
	}

	async initialize(settings: LinkaceSettings): Promise<void> {
		this.apiUrl = settings.apiConfig.url;
		this.token = settings.apiConfig.token;

		// Store the static token in the token manager
		const tokenMetadata = this.createTokenMetadata({});
		await tokenManager.storeToken(this.getServiceName(), tokenMetadata);

		// Initialize the API client
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
			console.error("LinkAce connection test failed:", error);
			return false;
		}
	}

	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.apiClient.post("/api/v2/links", {
			url: article.url,
			title: article.title,
			visibility: 1, // Private by default
			check_disabled: false,
		});
		const validatedData = v.parse(linkaceSaveResponseSchema, response.data);

		// Check if it's an error response
		if ("message" in validatedData) {
			throw new Error(`Failed to save article: ${validatedData.message}`);
		}

		return this.mapArticle(validatedData.data);
	}

	async deleteArticle(id: number): Promise<void> {
		await this.apiClient.delete(`/api/v2/links/${id}`);
	}

	async sync(): Promise<Article[]> {
		const perPage = 30;
		const allArticles: Article[] = [];
		let currentPage = 1;
		let hasMorePages = true;

		while (hasMorePages) {
			const response = await this.apiClient.get(
				`/api/v2/links?page=${currentPage}&per_page=${perPage}`,
			);
			const validatedData = v.parse(linkaceSyncResponseSchema, response.data);

			// Check if it's an error response
			if ("message" in validatedData) {
				throw new Error(`Failed to sync articles: ${validatedData.message}`);
			}

			allArticles.push(
				...validatedData.data.map((item) => this.mapArticle(item)),
			);

			// Check if there are more pages
			if (validatedData.meta) {
				hasMorePages = currentPage < validatedData.meta.last_page;
			} else {
				// If no meta information, assume no more pages if we got less than perPage items
				hasMorePages = validatedData.data.length === perPage;
			}

			currentPage++;
		}

		return allArticles;
	}

	// Cleanup method to clear tokens when adapter is no longer needed
	public async cleanup(): Promise<void> {
		await this.apiClient.clearToken();
	}

	// Method to get token health information for debugging
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
