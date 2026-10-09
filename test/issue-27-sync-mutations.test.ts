import { bookmarks, mockReadyAdapter } from "./fixtures/ready-adapter-mock";
import { beforeEach, afterEach, expect, test, mock, spyOn } from "bun:test";
import { Effect } from "effect";
import {
  IncompleteSnapshotFailure,
  OperationInterrupted,
  runOperation,
} from "../src/background/api/effect-adapter";
import type { Article } from "../src/types/common";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

const keys = getAccountStorageKeys({ ...DEFAULT_SETTINGS, backend: "bookmarks" } as Parameters<
  ArticlesRepository["initialize"]
>[0]);

beforeEach(() => {
  mockReadyAdapter();
});

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

afterEach(async () => {
  mock.restore();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function article(id: number | string, url: string, title = url): Article {
  return { id, url, title, created_at: "2026-01-01T00:00:00.000Z" };
}

function makeBrowserMock(options?: { failWrites?: Error }) {
  const storage: Record<string, unknown> = {};
  const writeOrder: string[] = [];
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: async (keys: string[]) => {
            const out: Record<string, unknown> = {};
            for (const key of keys) {
              if (key in storage) out[key] = storage[key];
            }
            return out;
          },
          set: async (values: Record<string, unknown>) => {
            if (options?.failWrites) throw options.failWrites;
            Object.assign(storage, values);
            for (const key of Object.keys(values)) writeOrder.push(key);
          },
          remove: async (keys: string[]) => {
            for (const key of keys) delete storage[key];
          },
        },
      },
      bookmarks: {
        getTree: async () => [{ id: "folder-1", title: "Pouch", children: [] }],
        getChildren: async () => [],
        create: async (details: { title: string; url: string }) => ({
          id: "new-ID_1",
          title: details.title,
          url: details.url,
          dateAdded: 1700000030000,
        }),
        remove: async () => {},
      },
      idle: { queryState: async () => "active" },
    },
  });
  return { storage, writeOrder };
}

function makeRepository(): Promise<ArticlesRepository> {
  const repository = new ArticlesRepository();
  repository.initialize({
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig: {},
  } as Parameters<ArticlesRepository["initialize"]>[0]);
  return Promise.resolve(repository);
}

test("save during overwrite sync retains the real server ID after replay", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred<ReturnType<typeof Object>>();
  const synced = [article("s1", "https://example.com/a"), article("s2", "https://example.com/b")];
  spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: synced,
      mode: "overwrite" as const,
    })),
  );
  const saved = article(42, "https://example.com/new");
  spyOn(bookmarks, "saveArticle").mockResolvedValue(saved);

  const syncPromise = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  const savePromise = runOperation(repository.saveArticle({
    url: "https://example.com/new",
    title: "New",
  }));

  syncGate.resolve();
  await syncPromise;
  const savedArticle = await savePromise;

  expect(savedArticle.id).toBe(42);
  const articles = await runOperation(repository.getAllArticles);
  expect(articles.map((a) => a.id).sort()).toEqual([42, "s1", "s2"].sort());
});

test("two concurrent saves during sync both survive overwrite replay", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(bookmarks, "saveArticle")
    .mockResolvedValueOnce(article(7, "https://example.com/one"))
    .mockResolvedValueOnce(article(8, "https://example.com/two"));

  const syncPromise = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  const saveOne = runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" }));
  const saveTwo = runOperation(repository.saveArticle({ url: "https://example.com/two", title: "Two" }));

  syncGate.resolve();
  await syncPromise;
  await Promise.all([saveOne, saveTwo]);

  const ids = (await runOperation(repository.getAllArticles)).map((a) => a.id);
  expect(ids).toContain(7);
  expect(ids).toContain(8);
  expect(ids).toContain("s1");
});

test("delete during sync replay removes the article the sync re-fetched", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a"), article("s2", "https://example.com/b")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(bookmarks, "deleteArticle").mockResolvedValue(undefined);

  const syncPromise = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  const deletePromise = runOperation(repository.deleteArticle("s2"));
  syncGate.resolve();

  await syncPromise;
  await deletePromise;

  const ids = (await runOperation(repository.getAllArticles)).map((a) => a.id);
  expect(ids).toEqual(["s1"]);
});

