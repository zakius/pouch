import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const wallabagConfigSchema = z.object({
	url: z.string().url(),
	clientId: z.string(),
	clientSecret: z.string(),
	username: z.string(),
	password: z.string().optional(),
});

export const wallabagSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("wallabag"),
	apiConfig: wallabagConfigSchema,
});

export type WallabagSettings = z.infer<typeof wallabagSettingsSchema>;
export type WallabagConfig = z.infer<typeof wallabagConfigSchema>;

// Zod schemas for API responses based on official documentation
const wallabagTagSchema = z.object({
	id: z.number(),
	name: z.string(),
});

const wallabagItemSchema = z.object({
	id: z.number(),
	title: z.string(),
	url: z.string(),
	created_at: z.string(),
	tags: z.array(wallabagTagSchema).optional(),
	// Additional fields that may be present
	content: z.string().optional(),
	excerpt: z.string().optional(),
	domain_name: z.string().optional(),
	is_archived: z.boolean().optional(),
	is_starred: z.boolean().optional(),
	language: z.string().optional(),
	reading_time: z.number().optional(),
	preview_picture: z.string().optional(),
	user_name: z.string().optional(),
	user_email: z.string().optional(),
	user_id: z.number().optional(),
});

const wallabagTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string().optional(),
	expires_in: z.number().optional(),
	refresh_token: z.string().optional(),
});

const wallabagErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().optional(),
	message: z.string().optional(),
});

const wallabagSaveResponseSchema = z.union([
	wallabagItemSchema,
	wallabagErrorSchema,
]);

const wallabagSyncResponseSchema = z.union([
	z.object({
		_embedded: z.object({
			items: z.array(wallabagItemSchema),
		}),
		_links: z
			.object({
				first: z.object({ href: z.string() }).optional(),
				last: z.object({ href: z.string() }).optional(),
				self: z.object({ href: z.string() }).optional(),
			})
			.optional(),
		limit: z.number(),
		page: z.number(),
		pages: z.number(),
		total: z.number(),
	}),
	wallabagErrorSchema,
]);

interface WallabagItem {
	id: number;
	title: string;
	url: string;
	created_at: string;
	tags?: { id: number; name: string }[];
	content?: string;
	excerpt?: string;
	domain_name?: string;
	is_archived?: boolean;
	is_starred?: boolean;
	language?: string;
	reading_time?: number;
	preview_picture?: string;
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
		const validatedTokenData = wallabagTokenResponseSchema.parse(tokenData);
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
		const validatedData = wallabagSaveResponseSchema.parse(data);

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
		const validatedFirstData = wallabagSyncResponseSchema.parse(firstData);

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
			const validatedData = wallabagSyncResponseSchema.parse(data);

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
