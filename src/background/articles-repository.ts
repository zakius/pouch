import { Cause, Effect, Exit, Fiber, Semaphore } from "effect";
import {
  localRead,
  storageHealthy,
  storageHealthyAfter,
  storagePromise,
  type AdapterError,
  type BrowserFailure,
  type EffectAdapter,
  type FatalStorageFailure,
} from "./api/effect-adapter";
import {
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
import { canonicalizeUrl, getCanonicalCacheGeneration } from "../utils/url-helpers";
import type { SyncOptions, SyncResult } from "./api/read-it-later-adapter";
import type { TokenManager } from "./token-manager";

type Mutation = { type: "save"; article: Article } | { type: "delete"; id: number | string };
type Remote = [outcome: RemoteOutcome, operation: string];
type Synced = { items: Article[]; total: number; syncResult: SyncResult };
type LocalError = BrowserFailure | FatalStorageFailure;

const canonical = (url: string) => storagePromise(() => canonicalizeUrl(url));

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
      return Effect.forkDetach(Effect.suspend(work)).pipe(
        Effect.flatMap((fiber) => {
          // The fork can yield to another caller first; a fiber that hasn't started costs nothing.
          if (this.fiber) {
            fiber.interruptUnsafe();
            return Fiber.join(this.fiber);
          }
          this.fiber = fiber;
          const shutdown = storageShutdownSignal();
          const stop = () => fiber.interruptUnsafe();
          shutdown.addEventListener("abort", stop, { once: true });
          if (shutdown.aborted) stop();
          // Runs at once if the fiber already exited.
          fiber.addObserver((exit) => {
            shutdown.removeEventListener("abort", stop);
            // Callers may all have left; Effect does not report a detached fiber that dies.
            if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
              logger.error("Shared background work died:", Cause.pretty(exit.cause));
            if (this.fiber === fiber && !(this.keepSuccess && Exit.isSuccess(exit)))
              this.fiber = undefined;
          });
          return Fiber.join(fiber);
        }),
      );
    });
  }
}

type CanonicalIndex = {
  readonly articles: Article[];
  readonly generation: number;
  readonly byCanonical: Map<string, Article>;
};

type RawIndex = {
  readonly articles: Article[];
  readonly byUrl: Map<string, Article>;
};

type KnownArticleCanonicals = {
  readonly url: string;
  readonly givenUrl?: string;
};

