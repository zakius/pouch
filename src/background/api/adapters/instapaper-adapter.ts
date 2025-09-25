import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { TokenRefreshConfig } from "../../token-manager";
import { tokenManager } from "../../token-manager";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
import type { TokenizedAdapter } from "../tokenized-adapter";
import { logger } from "../../../utils/logger";

export const instapaperConfigSchema = v.object({
	consumerKey: v.string(),
	consumerSecret: v.string(),
	username: v.string(),
	password: v.optional(v.string()),
});

export const instapaperSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("instapaper"),
		apiConfig: instapaperConfigSchema,
	}),
]);

export type InstapaperSettings = v.Input<typeof instapaperSettingsSchema>;
export type InstapaperConfig = v.Input<typeof instapaperConfigSchema>;

const instapaperTagSchema = v.object({
	id: v.number(),
	name: v.string(),
});

const instapaperBookmarkSchema = v.object({
	type: v.literal("bookmark"),
	bookmark_id: v.number(),
	url: v.string(),
	title: v.string(),
	description: v.optional(v.nullable(v.string())),
	tags: v.optional(v.array(instapaperTagSchema)),
	time: v.optional(v.number()),
	image_url: v.optional(v.nullable(v.string())),
	progress: v.optional(v.number()),
	progress_timestamp: v.optional(v.number()),
	private_source: v.optional(v.nullable(v.string())),
});

const instapaperUserSchema = v.object({
	type: v.literal("user"),
	user_id: v.number(),
	username: v.string(),
});

const instapaperErrorSchema = v.object({
	type: v.literal("error"),
	error_code: v.number(),
	message: v.string(),
});

const instapaperMetaSchema = v.object({
	type: v.literal("meta"),
});

const instapaperResponseItemSchema = v.union([
	instapaperBookmarkSchema,
	instapaperUserSchema,
	instapaperErrorSchema,
	instapaperMetaSchema,
]);

const instapaperSaveResponseSchema = v.array(instapaperResponseItemSchema);

const instapaperSyncResponseSchema = v.object({
	user: instapaperUserSchema,
	bookmarks: v.array(instapaperBookmarkSchema),
	highlights: v.optional(v.array(v.unknown())), // We don't use highlights
	delete_ids: v.optional(v.array(v.number())),
});

interface InstapaperBookmark {
	type: "bookmark";
	bookmark_id: number;
	url: string;
	title: string;
	description?: string | null;
	tags?: { id: number; name: string }[];
	time?: number;
	image_url?: string | null;
	progress?: number;
	progress_timestamp?: number;
	private_source?: string | null;
}

interface InstapaperError {
	type: "error";
	error_code: number;
	message: string;
}

export class InstapaperAdapter implements ReadItLaterAPI<InstapaperSettings>, TokenizedAdapter {
	public readonly displayName = "Instapaper";
	private apiUrl = "https://www.instapaper.com";
	private config!: InstapaperConfig;
	private accessToken: string | null = null;
	private accessTokenSecret: string | null = null;
	formConfig = [
		{ name: "consumerKey", label: "OAuth Consumer Key" },
		{ name: "consumerSecret", label: "OAuth Consumer Secret" },
		{ name: "username", label: "Instapaper Username" },
		{ name: "password", label: "Instapaper Password" },
	];

	getServiceName(): string {
		return "instapaper";
	}

	getTokenRefreshConfig(): TokenRefreshConfig {
		throw new Error("Instapaper uses OAuth 1.0a, no refresh configuration available");
	}

