import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const karakeepConfigSchema = v.object({
	url: v.string([v.url()]),
	token: v.string(),
});

export const karakeepSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("karakeep"),
		apiConfig: karakeepConfigSchema,
	}),
]);

export type KarakeepSettings = v.Input<typeof karakeepSettingsSchema>;
export type KarakeepConfig = v.Input<typeof karakeepConfigSchema>;

// Valibot schemas for API responses based on official documentation
const karakeepItemSchema = v.object({
	id: v.number(),
	title: v.string(),
	url: v.string(),
	createdAt: v.string(),
	cover: v.optional(v.nullable(v.string())),
	// Additional fields that may be present based on API docs
	description: v.optional(v.nullable(v.string())),
	summary: v.optional(v.nullable(v.string())),
	content: v.optional(v.nullable(v.string())),
	status: v.optional(v.nullable(v.string())),
	tags: v.optional(
		v.array(
			v.object({
				id: v.number(),
				name: v.string(),
			}),
		),
	),
	highlights: v.optional(v.array(v.unknown())),
	assets: v.optional(v.array(v.unknown())),
});

// Error response schemas
const karakeepErrorSchema = v.object({
	error: v.string(),
	message: v.optional(v.string()),
	status: v.optional(v.number()),
});

const karakeepSaveResponseSchema = v.union([
	karakeepItemSchema,
	karakeepErrorSchema,
]);

const karakeepSyncResponseSchema = v.union([
	v.array(karakeepItemSchema),
	karakeepErrorSchema,
]);

interface KarakeepItem {
	id: number;
	title: string;
	url: string;
	createdAt: string;
	cover?: string | null;
	description?: string | null;
	summary?: string | null;
	content?: string | null;
	status?: string | null;
	tags?: { id: number; name: string }[];
	highlights?: unknown[];
	assets?: unknown[];
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
		const data = await response.json();
		const validatedData = v.parse(karakeepSaveResponseSchema, data);

		// Check if it's an error response
		if ("error" in validatedData) {
			throw new Error(
				`Failed to save article: ${validatedData.message || validatedData.error}`,
			);
		}

		return this.mapArticle(validatedData);
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
		const data = await response.json();
		const validatedData = v.parse(karakeepSyncResponseSchema, data);

		// Check if it's an error response
		if ("error" in validatedData) {
			throw new Error(
				`Failed to sync articles: ${validatedData.message || validatedData.error}`,
			);
		}

		return validatedData.map(this.mapArticle);
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
