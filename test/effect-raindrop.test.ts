import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { createRaindropAdapter } from "../src/background/api/adapters/raindrop-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { RaindropSettings } from "../src/utils/settings-schemas";

const settings: RaindropSettings = {
  ...DEFAULT_SETTINGS,
  backend: "raindrop",
  apiConfig: { apiKey: "KEY" },
};
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const item = (id: number, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Article ${id}`,
  link: `https://example.com/${id}`,
  created: `2026-01-0${(id % 9) + 1}T00:00:00.000Z`,
  tags: [],
  ...overrides,
});
const page = (ids: number[], count?: number) => ({
  result: true,
  items: ids.map((id) => item(id)),
  ...(count === undefined ? {} : { count }),
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const urlOf = (call: [unknown, RequestInit?]) => new URL(String(call[0]));

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
let storage: Record<string, unknown>;
let rejectReads: boolean;
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  storage = {};
  rejectReads = false;
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => true },
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            if (rejectReads) throw new Error("SECRET private://payload");
            return Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]]),
            );
          },
          set: async (data: Record<string, unknown>) => {
            Object.assign(storage, data);
          },
        },
      },
      alarms: { get: async () => ({ periodInMinutes: 5 }), create: async () => {} },
      idle: { queryState: async () => "active" },
    },
  });
});
afterEach(() => {
  mock.restore();
  resetFilterListSources();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
});

const api = (handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) =>
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    handler(new URL(String(url)), init),
  );
const acquire = (config = settings) => runOperation(createRaindropAdapter(config));
const failure = async (operation: Effect.Effect<unknown, unknown>, signal?: AbortSignal) => {
  try {
    await runOperation(operation, signal);
    throw new Error("Expected failure");
  } catch (error) {
    return errorResponse(error);
  }
};
const save = async () =>
  (await acquire()).saveArticle({ url: "https://example.com/1", title: "Article 1" });

test("save posts JSON with the static key and maps the saved raindrop", async () => {
  const fetchMock = api(() => json({ result: true, item: item(1) }));
  const saved = await runOperation(await save());
  expect(saved).toEqual({
    id: 1,
    title: "Article 1",
    url: "https://example.com/1",
    created_at: item(1).created,
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe("https://api.raindrop.io/rest/v1/raindrop");
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer KEY");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(init?.body))).toEqual({
    link: "https://example.com/1",
    pleaseParse: {},
    title: "Article 1",
  });
});

test("save requests pleaseParse, omits blank title, and accepts minimal item shapes", async () => {
  const fetchMock = api(() =>
    json({
      result: true,
      item: {
        _id: 99,
        title: null,
        link: "https://example.com/99",
        created: "2026-01-02T00:00:00.000Z",
      },
    }),
  );
  const adapter = await acquire();
  const saved = await runOperation(
    adapter.saveArticle({ url: "https://example.com/99", title: "   " }),
  );
  expect(saved).toEqual({
    id: 99,
    title: "https://example.com/99",
    url: "https://example.com/99",
    created_at: "2026-01-02T00:00:00.000Z",
  });
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    link: "https://example.com/99",
    pleaseParse: {},
  });
});

