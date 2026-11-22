import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { createWallabagAdapter } from "../src/background/api/adapters/wallabag-adapter";
import { requestJson, retryAfterDelay } from "../src/background/api/effect-api-client";
import {
  CredentialsFailure,
  OperationInterrupted,
  runOperation,
} from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { hashAccountIdentity, TokenManager } from "../src/background/token-manager";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { clearCanonicalUrlCache, initializeUrlCanonizer } from "../src/utils/url-helpers";
import { initializeWithRawFilterLists } from "../src/utils/filter-list-url-cleaner";
import { resetFilterListSources, setFilterListSources } from "../src/utils/filter-list-manager";
import type { WallabagSettings } from "../src/utils/settings-schemas";

const settings: WallabagSettings = {
  ...DEFAULT_SETTINGS,
  backend: "wallabag",
  apiConfig: {
    url: "https://wallabag.example",
    clientId: "client",
    clientSecret: "SECRET",
    username: "user",
    password: "PASSWORD",
  },
};
const settingsIdentityHash = await hashAccountIdentity(JSON.stringify(settings.apiConfig));
const oldToken = {
  accessToken: "active-access",
  refreshToken: "active-refresh",
  tokenType: "Bearer",
  expiresAt: Date.now() + 3600000,
  issuedAt: Date.now(),
  refreshCount: 0,
  accountIdentityHash: settingsIdentityHash,
};
const token = {
  access_token: "rotated-access",
  refresh_token: "rotated-refresh",
  expires_in: 3600,
  token_type: "Bearer",
};
const item = {
  id: 42,
  title: "Article",
  url: "https://article.example",
  created_at: "2026-01-01T00:00:00Z",
};
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
const snapshot = (
  items = [item],
  total = items.length,
  pages = Math.ceil(total / 150),
  page = 1,
) => ({
  _embedded: { items },
  limit: 150,
  page,
  pages,
  total,
});
const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
let storage: Record<string, unknown>;
let granted: boolean;
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
  granted = true;
  rejectReads = false;
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => granted },
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
const request = (options: Partial<Parameters<typeof requestJson>[0]> = {}) =>
  requestJson({
    operation: "wallabag.test",
    url: "https://wallabag.example/api/entries.json",
    rateDelayMs: 0,
    ...options,
  });
const failure = async (operation: Effect.Effect<unknown, unknown>, signal?: AbortSignal) => {
  try {
    await runOperation(operation, signal);
    throw new Error("Expected failure");
  } catch (error) {
    return errorResponse(error);
  }
};

for (const [name, response, code] of [
  ["rejected credentials", () => json({ error: "SECRET" }, 401), "CredentialsFailure"],
  ["HTTP rejection", () => json({ secret: "SECRET" }, 418), "HttpFailure"],
  ["invalid JSON", () => new Response("SECRET not JSON"), "InvalidResponseFailure"],
  ["exhausted rate limit", () => json({}, 429, { "Retry-After": "0" }), "RateLimitFailure"],
] as const) {
  test(`runtime safely distinguishes ${name}`, async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => response());
    const result = await failure(request({ rateRetries: 1 }));
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(code === "RateLimitFailure" ? 2 : 1);
  });
}
test("missing permission and network failure remain distinct without exposing rejection payloads", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("SECRET https://user:password@private.example"),
  );
  granted = false;
  expect((await failure(request())).code).toBe("PermissionFailure");
  expect(fetchMock).not.toHaveBeenCalled();
  granted = true;
  const result = await failure(request());
  expect(result.code).toBe("NetworkFailure");
  expect(JSON.stringify(result)).not.toContain("private.example");
});
test("auth and rate-limit budgets are independent across alternating rejections", async () => {
  let attempts = 0;
  let refreshes = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
    attempts++;
    return attempts === 1 || attempts === 3
      ? json({}, 401)
      : json({}, 429, { "Retry-After": attempts === 4 ? "60" : "0" });
  });
  const result = await failure(
    request({
      authRetries: 2,
      rateRetries: 1,
      recoverAuth: Effect.sync(() => {
        refreshes++;
      }),
    }),
  );
  expect(result.code).toBe("RateLimitFailure");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(refreshes).toBe(2);
});
test("rate-limit retries cannot reset exhausted auth retries", async () => {
  const statuses = [401, 429, 401];
  let refreshes = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () =>
    json({}, statuses.shift(), { "Retry-After": "0" }),
  );
  const result = await failure(
    request({
      authRetries: 1,
      rateRetries: 3,
      recoverAuth: Effect.sync(() => {
        refreshes++;
      }),
    }),
  );
  expect(result.code).toBe("CredentialsFailure");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(refreshes).toBe(1);
});
test("Retry-After seconds, HTTP dates, reset time, and fallback produce server-directed delays", () => {
  expect(retryAfterDelay(new Headers({ "Retry-After": "1.5" }), 50, 1000)).toBe(1500);
  expect(
    retryAfterDelay(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:00:03 GMT" }), 50, 1000),
  ).toBe(2000);
  expect(retryAfterDelay(new Headers({ "Retry-After": "invalid" }), 50, 1000)).toBe(50);
  expect(retryAfterDelay(new Headers({ "Retry-After": "-1" }), 50, 1000)).toBe(50);
  expect(retryAfterDelay(new Headers({ "X-RateLimit-Reset": "3" }), 50, 1000)).toBe(2000);
});
test("cancellation during Retry-After wait interrupts without another request", async () => {
  const seen = deferred<void>();
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
    seen.resolve();
    return json({}, 429, { "Retry-After": "60" });
  });
  const controller = new AbortController();
  const result = failure(request(), controller.signal);
  await seen.promise;
  controller.abort();
  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
for (const abort of [false, true]) {
  test(`stalled body ${abort ? "caller cancellation is interruption" : "times out through consumption"}`, async () => {
    const body = deferred<void>();
    let fetchSignal: AbortSignal | undefined;
    const controller = new AbortController();
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start() {
            body.resolve();
          },
        }),
      );
    });
    const result = failure(request({ timeoutMs: 30 }), controller.signal);
    await body.promise;
    if (abort) controller.abort();
    expect((await result).code).toBe(abort ? "OPERATION_INTERRUPTED" : "TimeoutFailure");
    expect(fetchSignal?.aborted).toBe(true);
  });
}
test("pre-aborted operations never send fetch or report timeout", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const controller = new AbortController();
  controller.abort();
  expect((await failure(request({ timeoutMs: 1 }), controller.signal)).code).toBe(
    "OPERATION_INTERRUPTED",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
for (const operation of ["save", "delete"] as const) {
  for (const kind of ["network", "server", "timeout"] as const) {
    test(`${operation} with unknown ${kind} outcome is never automatically repeated`, async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (kind === "server") return json({}, 503);
        if (kind === "timeout") return new Promise<Response>(() => {});
        throw new TypeError("SECRET request payload");
      });
      const result = await failure(
        request({
          mutation: operation,
          timeoutMs: 10,
          init: { method: operation === "save" ? "POST" : "DELETE" },
        }),
      );
      expect(result.details).toMatchObject({
        remoteOperation: operation,
        remoteOutcome: "unknown",
      });
      expect(result.error).toContain("Do not repeat it");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }
}
test("required token failure stops fetch and retains its recovery category", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const result = await failure(
    request({ authorization: Effect.fail(new CredentialsFailure("access token")) }),
  );
  expect(result.code).toBe("CredentialsFailure");
  expect(fetchMock).not.toHaveBeenCalled();
});
test("Wallabag sends Bearer even when the server issues token_type bearer", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, tokenType: "bearer" }));
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer active-access");
    return json(snapshot());
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect(await runOperation(api.testConnection)).toBe(true);
});
test("ready Wallabag saves, deletes, tests, and paginates full and incremental sync", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const urls: string[] = [];
  const item2 = { ...item, id: 43, url: "https://article.example/2" };
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const requestUrl = String(url);
    urls.push(requestUrl);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer active-access");
    if (init?.method === "POST") return json({ ...item, id: "18446744073709551616" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (requestUrl.includes("perPage=1&")) return json(snapshot([item], 1, 1, 1));
    return json(
      requestUrl.includes("page=2")
        ? snapshot([item2], 151, 2, 2)
        : snapshot([item], 151, 2, 1),
    );
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await runOperation(api.saveArticle({ url: item.url, title: item.title }))).id).toBe(
    "18446744073709551616",
  );
  await runOperation(api.deleteArticle("42"));
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(urls.at(-1)).toBe("https://wallabag.example/api/entries.json?page=1&perPage=1&detail=metadata");
  const full = await runOperation(api.sync());
  expect(full.mode).toBe("overwrite");
  expect(full.articles).toHaveLength(2);
  const fullUrls = urls.slice(-2);
  expect(
    fullUrls.every(
      (url) =>
        url.includes("perPage=150") &&
        url.includes("detail=metadata") &&
        url.includes("sort=created") &&
        url.includes("order=asc"),
    ),
  ).toBe(true);
  const incremental = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now(), lastSyncTimestamp: "2026-01-01T00:00:00Z" }),
  );
  expect(incremental.mode).toBe("update");
  expect(urls.slice(-2).every((url) => url.includes("since=1767225480"))).toBe(true);
  const idle = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now() - 86400001, isBrowserIdle: true }),
  );
  expect(idle.mode).toBe("overwrite");
  expect(urls.at(-1)).not.toContain("since=");
  const active = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now() - 86400001, isBrowserIdle: false }),
  );
  expect(active.mode).toBe("update");
  const overdue = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now() - 2 * 86400001, isBrowserIdle: false }),
  );
  expect(overdue.mode).toBe("overwrite");
  expect(overdue.metadata.syncDecision?.reason).toBe("48h_overdue");
});
for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const tokens = new TokenManager({ persist: false });
    await runOperation(tokens.storeToken("wallabag", oldToken));
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(item),
    );
    const repo = new ArticlesRepository(tokens);
    await repo.initialize(settings);
    rejectReads = true;
    const result = await failure(
      operation === "save" ? repo.saveArticle(item) : repo.deleteArticle("42"),
    );
    expect(result.code).toBe("BrowserFailure");
    expect(result.details).toMatchObject({
      remoteOperation: operation,
      remoteOutcome: "succeeded",
    });
    expect(result.error).toContain("Do not repeat it");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(storage[getAccountStorageKeys(settings).articles]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}

