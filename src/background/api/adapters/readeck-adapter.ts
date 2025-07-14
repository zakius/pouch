import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const readeckConfigSchema = z.object({
	url: z.string().url(),
	apiToken: z.string(),
});

export const readeckSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("readeck"),
	apiConfig: readeckConfigSchema,
});

export type ReadeckSettings = z.infer<typeof readeckSettingsSchema>;
export type ReadeckConfig = z.infer<typeof readeckConfigSchema>;

// Based on OpenAPI specification structure found in the Readeck repository.
// The exact fields are inferred.
interface ReadeckItem {
	id: number;
	title: string;
	url: string;
	created_at: string;
	// Readeck may have more fields, but these are the essentials.
}

export class ReadeckAdapter implements ReadItLaterAPI<ReadeckSettings> {
	public readonly displayName = "Readeck";
	private apiUrl: string = "";
	private apiToken: string = "";
	private config!: ReadeckConfig;

	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "apiToken", label: "API Token" },
	];

	async initialize(settings: ReadeckSettings): Promise<void> {
		this.config = settings.apiConfig;
		this.apiUrl = this.config.url.endsWith("/")
			? this.config.url.slice(0, -1)
			: this.config.url;
		this.apiToken = this.config.apiToken;
	}

	async testConnection(): Promise<boolean> {
		try {
			const response = await this.makeApiRequest("profile");
			return response.ok;
		} catch (error) {
			console.error("Readeck connection test failed:", error);
			return false;
		}
	}

	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await this.makeApiRequest("bookmarks", "POST", {
			url: article.url,
		});
		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}
		const data = (await response.json()) as ReadeckItem;
		return this.mapArticle(data);
	}

	async deleteArticle(id: number): Promise<void> {
		const response = await this.makeApiRequest(`bookmarks/${id}`, "DELETE");
		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}

	async sync(): Promise<Article[]> {
		const response = await this.makeApiRequest("bookmarks");
		if (!response.ok) {
			throw new Error(`Failed to sync articles: ${response.statusText}`);
		}
		// The response for a list is likely an object with a data/items key
		const data = await response.json();
		// Assuming the bookmarks are in a top-level array in the response
		if (Array.isArray(data)) {
			return data.map(this.mapArticle);
		}
		// Fallback for responses like { "items": [...] } or { "bookmarks": [...] }
		const bookmarks = data.items || data.bookmarks || [];
		return bookmarks.map(this.mapArticle);
	}

	private mapArticle(item: ReadeckItem): Article {
		return {
			id: item.id,
			title: item.title,
			url: item.url,
			created_at: item.created_at,
		};
	}

	private async makeApiRequest(
		endpoint: string,
		method: "GET" | "POST" | "DELETE" = "GET",
		body?: Record<string, unknown>,
	): Promise<Response> {
		const url = `${this.apiUrl}/${endpoint}`;
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiToken}`,
		};
		return fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});
	}
}
