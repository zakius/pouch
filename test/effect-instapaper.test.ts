import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createInstapaperAdapter } from "../src/background/api/adapters/instapaper-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS, getSettings } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { InstapaperSettings } from "../src/utils/settings-schemas";

const settings: InstapaperSettings = {
  ...DEFAULT_SETTINGS,
  backend: "instapaper",
  apiConfig: {
    token: "v2-bearer-token",
  },
};

const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

const bookmark = (
  id: number,
  overrides: Partial<{
    url: string | null;
    title: string | null;
    time: number | null;
    archived: boolean;
  }> = {},
) => ({
  id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  time: 1700000000 + id,
  archived: false,
  ...overrides,
});

const listResponse = (
  bookmarks: ReturnType<typeof bookmark>[],
  total = bookmarks.length,
  deletedIds?: number[],
) => ({
  bookmarks,
  total,
  ...(deletedIds !== undefined ? { deleted_ids: deletedIds } : {}),
});

const v2Error = (code: number, message = "SECRET provider message") => ({
  error: { code, message },
});

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
let storage: Record<string, unknown>;
let syncStore: Record<string, unknown>;
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
  syncStore = {};
  rejectReads = false;
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => true },
      storage: {
        sync: {
          get: async (keys: string | string[]) =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys])
                .filter((key) => key in syncStore)
                .map((key) => [key, syncStore[key]]),
            ),
        },
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

const api = (
  handler: (call: number, url: URL, init?: RequestInit) => Response | Promise<Response>,
) => {
  let calls = 0;
  return spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    handler(++calls, new URL(String(input)), init),
  );
};

const acquire = (
  overrideSettings: InstapaperSettings = settings,
  tokens = new TokenManager({ persist: false }),
) => runOperation(createInstapaperAdapter(overrideSettings, tokens));

const failure = async (operation: Effect.Effect<unknown, unknown>, signal?: AbortSignal) => {
  try {
    await runOperation(operation, signal);
    throw new Error("Expected failure");
  } catch (error) {
    return errorResponse(error);
  }
};

