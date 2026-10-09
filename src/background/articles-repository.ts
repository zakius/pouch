import { Effect, Exit, Fiber, Semaphore } from "effect";
import {
  fromLegacyPromise,
  runOperation,
  storageHealthy,
  BrowserFailure,
  type AdapterError,
  type EffectAdapter,
} from "./api/effect-adapter";
import {
  assertStorageHealthy,
  reportRemoteOutcome,
  setLocal,
  removeLocal,
  storageShutdownSignal,
  type RemoteOutcome,
} from "../utils/fatal-storage";
import type { Article } from "../types/common";
import { getReadyAdapter } from "../utils/adapter-factory";
import { logger } from "../utils/logger";
import type { Settings } from "../utils/settings";
import { canonicalizeUrl } from "../utils/url-helpers";
import type { SyncOptions, SyncResult } from "./api/read-it-later-adapter";
import type { TokenManager } from "./token-manager";

type Mutation = { type: "save"; article: Article } | { type: "delete"; id: number | string };
type Remote = [outcome: RemoteOutcome, operation: string];
type Synced = { items: Article[]; total: number; syncResult: SyncResult };

/**
 * Runs work once for concurrent callers in a detached fiber. Interrupting one caller leaves the
 * work running for the others, and every caller sees its original success or failure. Fatal
 * storage shutdown still interrupts it.
 */
class Shared<A, E> {
  private fiber: Fiber.Fiber<A, E> | undefined;
  constructor(private readonly keepSuccess: boolean) {}

  get running(): boolean {
    return this.fiber !== undefined;
  }

  join(work: () => Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      if (this.fiber) return Fiber.join(this.fiber);
      const fiber = Effect.runFork(work(), { signal: storageShutdownSignal() });
      this.fiber = fiber;
      // Runs at once if the fiber already exited, e.g. after fatal storage shutdown.
      fiber.addObserver((exit) => {
        if (this.fiber === fiber && !(this.keepSuccess && Exit.isSuccess(exit)))
          this.fiber = undefined;
      });
      return Fiber.join(fiber);
    });
  }
}

