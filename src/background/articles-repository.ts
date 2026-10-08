import { Effect } from "effect";
import {
  fromLegacyPromise,
  isAdapterError,
  runOperation,
  storageHealthy,
  BrowserFailure,
  type EffectAdapter,
} from "./api/effect-adapter";
import {
  assertStorageHealthy,
  FatalStorageError,
  reportRemoteOutcome,
  setLocal,
  removeLocal,
  type RemoteOutcome,
} from "../utils/fatal-storage";
import type { Article } from "../types/common";
import { getAdapter, getReadyAdapter } from "../utils/adapter-factory";
import { hasBackendPermissions, missingPermissionMessage } from "../utils/backend-permissions";
import { logger } from "../utils/logger";
import type { Settings } from "../utils/settings";
import { canonicalizeUrl } from "../utils/url-helpers";
import type {
  ReadItLaterAPI,
  SyncMode,
  SyncOptions,
  SyncResult,
} from "./api/read-it-later-adapter";
import type { TokenManager } from "./token-manager";

type PendingOperation = {
  type: "save" | "delete";
  article?: Article;
  articleId?: number | string;
  timestamp: number;
};

export interface AccountStorageKeys {
  articles: string;
  lastSyncTimestamp: string;
  lastFullSyncTimestamp: string;
}

export function getAccountIdentity(settings: Settings): string {
  return JSON.stringify({ backend: settings.backend, apiConfig: settings.apiConfig });
}

export function getAccountStorageKeys(settings: Settings): AccountStorageKeys {
  const identity = getAccountIdentity(settings);
  let hash = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) {
    hash ^= identity.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36);
  return {
    articles: `articles:${suffix}`,
    lastSyncTimestamp: `lastSyncTimestamp:${suffix}`,
    lastFullSyncTimestamp: `lastFullSyncTimestamp:${suffix}`,
  };
}

/** Removes cached articles and sync timestamps left behind by other (or pre-per-account) accounts. */
export async function removeStaleAccountKeys(settings: Settings): Promise<void> {
  assertStorageHealthy();
  const current = new Set(Object.values(getAccountStorageKeys(settings)));
  const prefixes = ["articles", "lastSyncTimestamp", "lastFullSyncTimestamp"];
  const stale = Object.keys(await browser.storage.local.get(null)).filter(
    (key) => !current.has(key) && prefixes.some((p) => key === p || key.startsWith(`${p}:`)),
  );
  if (stale.length > 0) {
    await removeLocal("remove stale account data", stale);
  }
}

export class ArticlesRepository {
  private api: ReadItLaterAPI | null = null;
  private effectApi: Promise<EffectAdapter> | undefined;
  private apiInitPromise: Promise<ReadItLaterAPI> | null = null;
  private settings!: Settings;
  private lastFullSyncTimestamp: number | null = null;
  private lastSyncTimestamp: string | null = null;
  private syncInProgress: Promise<void> | null = null;
  private pendingOperations: PendingOperation[] = [];
  private articlesCache: Article[] | null = null;
  private commitQueue: Promise<unknown> = Promise.resolve();
  private storageKeys: AccountStorageKeys = {
    articles: "articles",
    lastSyncTimestamp: "lastSyncTimestamp",
    lastFullSyncTimestamp: "lastFullSyncTimestamp",
  };

  /** `tokens` defaults to the shared, persisted TokenManager; pass a separate one to isolate credentials. */
  constructor(private readonly tokens?: TokenManager) {}

  async initialize(settings: Settings): Promise<void> {
    assertStorageHealthy();
    logger.info("Initializing ArticlesRepository with settings:", settings);
    this.settings = settings;
    this.api = null;
    this.effectApi = undefined;
    this.apiInitPromise = null;
    this.storageKeys = getAccountStorageKeys(settings);
    await this.loadSyncTimestamps();
  }

  private get usesEffectAdapter(): boolean {
    return this.settings.backend === "bookmarks" || this.settings.backend === "wallabag";
  }