test("acquires with Bearer token without calling xAuth or storing in TokenManager", async () => {
  const fetchMock = api(() => json(listResponse([bookmark(1)])));
  const tokens = new TokenManager({ persist: false });
  const adapter = await acquire(
    { ...settings, apiConfig: { token: "  trimmed-v2-token  " } },
    tokens,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(tokens.getTokenMetadata("instapaper")).toBeNull();
  expect(storage.api_tokens).toBeUndefined();

  expect(await runOperation(adapter.testConnection)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe("https://www.instapaper.com/api/2/bookmarks?limit=1");
  expect(init?.method).toBeUndefined();
  const headers = new Headers(init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer trimmed-v2-token");
  expect(headers.get("Accept")).toBe("application/json");
});

test("rejects missing, whitespace, or non-ASCII tokens with ConfigurationFailure before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const tokens = new TokenManager({ persist: false });
  for (const apiConfig of [
    {},
    { token: "" },
    { token: "   " },
    { token: "bad token" },
    { token: "bad\ntoken" },
    { token: "bad\rtoken" },
    { token: "tökén" },
  ]) {
    const result = await failure(createInstapaperAdapter({ ...settings, apiConfig }, tokens));
    expect(result).toMatchObject({
      code: "ConfigurationFailure",
      details: { operation: "instapaper.acquire" },
    });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("legacy v1 settings seamlessly reuse stored oauth_token from TokenManager as v2 Bearer token", async () => {
  const legacySettings: InstapaperSettings = {
    ...DEFAULT_SETTINGS,
    backend: "instapaper",
    apiConfig: {
      consumerKey: "legacy-ck",
      consumerSecret: "legacy-cs",
      username: "legacy-user",
      password: "legacy-password",
    },
  };
  Object.assign(syncStore, legacySettings);
  expect(await getSettings()).toEqual(legacySettings);

  const tokens = new TokenManager({ persist: false });
  await runOperation(
    tokens.storeToken("instapaper", {
      accessToken: "legacy-oauth-token-123",
      refreshToken: "",
      tokenType: "OAuth",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      issuedAt: Date.now(),
      refreshCount: 0,
    }),
  );

  const fetchMock = api(() => json(listResponse([bookmark(1)])));
  const adapter = await acquire(legacySettings, tokens);
  expect(await runOperation(adapter.testConnection)).toBe(true);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe(
    "Bearer legacy-oauth-token-123",
  );

  // Explicit v2 token takes precedence over any legacy token still in TokenManager.
  const v2Adapter = await acquire(settings, tokens);
  expect(await runOperation(v2Adapter.testConnection)).toBe(true);
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Authorization")).toBe(
    "Bearer v2-bearer-token",
  );
});

test("legacy v1 settings fail with ConfigurationFailure if TokenManager has no valid oauth_token", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const legacySettings: InstapaperSettings = {
    ...DEFAULT_SETTINGS,
    backend: "instapaper",
    apiConfig: {
      consumerKey: "legacy-ck",
      consumerSecret: "legacy-cs",
      username: "legacy-user",
      password: "legacy-password",
    },
  };

  // Empty TokenManager
  const emptyTokens = new TokenManager({ persist: false });
  expect(await failure(createInstapaperAdapter(legacySettings, emptyTokens))).toMatchObject({
    code: "ConfigurationFailure",
    details: { operation: "instapaper.acquire" },
  });

  // Invalid non-ASCII stored legacy token
  const badTokens = new TokenManager({ persist: false });
  await runOperation(
    badTokens.storeToken("instapaper", {
      accessToken: "invalid\ntoken",
      refreshToken: "",
      tokenType: "OAuth",
      expiresAt: Date.now() + 60_000,
      issuedAt: Date.now(),
      refreshCount: 0,
    }),
  );
  expect(await failure(createInstapaperAdapter(legacySettings, badTokens))).toMatchObject({
    code: "ConfigurationFailure",
    details: { operation: "instapaper.acquire" },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("saveArticle sends JSON POST /api/2/bookmarks with canonicalize, omits blank titles, and applies nullable fallbacks", async () => {
  const fetchMock = api((call) => {
    if (call === 1) {
      return json(
        bookmark(10, {
          url: "https://en.wikipedia.org/wiki/Foo_(bar)",
          title: "Foo Title",
        }),
      );
    }
    return json(bookmark(11, { url: null, title: null, time: null }));
  });
  const adapter = await acquire();

  const first = await runOperation(
    adapter.saveArticle({
      url: "https://en.wikipedia.org/wiki/Foo_(bar)",
      title: "Foo Title",
    }),
  );
  expect(first).toMatchObject({
    id: 10,
    url: "https://en.wikipedia.org/wiki/Foo_(bar)",
    title: "Foo Title",
  });
  const [url1, init1] = fetchMock.mock.calls[0];
  expect(String(url1)).toBe("https://www.instapaper.com/api/2/bookmarks");
  expect(init1?.method).toBe("POST");
  expect(new Headers(init1?.headers).get("Content-Type")).toBe("application/json");
  expect(new Headers(init1?.headers).get("Accept")).toBe("application/json");
  expect(JSON.parse(String(init1?.body))).toEqual({
    url: "https://en.wikipedia.org/wiki/Foo_(bar)",
    canonicalize: false,
    title: "Foo Title",
  });

  const second = await runOperation(
    adapter.saveArticle({
      url: "https://example.com/redirect",
      title: "   ",
      resolveFinalUrl: true,
    }),
  );
  expect(second).toMatchObject({
    id: 11,
    url: "https://example.com/redirect",
    title: "https://example.com/redirect",
  });
  const [, init2] = fetchMock.mock.calls[1];
  expect(JSON.parse(String(init2?.body))).toEqual({
    url: "https://example.com/redirect",
    canonicalize: true,
  });
});

test("deleteArticle sends DELETE /api/2/bookmarks/{id}, accepts 200 empty, 204, and idempotent 404", async () => {
  const fetchMock = api((call) => {
    if (call === 1) return new Response("", { status: 200 });
    if (call === 2) return new Response(null, { status: 204 });
    if (call === 3) return new Response("", { status: 404 });
    return json(v2Error(404, "Bookmark not found"), 404);
  });
  const adapter = await acquire();

  await runOperation(adapter.deleteArticle(7));
  await runOperation(adapter.deleteArticle("8"));
  await runOperation(adapter.deleteArticle(9));
  await runOperation(adapter.deleteArticle("10/extra"));

  expect(fetchMock.mock.calls.map(([u, init]) => [String(u), init?.method])).toEqual([
    ["https://www.instapaper.com/api/2/bookmarks/7", "DELETE"],
    ["https://www.instapaper.com/api/2/bookmarks/8", "DELETE"],
    ["https://www.instapaper.com/api/2/bookmarks/9", "DELETE"],
    ["https://www.instapaper.com/api/2/bookmarks/10%2Fextra", "DELETE"],
  ]);
});

test("sync full overwrite handles empty account and multi-page offset/total pagination past 500 bookmarks", async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => bookmark(i + 1));
  const page2 = Array.from({ length: 250 }, (_, i) => bookmark(501 + i));
  const fetchMock = api((call, url) => {
    if (call === 1) return json(listResponse([], 0));
    if (url.searchParams.get("offset") === "0") return json(listResponse(page1, 750));
    if (url.searchParams.get("offset") === "500") return json(listResponse(page2, 750));
    throw new Error(`Unexpected offset: ${url.toString()}`);
  });
  const adapter = await acquire();

  const empty = await runOperation(adapter.sync({ mode: "overwrite" }));
  expect(empty.articles).toEqual([]);
  expect(empty.mode).toBe("overwrite");
  expect(empty.deletedIds).toBeUndefined();
  expect(empty.metadata?.apiVersion).toBe("2.0");

  const multi = await runOperation(adapter.sync({ mode: "overwrite" }));
  expect(multi.articles).toHaveLength(750);
  expect(multi.articles[0].id).toBe(1);
  expect(multi.articles[749].id).toBe(750);
  expect(multi.mode).toBe("overwrite");
  expect(multi.deletedIds).toBeUndefined();

  const [, req1, req2] = fetchMock.mock.calls;
  expect(new URL(String(req1[0])).searchParams.toString()).toBe("limit=500&offset=0&section=home");
  expect(new URL(String(req2[0])).searchParams.toString()).toBe(
    "limit=500&offset=500&section=home",
  );
});

test("sync dedupes duplicate bookmark IDs, skips null-URL private items, and accepts extra OpenAPI fields", async () => {
  api(() =>
    json({
      bookmarks: [
        {
          id: 10,
          url: "https://example.com/null-title",
          title: null,
          description: "Opening text",
          image: null,
          progress: { percent: 0.5, timestamp: 1700000010 },
          liked: false,
          archived: false,
          time: 1700000000,
          pubtime: null,
          author: "Author",
          folder_id: null,
          tags: [{ id: 1, name: "tech" }],
          private_source: null,
          category: 0,
        },
        bookmark(10, { url: "https://example.com/dup-ignored", title: "Dup" }),
        bookmark(11, { url: "https://example.com/blank-title", title: "   " }),
        bookmark(12, { url: null, title: "Private note without URL" }),
      ],
      total: 4,
    }),
  );
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => ({ id: a.id, title: a.title, url: a.url }))).toEqual([
    { id: 10, title: "https://example.com/null-title", url: "https://example.com/null-title" },
    { id: 11, title: "https://example.com/blank-title", url: "https://example.com/blank-title" },
  ]);
});

test("sync fails with IncompleteSnapshotFailure if pagination repeats without advancing or returns empty before total", async () => {
  // Repeating the same page when offset < total
  api(() => json(listResponse([bookmark(1), bookmark(2)], 5)));
  expect(await failure((await acquire()).sync({ mode: "overwrite" }))).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "instapaper.sync" },
  });

  // Empty page when total > 0
  api(() => json(listResponse([], 10)));
  expect(await failure((await acquire()).sync({ mode: "overwrite" }))).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "instapaper.sync" },
  });
});

