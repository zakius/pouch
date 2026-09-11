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

type PendingOperation = {
  type: "save" | "delete";
  article?: Pick<Article, "url" | "title">;
  articleId?: number;
  timestamp: number;
};

export class ArticlesRepository {
  private api: ReadItLaterAPI | null = null;
  private settings!: Settings;
  private lastFullSyncTimestamp: number | null = null;
  private lastSyncTimestamp: string | null = null;
  private syncInProgress: Promise<void> | null = null;
  private pendingOperations: PendingOperation[] = [];
  private articlesCache: Article[] | null = null;

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
    if (!this.articlesCache) {
      const result = await browser.storage.local.get(["articles"]);
      const articles: Article[] = result?.articles || [];
      this.articlesCache = articles;
      return articles;
    }
    return this.articlesCache;
  }

  private async storeArticles(articles: Article[]): Promise<void> {
    this.articlesCache = articles;
    await browser.storage.local.set({ articles });
  }

  private async sameUrl(a: string, b: string): Promise<boolean> {
    if (!this.settings.normalizeOnCompare) {
      return a === b;
    }
    return (await canonicalizeUrl(a)) === (await canonicalizeUrl(b));
  }

  async findSaved(url: string): Promise<Article | undefined> {
    const articles = await this.getAllArticles();

    for (const article of articles) {
      if (await this.sameUrl(article.url, url)) {
        return article;
      }
    }

    return undefined;
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
      return searchWords.every((word) => title.includes(word) || url.includes(word));
    });
  }

  async getRecentArticles(
    page = 1,
    perPage = 30,
    search?: string,
  ): Promise<{ items: Article[]; page: number; pages: number; total: number }> {
    const articles = this.filterBySearch(await this.getAllArticles(), search).sort((a, b) =>
      b.created_at > a.created_at ? 1 : -1,
    );
    const articlesNumber = articles.length;
    const pages = Math.ceil(articlesNumber / perPage);
    // Clamp requested page to valid range; if no pages, keep page as 1
    const safePage = pages === 0 ? 1 : Math.min(Math.max(1, page), pages);
    const start = (safePage - 1) * perPage;
    const end = start + perPage;
    return {
      items: articles.slice(start, end),
      page: safePage,
      pages,
      total: articlesNumber,
    };
  }

  async saveArticle(article: Pick<Article, "url" | "title">): Promise<Article> {
    const api = await this.getApi();
    logger.info("Saving article:", article);

    const canonicalUrl = await canonicalizeUrl(article.url);

    const urlToSave = this.settings.normalizeOnSave ? canonicalUrl : article.url;

    try {
      const savedArticle = await api.saveArticle({
        url: urlToSave,
        title: article.title,
      });

      const articleWithCanonicalUrl = {
        ...savedArticle,
        canonicalUrl: canonicalUrl,
      };

      logger.debug("Saved article, now adding to cache", articleWithCanonicalUrl);
      await this.addArticle(articleWithCanonicalUrl);

      // Track this operation if sync is in progress
      if (this.syncInProgress) {
        this.pendingOperations.push({
          type: "save",
          article: { url: article.url, title: article.title },
          timestamp: Date.now(),
        });
      }

      return articleWithCanonicalUrl;
    } catch (error) {
      logger.error("Error saving article through cache:", error);

      if (error instanceof Error && error.message.includes("No token found")) {
        logger.warn("Authentication error detected, attempting to re-initialize API...");
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

          // Track this operation if sync is in progress
          if (this.syncInProgress) {
            this.pendingOperations.push({
              type: "save",
              article: { url: article.url, title: article.title },
              timestamp: Date.now(),
            });
          }

          logger.info("Successfully saved article after re-authentication");
          return retryArticleWithCanonicalUrl;
        } catch (retryError) {
          logger.error("Failed to save article even after re-authentication:", retryError);
          throw retryError;
        }
      }

      throw error;
    }
  }

  async deleteArticle(id: number): Promise<{ success: boolean; id: string | number }> {
    const api = await this.getApi();
    logger.debug("Deleting article through cache:", id);
    if (!id) {
      logger.error("Cannot delete article: No ID provided");
      throw new Error("Article ID is required");
    }
    try {
      await api.deleteArticle(id);
      await this.removeArticle(id);
      logger.debug("Deleted article from API", id);

      // Track this operation if sync is in progress
      if (this.syncInProgress) {
        this.pendingOperations.push({
          type: "delete",
          articleId: id,
          timestamp: Date.now(),
        });
      }

      return { success: true, id };
    } catch (error) {
      logger.error("Error deleting article through cache:", error);
      throw error;
    }
  }

  async syncWithAPI(
    options?: SyncOptions,
  ): Promise<{ items: Article[]; total: number; syncResult: SyncResult }> {
    if (this.syncInProgress) {
      logger.debug("Sync already in progress, waiting for completion");
      await this.syncInProgress;
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

    // Clear pending operations at start of sync
    this.pendingOperations = [];

    const syncPromise = (async (): Promise<{
      items: Article[];
      total: number;
      syncResult: SyncResult;
    }> => {
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

        // Re-apply pending operations that occurred during sync
        if (this.pendingOperations.length > 0) {
          logger.info(`Re-applying ${this.pendingOperations.length} pending operations after sync`);
          await this.reapplyPendingOperations();
          this.pendingOperations = [];
        }

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
      } finally {
        this.syncInProgress = null;
      }
    })();

    this.syncInProgress = syncPromise.then(() => undefined);
    return syncPromise;
  }

  private async reapplyPendingOperations(): Promise<void> {
    const currentArticles = await this.getAllArticles();

    for (const op of this.pendingOperations) {
      try {
        if (op.type === "save" && op.article) {
          // Check if article already exists in the synced dataset
          const pendingArticle = op.article;
          if (!pendingArticle) continue;
          const exists = currentArticles.some((a) => this.sameUrl(a.url, pendingArticle.url));

          if (!exists) {
            logger.debug("Re-applying save operation for:", op.article);
            // The article was already saved to the server, just add to local cache
            await this.addArticle({
              id: Date.now() + Math.random(), // Temporary ID, will be updated on next sync
              url: op.article.url,
              title: op.article.title,
              created_at: new Date(op.timestamp).toISOString(),
            });
          }
        } else if (op.type === "delete" && op.articleId !== undefined) {
          logger.debug("Re-applying delete operation for:", op.articleId);
          await this.removeArticle(op.articleId);
        }
      } catch (error) {
        logger.error("Error re-applying pending operation:", op, error);
      }
    }
  }

  private async addArticle(article: Article): Promise<void> {
    logger.debug("Adding article to cache:", article);

    const existingArticles = await this.getAllArticles();

    const canonicalUrl = article.canonicalUrl || article.url;
    let isDuplicate = false;
    for (const a of existingArticles) {
      if (await this.sameUrl(a.url, article.url)) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      logger.debug("Article already exists in cache, skipping add:", canonicalUrl);
      return;
    }

    await this.storeArticles([article, ...existingArticles]);
    logger.debug("Article added to cache:", article);
  }

  private async removeArticle(id: number): Promise<void> {
    logger.debug("Removing article from cache:", id);
    if (!id) {
      logger.error("Cannot remove article from cache: No ID provided");
      return;
    }
    const articles = await this.getAllArticles();
    await this.storeArticles(articles.filter((a) => a.id !== id));
  }

  async updateArticles(newArticles: Article[]): Promise<void> {
    logger.debug("Updating articles in cache:", newArticles.length);
    await this.storeArticles(newArticles);
  }

  async mergeArticles(newArticles: Article[]): Promise<void> {
    logger.debug("Merging articles in cache:", newArticles.length);
    const existingArticles = await this.getAllArticles();
    const existingMap = new Map(existingArticles.map((article) => [article.id, article]));
    const compareKeyOf = (article: Article): string =>
      this.settings.normalizeOnCompare ? article.canonicalUrl || article.url : article.url;
    const existingCanonicalMap = new Map(
      existingArticles.map((article) => [compareKeyOf(article), article]),
    );

    for (const newArticle of newArticles) {
      const canonicalUrl = compareKeyOf(newArticle);
      const existingByCanonical = existingCanonicalMap.get(canonicalUrl);

      if (existingByCanonical && existingByCanonical.id !== newArticle.id) {
        const existingById = existingMap.get(existingByCanonical.id);
        if (existingById && existingById.id === existingByCanonical.id) {
          continue;
        }
      }

      existingMap.set(newArticle.id, newArticle);
    }

    const mergedArticles = Array.from(existingMap.values());
    await this.storeArticles(mergedArticles);
    logger.debug("Merged articles count:", mergedArticles.length);
  }

  async clear(): Promise<void> {
    this.articlesCache = null;
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
