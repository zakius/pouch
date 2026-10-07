import { Cause, Context, Effect, Exit, Option } from "effect";
import { logger } from "../../utils/logger";
import type { Article } from "../../types/common";
import {
  FatalStorageError,
  assertStorageHealthy,
  type StorageDiagnostic,
} from "../../utils/fatal-storage";
import type { SavingArticle, SyncOptions, SyncResult, FormConfig } from "./read-it-later-adapter";

export class ConfigurationFailure extends Error {
  readonly _tag = "ConfigurationFailure";
  constructor(readonly operation: string) {
    super("Invalid backend settings. Open Pouch settings and check the configuration.");
  }
}
export class PermissionFailure extends Error {
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
export class BrowserFailure extends Error {
  readonly _tag = "BrowserFailure";
  constructor(
    readonly operation: string,
    readonly reason: "missing-folder" | "permission-denied" | "unavailable" | "unknown" = "unknown",
    readonly cause?: { name: string },
  ) {
    const guidance = {
      "missing-folder":
        "The bookmark folder is missing. Check the Pouch folder in browser bookmarks.",
      "permission-denied":
        "Browser denied bookmarks access. Grant bookmarks permission in extension settings.",
      unavailable: "The browser bookmarks API is unavailable. Check extension availability.",
      unknown: "Check browser bookmarks access and try again.",
    };
    super(`Browser ${operation} failed. ${guidance[reason]}`);
  }
}
export class FatalStorageFailure extends FatalStorageError {
  constructor(diagnostic: StorageDiagnostic) {
    super(diagnostic);
  }
}
export type AcquisitionError =
  | ConfigurationFailure
  | PermissionFailure
  | BrowserFailure
  | FatalStorageFailure;
export type SaveError = PermissionFailure | BrowserFailure | FatalStorageFailure;
export type DeleteError = PermissionFailure | BrowserFailure | FatalStorageFailure;
export type SyncError = PermissionFailure | BrowserFailure | FatalStorageFailure;
export type ConnectionError = PermissionFailure | BrowserFailure | FatalStorageFailure;
export type AdapterError = AcquisitionError | SaveError | DeleteError | SyncError | ConnectionError;

/** Ready operations capture implementation dependencies; no private services escape in R. */
export interface EffectAdapter {
  readonly displayName: string;
  readonly formConfig: FormConfig;
  readonly saveArticle: (article: SavingArticle) => Effect.Effect<Article, SaveError>;
  readonly deleteArticle: (id: number | string) => Effect.Effect<void, DeleteError>;
  readonly sync: (options?: SyncOptions) => Effect.Effect<SyncResult, SyncError>;
  readonly testConnection: Effect.Effect<true, ConnectionError>;
}

export const storageHealthy: Effect.Effect<void, FatalStorageFailure> = Effect.try({
  try: () => assertStorageHealthy(),
  catch: (error) => {
    if (error instanceof FatalStorageError) return new FatalStorageFailure(error.diagnostic);
    throw error;
  },
});

export function isAdapterError(error: unknown): error is AdapterError {
  return (
    error instanceof ConfigurationFailure ||
    error instanceof PermissionFailure ||
    error instanceof BrowserFailure ||
    error instanceof FatalStorageFailure
  );
}

/** Removed in #81 with the Promise repository coordination and unmigrated callers. */
export function fromLegacyPromise<A>(operation: () => Promise<A>): Effect.Effect<A, AdapterError> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => {
      if (error instanceof FatalStorageError) return new FatalStorageFailure(error.diagnostic);
      if (isAdapterError(error)) return error;
      throw error;
    },
  }).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof OperationInterrupted ? Effect.interrupt : Effect.die(defect),
    ),
  );
}

export class OperationDefect extends Error {
  readonly _tag = "OperationDefect";
  constructor(readonly cause: Cause.Cause<unknown>) {
    super("Unexpected background error. Check the extension diagnostics.");
  }
}
type MutationOutcome = { remoteOperation: "save" | "delete"; remoteOutcome: "succeeded" };
const OperationProgress = Context.Service<{ mutation?: MutationOutcome }>(
  "pouch/OperationProgress",
);

export const recordMutationSuccess = (remoteOperation: MutationOutcome["remoteOperation"]) =>
  Effect.gen(function* () {
    const progress = yield* Effect.serviceOption(OperationProgress);
    if (Option.isSome(progress))
      progress.value.mutation = { remoteOperation, remoteOutcome: "succeeded" };
  });

export class OperationInterrupted extends Error {
  readonly _tag = "OperationInterrupted";
  constructor(
    readonly cause: Cause.Cause<unknown>,
    readonly mutation?: MutationOutcome,
  ) {
    super(
      mutation
        ? `The operation was interrupted. Remote ${mutation.remoteOperation} succeeded. Do not repeat it.`
        : "The operation was interrupted. Check its outcome before repeating it.",
    );
  }
}

/** Browser/legacy boundary preserves failures rather than squashing Exit into a generic Error. */
export async function runOperation<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const progress: { mutation?: MutationOutcome } = {};
  const exit = await Effect.runPromiseExit(
    operation.pipe(Effect.provideService(OperationProgress, progress)),
    { signal },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasDies(exit.cause)) {
    logger.error("Effect operation defect:", Cause.pretty(exit.cause));
    throw new OperationDefect(exit.cause);
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof FatalStorageError) throw failure.value;
  if (Cause.hasInterrupts(exit.cause))
    throw new OperationInterrupted(exit.cause, progress.mutation);
  if (Option.isSome(failure)) throw failure.value;
  throw new OperationDefect(exit.cause);
}
