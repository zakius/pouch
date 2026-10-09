import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createLinkaceAdapter } from "../src/background/api/adapters/linkace-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { LinkaceSettings } from "../src/utils/settings-schemas";

const settings: LinkaceSettings = {
  ...DEFAULT_SETTINGS,
  backend: "linkace",
  apiConfig: { url: "https://links.example.com/sub/", token: "TOKEN" },
};
const base = "https://links.example.com/sub/api/v2/links";
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const link = (id: number) => ({
  id,
  title: `Link ${id}`,
  url: `https://example.com/${id}`,
  created_at: `2026-01-0${(id % 9) + 1} 00:00:00`,
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
const acquire = (config = settings) => runOperation(createLinkaceAdapter(config));
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

for (const [variant, body] of [
  ["wrapped", { data: link(1) }],
  ["bare", link(1)],
] as const) {
  test(`save posts JSON with the static token and maps a ${variant} created link`, async () => {
    const fetchMock = api(() => json(body));
    const saved = await runOperation(await run("save"));
    expect(saved).toEqual({
      id: 1,
      title: "Link 1",
      url: "https://example.com/1",
      created_at: link(1).created_at,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(base);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer TOKEN");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://example.com/1",
      title: "Link 1",
      visibility: 1,
      check_disabled: false,
    });
  });
}

test("delete and connection test use their endpoints with the static token", async () => {
  const fetchMock = api(() => json({ data: [] }));
  const adapter = await acquire();
  await runOperation(adapter.deleteArticle(7));
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const [remove, probe] = fetchMock.mock.calls;
  expect(String(remove[0])).toBe(`${base}/7`);
  expect(remove[1]?.method).toBe("DELETE");
  expect(new Headers(remove[1]?.headers).has("Content-Type")).toBe(false);
  expect(String(probe[0])).toBe(`${base}?per_page=1`);
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
    expect((await failure(createLinkaceAdapter({ ...settings, apiConfig }))).code).toBe(
      "ConfigurationFailure",
    );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the static token never enters TokenManager or refresh, and rejection is never retried unauthenticated", async () => {
  const tokens = new TokenManager({ persist: false });
  const legacy = {
    accessToken: "LEGACY",
    refreshToken: "",
    tokenType: "Bearer",
    expiresAt: Date.now() - 1000,
    issuedAt: 0,
    refreshCount: 0,
  };
  await tokens.storeToken("linkace", legacy);
  const refresh = spyOn(tokens, "refreshToken");
  const getAccessToken = spyOn(tokens, "getAccessToken");
  const fetchMock = api((url) =>
    url.searchParams.get("per_page") === "1"
      ? json({ message: "Unauthenticated." }, 401)
      : json({ data: [link(1)] }),
  );
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await repo.syncWithAPI();
  const rejected = await repo.testConnection().catch((error: unknown) => errorResponse(error));
  expect(rejected).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "linkace.testConnection" },
  });
  await tokens.checkAndRefreshTokens();
  expect(refresh).not.toHaveBeenCalled();
  expect(getAccessToken).not.toHaveBeenCalled();
  const linkace = fetchMock.mock.calls.filter(([url]) => urlOf([url]).host === "links.example.com");
  expect(linkace).toHaveLength(2);
  expect(tokens.getTokenMetadata("linkace")).toMatchObject({ accessToken: "LEGACY" });
  for (const [, init] of linkace)
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOKEN");
});

