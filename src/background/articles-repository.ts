import type { Article } from "../types/common";
import { getAdapter } from "../utils/adapter-factory";
import { logger } from "../utils/logger";
import type { Settings } from "../utils/settings";
import { canonicalizeUrl } from "../utils/url-helpers";
import type {
	ReadItLaterAPI,
	SyncMode,
	SyncOptions,
	SyncResult,
} from "./api/read-it-later-adapter";
export class ArticlesRepository {
	private api: ReadItLaterAPI | null = null;
	private settings!: Settings;
	private lastFullSyncTimestamp: number | null = null;
	private lastSyncTimestamp: string | null = null;
	async initialize(settings: Settings): Promise<void> {
		logger.info("Initializing ArticlesRepository with settings:", settings);
		this.settings = settings;
		this.api = null;
		await this.loadSyncTimestamps();
	}
	private async getApi(): Promise<ReadItLaterAPI> {
		if (this.api) {
			return this.api;
		}
		logger.debug("API not initialized, creating adapter now...");
		const api = getAdapter(this.settings.backend);
		logger.debug("Initializing API with config:", this.settings.apiConfig);
		try {
			await api.initialize(this.settings);
			logger.info("On-demand API initialization completed");
			this.api = api;
			return this.api;
		} catch (error) {
			logger.error("Failed to initialize API:", error);
			throw new Error(
				`Failed to initialize ${this.settings.backend} API: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}
	async testConnection(): Promise<boolean> {
		const api = await this.getApi();
		return api.testConnection();
	}
	async getArticle(id: number): Promise<Article | undefined> {
		const articles = await this.getAllArticles();
		return articles.find((a) => a.id === id);
	}
	async getAllArticles(): Promise<Article[]> {
		const result = await browser.storage.local.get(["articles"]);
		logger.debug("result", result);
		return result?.articles || [];
	}
	async findSaved(url: string): Promise<Article | undefined> {
		const articles = await this.getAllArticles();

		const canonicalUrl = await canonicalizeUrl(url);

		const existingArticle = articles.find((article) => {
			const articleCanonicalUrl = article.canonicalUrl || article.url;
			return articleCanonicalUrl === canonicalUrl;
		});

		return existingArticle;
	}
	private filterBySearch(articles: Article[], search?: string): Article[] {
		if (!search) {
			return articles;
		}
		const searchTerm = search.toLowerCase().trim();
		const searchWords = searchTerm.split(/\s+/);
		return articles.filter((article) => {
			const title = article.title?.toLowerCase() || "";
			const url = article.url?.toLowerCase() || "";
			return searchWords.every(
				(word) => title.includes(word) || url.includes(word),
			);
		});
	}
	async getRecentArticles(
		page = 1,
		perPage = 30,
		search?: string,
	): Promise<{ items: Article[]; page: number; pages: number; total: number }> {
		const articles = this.filterBySearch(
			await this.getAllArticles(),
			search,
		).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
		const articlesNumber = articles.length;
		const start = (page - 1) * perPage;
		const end = start + perPage;
		return {
			items: articles.slice(start, end),
			page,
			pages: Math.ceil(articlesNumber / perPage),
			total: articlesNumber,
		};
	}
	async saveArticle(article: Pick<Article, "url" | "title">): Promise<Article> {
		const api = await this.getApi();
		logger.info("Saving article:", article);

		const canonicalUrl = await canonicalizeUrl(article.url);

		const urlToSave = this.settings.normalizeOnSave
			? canonicalUrl
			: article.url;

		try {
			const savedArticle = await api.saveArticle({
				url: urlToSave,
				title: article.title,
			});

			const articleWithCanonicalUrl = {
				...savedArticle,
				canonicalUrl: canonicalUrl,
			};

			logger.debug(
				"Saved article, now adding to cache",
				articleWithCanonicalUrl,
			);
			await this.addArticle(articleWithCanonicalUrl);


			return articleWithCanonicalUrl;
		} catch (error) {
			logger.error("Error saving article through cache:", error);

			if (error instanceof Error && error.message.includes("No token found")) {
				logger.warn(
					"Authentication error detected, attempting to re-initialize API...",
				);
				this.api = null; // Clear the cached API instance
				try {
					const newApi = await this.getApi();
					const retryArticle = await newApi.saveArticle({
						url: urlToSave,
						title: article.title,
					});

					const retryArticleWithCanonicalUrl = {
						...retryArticle,
						canonicalUrl: canonicalUrl,
					};

					await this.addArticle(retryArticleWithCanonicalUrl);


					logger.info("Successfully saved article after re-authentication");
					return retryArticleWithCanonicalUrl;
				} catch (retryError) {
					logger.error(
						"Failed to save article even after re-authentication:",
						retryError,
					);
					throw retryError;
				}
			}

			throw error;
		}
	}
	async deleteArticle(
		id: number,
	): Promise<{ success: boolean; id: string | number }> {
		const api = await this.getApi();
		logger.debug("Deleting article through cache:", id);
		if (!id) {
			logger.error("Cannot delete article: No ID provided");
			throw new Error("Article ID is required");
		}
		try {
			await this.removeArticle(id);
			await api.deleteArticle(id);
			logger.debug("Deleted article from API", id);
			return { success: true, id };
		} catch (error) {
			logger.error("Error deleting article through cache:", error);
			throw error;
		}
	}
	async syncWithAPI(
		options?: SyncOptions,
	): Promise<{ items: Article[]; total: number; syncResult: SyncResult }> {
		try {
			const api = await this.getApi();

			// Prepare sync options with history data
			const syncOptions: SyncOptions = {
				...options,
				lastSyncTimestamp: this.lastSyncTimestamp ?? undefined,
				lastFullSyncTimestamp: this.lastFullSyncTimestamp ?? undefined,
				isBrowserIdle: options?.isBrowserIdle ?? (await this.isBrowserIdle()),
			};

			logger.info("Starting cache sync with API", {
				providedMode: options?.mode,
				lastSync: this.lastSyncTimestamp,
				lastFullSync: this.lastFullSyncTimestamp
					? new Date(this.lastFullSyncTimestamp).toISOString()
					: null,
				isBrowserIdle: syncOptions.isBrowserIdle,
			});

			const syncResult = await api.sync(syncOptions);
			logger.debug(
				`Synced ${syncResult.articles.length} articles from API using ${syncResult.mode} mode`,
				{
					metadata: syncResult.metadata,
				},
			);

			const articlesWithCanonicalUrls = await Promise.all(
				syncResult.articles.map(async (article) => {
					const canonicalUrl = await canonicalizeUrl(article.url);
					return {
						...article,
						canonicalUrl: canonicalUrl,
					};
				}),
			);

			const processedArticles = this.settings.normalizeOnSave
				? articlesWithCanonicalUrls.map((article) => ({
						...article,
						url: article.canonicalUrl,
					}))
				: articlesWithCanonicalUrls;


			// Handle different sync modes
			if (syncResult.mode === "overwrite") {
				// Replace all articles with the new ones
				await this.updateArticles(processedArticles);
			} else if (syncResult.mode === "update") {
				// Merge new articles with existing ones
				await this.mergeArticles(processedArticles);
			}

			// Update sync timestamps
			await this.updateSyncTimestamp(syncResult.mode);

			return {
				items: processedArticles,
				total: processedArticles.length,
				syncResult,
			};
		} catch (error) {
			logger.error("Error syncing cache with API:", error);
			const currentArticles = await this.getAllArticles();
			return {
				items: currentArticles,
				total: currentArticles.length,
				syncResult: {
					articles: currentArticles,
					mode: "overwrite",
					metadata: {
						totalFetched: 0,
						totalProcessed: 0,
						lastSyncTimestamp: new Date().toISOString(),
					},
				},
			};
		}
	}
	private async addArticle(article: Article): Promise<void> {
		logger.debug("Adding article to cache:", article);
		
		// More efficient: add to beginning of array (newest first)
		const result = await browser.storage.local.get("articles");
		const existingArticles = result.articles || [];
		const updatedArticles = [article, ...existingArticles];
		
		await browser.storage.local.set({ articles: updatedArticles });
		logger.debug("Article added to cache:", article);
	}
	private async removeArticle(id: number): Promise<void> {
		logger.debug("Removing article from cache:", id);
		if (!id) {
			logger.error("Cannot remove article from cache: No ID provided");
			return;
		}
		const articles = await this.getAllArticles();
		const filteredArticles = articles.filter((a) => a.id !== id);
		await browser.storage.local.set({ articles: filteredArticles });
	}
	async updateArticles(newArticles: Article[]): Promise<void> {
		logger.debug("Updating articles in cache:", newArticles.length);
		await browser.storage.local.set({ articles: newArticles });
	}

	async mergeArticles(newArticles: Article[]): Promise<void> {
		logger.debug("Merging articles in cache:", newArticles.length);
		const existingArticles = await this.getAllArticles();
		const existingMap = new Map(
			existingArticles.map((article) => [article.id, article]),
		);

		// Add or update articles
		for (const newArticle of newArticles) {
			existingMap.set(newArticle.id, newArticle);
		}

		const mergedArticles = Array.from(existingMap.values());
		await browser.storage.local.set({ articles: mergedArticles });
		logger.debug("Merged articles count:", mergedArticles.length);
	}

	async clear(): Promise<void> {
		await browser.storage.local.remove("articles");
	}

	private async loadSyncTimestamps(): Promise<void> {
		try {
			const result = await browser.storage.local.get([
				"lastFullSyncTimestamp",
				"lastSyncTimestamp",
			]);
			this.lastFullSyncTimestamp = result.lastFullSyncTimestamp || null;
			this.lastSyncTimestamp = result.lastSyncTimestamp || null;
			logger.debug("Loaded sync timestamps:", {
				lastSync: this.lastSyncTimestamp,
				lastFullSync: this.lastFullSyncTimestamp
					? new Date(this.lastFullSyncTimestamp).toISOString()
					: null,
			});
		} catch (error) {
			logger.error("Failed to load sync timestamps:", error);
			this.lastFullSyncTimestamp = null;
			this.lastSyncTimestamp = null;
		}
	}

	private async saveSyncTimestamps(): Promise<void> {
		try {
			await browser.storage.local.set({
				lastFullSyncTimestamp: this.lastFullSyncTimestamp,
				lastSyncTimestamp: this.lastSyncTimestamp,
			});
		} catch (error) {
			logger.error("Failed to save sync timestamps:", error);
		}
	}

	private async isBrowserIdle(): Promise<boolean> {
		try {
			// Check if browser is idle using the idle API
			// Use 5 minutes (300 seconds) as a more conservative threshold
			// This ensures we only do full sync when the user is truly away
			const state = await browser.idle.queryState(300); // 5 minutes idle threshold
			logger.debug("Browser idle state:", { state, isIdle: state === "idle" });
			return state === "idle";
		} catch (error) {
			logger.debug("Could not check browser idle state:", error);
			// If idle API is not available, assume not idle
			return false;
		}
	}

	private async updateSyncTimestamp(mode: SyncMode): Promise<void> {
		const now = new Date().toISOString();

		// Always update lastSyncTimestamp for any sync
		const oldLastSync = this.lastSyncTimestamp;
		this.lastSyncTimestamp = now;

		// Update lastFullSyncTimestamp only for overwrite syncs
		if (mode === "overwrite") {
			const oldFullSync = this.lastFullSyncTimestamp;
			this.lastFullSyncTimestamp = Date.now();
			await this.saveSyncTimestamps();
			logger.debug("Updated sync timestamps:", {
				oldLastSync,
				newLastSync: this.lastSyncTimestamp,
				oldFullSync: oldFullSync ? new Date(oldFullSync).toISOString() : null,
				newFullSync: new Date(this.lastFullSyncTimestamp).toISOString(),
				mode,
			});
		} else {
			// For update syncs, just save the lastSyncTimestamp
			await this.saveSyncTimestamps();
			logger.debug("Updated sync timestamp:", {
				oldLastSync,
				newLastSync: this.lastSyncTimestamp,
				mode,
			});
		}
	}
}
