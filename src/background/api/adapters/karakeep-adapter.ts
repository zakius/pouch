import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
export const karakeepConfigSchema = z.object({
	url: z.string().url(),
	token: z.string(),
});
export const karakeepSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("karakeep"),
	apiConfig: karakeepConfigSchema,
});
export type KarakeepSettings = z.infer<typeof karakeepSettingsSchema>;
export type KarakeepConfig = z.infer<typeof karakeepConfigSchema>;
interface KarakeepItem {
	id: number;
	title: string;
	url: string;
	createdAt: string;
	cover?: string;
}
export class KarakeepAdapter implements ReadItLaterAPI<KarakeepSettings> {
	public readonly displayName = "Karakeep";
	private apiUrl: string = "";
	private token: string = "";
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];
	async initialize(settings: KarakeepSettings): Promise<void> {
		this.apiUrl = settings.apiConfig.url;
		this.token = settings.apiConfig.token;
	}
	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${this.apiUrl}/bookmarks`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
				},
			});
			return response.ok;
		} catch (error) {
			console.error("Karakeep connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await fetch(`${this.apiUrl}/bookmarks`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({
				url: article.url,
				title: article.title,
			}),
		});
		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}
		const data = (await response.json()) as KarakeepItem;
		return this.mapArticle(data);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await fetch(`${this.apiUrl}/bookmarks/${id}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.token}`,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}
	async sync(): Promise<Article[]> {
		const response = await fetch(`${this.apiUrl}/bookmarks`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to sync articles: ${response.statusText}`);
		}
		const data = (await response.json()) as KarakeepItem[];
		return data.map(this.mapArticle);
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
