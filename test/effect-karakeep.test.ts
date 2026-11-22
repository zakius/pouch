import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createKarakeepAdapter } from "../src/background/api/adapters/karakeep-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { KarakeepSettings } from "../src/utils/settings-schemas";

const settings: KarakeepSettings = {
  ...DEFAULT_SETTINGS,
  backend: "karakeep",
  apiConfig: { url: "https://keep.example.com/api/v1/", token: "TOKEN" },
};
const base = "https://keep.example.com/api/v1/bookmarks";
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const noContent = () => new Response(null, { status: 204 });
/** Shape from Karakeep's OpenAPI `Bookmark` schema, trimmed to what Pouch reads plus noise. */
const bookmark = (id: number) => ({
  id: `bm${id}`,
  createdAt: `2026-01-0${(id % 9) + 1}T00:00:00.000Z`,
  modifiedAt: null,
  title: `Bookmark ${id}`,
  archived: false,
  favourited: false,
  taggingStatus: "success",
  userId: "user",
  tags: [{ id: "t1", name: "news", attachedBy: "human" }],
  content: { type: "link", url: `https://example.com/${id}`, title: null, htmlContent: null },
});
const page = (ids: number[], nextCursor: string | null = null) => ({
  bookmarks: ids.map(bookmark),
  nextCursor,
});
const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
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
const acquire = (config = settings) => runOperation(createKarakeepAdapter(config));
const failure = async (operation: Effect.Effect<unknown, unknown>, signal?: AbortSignal) => {
  try {
    await runOperation(operation, signal);
    throw new Error("Expected failure");
  } catch (error) {
    return errorResponse(error);
  }
};
const operations = ["save", "delete", "sync", "testConnection"] as const;
const run = async (operation: (typeof operations)[number]) => {
  const adapter = await acquire();
  return operation === "save"
    ? adapter.saveArticle({ url: "https://example.com/1", title: "Bookmark 1" })
    : operation === "delete"
      ? adapter.deleteArticle("bm1")
      : operation === "sync"
        ? adapter.sync()
        : adapter.testConnection;
};

for (const status of [201, 200]) {
  test(`save posts a link bookmark with the static token and maps a ${status} bookmark`, async () => {
    const fetchMock = api(() => json(bookmark(1), status));
    const saved = await runOperation(await run("save"));
    expect(saved).toEqual({
      id: "bm1",
      title: "Bookmark 1",
      url: "https://example.com/1",
      created_at: bookmark(1).createdAt,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(base);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer TOKEN");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "link",
      url: "https://example.com/1",
      title: "Bookmark 1",
    });
  });
}

test("delete (204) and connection test use their endpoints with the static token", async () => {
  const fetchMock = api((_url, init) => (init?.method === "DELETE" ? noContent() : json(page([]))));
  const adapter = await acquire();
  await runOperation(adapter.deleteArticle("bm/7"));
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const [remove, probe] = fetchMock.mock.calls;
  expect(String(remove[0])).toBe(`${base}/bm%2F7`);
  expect(remove[1]?.method).toBe("DELETE");
  expect(String(probe[0])).toBe(`${base}?limit=1&includeContent=false`);
  for (const [, init] of fetchMock.mock.calls)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
});

test("save omits empty or whitespace titles, truncates >1000-char titles, and falls back past empty response strings", async () => {
  const fetchMock = api((_url, init) => {
    const body = JSON.parse(String(init?.body)) as { url: string; title?: string };
    return json(
      {
        ...bookmark(1),
        title: "   ",
        content: {
          type: "link",
          url: "",
          title: body.title ? "   " : "Crawled Title",
        },
      },
      201,
    );
  });
  const adapter = await acquire();

  const bare = await runOperation(
    adapter.saveArticle({ url: "https://example.com/bare", title: "" }),
  );
  const whitespace = await runOperation(
    adapter.saveArticle({ url: "https://example.com/ws", title: "   \t\n  " }),
  );
  const longTitle = `  ${"a".repeat(1050)}  `;
  const truncated = await runOperation(
    adapter.saveArticle({ url: "https://example.com/long", title: longTitle }),
  );

  expect(bare).toMatchObject({
    id: "bm1",
    title: "Crawled Title",
    url: "https://example.com/bare",
  });
  expect(whitespace).toMatchObject({
    id: "bm1",
    title: "Crawled Title",
    url: "https://example.com/ws",
  });
  expect(truncated).toMatchObject({
    id: "bm1",
    title: "https://example.com/long",
    url: "https://example.com/long",
  });

  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies).toEqual([
    { type: "link", url: "https://example.com/bare" },
    { type: "link", url: "https://example.com/ws" },
    { type: "link", url: "https://example.com/long", title: "a".repeat(1000) },
  ]);
  expect("title" in bodies[0]).toBe(false);
  expect("title" in bodies[1]).toBe(false);
});

