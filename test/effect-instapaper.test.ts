import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { createInstapaperAdapter } from "../src/background/api/adapters/instapaper-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { InstapaperSettings } from "../src/utils/settings-schemas";

const settings: InstapaperSettings = {
  ...DEFAULT_SETTINGS,
  backend: "instapaper",
  apiConfig: {
    consumerKey: "key",
    consumerSecret: "secret",
    username: "user",
    password: "PASSWORD",
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bookmark = (id: number) => ({
  type: "bookmark",
  bookmark_id: id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  time: 1700000000,
});
const syncResponse = (bookmarks: number[], deleteIds?: number[]) => ({
  user: { type: "user", user_id: 1, username: "test" },
  bookmarks: bookmarks.map(bookmark),
  ...(deleteIds ? { delete_ids: deleteIds } : {}),
});
const full = Array.from({ length: 500 }, (_, i) => i + 1);
const tokenBody = "oauth_token=token&oauth_token_secret=token-secret";
const isAuth = (url: unknown) => String(url).endsWith("/oauth/access_token");
const bodyOf = (init?: RequestInit) => new URLSearchParams(String(init?.body));

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

/** xAuth succeeds; API requests go to `handler` with their 1-based API call number. */
const api = (
  handler: (call: number, body: URLSearchParams, url: string) => Response | Promise<Response>,
) => {
  let calls = 0;
  return spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    isAuth(url) ? new Response(tokenBody) : handler(++calls, bodyOf(init), String(url)),
  );
};
const acquire = (tokens = new TokenManager({ persist: false })) =>
  runOperation(createInstapaperAdapter(settings, tokens));
const failure = async (operation: Effect.Effect<unknown, unknown>, signal?: AbortSignal) => {
  try {
    await runOperation(operation, signal);
    throw new Error("Expected failure");
  } catch (error) {
    return errorResponse(error);
  }
};
const apiCalls = (fetchMock: ReturnType<typeof api>) =>
  fetchMock.mock.calls.filter(([url]) => !isAuth(url));

/** Recomputes the OAuth signature from pre-encoded `key=value` request params. */
const expectValidSignature = (
  [url, init]: [unknown, RequestInit?],
  requestParams: string[],
  token?: { key: string; secret: string },
) => {
  const auth = new Headers(init?.headers).get("Authorization")!;
  expect(auth).toStartWith("OAuth ");
  const header = Object.fromEntries(
    [...auth.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decodeURIComponent(v)]),
  );
  expect(header.oauth_token).toBe(token?.key);
  const params = [
    ...requestParams,
    "oauth_consumer_key=key",
    `oauth_nonce=${header.oauth_nonce}`,
    "oauth_signature_method=HMAC-SHA1",
    `oauth_timestamp=${header.oauth_timestamp}`,
    ...(token ? [`oauth_token=${token.key}`] : []),
    "oauth_version=1.0",
  ]
    .sort()
    .join("&");
  const base = `POST&${encodeURIComponent(String(url))}&${encodeURIComponent(params)}`;
  const expected = createHmac("sha1", `secret&${token?.secret ?? ""}`)
    .update(base)
    .digest("base64");
  expect(header.oauth_signature).toBe(expected);
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
};
const userToken = { key: "token", secret: "token-secret" };

test("xAuth access_token request is a signed POST without an access token", async () => {
  const fetchMock = api(() => json(syncResponse([])));
  const tokens = new TokenManager({ persist: false });
  await acquire(tokens);
  const auth = fetchMock.mock.calls[0];
  expect(String(auth[0])).toBe("https://www.instapaper.com/api/1/oauth/access_token");
  expect(Object.fromEntries(bodyOf(auth[1]))).toEqual({
    x_auth_username: "user",
    x_auth_password: "PASSWORD",
    x_auth_mode: "client_auth",
  });
  expectValidSignature(auth, [
    "x_auth_mode=client_auth",
    "x_auth_password=PASSWORD",
    "x_auth_username=user",
  ]);
  expect(tokens.getTokenMetadata("instapaper")).toMatchObject({
    accessToken: "token",
    tokenType: "OAuth",
  });
  expect(JSON.stringify(tokens.getTokenMetadata("instapaper"))).not.toContain("token-secret");
});

test("saveArticle signs RFC 3986-encoded params so URLs with ( ) verify", async () => {
  const fetchMock = api(() => json([bookmark(1)]));
  const adapter = await acquire();
  const saved = await runOperation(
    adapter.saveArticle({ url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "t!" }),
  );
  expect(saved.id).toBe(1);
  expectValidSignature(
    apiCalls(fetchMock)[0],
    ["title=t%21", "url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FFoo_%28bar%29"],
    userToken,
  );
});

test("delete and connection test are signed POSTs", async () => {
  const fetchMock = api((call) => (call === 1 ? json([]) : json(syncResponse([1]))));
  const adapter = await acquire();
  await runOperation(adapter.deleteArticle(7));
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const [remove, list] = apiCalls(fetchMock);
  expect(String(remove[0])).toEndWith("/api/1/bookmarks/delete");
  expectValidSignature(remove, ["bookmark_id=7"], userToken);
  expectValidSignature(list, ["limit=1"], userToken);
});