test("sync accepts minimal raindrop items without tags, important, or collection", async () => {
  api(() =>
    json({
      result: true,
      items: [
        {
          _id: 10,
          link: "https://example.com/10",
          created: "2026-01-02T00:00:00.000Z",
        },
        {
          _id: 11,
          title: "   ",
          link: "https://example.com/11",
          created: "2026-01-01T00:00:00.000Z",
          tags: "unexpected-type",
          important: "unexpected-type",
          collection: null,
        },
      ],
    }),
  );
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles).toEqual([
    {
      id: 10,
      title: "https://example.com/10",
      url: "https://example.com/10",
      created_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: 11,
      title: "https://example.com/11",
      url: "https://example.com/11",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

test("delete and connection test use their endpoints", async () => {
  const fetchMock = api(() => json({ result: true, items: [] }));
  const adapter = await acquire();
  await runOperation(adapter.deleteArticle(7));
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const [remove, collections] = fetchMock.mock.calls;
  expect(String(remove[0])).toBe("https://api.raindrop.io/rest/v1/raindrop/7");
  expect(remove[1]?.method).toBe("DELETE");
  expect(String(collections[0])).toBe("https://api.raindrop.io/rest/v1/collections");
});

test("missing or header-unsafe API key fails acquisition before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  for (const apiKey of [
    "",
    "  ",
    "a\r\nX-Injected: 1",
    "token with space",
    "tok\u0080en",
    "café",
    "token🔑",
  ])
    expect(
      (await failure(createRaindropAdapter({ ...settings, apiConfig: { apiKey } }))).code,
    ).toBe("ConfigurationFailure");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the static key never enters TokenManager or refresh, even with an expired legacy token", async () => {
  const tokens = new TokenManager({ persist: false });
  const legacy = {
    accessToken: "LEGACY",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: Date.now() - 1000,
    issuedAt: 0,
    refreshCount: 0,
  };
  await runOperation(tokens.storeToken("raindrop", legacy));
  const refresh = spyOn(tokens, "refreshToken");
  const getAccessToken = spyOn(tokens, "getAccessToken");
  const fetchMock = api((url) =>
    url.pathname.endsWith("/collections") ? json({}, 401) : json(page([1], 1)),
  );
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI());
  const rejected = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(rejected).toMatchObject({ code: "CredentialsFailure" });
  await runOperation(tokens.checkAndRefreshTokens);
  expect(refresh).not.toHaveBeenCalled();
  expect(getAccessToken).not.toHaveBeenCalled();
  // A rejected key neither retries nor removes stored authentication.
  const raindrop = fetchMock.mock.calls.filter(([url]) => urlOf([url]).host === "api.raindrop.io");
  expect(raindrop).toHaveLength(2);
  expect(tokens.getTokenMetadata("raindrop")).toMatchObject({ accessToken: "LEGACY" });
  for (const [, init] of raindrop)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer KEY");
});

