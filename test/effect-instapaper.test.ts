import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createInstapaperAdapter } from "../src/background/api/adapters/instapaper-adapter";
import { runOperation } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { TokenManager } from "../src/background/token-manager";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { logger } from "../src/utils/logger";
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
  consumer: { key: string; secret: string } = { key: "key", secret: "secret" },
) => {
  const auth = new Headers(init?.headers).get("Authorization")!;
  expect(auth).toStartWith("OAuth ");
  const header = Object.fromEntries(
    [...auth.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decodeURIComponent(v)]),
  );
  expect(header.oauth_nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(header.oauth_token).toBe(token?.key);
  const params = [
    ...requestParams,
    `oauth_consumer_key=${encodeURIComponent(consumer.key)}`,
    `oauth_nonce=${header.oauth_nonce}`,
    "oauth_signature_method=HMAC-SHA1",
    `oauth_timestamp=${header.oauth_timestamp}`,
    ...(token ? [`oauth_token=${encodeURIComponent(token.key)}`] : []),
    "oauth_version=1.0",
  ]
    .sort()
    .join("&");
  const base = `POST&${encodeURIComponent(String(url))}&${encodeURIComponent(params)}`;
  const expected = createHmac(
    "sha1",
    `${encodeURIComponent(consumer.secret)}&${encodeURIComponent(token?.secret ?? "")}`,
  )
    .update(base)
    .digest("base64");
  expect(header.oauth_signature).toBe(expected);
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
  return header;
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

test("saveArticle signs RFC 3986-encoded params, defaults resolve_final_url=0, and uses WebCrypto UUID nonces", async () => {
  const fetchMock = api(() => json([bookmark(1)]));
  const adapter = await acquire();
  const saved = await runOperation(
    adapter.saveArticle({ url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "t!" }),
  );
  expect(saved.id).toBe(1);
  const authHeader = expectValidSignature(fetchMock.mock.calls[0], [
    "x_auth_mode=client_auth",
    "x_auth_password=PASSWORD",
    "x_auth_username=user",
  ]);
  const saveHeader = expectValidSignature(
    apiCalls(fetchMock)[0],
    [
      "resolve_final_url=0",
      "title=t%21",
      "url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FFoo_%28bar%29",
    ],
    userToken,
  );
  expect(saveHeader.oauth_nonce).not.toBe(authHeader.oauth_nonce);
});

test("saveArticle sends resolve_final_url=1 when requested and omits blank titles", async () => {
  const fetchMock = api(() => json([{ type: "meta" }, bookmark(1), { type: "unknown_future" }]));
  const adapter = await acquire();
  const saved = await runOperation(
    adapter.saveArticle({
      url: "https://example.com/redirect",
      title: "   ",
      resolveFinalUrl: true,
    }),
  );
  expect(saved.id).toBe(1);
  const saveCall = apiCalls(fetchMock)[0];
  const params = bodyOf(saveCall[1]);
  expect(params.get("url")).toBe("https://example.com/redirect");
  expect(params.get("resolve_final_url")).toBe("1");
  expect(params.has("title")).toBe(false);
  expectValidSignature(
    saveCall,
    ["resolve_final_url=1", "url=https%3A%2F%2Fexample.com%2Fredirect"],
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

test("sync issues a single limit=500 request without have or sleep and warns at the 500-item v1 cap", async () => {
  const warnSpy = spyOn(logger, "warn");
  const fetchMock = api(() => json(syncResponse(full)));
  const started = Date.now();
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  const elapsed = Date.now() - started;
  expect(result.articles).toHaveLength(500);
  expect(result.mode).toBe("overwrite");
  expect(apiCalls(fetchMock)).toHaveLength(1);
  const callBody = bodyOf(apiCalls(fetchMock)[0][1]);
  expect(callBody.get("limit")).toBe("500");
  expect(callBody.has("have")).toBe(false);
  expect(elapsed).toBeLessThan(500);
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(String(warnSpy.mock.calls[0]?.[0])).toContain("500");
});

test("sync dedupes duplicate bookmark_ids within the single list response", async () => {
  const fetchMock = api(() => json(syncResponse([1, 2, 2, 3, 1])));
  const result = await runOperation((await acquire()).sync({ mode: "overwrite" }));
  expect(result.articles.map((a) => a.id)).toEqual([1, 2, 3]);
  expect(apiCalls(fetchMock)).toHaveLength(1);
});

test("sync always returns overwrite mode even when update is requested", async () => {
  const fetchMock = api(() => json(syncResponse([1, 2], [1])));
  const result = await runOperation((await acquire()).sync({ mode: "update" }));
  expect(result.articles.map((a) => a.id)).toEqual([1, 2]);
  expect(result.mode).toBe("overwrite");
  expect(apiCalls(fetchMock)).toHaveLength(1);
});

test("sync and testConnection accept nullish titles and unexpected unused fields", async () => {
  const fetchMock = api(() =>
    json({
      user: { type: "user", user_id: 1, username: "test", subscription_is_active: "1" },
      bookmarks: [
        {
          type: "bookmark",
          bookmark_id: 10,
          url: "https://example.com/null-title",
          title: null,
          time: 1700000000,
          description: 123,
          tags: "unexpected-string",
          progress: null,
        },
        {
          type: "bookmark",
          bookmark_id: 11,
          url: "https://example.com/blank-title",
          title: "   ",
          time: 1700000001,
        },
        {
          type: "bookmark",
          bookmark_id: 12,
          url: "https://example.com/missing-title",
          time: 1700000002,
        },
      ],
      highlights: null,
      delete_ids: ["not-a-number", null],
    }),
  );
  const adapter = await acquire();
  expect(await runOperation(adapter.testConnection)).toBe(true);
  const result = await runOperation(adapter.sync());
  expect(result.articles.map((a) => ({ id: a.id, title: a.title, url: a.url }))).toEqual([
    { id: 10, title: "https://example.com/null-title", url: "https://example.com/null-title" },
    { id: 11, title: "https://example.com/blank-title", url: "https://example.com/blank-title" },
    {
      id: 12,
      title: "https://example.com/missing-title",
      url: "https://example.com/missing-title",
    },
  ]);
  expect(apiCalls(fetchMock)).toHaveLength(2);
});

test("cancellation aborts an in-flight sync request", async () => {
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

for (const operation of ["save", "delete", "sync"] as const) {
  test(`401 on ${operation} triggers xAuth re-exchange and retries once without persisting secret`, async () => {
    let authCalls = 0;
    let opCalls = 0;
    const rotatedToken = { key: "rotated-token", secret: "rotated-secret" };
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (isAuth(url)) {
        authCalls++;
        return new Response(
          authCalls === 1
            ? tokenBody
            : `oauth_token=${rotatedToken.key}&oauth_token_secret=${rotatedToken.secret}`,
        );
      }
      opCalls++;
      if (opCalls === 1) return new Response("Invalid OAuth token", { status: 401 });
      if (operation === "save") return json([bookmark(9)]);
      if (operation === "delete") return json([]);
      return json(syncResponse([9]));
    });
    const tokens = new TokenManager({ persist: false });
    const adapter = await acquire(tokens);
    await runOperation(
      operation === "save"
        ? adapter.saveArticle({ url: "https://example.com/9", title: "Nine" })
        : operation === "delete"
          ? adapter.deleteArticle(9)
          : adapter.sync(),
    );
    expect(authCalls).toBe(2);
    expect(opCalls).toBe(2);
    const retryCall = apiCalls(fetchMock)[1];
    expectValidSignature(
      retryCall,
      operation === "save"
        ? ["resolve_final_url=0", "title=Nine", "url=https%3A%2F%2Fexample.com%2F9"]
        : operation === "delete"
          ? ["bookmark_id=9"]
          : ["limit=500"],
      rotatedToken,
    );
    expect(tokens.getTokenMetadata("instapaper")).toMatchObject({
      accessToken: rotatedToken.key,
      tokenType: "OAuth",
    });
    expect(JSON.stringify(tokens.getTokenMetadata("instapaper"))).not.toContain(
      rotatedToken.secret,
    );
  });
}

test("concurrent 401 responses coalesce into a single-flight xAuth re-exchange", async () => {
  let authCalls = 0;
  const reauthStarted = deferred<void>();
  const releaseReauth = deferred<Response>();
  const rotatedToken = { key: "shared-rotated", secret: "shared-secret" };
  let firstSync401 = false;
  let firstSave401 = false;

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (isAuth(url)) {
      authCalls++;
      if (authCalls === 1) return new Response(tokenBody);
      reauthStarted.resolve();
      return releaseReauth.promise;
    }
    if (String(url).endsWith("/list")) {
      if (!firstSync401) {
        firstSync401 = true;
        return new Response("expired", { status: 401 });
      }
      return json(syncResponse([1]));
    }
    if (!firstSave401) {
      firstSave401 = true;
      return new Response("expired", { status: 401 });
    }
    return json([bookmark(2)]);
  });

  const tokens = new TokenManager({ persist: false });
  const adapter = await acquire(tokens);
  const pendingSync = runOperation(adapter.sync());
  const pendingSave = runOperation(adapter.saveArticle({ url: "https://example.com/2", title: "Two" }));
  await reauthStarted.promise;
  // Let the second 401 join the in-flight xAuth fiber before releasing it.
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseReauth.resolve(
    new Response(`oauth_token=${rotatedToken.key}&oauth_token_secret=${rotatedToken.secret}`),
  );
  const [syncResult, saved] = await Promise.all([pendingSync, pendingSave]);
  expect(syncResult.articles.map((a) => a.id)).toEqual([1]);
  expect(saved.id).toBe(2);
  expect(authCalls).toBe(2);
  expect(tokens.getTokenMetadata("instapaper")?.accessToken).toBe(rotatedToken.key);
  expect(apiCalls(fetchMock)).toHaveLength(4);
});

test("401 fails after a single auth retry if the new token is also rejected", async () => {
  let authCalls = 0;
  let opCalls = 0;
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (isAuth(url)) {
      authCalls++;
      return new Response(`oauth_token=t${authCalls}&oauth_token_secret=s${authCalls}`);
    }
    opCalls++;
    return new Response("still rejected", { status: 401 });
  });
  const adapter = await acquire();
  const result = await failure(adapter.saveArticle({ url: "https://example.com/1", title: "a" }));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "instapaper.save" },
  });
  expect(result.details).not.toHaveProperty("remoteOutcome");
  expect(authCalls).toBe(2);
  expect(opCalls).toBe(2);
});