  private getApi(): Promise<ReadItLaterAPI> {
    assertStorageHealthy();
    if (this.api) {
      return Promise.resolve(this.api);
    }
    if (!this.apiInitPromise) {
      logger.debug("API not initialized, creating adapter now...");
      this.apiInitPromise = (async () => {
        if (!(await hasBackendPermissions(this.settings))) {
          throw new Error(missingPermissionMessage(this.settings));
        }
        assertStorageHealthy();
        const api: ReadItLaterAPI = this.usesEffectAdapter
          ? this.effectPromiseBridge(await this.getEffectApi())
          : getAdapter(this.settings.backend, this.tokens);
        await api.initialize(this.settings);
        logger.info("On-demand API initialization completed");
        assertStorageHealthy();
        this.api = api;
        return api;
      })().catch((error: unknown) => {
        if (error instanceof FatalStorageError) throw error;
        assertStorageHealthy();
        this.apiInitPromise = null;
        if (isAdapterError(error) || this.usesEffectAdapter) throw error;
        logger.error("Failed to initialize API:", error);
        throw new Error(
          `Failed to initialize ${this.settings.backend} API: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      });
    }
    return this.apiInitPromise;
  }

  private async testConnectionLegacy(): Promise<boolean> {
    const api = await this.getApi();
    assertStorageHealthy();
    const result = await api.testConnection();
    assertStorageHealthy();
    return result;
  }

  private effectPromiseBridge(api: EffectAdapter): ReadItLaterAPI {
    return {
      displayName: api.displayName,
      formConfig: api.formConfig,
      initialize: async () => {},
      saveArticle: (article) => runOperation(api.saveArticle(article)),
      deleteArticle: (id) => runOperation(api.deleteArticle(id)),
      sync: (options) => runOperation(api.sync(options)),
      testConnection: () => runOperation(api.testConnection),
    };
  }

  private getEffectApi(): Promise<EffectAdapter> {
    if (this.settings.backend !== "bookmarks" && this.settings.backend !== "wallabag")
      throw new Error("Ready backend required");
    this.effectApi ??= runOperation(getReadyAdapter(this.settings, this.tokens)).catch(
      (error: unknown) => {
        this.effectApi = undefined;
        throw error;
      },
    );
    return this.effectApi;
  }

  readonly saveArticleEffect = Effect.fn("repository.save")(function* (
    this: ArticlesRepository,
    article: Pick<Article, "url" | "title">,
  ) {
    const api = yield* fromLegacyPromise(() => this.getEffectApi());
    const canonicalUrl = yield* fromLegacyPromise(() => canonicalizeUrl(article.url));
    // Browser mutations cannot be cancelled after submission; commit and bookkeeping must finish together.
    return yield* Effect.gen({ self: this }, function* () {
      const savedArticle = yield* api.saveArticle({
        url: this.settings.normalizeOnSave ? canonicalUrl : article.url,
        title: article.title,
      });
      reportRemoteOutcome("save", "succeeded");
      const saved = { ...savedArticle, canonicalUrl };
      yield* fromLegacyPromise(() => this.addArticle(saved, "succeeded", "save"));
      if (this.syncInProgress)
        this.pendingOperations.push({ type: "save", article: saved, timestamp: Date.now() });
      return saved;
    }).pipe(Effect.uninterruptible);
  });
  readonly deleteArticleEffect = Effect.fn("repository.delete")(function* (
    this: ArticlesRepository,
    id: number | string,
  ) {
    const api = yield* fromLegacyPromise(() => this.getEffectApi());
    return yield* Effect.gen({ self: this }, function* () {
      yield* api.deleteArticle(id);
      reportRemoteOutcome("delete", "succeeded");
      yield* fromLegacyPromise(() => this.removeArticle(id, "succeeded", "delete"));
      if (this.syncInProgress)
        this.pendingOperations.push({ type: "delete", articleId: id, timestamp: Date.now() });
      return { success: true, id };
    }).pipe(Effect.uninterruptible);
  });
  // Shared Promise sync/commit coordination is migrated in #80 and its bridge removed in #81.
  readonly syncWithAPIEffect = Effect.fn("repository.sync")((options?: SyncOptions) =>
    fromLegacyPromise(() => this.syncWithAPILegacy(options)),
  );
  readonly testConnectionEffect = Effect.gen({ self: this }, function* () {
    const api = yield* fromLegacyPromise(() => this.getEffectApi());
    yield* storageHealthy;
    return yield* api.testConnection;
  });

  saveArticle(article: Pick<Article, "url" | "title">): Promise<Article> {
    return this.usesEffectAdapter
      ? runOperation(this.saveArticleEffect(article))
      : this.saveArticleLegacy(article);
  }
  deleteArticle(id: number | string): Promise<{ success: boolean; id: string | number }> {
    return this.usesEffectAdapter
      ? runOperation(this.deleteArticleEffect(id))
      : this.deleteArticleLegacy(id);
  }
  syncWithAPI(
    options?: SyncOptions,
  ): Promise<{ items: Article[]; total: number; syncResult: SyncResult }> {
    return this.usesEffectAdapter
      ? runOperation(this.syncWithAPIEffect(options))
      : this.syncWithAPILegacy(options);
  }
  testConnection(): Promise<boolean> {
    return this.usesEffectAdapter
      ? runOperation(this.testConnectionEffect)
      : this.testConnectionLegacy();
  }

  async getArticle(id: number | string): Promise<Article | undefined> {
    const articles = await this.getAllArticles();
    // Ids are compared as strings: the storage may hold entries written by
    // versions that used the other type, and bookmark ids are strings in both
    // APIs (GUIDs on Firefox, decimal strings on Chromium).
    return articles.find((a) => String(a.id) === String(id));
  }

  async getAllArticles(): Promise<Article[]> {
    assertStorageHealthy();
    if (!this.articlesCache) {
      const result = await browser.storage.local
        .get([this.storageKeys.articles])
        .catch((error: unknown) => {
          if (this.usesEffectAdapter) throw new BrowserFailure("read local articles");
          throw error;
        });
      const articles: Article[] = result?.[this.storageKeys.articles] || [];
      assertStorageHealthy();
      this.articlesCache = articles;
      return articles;
    }
    return this.articlesCache;
  }

  private async storeArticles(
    articles: Article[],
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    await setLocal(
      "persist articles",
      { [this.storageKeys.articles]: articles },
      remoteOutcome,
      remoteOperation,
    );
    assertStorageHealthy();
    this.articlesCache = articles;
  }

  private enqueueCommit<T>(
    operation: () => Promise<T>,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<T> {
    const result = this.commitQueue
      .then(() => {
        assertStorageHealthy(remoteOutcome, remoteOperation);
        return operation();
      })
      .catch((error: unknown) => {
        assertStorageHealthy(remoteOutcome, remoteOperation);
        throw error;
      });
    this.commitQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    // Clamp page into [1, pages]; an empty result set has no pages, so report page 1
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

  private async saveArticleLegacy(article: Pick<Article, "url" | "title">): Promise<Article> {
    const api = await this.getApi();
    logger.info("Saving article:", article);

    const canonicalUrl = await canonicalizeUrl(article.url);

    const urlToSave = this.settings.normalizeOnSave ? canonicalUrl : article.url;

    try {
      assertStorageHealthy();
      const savedArticle = await api.saveArticle({
        url: urlToSave,
        title: article.title,
      });

      reportRemoteOutcome("save", "succeeded");
      const articleWithCanonicalUrl = {
        ...savedArticle,
        canonicalUrl: canonicalUrl,
      };

      logger.debug("Saved article, now adding to cache", articleWithCanonicalUrl);
      await this.addArticle(articleWithCanonicalUrl, "succeeded", "save");

      // Track this operation if sync is in progress
      if (this.syncInProgress) {
        this.pendingOperations.push({
          type: "save",
          article: articleWithCanonicalUrl,
          timestamp: Date.now(),
        });
      }

      return articleWithCanonicalUrl;
    } catch (error) {
      logger.error("Error saving article through cache:", error);

      throw error;
    }
  }

  private async deleteArticleLegacy(
    id: number | string,
  ): Promise<{ success: boolean; id: string | number }> {
    const api = await this.getApi();
    logger.debug("Deleting article through cache:", id);
    if (!id) {
      logger.error("Cannot delete article: No ID provided");
      throw new Error("Article ID is required");
    }
    try {
      assertStorageHealthy();
      await api.deleteArticle(id);
      reportRemoteOutcome("delete", "succeeded");
      await this.removeArticle(id, "succeeded", "delete");
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

  private async syncWithAPILegacy(
    options?: SyncOptions,
  ): Promise<{ items: Article[]; total: number; syncResult: SyncResult }> {
    assertStorageHealthy();
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

        const fetchStartedAt = new Date().toISOString();
        assertStorageHealthy();
        const syncResult = await api.sync(syncOptions);
        assertStorageHealthy();
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
          await this.updateArticles(processedArticles, "succeeded", "sync");
        } else if (syncResult.mode === "update") {
          // Merge new articles with existing ones
          await this.mergeArticles(processedArticles, "succeeded", "sync");
        }

        // Update sync timestamps
        await this.updateSyncTimestamp(syncResult.mode, fetchStartedAt);

        // An API failure mid-sync would drop mutations made after the fetch, so
        // queued saves and deletes are re-applied against the synced state.
        if (this.pendingOperations.length > 0) {
          logger.info(`Re-applying ${this.pendingOperations.length} pending operations after sync`);
          await this.reapplyPendingOperations();
          this.pendingOperations = [];
        }

        const currentArticles = await this.getAllArticles();
        return {
          items: currentArticles,
          total: currentArticles.length,
          syncResult,
        };
      } catch (error) {
        logger.error("Error syncing cache with API:", error);
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        this.syncInProgress = null;
      }
    })();

    this.syncInProgress = syncPromise.then(
      () => undefined,
      () => undefined,
    );
    return syncPromise;
  }

  private async reapplyPendingOperations(): Promise<void> {
    for (const op of this.pendingOperations) {
      try {
        if (op.type === "save" && op.article) {
          logger.debug("Re-applying save operation for:", op.article);
          await this.addArticle(op.article, "succeeded", "save");
        } else if (op.type === "delete" && op.articleId !== undefined) {
          logger.debug("Re-applying delete operation for:", op.articleId);
          await this.removeArticle(op.articleId, "succeeded", "delete");
        }
      } catch (error) {
        assertStorageHealthy();
        logger.error("Error re-applying pending operation:", op, error);
      }
    }
  }

  private addArticle(
    article: Article,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    logger.debug("Adding article to cache:", article);

    return this.enqueueCommit(
      async () => {
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

        await this.storeArticles([article, ...existingArticles], remoteOutcome, remoteOperation);
        logger.debug("Article added to cache:", article);
      },
      remoteOutcome,
      remoteOperation,
    );
  }

  private removeArticle(
    id: number | string,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    logger.debug("Removing article from cache:", id);
    if (id === undefined || id === null || id === "") {
      logger.error("Cannot remove article from cache: No ID provided");
      return Promise.resolve();
    }
    return this.enqueueCommit(
      async () => {
        const articles = await this.getAllArticles();
        // String comparison, so entries stored with the other id type (see
        // getArticle) still match.
        const target = String(id);
        await this.storeArticles(
          articles.filter((a) => String(a.id) !== target),
          remoteOutcome,
          remoteOperation,
        );
      },
      remoteOutcome,
      remoteOperation,
    );
  }

  updateArticles(
    newArticles: Article[],
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    logger.debug("Updating articles in cache:", newArticles.length);
    return this.enqueueCommit(
      () => this.storeArticles(newArticles, remoteOutcome, remoteOperation),
      remoteOutcome,
      remoteOperation,
    );
  }

  mergeArticles(
    newArticles: Article[],
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    logger.debug("Merging articles in cache:", newArticles.length);
    return this.enqueueCommit(
      async () => {
        const existingArticles = await this.getAllArticles();
        const existingMap = new Map(existingArticles.map((article) => [article.id, article]));
        const compareKeyOf = (article: Article): string =>
          this.settings.normalizeOnCompare ? article.canonicalUrl || article.url : article.url;
        const existingCanonicalMap = new Map(
          existingArticles.map((article) => [compareKeyOf(article), article]),
        );

        for (const newArticle of newArticles) {
          const compareKey = compareKeyOf(newArticle);
          const existingByCanonical = existingCanonicalMap.get(compareKey);

          if (existingByCanonical && existingByCanonical.id !== newArticle.id) {
            const existingById = existingMap.get(existingByCanonical.id);
            if (existingById && existingById.id === existingByCanonical.id) {
              continue;
            }
          }

          existingMap.set(newArticle.id, newArticle);
          existingCanonicalMap.set(compareKey, newArticle);
        }

        const mergedArticles = Array.from(existingMap.values());
        await this.storeArticles(mergedArticles, remoteOutcome, remoteOperation);
        logger.debug("Merged articles count:", mergedArticles.length);
      },
      remoteOutcome,
      remoteOperation,
    );
  }

  async clear(): Promise<void> {
    await removeLocal("clear articles", this.storageKeys.articles);
    assertStorageHealthy();
    this.articlesCache = null;
  }

  private async loadSyncTimestamps(): Promise<void> {
    try {
      const result = await browser.storage.local
        .get([this.storageKeys.lastFullSyncTimestamp, this.storageKeys.lastSyncTimestamp])
        .catch((error: unknown) => {
          if (this.usesEffectAdapter) throw new BrowserFailure("read sync metadata");
          throw error;
        });
      assertStorageHealthy();
      this.lastFullSyncTimestamp = result[this.storageKeys.lastFullSyncTimestamp] || null;
      this.lastSyncTimestamp = result[this.storageKeys.lastSyncTimestamp] || null;
      logger.debug("Loaded sync timestamps:", {
        lastSync: this.lastSyncTimestamp,
        lastFullSync: this.lastFullSyncTimestamp
          ? new Date(this.lastFullSyncTimestamp).toISOString()
          : null,
      });
    } catch (error) {
      assertStorageHealthy();
      if (this.usesEffectAdapter) throw error;
      logger.error("Failed to load sync timestamps:", error);
      this.lastFullSyncTimestamp = null;
      this.lastSyncTimestamp = null;
    }
  }

  private async isBrowserIdle(): Promise<boolean> {
    try {
      const state = await browser.idle.queryState(300);
      logger.debug("Browser idle state:", { state, isIdle: state === "idle" });
      return state === "idle";
    } catch (error) {
      logger.debug("Could not check browser idle state:", error);
      // If idle API is not available, assume not idle
      return false;
    }
  }

  private async updateSyncTimestamp(mode: SyncMode, fetchStartedAt: string): Promise<void> {
    const full = mode === "overwrite" ? Date.parse(fetchStartedAt) : this.lastFullSyncTimestamp;
    await setLocal(
      "persist sync timestamps",
      {
        [this.storageKeys.lastFullSyncTimestamp]: full,
        [this.storageKeys.lastSyncTimestamp]: fetchStartedAt,
      },
      "succeeded",
      "sync",
    );
    assertStorageHealthy();
    this.lastFullSyncTimestamp = full;
    this.lastSyncTimestamp = fetchStartedAt;
  }
}