const refreshConfig = {
  serviceName: "wallabag",
  refreshUrl: "https://wallabag.example/oauth/v2/token",
  clientId: "client",
  clientSecret: "SECRET",
  refreshToken: "active-refresh",
};
for (const kind of ["server", "rate", "shape", "rejected"] as const) {
  test(`concurrent refresh shares its complete ${kind} result and preserves credential policy`, async () => {
    const tokens = new TokenManager({ persist: false, refreshCooldownMs: 0 });
    await runOperation(tokens.storeToken("wallabag", oldToken));
    const started = deferred<void>();
    const release = deferred<Response>();
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });
    const first = runOperation(tokens.refreshToken("wallabag", refreshConfig));
    const second = runOperation(tokens.refreshToken("wallabag", refreshConfig));
    await started.promise;
    release.resolve(
      kind === "rate"
        ? json({}, 429)
        : kind === "rejected"
          ? json({ error: "invalid_grant", error_description: "SECRET" }, 400)
          : kind === "shape"
            ? json({ access_token: "" })
            : json({}, 503),
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.success).toBe(false);
    expect(a.requiresReauth).toBe(kind === "rejected");
    expect(a.failure?._tag).toBe(
      kind === "rate"
        ? "RateLimitFailure"
        : kind === "rejected"
          ? "CredentialsFailure"
          : kind === "shape"
            ? "InvalidResponseFailure"
            : "HttpFailure",
    );
    expect(tokens.getTokenMetadata("wallabag")?.accessToken ?? null).toBe(
      kind === "rejected" ? null : "active-access",
    );
    expect(JSON.stringify(a)).not.toContain("SECRET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
}
test("repeated transient failures never erase credentials and expired tokens retain the last failure", async () => {
  const tokens = new TokenManager({ persist: false, refreshCooldownMs: 0, maxRefreshAttempts: 1 });
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, expiresAt: Date.now() + 60000 }));
  tokens.setRefreshConfigProvider("wallabag", () => refreshConfig);
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("SECRET"));
  for (let index = 0; index < 4; index++)
    expect((await runOperation(tokens.refreshToken("wallabag"))).requiresReauth).toBe(false);
  expect(await runOperation(tokens.getAccessToken("wallabag"))).toBe("active-access");
  expect(tokens.getTokenMetadata("wallabag")?.refreshCount).toBeGreaterThan(1);
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, expiresAt: Date.now() - 1 }));
  const result = await failure(tokens.getAccessToken("wallabag"));
  expect(result.code).toBe("NetworkFailure");
  expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
});
test("malformed token fields and ambiguous OAuth 400 responses preserve credentials", async () => {
  for (const response of [
    json({ ...token, expires_in: "3600" }),
    json({ ...token, expires_in: -1 }),
    json({ ...token, refresh_token: 42 }),
    json({ ...token, token_type: "Bearer SECRET\r\n" }),
    json({ error: "invalid_request", error_description: "SECRET" }, 400),
  ]) {
    const tokens = new TokenManager({ persist: false });
    await runOperation(tokens.storeToken("wallabag", oldToken));
    spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await runOperation(tokens.refreshToken("wallabag", refreshConfig));
    expect(result.success).toBe(false);
    expect(result.requiresReauth).toBe(false);
    expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});
test("token rotation is persisted before publication and used on the next refresh", async () => {
  const tokens = new TokenManager({ refreshCooldownMs: 0 });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const bodies: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body));
    return json(token);
  });
  expect((await runOperation(tokens.refreshToken("wallabag", refreshConfig))).success).toBe(true);
  expect(storage.api_tokens).toEqual([
    [
      "wallabag",
      expect.objectContaining({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }),
    ],
  ]);
  expect((await runOperation(tokens.refreshToken("wallabag", refreshConfig))).success).toBe(true);
  expect(bodies[1]).toContain("refresh_token=rotated-refresh");
});
test("a late refresh cannot install old-account credentials after replacement", async () => {
  const tokens = new TokenManager();
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const started = deferred<void>();
  const release = deferred<Response>();
  spyOn(globalThis, "fetch").mockImplementation(async () => {
    started.resolve();
    return release.promise;
  });
  const pending = runOperation(tokens.refreshToken("wallabag", refreshConfig));
  await started.promise;
  await runOperation(tokens.clearToken("wallabag"));
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, accessToken: "replacement" }));
  release.resolve(json(token));
  expect((await pending).success).toBe(false);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("replacement");
  expect(storage.api_tokens).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "replacement" })],
  ]);
});
test("cancelled refresh waiter and draft authentication cannot cancel or change active refresh", async () => {
  const active = new TokenManager();
  await runOperation(active.storeToken("wallabag", oldToken));
  const draft = new TokenManager({ persist: false });
  const started = deferred<void>();
  const release = deferred<Response>();
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(init?.body).includes("grant_type=refresh_token")) {
      started.resolve();
      return release.promise;
    }
    if (String(url).includes("oauth")) return json({ ...token, access_token: "draft-access" });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer draft-access");
    return json(snapshot());
  });
  const controller = new AbortController();
  const waiting = runOperation(
    active.refreshToken("wallabag", refreshConfig),
    controller.signal,
  ).catch((error: unknown) => error);
  await started.promise;
  const shared = runOperation(active.refreshToken("wallabag", refreshConfig));
  controller.abort();
  expect(await waiting).toBeInstanceOf(OperationInterrupted);
  const api = await runOperation(createWallabagAdapter(settings, draft));
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(active.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
  release.resolve(json(token));
  expect((await shared).success).toBe(true);
  expect(active.getTokenMetadata("wallabag")?.accessToken).toBe("rotated-access");
  expect(draft.getTokenMetadata("wallabag")?.accessToken).toBe("draft-access");
  expect(storage.api_tokens).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "rotated-access" })],
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
test("failed ready connection test preserves actionable typed reason instead of returning false", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  spyOn(globalThis, "fetch").mockResolvedValue(json({ secret: "SECRET" }));
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await failure(api.testConnection)).code).toBe("InvalidResponseFailure");
});

