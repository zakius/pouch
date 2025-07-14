import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
export const shioriConfigSchema = z.object({
	url: z.string().url(),
	username: z.string(),
	password: z.string().optional(),
});
export const shioriSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("shiori"),
	apiConfig: shioriConfigSchema,
});
export type ShioriSettings = z.infer<typeof shioriSettingsSchema>;
export type ShioriConfig = z.infer<typeof shioriConfigSchema>;
interface ShioriItem {
	id: number;
	title: string;
	url: string;
	excerpt: string;
	imageURL: string;
	hasContent: boolean;
	hasArchive: boolean;
	createAt: string;
	updateAt: string;
}
export class ShioriAdapter implements ReadItLaterAPI<ShioriSettings> {
	public readonly displayName = "Shiori";
	private apiUrl: string = "";
	private sessionToken: string = "";
	private config!: ShioriConfig;
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "username", label: "Username" },
		{ name: "password", label: "Password" },
	];
	async initialize(settings: ShioriSettings): Promise<void> {
		this.config = settings.apiConfig;
		this.apiUrl = this.config.url;
		const response = await fetch(`${this.apiUrl}/api/v1/auth/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				username: this.config.username,
				password: this.config.password || "",
			}),
		});
		if (!response.ok) {
			throw new Error("Failed to authenticate with Shiori API");
		}
		const loginData = await response.json();
		this.sessionToken = loginData.session;
	}
	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${this.apiUrl}/api/bookmarks`, {
				method: "GET",
				headers: {
					"X-Session-Id": this.sessionToken,
				},
			});
			return response.ok;
		} catch (error) {
			console.error("Shiori connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await fetch(`${this.apiUrl}/api/bookmarks`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Session-Id": this.sessionToken,
			},
			body: JSON.stringify({
				url: article.url,
				title: article.title,
			}),
		});
		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}
		const data = (await response.json()) as ShioriItem;
		return this.mapArticle(data);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await fetch(`${this.apiUrl}/api/bookmarks/${id}`, {
			method: "DELETE",
			headers: {
				"X-Session-Id": this.sessionToken,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}
	async sync(): Promise<Article[]> {
		const response = await fetch(`${this.apiUrl}/api/bookmarks`, {
			method: "GET",
			headers: {
				"X-Session-Id": this.sessionToken,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to sync articles: ${response.statusText}`);
		}
		const data = (await response.json()) as { bookmarks: ShioriItem[] };
		return data.bookmarks.map(this.mapArticle);
	}
	private mapArticle(item: ShioriItem): Article {
		return {
			id: item.id,
			title: item.title,
			url: item.url,
			created_at: item.createAt,
		};
	}
}