test("failed sync fetch propagates the error and preserves cached data", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository();
  storage[keys.articles] = [article("s1", "https://example.com/a")];

  spyOn(bookmarks, "sync").mockRejectedValue(new Error("Network down"));

  await expect(runOperation(repository.syncWithAPI({ mode: "overwrite" }))).rejects.toThrow("Network down");

  expect(await runOperation(repository.getAllArticles)).toEqual([article("s1", "https://example.com/a")]);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();
});

test("concurrent cache mutations commit in order without losing writes", async () => {
  const { storage } = makeBrowserMock();
  storage[keys.articles] = [article("a1", "https://example.com/a")];
  const repository = await makeRepository();

  const saveGate = deferred<{ id: number; url: string; title: string; created_at: string }>();
  const saveSpy = spyOn(bookmarks, "saveArticle").mockReturnValue(
    saveGate.promise.then(() => article(10, "https://example.com/saved")),
  );
  spyOn(bookmarks, "sync").mockResolvedValue({
    articles: [article("m1", "https://example.com/merged")],
    mode: "update",
  });

  const savePromise = runOperation(
    repository.saveArticle({ url: "https://example.com/saved", title: "Saved" }),
  );
  const mergePromise = runOperation(repository.syncWithAPI({ mode: "update" }));

  saveGate.resolve({ id: 10, url: "https://example.com/saved", title: "Saved", created_at: "" });
  await mergePromise;
  await savePromise;

  expect(saveSpy).toHaveBeenCalled();
  const ids = (await runOperation(repository.getAllArticles)).map((a) => a.id);
  expect(ids).toHaveLength(3);
  expect(storage[keys.articles]).toEqual(await runOperation(repository.getAllArticles));
});

test("merge collapses duplicate canonical URLs instead of keeping both", async () => {
  const { storage } = makeBrowserMock();
  storage[keys.articles] = [article("a1", "https://example.com/a")];
  const repository = new ArticlesRepository();
  repository.initialize({
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig: {},
    normalizeOnCompare: true,
  } as Parameters<ArticlesRepository["initialize"]>[0]);
  spyOn(bookmarks, "sync").mockResolvedValue({
    articles: [article("a2", "https://example.com/a"), article("a3", "https://example.com/a")],
    mode: "update",
  });

  await runOperation(repository.syncWithAPI({ mode: "update" }));

  const articles = await runOperation(repository.getAllArticles);
  expect(articles).toHaveLength(1);
  expect(articles[0]?.id).toBe("a1");
});

test("concurrent sync callers share one fetch and both see the final cache", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  const syncSpy = spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );

  const first = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  const second = runOperation(repository.syncWithAPI());

  syncGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(firstResult.items.map((a) => a.id)).toEqual(["s1"]);
  expect(secondResult.items.map((a) => a.id)).toEqual(["s1"]);
});

test("sync returns the final stored collection, including articles saved mid-sync", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(11, "https://example.com/mid"),
  );

  const syncPromise = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  const savePromise = runOperation(repository.saveArticle({ url: "https://example.com/mid", title: "Mid" }));
  syncGate.resolve();

  const result = await syncPromise;
  await savePromise;

  const storedIds = (await runOperation(repository.getAllArticles)).map((a) => a.id);
  expect(result.items.map((a) => a.id).sort()).toEqual(storedIds.sort());
});