test("base URL normalization appends /api/v1 when absent and preserves existing /api/v1 paths", async () => {
  const cases = [
    ["https://keep.example.com", "https://keep.example.com/api/v1/bookmarks?limit=1&includeContent=false"],
    ["https://keep.example.com/", "https://keep.example.com/api/v1/bookmarks?limit=1&includeContent=false"],
    ["https://host.example/karakeep", "https://host.example/karakeep/api/v1/bookmarks?limit=1&includeContent=false"],
    ["https://host.example/karakeep/", "https://host.example/karakeep/api/v1/bookmarks?limit=1&includeContent=false"],
    ["https://keep.example.com/api/v1", "https://keep.example.com/api/v1/bookmarks?limit=1&includeContent=false"],
    [
      "https://keep.example.com/api/v1///?foo=bar#section",
      "https://keep.example.com/api/v1/bookmarks?limit=1&includeContent=false",
    ],
    [
      "https://host.example/karakeep/API/V1/?foo=bar#hash",
      "https://host.example/karakeep/API/V1/bookmarks?limit=1&includeContent=false",
    ],
    ["http://localhost:3000/subpath?x=1#y", "http://localhost:3000/subpath/api/v1/bookmarks?limit=1&includeContent=false"],
  ] as const;

  for (const [configuredUrl, expectedUrl] of cases) {
    const fetchMock = api(() => json(page([])));
    const adapter = await acquire({
      ...settings,
      apiConfig: { url: configuredUrl, token: "TOKEN" },
    });
    expect(await runOperation(adapter.testConnection)).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(expectedUrl);
    mock.restore();
  }
});

test("missing, header-unsafe, or invalid settings fail acquisition before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  for (const apiConfig of [
    { url: settings.apiConfig.url, token: "" },
    { url: settings.apiConfig.url, token: "  " },
    { url: settings.apiConfig.url, token: "a\r\nX-Injected: 1" },
    { url: "not a url", token: "TOKEN" },
    { url: "ftp://keep.example.com", token: "TOKEN" },
    { url: "javascript:alert(1)", token: "TOKEN" },
    { url: "file:///etc/passwd", token: "TOKEN" },
  ])
    expect((await failure(createKarakeepAdapter({ ...settings, apiConfig }))).code).toBe(
      "ConfigurationFailure",
    );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the static token never enters TokenManager or refresh, and rejection is never retried", async () => {
  const tokens = new TokenManager({ persist: false });
  const legacy = {
    accessToken: "LEGACY",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: Date.now() - 1000,
    issuedAt: 0,
    refreshCount: 0,
  };
  await runOperation(tokens.storeToken("karakeep", legacy));
  const refresh = spyOn(tokens, "refreshToken");
  const getAccessToken = spyOn(tokens, "getAccessToken");
  const storeToken = spyOn(tokens, "storeToken");
  // Karakeep's auth middleware answers a bad token with a text/plain 401.
  const fetchMock = api((url) =>
    url.searchParams.get("limit") === "1"
      ? new Response("Unauthorized", { status: 401 })
      : json(page([1])),
  );
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI());
  const rejected = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(rejected).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "karakeep.testConnection" },
  });
  await runOperation(tokens.checkAndRefreshTokens);
  expect(refresh).not.toHaveBeenCalled();
  expect(getAccessToken).not.toHaveBeenCalled();
  expect(storeToken).not.toHaveBeenCalled();
  const karakeep = fetchMock.mock.calls.filter(([url]) => urlOf([url]).host === "keep.example.com");
  expect(karakeep).toHaveLength(2);
  expect(tokens.getTokenMetadata("karakeep")).toMatchObject({ accessToken: "LEGACY" });
  for (const [, init] of karakeep)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
});