test("Wallabag retries an explicit auth rejection with the rotated required token", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const methods: string[] = [];
  const auth: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth")) {
      methods.push("refresh");
      expect(String(init?.body)).toContain("refresh_token=active-refresh");
      return json(token);
    }
    const header = new Headers(init?.headers).get("Authorization");
    auth.push(header);
    methods.push("save");
    return header === "Bearer active-access" ? json({}, 401) : json(item);
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await runOperation(api.saveArticle(item))).id).toBe("42");
  expect(methods).toEqual(["save", "refresh", "save"]);
  expect(auth).toEqual(["Bearer active-access", "Bearer rotated-access"]);
});
test("transient auth recovery does not repeat a mutation or attempt password authentication", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const methods: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth")) {
      methods.push(String(init?.body));
      throw new TypeError("SECRET");
    }
    methods.push("save");
    return json({}, 401);
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await failure(api.saveArticle(item))).code).toBe("NetworkFailure");
  expect(methods).toHaveLength(2);
  expect(methods[1]).toContain("grant_type=refresh_token");
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
});
test("definitive refresh rejection allows password authentication before retrying", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const grants: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth")) {
      const grant = new URLSearchParams(String(init?.body)).get("grant_type")!;
      grants.push(grant);
      return grant === "refresh_token" ? json({ error: "invalid_grant" }, 400) : json(token);
    }
    return new Headers(init?.headers).get("Authorization") === "Bearer active-access"
      ? json({}, 401)
      : json(item);
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await runOperation(api.saveArticle(item))).id).toBe("42");
  expect(grants).toEqual(["refresh_token", "password"]);
});
test("provider error envelope is a rejection and cannot claim mutation success", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    json({ error: "failure", error_description: "SECRET" }),
  );
  const result = await failure(request({ mutation: "save", init: { method: "POST" } }));
  expect(result.code).toBe("HttpFailure");
  expect(result.details).not.toHaveProperty("remoteOutcome");
  expect(result.error).not.toContain("succeeded");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