for (const [name, response, providerCode] of [
  [
    "a success-status result=false",
    () => json({ result: false, error: 7, errorMessage: "SECRET" }),
    7,
  ],
  [
    "a rejected result=false",
    () => json({ result: false, error: "SECRET", errorMessage: "SECRET" }, 404),
    undefined,
  ],
] as const) {
  for (const operation of ["save", "delete", "sync", "testConnection"] as const) {
    test(`${operation} maps ${name} to a safe provider rejection without claiming an outcome`, async () => {
      const fetchMock = api(() => response());
      const adapter = await acquire();
      const result = await failure(
        operation === "save"
          ? adapter.saveArticle({ url: "https://a", title: "a" })
          : operation === "delete"
            ? adapter.deleteArticle(1)
            : operation === "sync"
              ? adapter.sync()
              : adapter.testConnection,
      );
      expect(result.code).toBe("ProviderFailure");
      expect(result.details).toEqual({
        operation: `raindrop.${operation}`,
        ...(providerCode === undefined ? {} : { providerCode }),
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}

for (const [name, response] of [
  ["a success without the saved item", () => json({ result: true, SECRET: 1 })],
  ["a success-status non-JSON body", () => new Response("<html>SECRET</html>")],
] as const) {
  test(`save treats ${name} as an invalid response with unknown outcome`, async () => {
    const fetchMock = api(() => response());
    const result = await failure(await save());
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { responseKind: "response", remoteOperation: "save", remoteOutcome: "unknown" },
    });
    expect(result.error).toContain("Do not repeat it");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

test("delete without result=true is an invalid response with unknown outcome", async () => {
  api(() => json({ ok: 1 }));
  const result = await failure((await acquire()).deleteArticle(1));
  expect(result).toMatchObject({
    code: "InvalidResponseFailure",
    details: { remoteOperation: "delete", remoteOutcome: "unknown" },
  });
});

for (const body of [{ result: true, items: "SECRET" }, { items: [] }, { result: true }]) {
  test(`malformed sync page ${JSON.stringify(body)} is an invalid response`, async () => {
    api(() => json(body));
    const result = await failure((await acquire()).sync());
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { operation: "raindrop.sync" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("malformed connection response is an invalid response", async () => {
  api(() => json({ items: [] }));
  expect((await failure((await acquire()).testConnection)).code).toBe("InvalidResponseFailure");
});

for (const kind of ["network", "server", "provider-server"] as const) {
  for (const operation of ["save", "delete"] as const) {
    test(`${operation} with unknown ${kind} outcome is never repeated`, async () => {
      const fetchMock = api(() => {
        if (kind === "network") throw new TypeError("SECRET request payload");
        return kind === "server"
          ? json({}, 503)
          : json({ result: false, error: 500, errorMessage: "SECRET" }, 500);
      });
      const adapter = await acquire();
      const result = await failure(
        operation === "save"
          ? adapter.saveArticle({ url: "https://a", title: "a" })
          : adapter.deleteArticle(1),
      );
      expect(result.code).toBe(
        kind === "network"
          ? "NetworkFailure"
          : kind === "server"
            ? "HttpFailure"
            : "ProviderFailure",
      );
      expect(result.details).toMatchObject({
        remoteOperation: operation,
        remoteOutcome: "unknown",
      });
      expect(result.error).toContain("Do not repeat it");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}

test("rate-limited requests retry three times, then report the exhausted budget", async () => {
  const fetchMock = api(() => json({}, 429, { "Retry-After": "0" }));
  const result = await failure((await acquire()).sync());
  expect(result).toMatchObject({
    code: "RateLimitFailure",
    details: { operation: "raindrop.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("a rate-limited save was not processed, so it retries and succeeds once", async () => {
  let calls = 0;
  const fetchMock = api(() =>
    ++calls === 1 ? json({}, 429, { "Retry-After": "0" }) : json({ result: true, item: item(1) }),
  );
  expect((await runOperation(await save())).id).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("multi-page sync follows the first page's count and preserves order and totals", async () => {
  const fetchMock = api((url) => {
    const index = Number(url.searchParams.get("page"));
    return json(page(range(index * 50 + 1, Math.min(index * 50 + 50, 120)), 120));
  });
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual(range(1, 120));
  expect(result.mode).toBe("overwrite");
  expect(result.metadata).toMatchObject({
    totalFetched: 120,
    totalProcessed: 120,
    apiVersion: "1.0",
  });
  const urls = fetchMock.mock.calls.map(urlOf);
  expect(urls.map((url) => url.pathname)).toEqual(Array(3).fill("/rest/v1/raindrops/0"));
  expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["0", "1", "2"]);
  for (const url of urls) {
    expect(url.searchParams.get("perpage")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("-created");
    expect(url.searchParams.has("search")).toBe(false);
  }
});

test("multi-page sync continues without count, stops on short page, and deduplicates overlapping IDs", async () => {
  const fetchMock = api((url) => {
    const index = Number(url.searchParams.get("page"));
    if (index === 0) return json(page(range(1, 50)));
    // Simulate concurrent insert shifting item 50 onto page 1, with no `count` field.
    if (index === 1) return json(page([50, ...range(51, 75)]));
    return json(page([]));
  });
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual(range(1, 75));
  expect(result.metadata).toMatchObject({
    totalFetched: 75,
    totalProcessed: 75,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("multi-page sync stops cleanly after an exact page-size multiple and tolerates deletion shrinkage", async () => {
  const fetchMock = api((url) => {
    const index = Number(url.searchParams.get("page"));
    if (index === 0) return json(page(range(1, 50), 100));
    return json(page([]));
  });
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual(range(1, 50));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("repeated full page fails with IncompleteSnapshotFailure and repository preserves existing cache", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  let brokenPagination = false;
  const fetchMock = api(() => {
    if (!brokenPagination) return json(page([1, 2], 2));
    return json(page(range(1, 50), 100));
  });
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([1, 2]);

  brokenPagination = true;
  const result = await failure(repo.syncWithAPI({ mode: "overwrite" }));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "raindrop.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([1, 2]);
});

test("overwrite sync fails with IncompleteSnapshotFailure when page 0 is empty despite positive count", async () => {
  api(() => json({ result: true, items: [], count: 42 }));
  const result = await failure((await acquire()).sync({ mode: "overwrite" }));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "raindrop.sync" },
  });
});

test("update sync paginates sort=-created without search, honors 2m clock-skew overlap, and stops early", async () => {
  const lastSyncTimestamp = "2026-01-10T12:00:00.000Z";
  const page0Items = [
    ...range(1, 49).map((id) => item(id, { created: "2026-01-10T12:05:00.000Z" })),
    // Within 2-minute clock-skew overlap (11:58:30 >= 11:58:00)
    item(50, { created: "2026-01-10T11:58:30.000Z" }),
  ];
  const page1Items = [
    // Exactly at cutoff (11:58:00) -> kept
    item(51, { created: "2026-01-10T11:58:00.000Z" }),
    // Unparseable created -> kept
    item(52, { created: "not-a-timestamp" }),
    // Older than cutoff -> triggers early stop after finishing this page
    item(53, { created: "2026-01-10T11:57:59.999Z" }),
    ...range(54, 100).map((id) => item(id, { created: "2026-01-09T00:00:00.000Z" })),
  ];
  const fetchMock = api((url) => {
    const index = Number(url.searchParams.get("page"));
    if (index === 0) return json({ result: true, items: page0Items, count: 200 });
    if (index === 1) return json({ result: true, items: page1Items, count: 200 });
    throw new Error("Should have stopped early before page 2");
  });
  const adapter = await acquire();
  const update = await runOperation(adapter.sync({ mode: "update", lastSyncTimestamp }));
  expect(update.mode).toBe("update");
  expect(update.articles.map((a) => a.id)).toEqual(range(1, 52));
  expect(update.metadata?.syncDecision).toMatchObject({
    reason: "explicit_mode",
    wasFullSync: false,
  });
  const urls = fetchMock.mock.calls.map(urlOf);
  expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["0", "1"]);
  for (const url of urls) {
    expect(url.searchParams.get("sort")).toBe("-created");
    expect(url.searchParams.has("search")).toBe(false);
  }
});

test("update sync falls back to overwrite when lastSyncTimestamp is missing or invalid", async () => {
  const fetchMock = api((url) => {
    const index = Number(url.searchParams.get("page"));
    if (index === 0) return json(page(range(1, 50)));
    return json(page(range(51, 60)));
  });
  const adapter = await acquire();
  const missing = await runOperation(adapter.sync({ mode: "update" }));
  expect(missing.mode).toBe("overwrite");
  expect(missing.articles).toHaveLength(60);
  expect(missing.metadata?.syncDecision).toMatchObject({
    reason: "missing_last_sync",
    wasFullSync: true,
  });

  const invalid = await runOperation(
    adapter.sync({ mode: "update", lastSyncTimestamp: "not-a-date" }),
  );
  expect(invalid.mode).toBe("overwrite");
  expect(invalid.articles).toHaveLength(60);
  expect(invalid.metadata?.syncDecision).toMatchObject({
    reason: "missing_last_sync",
    wasFullSync: true,
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("hybrid sync mode selection follows first-sync, incremental, 24h-idle, and 48h-overdue rules", async () => {
  const now = Date.now();
  const recentIso = new Date(now).toISOString();
  api(() => json({ result: true, items: [item(1, { created: recentIso })], count: 1 }));
  const adapter = await acquire();

  const first = await runOperation(adapter.sync());
  expect(first.mode).toBe("overwrite");
  expect(first.metadata?.syncDecision).toMatchObject({
    reason: "first_sync",
    wasFullSync: true,
  });

  const missingLastSync = await runOperation(
    adapter.sync({ lastFullSyncTimestamp: now - 60_000, isBrowserIdle: false }),
  );
  expect(missingLastSync.mode).toBe("overwrite");
  expect(missingLastSync.metadata?.syncDecision).toMatchObject({
    reason: "first_sync",
    wasFullSync: true,
  });

  const recent = await runOperation(
    adapter.sync({
      lastFullSyncTimestamp: now - 60_000,
      lastSyncTimestamp: recentIso,
      isBrowserIdle: false,
    }),
  );
  expect(recent.mode).toBe("update");
  expect(recent.metadata?.syncDecision).toMatchObject({
    reason: "incremental",
    wasFullSync: false,
  });

  const active24h = await runOperation(
    adapter.sync({
      lastFullSyncTimestamp: now - 86_400_001,
      lastSyncTimestamp: recentIso,
      isBrowserIdle: false,
    }),
  );
  expect(active24h.mode).toBe("update");
  expect(active24h.metadata?.syncDecision).toMatchObject({
    reason: "incremental",
    wasFullSync: false,
  });

  const idle24h = await runOperation(
    adapter.sync({
      lastFullSyncTimestamp: now - 86_400_001,
      lastSyncTimestamp: recentIso,
      isBrowserIdle: true,
    }),
  );
  expect(idle24h.mode).toBe("overwrite");
  expect(idle24h.metadata?.syncDecision).toMatchObject({
    reason: "24h_idle",
    wasFullSync: true,
  });

  const overdue48h = await runOperation(
    adapter.sync({
      lastFullSyncTimestamp: now - 2 * 86_400_001,
      lastSyncTimestamp: recentIso,
      isBrowserIdle: false,
    }),
  );
  expect(overdue48h.mode).toBe("overwrite");
  expect(overdue48h.metadata?.syncDecision).toMatchObject({
    reason: "48h_overdue",
    wasFullSync: true,
  });
});

test("cancellation during the page wait stops pagination without another request", async () => {
  const seen = deferred<void>();
  const fetchMock = api(() => {
    seen.resolve();
    return json(page(range(1, 50), 100));
  });
  const adapter = await acquire();
  const controller = new AbortController();
  const result = failure(adapter.sync(), controller.signal);
  await seen.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancellation aborts an in-flight save and reports an unknown outcome", async () => {
  const seen = deferred<void>();
  let signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    signal = init?.signal ?? undefined;
    seen.resolve();
    return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const result = failure(await save(), controller.signal);
  await seen.promise;
  controller.abort();
  expect(await result).toMatchObject({
    code: "OPERATION_INTERRUPTED",
    details: { remoteOperation: "save", remoteOutcome: "unknown" },
  });
  expect(signal?.aborted).toBe(true);
});

test("draft connection test reports an actionable failure and stores no credentials", async () => {
  api(() => json({}, 401));
  const tokens = new TokenManager();
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  const result = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "raindrop.testConnection" },
  });
  expect(storage.api_tokens).toBeUndefined();
});

test("repository save, delete, overwrite and update sync commit Raindrop outcomes", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  let listed = [item(1), item(2)];
  api((url, init) => {
    if (init?.method === "POST") return json({ result: true, item: item(3) });
    if (init?.method === "DELETE") return json({ result: true });
    return json({ result: true, items: listed, count: listed.length });
  });
  const ids = () => (storage[keys.articles] as { id: number }[]).map((a) => a.id).sort();
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
  expect(ids()).toEqual([1, 2]);
  await runOperation(repo.saveArticle({ url: "https://example.com/3", title: "Article 3" }));
  expect(ids()).toEqual([1, 2, 3]);
  await runOperation(repo.deleteArticle(1));
  expect(ids()).toEqual([2, 3]);
  listed = [item(4, { created: new Date().toISOString() })];
  await runOperation(repo.syncWithAPI({ mode: "update" }));
  expect(ids()).toEqual([2, 3, 4]);
  await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
  expect(ids()).toEqual([4]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api(() =>
      json(operation === "save" ? { result: true, item: item(1) } : { result: true, items: [] }),
    );
    const repo = new ArticlesRepository(new TokenManager({ persist: false }));
    await repo.initialize(settings);
    await runOperation(repo.testConnection);
    rejectReads = true;
    const result = await failure(
      operation === "save"
        ? repo.saveArticle({ url: "https://example.com/1", title: "a" })
        : repo.deleteArticle(1),
    );
    expect(result.code).toBe("BrowserFailure");
    expect(result.details).toMatchObject({
      remoteOperation: operation,
      remoteOutcome: "succeeded",
    });
    expect(result.error).toContain("Do not repeat it");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== undefined)).toHaveLength(1);
  });
}

for (const operation of ["save", "delete"] as const) {
  test(`a confirmed ${operation} body with an error key is still a success`, async () => {
    const fetchMock = api(() =>
      json(
        operation === "save"
          ? { result: true, item: item(1), error: null }
          : { result: true, error: null },
      ),
    );
    const adapter = await acquire();
    if (operation === "save") expect((await runOperation(await save())).id).toBe(1);
    else await runOperation(adapter.deleteArticle(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}
