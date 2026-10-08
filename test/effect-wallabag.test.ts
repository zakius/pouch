import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { createWallabagAdapter } from "../src/background/api/adapters/wallabag-adapter";
import { requestJson, retryAfterDelay } from "../src/background/api/effect-api-client";
import {
  CredentialsFailure,
  OperationInterrupted,
  fromLegacyPromise,
  runOperation,
} from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
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
const oldToken = {
  accessToken: "active-access",
  refreshToken: "active-refresh",
  tokenType: "Bearer",
  expiresAt: Date.now() + 3600000,
  issuedAt: Date.now(),
  refreshCount: 0,
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
const snapshot = (items = [item], total = items.length) => ({
  _embedded: { items },
  limit: 30,
  page: 1,
  pages: Math.ceil(total / 30),
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
test("ready Wallabag saves, deletes, tests, and paginates full and incremental sync", async () => {
  const tokens = new TokenManager({ persist: false });
  await tokens.storeToken("wallabag", oldToken);
  const urls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    urls.push(String(url));
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer active-access");
    if (init?.method === "POST") return json({ ...item, id: "18446744073709551616" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json(snapshot([item], String(url).includes("page=2") ? 31 : 31));
  });
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await runOperation(api.saveArticle({ url: item.url, title: item.title }))).id).toBe(
    "18446744073709551616",
  );
  await runOperation(api.deleteArticle("42"));
  expect(await runOperation(api.testConnection)).toBe(true);
  const full = await runOperation(api.sync());
  expect(full.mode).toBe("overwrite");
  expect(full.articles).toHaveLength(2);
  const incremental = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now(), lastSyncTimestamp: "2026-01-01T00:00:00Z" }),
  );
  expect(incremental.mode).toBe("update");
  expect(urls.slice(-2).every((url) => url.includes("since=1767225600"))).toBe(true);
  const idle = await runOperation(
    api.sync({ lastFullSyncTimestamp: Date.now() - 86400001, isBrowserIdle: true }),
  );
  expect(idle.mode).toBe("overwrite");
  expect(urls.at(-1)).not.toContain("since=");
}, 15000);
for (const operation of ["save", "delete"] as const) {
  test(`confirmed ${operation} survives post-mutation local-read failure with safe runtime advice`, async () => {
    setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
    await initializeUrlCanonizer();
    const tokens = new TokenManager({ persist: false });
    await tokens.storeToken("wallabag", oldToken);
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : json(item),
    );
    const repo = new ArticlesRepository(tokens);
    await repo.initialize(settings);
    rejectReads = true;
    const result = await failure(
      operation === "save" ? repo.saveArticleEffect(item) : repo.deleteArticleEffect("42"),
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
    await tokens.storeToken("wallabag", oldToken);
    const started = deferred<void>();
    const release = deferred<Response>();
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      return release.promise;
    });
    const first = tokens.refreshToken("wallabag", refreshConfig);
    const second = tokens.refreshToken("wallabag", refreshConfig);
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
  await tokens.storeToken("wallabag", { ...oldToken, expiresAt: Date.now() + 60000 });
  tokens.setRefreshConfigProvider("wallabag", () => refreshConfig);
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("SECRET"));
  for (let index = 0; index < 4; index++)
    expect((await tokens.refreshToken("wallabag")).requiresReauth).toBe(false);
  expect(await tokens.getAccessToken("wallabag")).toBe("active-access");
  expect(tokens.getTokenMetadata("wallabag")?.refreshCount).toBeGreaterThan(1);
  await tokens.storeToken("wallabag", { ...oldToken, expiresAt: Date.now() - 1 });
  const result = await failure(fromLegacyPromise(() => tokens.getAccessToken("wallabag")));
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
    await tokens.storeToken("wallabag", oldToken);
    spyOn(globalThis, "fetch").mockResolvedValue(response);
    const result = await tokens.refreshToken("wallabag", refreshConfig);
    expect(result.success).toBe(false);
    expect(result.requiresReauth).toBe(false);
    expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});