test("malformed persisted required token fails before any authenticated request", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, accessToken: "" }));
  const fetchMock = spyOn(globalThis, "fetch");
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await failure(api.testConnection)).code).toBe("InvalidResponseFailure");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("repository sync retains typed missing permission at acquisition", async () => {
  const tokens = new TokenManager({ persist: false });
  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  granted = false;
  const fetchMock = spyOn(globalThis, "fetch");
  const result = await runOperation(repo.syncWithAPI()).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({
    code: "PermissionFailure",
    details: { permission: "server access" },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("late password authentication cannot publish or use replacement-account credentials", async () => {
  const tokens = new TokenManager();
  const started = deferred<void>();
  const release = deferred<Response>();
  const headers: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth")) {
      if (String(url).includes("wallabag.example")) {
        started.resolve();
        return release.promise;
      }
      return json({ ...token, access_token: "B-access" });
    }
    headers.push(new Headers(init?.headers).get("Authorization")!);
    expect(String(url)).toContain("replacement.example");
    return json(snapshot());
  });
  const pending = failure(createWallabagAdapter(settings, tokens));
  await started.promise;
  await runOperation(tokens.clearToken("wallabag"));
  const replacement = await runOperation(
    createWallabagAdapter(
      {
        ...settings,
        apiConfig: { ...settings.apiConfig, url: "https://replacement.example", username: "B" },
      },
      tokens,
    ),
  );
  release.resolve(json({ ...token, access_token: "A-access" }));
  expect((await pending).code).toBe("CredentialsFailure");
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("B-access");
  expect(storage.api_tokens).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "B-access" })],
  ]);
  expect(await runOperation(replacement.testConnection)).toBe(true);
  expect(headers).toEqual(["Bearer B-access"]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("a stale ready adapter cannot send the replacement token to its old server", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const stale = await runOperation(createWallabagAdapter(settings, tokens));
  await runOperation(tokens.clearToken("wallabag"));
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("oauth")) return json(token);
    expect(String(url)).toContain("replacement.example");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rotated-access");
    return json(snapshot());
  });
  const current = await runOperation(
    createWallabagAdapter(
      {
        ...settings,
        apiConfig: { ...settings.apiConfig, url: "https://replacement.example" },
      },
      tokens,
    ),
  );
  expect((await failure(stale.testConnection)).code).toBe("CredentialsFailure");
  expect(await runOperation(current.testConnection)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

for (const succeeds of [true, false]) {
  test(`token without refresh capability has bounded password recovery (${succeeds})`, async () => {
    const tokens = new TokenManager();
    let passwordCalls = 0;
    let apiCalls = 0;
    spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("oauth")) {
        expect(String(init?.body)).toContain("grant_type=password");
        passwordCalls++;
        return json({ access_token: `access-${passwordCalls}`, expires_in: 3600 });
      }
      apiCalls++;
      return succeeds && apiCalls > 1 ? json(item) : json({}, 401);
    });
    const api = await runOperation(createWallabagAdapter(settings, tokens));
    if (succeeds) {
      expect((await runOperation(api.saveArticle(item))).id).toBe("42");
      expect(apiCalls).toBe(2);
      expect(passwordCalls).toBe(2);
      expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("access-2");
    } else {
      expect((await failure(api.saveArticle(item))).code).toBe("CredentialsFailure");
      expect(apiCalls).toBe(3);
      expect(passwordCalls).toBe(3);
      expect(tokens.getTokenMetadata("wallabag")).toBeNull();
      await runOperation(createWallabagAdapter(settings, tokens));
      expect(passwordCalls).toBe(4);
    }
  });
}

for (const invalid of ["bad\r\ntoken", "bad\ntoken", "bad\u0100token", "token\r\n"]) {
  test(`OAuth and persisted bearer validation reject unusable header ${JSON.stringify(invalid)}`, async () => {
    const tokens = new TokenManager({ persist: false });
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(json({ access_token: invalid }));
    const oauth = await failure(createWallabagAdapter(settings, tokens));
    expect(oauth.code).toBe("InvalidResponseFailure");
    expect(oauth.details).toMatchObject({ responseKind: "token" });
    expect(tokens.getTokenMetadata("wallabag")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await runOperation(tokens.storeToken("wallabag", { ...oldToken, accessToken: invalid }));
    const api = await runOperation(createWallabagAdapter(settings, tokens));
    fetchMock.mockClear();
    const persisted = await failure(api.saveArticle(item));
    expect(persisted.code).toBe("InvalidResponseFailure");
    expect(persisted.details).toMatchObject({ responseKind: "token" });
    expect(persisted.details).not.toHaveProperty("remoteOutcome");
    expect(fetchMock).not.toHaveBeenCalled();
  });
}

test("header preflight failure does not mark a mutation as submitted", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  for (const options of [
    { authorization: Effect.succeed("Bearer bad\r\ntoken") },
    { init: { headers: { "bad header": "value" } } },
  ]) {
    const result = await failure(request({ mutation: "save", ...options }));
    expect(result.code).toBe("InvalidResponseFailure");
    expect(result.details).not.toHaveProperty("remoteOutcome");
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("sync decision diagnostics precede a failed first page without account secrets", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const { logger } = await import("../src/utils/logger");
  const log = spyOn(logger, "info");
  const timestamp = Date.now() - 86400001;
  spyOn(globalThis, "fetch").mockImplementation(async () => {
    expect(log).toHaveBeenCalledWith("Wallabag sync mode decision", {
      mode: "overwrite",
      reason: "24h_idle",
      timeSinceLastFullSync: expect.any(Number),
      isBrowserIdle: true,
    });
    throw new TypeError("SECRET");
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect(
    (await failure(api.sync({ lastFullSyncTimestamp: timestamp, isBrowserIdle: true }))).code,
  ).toBe("NetworkFailure");
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|PASSWORD|wallabag\.example/);
});

test("account invalidation gates an authentication commit queued behind persistence", async () => {
  const tokens = new TokenManager();
  const generation = await runOperation(tokens.bindAccount("wallabag", "A"));
  const started = deferred<void>();
  const release = deferred<void>();
  browser.storage.local.set = async (data) => {
    started.resolve();
    await release.promise;
    Object.assign(storage, data);
  };
  const blocker = runOperation(tokens.storeToken("other", oldToken));
  await started.promise;
  const stale = runOperation(
    tokens.storeToken("wallabag", oldToken, undefined, undefined, generation),
  ).catch((error: unknown) => error);
  const clearing = runOperation(tokens.clearToken("wallabag"));
  release.resolve();
  await blocker;
  expect(await stale).toBeInstanceOf(CredentialsFailure);
  await clearing;
  expect(tokens.getTokenMetadata("wallabag")).toBeNull();
});

test("late rejection does not clear a newer token without refresh capability", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, refreshToken: "" }));
  const started = deferred<void>();
  const release = deferred<Response>();
  let calls = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (++calls === 1) {
      started.resolve();
      return release.promise;
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer replacement");
    return json(snapshot());
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const pending = runOperation(api.testConnection);
  await started.promise;
  await runOperation(tokens.storeToken("wallabag", {
    ...oldToken,
    refreshToken: "",
    accessToken: "replacement",
  }));
  release.resolve(json({}, 401));
  // The newer token has not been rejected: retry directly with it without a password grant.
  expect(await pending).toBe(true);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("replacement");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("replacement during acquisition permission cannot reclaim account ownership", async () => {
  const tokens = new TokenManager({ persist: false });
  const started = deferred<void>();
  const release = deferred<boolean>();
  browser.permissions.contains = async ({ origins }) => {
    if (origins?.[0]?.includes("wallabag.example")) {
      started.resolve();
      return release.promise;
    }
    return true;
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toContain("replacement.example");
    return String(url).includes("oauth") ? json(token) : json(snapshot());
  });
  const pending = failure(createWallabagAdapter(settings, tokens));
  await started.promise;
  const current = await runOperation(
    createWallabagAdapter(
      {
        ...settings,
        apiConfig: { ...settings.apiConfig, url: "https://replacement.example" },
      },
      tokens,
    ),
  );
  release.resolve(true);
  expect((await pending).code).toBe("CredentialsFailure");
  expect(await runOperation(current.testConnection)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("missing refresh capability preserves a current token until expiry and discards it once expired", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", {
    ...oldToken,
    refreshToken: "",
    expiresAt: Date.now() + 60000,
  }));
  const fetchMock = spyOn(globalThis, "fetch");
  expect(await runOperation(tokens.getAccessToken("wallabag"))).toBe("active-access");
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, refreshToken: "", expiresAt: Date.now() - 1 }));
  expect(await runOperation(tokens.getAccessToken("wallabag")).catch((error: unknown) => error)).toBeInstanceOf(
    CredentialsFailure,
  );
  expect(tokens.getTokenMetadata("wallabag")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("concurrent replacement acquisitions wait for the previous account's token deletion", async () => {
  const tokens = new TokenManager();
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, accessToken: "A-token" }));
  await runOperation(createWallabagAdapter(settings, tokens));
  const replacement: WallabagSettings = {
    ...settings,
    apiConfig: { ...settings.apiConfig, url: "https://B.example", username: "B" },
  };
  const started = deferred<void>();
  const release = deferred<void>();
  browser.storage.local.set = async (data) => {
    started.resolve();
    await release.promise;
    Object.assign(storage, data);
  };
  const headers: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(String(url)).toContain("B.example");
    if (String(url).includes("oauth")) return json({ ...token, access_token: "B-token" });
    headers.push(new Headers(init?.headers).get("Authorization")!);
    return json(snapshot());
  });
  const first = runOperation(createWallabagAdapter(replacement, tokens));
  await started.promise;
  let secondReady = false;
  const second = runOperation(createWallabagAdapter(replacement, tokens)).then((api) => {
    secondReady = true;
    return api;
  });
  for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  expect(secondReady).toBe(false);
  release.resolve();
  await first;
  expect(await runOperation((await second).testConnection)).toBe(true);
  expect(headers).toEqual(["Bearer B-token"]);
  expect(storage.api_tokens).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "B-token" })],
  ]);
});