for (const [name, response] of [
  ["a documented error body", () => json({ code: "NOT_FOUND", message: "SECRET" }, 404)],
  [
    "a request validation rejection",
    () => json({ success: false, error: { name: "ZodError", message: "SECRET" } }, 400),
  ],
  ["a success-status error body", () => json({ code: "BAD", message: "SECRET" })],
] as const) {
  for (const operation of operations) {
    test(`${operation} maps ${name} to a safe provider rejection without claiming an outcome`, async () => {
      const fetchMock = api(() => response());
      const result = await failure(await run(operation));
      expect(result.code).toBe("ProviderFailure");
      expect(result.details).toEqual({ operation: `karakeep.${operation}` });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}

for (const operation of operations) {
  test(`${operation} keeps HTTP, schema, network, and permission failures distinct`, async () => {
    for (const [response, code] of [
      [() => new Response("SECRET Not Found", { status: 404 }), "HttpFailure"],
      [() => new Response("<html>SECRET login</html>"), "InvalidResponseFailure"],
      [
        () => {
          throw new TypeError("SECRET request payload");
        },
        "NetworkFailure",
      ],
    ] as const) {
      api(response);
      const result = await failure(await run(operation));
      expect(result.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      mock.restore();
    }
    const fetchMock = spyOn(globalThis, "fetch");
    const pending = await run(operation);
    browser.permissions.contains = async () => false;
    expect((await failure(pending)).code).toBe("PermissionFailure");
    expect(fetchMock).not.toHaveBeenCalled();
  });
}

for (const operation of operations) {
  test(`${operation} reports a timeout distinctly and aborts the request`, async () => {
    const seen = deferred<void>();
    let signal: AbortSignal | undefined;
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      seen.resolve();
      return new Promise<Response>(() => {});
    });
    const pending = await run(operation);
    const timeoutMs = operation === "testConnection" ? 10000 : 30000;
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(pending));
        yield* Effect.promise(() => seen.promise);
        yield* TestClock.adjust(timeoutMs);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(errorResponse(error)).toMatchObject({
      code: "TimeoutFailure",
      details: {
        operation: `karakeep.${operation}`,
        timeoutMs,
        ...(operation === "save" || operation === "delete"
          ? { remoteOperation: operation, remoteOutcome: "unknown" }
          : {}),
      },
    });
    expect(signal?.aborted).toBe(true);
  });
}

for (const kind of ["network", "server", "provider-server"] as const) {
  for (const operation of ["save", "delete"] as const) {
    test(`${operation} with unknown ${kind} outcome is never repeated`, async () => {
      const fetchMock = api(() => {
        if (kind === "network") throw new TypeError("SECRET request payload");
        return kind === "server"
          ? new Response("Internal server error", { status: 503 })
          : json({ code: "INTERNAL_SERVER_ERROR", message: "SECRET" }, 500);
      });
      const result = await failure(await run(operation));
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

test("save without a bookmark is an invalid response with unknown outcome", async () => {
  // The pre-migration adapter expected a numeric id; Karakeep returns string ids.
  const fetchMock = api(() => json({ id: 1, title: "SECRET", url: "https://example.com/1" }));
  const result = await failure(await run("save"));
  expect(result).toMatchObject({
    code: "InvalidResponseFailure",
    details: { responseKind: "response", remoteOperation: "save", remoteOutcome: "unknown" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

for (const body of [
  [bookmark(1)],
  { bookmarks: [bookmark(1)] },
  { bookmarks: "SECRET", nextCursor: null },
  { bookmarks: [{ id: "bm1", createdAt: "2026", title: "SECRET" }], nextCursor: null },
  { bookmarks: [], nextCursor: 5 },
]) {
  test(`malformed sync page ${JSON.stringify(body).slice(0, 60)} is an invalid response`, async () => {
    api(() => json(body));
    const result = await failure(await run("sync"));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { operation: "karakeep.sync" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("rate-limited requests retry three times, then report the exhausted budget", async () => {
  const fetchMock = api(() => new Response("Too many requests", { status: 429 }));
  const pending = await run("sync");
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
  expect(errorResponse(error)).toMatchObject({
    code: "RateLimitFailure",
    details: { operation: "karakeep.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("a rate-limited save was not processed, so it retries and succeeds once", async () => {
  let calls = 0;
  const fetchMock = api(() =>
    ++calls === 1 ? json({}, 429, { "Retry-After": "0" }) : json(bookmark(1), 201),
  );
  expect((await runOperation(await run("save"))).id).toBe("bm1");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync follows nextCursor through every page without inter-page sleep and preserves order and totals", async () => {
  const cursors = [null, "bm100_2026-01-01T00:00:00.000Z", "bm200_2026-01-02T00:00:00.000Z"];
  const fetchMock = api((url) => {
    const index = cursors.indexOf(url.searchParams.get("cursor"));
    return json(
      page(range(index * 100 + 1, Math.min((index + 1) * 100, 230)), cursors[index + 1] ?? null),
    );
  });
  const adapter = await acquire();
  // Providing TestClock without advancing it verifies pagination never sleeps between pages.
  const result = await Effect.runPromise(
    adapter.sync({ mode: "overwrite" }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.articles.map((a) => a.id)).toEqual(range(1, 230).map((id) => `bm${id}`));
  expect(result.mode).toBe("overwrite");
  expect(result.metadata).toMatchObject({ totalFetched: 230, totalProcessed: 230 });
  const urls = fetchMock.mock.calls.map(urlOf);
  expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual(cursors);
  for (const url of urls) {
    expect(url.pathname).toBe("/api/v1/bookmarks");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("includeContent")).toBe("false");
  }
});

test("sync deduplicates bookmark IDs appearing across pages", async () => {
  api((url) =>
    url.searchParams.get("cursor")
      ? json(page([2, 3]))
      : json(page([1, 2], "bm2_2026-01-03T00:00:00.000Z")),
  );
  const result = await runOperation((await acquire()).sync());
  expect(result.articles.map((a) => a.id)).toEqual(["bm1", "bm2", "bm3"]);
  expect(result.metadata).toMatchObject({ totalFetched: 3, totalProcessed: 3 });
});

test("sync maps text and asset source URLs, title fallbacks, and skips notes without a URL", async () => {
  const item = bookmark(1);
  api(() =>
    json({
      bookmarks: [
        { ...item, id: "link", title: null, content: { type: "link", url: "https://a.example/" } },
        {
          ...item,
          id: "crawled",
          title: null,
          content: { type: "link", url: "https://b.example/", title: "Crawled" },
        },
        {
          ...item,
          id: "empty-title",
          title: "",
          content: { type: "link", url: "https://d.example/", title: "From Content" },
        },
        {
          ...item,
          id: "blank-titles",
          title: "   ",
          content: { type: "link", url: "https://e.example/", title: "  " },
        },
        { ...item, id: "note", content: { type: "text", text: "SECRET", sourceUrl: null } },
        {
          ...item,
          id: "pdf",
          content: {
            type: "asset",
            assetType: "pdf",
            assetId: "x",
            sourceUrl: "https://c.example/",
          },
        },
      ],
      nextCursor: null,
    }),
  );
  const result = await runOperation((await acquire()).sync());
  expect(result.articles.map(({ id, title, url }) => ({ id, title, url }))).toEqual([
    { id: "link", title: "https://a.example/", url: "https://a.example/" },
    { id: "crawled", title: "Crawled", url: "https://b.example/" },
    { id: "empty-title", title: "From Content", url: "https://d.example/" },
    { id: "blank-titles", title: "https://e.example/", url: "https://e.example/" },
    { id: "pdf", title: "Bookmark 1", url: "https://c.example/" },
  ]);
});

test("update sync is still a complete overwrite listing without filters", async () => {
  const fetchMock = api(() => json(page([3])));
  const adapter = await acquire();
  const lastSyncTimestamp = "2023-11-14T22:13:20.999Z";
  const update = await runOperation(adapter.sync({ mode: "update", lastSyncTimestamp }));
  const full = await runOperation(adapter.sync({ mode: "overwrite", lastSyncTimestamp }));
  expect(update.mode).toBe("overwrite");
  expect(full.mode).toBe("overwrite");
  const [incremental, overwrite] = fetchMock.mock.calls.map(urlOf);
  expect(incremental.search).toBe("?limit=100&includeContent=false");
  expect(overwrite.search).toBe("?limit=100&includeContent=false");
});

test("a repeated cursor fails as an incomplete snapshot instead of looping", async () => {
  const fetchMock = api(() => json(page([1], "same_2026-01-01T00:00:00.000Z")));
  const result = await failure(await run("sync"));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "karakeep.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a cursor cycle fails as an incomplete snapshot instead of paging forever", async () => {
  const next: Record<string, string> = { "": "A", A: "B", B: "A" };
  const fetchMock = api((url) =>
    json(page([1], next[url.searchParams.get("cursor") ?? ""] ?? null)),
  );
  const result = await failure(await run("sync"));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "karakeep.sync" },
  });
  expect(fetchMock.mock.calls.map((call) => urlOf(call).searchParams.get("cursor"))).toEqual([
    null,
    "A",
    "B",
  ]);
});

test("cancellation aborts an in-flight second page fetch and stops pagination", async () => {
  const pageTwoStarted = deferred<void>();
  let pageTwoSignal: AbortSignal | undefined;
  const fetchMock = api((url, init) => {
    if (!url.searchParams.get("cursor")) {
      return json(page([1], "next_2026-01-01T00:00:00.000Z"));
    }
    pageTwoSignal = init?.signal ?? undefined;
    pageTwoStarted.resolve();
    return new Promise<Response>(() => {});
  });
  const adapter = await acquire();
  const controller = new AbortController();
  const result = failure(adapter.sync(), controller.signal);
  await pageTwoStarted.promise;
  controller.abort();
  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(pageTwoSignal?.aborted).toBe(true);
});

test("cancellation aborts an in-flight delete and reports an unknown outcome", async () => {
  const seen = deferred<void>();
  let signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    signal = init?.signal ?? undefined;
    seen.resolve();
    return new Promise<Response>(() => {});
  });
  const controller = new AbortController();
  const result = failure(await run("delete"), controller.signal);
  await seen.promise;
  controller.abort();
  expect(await result).toMatchObject({
    code: "OPERATION_INTERRUPTED",
    details: { remoteOperation: "delete", remoteOutcome: "unknown" },
  });
  expect(signal?.aborted).toBe(true);
});

test("draft connection test reports an actionable failure and stores no credentials", async () => {
  api(() => new Response("Unauthorized", { status: 401 }));
  const repo = new ArticlesRepository(new TokenManager());
  await repo.initialize(settings);
  const result = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "karakeep.testConnection" },
  });
  expect(result.error).toContain("Check them in Pouch settings");
  expect(storage.api_tokens).toBeUndefined();
});

test("repository save, delete, and every sync mode commit complete Karakeep listings", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  let listed = [1, 2];
  api((_url, init) => {
    if (init?.method === "POST") return json(bookmark(3), 201);
    if (init?.method === "DELETE") return noContent();
    return json(page(listed));
  });
  const ids = () => (storage[keys.articles] as { id: string }[]).map((a) => a.id).sort();
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
  expect(ids()).toEqual(["bm1", "bm2"]);
  await runOperation(repo.saveArticle({ url: "https://example.com/3", title: "Bookmark 3" }));
  expect(ids()).toEqual(["bm1", "bm2", "bm3"]);
  await runOperation(repo.deleteArticle("bm1"));
  expect(ids()).toEqual(["bm2", "bm3"]);
  listed = [4];
  // A requested update still replaces the cache, so remote deletions disappear locally.
  await runOperation(repo.syncWithAPI({ mode: "update" }));
  expect(ids()).toEqual(["bm4"]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
  expect(typeof storage[keys.lastFullSyncTimestamp]).toBe("number");
  expect(storage.api_tokens).toBeUndefined();
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api((_url, init) =>
      init?.method === "POST"
        ? json(bookmark(1), 201)
        : init?.method === "DELETE"
          ? noContent()
          : json(page([])),
    );
    const repo = new ArticlesRepository(new TokenManager({ persist: false }));
    await repo.initialize(settings);
    await runOperation(repo.testConnection);
    rejectReads = true;
    const result = await failure(
      operation === "save"
        ? repo.saveArticle({ url: "https://example.com/1", title: "a" })
        : repo.deleteArticle("bm1"),
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
