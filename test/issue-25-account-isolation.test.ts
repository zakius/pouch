import { mockReadyAdapter } from "./fixtures/ready-adapter-mock";
import { beforeEach, afterEach, beforeEach, expect, test, mock, spyOn } from "bun:test";
import type { Article } from "../src/types/common";
import { BookmarksAdapter } from "../src/background/api/adapters/bookmarks-adapter";
import {
  ArticlesRepository,
  getAccountStorageKeys,
  removeStaleAccountKeys,
} from "../src/background/articles-repository";
import { TokenManager, tokenManager } from "../src/background/token-manager";
import { getAdapter } from "../src/utils/adapter-factory";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

beforeEach(() => { mockReadyAdapter(); });

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

beforeEach(async () => {
  makeBrowserMock();
  await tokenManager.clearAllTokens();
});

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

function makeBrowserMock() {
  const storage: Record<string, unknown> = {};
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: async (keys: string | string[] | null) => {
            if (keys === null) return { ...storage };
            const names = typeof keys === "string" ? [keys] : keys;
            const out: Record<string, unknown> = {};
            for (const key of names) {
              if (key in storage) out[key] = storage[key];
            }
            return out;
          },
          set: async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          },
          remove: async (keys: string | string[]) => {
            for (const key of typeof keys === "string" ? [keys] : keys) delete storage[key];
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
      alarms: {
        clear: async () => {},
        create: async () => {},
        onAlarm: { addListener: () => {} },
      },
    },
  });
  return { storage };
}

type RepoSettings = Parameters<ArticlesRepository["initialize"]>[0];

function makeSettings(apiConfig: Record<string, string>): RepoSettings {
  return {
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig,
  } as RepoSettings;
}

async function makeRepository(apiConfig: Record<string, string>): Promise<ArticlesRepository> {
  const repository = new ArticlesRepository();
  await repository.initialize(makeSettings(apiConfig));
  return repository;
}

test("getAdapter returns a fresh adapter instance on every call", () => {
  const first = getAdapter("bookmarks");
  const second = getAdapter("bookmarks");
  expect(first).not.toBe(second);
});

test("a retired account's late sync never writes into the new account's storage", async () => {
  const { storage } = makeBrowserMock();
  const oldRepo = await makeRepository({ account: "a" });
  const newKeys = getAccountStorageKeys(makeSettings({ account: "b" }));

  const syncGate = deferred();
  spyOn(BookmarksAdapter.prototype, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [article("old-1", "https://old.example/a"), article(42, "https://shared.example/x")],
      mode: "overwrite" as const,
    })),
  );

  const oldSync = oldRepo.syncWithAPI({ mode: "overwrite" });

  const newRepo = await makeRepository({ account: "b" });
  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(
    article(42, "https://shared.example/x"),
  );
  await newRepo.saveArticle({ url: "https://shared.example/x", title: "Shared" });

  syncGate.resolve();
  await oldSync;

  const newArticles = (storage[newKeys.articles] as Article[]) ?? [];
  expect(newArticles.map((a) => a.id)).toEqual([42]);
  expect(storage[newKeys.lastSyncTimestamp]).toBeUndefined();
  expect(storage[newKeys.lastFullSyncTimestamp]).toBeUndefined();
  const oldArticles = await oldRepo.getAllArticles();
  expect(oldArticles.map((a) => a.id).sort()).toEqual([42, "old-1"].sort());
});

test("accounts within one backend keep isolated articles and timestamps", async () => {
  const { storage } = makeBrowserMock();
  const repoA = await makeRepository({ account: "a" });
  const keysB = getAccountStorageKeys(makeSettings({ account: "b" }));

  await repoA.updateArticles([article("a-1", "https://a.example/1")]);

  const repoB = await makeRepository({ account: "b" });
  expect(await repoB.getAllArticles()).toEqual([]);

  spyOn(BookmarksAdapter.prototype, "sync").mockResolvedValue({
    articles: [article("b-1", "https://b.example/1")],
    mode: "overwrite" as const,
  });
  await repoB.syncWithAPI({ mode: "overwrite" });

  expect(storage[keysB.lastSyncTimestamp]).toBeDefined();
  expect(await repoA.getAllArticles()).toEqual([article("a-1", "https://a.example/1")]);
  const articlesA = getAccountStorageKeys(makeSettings({ account: "a" }));
  expect(storage[articlesA.lastSyncTimestamp]).toBeUndefined();
});

test("deleting a shared article ID only affects the active account", async () => {
  const { storage } = makeBrowserMock();
  const repoA = await makeRepository({ account: "a" });
  const keysB = getAccountStorageKeys(makeSettings({ account: "b" }));
  storage[keysB.articles] = [article(42, "https://shared.example/x")];

  spyOn(BookmarksAdapter.prototype, "deleteArticle").mockResolvedValue(undefined);
  await repoA.deleteArticle(42);

  expect((storage[keysB.articles] as Article[]).map((a) => a.id)).toEqual([42]);
});

