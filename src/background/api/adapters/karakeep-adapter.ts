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

// Zod schemas for API responses based on official documentation
const karakeepItemSchema = z.object({
	id: z.number(),
	title: z.string(),
	url: z.string(),
	createdAt: z.string(),
	cover: z.string().nullable().optional(),
	// Additional fields that may be present based on API docs
	description: z.string().nullable().optional(),
	summary: z.string().nullable().optional(),
	content: z.string().nullable().optional(),
	status: z.string().nullable().optional(),
	tags: z
		.array(
			z.object({
				id: z.number(),
				name: z.string(),
			}),
		)
		.optional(),
	highlights: z.array(z.unknown()).optional(),
	assets: z.array(z.unknown()).optional(),
});

// Error response schemas
const karakeepErrorSchema = z.object({
	error: z.string(),
	message: z.string().optional(),
	status: z.number().optional(),
});

const karakeepSaveResponseSchema = z.union([
	karakeepItemSchema,
	karakeepErrorSchema,
]);

const karakeepSyncResponseSchema = z.union([
	z.array(karakeepItemSchema),
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
		const validatedData = karakeepSaveResponseSchema.parse(data);

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
		const validatedData = karakeepSyncResponseSchema.parse(data);

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