	createTokenMetadata(_tokenData: Record<string, unknown>) {
		const now = Date.now();
		return {
			accessToken: this.accessToken || "",
			refreshToken: "", // No refresh token for OAuth 1.0a
			tokenType: "OAuth",
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
		return `${this.apiUrl}/api/1/oauth/access_token`;
	}

	/**
	 * Perform full re-authentication when tokens are invalid
	 */
	async reAuthenticate(): Promise<void> {
		logger.info(`Performing full re-authentication for ${this.getServiceName()}`);
		await this.authenticate();
	}
	async initialize(settings: InstapaperSettings): Promise<void> {
		this.config = settings.apiConfig;
		await this.authenticate();
	}

	private async authenticate(): Promise<void> {
		const response = await fetch(`${this.apiUrl}/api/1/oauth/access_token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				x_auth_username: this.config.username,
				x_auth_password: this.config.password || "",
				x_auth_mode: "client_auth",
			}),
		});
		if (!response.ok) {
			throw new Error("Failed to authenticate with Instapaper");
		}
		const tokenData = await response.text();
		const params = new URLSearchParams(tokenData);
		this.accessToken = params.get("oauth_token");
		this.accessTokenSecret = params.get("oauth_token_secret");
		if (!this.accessToken || !this.accessTokenSecret) {
			throw new Error("Failed to obtain Instapaper access token");
		}

		const tokenMetadata = this.createTokenMetadata({});
		await tokenManager.storeToken(this.getServiceName(), tokenMetadata);
	}
	async testConnection(): Promise<boolean> {
		try {
			await this._makeSignedRequest("/api/1/bookmarks/list", { limit: 1 });
			return true;
		} catch (error) {
			console.error("Instapaper connection test failed:", error);
			return false;
		}
	}

	public async cleanup(): Promise<void> {
		await tokenManager.clearToken(this.getServiceName());
	}

	public getTokenHealth(): {
		isValid: boolean;
		expiresAt?: string;
		refreshCount?: number;
	} {
		const health = tokenManager.getTokenHealth();
		return health[this.getServiceName()] || { isValid: false };
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const params = { url: article.url, title: article.title };
		const data = await this._makeSignedRequest("/api/1/bookmarks/add", params);
		const validatedData = v.parse(instapaperSaveResponseSchema, data);

		const savedBookmark = validatedData.find(
			(item): item is InstapaperBookmark => item.type === "bookmark",
		);

		const error = validatedData.find(
			(item): item is InstapaperError => item.type === "error",
		);

		if (error) {
			throw new Error(
				`Failed to save article: ${error.message} (Error ${error.error_code})`,
			);
		}

		if (!savedBookmark) {
			throw new Error(
				"Failed to save article to Instapaper: No bookmark returned",
			);
		}

		return this.mapArticle(savedBookmark);
	}
	async deleteArticle(id: number): Promise<void> {
		await this._makeSignedRequest("/api/1/bookmarks/delete", {
			bookmark_id: id,
		});
	}
	async sync(): Promise<Article[]> {
		const limit = 500;
		const allArticles: Article[] = [];
		let receivedBookmarks: InstapaperBookmark[] = [];
		do {
			const have = allArticles.map((a) => a.id).join(",");
			const params: { limit: number; have?: string } = { limit };
			if (have) {
				params.have = have;
			}
			const data = await this._makeSignedRequest(
				"/api/1/bookmarks/list",
				params,
			);
			const validatedData = v.parse(instapaperSyncResponseSchema, data);

			if (validatedData.bookmarks) {
				receivedBookmarks = validatedData.bookmarks;
				const articles = receivedBookmarks.map((item) => this.mapArticle(item));
				allArticles.push(...articles);
			} else {
				receivedBookmarks = [];
			}
			if (receivedBookmarks.length === limit) {
				await new Promise((resolve) =>
					setTimeout(resolve, this.RATE_LIMIT_DELAY),
				);
			}
		} while (receivedBookmarks.length === limit);
		return allArticles;
	}
	private mapArticle(item: InstapaperBookmark): Article {
		return {
			id: item.bookmark_id,
			title: item.title,
			url: item.url,
			created_at: item.time
				? new Date(item.time * 1000).toISOString()
				: new Date().toISOString(),
		};
	}
	private async _makeSignedRequest(
		endpoint: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		if (!this.config || !this.accessToken || !this.accessTokenSecret) {
			throw new Error("Instapaper adapter not initialized");
		}
		const oauthParams: Record<string, string> = {
			oauth_consumer_key: this.config.consumerKey,
			oauth_nonce: Math.random().toString(36).substring(2),
			oauth_signature_method: "HMAC-SHA1",
			oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
			oauth_token: this.accessToken,
			oauth_version: "1.0",
		};
		const allParams = { ...params, ...oauthParams };
		const paramString = Object.keys(allParams)
			.sort()
			.map(
				(key) =>
					`${encodeURIComponent(key)}=${encodeURIComponent(
						String(allParams[key]),
					)}`,
			)
			.join("&");
		const method = "POST";
		const baseUrl = `${this.apiUrl}${endpoint}`;
		const signatureBaseString = `${method}&${encodeURIComponent(
			baseUrl,
		)}&${encodeURIComponent(paramString)}`;
		const signingKey = `${encodeURIComponent(
			this.config.consumerSecret,
		)}&${encodeURIComponent(this.accessTokenSecret)}`;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(signingKey),
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(signatureBaseString),
		);
		oauthParams.oauth_signature = btoa(
			String.fromCharCode(...new Uint8Array(signature)),
		);
		const authHeader = `OAuth ${Object.keys(oauthParams)
			.sort()
			.map(
				(key) =>
					`${encodeURIComponent(key)}="${encodeURIComponent(
						oauthParams[key],
					)}"`,
			)
			.join(", ")}`;
		const response = await fetch(baseUrl, {
			method,
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params as Record<string, string>),
		});
		if (!response.ok) {
			throw new Error(
				`Instapaper API Error: ${response.status} ${await response.text()}`,
			);
		}
		return response.json();
	}
}