test("sync selects hybrid mode based on timestamps and browser idle state", async () => {
  const fetchMock = api(() => json(listResponse([], 0)));
  const adapter = await acquire();
  const now = Date.now();
  const recentIso = new Date(now - 10 * 60 * 1000).toISOString();

  // First sync -> overwrite
  const first = await runOperation(adapter.sync());
  expect(first.mode).toBe("overwrite");
  expect(first.metadata?.syncDecision?.reason).toBe("first_sync");

  // Recent full sync -> incremental update with since (120s overlap, no section)
  const inc = await runOperation(
    adapter.sync({
      lastSyncTimestamp: recentIso,
      lastFullSyncTimestamp: now - 3600_000,
      isBrowserIdle: false,
    }),
  );
  expect(inc.mode).toBe("update");
  expect(inc.metadata?.syncDecision?.reason).toBe("incremental");
  const incUrl = new URL(String(fetchMock.mock.calls[1][0]));
  expect(incUrl.searchParams.has("section")).toBe(false);
  expect(incUrl.searchParams.get("since")).toBe(
    String(Math.floor(Date.parse(recentIso) / 1000) - 120),
  );

  // >= 24h while active -> still incremental
  const active24h = await runOperation(
    adapter.sync({
      lastSyncTimestamp: recentIso,
      lastFullSyncTimestamp: now - 25 * 3600_000,
      isBrowserIdle: false,
    }),
  );
  expect(active24h.mode).toBe("update");

  // >= 24h while idle -> overwrite
  const idle24h = await runOperation(
    adapter.sync({
      lastSyncTimestamp: recentIso,
      lastFullSyncTimestamp: now - 25 * 3600_000,
      isBrowserIdle: true,
    }),
  );
  expect(idle24h.mode).toBe("overwrite");
  expect(idle24h.metadata?.syncDecision?.reason).toBe("24h_idle");

  // >= 48h overdue even when active -> overwrite
  const overdue48h = await runOperation(
    adapter.sync({
      lastSyncTimestamp: recentIso,
      lastFullSyncTimestamp: now - 49 * 3600_000,
      isBrowserIdle: false,
    }),
  );
  expect(overdue48h.mode).toBe("overwrite");
  expect(overdue48h.metadata?.syncDecision?.reason).toBe("48h_overdue");

  // Explicit update without lastSyncTimestamp -> falls back to overwrite
  const missingLast = await runOperation(adapter.sync({ mode: "update" }));
  expect(missingLast.mode).toBe("overwrite");
  expect(missingLast.metadata?.syncDecision?.reason).toBe("missing_last_sync");
});

