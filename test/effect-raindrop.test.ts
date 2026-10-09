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
const item = (id: number) => ({
  _id: id,
  title: `Article ${id}`,
  link: `https://example.com/${id}`,
  created: `2026-01-0${(id % 9) + 1}T00:00:00.000Z`,
  tags: [],
});
const page = (ids: number[], count?: number) => ({
  result: true,
  items: ids.map(item),
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
    title: "Article 1",
  });
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
  for (const apiKey of ["", "  ", "a\r\nX-Injected: 1"])
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
  await tokens.storeToken("raindrop", legacy);
  const refresh = spyOn(tokens, "refreshToken");
  const getAccessToken = spyOn(tokens, "getAccessToken");
  const fetchMock = api((url) =>
    url.pathname.endsWith("/collections") ? json({}, 401) : json(page([1], 1)),
  );
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await repo.syncWithAPI();
  const rejected = await repo.testConnection().catch((error: unknown) => errorResponse(error));
  expect(rejected).toMatchObject({ code: "CredentialsFailure" });
  await tokens.checkAndRefreshTokens();
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

test("sync without a count stops after the first page", async () => {
  const fetchMock = api(() => json(page(range(1, 50))));
  const result = await runOperation((await acquire()).sync());
  expect(result.articles).toHaveLength(50);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("update sync searches by creation time in seconds; overwrite sync ignores the timestamp", async () => {
  const fetchMock = api(() => json(page([3], 1)));
  const adapter = await acquire();
  const lastSyncTimestamp = "2023-11-14T22:13:20.999Z";
  const update = await runOperation(adapter.sync({ mode: "update", lastSyncTimestamp }));
  await runOperation(adapter.sync({ mode: "overwrite", lastSyncTimestamp }));
  expect(update.mode).toBe("update");
  const [incremental, full] = fetchMock.mock.calls.map(urlOf);
  expect(incremental.searchParams.get("search")).toBe("created:>1700000000");
  expect(full.searchParams.has("search")).toBe(false);
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
  const result = await repo.testConnection().catch((error: unknown) => errorResponse(error));
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
  let listed = [1, 2];
  api((url, init) => {
    if (init?.method === "POST") return json({ result: true, item: item(3) });
    if (init?.method === "DELETE") return json({ result: true });
    return json(page(listed, listed.length));
  });
  const ids = () => (storage[keys.articles] as { id: number }[]).map((a) => a.id).sort();
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  await repo.syncWithAPI({ mode: "overwrite" });
  expect(ids()).toEqual([1, 2]);
  await repo.saveArticle({ url: "https://example.com/3", title: "Article 3" });
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
    const fetchMock = api(() =>
      json(operation === "save" ? { result: true, item: item(1) } : { result: true, items: [] }),
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

for (const header of ["X-RateLimit-Remaining", "RateLimit-Remaining"]) {
  test(`a low ${header} holds the next page until its reset, and the hold is cancellable`, async () => {
    const seen = deferred<void>();
    const reset = String(Math.ceil(Date.now() / 1000) + 30);
    const fetchMock = api(() => {
      seen.resolve();
      return json(page(range(1, 50), 100), 200, { [header]: "9", "X-RateLimit-Reset": reset });
    });
    const controller = new AbortController();
    const result = failure((await acquire()).sync(), controller.signal);
    await seen.promise;
    // Past the one-second page spacing, so only the rate-limit hold blocks page 1.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await result).code).toBe("OPERATION_INTERRUPTED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

test("a healthy rate limit does not hold the next page", async () => {
  const fetchMock = api((url) =>
    json(page(url.searchParams.get("page") === "0" ? range(1, 50) : [51], 51), 200, {
      "X-RateLimit-Remaining": "10",
      "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 30),
    }),
  );
  expect((await runOperation((await acquire()).sync())).articles).toHaveLength(51);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