/** One account's state. A different account identity retires it, so its late work never commits. */
type Account = {
  /** Same-identity settings changes apply in place, so in-flight work still commits. */
  settings: Settings;
  readonly keys: AccountStorageKeys;
  retired: boolean;
  readonly adapter: Shared<EffectAdapter, AdapterError>;
  readonly sync: Shared<Synced, AdapterError>;
  articles?: Article[];
  canonicalIndex?: CanonicalIndex;
  rawIndex?: RawIndex;
  /** Canonical URLs computed in-memory under a specific cache generation. */
  knownCanonicals?: {
    generation: number;
    byArticle: WeakMap<Article, KnownArticleCanonicals>;
  };
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
export const removeStaleAccountKeys = Effect.fn("repository.removeStale")(function* (
  settings: Settings,
) {
  const current = new Set(Object.values(getAccountStorageKeys(settings)));
  const prefixes = ["articles", "lastSyncTimestamp", "lastFullSyncTimestamp"];
  const stale = Object.keys(yield* localRead("read stale account data", null)).filter(
    (key) => !current.has(key) && prefixes.some((p) => key === p || key.startsWith(`${p}:`)),
  );
  if (stale.length > 0)
    yield* storagePromise(() => removeLocal("remove stale account data", stale));
});

export class ArticlesRepository {
  private account: Account | undefined;
  /** Short local commits run one at a time across accounts; network work never holds it. */
  private readonly commits = Semaphore.makeUnsafe(1);

  /** `tokens` defaults to the shared, persisted TokenManager; pass a separate one to isolate credentials. */
  constructor(private readonly tokens?: TokenManager) {}

  initialize(settings: Settings): void {
    logger.info("Initializing ArticlesRepository with settings:", settings);
    if (
      this.account &&
      getAccountIdentity(this.account.settings) === getAccountIdentity(settings)
    ) {
      this.account.settings = settings;
      return;
    }
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

  /**
   * Removes other accounts' keys after in-flight commits finish, so a retired account's commit
   * that already passed its retired check cannot write its keys back.
   */
  removeStaleKeys(settings: Settings): Effect.Effect<void, LocalError> {
    return Semaphore.withPermit(this.commits, removeStaleAccountKeys(settings));
  }

  private active(): Effect.Effect<Account> {
    return Effect.suspend(() =>
      this.account
        ? Effect.succeed(this.account)
        : Effect.die("ArticlesRepository is not initialized"),
    );
  }

  private adapter(account: Account): Effect.Effect<EffectAdapter, AdapterError> {
    return account.adapter.join(() => getReadyAdapter(account.settings, this.tokens));
  }

  readonly saveArticle = Effect.fn("repository.save")(function* (
    this: ArticlesRepository,
    article: Pick<Article, "url" | "title">,
  ) {
    const account = yield* this.active();
    const { existing, canonicalUrl: precomputedCanonical } = yield* this.findSavedInAccount(
      account,
      article.url,
    ).pipe(
      Effect.catchTag("BrowserFailure", (error) => {
        logger.warn("Skipping pre-save duplicate check because local cache read failed:", error);
        return Effect.succeed({ existing: undefined, canonicalUrl: undefined });
      }),
    );
    if (existing) {
      logger.debug("Article already saved in cache, skipping remote save:", article.url);
      return existing;
    }
    const canonicalUrl = precomputedCanonical ?? (yield* canonical(article.url));
    if (
      !account.settings.normalizeOnCompare &&
      account.settings.normalizeOnSave &&
      canonicalUrl !== article.url &&
      account.articles &&
      account.articles.length > 0
    ) {
      const existingNormalized = this.getRawIndex(account, account.articles).get(canonicalUrl);
      if (existingNormalized) {
        logger.debug(
          "Normalized article already saved in cache, skipping remote save:",
          canonicalUrl,
        );
        return existingNormalized;
      }
    }
    const api = yield* this.adapter(account);
    // Browser mutations cannot be cancelled after submission; commit and bookkeeping must finish together.
    return yield* Effect.gen({ self: this }, function* () {
      const savedArticle = yield* api.saveArticle({
        url: account.settings.normalizeOnSave ? canonicalUrl : article.url,
        title: article.title,
      });
      reportRemoteOutcome("save", "succeeded");
      const savedCanonicalUrl =
        savedArticle.url === article.url || savedArticle.url === canonicalUrl
          ? canonicalUrl
          : yield* canonical(savedArticle.url);
      const savedCanonicalGivenUrl = savedArticle.givenUrl
        ? savedArticle.givenUrl === article.url || savedArticle.givenUrl === canonicalUrl
          ? canonicalUrl
          : yield* canonical(savedArticle.givenUrl)
        : undefined;
      const saved: Article = {
        ...savedArticle,
        canonicalUrl: savedCanonicalUrl,
        ...(savedCanonicalGivenUrl && savedCanonicalGivenUrl !== savedCanonicalUrl
          ? { canonicalGivenUrl: savedCanonicalGivenUrl }
          : {}),
      };
      yield* this.commit(account, ["succeeded", "save"], { type: "save", article: saved });
      return saved;
    }).pipe(Effect.uninterruptible);
  });
  readonly deleteArticle = Effect.fn("repository.delete")(function* (
    this: ArticlesRepository,
    id: number | string,
  ) {
    const account = yield* this.active();
    const api = yield* this.adapter(account);
    return yield* Effect.gen({ self: this }, function* () {
      yield* api.deleteArticle(id);
      reportRemoteOutcome("delete", "succeeded");
      yield* this.commit(account, ["succeeded", "delete"], { type: "delete", id });
      return { success: true, id };
    }).pipe(Effect.uninterruptible);
  });
  /** Concurrent callers share one fetch and its committed result or failure. */
  readonly syncWithAPI = Effect.fn("repository.sync")(function* (
    this: ArticlesRepository,
    options?: SyncOptions,
  ) {
    const account = yield* this.active();
    return yield* account.sync.join(() => this.syncAccount(account, options));
  });
  readonly testConnection = Effect.gen({ self: this }, function* () {
    const api = yield* this.adapter(yield* this.active());
    yield* storageHealthy;
    return yield* api.testConnection;
  });

  readonly getAllArticles: Effect.Effect<Article[], LocalError> = Effect.gen(
    { self: this },
    function* () {
      return yield* this.articles(yield* this.active());
    },
  );

  private articles(account: Account): Effect.Effect<Article[], LocalError> {
    return Effect.gen(function* () {
      yield* storageHealthy;
      if (account.articles) return account.articles;
      const result = yield* localRead("read local articles", [account.keys.articles]);
      // A commit may have published while this read was pending; it is newer.
      account.articles ??= (result[account.keys.articles] as Article[] | undefined) || [];
      return account.articles;
    });
  }

  /**
   * Serializes one local change: reads the committed articles, persists the change, then
   * publishes it. A failed write latches fatal storage, which fails queued and later commits.
   */
  private commit(
    account: Account,
    remote: Remote | undefined,
    change: Mutation | ((articles: Article[]) => Effect.Effect<Article[], LocalError>),
    after?: Effect.Effect<void, FatalStorageFailure>,
  ): Effect.Effect<void, LocalError> {
    const [outcome, operation] = remote ?? [undefined, undefined];
    const work = Effect.gen({ self: this }, function* () {
      // A retired account's late work must not reach storage the next account may share.
      if (account.retired) return;
      yield* storageHealthyAfter(outcome, operation);
      const articles = yield* this.articles(account);
      const next =
        typeof change === "function"
          ? yield* change(articles)
          : yield* this.apply(account, articles, change);
      if (!articlesEqual(articles, next)) {
        yield* storagePromise(() =>
          setLocal("persist articles", { [account.keys.articles]: next }, outcome, operation),
        );
        yield* storageHealthyAfter(outcome, operation);
        account.articles = next;
      }
      if (typeof change !== "function" && account.sync.running) account.pending.push(change);
      if (after) yield* after;
    });
    return Semaphore.withPermit(this.commits, work).pipe(Effect.uninterruptible);
  }

  private apply(
    account: Account,
    articles: Article[],
    mutation: Mutation,
  ): Effect.Effect<Article[], FatalStorageFailure> {
    return Effect.gen({ self: this }, function* () {
      if (mutation.type === "delete") {
        // Ids are compared as strings: storage may hold entries written by versions that used the
        // other type, and bookmark ids are strings (GUIDs on Firefox, decimal strings on Chromium).
        const target = String(mutation.id);
        return articles.filter((a) => String(a.id) !== target);
      }
      if (articles.length === 0) {
        return [mutation.article];
      }
      if (!account.settings.normalizeOnCompare) {
        const existing =
          articles === account.articles
            ? this.getRawIndex(account, articles).get(mutation.article.url)
            : articles.find(
                (a) => a.url === mutation.article.url || a.givenUrl === mutation.article.url,
              );
        if (existing) {
          if (
            String(existing.id) === String(mutation.article.id) &&
            mutation.article.givenUrl &&
            existing.givenUrl !== mutation.article.givenUrl
          ) {
            return articles.map((a) => (a === existing ? mutation.article : a));
          }
          logger.debug("Article already exists in cache, skipping add:", mutation.article.url);
          return articles;
        }
        return [mutation.article, ...articles];
      }
      let targetCanonicals = yield* this.resolveArticleCanonicals(mutation.article);
      let genAfterTarget = getCanonicalCacheGeneration();
      const byCanonical = yield* this.getCanonicalIndex(account, articles);
      if (getCanonicalCacheGeneration() !== genAfterTarget) {
        targetCanonicals = yield* this.resolveArticleCanonicals(mutation.article);
        genAfterTarget = getCanonicalCacheGeneration();
      }
      const existing = byCanonical.get(targetCanonicals.url);
      if (existing) {
        if (
          String(existing.id) === String(mutation.article.id) &&
          mutation.article.givenUrl &&
          existing.givenUrl !== mutation.article.givenUrl
        ) {
          this.getKnownCanonicals(account, genAfterTarget).set(mutation.article, targetCanonicals);
          return articles.map((a) => (a === existing ? mutation.article : a));
        }
        logger.debug("Article already exists in cache, skipping add:", mutation.article.url);
        return articles;
      }
      this.getKnownCanonicals(account, genAfterTarget).set(mutation.article, targetCanonicals);
      return [mutation.article, ...articles];
    });
  }

  private syncAccount(
    account: Account,
    options?: SyncOptions,
  ): Effect.Effect<Synced, AdapterError> {
    return Effect.gen({ self: this }, function* () {
      account.pending = [];
      const api = yield* this.adapter(account);
      const timestamps = yield* this.timestamps(account);
      const cachedArticles = yield* this.articles(account);
      const syncOptions: SyncOptions = {
        ...options,
        lastSyncTimestamp: timestamps.last ?? undefined,
        lastFullSyncTimestamp: timestamps.full ?? undefined,
        isBrowserIdle: options?.isBrowserIdle ?? (yield* Effect.promise(() => isBrowserIdle())),
        maxKnownNumericId: options?.maxKnownNumericId ?? maxNumericIdOf(cachedArticles),
      };
      logger.info("Starting cache sync with API", {
        providedMode: options?.mode,
        lastSync: timestamps.last,
        lastFullSync: timestamps.full ? new Date(timestamps.full).toISOString() : null,
        isBrowserIdle: syncOptions.isBrowserIdle,
        maxKnownNumericId: syncOptions.maxKnownNumericId,
      });

      const fetchStartedAt = new Date().toISOString();
      yield* storageHealthy;
      const syncResult = yield* api.sync(syncOptions);
      yield* storageHealthy;
      logger.debug(
        `Synced ${syncResult.articles.length} articles from API using ${syncResult.mode} mode`,
        { metadata: syncResult.metadata },
      );
      const fetchedWithGen = yield* Effect.forEach(syncResult.articles, (article) =>
        Effect.gen(function* () {
          const canonicalUrl = yield* canonical(article.url);
          const canonicalGivenUrl =
            article.givenUrl && article.givenUrl !== article.url
              ? yield* canonical(article.givenUrl)
              : undefined;
          const generation = getCanonicalCacheGeneration();
          const url = account.settings.normalizeOnSave ? canonicalUrl : article.url;
          const hasDistinctGivenUrl = Boolean(article.givenUrl && article.givenUrl !== url);
          const hasDistinctCanonicalGivenUrl = Boolean(
            canonicalGivenUrl && canonicalGivenUrl !== canonicalUrl,
          );
          const normalized: Article = {
            ...article,
            url,
            canonicalUrl,
            ...(hasDistinctCanonicalGivenUrl ? { canonicalGivenUrl } : {}),
          };
          if (!hasDistinctGivenUrl) delete normalized.givenUrl;
          if (!hasDistinctCanonicalGivenUrl) delete normalized.canonicalGivenUrl;
          const canonicals: KnownArticleCanonicals = hasDistinctCanonicalGivenUrl
            ? { url: canonicalUrl, givenUrl: canonicalGivenUrl }
            : { url: canonicalUrl };
          return { article: normalized, canonicals, generation };
        }),
      );
      const finalGeneration = getCanonicalCacheGeneration();
      const known = this.getKnownCanonicals(account, finalGeneration);
      const fetched = fetchedWithGen.map(({ article, canonicals, generation }) => {
        if (generation === finalGeneration) {
          known.set(article, canonicals);
        }
        return article;
      });

      yield* this.commit(
        account,
        ["succeeded", "sync"],
        (articles) =>
          Effect.gen({ self: this }, function* () {
            let next =
              syncResult.mode === "overwrite"
                ? fetched
                : merge(account.settings, articles, fetched);
            // Mutations committed after the fetch started may be missing from the snapshot.
            if (account.pending.length > 0)
              logger.info(`Re-applying ${account.pending.length} pending operations after sync`);
            for (const mutation of account.pending)
              next = yield* this.apply(account, next, mutation);
            account.pending = [];
            return next;
          }),
        this.storeTimestamps(account, {
          full: syncResult.mode === "overwrite" ? Date.parse(fetchStartedAt) : timestamps.full,
          last: fetchStartedAt,
        }),
      );
      const items = yield* this.articles(account);
      return { items, total: items.length, syncResult };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => logger.error("Error syncing cache with API:", error)),
      ),
    );
  }

  private getRawIndex(account: Account, articles: Article[]): Map<string, Article> {
    if (account.rawIndex && account.rawIndex.articles === articles) {
      return account.rawIndex.byUrl;
    }
    const byUrl = new Map<string, Article>();
    for (const article of articles) {
      if (!byUrl.has(article.url)) {
        byUrl.set(article.url, article);
      }
    }
    for (const article of articles) {
      if (article.givenUrl && !byUrl.has(article.givenUrl)) {
        byUrl.set(article.givenUrl, article);
      }
    }
    if (articles === account.articles) {
      account.rawIndex = { articles, byUrl };
    }
    return byUrl;
  }

  private getKnownCanonicals(
    account: Account,
    generation: number,
  ): WeakMap<Article, KnownArticleCanonicals> {
    if (!account.knownCanonicals || account.knownCanonicals.generation !== generation) {
      account.knownCanonicals = { generation, byArticle: new WeakMap() };
    }
    return account.knownCanonicals.byArticle;
  }

  private resolveArticleCanonicals(
    article: Article,
    known?: WeakMap<Article, KnownArticleCanonicals>,
    buildGen?: number,
  ): Effect.Effect<KnownArticleCanonicals, FatalStorageFailure> {
    return Effect.gen(function* () {
      const cached = known?.get(article);
      if (cached !== undefined) return cached;
      const url = yield* canonical(article.url);
      const givenUrl =
        article.givenUrl && article.givenUrl !== article.url
          ? yield* canonical(article.givenUrl)
          : undefined;
      const entry: KnownArticleCanonicals =
        givenUrl && givenUrl !== url ? { url, givenUrl } : { url };
      if (known && buildGen !== undefined && getCanonicalCacheGeneration() === buildGen) {
        known.set(article, entry);
      }
      return entry;
    });
  }

  private getCanonicalIndex(
    account: Account,
    articles: Article[],
  ): Effect.Effect<Map<string, Article>, FatalStorageFailure> {
    return Effect.gen({ self: this }, function* () {
      const currentGen = getCanonicalCacheGeneration();
      if (
        account.canonicalIndex &&
        account.canonicalIndex.articles === articles &&
        account.canonicalIndex.generation === currentGen
      ) {
        return account.canonicalIndex.byCanonical;
      }

      // Retry once if a concurrent filter-list refresh bumps the generation mid-build.
      for (let attempt = 0; attempt < 2; attempt++) {
        const buildGen = getCanonicalCacheGeneration();
        const known = this.getKnownCanonicals(account, buildGen);
        const byCanonical = new Map<string, Article>();
        const resolved: { article: Article; canonicals: KnownArticleCanonicals }[] = [];

        for (const article of articles) {
          const canonicals = yield* this.resolveArticleCanonicals(article, known, buildGen);
          resolved.push({ article, canonicals });
          if (!byCanonical.has(canonicals.url)) {
            byCanonical.set(canonicals.url, article);
          }
        }
        for (const { article, canonicals } of resolved) {
          if (canonicals.givenUrl && !byCanonical.has(canonicals.givenUrl)) {
            byCanonical.set(canonicals.givenUrl, article);
          }
        }

        if (getCanonicalCacheGeneration() === buildGen) {
          if (articles === account.articles) {
            account.canonicalIndex = { articles, generation: buildGen, byCanonical };
          }
          return byCanonical;
        }
      }

      const byCanonical = new Map<string, Article>();
      const resolved: { article: Article; canonicals: KnownArticleCanonicals }[] = [];
      for (const article of articles) {
        const canonicals = yield* this.resolveArticleCanonicals(article);
        resolved.push({ article, canonicals });
        if (!byCanonical.has(canonicals.url)) {
          byCanonical.set(canonicals.url, article);
        }
      }
      for (const { article, canonicals } of resolved) {
        if (canonicals.givenUrl && !byCanonical.has(canonicals.givenUrl)) {
          byCanonical.set(canonicals.givenUrl, article);
        }
      }
      return byCanonical;
    });
  }

  private findSavedInAccount(
    account: Account,
    url: string,
  ): Effect.Effect<{ existing: Article | undefined; canonicalUrl?: string }, LocalError> {
    return Effect.gen({ self: this }, function* () {
      const articles = yield* this.articles(account);
      if (articles.length === 0) return { existing: undefined };
      if (!account.settings.normalizeOnCompare) {
        return { existing: this.getRawIndex(account, articles).get(url) };
      }
      let targetCanonical = yield* canonical(url);
      const genAfterTarget = getCanonicalCacheGeneration();
      const byCanonical = yield* this.getCanonicalIndex(account, articles);
      if (getCanonicalCacheGeneration() !== genAfterTarget) {
        targetCanonical = yield* canonical(url);
      }
      return { existing: byCanonical.get(targetCanonical), canonicalUrl: targetCanonical };
    });
  }

  readonly findSaved = Effect.fn("repository.findSaved")(function* (
    this: ArticlesRepository,
    url: string,
  ) {
    const account = yield* this.active();
    return (yield* this.findSavedInAccount(account, url)).existing;
  });

  private filterBySearch(articles: Article[], search?: string): Article[] {
    if (!search) {
      return articles;
    }
    const searchTerm = search.toLowerCase().trim();
    const searchWords = searchTerm.split(/\s+/);
    return articles.filter((article) => {
      const title = article.title?.toLowerCase() || "";
      const url = article.url?.toLowerCase() || "";
      const givenUrl = article.givenUrl?.toLowerCase() || "";
      return searchWords.every(
        (word) => title.includes(word) || url.includes(word) || givenUrl.includes(word),
      );
    });
  }

  readonly getRecentArticles = Effect.fn("repository.recent")(function* (
    this: ArticlesRepository,
    page: number = 1,
    perPage: number = 30,
    search?: string,
  ) {
    const filtered = this.filterBySearch(yield* this.getAllArticles, search);
    const articles = [...filtered].sort((a, b) => {
      if (b.created_at > a.created_at) return 1;
      if (b.created_at < a.created_at) return -1;
      return 0;
    });
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
  });

  private timestamps(
    account: Account,
  ): Effect.Effect<NonNullable<Account["timestamps"]>, LocalError> {
    return Effect.gen(function* () {
      if (account.timestamps) return account.timestamps;
      const { keys } = account;
      const result = yield* localRead("read sync metadata", [
        keys.lastFullSyncTimestamp,
        keys.lastSyncTimestamp,
      ]);
      account.timestamps ??= {
        full: (result[keys.lastFullSyncTimestamp] as number | undefined) || null,
        last: (result[keys.lastSyncTimestamp] as string | undefined) || null,
      };
      return account.timestamps;
    });
  }

  private storeTimestamps(
    account: Account,
    timestamps: NonNullable<Account["timestamps"]>,
  ): Effect.Effect<void, FatalStorageFailure> {
    return storagePromise(() =>
      setLocal(
        "persist sync timestamps",
        {
          [account.keys.lastFullSyncTimestamp]: timestamps.full,
          [account.keys.lastSyncTimestamp]: timestamps.last,
        },
        "succeeded",
        "sync",
      ),
    ).pipe(
      Effect.andThen(storageHealthy),
      Effect.tap(() => Effect.sync(() => (account.timestamps = timestamps))),
    );
  }
}

function articlesEqual(a: readonly Article[], b: readonly Article[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.url !== y.url ||
      x.givenUrl !== y.givenUrl ||
      x.canonicalUrl !== y.canonicalUrl ||
      x.canonicalGivenUrl !== y.canonicalGivenUrl ||
      x.title !== y.title ||
      x.created_at !== y.created_at
    ) {
      return false;
    }
  }
  return true;
}

