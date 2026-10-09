import { bookmarks, mockReadyAdapter } from "./fixtures/ready-adapter-mock";
import { runOperation } from "../src/background/api/effect-adapter";
import { beforeEach, afterEach, expect, test, mock, spyOn } from "bun:test";
import type { Article } from "../src/types/common";
import {
  ArticlesRepository,
  getAccountStorageKeys,
  removeStaleAccountKeys,
} from "../src/background/articles-repository";
import { TokenManager, tokenManager } from "../src/background/token-manager";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

beforeEach(() => {
  mockReadyAdapter();
});

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

beforeEach(async () => {
  makeBrowserMock();
  await runOperation(tokenManager.clearToken("wallabag"));
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

test("a retired account's late sync never writes into the new account's storage", async () => {
  const { storage } = makeBrowserMock();
  const oldRepo = await makeRepository({ account: "a" });
  const newKeys = getAccountStorageKeys(makeSettings({ account: "b" }));

  const syncGate = deferred();
  spyOn(bookmarks, "sync").mockReturnValue(
    syncGate.promise.then(() => ({
      articles: [
        article("old-1", "https://old.example/a"),
        article(42, "https://shared.example/x"),
      ],
      mode: "overwrite" as const,
    })),
  );

  const oldSync = runOperation(oldRepo.syncWithAPI({ mode: "overwrite" }));

  const newRepo = await makeRepository({ account: "b" });
  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(42, "https://shared.example/x"),
  );
  await runOperation(newRepo.saveArticle({ url: "https://shared.example/x", title: "Shared" }));

  syncGate.resolve();
  await oldSync;

  const newArticles = (storage[newKeys.articles] as Article[]) ?? [];
  expect(newArticles.map((a) => a.id)).toEqual([42]);
  expect(storage[newKeys.lastSyncTimestamp]).toBeUndefined();
  expect(storage[newKeys.lastFullSyncTimestamp]).toBeUndefined();
  const oldArticles = await runOperation(oldRepo.getAllArticles);
  expect(oldArticles.map((a) => a.id).sort()).toEqual([42, "old-1"].sort());
});

test("re-initializing retires late saves, deletes, and syncs of the previous account", async () => {
  const { storage } = makeBrowserMock();
  const repository = await makeRepository({ account: "a" });
  const keysA = getAccountStorageKeys(makeSettings({ account: "a" }));
  const keysB = getAccountStorageKeys(makeSettings({ account: "b" }));
  storage[keysA.articles] = [article(42, "https://shared.example/x")];
  storage[keysB.articles] = [article(42, "https://shared.example/x")];

  const remoteGate = deferred();
  let entered = 0;
  const allEntered = deferred();
  const remote = <T>(value: () => T) => {
    if (++entered === 3) allEntered.resolve();
    return remoteGate.promise.then(value);
  };
  spyOn(bookmarks, "saveArticle").mockImplementation(() =>
    remote(() => article(7, "https://late.example/save")),
  );
  spyOn(bookmarks, "deleteArticle").mockImplementation(() =>
    remote(() => undefined),
  );
  spyOn(bookmarks, "sync").mockImplementation(() =>
    remote(() => ({
      articles: [article("old-1", "https://old.example/a")],
      mode: "overwrite" as const,
    })),
  );
  const save = runOperation(repository.saveArticle({ url: "https://late.example/save", title: "Late" }));
  const remove = runOperation(repository.deleteArticle(42));
  const sync = runOperation(repository.syncWithAPI({ mode: "overwrite" }));
  await allEntered.promise;

  repository.initialize(makeSettings({ account: "b" }));
  const before = structuredClone(storage);
  remoteGate.resolve();

  expect((await save).id).toBe(7);
  expect(await remove).toEqual({ success: true, id: 42 });
  await sync;
  expect(storage).toEqual(before);
  expect((await runOperation(repository.getAllArticles)).map((a) => a.id)).toEqual([42]);
});

test("accounts within one backend keep isolated articles and timestamps", async () => {
  const { storage } = makeBrowserMock();
  storage[getAccountStorageKeys(makeSettings({ account: "a" })).articles] = [
    article("a-1", "https://a.example/1"),
  ];
  const repoA = await makeRepository({ account: "a" });
  const keysB = getAccountStorageKeys(makeSettings({ account: "b" }));

  const repoB = await makeRepository({ account: "b" });
  expect(await runOperation(repoB.getAllArticles)).toEqual([]);

  spyOn(bookmarks, "sync").mockResolvedValue({
    articles: [article("b-1", "https://b.example/1")],
    mode: "overwrite" as const,
  });
  await runOperation(repoB.syncWithAPI({ mode: "overwrite" }));

  expect(storage[keysB.lastSyncTimestamp]).toBeDefined();
  expect(await runOperation(repoA.getAllArticles)).toEqual([article("a-1", "https://a.example/1")]);
  const articlesA = getAccountStorageKeys(makeSettings({ account: "a" }));
  expect(storage[articlesA.lastSyncTimestamp]).toBeUndefined();
});

test("deleting a shared article ID only affects the active account", async () => {
  const { storage } = makeBrowserMock();
  const repoA = await makeRepository({ account: "a" });
  const keysB = getAccountStorageKeys(makeSettings({ account: "b" }));
  storage[keysB.articles] = [article(42, "https://shared.example/x")];

  spyOn(bookmarks, "deleteArticle").mockResolvedValue(undefined);
  await runOperation(repoA.deleteArticle(42));

  expect((storage[keysB.articles] as Article[]).map((a) => a.id)).toEqual([42]);
});

test("concurrent repository operations coalesce adapter initialization", async () => {
  makeBrowserMock();
  const repository = await makeRepository({ account: "a" });

  const initGate = deferred();
  const initSpy = spyOn(bookmarks, "initialize").mockReturnValue(
    initGate.promise as unknown as Promise<void>,
  );
  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(7, "https://example.com/one"),
  );

  const first = runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" }));
  const second = runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" }));
  initGate.resolve();

  await Promise.all([first, second]);
  expect(initSpy).toHaveBeenCalledTimes(1);
});