test("incremental since sync paginates by bookmarks + deleted_ids and reconciles deletions and archives in ArticlesRepository", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  const now = Date.now();
  storage[keys.articles] = [
    { id: 1, title: "Keep", url: "https://example.com/1", created_at: "2026-01-01T00:00:00.000Z" },
    {
      id: 2,
      title: "Delete me",
      url: "https://example.com/2",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 3,
      title: "Archive me",
      url: "https://example.com/3",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  storage[keys.lastSyncTimestamp] = new Date(now - 600_000).toISOString();
  storage[keys.lastFullSyncTimestamp] = now - 3600_000;

  // Multi-page since response: page 1 has 400 bookmarks + 100 deleted_ids (500 combined);
  // page 2 has 1 archived bookmark + 1 new bookmark + 1 deleted_id.
  const page1Bookmarks = Array.from({ length: 400 }, (_, i) => bookmark(1000 + i));
  const page1Deleted = Array.from({ length: 100 }, (_, i) => 5000 + i);
  const fetchMock = api((_call, url) => {
    const offset = url.searchParams.get("offset");
    expect(url.searchParams.has("since")).toBe(true);
    if (offset === "0") {
      return json(listResponse(page1Bookmarks, 503, page1Deleted));
    }
    if (offset === "500") {
      return json(
        listResponse(
          [bookmark(3, { archived: true }), bookmark(4, { archived: false, title: "New 4" })],
          503,
          [2],
        ),
      );
    }
    throw new Error(`Unexpected offset: ${offset}`);
  });

  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  const synced = await runOperation(repo.syncWithAPI());

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(synced.syncResult.mode).toBe("update");
  expect(synced.syncResult.deletedIds).toContain(2);
  expect(synced.syncResult.deletedIds).toContain(3);

  const ids = new Set(synced.items.map((a) => a.id));
  expect(ids.has(1)).toBe(true);
  expect(ids.has(4)).toBe(true);
  expect(ids.has(1000)).toBe(true);
  expect(ids.has(1399)).toBe(true);
  expect(ids.has(2)).toBe(false);
  expect(ids.has(3)).toBe(false);
  expect(synced.items).toHaveLength(402);
});

test("cancellation aborts an in-flight sync request", async () => {
  const seen = deferred<void>();
  let signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    signal = init?.signal ?? undefined;
    seen.resolve();
    return new Promise<Response>(() => {});
  });
  const adapter = await acquire();
  const controller = new AbortController();
  const result = failure(adapter.sync(), controller.signal);
  await seen.promise;
  controller.abort();
  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(signal?.aborted).toBe(true);
});

