import { z } from "zod";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type { ReadItLaterAPI, SavingArticle } from "../read-it-later-adapter";

export const linkaceConfigSchema = z.object({
	url: z.string().url(),
	token: z.string(),
});

export const linkaceSettingsSchema = baseSettingsSchema.extend({
	backend: z.literal("linkace"),
	apiConfig: linkaceConfigSchema,
});

export type LinkaceSettings = z.infer<typeof linkaceSettingsSchema>;
export type LinkaceConfig = z.infer<typeof linkaceConfigSchema>;

// Zod schemas for API responses based on LinkAce API documentation
const linkaceTagSchema = z.object({
	id: z.number(),
	name: z.string(),
});

const linkaceListSchema = z.object({
	id: z.number(),
	name: z.string(),
});

const linkaceLinkSchema = z.object({
	id: z.number(),
	url: z.string(),
	title: z.string(),
	description: z.string().optional(),
	created_at: z.string(),
	updated_at: z.string().optional(),
	// Additional fields that may be present
	lists: z.array(linkaceListSchema).optional(),
	tags: z.array(linkaceTagSchema).optional(),
	visibility: z.number().optional(),
	check_disabled: z.boolean().optional(),
	status: z.number().optional(),
	icon: z.string().optional(),
	thumbnail: z.string().optional(),
});

// Error response schemas
const linkaceErrorSchema = z.object({
	message: z.string(),
	errors: z.record(z.string(), z.array(z.string())).optional(),
});

const linkaceSaveResponseSchema = z.union([
	z.object({
		data: linkaceLinkSchema,
	}),
	linkaceErrorSchema,
]);

const linkaceSyncResponseSchema = z.union([
	z.object({
		data: z.array(linkaceLinkSchema),
		links: z.object({
			first: z.string().optional(),
			last: z.string().optional(),
			prev: z.string().optional(),
			next: z.string().optional(),
		}).optional(),
		meta: z.object({
			current_page: z.number(),
			from: z.number().optional(),
			last_page: z.number(),
			per_page: z.number(),
			to: z.number().optional(),
			total: z.number(),
		}).optional(),
	}),
	linkaceErrorSchema,
]);

interface LinkaceLink {
	id: number;
	url: string;
	title: string;
	description?: string;
	created_at: string;
	updated_at?: string;
	lists?: { id: number; name: string }[];
	tags?: { id: number; name: string }[];
	visibility?: number;
	check_disabled?: boolean;
	status?: number;
	icon?: string;
	thumbnail?: string;
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
		const validatedData = linkaceSaveResponseSchema.parse(data);

		// Check if it's an error response
		if ("message" in validatedData) {
			throw new Error(
				`Failed to save article: ${validatedData.message}`,
			);
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
			const validatedData = linkaceSyncResponseSchema.parse(data);

			// Check if it's an error response
			if ("message" in validatedData) {
				throw new Error(
					`Failed to sync articles: ${validatedData.message}`,
				);
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