test("concurrent repository operations coalesce adapter initialization", async () => {
  makeBrowserMock();
  const repository = await makeRepository({ account: "a" });

  const initGate = deferred();
  const initSpy = spyOn(BookmarksAdapter.prototype, "initialize").mockReturnValue(
    initGate.promise as unknown as Promise<void>,
  );
  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(
    article(7, "https://example.com/one"),
  );

  const first = repository.saveArticle({ url: "https://example.com/one", title: "One" });
  const second = repository.saveArticle({ url: "https://example.com/one", title: "One" });
  initGate.resolve();

  await Promise.all([first, second]);
  expect(initSpy).toHaveBeenCalledTimes(1);
});

test("a failed adapter initialization rejects all concurrent callers and allows retry", async () => {
  makeBrowserMock();
  const repository = await makeRepository({ account: "a" });

  spyOn(BookmarksAdapter.prototype, "initialize").mockRejectedValueOnce(new Error("boom"));
  spyOn(BookmarksAdapter.prototype, "saveArticle").mockResolvedValue(
    article(7, "https://example.com/one"),
  );

  const first = repository.saveArticle({ url: "https://example.com/one", title: "One" });
  const second = repository.saveArticle({ url: "https://example.com/one", title: "One" });
  const firstOutcome = await first.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  const secondOutcome = await second.then(
    () => "resolved",
    (error: Error) => error.message,
  );
  expect(firstOutcome).toContain("boom");
  expect(secondOutcome).toContain("boom");

  await expect(
    repository.saveArticle({ url: "https://example.com/one", title: "One" }),
  ).resolves.toMatchObject({ id: 7 });
});

test("test connection uses isolated tokens while a real request for the same backend runs", async () => {
  const { storage } = makeBrowserMock();
  Object.assign(browser, { permissions: { contains: async () => true } });
  const draftRequestStarted = deferred();
  const releaseDraftRequest = deferred();
  const authHeaders: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    authHeaders.push(auth);
    if (auth === "Bearer draft-token") {
      draftRequestStarted.resolve();
      await releaseDraftRequest.promise;
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const karakeep = (token: string) =>
    ({
      ...DEFAULT_SETTINGS,
      backend: "karakeep",
      apiConfig: { url: "https://karakeep.example", token },
    }) as RepoSettings;

  const activeRepo = new ArticlesRepository();
  await activeRepo.initialize(karakeep("active-token"));
  expect(await activeRepo.testConnection()).toBe(true);

  const testRepo = new ArticlesRepository(new TokenManager({ persist: false }));
  await testRepo.initialize(karakeep("draft-token"));
  const testResult = testRepo.testConnection();
  await draftRequestStarted.promise;

  await tokenManager.storeToken("karakeep", {
    accessToken: "rotated-token",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: Date.now() + 60 * 60 * 1000,
    issuedAt: Date.now(),
    refreshCount: 0,
  });
  expect(await activeRepo.testConnection()).toBe(true);

  releaseDraftRequest.resolve();
  expect(await testResult).toBe(true);

  expect(authHeaders).toEqual([
    "Bearer active-token",
    "Bearer draft-token",
    "Bearer rotated-token",
  ]);
  expect(await tokenManager.getAccessToken("karakeep")).toBe("rotated-token");
  const persisted = storage.api_tokens as [string, { accessToken: string }][];
  expect(persisted).toEqual([
    ["karakeep", expect.objectContaining({ accessToken: "rotated-token" })],
  ]);
});

test("Settings change removes other accounts' cached keys and legacy keys only", async () => {
  const current = getAccountStorageKeys(DEFAULT_SETTINGS);
  const other = getAccountStorageKeys({ ...DEFAULT_SETTINGS, backend: "karakeep" });
  const initial: Record<string, unknown> = {
    [current.articles]: [],
    [current.lastSyncTimestamp]: "2026-01-01",
    [current.lastFullSyncTimestamp]: 1,
    [other.articles]: [],
    [other.lastSyncTimestamp]: "2026-01-01",
    [other.lastFullSyncTimestamp]: 1,
    articles: [],
    lastSyncTimestamp: "2026-01-01",
    lastFullSyncTimestamp: 1,
    api_tokens: [],
    filterListCache: "x",
  };
  await browser.storage.local.set(initial);

  await removeStaleAccountKeys(DEFAULT_SETTINGS);

  expect(Object.keys(await browser.storage.local.get(null)).sort()).toEqual(
    [...Object.values(current), "api_tokens", "filterListCache"].sort(),
  );
});
