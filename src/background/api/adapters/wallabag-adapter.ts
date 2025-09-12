import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
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

// Valibot schemas for API responses based on official documentation
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
	// Additional fields that may be present
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
	scope: v.optional(v.string()),
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
	private readonly RATE_LIMIT_DELAY: number = 1000;
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "clientId", label: "Client ID" },
		{ name: "clientSecret", label: "Client Secret" },
		{ name: "username", label: "Username" },
		{ name: "password", label: "Password" },
	];

	// TokenizedAdapter interface implementation
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

		return {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token || "",
			tokenType: tokenData.token_type || "Bearer",
			expiresAt: now + expiresIn * 1000,
			issuedAt: now,
			scope: tokenData.scope,
			refreshCount: 0,
		};
	}

	getBaseUrl(): string {
		return this.apiUrl;
	}

	getAuthEndpoint(): string {
		return `${this.apiUrl}/oauth/v2/token`;
	}
	async initialize(settings: WallabagSettings): Promise<void> {
		this.config = settings.apiConfig;
		this.apiUrl = this.config.url;
		await this.authenticate();
	}

	private async authenticate(): Promise<void> {
		const response = await fetch(this.getAuthEndpoint(), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "password",
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				username: this.config.username,
				password: this.config.password || "",
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Failed to authenticate with Wallabag API: ${response.status} ${errorText}`,
			);
		}

		const tokenData = await response.json();
		const validatedTokenData = v.parse(wallabagTokenResponseSchema, tokenData);

		const tokenMetadata = this.createTokenMetadata(validatedTokenData);
		tokenManager.storeToken(this.getServiceName(), tokenMetadata);

		console.log("Wallabag authentication successful", {
			tokenType: tokenMetadata.tokenType,
			expiresAt: new Date(tokenMetadata.expiresAt).toISOString(),
			scope: tokenMetadata.scope,
		});
	}

	private async makeAuthenticatedRequest(
		url: string,
		options: RequestInit = {},
	): Promise<Response> {
		const accessToken = await tokenManager.getAccessToken(
			this.getServiceName(),
		);
		const tokenMetadata = tokenManager.getTokenMetadata(this.getServiceName());

		const response = await fetch(url, {
			...options,
			headers: {
				...options.headers,
				Authorization: `${tokenMetadata?.tokenType} ${accessToken}`,
			},
		});

		// If we get a 401, try to refresh the token and retry once
		if (response.status === 401) {
			console.warn("Received 401, attempting token refresh");
			const refreshResult = await tokenManager.refreshToken(
				this.getServiceName(),
				this.getTokenRefreshConfig(),
			);

			if (refreshResult.success) {
				// Refresh successful, retry with new token
				const newAccessToken = await tokenManager.getAccessToken(
					this.getServiceName(),
				);
				const newTokenMetadata = tokenManager.getTokenMetadata(
					this.getServiceName(),
				);

				return fetch(url, {
					...options,
					headers: {
						...options.headers,
						Authorization: `${newTokenMetadata?.tokenType} ${newAccessToken}`,
					},
				});
			} else if (refreshResult.requiresReauth) {
				// Refresh failed, need to re-authenticate
				console.warn(
					"Token refresh failed, re-authenticating:",
					refreshResult.error,
				);
				await this.authenticate();

				// Retry with fresh token
				const newAccessToken = await tokenManager.getAccessToken(
					this.getServiceName(),
				);
				const newTokenMetadata = tokenManager.getTokenMetadata(
					this.getServiceName(),
				);

				return fetch(url, {
					...options,
					headers: {
						...options.headers,
						Authorization: `${newTokenMetadata?.tokenType} ${newAccessToken}`,
					},
				});
			} else {
				// Unexpected error
				throw new Error(`Token refresh failed: ${refreshResult.error}`);
			}
		}

		return response;
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

	async testConnection(): Promise<boolean> {
		try {
			const response = await this.makeAuthenticatedRequest(
				`${this.apiUrl}/api/entries.json?page=1&perPage=1`,
			);
			return response.ok;
		} catch (error) {
			console.error("Wallabag connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.makeAuthenticatedRequest(
			`${this.apiUrl}/api/entries.json`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url: article.url,
					title: article.title,
				}),
			},
		);
		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}
		const data = await response.json();
		const validatedData = v.parse(wallabagSaveResponseSchema, data);

		// Check if it's an error response
		if ("error" in validatedData) {
			throw new Error(
				`Failed to save article: ${validatedData.error_description || validatedData.message || validatedData.error}`,
			);
		}

		return this.mapArticle(validatedData);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await this.makeAuthenticatedRequest(
			`${this.apiUrl}/api/entries/${id}.json`,
			{
				method: "DELETE",
			},
		);
		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}
	async sync(): Promise<Article[]> {
		const perPage = 30;
		const allArticles: Article[] = [];
		const firstResponse = await this.makeAuthenticatedRequest(
			`${this.apiUrl}/api/entries.json?page=1&perPage=${perPage}&detail=metadata`,
		);
		if (!firstResponse.ok) {
			throw new Error(`Failed to get articles: ${firstResponse.statusText}`);
		}
		const firstData = await firstResponse.json();
		const validatedFirstData = v.parse(wallabagSyncResponseSchema, firstData);

		// Check if it's an error response
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
			await new Promise((resolve) =>
				setTimeout(resolve, this.RATE_LIMIT_DELAY),
			);
			const response = await this.makeAuthenticatedRequest(
				`${this.apiUrl}/api/entries.json?page=${page}&perPage=${perPage}&detail=metadata`,
			);
			if (!response.ok) {
				throw new Error(`Failed to get articles: ${response.statusText}`);
			}
			const data = await response.json();
			const validatedData = v.parse(wallabagSyncResponseSchema, data);

			// Check if it's an error response
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
