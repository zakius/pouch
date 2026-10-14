import { Cause, Context, Effect, Exit, Option } from "effect";
import { logger } from "../../utils/logger";
import type { Article } from "../../types/common";
import {
  FatalStorageError,
  assertStorageHealthy,
  storageShutdownSignal,
  type RemoteOutcome,
  type StorageDiagnostic,
} from "../../utils/fatal-storage";
import type { SavingArticle, SyncOptions, SyncResult } from "./read-it-later-adapter";

type MutationOutcome = {
  remoteOperation: "save" | "delete";
  remoteOutcome: "succeeded" | "unknown";
};

class OperationError extends Error {
  mutation?: MutationOutcome;

  withMutation(mutation?: MutationOutcome): this {
    if (!mutation) return this;
    // Effects can reuse failures; invocation outcomes must not change the supplied error.
    const failure: this = Object.setPrototypeOf(new Error(), Object.getPrototypeOf(this));
    Object.defineProperties(failure, Object.getOwnPropertyDescriptors(this));
    failure.mutation = { ...mutation };
    failure.message =
      mutation.remoteOutcome === "succeeded"
        ? `Remote ${mutation.remoteOperation} succeeded, but Pouch could not finish the operation. Do not repeat it. Check extension diagnostics before refreshing local articles with sync.`
        : `Remote ${mutation.remoteOperation} outcome is unknown. Do not repeat it. Check the server and extension diagnostics before syncing.`;
    return failure;
  }
}

export class ConfigurationFailure extends OperationError {
  readonly _tag = "ConfigurationFailure";
  constructor(readonly operation: string) {
    super("Invalid backend settings. Open Pouch settings and check the configuration.");
  }
}
export class PermissionFailure extends OperationError {
  readonly _tag = "PermissionFailure";
  constructor(
    readonly operation: string,
    readonly permission: string,
  ) {
    super(
      `Pouch needs ${permission} permission. Open the browser extension settings and grant access.`,
    );
  }
}
export class BrowserFailure extends OperationError {
  readonly _tag = "BrowserFailure";
  constructor(
    readonly operation: string,
    readonly reason:
      | "missing-folder"
      | "permission-denied"
      | "unavailable"
      | "crypto"
      | "rejected"
      | "unknown" = "unknown",
    readonly cause?: { name: string; message?: string },
  ) {
    const guidance = {
      "missing-folder":
        "The bookmark folder is missing. Check the Pouch folder in browser bookmarks.",
      "permission-denied":
        "Browser denied bookmarks access. Grant bookmarks permission in extension settings.",
      unavailable: "The browser API is unavailable. Check extension availability.",
      crypto: "Browser cryptography could not sign the request. Check browser support.",
      unknown: "Check browser bookmarks access and try again.",
      rejected: "Fix the reported cause and try again.",
    };
    const reported = cause?.message ? `${cause.message}. ` : "";
    super(`Browser ${operation} failed. ${reported}${guidance[reason]}`);
  }
}
export class CredentialsFailure extends OperationError {
  readonly _tag = "CredentialsFailure";
  constructor(readonly operation: string) {
    super("The server did not accept your login details. Check them in Pouch settings.");
  }
}
export class NetworkFailure extends OperationError {
  readonly _tag = "NetworkFailure";
  constructor(readonly operation: string) {
    super("The server could not be reached. Check the connection and extension diagnostics.");
  }
}
export class TimeoutFailure extends OperationError {
  readonly _tag = "TimeoutFailure";
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super("The server request timed out. Check the connection and extension diagnostics.");
  }
}
export class InvalidResponseFailure extends OperationError {
  readonly _tag = "InvalidResponseFailure";
  constructor(
    readonly operation: string,
    readonly responseKind: "token" | "response" = "response",
  ) {
    super(
      `The server returned an invalid ${responseKind}. Check server compatibility and extension diagnostics.`,
    );
  }
}
export class HttpFailure extends OperationError {
  readonly _tag = "HttpFailure";
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(
      `The server rejected the request (HTTP ${status}). Check server access and extension diagnostics.`,
    );
  }
}
export class RateLimitFailure extends OperationError {
  readonly _tag = "RateLimitFailure";
  constructor(
    readonly operation: string,
    readonly retryAfterMs: number,
  ) {
    super("The server rate limit is reached. Wait and try again later.");
  }
}
/** Carries only the provider's numeric code, if any; provider messages may echo request data. */
export class ProviderFailure extends OperationError {
  readonly _tag = "ProviderFailure";
  constructor(
    readonly operation: string,
    readonly providerCode?: number,
  ) {
    super(
      `The server rejected the request (${providerCode === undefined ? "provider rejection" : `provider error ${providerCode}`}). Check the account and extension diagnostics.`,
    );
  }
}
export class IncompleteSnapshotFailure extends OperationError {
  readonly _tag = "IncompleteSnapshotFailure";
  constructor(readonly operation: string) {
    super(
      "The server did not return a complete article list. Pouch kept the previous articles. Try syncing again later.",
    );
  }
}
export type TransportError =
  | PermissionFailure
  | BrowserFailure
  | CredentialsFailure
  | NetworkFailure
  | TimeoutFailure
  | InvalidResponseFailure
  | HttpFailure
  | RateLimitFailure
  | ProviderFailure
  | FatalStorageFailure;
