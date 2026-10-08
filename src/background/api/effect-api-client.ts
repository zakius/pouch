import { Effect } from "effect";
import { storageShutdownSignal } from "../../utils/fatal-storage";
import { originPatternFromUrl } from "../../utils/backend-permissions";
import {
  BrowserFailure,
  CredentialsFailure,
  HttpFailure,
  InvalidResponseFailure,
  NetworkFailure,
  PermissionFailure,
  RateLimitFailure,
  TimeoutFailure,
  recordMutationSuccess,
  recordMutationOutcome,
  storageHealthy,
  type TransportError,
} from "./effect-adapter";
import { reportRemoteOutcome } from "../../utils/fatal-storage";

export function retryAfterDelay(headers: Headers, fallback: number, now = Date.now()): number {
  const value = headers.get("Retry-After");
  if (value !== null) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
    if (!/[a-zA-Z]/.test(value)) return fallback;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  } else {
    const reset = Number(headers.get("X-RateLimit-Reset"));
    if (reset > 0 && Number.isFinite(reset)) return Math.max(0, reset * 1000 - now);
  }
  return fallback;
}

export function checkHostPermission(url: string, operation: string) {
  return Effect.gen(function* () {
    yield* storageHealthy;
    const origin = originPatternFromUrl(url);
    if (!origin) return yield* Effect.fail(new PermissionFailure(operation, "server access"));
    const granted = yield* Effect.tryPromise({
      try: () => browser.permissions.contains({ origins: [origin] }),
      catch: () => new BrowserFailure(operation, "unavailable"),
    });
    if (!granted) return yield* Effect.fail(new PermissionFailure(operation, "server access"));
  });
}

export interface EffectRequest {
  readonly operation: string;
  readonly url: string;
  readonly init?: RequestInit;
  readonly timeoutMs?: number;
  readonly rateRetries?: number;
  readonly rateDelayMs?: number;
  readonly authRetries?: number;
  readonly authorization?: Effect.Effect<string, TransportError>;
  readonly recoverAuth?: Effect.Effect<void, TransportError>;
  readonly mutation?: "save" | "delete";
  readonly beforeAttempt?: Effect.Effect<void, TransportError>;
  readonly responseKind?: "token" | "response";
}

// Native fetch stays private; timeout covers headers and the consumed body in one attempt.
export const requestJson = Effect.fn("transport.request")(function* (request: EffectRequest) {
  const { operation, url, mutation } = request;
  const timeoutMs = request.timeoutMs ?? 30000;
  let confirmed = false;
  const unknownOutcome = (
    failure: NetworkFailure | TimeoutFailure | InvalidResponseFailure | HttpFailure,
  ) =>
    mutation && !confirmed
      ? failure.withMutation({ remoteOperation: mutation, remoteOutcome: "unknown" })
      : failure;
  const attempt = Effect.gen(function* () {
    yield* checkHostPermission(url, operation).pipe(Effect.interruptible);
    const authorization = request.authorization
      ? yield* request.authorization.pipe(Effect.interruptible)
      : undefined;
    if (request.beforeAttempt) yield* request.beforeAttempt.pipe(Effect.interruptible);
    yield* storageHealthy;
    return yield* Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      if (mutation)
        yield* recordMutationOutcome({ remoteOperation: mutation, remoteOutcome: "unknown" });
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            ...request.init,
            headers: (() => {
              const headers = new Headers(request.init?.headers);
              if (authorization) headers.set("Authorization", authorization);
              return headers;
            })(),
            signal: AbortSignal.any([controller.signal, storageShutdownSignal()]),
          }),
        catch: () => unknownOutcome(new NetworkFailure(operation)),
      });
      if (mutation && !response.ok && response.status < 500) yield* recordMutationOutcome();
      if (!response.ok) yield* storageHealthy;
      if (response.status === 401 || response.status === 403)
        return yield* Effect.fail(new CredentialsFailure(operation));
      if (response.status === 429)
        return yield* Effect.fail(
          new RateLimitFailure(
            operation,
            retryAfterDelay(response.headers, request.rateDelayMs ?? 1000),
          ),
        );
      if (!response.ok) {
        if (request.responseKind === "token" && response.status === 400) {
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => new NetworkFailure(operation),
          });
          const data = yield* Effect.try({
            try: (): unknown => JSON.parse(text),
            catch: () => new InvalidResponseFailure(operation, "token"),
          });
          if (
            typeof data === "object" &&
            data !== null &&
            "error" in data &&
            ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(
              String(data.error),
            )
          )
            return yield* Effect.fail(new CredentialsFailure(operation));
        }
        return yield* Effect.fail(
          response.status >= 500
            ? unknownOutcome(new HttpFailure(operation, response.status))
            : new HttpFailure(operation, response.status),
        );
      }
      if (response.status === 204 || response.status === 205) {
        if (mutation) {
          confirmed = true;
          reportRemoteOutcome(mutation, "succeeded");
          yield* recordMutationSuccess(mutation);
        }
        yield* storageHealthy;
        return undefined;
      }
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => unknownOutcome(new NetworkFailure(operation)),
      });
      const data = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () => unknownOutcome(new InvalidResponseFailure(operation, request.responseKind)),
      });
      if (mutation && typeof data === "object" && data !== null && "error" in data) {
        yield* recordMutationOutcome();
        yield* storageHealthy;
        return yield* Effect.fail(new HttpFailure(operation, response.status));
      }
      if (mutation) {
        confirmed = true;
        reportRemoteOutcome(mutation, "succeeded");
        yield* recordMutationSuccess(mutation);
      }
      yield* storageHealthy;
      return data;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(unknownOutcome(new TimeoutFailure(operation, timeoutMs))),
      }),
      Effect.interruptible,
    );
  });

  let authRetries = request.authRetries ?? 0;
  let rateRetries = request.rateRetries ?? 3;
  return yield* attempt.pipe(
    Effect.retry({
      while: (error) =>
        Effect.gen(function* () {
          if (error instanceof CredentialsFailure && request.recoverAuth && authRetries > 0) {
            authRetries--;
            yield* request.recoverAuth;
            return true;
          }
          if (error instanceof RateLimitFailure && rateRetries > 0) {
            rateRetries--;
            yield* Effect.sleep(error.retryAfterMs);
            return true;
          }
          return false;
        }),
    }),
    Effect.tapError(() => storageHealthy),
    Effect.interruptible,
  );
});