function maxNumericIdOf(articles: readonly Article[]): number | undefined {
  let max: number | undefined;
  for (const article of articles) {
    let numeric: number | undefined;
    if (typeof article.id === "number") {
      numeric = article.id;
    } else if (/^\d+$/.test(article.id)) {
      numeric = Number(article.id);
    }
    if (numeric !== undefined && Number.isSafeInteger(numeric) && numeric > 0) {
      if (max === undefined || numeric > max) max = numeric;
    }
  }
  return max;
}

function merge(settings: Settings, existingArticles: Article[], newArticles: Article[]): Article[] {
  const compareKeyOf = (article: Article): string =>
    settings.normalizeOnCompare ? article.canonicalUrl || article.url : article.url;
  const existingMap = new Map<string, Article>();
  const existingCanonicalMap = new Map<string, Article>();

  for (const article of existingArticles) {
    const id = String(article.id);
    const compareKey = compareKeyOf(article);
    const existingByCanonical = existingCanonicalMap.get(compareKey);
    if (existingByCanonical && String(existingByCanonical.id) !== id) {
      existingMap.delete(String(existingByCanonical.id));
    }
    existingMap.set(id, article);
    existingCanonicalMap.set(compareKey, article);
  }

  for (const newArticle of newArticles) {
    const newId = String(newArticle.id);
    const compareKey = compareKeyOf(newArticle);

    const existingById = existingMap.get(newId);
    if (existingById) {
      const oldCompareKey = compareKeyOf(existingById);
      if (
        oldCompareKey !== compareKey &&
        existingCanonicalMap.get(oldCompareKey) === existingById
      ) {
        existingCanonicalMap.delete(oldCompareKey);
      }
    }

    const existingByCanonical = existingCanonicalMap.get(compareKey);
    if (existingByCanonical && String(existingByCanonical.id) !== newId) {
      existingMap.delete(String(existingByCanonical.id));
    }

    existingMap.set(newId, newArticle);
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
