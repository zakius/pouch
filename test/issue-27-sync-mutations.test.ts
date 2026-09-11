import { afterEach, expect, test, mock, spyOn } from "bun:test";
import type { Article } from "../src/types/common";
import { BookmarksAdapter } from "../src/background/api/adapters/bookmarks-adapter";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

const keys = getAccountStorageKeys({ ...DEFAULT_SETTINGS, backend: "bookmarks" } as Parameters<
  ArticlesRepository["initialize"]
>[0]);

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
  return repository
    .initialize({
      ...DEFAULT_SETTINGS,
      backend: "bookmarks",
      apiConfig: {},
    } as Parameters<ArticlesRepository["initialize"]>[0])
    .then(() => repository);
}

test("save during overwrite sync retains the real server ID after replay", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred<ReturnType<typeof Object>>();
  const synced = [article("s1", "https://example.com/a"), article("s2", "https://example.com/b")];
  spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: synced,
      mode: "overwrite" as const,
    })),
  );
  const saved = article(42, "https://example.com/new");
  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(saved);

  const syncPromise = repository.syncWithAPI({ mode: "overwrite" });
  const savePromise = repository.saveArticle({
    url: "https://example.com/new",
    title: "New",
  });

  syncGate.resolve();
  await syncPromise;
  const savedArticle = await savePromise;

  expect(savedArticle.id).toBe(42);
  const articles = await repository.getAllArticles();
  expect(articles.map((a) => a.id).sort()).toEqual([42, "s1", "s2"].sort());
});

test("two concurrent saves during sync both survive overwrite replay", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(BookmarksAdapter.prototype, "saveArticle")
    .mockResolvedValueOnce(article(7, "https://example.com/one"))
    .mockResolvedValueOnce(article(8, "https://example.com/two"));

  const syncPromise = repository.syncWithAPI({ mode: "overwrite" });
  const saveOne = repository.saveArticle({ url: "https://example.com/one", title: "One" });
  const saveTwo = repository.saveArticle({ url: "https://example.com/two", title: "Two" });

  syncGate.resolve();
  await syncPromise;
  await Promise.all([saveOne, saveTwo]);

  const ids = (await repository.getAllArticles()).map((a) => a.id);
  expect(ids).toContain(7);
  expect(ids).toContain(8);
  expect(ids).toContain("s1");
});

test("delete during sync replay removes the article the sync re-fetched", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a"), article("s2", "https://example.com/b")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(BookmarksAdapter.prototype, "deleteArticle").mockResolvedValue(undefined);

  const syncPromise = repository.syncWithAPI({ mode: "overwrite" });
  const deletePromise = repository.deleteArticle("s2");
  syncGate.resolve();

  await syncPromise;
  await deletePromise;

  const ids = (await repository.getAllArticles()).map((a) => a.id);
  expect(ids).toEqual(["s1"]);
});

test("failed sync fetch propagates the error and preserves cached data", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository();
  storage[keys.articles] = [article("s1", "https://example.com/a")];

  spyOn(BookmarksAdapter.prototype, "sync").mockRejectedValue(new Error("Network down"));

  await expect(repository.syncWithAPI({ mode: "overwrite" })).rejects.toThrow("Network down");

  expect(await repository.getAllArticles()).toEqual([article("s1", "https://example.com/a")]);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();
});

test("failed cache persistence propagates and keeps prior cache intact", async () => {
  const failure = new Error("storage quota exceeded");
  makeBrowserMock({ failWrites: failure });
  const repository = await makeRepository();

  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(
    article(9, "https://example.com/x"),
  );

  await expect(
    repository.saveArticle({ url: "https://example.com/x", title: "X" }),
  ).rejects.toThrow("storage quota exceeded");
});

test("concurrent cache mutations commit in order without losing writes", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository();

  await repository.updateArticles([article("a1", "https://example.com/a")]);

  const saveGate = deferred<{ id: number; url: string; title: string; created_at: string }>();
  const saveSpy = spyOn(BookmarksAdapter.prototype, "saveArticle").mockReturnValue(
    saveGate.promise.then(() => article(10, "https://example.com/saved")),
  );

  const savePromise = repository.saveArticle({ url: "https://example.com/saved", title: "Saved" });
  const mergePromise = repository.mergeArticles([article("m1", "https://example.com/merged")]);

  saveGate.resolve({ id: 10, url: "https://example.com/saved", title: "Saved", created_at: "" });
  await mergePromise;
  await savePromise;

  expect(saveSpy).toHaveBeenCalled();
  const ids = (await repository.getAllArticles()).map((a) => a.id);
  expect(ids).toHaveLength(3);
  expect(storage[keys.articles]).toEqual(await repository.getAllArticles());
});

test("merge collapses duplicate canonical URLs instead of keeping both", async () => {
  makeBrowserMock();
  const repository = new ArticlesRepository();
  await repository.initialize({
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig: {},
    normalizeOnCompare: true,
  } as Parameters<ArticlesRepository["initialize"]>[0]);

  await repository.updateArticles([article("a1", "https://example.com/a")]);
  await repository.mergeArticles([
    { ...article("a2", "https://example.com/a?utm=1"), canonicalUrl: "https://example.com/a" },
    { ...article("a3", "https://example.com/a?utm=2"), canonicalUrl: "https://example.com/a" },
  ]);

  const articles = await repository.getAllArticles();
  expect(articles).toHaveLength(1);
  expect(articles[0]?.id).toBe("a1");
});

test("concurrent sync callers share one fetch and both see the final cache", async () => {
  makeBrowserMock();
  const repository = await makeRepository();

  const syncGate = deferred();
  const syncSpy = spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );

  const first = repository.syncWithAPI({ mode: "overwrite" });
  const second = repository.syncWithAPI();

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
  spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("s1", "https://example.com/a")],
      mode: "overwrite" as const,
    })),
  );
  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(
    article(11, "https://example.com/mid"),
  );

  const syncPromise = repository.syncWithAPI({ mode: "overwrite" });
  const savePromise = repository.saveArticle({ url: "https://example.com/mid", title: "Mid" });
  syncGate.resolve();

  const result = await syncPromise;
  await savePromise;

  const storedIds = (await repository.getAllArticles()).map((a) => a.id);
  expect(result.items.map((a) => a.id).sort()).toEqual(storedIds.sort());
});