/** One initialize() call's state. Re-initializing retires it, so its late work never commits. */
type Account = {
  readonly settings: Settings;
  readonly keys: AccountStorageKeys;
  retired: boolean;
  readonly adapter: Shared<EffectAdapter, AdapterError>;
  readonly sync: Shared<Synced, AdapterError>;
  articles?: Article[];
  timestamps?: { last: string | null; full: number | null };
  /** Mutations committed while a sync fetches; its commit replays them onto the snapshot. */
  pending: Mutation[];
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
  private account: Account | undefined;
  /** Short local commits run one at a time across accounts; network work never holds it. */
  private readonly commits = Semaphore.makeUnsafe(1);

  /** `tokens` defaults to the shared, persisted TokenManager; pass a separate one to isolate credentials. */
  constructor(private readonly tokens?: TokenManager) {}

  initialize(settings: Settings): void {
    assertStorageHealthy();
    logger.info("Initializing ArticlesRepository with settings:", settings);
    if (this.account) this.account.retired = true;
    this.account = {
      settings,
      keys: getAccountStorageKeys(settings),
      retired: false,
      adapter: new Shared(true),
      sync: new Shared(false),
      pending: [],
    };
  }

  private active(): Account {
    if (!this.account) throw new Error("ArticlesRepository is not initialized");
    return this.account;
  }

  private adapter(account: Account): Effect.Effect<EffectAdapter, AdapterError> {
    return account.adapter.join(() => getReadyAdapter(account.settings, this.tokens));
  }

  readonly saveArticleEffect = Effect.fn("repository.save")(function* (
    this: ArticlesRepository,
    article: Pick<Article, "url" | "title">,
  ) {
    const account = this.active();
    const api = yield* this.adapter(account);
    const canonicalUrl = yield* fromLegacyPromise(() => canonicalizeUrl(article.url));
    // Browser mutations cannot be cancelled after submission; commit and bookkeeping must finish together.
    return yield* Effect.gen({ self: this }, function* () {
      const savedArticle = yield* api.saveArticle({
        url: account.settings.normalizeOnSave ? canonicalUrl : article.url,
        title: article.title,
      });
      reportRemoteOutcome("save", "succeeded");
      const saved = { ...savedArticle, canonicalUrl };
      yield* this.commit(account, ["succeeded", "save"], { type: "save", article: saved });
      return saved;
    }).pipe(Effect.uninterruptible);
  });
  readonly deleteArticleEffect = Effect.fn("repository.delete")(function* (
    this: ArticlesRepository,
    id: number | string,
  ) {
    const account = this.active();
    const api = yield* this.adapter(account);
    return yield* Effect.gen({ self: this }, function* () {
      yield* api.deleteArticle(id);
      reportRemoteOutcome("delete", "succeeded");
      yield* this.commit(account, ["succeeded", "delete"], { type: "delete", id });
      return { success: true, id };
    }).pipe(Effect.uninterruptible);
  });
  /** Concurrent callers share one fetch and its committed result or failure. */
  readonly syncWithAPIEffect = Effect.fn("repository.sync")(function* (
    this: ArticlesRepository,
    options?: SyncOptions,
  ) {
    const account = this.active();
    return yield* account.sync.join(() => this.syncAccount(account, options));
  });
  readonly testConnectionEffect = Effect.gen({ self: this }, function* () {
    const api = yield* this.adapter(this.active());
    yield* storageHealthy;
    return yield* api.testConnection;
  });

  saveArticle(article: Pick<Article, "url" | "title">): Promise<Article> {
    return runOperation(this.saveArticleEffect(article));
  }
  deleteArticle(id: number | string): Promise<{ success: boolean; id: string | number }> {
    return runOperation(this.deleteArticleEffect(id));
  }
  syncWithAPI(options?: SyncOptions): Promise<Synced> {
    return runOperation(this.syncWithAPIEffect(options));
  }
  testConnection(): Promise<boolean> {
    return runOperation(this.testConnectionEffect);
  }

  async getArticle(id: number | string): Promise<Article | undefined> {
    const articles = await this.getAllArticles();
    // Ids are compared as strings: the storage may hold entries written by
    // versions that used the other type, and bookmark ids are strings in both
    // APIs (GUIDs on Firefox, decimal strings on Chromium).
    return articles.find((a) => String(a.id) === String(id));
  }

  getAllArticles(): Promise<Article[]> {
    return this.articles(this.active());
  }

  private async articles(account: Account): Promise<Article[]> {
    assertStorageHealthy();
    if (account.articles) return account.articles;
    const result = await browser.storage.local.get([account.keys.articles]).catch(() => {
      throw new BrowserFailure("read local articles");
    });
    assertStorageHealthy();
    // A commit may have published while this read was pending; it is newer.
    account.articles ??= (result?.[account.keys.articles] as Article[] | undefined) || [];
    return account.articles;
  }

  /**
   * Serializes one local change: reads the committed articles, persists the change, then
   * publishes it. A failed write latches fatal storage, which fails queued and later commits.
   */
  private commit(
    account: Account,
    remote: Remote | undefined,
    change: Mutation | ((articles: Article[]) => Promise<Article[]>),
    after?: () => Promise<void>,
  ): Effect.Effect<void, AdapterError> {
    const [outcome, operation] = remote ?? [undefined, undefined];
    const work = fromLegacyPromise(async () => {
      // A retired account's late work must not reach storage the next account may share.
      if (account.retired) return;
      assertStorageHealthy(outcome, operation);
      const articles = await this.articles(account);
      const next =
        typeof change === "function"
          ? await change(articles)
          : await this.apply(account, articles, change);
      if (next !== articles) {
        await setLocal("persist articles", { [account.keys.articles]: next }, outcome, operation);
        assertStorageHealthy(outcome, operation);
        account.articles = next;
      }
      if (typeof change !== "function" && account.sync.running) account.pending.push(change);
      await after?.();
    });
    return Semaphore.withPermit(this.commits, work.pipe(Effect.uninterruptible));
  }

  private async apply(
    account: Account,
    articles: Article[],
    mutation: Mutation,
  ): Promise<Article[]> {
    if (mutation.type === "delete") {
      // String comparison, so entries stored with the other id type (see getArticle) still match.
      const target = String(mutation.id);
      return articles.filter((a) => String(a.id) !== target);
    }
    for (const a of articles) {
      if (await this.sameUrl(account, a.url, mutation.article.url)) {
        logger.debug("Article already exists in cache, skipping add:", mutation.article.url);
        return articles;
      }
    }
    return [mutation.article, ...articles];
  }

  private syncAccount(
    account: Account,
    options?: SyncOptions,
  ): Effect.Effect<Synced, AdapterError> {
    return Effect.gen({ self: this }, function* () {
      account.pending = [];
      const api = yield* this.adapter(account);
      const timestamps = yield* fromLegacyPromise(() => this.timestamps(account));
      const syncOptions: SyncOptions = {
        ...options,
        lastSyncTimestamp: timestamps.last ?? undefined,
        lastFullSyncTimestamp: timestamps.full ?? undefined,
        isBrowserIdle: options?.isBrowserIdle ?? (yield* Effect.promise(() => isBrowserIdle())),
      };
      logger.info("Starting cache sync with API", {
        providedMode: options?.mode,
        lastSync: timestamps.last,
        lastFullSync: timestamps.full ? new Date(timestamps.full).toISOString() : null,
        isBrowserIdle: syncOptions.isBrowserIdle,
      });

      const fetchStartedAt = new Date().toISOString();
      yield* storageHealthy;
      const syncResult = yield* api.sync(syncOptions);
      yield* storageHealthy;
      logger.debug(
        `Synced ${syncResult.articles.length} articles from API using ${syncResult.mode} mode`,
        { metadata: syncResult.metadata },
      );
      const fetched = yield* fromLegacyPromise(() =>
        Promise.all(
          syncResult.articles.map(async (article) => {
            const canonicalUrl = await canonicalizeUrl(article.url);
            return account.settings.normalizeOnSave
              ? { ...article, canonicalUrl, url: canonicalUrl }
              : { ...article, canonicalUrl };
          }),
        ),
      );

      yield* this.commit(
        account,
        ["succeeded", "sync"],
        async (articles) => {
          let next =
            syncResult.mode === "overwrite" ? fetched : merge(account.settings, articles, fetched);
          // Mutations committed after the fetch started may be missing from the snapshot.
          if (account.pending.length > 0)
            logger.info(`Re-applying ${account.pending.length} pending operations after sync`);
          for (const mutation of account.pending) next = await this.apply(account, next, mutation);
          account.pending = [];
          return next;
        },
        () =>
          this.storeTimestamps(account, {
            full: syncResult.mode === "overwrite" ? Date.parse(fetchStartedAt) : timestamps.full,
            last: fetchStartedAt,
          }),
      );
      const items = yield* fromLegacyPromise(() => this.articles(account));
      return { items, total: items.length, syncResult };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => logger.error("Error syncing cache with API:", error)),
      ),
    );
  }

  private sameUrl(account: Account, a: string, b: string): Promise<boolean> | boolean {
    if (!account.settings.normalizeOnCompare) return a === b;
    return Promise.all([canonicalizeUrl(a), canonicalizeUrl(b)]).then(([x, y]) => x === y);
  }

  async findSaved(url: string): Promise<Article | undefined> {
    const account = this.active();
    for (const article of await this.articles(account)) {
      if (await this.sameUrl(account, article.url, url)) return article;
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

  updateArticles(articles: Article[]): Promise<void> {
    return runOperation(this.commit(this.active(), undefined, () => Promise.resolve(articles)));
  }

  mergeArticles(articles: Article[]): Promise<void> {
    const account = this.active();
    return runOperation(
      this.commit(account, undefined, (existing) =>
        Promise.resolve(merge(account.settings, existing, articles)),
      ),
    );
  }

  async clear(): Promise<void> {
    const account = this.active();
    await removeLocal("clear articles", account.keys.articles);
    assertStorageHealthy();
    account.articles = undefined;
  }

  private async timestamps(account: Account): Promise<NonNullable<Account["timestamps"]>> {
    if (account.timestamps) return account.timestamps;
    const { keys } = account;
    const result = await browser.storage.local
      .get([keys.lastFullSyncTimestamp, keys.lastSyncTimestamp])
      .catch(() => {
        throw new BrowserFailure("read sync metadata");
      });
    assertStorageHealthy();
    account.timestamps ??= {
      full: (result[keys.lastFullSyncTimestamp] as number | undefined) || null,
      last: (result[keys.lastSyncTimestamp] as string | undefined) || null,
    };
    return account.timestamps;
  }

  private async storeTimestamps(
    account: Account,
    timestamps: NonNullable<Account["timestamps"]>,
  ): Promise<void> {
    await setLocal(
      "persist sync timestamps",
      {
        [account.keys.lastFullSyncTimestamp]: timestamps.full,
        [account.keys.lastSyncTimestamp]: timestamps.last,
      },
      "succeeded",
      "sync",
    );
    assertStorageHealthy();
    account.timestamps = timestamps;
  }
}

function merge(settings: Settings, existingArticles: Article[], newArticles: Article[]): Article[] {
  const existingMap = new Map(existingArticles.map((article) => [article.id, article]));
  const compareKeyOf = (article: Article): string =>
    settings.normalizeOnCompare ? article.canonicalUrl || article.url : article.url;
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

  return Array.from(existingMap.values());
}

async function isBrowserIdle(): Promise<boolean> {
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