test("a failed adapter initialization rejects all concurrent callers and allows retry", async () => {
  makeBrowserMock();
  const repository = await makeRepository({ account: "a" });

  spyOn(bookmarks, "initialize").mockRejectedValueOnce(new Error("boom"));
  spyOn(bookmarks, "saveArticle").mockResolvedValue(
    article(7, "https://example.com/one"),
  );

  const first = runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" }));
  const second = runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" }));
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
    runOperation(repository.saveArticle({ url: "https://example.com/one", title: "One" })),
  ).resolves.toMatchObject({ id: 7 });
});

test("test connection uses isolated tokens while a real request for the same backend runs", async () => {
  // Wallabag is the remaining TokenManager backend; it needs the real ready-adapter factory.
  mock.restore();
  const { storage } = makeBrowserMock();
  Object.assign(browser, { permissions: { contains: async () => true } });
  const draftRequestStarted = deferred();
  const releaseDraftRequest = deferred();
  const authHeaders: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/oauth/v2/token")) {
      const password = new URLSearchParams(String(init?.body)).get("password");
      return new Response(
        JSON.stringify({
          access_token: password === "draft" ? "draft-token" : "active-token",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    }
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    authHeaders.push(auth);
    if (auth === "Bearer draft-token") {
      draftRequestStarted.resolve();
      await releaseDraftRequest.promise;
    }
    return new Response(
      JSON.stringify({ _embedded: { items: [] }, limit: 1, page: 1, pages: 0, total: 0 }),
    );
  }) as typeof fetch);
  const wallabag = (password: string) =>
    ({
      ...DEFAULT_SETTINGS,
      backend: "wallabag",
      apiConfig: {
        url: "https://wallabag.example",
        clientId: "client",
        clientSecret: "secret",
        username: "user",
        password,
      },
    }) as RepoSettings;

  const activeRepo = new ArticlesRepository();
  await activeRepo.initialize(wallabag("active"));
  expect(await runOperation(activeRepo.testConnection)).toBe(true);

  const testRepo = new ArticlesRepository(new TokenManager({ persist: false }));
  await testRepo.initialize(wallabag("draft"));
  const testResult = runOperation(testRepo.testConnection);
  await draftRequestStarted.promise;

  await runOperation(tokenManager.storeToken("wallabag", {
    accessToken: "rotated-token",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: Date.now() + 60 * 60 * 1000,
    issuedAt: Date.now(),
    refreshCount: 0,
  }));
  expect(await runOperation(activeRepo.testConnection)).toBe(true);

  releaseDraftRequest.resolve();
  expect(await testResult).toBe(true);

  expect(authHeaders).toEqual([
    "Bearer active-token",
    "Bearer draft-token",
    "Bearer rotated-token",
  ]);
  expect(await runOperation(tokenManager.getAccessToken("wallabag"))).toBe("rotated-token");
  const persisted = storage.api_tokens as [string, { accessToken: string }][];
  expect(persisted).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "rotated-token" })],
  ]);
}, 15000);

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

  await runOperation(removeStaleAccountKeys(DEFAULT_SETTINGS));

  expect(Object.keys(await browser.storage.local.get(null)).sort()).toEqual(
    [...Object.values(current), "api_tokens", "filterListCache"].sort(),
  );
});