test("invalidation during acquisition token persistence fails the acquisition", async () => {
  const tokens = new TokenManager();
  const started = deferred<void>();
  const release = deferred<void>();
  browser.storage.local.set = async (data) => {
    started.resolve();
    await release.promise;
    Object.assign(storage, data);
  };
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => json(token));
  const pending = failure(createWallabagAdapter(settings, tokens));
  await started.promise;
  const clearing = runOperation(tokens.clearToken("wallabag"));
  release.resolve();
  expect((await pending).code).toBe("CredentialsFailure");
  await clearing;
  expect(tokens.getTokenMetadata("wallabag")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cold-start Wallabag evicts Account A's persisted token when synced to Account B without persisting secrets", async () => {
  const accountB: WallabagSettings = {
    ...settings,
    apiConfig: {
      url: "https://account-b.example",
      clientId: "client-b",
      clientSecret: "SUPER_SECRET_B",
      username: "user-b",
      password: "SUPER_PASSWORD_B",
    },
  };
  // Persist a token bound to Account A in a first TokenManager instance.
  const firstRun = new TokenManager();
  await runOperation(firstRun.bindAccount("wallabag", JSON.stringify(settings.apiConfig)));
  await runOperation(
    firstRun.storeToken("wallabag", { ...oldToken, accessToken: "account-a-access" }),
  );

  // Cold start: fresh TokenManager loads Account A's persisted token, then binds Account B.
  const secondRun = new TokenManager();
  await runOperation(secondRun.loadTokens);
  expect(secondRun.getTokenMetadata("wallabag")?.accessToken).toBe("account-a-access");

  const sentAuthHeaders: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/oauth/v2/token")) {
      expect(String(url)).toBe("https://account-b.example/oauth/v2/token");
      return json({ ...token, access_token: "account-b-access" });
    }
    sentAuthHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
    expect(String(url)).toStartWith("https://account-b.example/");
    return json(snapshot());
  });

  const api = await runOperation(createWallabagAdapter(accountB, secondRun));
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(sentAuthHeaders).toEqual(["Bearer account-b-access"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  const persistedJson = JSON.stringify(storage.api_tokens);
  expect(persistedJson).not.toContain("SUPER_PASSWORD_B");
  expect(persistedJson).not.toContain("SUPER_SECRET_B");
  expect(persistedJson).not.toContain("account-b.example");
  expect(persistedJson).not.toContain("user-b");
  expect(persistedJson).toContain(await hashAccountIdentity(JSON.stringify(accountB.apiConfig)));
});

test("cold-start Wallabag evicts legacy persisted token without accountIdentityHash and re-authenticates", async () => {
  const { accountIdentityHash: _omit, ...legacyToken } = oldToken;
  storage.api_tokens = [["wallabag", { ...legacyToken, serviceName: "wallabag" }]];
  const tokens = new TokenManager();
  await runOperation(tokens.loadTokens);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/oauth/v2/token")) {
      return json({ ...token, access_token: "reauthed-access" });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer reauthed-access");
    return json(snapshot());
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(tokens.getTokenMetadata("wallabag")?.accountIdentityHash).toBe(settingsIdentityHash);
});