for (const [label, payload] of [
  ["empty array", []],
  ["plain object", {}],
  ["missing id", { url: "https://example.com/1", title: "No id" }],
] as const) {
  test(`saveArticle rejects unexpected 200 OK JSON (${label}) as unknown outcome without retrying`, async () => {
    const fetchMock = api(() => json(payload));
    const result = await failure(
      (await acquire()).saveArticle({ url: "https://example.com/1", title: "A" }),
    );
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: {
        operation: "instapaper.save",
        remoteOperation: "save",
        remoteOutcome: "unknown",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

for (const [name, response] of [
  ["a 400 v2 error envelope", () => json(v2Error(400, "SECRET invalid URL"), 400)],
  ["a 200 v2 error envelope", () => json(v2Error(400, "SECRET invalid URL"), 200)],
] as const) {
  test(`save maps ${name} to a safe ProviderFailure without leaking message or claiming unknown outcome`, async () => {
    const fetchMock = api(() => response());
    const result = await failure((await acquire()).saveArticle({ url: "https://a", title: "a" }));
    expect(result).toMatchObject({
      code: "ProviderFailure",
      details: { operation: "instapaper.save", providerCode: 400 },
    });
    expect(result.details).not.toHaveProperty("remoteOutcome");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

for (const status of [401, 403] as const) {
  test(`HTTP ${status} fails as CredentialsFailure without exposing provider message`, async () => {
    api(() => json(v2Error(status, "SECRET token detail"), status));
    const result = await failure((await acquire()).testConnection);
    expect(result).toMatchObject({
      code: "CredentialsFailure",
      details: { operation: "instapaper.testConnection" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

for (const operation of ["save", "delete", "sync"] as const) {
  test(`${operation} retries on HTTP 429 rate limit and succeeds`, async () => {
    const fetchMock = api((call) =>
      call === 1
        ? json(v2Error(429, "SECRET rate limit"), 429, { "Retry-After": "0" })
        : operation === "save"
          ? json(bookmark(1))
          : operation === "delete"
            ? new Response("", { status: 200 })
            : json(listResponse([bookmark(1)])),
    );
    const adapter = await acquire();
    await runOperation(
      operation === "save"
        ? adapter.saveArticle({ url: "https://a", title: "a" })
        : operation === "delete"
          ? adapter.deleteArticle(1)
          : adapter.sync(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
}

test("a persistent 429 rate limit fails as a definite RateLimitFailure", async () => {
  const fetchMock = api(() => json(v2Error(429, "SECRET rate limit"), 429));
  const pending = (await acquire()).saveArticle({ url: "https://a", title: "a" });
  const flush = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(pending));
      for (const delayMs of [1000, 2000, 4000]) {
        yield* flush();
        yield* TestClock.adjust(delayMs);
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  const result = errorResponse(error);
  expect(result).toMatchObject({
    code: "RateLimitFailure",
    error: "The server rate limit is reached. Wait and try again later.",
    details: { operation: "instapaper.save" },
  });
  expect(result.details).not.toHaveProperty("remoteOutcome");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

for (const kind of ["network", "server", "provider-server"] as const) {
  for (const operation of ["save", "delete"] as const) {
    test(`${operation} with unknown ${kind} outcome is never repeated`, async () => {
      const fetchMock = api(() => {
        if (kind === "network") throw new TypeError("SECRET request payload");
        return kind === "server"
          ? json({}, 503)
          : json(v2Error(500, "SECRET server error"), 500);
      });
      const adapter = await acquire();
      const result = await failure(
        operation === "save"
          ? adapter.saveArticle({ url: "https://a", title: "a" })
          : adapter.deleteArticle(1),
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

test("repository keeps the previous cache when sync fails with an invalid response or incomplete snapshot", async () => {
  const keys = getAccountStorageKeys(settings);
  const previous = [{ id: 9, title: "Kept", url: "https://kept.example", created_at: "2026" }];
  storage[keys.articles] = previous;
  api(() => json({ bookmarks: "SECRET" }));
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  const result = await runOperation(repo.syncWithAPI()).catch((error: unknown) =>
    errorResponse(error),
  );
  expect(result).toMatchObject({ code: "InvalidResponseFailure" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(storage[keys.articles]).toEqual(previous);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();
  expect(await runOperation(repo.getAllArticles)).toEqual(previous);
});

test("repository save, delete, and sync commit Instapaper v2 outcomes to the account cache", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  const fetchMock = api((_call, _url, init) => {
    if (init?.method === "POST") return json(bookmark(3));
    if (init?.method === "DELETE") return new Response("", { status: 200 });
    return json(listResponse([bookmark(1), bookmark(2)]));
  });
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);

  expect((await runOperation(repo.syncWithAPI())).items.map((a) => a.id)).toEqual([1, 2]);
  await runOperation(
    repo.saveArticle({ url: "https://example.com/3", title: "", resolveFinalUrl: true }),
  );
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([3, 1, 2]);
  const saveCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(String(saveCall[1]?.body))).toEqual({
    url: "https://example.com/3",
    canonicalize: true,
  });

  await runOperation(repo.deleteArticle(1));
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([3, 2]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api(() =>
      operation === "save" ? json(bookmark(1)) : new Response("", { status: 200 }),
    );
    const repo = new ArticlesRepository(new TokenManager({ persist: false }));
    await repo.initialize(settings);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}
