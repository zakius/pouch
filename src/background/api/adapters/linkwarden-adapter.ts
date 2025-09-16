import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";
import { createApiClient, type ApiClient } from "../api-client";

export const linkwardenConfigSchema = v.object({
	url: v.string([v.url()]),
	token: v.string(),
});

export const linkwardenSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("linkwarden"),
		apiConfig: linkwardenConfigSchema,
	}),
]);

export type LinkwardenSettings = v.Input<typeof linkwardenSettingsSchema>;
export type LinkwardenConfig = v.Input<typeof linkwardenConfigSchema>;

// Valibot schemas for API responses based on official documentation
const linkwardenItemSchema = v.object({
	id: v.number(),
	name: v.string(),
	url: v.string(),
	createdAt: v.string(),
	image: v.optional(v.nullable(v.string())),
	// Additional fields that may be present based on API docs
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

// Error response schemas
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

export class LinkwardenAdapter
	implements ReadItLaterAPI<LinkwardenSettings>, TokenizedAdapter
{
	public readonly displayName = "Linkwarden";
	private apiUrl: string = "";
	private token: string = "";
	private apiClient!: ApiClient;
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];

	// TokenizedAdapter interface implementation
	getServiceName(): string {
		return "linkwarden";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		// Linkwarden uses static API tokens, no refresh needed
		throw new Error(
			"Linkwarden uses static API tokens, no refresh configuration available",
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
		// Linkwarden doesn't have a traditional auth endpoint
		return "";
	}

	async initialize(settings: LinkwardenSettings): Promise<void> {
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

		// Check if it's an error response
		if ("error" in validatedData) {
			throw new Error(
				`Failed to save article: ${validatedData.message || validatedData.error}`,
			);
		}

		return this.mapArticle(validatedData.response);
	}
	async deleteArticle(id: number): Promise<void> {
		await this.apiClient.delete(`/api/v1/links/${id}`);
	}
	async sync(): Promise<Article[]> {
		const response = await this.apiClient.get("/api/v1/links");
		const validatedData = v.parse(linkwardenSyncResponseSchema, response.data);

		// Check if it's an error response
		if ("error" in validatedData) {
			throw new Error(
				`Failed to sync articles: ${validatedData.message || validatedData.error}`,
			);
		}

		return validatedData.response.data.map(this.mapArticle);
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

	private mapArticle(item: LinkwardenItem): Article {
		return {
			id: item.id,
			title: item.name,
			url: item.url,
			created_at: item.createdAt,
		};
	}
}