export class FatalStorageFailure extends FatalStorageError {
  constructor(diagnostic: StorageDiagnostic) {
    super(diagnostic);
  }
}
export type AcquisitionError = ConfigurationFailure | TransportError;
export type SaveError = TransportError;
export type DeleteError = TransportError;
export type SyncError = TransportError | IncompleteSnapshotFailure;
export type ConnectionError = TransportError;
export type AdapterError = AcquisitionError | IncompleteSnapshotFailure;

/** Ready operations capture implementation dependencies; no private services escape in R. */
export interface EffectAdapter {
  readonly saveArticle: (article: SavingArticle) => Effect.Effect<Article, SaveError>;
  readonly deleteArticle: (id: number | string) => Effect.Effect<void, DeleteError>;
  readonly sync: (options?: SyncOptions) => Effect.Effect<SyncResult, SyncError>;
  readonly testConnection: Effect.Effect<true, ConnectionError>;
}

/** With a remote outcome, a fatal failure reports that outcome too. */
export const storageHealthyAfter = (
  remoteOutcome?: RemoteOutcome,
  remoteOperation?: string,
): Effect.Effect<void, FatalStorageFailure> =>
  Effect.try({
    try: () => assertStorageHealthy(remoteOutcome, remoteOperation),
    catch: (error) => {
      if (error instanceof FatalStorageError) return new FatalStorageFailure(error.diagnostic);
      throw error;
    },
  });
export const storageHealthy = storageHealthyAfter();

export function isAdapterError(error: unknown): error is AdapterError {
  return (
    error instanceof ConfigurationFailure ||
    error instanceof PermissionFailure ||
    error instanceof BrowserFailure ||
    error instanceof FatalStorageFailure ||
    error instanceof CredentialsFailure ||
    error instanceof NetworkFailure ||
    error instanceof TimeoutFailure ||
    error instanceof InvalidResponseFailure ||
    error instanceof HttpFailure ||
    error instanceof RateLimitFailure ||
    error instanceof ProviderFailure ||
    error instanceof IncompleteSnapshotFailure
  );
}

/** Runs a Promise whose only rejection is fatal storage, e.g. `setLocal`, which latches it first. */
export function storagePromise<A>(run: () => Promise<A>): Effect.Effect<A, FatalStorageFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof FatalStorageError) return new FatalStorageFailure(error.diagnostic);
      throw error;
    },
  });
}

/**
 * Forks work that nobody joins. Effect does not report a detached fiber that dies, so this logs
 * every failure except interruption.
 */
export function forkDetachLogged<A, E>(label: string, effect: Effect.Effect<A, E>) {
  return Effect.forkDetach(
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => logger.error(`${label} failed:`, Cause.pretty(cause))),
      ),
    ),
  );
}

export function localRead(
  operation: string,
  keys: string | string[] | null,
): Effect.Effect<Record<string, unknown>, BrowserFailure | FatalStorageFailure> {
  return Effect.tryPromise({
    try: () => browser.storage.local.get(keys),
    catch: () => new BrowserFailure(operation),
  }).pipe(Effect.tap(() => storageHealthy));
}

export class OperationDefect extends OperationError {
  readonly _tag = "OperationDefect";
  constructor(readonly cause: Cause.Cause<unknown>) {
    super("Unexpected background error. Check the extension diagnostics.");
  }
}
const OperationProgress = Context.Service<{ mutation?: MutationOutcome }>(
  "pouch/OperationProgress",
);

export const recordMutationOutcome = (mutation?: MutationOutcome) =>
  Effect.gen(function* () {
    const progress = yield* Effect.serviceOption(OperationProgress);
    if (Option.isSome(progress)) progress.value.mutation = mutation;
  });
export const recordMutationSuccess = (remoteOperation: MutationOutcome["remoteOperation"]) =>
  recordMutationOutcome({ remoteOperation, remoteOutcome: "succeeded" });

export class OperationInterrupted extends Error {
  readonly _tag = "OperationInterrupted";
  constructor(
    readonly cause: Cause.Cause<unknown>,
    readonly mutation?: MutationOutcome,
  ) {
    super(
      mutation
        ? `The operation was interrupted. Remote ${mutation.remoteOperation} ${mutation.remoteOutcome === "succeeded" ? "succeeded" : "outcome is unknown"}. Do not repeat it.`
        : "The operation was interrupted. Check its outcome before repeating it.",
    );
  }
}

/** The browser boundary: classifies the Exit into a typed failure, fatal storage, interruption or defect. */
export async function runOperation<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const progress: { mutation?: MutationOutcome } = {};
  const exit = await Effect.runPromiseExit(
    operation.pipe(Effect.provideService(OperationProgress, progress)),
    { signal: AbortSignal.any([storageShutdownSignal(), ...(signal ? [signal] : [])]) },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasDies(exit.cause)) {
    logger.error("Effect operation defect:", Cause.pretty(exit.cause));
    throw new OperationDefect(exit.cause).withMutation(progress.mutation);
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof FatalStorageError) throw failure.value;
  if (Cause.hasInterrupts(exit.cause)) {
    try {
      assertStorageHealthy(progress.mutation?.remoteOutcome, progress.mutation?.remoteOperation);
    } catch (error) {
      if (error instanceof FatalStorageError) throw new FatalStorageFailure(error.diagnostic);
      throw error;
    }
    throw new OperationInterrupted(exit.cause, progress.mutation);
  }
  if (Option.isSome(failure))
    throw failure.value instanceof OperationError
      ? failure.value.withMutation(progress.mutation ?? failure.value.mutation)
      : failure.value;
  throw new OperationDefect(exit.cause).withMutation(progress.mutation);
}