test("sync returns an empty snapshot for an empty account", async () => {
  api(() => json(syncResponse([])));
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles).toEqual([]);
  expect(result.mode).toBe("overwrite");
  expect(result.metadata?.totalFetched).toBe(0);
});

test("sync stops after a short page", async () => {
  const fetchMock = api(() => json(syncResponse([1, 2, 3])));
  const result = await runOperation((await acquire()).sync());
  expect(result.articles.map((a) => a.id)).toEqual([1, 2, 3]);
  expect(result.mode).toBe("overwrite");
  expect(apiCalls(fetchMock)).toHaveLength(1);
});

test("sync requests the next page after an exactly-500 page", async () => {
  const fetchMock = api((call) => json(syncResponse(call === 1 ? full : [])));
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles).toHaveLength(500);
  expect(apiCalls(fetchMock)).toHaveLength(2);
});

test("sync dedupes bookmarks repeated across pages", async () => {
  const fetchMock = api((call) => json(syncResponse(call === 1 ? full : [500, 501])));
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual([...full, 501]);
  expect(apiCalls(fetchMock)).toHaveLength(2);
});

test("sync ignores delete_ids it cannot apply and still returns the snapshot", async () => {
  api(() => json(syncResponse([1, 2], [1])));
  const result = await runOperation((await acquire()).sync({ mode: "update" }));
  expect(result.articles.map((a) => a.id)).toEqual([1, 2]);
  expect(result.mode).toBe("update");
});

test("sync pages past 500 bookmarks by sending seen ids as a signed have param", async () => {
  const all = Array.from({ length: 1234 }, (_, i) => i + 1);
  const fetchMock = api((_call, body) => {
    const have = new Set(body.get("have")?.split(","));
    return json(syncResponse(all.filter((id) => !have.has(String(id))).slice(0, 500)));
  });
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual(all);
  const [first, second] = apiCalls(fetchMock);
  expect(apiCalls(fetchMock)).toHaveLength(3);
  expect(bodyOf(first[1]).has("have")).toBe(false);
  expect(bodyOf(second[1]).get("have")).toBe(all.slice(0, 500).join(","));
  expectValidSignature(second, [`have=${all.slice(0, 500).join("%2C")}`, "limit=500"], userToken);
});

test("a full page with no new IDs fails as an incomplete snapshot", async () => {
  const fetchMock = api(() => json(syncResponse(full)));
  const result = await failure((await acquire()).sync({ mode: "overwrite" }));
  expect(result).toMatchObject({
    code: "IncompleteSnapshotFailure",
    details: { operation: "instapaper.sync" },
  });
  expect(result.error).toContain("kept the previous articles");
  expect(apiCalls(fetchMock)).toHaveLength(2);
});

test("cancellation during the page wait stops pagination without another request", async () => {
  const seen = deferred<void>();
  const fetchMock = api(() => {
    seen.resolve();
    return json(syncResponse(full));
  });
  const adapter = await acquire();
  const controller = new AbortController();
  const result = failure(adapter.sync(), controller.signal);
  await seen.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(apiCalls(fetchMock)).toHaveLength(1);
});

