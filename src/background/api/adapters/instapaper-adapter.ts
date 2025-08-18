import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const instapaperConfigSchema = z.object({
	consumerKey: z.string(),
	consumerSecret: z.string(),
	username: z.string(),
	password: z.string().optional(),
});

export const instapaperSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("instapaper"),
	apiConfig: instapaperConfigSchema,
});

export type InstapaperSettings = z.infer<typeof instapaperSettingsSchema>;
export type InstapaperConfig = z.infer<typeof instapaperConfigSchema>;

// Zod schemas for API responses based on official documentation
const instapaperTagSchema = z.object({
	id: z.number(),
	name: z.string(),
});

const instapaperBookmarkSchema = z.object({
	type: z.literal("bookmark"),
	bookmark_id: z.number(),
	url: z.string(),
	title: z.string(),
	description: z.string().optional(),
	tags: z.array(instapaperTagSchema).optional(),
	time: z.number().optional(),
	image_url: z.string().optional(),
	// Additional fields that may be present
	progress: z.number().optional(),
	progress_timestamp: z.number().optional(),
	private_source: z.string().optional(),
});

const instapaperUserSchema = z.object({
	type: z.literal("user"),
	user_id: z.number(),
	username: z.string(),
});

const instapaperErrorSchema = z.object({
	type: z.literal("error"),
	error_code: z.number(),
	message: z.string(),
});

const instapaperMetaSchema = z
	.object({
		type: z.literal("meta"),
	})
	.passthrough();

// Union type for all possible API response items
const instapaperResponseItemSchema = z.union([
	instapaperBookmarkSchema,
	instapaperUserSchema,
	instapaperErrorSchema,
	instapaperMetaSchema,
]);

// Save response is an array of items
const instapaperSaveResponseSchema = z.array(instapaperResponseItemSchema);

// Sync response has a specific structure
const instapaperSyncResponseSchema = z.object({
	user: instapaperUserSchema,
	bookmarks: z.array(instapaperBookmarkSchema),
	highlights: z.array(z.unknown()).optional(), // We don't use highlights
	delete_ids: z.array(z.number()).optional(),
});

interface InstapaperBookmark {
	type: "bookmark";
	bookmark_id: number;
	url: string;
	title: string;
	description?: string;
	tags?: { id: number; name: string }[];
	time?: number;
	image_url?: string;
	progress?: number;
	progress_timestamp?: number;
	private_source?: string;
}

interface InstapaperError {
	type: "error";
	error_code: number;
	message: string;
}

export class InstapaperAdapter implements ReadItLaterAPI<InstapaperSettings> {
	public readonly displayName = "Instapaper";
	private apiUrl = "https://www.instapaper.com";
	private config!: InstapaperConfig;
	private accessToken: string | null = null;
	private accessTokenSecret: string | null = null;
	private readonly RATE_LIMIT_DELAY: number = 1000;
	formConfig = [
		{ name: "consumerKey", label: "OAuth Consumer Key" },
		{ name: "consumerSecret", label: "OAuth Consumer Secret" },
		{ name: "username", label: "Instapaper Username" },
		{ name: "password", label: "Instapaper Password" },
	];
	async initialize(settings: InstapaperSettings): Promise<void> {
		this.config = settings.apiConfig;
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
	async saveArticle(article: SavingArticle): Promise<Article> {
		const params = { url: article.url, title: article.title };
		const data = await this._makeSignedRequest("/api/1/bookmarks/add", params);
		const validatedData = instapaperSaveResponseSchema.parse(data);

		// Find the bookmark in the response
		const savedBookmark = validatedData.find(
			(item): item is InstapaperBookmark => item.type === "bookmark",
		);

		// Check for errors
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
			const validatedData = instapaperSyncResponseSchema.parse(data);

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
