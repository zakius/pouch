import { Effect } from "effect";
import * as v from "valibot";
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
  type ProviderFailure,
  type TransportError,
} from "./effect-adapter";
import { reportRemoteOutcome } from "../../utils/fatal-storage";

export function isOAuthRejection(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied"].includes(
      String(data.error),
    )
  );
}

export function validate<S extends v.GenericSchema>(schema: S, data: unknown, operation: string) {
  const parsed = v.safeParse(schema, data);
  return parsed.success
    ? Effect.succeed(parsed.output)
    : Effect.fail(new InvalidResponseFailure(operation));
}

export function retryAfterDelay(headers: Headers, fallback: number, now = Date.now()): number {
  const value = headers.get("Retry-After");
  if (value !== null) {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
      const delay = Number(value) * 1000;
      return Number.isFinite(delay) ? delay : fallback;
    }
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
  readonly onAuthRejected?: (
    authorization: string | undefined,
  ) => Effect.Effect<void, TransportError>;
  readonly recoverAuth?: Effect.Effect<void, TransportError>;
  readonly mutation?: "save" | "delete";
  readonly beforeAttempt?: Effect.Effect<void, TransportError>;
  readonly responseKind?: "token" | "response";
  /** Returns the raw body instead of parsing JSON. */
  readonly format?: "text";
  /** Maps a provider error envelope in any parsed body to a definitive rejection. */
  readonly providerFailure?: (data: unknown) => ProviderFailure | undefined;
  /** A parsed body this rejects is an invalid response; a mutation's outcome stays unknown. */
  readonly confirms?: (data: unknown) => boolean;
}

// Native fetch stays private; timeout covers headers and the consumed body in one attempt.
export const requestJson = Effect.fn("transport.request")(function* (request: EffectRequest) {
  const { operation, url, mutation } = request;
  const timeoutMs = request.timeoutMs ?? 30000;
  let confirmed = false;
  const unknownOutcome = (
    failure:
      | NetworkFailure
      | TimeoutFailure
      | InvalidResponseFailure
      | HttpFailure
      | ProviderFailure,
  ) =>
    mutation && !confirmed
      ? failure.withMutation({ remoteOperation: mutation, remoteOutcome: "unknown" })
      : failure;
  const attempt = Effect.gen(function* () {
    yield* checkHostPermission(url, operation).pipe(Effect.interruptible);
    if (request.beforeAttempt) yield* request.beforeAttempt.pipe(Effect.interruptible);
    const authorization = request.authorization
      ? yield* request.authorization.pipe(Effect.interruptible)
      : undefined;
    const headers = yield* Effect.try({
      try: () => {
        const headers = new Headers(request.init?.headers);
        if (authorization !== undefined) headers.set("Authorization", authorization);
        return headers;
      },
      catch: () =>
        new InvalidResponseFailure(operation, authorization !== undefined ? "token" : "response"),
    });
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
            headers,
            signal: AbortSignal.any([controller.signal, storageShutdownSignal()]),
          }),
        catch: () => unknownOutcome(new NetworkFailure(operation)),
      });
      if (mutation && !response.ok && response.status < 500) yield* recordMutationOutcome();
      if (!response.ok) yield* storageHealthy;
      if (response.status === 401 || response.status === 403) {
        if (request.onAuthRejected) yield* request.onAuthRejected(authorization);
        return yield* Effect.fail(new CredentialsFailure(operation));
      }
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
          if (isOAuthRejection(data)) return yield* Effect.fail(new CredentialsFailure(operation));
        }
        if (request.providerFailure) {
          // Best effort: an unreadable rejection body still fails with its HTTP status.
          const data = yield* Effect.tryPromise(
            async (): Promise<unknown> => JSON.parse(await response.text()),
          ).pipe(Effect.orElseSucceed(() => undefined));
          const provider = request.providerFailure(data);
          if (provider)
            return yield* Effect.fail(response.status >= 500 ? unknownOutcome(provider) : provider);
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
        try: (): unknown => (request.format === "text" ? text : JSON.parse(text)),
        catch: () => unknownOutcome(new InvalidResponseFailure(operation, request.responseKind)),
      });
      const provider = request.providerFailure?.(data);
      if (provider) {
        if (mutation) yield* recordMutationOutcome();
        yield* storageHealthy;
        return yield* Effect.fail(provider);
      }
      if (request.confirms && !request.confirms(data)) {
        yield* storageHealthy;
        return yield* Effect.fail(
          unknownOutcome(new InvalidResponseFailure(operation, request.responseKind)),
        );
      }
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