test("joined sync callers share the original failure and keep the prior snapshot", async () => {
  const { storage, writeOrder } = makeBrowserMock();
  const repository = await makeRepository();
  storage[keys.articles] = [article("s1", "https://example.com/a")];

  const fetchGate = deferred();
  const failure = new IncompleteSnapshotFailure("sync");
  let fetches = 0;
  const factory = await import("../src/utils/adapter-factory");
  spyOn(factory, "getReadyAdapter").mockReturnValue(
    Effect.succeed({
      sync: () =>
        Effect.promise(() => fetchGate.promise).pipe(
          Effect.andThen(
            ++fetches === 1
              ? Effect.fail(failure)
              : Effect.succeed({
                  articles: [article("s2", "https://example.com/b")],
                  mode: "overwrite",
                }),
          ),
        ),
    }) as never,
  );

  const first = runOperation(repository.syncWithAPI({ mode: "overwrite" })).catch((error: unknown) => error);
  const second = runOperation(repository.syncWithAPI()).catch((error: unknown) => error);
  fetchGate.resolve();

  const [firstError, secondError] = await Promise.all([first, second]);
  expect(firstError).toBeInstanceOf(IncompleteSnapshotFailure);
  expect(secondError).toBe(firstError);
  expect(fetches).toBe(1);
  expect(writeOrder).toEqual([]);
  expect(await runOperation(repository.getAllArticles)).toEqual([article("s1", "https://example.com/a")]);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();

  // The failed run is not cached: the next caller fetches again.
  expect((await runOperation(repository.syncWithAPI())).items.map((a) => a.id)).toEqual(["s2"]);
  expect(fetches).toBe(2);
});

test("cancelling one sync waiter leaves the shared sync running for the other", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository();

  const fetchGate = deferred();
  const syncSpy = spyOn(bookmarks, "sync").mockReturnValue(
    fetchGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );
  const controller = new AbortController();
  const cancelled = runOperation(repository.syncWithAPI(), controller.signal).catch(
    (error: unknown) => error,
  );
  const kept = runOperation(repository.syncWithAPI());
  controller.abort();
  expect(await cancelled).toBeInstanceOf(OperationInterrupted);

  fetchGate.resolve();
  expect((await kept).items.map((a) => a.id)).toEqual(["s1"]);
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(storage[keys.articles]).toEqual([
    { ...article("s1", "https://example.com/a"), canonicalUrl: "https://example.com/a" },
  ]);
  expect(storage[keys.lastSyncTimestamp]).toBeDefined();
});

test("the shared sync is detached from the caller that started it", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository();
  const fetchGate = deferred();
  const fetchStarted = deferred();
  const syncSpy = spyOn(bookmarks, "sync").mockImplementation(() => {
    fetchStarted.resolve();
    return fetchGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    }));
  });
  // The starting fiber ends while the fetch is pending; the sync fiber is not its child.
  const controller = new AbortController();
  const starter = runOperation(repository.syncWithAPI(), controller.signal).catch(
    (error: unknown) => error,
  );
  await fetchStarted.promise;
  controller.abort();
  expect(await starter).toBeInstanceOf(OperationInterrupted);

  const joined = runOperation(repository.syncWithAPI());
  fetchGate.resolve();
  expect((await joined).items.map((a) => a.id)).toEqual(["s1"]);
  expect(syncSpy).toHaveBeenCalledTimes(1);
  expect(storage[keys.lastSyncTimestamp]).toBeDefined();
});

test("cancelling one initialization waiter leaves adapter acquisition shared", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const initGate = deferred();
  const initSpy = spyOn(bookmarks, "initialize").mockReturnValue(initGate.promise);
  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(5, "https://example.com/kept"),
  );
  const controller = new AbortController();
  const cancelled = runOperation(
    repository.saveArticle({ url: "https://example.com/cancelled", title: "Cancelled" }),
    controller.signal,
  ).catch((error: unknown) => error);
  const kept = runOperation(repository.saveArticle({ url: "https://example.com/kept", title: "Kept" }));
  controller.abort();
  expect(await cancelled).toBeInstanceOf(OperationInterrupted);

  initGate.resolve();
  expect((await kept).id).toBe(5);
  expect(initSpy).toHaveBeenCalledTimes(1);
});

test("failed cache persistence propagates and keeps prior cache intact", async () => {
  const failure = new Error("storage quota exceeded");
  makeBrowserMock({ failWrites: failure });
  const repository = await makeRepository();

  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(9, "https://example.com/x"),
  );

  await expect(
    runOperation(repository.saveArticle({ url: "https://example.com/x", title: "X" })),
  ).rejects.toThrow("Pouch stopped: persist articles failed");
  // The cache is published only after a successful write.
  expect(Reflect.get(repository, "account").articles).toEqual([]);
  await expect(
    runOperation(repository.saveArticle({ url: "https://example.com/y", title: "Y" })),
  ).rejects.toThrow("Pouch stopped");
  expect(Reflect.get(repository, "account").articles).toEqual([]);
});