test("cancellation aborts an in-flight page request", async () => {
  const seen = deferred<void>();
  let signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (isAuth(url)) return new Response(tokenBody);
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

for (const [name, response] of [
  [
    "a success-status error envelope",
    () => json([{ type: "error", error_code: 1240, message: "SECRET" }]),
  ],
  ["a rejected request", () => json([{ type: "error", error_code: 1240, message: "SECRET" }], 400)],
] as const) {
  test(`save maps ${name} to a safe provider code without claiming success`, async () => {
    const fetchMock = api(() => response());
    const result = await failure((await acquire()).saveArticle({ url: "https://a", title: "a" }));
    expect(result).toMatchObject({
      code: "ProviderFailure",
      details: { operation: "instapaper.save", providerCode: 1240 },
    });
    expect(result.details).not.toHaveProperty("remoteOutcome");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(apiCalls(fetchMock)).toHaveLength(1);
  });
}

for (const kind of ["network", "server", "provider-server"] as const) {
  for (const operation of ["save", "delete"] as const) {
    test(`${operation} with unknown ${kind} outcome is never repeated`, async () => {
      const fetchMock = api(() => {
        if (kind === "network") throw new TypeError("SECRET request payload");
        return kind === "server"
          ? json({}, 503)
          : json([{ type: "error", error_code: 1500, message: "SECRET" }], 500);
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
      expect(apiCalls(fetchMock)).toHaveLength(1);
    });
  }
}

test("rejected xAuth credentials fail acquisition without exposing the response", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("SECRET Invalid xAuth", { status: 401 }),
  );
  const tokens = new TokenManager({ persist: false });
  const result = await failure(createInstapaperAdapter(settings, tokens));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "instapaper.authenticate" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(tokens.getTokenMetadata("instapaper")).toBeNull();
});

test("signed request rejection is a credential failure", async () => {
  api(() => new Response("SECRET", { status: 403 }));
  expect((await failure((await acquire()).sync())).code).toBe("CredentialsFailure");
});

for (const body of ["oauth_token=only", "<html>SECRET</html>"]) {
  test(`xAuth response ${JSON.stringify(body)} is an invalid token response`, async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const result = await failure(createInstapaperAdapter(settings));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: { responseKind: "token" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
}

test("malformed list response is an invalid response, not a snapshot", async () => {
  api(() => json({ bookmarks: "SECRET" }));
  const result = await failure((await acquire()).sync());
  expect(result).toMatchObject({
    code: "InvalidResponseFailure",
    details: { responseKind: "response" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("browser crypto failure is a signing failure and sends nothing", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("SECRET key material"));
  const result = await failure(createInstapaperAdapter(settings));
  expect(result).toMatchObject({
    code: "BrowserFailure",
    details: { operation: "instapaper.authenticate", reason: "crypto" },
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("missing configuration fails acquisition before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const result = await failure(
    createInstapaperAdapter({ ...settings, apiConfig: { ...settings.apiConfig, consumerKey: "" } }),
  );
  expect(result.code).toBe("ConfigurationFailure");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a late xAuth response cannot publish credentials after account replacement", async () => {
  const tokens = new TokenManager();
  const started = deferred<void>();
  const release = deferred<Response>();
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (bodyOf(init).get("x_auth_username") === "user") {
      started.resolve();
      return release.promise;
    }
    return new Response("oauth_token=replacement&oauth_token_secret=s");
  });
  const pending = failure(createInstapaperAdapter(settings, tokens));
  await started.promise;
  await runOperation(
    createInstapaperAdapter(
      { ...settings, apiConfig: { ...settings.apiConfig, username: "other" } },
      tokens,
    ),
  );
  release.resolve(new Response(tokenBody));
  expect((await pending).code).toBe("CredentialsFailure");
  expect(tokens.getTokenMetadata("instapaper")?.accessToken).toBe("replacement");
  expect(storage.api_tokens).toEqual([
    ["instapaper", expect.objectContaining({ accessToken: "replacement" })],
  ]);
});

test("a replaced account's ready adapter cannot sign further requests", async () => {
  const tokens = new TokenManager({ persist: false });
  const fetchMock = api(() => json(syncResponse([])));
  const stale = await acquire(tokens);
  await acquire(tokens);
  await runOperation(
    createInstapaperAdapter(
      { ...settings, apiConfig: { ...settings.apiConfig, username: "other" } },
      tokens,
    ),
  );
  const before = fetchMock.mock.calls.length;
  expect((await failure(stale.sync())).code).toBe("CredentialsFailure");
  expect(fetchMock.mock.calls.length).toBe(before);
});

test("draft connection test uses its own tokens and leaves the active account untouched", async () => {
  const active = new TokenManager();
  api(() => json(syncResponse([1])));
  await acquire(active);
  const stored = structuredClone(storage.api_tokens);
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize({ ...settings, apiConfig: { ...settings.apiConfig, username: "draft" } });
  expect(await runOperation(repo.testConnection)).toBe(true);
  expect(storage.api_tokens).toEqual(stored);
  expect(active.getTokenMetadata("instapaper")?.accessToken).toBe("token");
});

test("repository keeps the previous cache when the snapshot is incomplete", async () => {
  const keys = getAccountStorageKeys(settings);
  const previous = [{ id: 9, title: "Kept", url: "https://kept.example", created_at: "2026" }];
  storage[keys.articles] = previous;
  api(() => json(syncResponse(full)));
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  const result = await runOperation(repo.syncWithAPI()).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({ code: "IncompleteSnapshotFailure" });
  expect(storage[keys.articles]).toEqual(previous);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();
  expect(await runOperation(repo.getAllArticles)).toEqual(previous);
});

test("repository save, delete, and sync commit Instapaper outcomes to the account cache", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (isAuth(url)) return new Response(tokenBody);
    if (String(url).endsWith("/add")) return json([bookmark(3)]);
    if (String(url).endsWith("/delete")) return json([]);
    return json(syncResponse([1, 2]));
  });
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  expect((await runOperation(repo.syncWithAPI())).items.map((a) => a.id)).toEqual([1, 2]);
  await runOperation(repo.saveArticle({ url: "https://example.com/3", title: "Article 3" }));
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([3, 1, 2]);
  await runOperation(repo.deleteArticle(1));
  expect((storage[keys.articles] as { id: number }[]).map((a) => a.id)).toEqual([3, 2]);
  expect(typeof storage[keys.lastSyncTimestamp]).toBe("string");
});

for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const fetchMock = api(() => json(operation === "save" ? [bookmark(1)] : []));
    const repo = new ArticlesRepository(new TokenManager({ persist: false }));
    await repo.initialize(settings);
    await runOperation(repo.testConnection).catch(() => {});
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
    expect(apiCalls(fetchMock).filter(([url]) => !String(url).endsWith("/list"))).toHaveLength(1);
  });
}
