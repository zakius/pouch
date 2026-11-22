import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  MAX_AUTO_RETRY_MS,
  requestJson,
  retryAfterDelay,
} from "../src/background/api/effect-api-client";
import {
  CredentialsFailure,
  InvalidResponseFailure,
  RateLimitFailure,
  runOperation,
} from "../src/background/api/effect-adapter";
import { createWallabagAdapter } from "../src/background/api/adapters/wallabag-adapter";
import { errorResponse } from "../src/background/runtime-message";
import { hashAccountIdentity, TokenManager } from "../src/background/token-manager";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import type { WallabagSettings } from "../src/utils/settings-schemas";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
const flush = () => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => true },
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
      },
      alarms: { get: async () => ({ periodInMinutes: 5 }), create: async () => {} },
    },
  });
});

afterEach(() => {
  mock.restore();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
});

test("Retry-After above MAX_AUTO_RETRY_MS fails immediately without sleeping", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } }),
  );
  const start = Date.now();
  const error = await runOperation(
    requestJson({
      operation: "test.rateLimitCap",
      url: "https://example.com/items",
    }),
  ).catch((err: unknown) => err);

  expect(Date.now() - start).toBeLessThan(500);
  expect(error).toBeInstanceOf(RateLimitFailure);
  expect((error as RateLimitFailure).retryAfterMs).toBe(3_600_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("X-RateLimit-Reset normalizes millisecond epochs and rejects past timestamps to fallback", () => {
  const now = 1_700_000_000_000;
  // Millisecond epoch (> 1e12) is not multiplied by 1000.
  expect(
    retryAfterDelay(new Headers({ "X-RateLimit-Reset": String(now + 5000) }), 1000, now),
  ).toBe(5000);
  // Seconds epoch (<= 1e12) is converted to milliseconds.
  expect(
    retryAfterDelay(
      new Headers({ "X-RateLimit-Reset": String(Math.floor(now / 1000) + 5) }),
      1000,
      now,
    ),
  ).toBe(5000);
  // Past or equal X-RateLimit-Reset (client clock ahead) falls back instead of returning 0ms.
  expect(
    retryAfterDelay(
      new Headers({ "X-RateLimit-Reset": String(Math.floor(now / 1000) - 10) }),
      1000,
      now,
    ),
  ).toBe(1000);
  expect(
    retryAfterDelay(new Headers({ "X-RateLimit-Reset": String(now - 5000) }), 1000, now),
  ).toBe(1000);
  expect(retryAfterDelay(new Headers({ "X-RateLimit-Reset": String(now) }), 1000, now)).toBe(1000);
  // Past HTTP-date Retry-After also falls back instead of spinning at 0ms.
  expect(
    retryAfterDelay(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:00:01 GMT" }), 1000, 5000),
  ).toBe(1000);
  // Explicit Retry-After: 0 remains 0ms.
  expect(retryAfterDelay(new Headers({ "Retry-After": "0" }), 1000, now)).toBe(0);
});

test("millisecond X-RateLimit-Reset retries after normalized delay and fails fast if over cap", async () => {
  const now = Date.now();
  let calls = 0;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls++;
    return calls === 1
      ? new Response("slow down", {
          status: 429,
          headers: { "X-RateLimit-Reset": String(now + 5000) },
        })
      : new Response(JSON.stringify({ ok: true }));
  });

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        requestJson({
          operation: "test.msReset",
          url: "https://example.com/items",
        }),
      );
      yield* flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(4000);
      yield* flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust(2000);
      yield* flush();
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(result).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  // Far-future millisecond reset exceeds MAX_AUTO_RETRY_MS and fails immediately.
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(
    new Response("slow down", {
      status: 429,
      headers: { "X-RateLimit-Reset": String(Date.now() + MAX_AUTO_RETRY_MS + 60_000) },
    }),
  );
  const error = await runOperation(
    requestJson({
      operation: "test.msResetOverCap",
      url: "https://example.com/items",
    }),
  ).catch((err: unknown) => err);
  expect(error).toBeInstanceOf(RateLimitFailure);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("headerless 429 and skewed past X-RateLimit-Reset use exponential backoff instead of spinning", async () => {
  for (const responseFactory of [
    () => new Response("rate limited", { status: 429 }),
    () =>
      new Response("rate limited", {
        status: 429,
        headers: { "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) - 30) },
      }),
  ]) {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => responseFactory());
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.flip(
            requestJson({
              operation: "test.backoff",
              url: "https://example.com/items",
            }),
          ),
        );
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Retry 1: 1000ms
        yield* TestClock.adjust(999);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust(1);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Retry 2: 2000ms
        yield* TestClock.adjust(1999);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        yield* TestClock.adjust(1);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(3);

        // Retry 3: 4000ms
        yield* TestClock.adjust(3999);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        yield* TestClock.adjust(1);
        yield* flush();
        expect(fetchMock).toHaveBeenCalledTimes(4);

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(error).toBeInstanceOf(RateLimitFailure);
    mock.restore();
  }
});