for (const [name, response] of [
  [
    "a validation rejection",
    () => json({ message: "SECRET", errors: { url: ["SECRET is taken"] } }, 422),
  ],
  ["a success-status message envelope", () => json({ message: "SECRET" })],
] as const) {
  for (const operation of operations) {
    test(`${operation} maps ${name} to a safe provider rejection without claiming an outcome`, async () => {
      const fetchMock = api(() => response());
      const result = await failure(await run(operation));
      expect(result.code).toBe("ProviderFailure");
      expect(result.details).toEqual({ operation: `linkace.${operation}` });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}

for (const operation of operations) {
  test(`${operation} keeps HTTP, schema, and network failures distinct from provider rejection`, async () => {
    for (const [response, code] of [
      [() => new Response("<html>SECRET</html>", { status: 404 }), "HttpFailure"],
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
        operation: `linkace.${operation}`,
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
        return kind === "server" ? json({}, 503) : json({ message: "SECRET Server Error" }, 500);
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

test("save without a created link is an invalid response with unknown outcome", async () => {
  const fetchMock = api(() => json({ data: { id: "SECRET" } }));
  const result = await failure(await run("save"));
  expect(result).toMatchObject({
    code: "InvalidResponseFailure",
    details: { responseKind: "response", remoteOperation: "save", remoteOutcome: "unknown" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

for (const body of [
  { data: "SECRET" },
  { links: [] },
  { data: [{ id: 1, title: "SECRET" }] },
  { data: [], meta: { last_page: "SECRET" } },
]) {
  test(`malformed sync page ${JSON.stringify(body)} is an invalid response`, async () => {
    api(() => json(body));
    const result = await failure(await run("sync"));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { operation: "linkace.sync" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("rate-limited requests retry three times, then report the exhausted budget", async () => {
  const fetchMock = api(() => json({}, 429, { "Retry-After": "0" }));
  const result = await failure(await run("sync"));
  expect(result).toMatchObject({
    code: "RateLimitFailure",
    details: { operation: "linkace.sync" },
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("a rate-limited save was not processed, so it retries and succeeds once", async () => {
  let calls = 0;
  const fetchMock = api(() =>
    ++calls === 1 ? json({}, 429, { "Retry-After": "0" }) : json({ data: link(1) }),
  );
  expect((await runOperation(await run("save"))).id).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

for (const [name, total, pageBody] of [
  ["meta.last_page", 65, (ids: number[]) => ({ data: ids.map(link), meta: { last_page: 3 } })],
  ["flat last_page", 65, (ids: number[]) => ({ data: ids.map(link), last_page: 3 })],
  ["no metadata and a short last page", 65, (ids: number[]) => ({ data: ids.map(link) })],
] as const) {
  test(`multi-page sync follows ${name} and preserves order and totals`, async () => {
    const fetchMock = api((url) => {
      const page = Number(url.searchParams.get("page"));
      return json(pageBody(range((page - 1) * 30 + 1, Math.min(page * 30, total))));
    });
    const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
    expect(result.articles.map((a) => a.id)).toEqual(range(1, total));
    expect(result.mode).toBe("overwrite");
    expect(result.metadata).toMatchObject({
      totalFetched: total,
      totalProcessed: total,
      apiVersion: "2.0",
    });
    const urls = fetchMock.mock.calls.map(urlOf);
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const url of urls) {
      expect(url.pathname).toBe("/sub/api/v2/links");
      expect(url.searchParams.get("per_page")).toBe("30");
      expect(url.searchParams.has("created_after")).toBe(false);
    }
  });
}

test("without metadata a full last page needs one empty page to end the listing", async () => {
  const fetchMock = api((url) =>
    json({ data: url.searchParams.get("page") === "1" ? range(1, 30).map(link) : [] }),
  );
  const result = await runOperation((await acquire()).sync());
  expect(result.articles).toHaveLength(30);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a page total overrides a full page", async () => {
  const fetchMock = api(() => json({ data: range(1, 30).map(link), meta: { last_page: 1 } }));
  await runOperation((await acquire()).sync());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("update sync sends created_after verbatim; overwrite sync ignores the timestamp", async () => {
  const fetchMock = api(() => json({ data: [link(3)] }));
  const adapter = await acquire();
  const lastSyncTimestamp = "2023-11-14T22:13:20.999Z";
  const update = await runOperation(adapter.sync({ mode: "update", lastSyncTimestamp }));
  const full = await runOperation(adapter.sync({ mode: "overwrite", lastSyncTimestamp }));
  expect(update.mode).toBe("update");
  expect(full.mode).toBe("overwrite");
  const [incremental, overwrite] = fetchMock.mock.calls.map(urlOf);
  expect(incremental.searchParams.get("created_after")).toBe(lastSyncTimestamp);
  expect(overwrite.searchParams.has("created_after")).toBe(false);
});

test("cancellation during the page wait stops pagination without another request", async () => {
  const seen = deferred<void>();
  const fetchMock = api(() => {
    seen.resolve();
    return json({ data: range(1, 30).map(link), meta: { last_page: 2 } });
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

test("a nearly exhausted rate limit delays this account's next request until cancelled", async () => {
  const reset = String(Math.ceil(Date.now() / 1000) + 30);
  const fetchMock = api(() =>
    json({ data: link(1) }, 200, { "X-RateLimit-Remaining": "2", "X-RateLimit-Reset": reset }),
  );
  const adapter = await acquire();
  await runOperation(adapter.saveArticle({ url: "https://example.com/1", title: "Link 1" }));
  const controller = new AbortController();
  const waiting = failure(adapter.testConnection, controller.signal);
  // Another account has its own pacing.
  await runOperation((await acquire()).saveArticle({ url: "https://a", title: "a" }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  controller.abort();
  expect(await waiting).toEqual({
    error: "The operation was interrupted. Check its outcome before repeating it.",
    code: "OPERATION_INTERRUPTED",
    details: {},
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("draft connection test reports an actionable failure and stores no credentials", async () => {
  api(() => json({ message: "Unauthenticated." }, 401));
  const repo = new ArticlesRepository(new TokenManager());
  await repo.initialize(settings);
  const result = await repo.testConnection().catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "linkace.testConnection" },
  });
  expect(storage.api_tokens).toBeUndefined();
});

test("repository save, delete, overwrite and update sync commit LinkAce outcomes", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  let listed = [1, 2];
  api((_url, init) => {
    if (init?.method === "POST") return json({ data: link(3) });
    if (init?.method === "DELETE") return json({});
    return json({ data: listed.map(link) });
  });
  const ids = () => (storage[keys.articles] as { id: number }[]).map((a) => a.id).sort();
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await repo.syncWithAPI({ mode: "overwrite" });
  expect(ids()).toEqual([1, 2]);
  await repo.saveArticle({ url: "https://example.com/3", title: "Link 3" });
  expect(ids()).toEqual([1, 2, 3]);
  await repo.deleteArticle(1);
  expect(ids()).toEqual([2, 3]);
  listed = [4];
  await repo.syncWithAPI({ mode: "update" });
  expect(ids()).toEqual([2, 3, 4]);
  await repo.syncWithAPI({ mode: "overwrite" });
  expect(ids()).toEqual([4]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api((_url, init) =>
      json(init?.method === "POST" ? { data: link(1) } : { data: [] }),
    );
    const repo = new ArticlesRepository(new TokenManager({ persist: false }));
    await repo.initialize(settings);
    await repo.testConnection();
    rejectReads = true;
    const result = await failure(
      operation === "save"
        ? repo.saveArticleEffect({ url: "https://example.com/1", title: "a" })
        : repo.deleteArticleEffect(1),
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