test("failed xAuth during 401 recovery fails cleanly without claiming unknown mutation outcome", async () => {
  let authCalls = 0;
  spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (isAuth(url)) {
      authCalls++;
      if (authCalls === 1) return new Response(tokenBody);
      return new Response("SECRET bad password", { status: 401 });
    }
    return new Response("revoked", { status: 401 });
  });
  const adapter = await acquire();
  const result = await failure(adapter.deleteArticle(42));
  expect(result).toMatchObject({
    code: "CredentialsFailure",
    details: { operation: "instapaper.authenticate" },
  });
  expect(result.details).not.toHaveProperty("remoteOutcome");
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("account replacement during 401 recovery prevents retired adapter from overwriting tokens", async () => {
  const tokens = new TokenManager();
  let authCalls = 0;
  const reauthStarted = deferred<void>();
  const releaseReauth = deferred<Response>();
  spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (isAuth(url)) {
      const username = bodyOf(init).get("x_auth_username");
      if (username === "other") {
        return new Response("oauth_token=other-token&oauth_token_secret=other-secret");
      }
      authCalls++;
      if (authCalls === 1) return new Response(tokenBody);
      reauthStarted.resolve();
      return releaseReauth.promise;
    }
    return new Response("revoked", { status: 401 });
  });

  const stale = await acquire(tokens);
  const pending = failure(stale.sync());
  await reauthStarted.promise;
  await runOperation(
    createInstapaperAdapter(
      { ...settings, apiConfig: { ...settings.apiConfig, username: "other" } },
      tokens,
    ),
  );
  releaseReauth.resolve(new Response("oauth_token=stale-rotated&oauth_token_secret=stale-secret"));
  expect((await pending).code).toBe("CredentialsFailure");
  expect(tokens.getTokenMetadata("instapaper")?.accessToken).toBe("other-token");
});