test("HTTP 403 does not trigger onAuthRejected or recoverAuth, while 401 does", async () => {
  const onAuthRejected = mock(() => Effect.void);
  const recoverAuth = mock(() => Effect.void);

  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Forbidden", { status: 403 }),
  );
  const forbidden = await runOperation(
    requestJson({
      operation: "test.forbidden",
      url: "https://example.com/items",
      authRetries: 2,
      authorization: Effect.succeed("Bearer token"),
      onAuthRejected,
      recoverAuth: Effect.suspend(recoverAuth),
    }),
  ).catch((err: unknown) => err);

  expect(forbidden).toBeInstanceOf(CredentialsFailure);
  expect((forbidden as CredentialsFailure).recoverable).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onAuthRejected).not.toHaveBeenCalled();
  expect(recoverAuth).not.toHaveBeenCalled();

  // 401 still invokes onAuthRejected and recoverAuth retries.
  let calls = 0;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () =>
    ++calls === 1 ? new Response("Unauthorized", { status: 401 }) : new Response(JSON.stringify({ ok: true })),
  );
  const recovered = await runOperation(
    requestJson({
      operation: "test.unauthorized",
      url: "https://example.com/items",
      authRetries: 2,
      authorization: Effect.succeed("Bearer token"),
      onAuthRejected,
      recoverAuth: Effect.suspend(recoverAuth),
    }),
  );
  expect(recovered).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(onAuthRejected).toHaveBeenCalledTimes(1);
  expect(recoverAuth).toHaveBeenCalledTimes(1);
});

test("Wallabag 403 does not discard tokens or trigger OAuth refresh", async () => {
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
  const tokens = new TokenManager({ persist: false });
  await runOperation(
    tokens.storeToken("wallabag", {
      accessToken: "active-access",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      issuedAt: Date.now(),
      refreshCount: 0,
      accountIdentityHash: await hashAccountIdentity(JSON.stringify(settings.apiConfig)),
    }),
  );
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Forbidden", { status: 403 }),
  );
  const adapter = await runOperation(createWallabagAdapter(settings, tokens));
  const result = await runOperation(adapter.testConnection).catch((err: unknown) =>
    errorResponse(err),
  );

  expect(result.code).toBe("CredentialsFailure");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
});

test("HTTP 403 on OAuth refresh preserves stored credentials", async () => {
  const tokens = new TokenManager({ persist: false });
  await runOperation(
    tokens.storeToken("wallabag", {
      accessToken: "active-access",
      refreshToken: "active-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
      issuedAt: Date.now(),
      refreshCount: 0,
    }),
  );
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));
  const result = await runOperation(
    tokens.refreshToken("wallabag", {
      serviceName: "wallabag",
      refreshUrl: "https://wallabag.example/oauth/v2/token",
      clientId: "client",
      clientSecret: "SECRET",
      refreshToken: "active-refresh",
    }),
  );

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(result.failure).toBeInstanceOf(CredentialsFailure);
  expect(tokens.getTokenMetadata("wallabag")?.accessToken).toBe("active-access");
});

test("empty 200 OK body succeeds for unconfirmed mutations and fails for reads and confirmed mutations", async () => {
  for (const body of ["", "   \n\t  "]) {
    spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status: 200 }));
    const deleted = await runOperation(
      requestJson({
        operation: "test.delete",
        url: "https://example.com/items/1",
        mutation: "delete",
        init: { method: "DELETE" },
      }),
    );
    expect(deleted).toBeUndefined();
    mock.restore();
  }

  // Empty 200 OK mutation records remoteOutcome="succeeded" just like 204.
  spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
  const postMutationFailure = await runOperation(
    requestJson({
      operation: "test.delete",
      url: "https://example.com/items/1",
      mutation: "delete",
      init: { method: "DELETE" },
    }).pipe(Effect.andThen(Effect.fail(new InvalidResponseFailure("test.post")))),
  ).catch((err: unknown) => errorResponse(err));
  expect(postMutationFailure).toMatchObject({
    code: "InvalidResponseFailure",
    details: { remoteOperation: "delete", remoteOutcome: "succeeded" },
  });

  // Non-mutation read with empty 200 body still fails with InvalidResponseFailure.
  const readError = await runOperation(
    requestJson({
      operation: "test.read",
      url: "https://example.com/items",
    }),
  ).catch((err: unknown) => err);
  expect(readError).toBeInstanceOf(InvalidResponseFailure);

  // Mutation with `confirms` and empty 200 body still fails with unknown outcome.
  const confirmedError = await runOperation(
    requestJson({
      operation: "test.confirmedDelete",
      url: "https://example.com/items/1",
      mutation: "delete",
      confirms: (data) => typeof data === "object" && data !== null && "ok" in data,
      init: { method: "DELETE" },
    }),
  ).catch((err: unknown) => errorResponse(err));
  expect(confirmedError).toMatchObject({
    code: "InvalidResponseFailure",
    details: { remoteOperation: "delete", remoteOutcome: "unknown" },
  });
});
