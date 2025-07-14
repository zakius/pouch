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
interface WallabagItem {
	id: number;
	title: string;
	url: string;
	created_at: string;
	tags?: { id: number; name: string }[];
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
		this.accessToken = tokenData.access_token;
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
		const data = (await response.json()) as WallabagItem;
		return this.mapArticle(data);
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
		const firstData = (await firstResponse.json()) as {
			_embedded: { items: WallabagItem[] };
			total: number;
		};
		allArticles.push(
			...firstData._embedded.items.map((item) => this.mapArticle(item)),
		);
		const total = firstData.total;
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
			const data = (await response.json()) as {
				_embedded: { items: WallabagItem[] };
			};
			allArticles.push(
				...data._embedded.items.map((item) => this.mapArticle(item)),
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