for (const [label, payload] of [
  ["empty array", []],
  ["plain object", {}],
  ["meta-only array", [{ type: "meta" }]],
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
    expect(apiCalls(fetchMock)).toHaveLength(1);
  });
}

for (const [label, payload] of [
  ["plain object", {}],
  ["non-empty array", [1]],
  ["meta-only array", [{ type: "meta" }]],
] as const) {
  test(`deleteArticle rejects unexpected 200 OK JSON (${label}) as unknown outcome without retrying`, async () => {
    const fetchMock = api(() => json(payload));
    const result = await failure((await acquire()).deleteArticle(7));
    expect(result).toMatchObject({
      code: "InvalidResponseFailure",
      details: {
        operation: "instapaper.delete",
        remoteOperation: "delete",
        remoteOutcome: "unknown",
      },
    });
    expect(apiCalls(fetchMock)).toHaveLength(1);
  });
}

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

const rateLimited = (status: number) =>
  json([{ type: "error", error_code: 1040, message: "SECRET" }], status);
for (const [operation, status] of [
  ["save", 400],
  ["delete", 200],
  ["sync", 500],
] as const) {
  test(`${operation} rate limit (1040, HTTP ${status}) was not applied, so it retries`, async () => {
    const fetchMock = api((call) =>
      call === 1
        ? rateLimited(status)
        : operation === "save"
          ? json([bookmark(1)])
          : operation === "delete"
            ? json([])
            : json(syncResponse([1])),
    );
    const adapter = await acquire();
    await runOperation(
      operation === "save"
        ? adapter.saveArticle({ url: "https://a", title: "a" })
        : operation === "delete"
          ? adapter.deleteArticle(1)
          : adapter.sync(),
    );
    expect(apiCalls(fetchMock)).toHaveLength(2);
  });
}

