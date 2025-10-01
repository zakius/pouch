import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import { type ApiClient, createApiClient } from "../api-client";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";

export const karakeepConfigSchema = v.object({
	url: v.string([v.url()]),
	token: v.string(),
});

export const karakeepSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("karakeep"),
		apiConfig: karakeepConfigSchema,
	}),
]);

export type KarakeepSettings = v.Input<typeof karakeepSettingsSchema>;
export type KarakeepConfig = v.Input<typeof karakeepConfigSchema>;

const karakeepItemSchema = v.object({
	id: v.number(),
	title: v.string(),
	url: v.string(),
	createdAt: v.string(),
	cover: v.optional(v.nullable(v.string())),
	description: v.optional(v.nullable(v.string())),
	summary: v.optional(v.nullable(v.string())),
	content: v.optional(v.nullable(v.string())),
	status: v.optional(v.nullable(v.string())),
	tags: v.optional(
		v.array(
			v.object({
				id: v.number(),
				name: v.string(),
			}),
		),
	),
	highlights: v.optional(v.array(v.unknown())),
	assets: v.optional(v.array(v.unknown())),
});

const karakeepErrorSchema = v.object({
	error: v.string(),
	message: v.optional(v.string()),
	status: v.optional(v.number()),
});

const karakeepSaveResponseSchema = v.union([
	karakeepItemSchema,
	karakeepErrorSchema,
]);

const karakeepSyncResponseSchema = v.union([
	v.array(karakeepItemSchema),
	karakeepErrorSchema,
]);

interface KarakeepItem {
	id: number;
	title: string;
	url: string;
	createdAt: string;
	cover?: string | null;
	description?: string | null;
	summary?: string | null;
	content?: string | null;
	status?: string | null;
	tags?: { id: number; name: string }[];
	highlights?: unknown[];
	assets?: unknown[];
}

export class KarakeepAdapter
	implements ReadItLaterAPI<KarakeepSettings>, TokenizedAdapter
{
	public readonly displayName = "Karakeep";
	private apiUrl: string = "";
	private token: string = "";
	private apiClient!: ApiClient;
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];

	getServiceName(): string {
		return "karakeep";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		throw new Error(
			"Karakeep uses static API tokens, no refresh configuration available",
		);
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

	async initialize(settings: KarakeepSettings): Promise<void> {
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
			return await this.apiClient.testConnection("/bookmarks");
		} catch (error) {
			console.error("Karakeep connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.apiClient.post("/bookmarks", {
			url: article.url,
			title: article.title,
		});
		const validatedData = v.parse(karakeepSaveResponseSchema, response.data);

		if ("error" in validatedData) {
			throw new Error(
				`Failed to save article: ${validatedData.message || validatedData.error}`,
			);
		}

		return this.mapArticle(validatedData);
	}
	async deleteArticle(id: number): Promise<void> {
		await this.apiClient.delete(`/bookmarks/${id}`);
	}
	async sync(): Promise<Article[]> {
		const response = await this.apiClient.get("/bookmarks");
		const validatedData = v.parse(karakeepSyncResponseSchema, response.data);

		if ("error" in validatedData) {
			throw new Error(
				`Failed to sync articles: ${validatedData.message || validatedData.error}`,
			);
		}

		return validatedData.map(this.mapArticle);
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

	private mapArticle(item: KarakeepItem): Article {
		return {
			id: item.id,
			title: item.title,
			url: item.url,
			created_at: item.createdAt,
		};
	}
}
