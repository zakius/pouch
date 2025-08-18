import type { Article } from "../types/common";
import { getAdatper } from "../utils/adapter-factory";
import { logger } from "../utils/logger";
import type { Settings } from "../utils/settings";
import { canonicalizeUrl } from "../utils/url-helpers";
import type { ReadItLaterAPI } from "./api/read-it-later-adapter";
export class ArticlesRepository {
	private api: ReadItLaterAPI | null = null;
	private settings!: Settings;
	async initialize(settings: Settings): Promise<void> {
		logger.info("Initializing ArticlesRepository with settings:", settings);
		this.settings = settings;
		this.api = null;
	}
	private async getApi(): Promise<ReadItLaterAPI> {
		if (this.api) {
			return this.api;
		}
		logger.debug("API not initialized, creating adapter now...");
		const api = getAdatper(this.settings.backend);
		logger.debug("Initializing API with config:", this.settings.apiConfig);
		await api.initialize(this.settings);
		logger.info("On-demand API initialization completed");
		this.api = api;
		return this.api;
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
		const urlToCompare = this.settings.normalizeOnCompare
			? canonicalizeUrl(url)
			: url;
		const existingArticle = articles.find(
			(article) => article.url === urlToCompare,
		);
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
		const urlToSave = this.settings.normalizeOnSave
			? canonicalizeUrl(article.url)
			: article.url;
		try {
			const savedArticle = await api.saveArticle({
				url: urlToSave,
				title: article.title,
			});
			logger.debug("Saved article, now adding to cache", savedArticle);
			await this.addArticle(savedArticle);
			return savedArticle;
		} catch (error) {
			logger.error("Error saving article through cache:", error);
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
	async syncWithAPI(): Promise<{ items: Article[]; total: number }> {
		const api = await this.getApi();
		logger.info("Starting cache sync with API");
		try {
			const allArticles = await api.sync();
			logger.debug(`Synced ${allArticles.length} articles from API`);
			const processedArticles = this.settings.normalizeOnSave
				? allArticles.map((article) => ({
						...article,
						url: canonicalizeUrl(article.url),
					}))
				: allArticles;
			await this.updateArticles(processedArticles);
			return {
				items: processedArticles,
				total: processedArticles.length,
			};
		} catch (error) {
			logger.error("Error syncing cache with API:", error);
			throw error;
		}
	}
	private async addArticle(article: Article): Promise<void> {
		logger.debug("Adding article to cache:", article);
		const articles = await this.getAllArticles();
		articles.push(article);
		logger.debug("Articles:", articles);
		await browser.storage.local.set({ articles: articles });
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
	async clear(): Promise<void> {
		await browser.storage.local.remove("articles");
	}
}
