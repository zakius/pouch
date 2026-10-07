import { Cause, Effect, Exit, Option } from "effect";
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
  constructor(readonly operation: string) {
    super(`Browser ${operation} failed. Check browser bookmarks access and try again.`);
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
export class OperationInterrupted extends Error {
  readonly _tag = "OperationInterrupted";
  constructor(readonly cause: Cause.Cause<unknown>) {
    super("The operation was interrupted.");
  }
}

/** Browser/legacy boundary preserves failures rather than squashing Exit into a generic Error. */
export async function runOperation<A, E>(
  operation: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(operation, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasDies(exit.cause)) {
    logger.error("Effect operation defect:", Cause.pretty(exit.cause));
    throw new OperationDefect(exit.cause);
  }
  if (Cause.hasInterrupts(exit.cause)) throw new OperationInterrupted(exit.cause);
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw new OperationDefect(exit.cause);
}
