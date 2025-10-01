import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import { logger } from "../../../utils/logger";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import { type ApiClient, createApiClient } from "../api-client";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";

export const wallabagConfigSchema = v.object({
	url: v.string([v.url()]),
	clientId: v.string(),
	clientSecret: v.string(),
	username: v.string(),
	password: v.optional(v.string()),
});

export const wallabagSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("wallabag"),
		apiConfig: wallabagConfigSchema,
	}),
]);

export type WallabagSettings = v.Input<typeof wallabagSettingsSchema>;
export type WallabagConfig = v.Input<typeof wallabagConfigSchema>;

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

const wallabagSaveResponseSchema = v.union([
	wallabagItemSchema,
	wallabagErrorSchema,
]);

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

export class WallabagAdapter
	implements ReadItLaterAPI<WallabagSettings>, TokenizedAdapter
{
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
			refreshToken:
				tokenManager.getTokenMetadata(this.getServiceName())?.refreshToken ||
				"",
		};
	}

	createTokenMetadata(tokenData: v.Output<typeof wallabagTokenResponseSchema>) {
		const now = Date.now();
		const expiresIn = tokenData.expires_in || 3600; // Default to 1 hour

		const tokenType = tokenData.token_type
			? tokenData.token_type.charAt(0).toUpperCase() +
				tokenData.token_type.slice(1).toLowerCase()
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
		logger.info(
			`Performing full re-authentication for ${this.getServiceName()}`,
		);
		await this.authenticate();
	}
	async initialize(settings: WallabagSettings): Promise<void> {
		this.config = settings.apiConfig;
		this.apiUrl = this.config.url;

		if (!this.config.password) {
			throw new Error("Password is required for Wallabag authentication");
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

		console.log("Wallabag authentication request:", {
			url: this.getAuthEndpoint(),
			body: requestBody.toString(),
			hasPassword: !!this.config.password,
		});

		const response = await fetch(this.getAuthEndpoint(), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: requestBody,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to authenticate with Wallabag API: ${response.status} ${errorText}`,
			);
		}

		const tokenData = (await response.json()) as Record<string, unknown>;
		console.log("Wallabag API response:", tokenData);

		if (tokenData.error) {
			const errorMessage =
				(tokenData.error_description as string) ||
				(tokenData.message as string) ||
				(tokenData.error as string);
			throw new Error(`Wallabag authentication failed: ${errorMessage}`);
		}

		let validatedTokenData: v.Output<typeof wallabagTokenResponseSchema>;
		try {
			validatedTokenData = v.parse(wallabagTokenResponseSchema, tokenData);
		} catch (validationError: unknown) {
			console.error(
				"Validation error for Wallabag token response:",
				validationError,
			);
			console.error("Raw token data:", tokenData);
			throw new Error(
				`Invalid token response from Wallabag API: ${validationError instanceof Error ? validationError.message : "Unknown validation error"}`,
			);
		}

		const tokenMetadata = this.createTokenMetadata(validatedTokenData);
		await tokenManager.storeToken(this.getServiceName(), tokenMetadata);

		console.log("Wallabag authentication successful", {
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
			return await this.apiClient.testConnection(
				"/api/entries.json?page=1&perPage=1",
			);
		} catch (error) {
			console.error("Wallabag connection test failed:", error);
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
	async sync(): Promise<Article[]> {
		const perPage = 30;
		const allArticles: Article[] = [];
		const firstResponse = await this.apiClient.get(
			`/api/entries.json?page=1&perPage=${perPage}&detail=metadata`,
		);
		const validatedFirstData = v.parse(
			wallabagSyncResponseSchema,
			firstResponse.data,
		);

		if ("error" in validatedFirstData) {
			throw new Error(
				`Failed to get articles: ${validatedFirstData.error_description || validatedFirstData.message || validatedFirstData.error}`,
			);
		}

		allArticles.push(
			...validatedFirstData._embedded.items.map((item) =>
				this.mapArticle(item),
			),
		);
		const total = validatedFirstData.total;
		const totalPages = Math.ceil(total / perPage);
		for (let page = 2; page <= totalPages; page++) {
			const response = await this.apiClient.get(
				`/api/entries.json?page=${page}&perPage=${perPage}&detail=metadata`,
			);
			const validatedData = v.parse(wallabagSyncResponseSchema, response.data);

			if ("error" in validatedData) {
				throw new Error(
					`Failed to get articles: ${validatedData.error_description || validatedData.message || validatedData.error}`,
				);
			}

			allArticles.push(
				...validatedData._embedded.items.map((item) => this.mapArticle(item)),
			);
		}
		return allArticles;
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
