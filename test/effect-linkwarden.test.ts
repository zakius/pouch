import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createLinkwardenAdapter } from "../src/background/api/adapters/linkwarden-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import { backendForms, type LinkwardenSettings } from "../src/utils/settings-schemas";

const settings: LinkwardenSettings = {
  ...DEFAULT_SETTINGS,
  backend: "linkwarden",
  apiConfig: { url: "https://warden.example.com/", token: "TOKEN" },
};
const base = "https://warden.example.com/api/v1";
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
/** Shape of Linkwarden's Prisma `Link` with the `tags` and `collection` includes, plus noise. */
const link = (id: number) => ({
  id,
  name: `Link ${id}`,
  type: "url",
  description: "",
  createdById: 1,
  collectionId: 1,
  icon: null,
  url: `https://example.com/${id}`,
  textContent: null,
  preview: null,
  image: null,
  readable: null,
  lastPreserved: null,
  importDate: null,
  createdAt: `2026-01-0${(id % 9) + 1}T00:00:00.000Z`,
  updatedAt: "2026-01-01T00:00:00.000Z",
  tags: [{ id: 1, name: "news", ownerId: 1 }],
  collection: { id: 1, name: "Unorganized", ownerId: 1 },
  pinnedBy: [],
});
/** Shape of GET /api/v1/search without a query string. */
const page = (ids: number[], nextCursor: number | null = null) => ({
  data: { links: ids.map(link), nextCursor },
  success: true,
  message: "Success",
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
const acquire = (config = settings) => runOperation(createLinkwardenAdapter(config));
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
    ? adapter.saveArticle({ url: "https://example.com/1", title: "Link 1" })
    : operation === "delete"
      ? adapter.deleteArticle(1)
      : operation === "sync"
        ? adapter.sync()
        : adapter.testConnection;
};

test("save posts url and name with the static token and maps the returned link", async () => {
  const fetchMock = api(() => json({ response: link(1) }));
  const saved = await runOperation(await run("save"));
  expect(saved).toEqual({
    id: 1,
    title: "Link 1",
    url: "https://example.com/1",
    created_at: link(1).createdAt,
  });
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${base}/links`);
  expect(init?.method).toBe("POST");
  const headers = new Headers(init?.headers);
  expect(headers.get("Authorization")).toBe("Bearer TOKEN");
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(JSON.parse(String(init?.body))).toEqual({ url: "https://example.com/1", name: "Link 1" });
});

test("delete and connection test use their endpoints with the static token", async () => {
  const fetchMock = api((_url, init) =>
    init?.method === "DELETE" ? json({ response: link(7) }) : json(page([])),
  );
  const adapter = await acquire();
  await runOperation(adapter.deleteArticle("7"));
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const [remove, probe] = fetchMock.mock.calls;
  expect(String(remove[0])).toBe(`${base}/links/7`);
  expect(remove[1]?.method).toBe("DELETE");
  expect(String(probe[0])).toBe(`${base}/search`);
  for (const [, init] of fetchMock.mock.calls)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
});

test("missing, header-unsafe, or invalid settings fail acquisition before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  for (const apiConfig of [
    { url: settings.apiConfig.url, token: "" },
    { url: settings.apiConfig.url, token: "  " },
    { url: settings.apiConfig.url, token: "a\r\nX-Injected: 1" },
    { url: "not a url", token: "TOKEN" },
  ])
    expect((await failure(createLinkwardenAdapter({ ...settings, apiConfig }))).code).toBe(
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
  await runOperation(tokens.storeToken("linkwarden", legacy));
  const refresh = spyOn(tokens, "refreshToken");
  const getAccessToken = spyOn(tokens, "getAccessToken");
  const storeToken = spyOn(tokens, "storeToken");
  let rejectToken = false;
  // verifyUser answers a missing, expired, or revoked token with {response} and 401.
  const fetchMock = api(() =>
    rejectToken ? json({ response: "You must be logged in." }, 401) : json(page([1])),
  );
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI());
  rejectToken = true;
  const rejected = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(rejected).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "linkwarden.testConnection" },
  });
  await runOperation(tokens.checkAndRefreshTokens);
  expect(refresh).not.toHaveBeenCalled();
  expect(getAccessToken).not.toHaveBeenCalled();
  expect(storeToken).not.toHaveBeenCalled();
  const linkwarden = fetchMock.mock.calls.filter(
    ([url]) => urlOf([url]).host === "warden.example.com",
  );
  expect(linkwarden).toHaveLength(2);
  expect(tokens.getTokenMetadata("linkwarden")).toMatchObject({ accessToken: "LEGACY" });
  for (const [, init] of linkwarden)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
});

for (const [name, response] of [
  ["a validation rejection", () => json({ response: "Error: SECRET [url]" }, 400)],
  ["a duplicate-link conflict", () => json({ response: "Link already exists" }, 409)],
  ["a missing user", () => json({ response: "User not found." }, 404)],
  ["a success-status rejection body", () => json({ response: "SECRET" })],
] as const) {
  for (const operation of operations) {
    test(`${operation} maps ${name} to a safe provider rejection without claiming an outcome`, async () => {
      const fetchMock = api(() => response());
      const result = await failure(await run(operation));
      expect(result.code).toBe("ProviderFailure");
      expect(result.details).toEqual({ operation: `linkwarden.${operation}` });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}

for (const operation of operations) {
  test(`${operation} keeps HTTP, schema, network, and permission failures distinct`, async () => {
    for (const [response, code] of [
      // Servers older than 2.10 have no /api/v1/search and answer with Next.js's HTML 404.
      [() => new Response("<html>SECRET 404</html>", { status: 404 }), "HttpFailure"],
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
        operation: `linkwarden.${operation}`,
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
          ? new Response("Internal Server Error", { status: 500 })
          : json({ response: "SECRET" }, 503);
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

for (const operation of ["save", "delete"] as const) {
  test(`${operation} without a link is an invalid response with unknown outcome`, async () => {
    // The pre-migration adapter accepted any 2xx delete body.
    const fetchMock = api(() => json({ id: 1, name: "SECRET", url: "https://example.com/1" }));
    const result = await failure(await run(operation));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { responseKind: "response", remoteOperation: operation, remoteOutcome: "unknown" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

for (const body of [
  // The pre-migration adapter expected this shape, which no Linkwarden version returns.
  { response: { data: [link(1)] } },
  { response: [link(1)] },
  { data: [] },
  { data: { links: "SECRET", nextCursor: null } },
  { data: { links: [{ id: 1, name: "SECRET", createdAt: "2026" }], nextCursor: null } },
  { data: { links: [], nextCursor: "5" } },
]) {
  test(`malformed sync page ${JSON.stringify(body).slice(0, 60)} is an invalid response`, async () => {
    api(() => json(body));
    const result = await failure(await run("sync"));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { operation: "linkwarden.sync" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("rate-limited requests retry three times, then report the exhausted budget", async () => {
  const fetchMock = api(() => new Response("Too many requests", { status: 429 }));
  const result = await failure(await run("sync"));
  expect(result).toMatchObject({
    code: "RateLimitFailure",
    details: { operation: "linkwarden.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("a rate-limited save was not processed, so it retries and succeeds once", async () => {
  let calls = 0;
  const fetchMock = api(() =>
    ++calls === 1 ? json({}, 429, { "Retry-After": "0" }) : json({ response: link(1) }),
  );
  expect((await runOperation(await run("save"))).id).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync follows nextCursor through every page, including a final empty one", async () => {
  // Linkwarden's Prisma path returns the last id of a full page, then an empty page.
  const pages: Record<string, ReturnType<typeof page>> = {
    "": page(range(51, 100).reverse(), 51),
    "51": page(range(1, 50).reverse(), 1),
    "1": page([]),
  };
  const fetchMock = api((url) => json(pages[url.searchParams.get("cursor") ?? ""]));
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual(range(1, 100).reverse());
  expect(result.mode).toBe("overwrite");
  expect(result.metadata).toMatchObject({ totalFetched: 100, totalProcessed: 100 });
  const urls = fetchMock.mock.calls.map(urlOf);
  expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "51", "1"]);
  for (const url of urls) expect(url.pathname).toBe("/api/v1/search");
});

test("sync skips uploaded files without a URL", async () => {
  api(() =>
    json({
      ...page([1, 2]),
      data: { links: [link(1), { ...link(2), url: null }], nextCursor: null },
    }),
  );
  const result = await runOperation((await acquire()).sync());
  expect(result.articles.map((a) => a.id)).toEqual([1]);
});

test("update sync is still a complete overwrite listing without filters", async () => {
  const fetchMock = api(() => json(page([3])));
  const adapter = await acquire();
  const lastSyncTimestamp = "2023-11-14T22:13:20.999Z";
  const update = await runOperation(adapter.sync({ mode: "update", lastSyncTimestamp }));
  const full = await runOperation(adapter.sync({ mode: "overwrite", lastSyncTimestamp }));
  expect(update.mode).toBe("overwrite");
  expect(full.mode).toBe("overwrite");
  for (const url of fetchMock.mock.calls.map(urlOf)) expect(url.search).toBe("");
});

test("a cursor cycle fails as an incomplete snapshot instead of paging forever", async () => {
  const next: Record<string, number> = { "": 30, "30": 20, "20": 30 };
  const fetchMock = api((url) =>
    json(page([1], next[url.searchParams.get("cursor") ?? ""] ?? null)),
  );
  const result = await failure(await run("sync"));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "linkwarden.sync" },
  });
  expect(fetchMock.mock.calls.map((call) => urlOf(call).searchParams.get("cursor"))).toEqual([
    null,
    "30",
    "20",
  ]);
});

test("cancellation during the page wait stops pagination without another request", async () => {
  const seen = deferred<void>();
  const fetchMock = api(() => {
    seen.resolve();
    return json(page([1], 1));
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
  api(() => json({ response: "You must be logged in." }, 401));
  const repo = new ArticlesRepository(new TokenManager());
  await repo.initialize(settings);
  const result = await runOperation(repo.testConnection).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "linkwarden.testConnection" },
  });
  expect(result.error).toContain("Check account settings");
  expect(storage.api_tokens).toBeUndefined();
});

test("repository save, delete, and every sync mode commit complete Linkwarden listings", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  let listed = [1, 2];
  api((_url, init) => {
    if (init?.method === "POST") return json({ response: link(3) });
    if (init?.method === "DELETE") return json({ response: link(1) });
    return json(page(listed));
  });
  const ids = () => (storage[keys.articles] as { id: number }[]).map((a) => a.id).sort();
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
  expect(ids()).toEqual([1, 2]);
  await runOperation(repo.saveArticle({ url: "https://example.com/3", title: "Link 3" }));
  expect(ids()).toEqual([1, 2, 3]);
  await runOperation(repo.deleteArticle(1));
  expect(ids()).toEqual([2, 3]);
  listed = [4];
  // A requested update still replaces the cache, so remote deletions disappear locally.
  await runOperation(repo.syncWithAPI({ mode: "update" }));
  expect(ids()).toEqual([4]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
  expect(typeof storage[keys.lastFullSyncTimestamp]).toBe("number");
  expect(storage.api_tokens).toBeUndefined();
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api((_url, init) =>
      init?.method === "POST" || init?.method === "DELETE"
        ? json({ response: link(1) })
        : json(page([])),
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

test("the options form says sync needs Linkwarden 2.10 or later", () => {
  // Older servers answer /api/v1/search with a bare HTTP 404.
  expect(backendForms.linkwarden.formConfig[0]?.label).toContain("Linkwarden 2.10 or later");
});