test("Wallabag accepts v2 tagged entries and nullable fields across sync, testConnection, and saveArticle", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const taggedEntry = {
    id: 101,
    title: null,
    url: "https://tagged.example/post",
    created_at: "2026-02-01T10:00:00Z",
    domain_name: null,
    reading_time: 5,
    tags: [{ id: 1, label: "reading", slug: "reading" }],
  };
  const missingUrlEntry = {
    id: 102,
    title: "Orphan entry",
    url: null,
    created_at: "2026-02-01T11:00:00Z",
    domain_name: null,
    tags: [{ id: 2, label: "later", slug: "later" }],
  };
  const savedEntryWithNullFields = {
    id: 103,
    title: null,
    url: null,
    created_at: "2026-02-01T12:00:00Z",
    domain_name: null,
    tags: [{ id: 1, label: "reading", slug: "reading" }],
  };

  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "POST") return json(savedEntryWithNullFields);
    return json(snapshot([taggedEntry, missingUrlEntry], 2));
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect(await runOperation(api.testConnection)).toBe(true);

  const synced = await runOperation(api.sync());
  expect(synced.articles).toEqual([
    {
      id: "101",
      title: "https://tagged.example/post",
      url: "https://tagged.example/post",
      created_at: "2026-02-01T10:00:00Z",
    },
  ]);

  const saved = await runOperation(
    api.saveArticle({ url: "https://saved.example/page", title: "Saved Page" }),
  );
  expect(saved).toEqual({
    id: "103",
    title: "https://saved.example/page",
    url: "https://saved.example/page",
    created_at: "2026-02-01T12:00:00Z",
  });
});

test("Wallabag saveArticle omits empty title and includes non-empty title in POST body", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const bodies: Record<string, unknown>[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json(item);
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  await runOperation(api.saveArticle({ url: "https://article.example/1", title: "" }));
  await runOperation(api.saveArticle({ url: "https://article.example/2", title: "   " }));
  await runOperation(api.saveArticle({ url: "https://article.example/3", title: "Explicit Title" }));

  expect(bodies).toEqual([
    { url: "https://article.example/1" },
    { url: "https://article.example/2" },
    { url: "https://article.example/3", title: "Explicit Title" },
  ]);
  expect("title" in bodies[0]!).toBe(false);
  expect("title" in bodies[1]!).toBe(false);
});

test("Wallabag saveArticle treats unexpected 200 OK JSON as InvalidResponseFailure with unknown outcome", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(json({ ok: true }));

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const result = await failure(api.saveArticle({ url: item.url, title: item.title }));

  expect(result.code).toBe("InvalidResponseFailure");
  expect(result.details).toMatchObject({
    remoteOperation: "save",
    remoteOutcome: "unknown",
  });
  expect(result.details).not.toMatchObject({ remoteOutcome: "succeeded" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("Wallabag sync tracks dynamic pages, deduplicates entries, and runs without 1s pacing", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const requestedPages: number[] = [];
  const start = Date.now();
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("perPage")).toBe("150");
    expect(parsed.searchParams.get("detail")).toBe("metadata");
    expect(parsed.searchParams.get("sort")).toBe("created");
    expect(parsed.searchParams.get("order")).toBe("asc");
    const pageNum = Number(parsed.searchParams.get("page"));
    requestedPages.push(pageNum);
    if (pageNum === 1) {
      return json(
        snapshot(
          [
            { ...item, id: 1, title: "First", url: "https://article.example/1" },
            { ...item, id: 2, title: "Second v1", url: "https://article.example/2" },
          ],
          300,
          2,
          1,
        ),
      );
    }
    if (pageNum === 2) {
      // Mid-sync insert grows pages from 2 to 3, and id 2 overlaps across page boundary.
      return json(
        snapshot(
          [
            { ...item, id: "2", title: "Second v2", url: "https://article.example/2" },
            { ...item, id: 3, title: "Third", url: "https://article.example/3" },
          ],
          350,
          3,
          2,
        ),
      );
    }
    return json(
      snapshot([{ ...item, id: 4, title: "Fourth", url: "https://article.example/4" }], 350, 3, 3),
    );
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const synced = await runOperation(api.sync());
  const elapsedMs = Date.now() - start;

  expect(requestedPages).toEqual([1, 2, 3]);
  expect(synced.articles.map((a) => [a.id, a.title])).toEqual([
    ["1", "First"],
    ["2", "Second v2"],
    ["3", "Third"],
    ["4", "Fourth"],
  ]);
  expect(synced.metadata.totalFetched).toBe(4);
  expect(synced.metadata.totalProcessed).toBe(4);
  // 3 pages without the removed 1000ms pacing semaphore completes well under 1 second.
  expect(elapsedMs).toBeLessThan(800);
});

test("Wallabag sync stops cleanly on empty page or trailing 404, while page 1 404 still fails", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));

  // Case 1: Trailing page returns 404 after mid-sync deletions shrink total pages.
  const trailing404Pages: number[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const pageNum = Number(new URL(String(url)).searchParams.get("page"));
    trailing404Pages.push(pageNum);
    if (pageNum === 1) {
      return json(snapshot([{ ...item, id: 10, url: "https://article.example/10" }], 300, 3, 1));
    }
    if (pageNum === 2) {
      return json(snapshot([{ ...item, id: 11, url: "https://article.example/11" }], 300, 3, 2));
    }
    return json({ error: "not_found" }, 404);
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const after404 = await runOperation(api.sync());
  expect(trailing404Pages).toEqual([1, 2, 3]);
  expect(after404.articles.map((a) => a.id)).toEqual(["10", "11"]);

  // Case 2: Subsequent page returns empty items even if pages claims more.
  const emptyPageCalls: number[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const pageNum = Number(new URL(String(url)).searchParams.get("page"));
    emptyPageCalls.push(pageNum);
    if (pageNum === 1) {
      return json(snapshot([{ ...item, id: 20, url: "https://article.example/20" }], 400, 4, 1));
    }
    return json(snapshot([], 400, 4, pageNum));
  });
  const afterEmpty = await runOperation(api.sync());
  expect(emptyPageCalls).toEqual([1, 2]);
  expect(afterEmpty.articles.map((a) => a.id)).toEqual(["20"]);

  // Case 3: Page 1 returning 404 still fails with HttpFailure.
  spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not_found" }, 404));
  const page1Error = await failure(api.sync());
  expect(page1Error.code).toBe("HttpFailure");
});

test("Wallabag sync cancellation aborts an in-flight second page fetch cleanly", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const page2Started = deferred<void>();
  let page2Signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const pageNum = Number(new URL(String(url)).searchParams.get("page"));
    if (pageNum === 1) {
      return json(snapshot([{ ...item, id: 1 }], 300, 2, 1));
    }
    page2Signal = init?.signal ?? undefined;
    page2Started.resolve();
    return new Promise<Response>(() => {});
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const controller = new AbortController();
  const result = failure(api.sync(), controller.signal);
  await page2Started.promise;
  controller.abort();

  expect((await result).code).toBe("OPERATION_INTERRUPTED");
  expect(page2Signal?.aborted).toBe(true);
});

