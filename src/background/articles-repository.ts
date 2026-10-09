import { Effect, Exit, Fiber, Semaphore } from "effect";
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
import { canonicalizeUrl } from "../utils/url-helpers";
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
            if (this.fiber === fiber && !(this.keepSuccess && Exit.isSuccess(exit)))
              this.fiber = undefined;
          });
          return Fiber.join(fiber);
        }),
      );
    });
  }
}

/** One account's state. A different account identity retires it, so its late work never commits. */
type Account = {
  /** Same-identity settings changes apply in place, so in-flight work still commits. */
  settings: Settings;
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
    const api = yield* this.adapter(account);
    const canonicalUrl = yield* canonical(article.url);
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
      if (next !== articles) {
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
      for (const a of articles) {
        if (yield* this.sameUrl(account, a.url, mutation.article.url)) {
          logger.debug("Article already exists in cache, skipping add:", mutation.article.url);
          return articles;
        }
      }
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
      const fetched = yield* Effect.forEach(syncResult.articles, (article) =>
        canonical(article.url).pipe(
          Effect.map((canonicalUrl) =>
            account.settings.normalizeOnSave
              ? { ...article, canonicalUrl, url: canonicalUrl }
              : { ...article, canonicalUrl },
          ),
        ),
      );

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

  private sameUrl(
    account: Account,
    a: string,
    b: string,
  ): Effect.Effect<boolean, FatalStorageFailure> {
    if (!account.settings.normalizeOnCompare) return Effect.succeed(a === b);
    return Effect.zipWith(canonical(a), canonical(b), (x, y) => x === y);
  }

  readonly findSaved = Effect.fn("repository.findSaved")(function* (
    this: ArticlesRepository,
    url: string,
  ) {
    const account = yield* this.active();
    for (const article of yield* this.articles(account)) {
      if (yield* this.sameUrl(account, article.url, url)) return article;
    }
    return undefined;
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
      return searchWords.every((word) => title.includes(word) || url.includes(word));
    });
  }

  readonly getRecentArticles = Effect.fn("repository.recent")(function* (
    this: ArticlesRepository,
    page = 1,
    perPage = 30,
    search?: string,
  ) {
    const articles = this.filterBySearch(yield* this.getAllArticles, search).sort((a, b) =>
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