test("token rotation is persisted before publication and used on the next refresh", async () => {
  const tokens = new TokenManager({ refreshCooldownMs: 0 });
  await tokens.storeToken("wallabag", oldToken);
  const bodies: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(String(init?.body));
    return json(token);
  });
  expect((await tokens.refreshToken("wallabag", refreshConfig)).success).toBe(true);
  expect(storage.api_tokens).toEqual([
    [
      "wallabag",
      expect.objectContaining({ accessToken: "rotated-access", refreshToken: "rotated-refresh" }),
    ],
  ]);
  expect((await tokens.refreshToken("wallabag", refreshConfig)).success).toBe(true);
  expect(bodies[1]).toContain("refresh_token=rotated-refresh");
});
test("a late refresh cannot install old-account credentials after replacement", async () => {
  const tokens = new TokenManager();
  await tokens.storeToken("wallabag", oldToken);
  const started = deferred<void>();
  const release = deferred<Response>();
  spyOn(globalThis, "fetch").mockImplementation(async () => {
    started.resolve();
    return release.promise;
  });
  const pending = tokens.refreshToken("wallabag", refreshConfig);
  await started.promise;
  await tokens.clearAllTokens();
  await tokens.storeToken("wallabag", { ...oldToken, accessToken: "replacement" });
  release.resolve(json(token));
  expect((await pending).success).toBe(false);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("replacement");
  expect(storage.api_tokens).toEqual([
    ["wallabag", expect.objectContaining({ accessToken: "replacement" })],
  ]);
});
test("cancelled refresh waiter and draft authentication cannot cancel or change active refresh", async () => {
  const active = new TokenManager();
  await active.storeToken("wallabag", oldToken);
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
    fromLegacyPromise(() => active.refreshToken("wallabag", refreshConfig)),
    controller.signal,
  ).catch((error: unknown) => error);
  await started.promise;
  const shared = active.refreshToken("wallabag", refreshConfig);
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
  await tokens.storeToken("wallabag", oldToken);
  spyOn(globalThis, "fetch").mockResolvedValue(json({ secret: "SECRET" }));
  const api = await runOperation(createWallabagAdapter(settings, tokens));
  expect((await failure(api.testConnection)).code).toBe("InvalidResponseFailure");
});

test("Wallabag retries an explicit auth rejection with the rotated required token", async () => {
  const tokens = new TokenManager({ persist: false });
  await tokens.storeToken("wallabag", oldToken);
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
  await tokens.storeToken("wallabag", oldToken);
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
  await tokens.storeToken("wallabag", oldToken);
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
  await tokens.storeToken("wallabag", { ...oldToken, accessToken: "" });
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
  const result = await repo.syncWithAPI().catch((error: unknown) => errorResponse(error));
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
  await tokens.clearToken("wallabag");
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
  await tokens.storeToken("wallabag", oldToken);
  const stale = await runOperation(createWallabagAdapter(settings, tokens));
  await tokens.clearAllTokens();
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
    await tokens.storeToken("wallabag", { ...oldToken, accessToken: invalid });
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
  await tokens.storeToken("wallabag", oldToken);
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
  const generation = await tokens.bindAccount("wallabag", "A");
  const started = deferred<void>();
  const release = deferred<void>();
  browser.storage.local.set = async (data) => {
    started.resolve();
    await release.promise;
    Object.assign(storage, data);
  };
  const blocker = tokens.storeToken("other", oldToken);
  await started.promise;
  const stale = tokens
    .storeToken("wallabag", oldToken, undefined, undefined, generation)
    .catch((error: unknown) => error);
  const clearing = tokens.clearToken("wallabag");
  release.resolve();
  await blocker;
  expect(await stale).toBeInstanceOf(CredentialsFailure);
  await clearing;
  expect(tokens.getTokenMetadata("wallabag")).toBeNull();
});

test("late rejection does not clear a newer token without refresh capability", async () => {
  const tokens = new TokenManager({ persist: false });
  await tokens.storeToken("wallabag", { ...oldToken, refreshToken: "" });
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
  await tokens.storeToken("wallabag", {
    ...oldToken,
    refreshToken: "",
    accessToken: "replacement",
  });
  release.resolve(json({}, 401));
  // The newer token has not been rejected and does not require a password grant.
  expect(await pending.catch((error: unknown) => errorResponse(error))).toMatchObject({
    code: "CredentialsFailure",
  });
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("replacement");
  expect(fetchMock).toHaveBeenCalledTimes(1);
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

test("missing refresh capability preserves a current token until expiry", async () => {
  const tokens = new TokenManager({ persist: false });
  await tokens.storeToken("wallabag", {
    ...oldToken,
    refreshToken: "",
    expiresAt: Date.now() + 60000,
  });
  const fetchMock = spyOn(globalThis, "fetch");
  expect(await tokens.getAccessToken("wallabag")).toBe("active-access");
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
  await tokens.storeToken("wallabag", { ...oldToken, refreshToken: "", expiresAt: Date.now() - 1 });
  expect(await tokens.getAccessToken("wallabag").catch((error: unknown) => error)).toBeInstanceOf(
    CredentialsFailure,
  );
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
  expect(fetchMock).not.toHaveBeenCalled();
});