test("Wallabag incremental since subtracts 120s overlap and clamps at 0", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const sinceValues: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    sinceValues.push(new URL(String(url)).searchParams.get("since"));
    return json(snapshot([], 0, 0, 1));
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  await runOperation(
    api.sync({
      lastFullSyncTimestamp: Date.now(),
      lastSyncTimestamp: "2026-01-01T00:00:00Z",
    }),
  );
  await runOperation(
    api.sync({
      lastFullSyncTimestamp: Date.now(),
      lastSyncTimestamp: "1970-01-01T00:00:30Z",
    }),
  );

  expect(sinceValues).toEqual(["1767225480", "0"]);
});

test("Wallabag DELETE 404 succeeds idempotently and removes stale entry from repository cache", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const keys = getAccountStorageKeys(settings);
  storage[keys.articles] = [
    { id: "42", title: "Stale", url: "https://article.example", created_at: "2026-01-01T00:00:00Z" },
    { id: "99", title: "Keep", url: "https://keep.example", created_at: "2026-01-02T00:00:00Z" },
  ];

  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(init?.method).toBe("DELETE");
    return json({ error: "not_found" }, 404);
  });

  const repo = new ArticlesRepository(tokens);
  await repo.initialize(settings);
  await runOperation(repo.deleteArticle("42"));
  expect((storage[keys.articles] as { id: string }[]).map((a) => a.id)).toEqual(["99"]);

  // A post-delete local read failure after 404 still reports remoteOutcome: "succeeded".
  const repo2 = new ArticlesRepository(tokens);
  await repo2.initialize(settings);
  rejectReads = true;
  const readFailed = await failure(repo2.deleteArticle("99"));
  expect(readFailed.code).toBe("BrowserFailure");
  expect(readFailed.details).toMatchObject({
    remoteOperation: "delete",
    remoteOutcome: "succeeded",
  });

  // Non-404 DELETE failures (e.g. 500) still fail with HttpFailure.
  rejectReads = false;
  spyOn(globalThis, "fetch").mockResolvedValue(json({}, 500));
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await failure(api.deleteArticle("99"))).code).toBe("HttpFailure");
});

test("expired refreshless Wallabag token triggers password re-authentication instead of wedging", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(
    tokens.storeToken("wallabag", {
      ...oldToken,
      refreshToken: "",
      expiresAt: Date.now() - 1000,
    }),
  );
  const grants: string[] = [];
  const authHeaders: (string | null)[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/oauth/v2/token")) {
      grants.push(new URLSearchParams(String(init?.body)).get("grant_type") ?? "");
      return json({ access_token: "fresh-refreshless", expires_in: 3600, token_type: "Bearer" });
    }
    authHeaders.push(new Headers(init?.headers).get("Authorization"));
    return json(snapshot());
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(grants).toEqual(["password"]);
  expect(authHeaders).toEqual(["Bearer fresh-refreshless"]);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("fresh-refreshless");
});

test("concurrent 401s deduplicate password authentication into a single grant_type=password request", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(tokens.storeToken("wallabag", { ...oldToken, refreshToken: "" }));
  const both401Sent = deferred<void>();
  const releaseAuth = deferred<Response>();
  const authStarted = deferred<void>();
  let initial401Count = 0;
  let passwordGrants = 0;
  let apiCalls = 0;

  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/oauth/v2/token")) {
      expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("password");
      passwordGrants++;
      authStarted.resolve();
      return releaseAuth.promise;
    }
    apiCalls++;
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth === "Bearer active-access") {
      if (++initial401Count === 2) both401Sent.resolve();
      await both401Sent.promise;
      return json({}, 401);
    }
    expect(auth).toBe("Bearer deduped-access");
    return json(snapshot());
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  const first = runOperation(api.testConnection);
  const second = runOperation(api.testConnection);
  await authStarted.promise;
  // Let the second fiber reach the single-flight authenticate lock before resolving.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  releaseAuth.resolve(json({ access_token: "deduped-access", expires_in: 3600, token_type: "Bearer" }));

  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(passwordGrants).toBe(1);
  expect(apiCalls).toBe(4);
});

test("concurrent 401 skips redundant refresh when another request already rotated the access token", async () => {
  const tokens = new TokenManager({ persist: false, refreshCooldownMs: 0 });
  await runOperation(tokens.storeToken("wallabag", oldToken));
  const req2Started = deferred<void>();
  const releaseReq2 = deferred<Response>();
  let firstRequestSeen = false;
  let refreshCalls = 0;
  const authHeaders: string[] = [];

  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("/oauth/v2/token")) {
      refreshCalls++;
      expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
      return json(token);
    }
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    authHeaders.push(auth);
    if (auth === "Bearer active-access") {
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        return json({}, 401);
      }
      req2Started.resolve();
      return releaseReq2.promise;
    }
    expect(auth).toBe("Bearer rotated-access");
    return json(snapshot());
  });

  const api = await runOperation(createWallabagAdapter(settings, tokens));
  // Start both requests concurrently so both capture "Bearer active-access".
  const first = runOperation(api.testConnection);
  const second = runOperation(api.testConnection);
  await req2Started.promise;
  // Wait for first request to finish refreshing and succeeding with "rotated-access".
  expect(await first).toBe(true);
  expect(refreshCalls).toBe(1);
  // Now resolve the second request's stale 401; it should skip refresh and retry with rotated-access.
  releaseReq2.resolve(json({}, 401));
  expect(await second).toBe(true);
  expect(refreshCalls).toBe(1);
  expect(authHeaders).toEqual([
    "Bearer active-access",
    "Bearer active-access",
    "Bearer rotated-access",
    "Bearer rotated-access",
  ]);
});

for (const [inputUrl, expectedBase] of [
  ["https://wallabag.example/api", "https://wallabag.example"],
  ["https://wallabag.example/API/", "https://wallabag.example"],
  ["https://wallabag.example/api///", "https://wallabag.example"],
  ["https://wallabag.example///", "https://wallabag.example"],
  ["https://wallabag.example/wallabag/", "https://wallabag.example/wallabag"],
  ["https://wallabag.example/wallabag/api", "https://wallabag.example/wallabag"],
  ["https://wallabag.example/wallabag/API///", "https://wallabag.example/wallabag"],
] as const) {
  test(`Wallabag normalizes base URL ${inputUrl} -> ${expectedBase}`, async () => {
    const tokens = new TokenManager({ persist: false });
    const urls: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      urls.push(String(url));
      if (String(url).includes("/oauth/v2/token")) return json(token);
      return json(snapshot());
    });

    const api = await runOperation(
      createWallabagAdapter(
        {
          ...settings,
          apiConfig: { ...settings.apiConfig, url: inputUrl },
        },
        tokens,
      ),
    );
    expect(await runOperation(api.testConnection)).toBe(true);
    expect(urls).toEqual([
      `${expectedBase}/oauth/v2/token`,
      `${expectedBase}/api/entries.json?page=1&perPage=1&detail=metadata`,
    ]);
  });
}