test("a persistent rate limit fails as a definite rate-limit rejection", async () => {
  const fetchMock = api(() => rateLimited(500));
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
  expect(apiCalls(fetchMock)).toHaveLength(4);
});

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

test("missing or whitespace-only configuration fails acquisition before any request", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  for (const patch of [
    { consumerKey: "" },
    { consumerKey: "   " },
    { consumerSecret: " \t " },
    { username: "\n  " },
  ]) {
    const result = await failure(
      createInstapaperAdapter({ ...settings, apiConfig: { ...settings.apiConfig, ...patch } }),
    );
    expect(result).toMatchObject({
      code: "ConfigurationFailure",
      details: { operation: "instapaper.acquire" },
    });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("trims consumerKey, consumerSecret, and username while keeping password verbatim", async () => {
  const fetchMock = api(() => json(syncResponse([])));
  await runOperation(
    createInstapaperAdapter(
      {
        ...settings,
        apiConfig: {
          consumerKey: "  trimmedKey  ",
          consumerSecret: " trimmedSecret\n",
          username: "  trimmedUser  ",
          password: "  spaced pass  ",
        },
      },
      new TokenManager({ persist: false }),
    ),
  );
  const auth = fetchMock.mock.calls[0];
  expect(Object.fromEntries(bodyOf(auth[1]))).toEqual({
    x_auth_username: "trimmedUser",
    x_auth_password: "  spaced pass  ",
    x_auth_mode: "client_auth",
  });
  expectValidSignature(
    auth,
    [
      "x_auth_mode=client_auth",
      "x_auth_password=%20%20spaced%20pass%20%20",
      "x_auth_username=trimmedUser",
    ],
    undefined,
    { key: "trimmedKey", secret: "trimmedSecret" },
  );
});

test("allows empty or omitted password during acquisition", async () => {
  const fetchMock = api(() => json(syncResponse([])));
  await runOperation(
    createInstapaperAdapter(
      {
        ...settings,
        apiConfig: {
          consumerKey: "key",
          consumerSecret: "secret",
          username: "user",
          password: undefined,
        },
      },
      new TokenManager({ persist: false }),
    ),
  );
  const auth = fetchMock.mock.calls[0];
  expect(bodyOf(auth[1]).get("x_auth_password")).toBe("");
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

test("repository keeps the previous cache when sync fails with an invalid response", async () => {
  const keys = getAccountStorageKeys(settings);
  const previous = [{ id: 9, title: "Kept", url: "https://kept.example", created_at: "2026" }];
  storage[keys.articles] = previous;
  api(() => json({ bookmarks: "invalid" }));
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  const result = await runOperation(repo.syncWithAPI()).catch((error: unknown) => errorResponse(error));
  expect(result).toMatchObject({ code: "InvalidResponseFailure" });
  expect(storage[keys.articles]).toEqual(previous);
  expect(storage[keys.lastSyncTimestamp]).toBeUndefined();
  expect(await runOperation(repo.getAllArticles)).toEqual(previous);
});

test("repository sync reconciles deletions even when update mode is requested and forwards resolveFinalUrl", async () => {
  setFilterListSources([{ name: "empty", url: "data:text/plain,! empty" }]);
  await initializeUrlCanonizer();
  const keys = getAccountStorageKeys(settings);
  storage[keys.articles] = [
    { id: 1, title: "Article 1", url: "https://example.com/1", created_at: "2026" },
    { id: 99, title: "Deleted remotely", url: "https://example.com/99", created_at: "2026" },
  ];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (isAuth(url)) return new Response(tokenBody);
    if (String(url).endsWith("/add")) return json([bookmark(4)]);
    return json(syncResponse([1]));
  });
  const repo = new ArticlesRepository(new TokenManager({ persist: false }));
  await repo.initialize(settings);
  const synced = await runOperation(repo.syncWithAPI({ mode: "update" }));
  expect(synced.syncResult.mode).toBe("overwrite");
  expect(synced.items.map((a) => a.id)).toEqual([1]);

  await runOperation(
    repo.saveArticle({ url: "https://example.com/4", title: "", resolveFinalUrl: true }),
  );
  const addCall = apiCalls(fetchMock).find(([url]) => String(url).endsWith("/add"))!;
  expect(bodyOf(addCall[1]).get("resolve_final_url")).toBe("1");
  expect(bodyOf(addCall[1]).has("title")).toBe(false);
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
