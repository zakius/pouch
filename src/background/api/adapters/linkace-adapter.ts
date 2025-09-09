import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const linkaceConfigSchema = v.object({
	url: v.string([v.url()]),
	token: v.string(),
});

export const linkaceSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("linkace"),
		apiConfig: linkaceConfigSchema,
	}),
]);

export type LinkaceSettings = v.Input<typeof linkaceSettingsSchema>;
export type LinkaceConfig = v.Input<typeof linkaceConfigSchema>;

// Valibot schemas for API responses based on LinkAce API documentation
const linkaceTagSchema = v.object({
	id: v.number(),
	name: v.string(),
});

const linkaceListSchema = v.object({
	id: v.number(),
	name: v.string(),
});

const linkaceLinkSchema = v.object({
	id: v.number(),
	url: v.string(),
	title: v.string(),
	description: v.optional(v.nullable(v.string())),
	created_at: v.string(),
	updated_at: v.optional(v.nullable(v.string())),
	// Additional fields that may be present
	lists: v.optional(v.array(linkaceListSchema)),
	tags: v.optional(v.array(linkaceTagSchema)),
	visibility: v.optional(v.number()),
	check_disabled: v.optional(v.union([v.boolean(), v.number()])),
	status: v.optional(v.number()),
	icon: v.optional(v.nullable(v.string())),
	thumbnail: v.optional(v.nullable(v.string())),
});

// Error response schemas
const linkaceErrorSchema = v.object({
	message: v.string(),
	errors: v.optional(v.record(v.string(), v.array(v.string()))),
});

const linkaceSaveResponseSchema = v.union([
	v.object({
		data: linkaceLinkSchema,
	}),
	linkaceErrorSchema,
]);

const linkaceSyncResponseSchema = v.union([
	v.object({
		data: v.array(linkaceLinkSchema),
		links: v.optional(
			v.object({
				first: v.optional(v.string()),
				last: v.optional(v.string()),
				prev: v.optional(v.string()),
				next: v.optional(v.string()),
			}),
		),
		meta: v.optional(
			v.object({
				current_page: v.number(),
				from: v.optional(v.number()),
				last_page: v.number(),
				per_page: v.number(),
				to: v.optional(v.number()),
				total: v.number(),
			}),
		),
	}),
	linkaceErrorSchema,
]);

interface LinkaceLink {
	id: number;
	url: string;
	title: string;
	description?: string | null;
	created_at: string;
	updated_at?: string | null;
	lists?: { id: number; name: string }[];
	tags?: { id: number; name: string }[];
	visibility?: number;
	check_disabled?: boolean | number;
	status?: number;
	icon?: string | null;
	thumbnail?: string | null;
}

export class LinkaceAdapter implements ReadItLaterAPI<LinkaceSettings> {
	public readonly displayName = "LinkAce";
	private apiUrl: string = "";
	private token: string = "";
	private readonly RATE_LIMIT_DELAY: number = 1000;

	formConfig = [
		{ name: "url", label: "API URL" },
		{ name: "token", label: "API Token" },
	];

	async initialize(settings: LinkaceSettings): Promise<void> {
		this.apiUrl = settings.apiConfig.url;
		this.token = settings.apiConfig.token;
	}

	async testConnection(): Promise<boolean> {
		try {
			const response = await fetch(`${this.apiUrl}/api/v2/links?per_page=1`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
				},
			});
			return response.ok;
		} catch (error) {
			console.error("LinkAce connection test failed:", error);
			return false;
		}
	}

	async saveArticle(article: SavingArticle): Promise<Article> {
		const response = await fetch(`${this.apiUrl}/api/v2/links`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
			},
			body: JSON.stringify({
				url: article.url,
				title: article.title,
				visibility: 1, // Private by default
				check_disabled: false,
			}),
		});

		if (!response.ok) {
			throw new Error(`Failed to save article: ${response.statusText}`);
		}

		const data = await response.json();
		const validatedData = v.parse(linkaceSaveResponseSchema, data);

		// Check if it's an error response
		if ("message" in validatedData) {
			throw new Error(`Failed to save article: ${validatedData.message}`);
		}

		return this.mapArticle(validatedData.data);
	}

	async deleteArticle(id: number): Promise<void> {
		const response = await fetch(`${this.apiUrl}/api/v2/links/${id}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to delete article: ${response.statusText}`);
		}
	}

	async sync(): Promise<Article[]> {
		const perPage = 30;
		const allArticles: Article[] = [];
		let currentPage = 1;
		let hasMorePages = true;

		while (hasMorePages) {
			// Add rate limiting delay for subsequent requests
			if (currentPage > 1) {
				await new Promise((resolve) =>
					setTimeout(resolve, this.RATE_LIMIT_DELAY),
				);
			}

			const response = await fetch(
				`${this.apiUrl}/api/v2/links?page=${currentPage}&per_page=${perPage}`,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${this.token}`,
						Accept: "application/json",
					},
				},
			);

			if (!response.ok) {
				throw new Error(`Failed to sync articles: ${response.statusText}`);
			}

			const data = await response.json();
			const validatedData = v.parse(linkaceSyncResponseSchema, data);

			// Check if it's an error response
			if ("message" in validatedData) {
				throw new Error(`Failed to sync articles: ${validatedData.message}`);
			}

			allArticles.push(
				...validatedData.data.map((item) => this.mapArticle(item)),
			);

			// Check if there are more pages
			if (validatedData.meta) {
				hasMorePages = currentPage < validatedData.meta.last_page;
			} else {
				// If no meta information, assume no more pages if we got less than perPage items
				hasMorePages = validatedData.data.length === perPage;
			}

			currentPage++;
		}

		return allArticles;
	}

	private mapArticle(item: LinkaceLink): Article {
		return {
			id: item.id,
			title: item.title,
			url: item.url,
			created_at: item.created_at,
		};
	}
}