test("Wallabag sync preserves given_url and matches both original and redirected URLs", async () => {
  await initializeWithRawFilterLists([{ name: "rules", content: "$removeparam=utm_source" }]);
  clearCanonicalUrlCache();

  const syncedItems = [
    {
      id: 201,
      title: "Redirected Article",
      url: "https://dest.example/full-article?utm_source=wallabag",
      given_url: "https://short.example/abc?utm_source=feed",
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      id: 202,
      title: "Given Only",
      url: null,
      given_url: "https://given-only.example/post",
      created_at: "2026-03-01T01:00:00Z",
    },
    {
      id: 203,
      title: "Same URL",
      url: "https://same.example/post",
      given_url: "https://same.example/post",
      created_at: "2026-03-01T02:00:00Z",
    },
    {
      id: 204,
      title: "Null given_url",
      url: "https://legacy-null.example/post",
      given_url: null,
      created_at: "2026-03-01T03:00:00Z",
    },
    {
      id: 205,
      title: "Absent given_url",
      url: "https://legacy-absent.example/post",
      created_at: "2026-03-01T04:00:00Z",
    },
  ];

  spyOn(globalThis, "fetch").mockImplementation(async () => json(snapshot(syncedItems)));

  for (const normalizeOnCompare of [false, true]) {
    storage = {};
    const tokens = new TokenManager({ persist: false });
    await runOperation(tokens.storeToken("wallabag", oldToken));
    const repo = new ArticlesRepository(tokens);
    repo.initialize({ ...settings, normalizeOnCompare });

    const synced = await runOperation(repo.syncWithAPI({ mode: "overwrite" }));
    expect(synced.items).toHaveLength(5);

    const redirected = synced.items.find((a) => a.id === "201");
    expect(redirected?.url).toBe("https://dest.example/full-article?utm_source=wallabag");
    expect(redirected?.givenUrl).toBe("https://short.example/abc?utm_source=feed");

    const givenOnly = synced.items.find((a) => a.id === "202");
    expect(givenOnly?.url).toBe("https://given-only.example/post");
    expect(givenOnly?.givenUrl).toBeUndefined();

    for (const id of ["203", "204", "205"]) {
      expect(synced.items.find((a) => a.id === id)?.givenUrl).toBeUndefined();
    }

    // Both original given_url and resolved url match in both comparison modes.
    expect(
      (await runOperation(repo.findSaved("https://short.example/abc?utm_source=feed")))?.id,
    ).toBe("201");
    expect(
      (await runOperation(repo.findSaved("https://dest.example/full-article?utm_source=wallabag")))
        ?.id,
    ).toBe("201");
    expect((await runOperation(repo.findSaved("https://given-only.example/post")))?.id).toBe("202");
    expect((await runOperation(repo.findSaved("https://legacy-null.example/post")))?.id).toBe(
      "204",
    );
    expect((await runOperation(repo.findSaved("https://legacy-absent.example/post")))?.id).toBe(
      "205",
    );

    if (normalizeOnCompare) {
      expect(
        (await runOperation(repo.findSaved("https://short.example/abc?utm_source=other")))?.id,
      ).toBe("201");
      expect((await runOperation(repo.findSaved("https://short.example/abc")))?.id).toBe("201");
      expect((await runOperation(repo.findSaved("https://dest.example/full-article")))?.id).toBe(
        "201",
      );
      expect(
        (await runOperation(repo.findSaved("https://dest.example/full-article?utm_source=other")))
          ?.id,
      ).toBe("201");
    } else {
      expect(await runOperation(repo.findSaved("https://short.example/abc"))).toBeUndefined();
      expect(
        await runOperation(repo.findSaved("https://dest.example/full-article")),
      ).toBeUndefined();
    }
  }
});

for (const responseGivenUrl of ["https://short.example/go", null, undefined] as const) {
  test(`Wallabag saveArticle matches redirected URL immediately and toggles off (given_url=${String(responseGivenUrl)})`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const tokens = new TokenManager({ persist: false });
    await runOperation(tokens.storeToken("wallabag", oldToken));

    let postCalls = 0;
    let deleteCalls = 0;
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        postCalls++;
        const payload: Record<string, unknown> = {
          id: 301,
          title: "Redirected Target",
          url: "https://target.example/canonical-path/",
          created_at: "2026-03-02T00:00:00Z",
        };
        if (responseGivenUrl !== undefined) payload.given_url = responseGivenUrl;
        return json(payload);
      }
      if (init?.method === "DELETE") {
        deleteCalls++;
        return new Response(null, { status: 204 });
      }
      return json(snapshot([]));
    });

    const repo = new ArticlesRepository(tokens);
    repo.initialize({ ...settings, normalizeOnCompare: false });

    const originalUrl = "https://short.example/go";
    const redirectedUrl = "https://target.example/canonical-path/";
    const saved = await runOperation(
      repo.saveArticle({ url: originalUrl, title: "Short Link" }),
    );
    expect(saved.id).toBe("301");
    expect(saved.url).toBe(redirectedUrl);
    expect(saved.givenUrl).toBe(originalUrl);
    expect(postCalls).toBe(1);

    // Matches both the submitted tab URL and the redirected URL immediately.
    const foundByOriginal = await runOperation(repo.findSaved(originalUrl));
    expect(foundByOriginal?.id).toBe("301");
    expect((await runOperation(repo.findSaved(redirectedUrl)))?.id).toBe("301");

    // Re-saving the original URL hits local cache without another POST.
    const duplicate = await runOperation(
      repo.saveArticle({ url: originalUrl, title: "Short Link" }),
    );
    expect(duplicate.id).toBe("301");
    expect(postCalls).toBe(1);

    // Toggling off via the original tab URL deletes the entry and clears both keys.
    await runOperation(repo.deleteArticle(foundByOriginal!.id));
    expect(deleteCalls).toBe(1);
    expect(await runOperation(repo.findSaved(originalUrl))).toBeUndefined();
    expect(await runOperation(repo.findSaved(redirectedUrl))).toBeUndefined();
  });
}
