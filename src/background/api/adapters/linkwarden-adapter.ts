import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";
export const linkwardenConfigSchema = z.object({
	url: z.string().url(),
	token: z.string(),
});
export const linkwardenSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("linkwarden"),
	apiConfig: linkwardenConfigSchema,
});
export type LinkwardenSettings = z.infer<typeof linkwardenSettingsSchema>;
export type LinkwardenConfig = z.infer<typeof linkwardenConfigSchema>;
interface LinkwardenItem {
	id: number;
	name: string;
	url: string;
	createdAt: string;
	image?: string;
}
export class LinkwardenAdapter implements ReadItLaterAPI<LinkwardenSettings> {
	public readonly displayName = "Linkwarden";
	private apiUrl: string = "";
	private token: string = "";
	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];
	async initialize(settings: LinkwardenSettings): Promise<void> {
		this.apiUrl = settings.apiConfig.url;
		this.token = settings.apiConfig.token;
	}
	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${this.apiUrl}/api/v1/links`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
				},
			});
			return response.ok;
		} catch (error) {
			console.error("Linkwarden connection test failed:", error);
			return false;
		}
	}
	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await fetch(`${this.apiUrl}/api/v1/links`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({
				url: article.url,
				name: article.title,
			}),
		});
		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}
		const data = (await response.json()) as { response: LinkwardenItem };
		return this.mapArticle(data.response);
	}
	async deleteArticle(id: number): Promise<void> {
		const response = await fetch(`${this.apiUrl}/api/v1/links/${id}`, {
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
		const response = await fetch(`${this.apiUrl}/api/v1/links`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.token}`,
			},
		});
		if (!response.ok) {
			throw new Error(`Failed to sync articles: ${response.statusText}`);
		}
		const data = (await response.json()) as {
			response: { data: LinkwardenItem[] };
		};
		return data.response.data.map(this.mapArticle);
	}
	private mapArticle(item: LinkwardenItem): Article {
		return {
			id: item.id,
			title: item.name,
			url: item.url,
			created_at: item.createdAt,
		};
	}
}
