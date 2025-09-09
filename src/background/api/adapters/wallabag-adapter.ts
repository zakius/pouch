import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

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

export class WallabagAdapter implements ReadItLaterAPI<WallabagSettings> {
	public readonly displayName = "Wallabag";
	private apiUrl: string = "";
	private accessToken: string = "";
	private config!: WallabagConfig;
	private readonly RATE_LIMIT_DELAY: number = 1000;
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "clientId", label: "Client ID" },
		{ name: "clientSecret", label: "Client Secret" },
		{ name: "username", label: "Username" },
		{ name: "password", label: "Password" },
	];
	async initialize(settings: WallabagSettings): Promise<void> {
		this.config = settings.apiConfig;
		this.apiUrl = this.config.url;
		const response = await fetch(`${this.apiUrl}/oauth/v2/token`, {
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
			throw new Error("Failed to authenticate with Wallabag API");
		}
		const tokenData = await response.json();
		const validatedTokenData = v.parse(wallabagTokenResponseSchema, tokenData);
		this.accessToken = validatedTokenData.access_token;
	}
	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(
				`${this.apiUrl}/api/entries.json?page=1&perPage=1`,
				{
					headers: {
						Authorization: `Bearer ${this.accessToken}`,
					},
				},
			);
			return response.ok;
		} catch (error) {
			console.error("Wallabag connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await fetch(`${this.apiUrl}/api/entries.json`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.accessToken}`,
			},
			body: JSON.stringify({
				url: article.url,
				title: article.title,
			}),
		});
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
		const response = await fetch(`${this.apiUrl}/api/entries/${id}.json`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}
	async sync(): Promise<Article[]> {
		const perPage = 30;
		const allArticles: Article[] = [];
		const firstResponse = await fetch(
			`${this.apiUrl}/api/entries.json?page=1&perPage=${perPage}&detail=metadata`,
			{
				headers: {
					Authorization: `Bearer ${this.accessToken}`,
				},
			},
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
			const response = await fetch(
				`${this.apiUrl}/api/entries.json?page=${page}&perPage=${perPage}&detail=metadata`,
				{
					headers: {
						Authorization: `Bearer ${this.accessToken}`,
					},
				},
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
