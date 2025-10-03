import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type {
	ReadItLaterAPI,
	SavingArticle,
	SyncOptions,
	SyncResult,
} from "../read-it-later-adapter";

export const bookmarksSettingsSchema = v.merge([
	baseSettingsSchema,
	v.object({
		backend: v.literal("bookmarks"),
		apiConfig: v.object({}),
	}),
]);

export type BookmarksSettings = v.Input<typeof bookmarksSettingsSchema>;

interface FirefoxBookmarkTreeNode {
	id: string;
	parentId?: string;
	index?: number;
	url?: string;
	title: string;
	dateAdded?: number;
	dateGroupModified?: number;
	children?: FirefoxBookmarkTreeNode[];
}

export class BookmarksAdapter implements ReadItLaterAPI<BookmarksSettings> {
	public readonly displayName = "Browser Bookmarks";
	formConfig = [];
	private pouchFolderId: string | null = null;
	private readonly POUCH_FOLDER_NAME = "Pouch";

	async initialize(): Promise<void> {
		await this.ensurePouchFolder();
	}

	async testConnection(): Promise<boolean> {
		try {
			await this.ensurePouchFolder();
			return true;
		} catch (error) {
			console.error("Bookmarks connection test failed:", error);
			return false;
		}
	}

	private async ensurePouchFolder(): Promise<string> {
		if (this.pouchFolderId) {
			return this.pouchFolderId;
		}

		const existingFolder = await this.findPouchFolder();
		if (existingFolder) {
			this.pouchFolderId = existingFolder.id;
			return this.pouchFolderId;
		}

		const folder = await browser.bookmarks.create({
			title: this.POUCH_FOLDER_NAME,
			parentId: "unfiled_____", // Other bookmarks folder in Firefox
		});

		this.pouchFolderId = folder.id;
		return folder.id;
	}

	private async findPouchFolder(): Promise<FirefoxBookmarkTreeNode | null> {
		const tree = await browser.bookmarks.getTree();

		const findFolder = (
			nodes: FirefoxBookmarkTreeNode[],
		): FirefoxBookmarkTreeNode | null => {
			for (const node of nodes) {
				if (node.title === this.POUCH_FOLDER_NAME && !node.url) {
					return node;
				}
				if (node.children) {
					const found = findFolder(node.children);
					if (found) return found;
				}
			}
			return null;
		};

		return findFolder(tree);
	}

	async saveArticle(article: SavingArticle): Promise<Article> {
		const folderId = await this.ensurePouchFolder();

		const bookmark = await browser.bookmarks.create({
			parentId: folderId,
			title: article.title,
			url: article.url,
		});

		const savedArticle: Article = {
			id: parseInt(bookmark.id, 10),
			title: bookmark.title,
			url: bookmark.url || "",
			created_at: new Date(bookmark.dateAdded || Date.now()).toISOString(),
		};

		return savedArticle;
	}

	async deleteArticle(id: number): Promise<void> {
		await browser.bookmarks.remove(id.toString());
	}

	async sync(options?: SyncOptions): Promise<SyncResult> {
		const folderId = await this.ensurePouchFolder();

		const children = await browser.bookmarks.getChildren(folderId);

		const articles: Article[] = children
			.filter((bookmark) => bookmark.url) // Only include bookmarks with URLs
			.map((bookmark) => ({
				id: parseInt(bookmark.id, 10),
				title: bookmark.title,
				url: bookmark.url || "",
				created_at: new Date(bookmark.dateAdded || Date.now()).toISOString(),
			}));

		const mode = options?.mode || "overwrite";

		return {
			articles,
			mode,
			metadata: {
				totalFetched: articles.length,
				totalProcessed: articles.length,
				lastSyncTimestamp: new Date().toISOString(),
				apiVersion: "1.0",
			},
		};
	}
}
