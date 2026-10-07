export type RemoteOutcome = "succeeded" | "failed" | "unknown";
export interface StorageDiagnostic {
  code: "FATAL_LOCAL_STORAGE";
  operation: string;
  cause: { name: string; message: string };
  remoteOutcome: RemoteOutcome;
  remoteOperation?: string;
  error: string;
}

export class FatalStorageError extends Error {
  readonly _tag = "FatalStorageFailure";
  constructor(readonly diagnostic: StorageDiagnostic) {
    super(diagnostic.error);
    this.name = "FatalStorageError";
  }
}

let fatal: FatalStorageError | undefined;
const shutdown = new AbortController();
const listeners = new Set<(diagnostic: StorageDiagnostic) => void>();

export function getStorageDiagnostic(): StorageDiagnostic | undefined {
  return fatal?.diagnostic;
}

export function assertStorageHealthy(
  remoteOutcome?: RemoteOutcome,
  remoteOperation?: string,
): void {
  if (fatal) {
    if (remoteOutcome && remoteOperation) {
      reportRemoteOutcome(remoteOperation, remoteOutcome);
      throw new FatalStorageError({ ...fatal.diagnostic, remoteOutcome, remoteOperation });
    }
    throw fatal;
  }
}

export function onFatalStorage(listener: (diagnostic: StorageDiagnostic) => void): void {
  listeners.add(listener);
  if (fatal) listener(fatal.diagnostic);
}

export function storageShutdownSignal(): AbortSignal {
  return shutdown.signal;
}

function safeCause(error: unknown): StorageDiagnostic["cause"] {
  const name = error instanceof Error ? error.name : "StorageError";
  // Browser errors can contain URLs or serialized values. Only expose known storage reasons.
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason =
    /QUOTA_BYTES|quota(?: exceeded)?|max(?:imum)? write|disk|space|denied|permission|unavailable|disabled/i.exec(
      message,
    );
  return {
    name: /^[a-zA-Z]{1,64}$/.test(name) ? name : "StorageError",
    message: reason
      ? `Browser reported: ${reason[0].toLowerCase()}`
      : "Browser rejected the local storage operation",
  };
}

function publishDiagnostic(): void {
  if (!fatal) return;
  for (const listener of listeners) {
    try {
      listener(fatal.diagnostic);
    } catch {
      /* Diagnostics must not replace the storage failure. */
    }
  }
}

function stopStorage(
  operation: string,
  error: unknown,
  remoteOutcome: RemoteOutcome,
  remoteOperation?: string,
): FatalStorageError {
  if (!fatal) {
    const cause = safeCause(error);
    const remote =
      remoteOutcome === "succeeded"
        ? `Remote ${remoteOperation || "operation"} succeeded. Do not repeat it.`
        : `Remote ${remoteOperation || "outcome"}: ${remoteOutcome}.`;
    fatal = new FatalStorageError({
      code: "FATAL_LOCAL_STORAGE",
      operation,
      cause,
      remoteOutcome,
      remoteOperation,
      error: `Pouch stopped: ${operation} failed. ${cause.name}: ${cause.message}. ${remote} Restart the extension to check storage before resuming. Already-sent operations cannot be rolled back.`,
    });
    shutdown.abort(fatal);
    publishDiagnostic();
  } else if (remoteOutcome !== "unknown" && remoteOperation) {
    reportRemoteOutcome(remoteOperation, remoteOutcome);
  }
  return remoteOperation && remoteOutcome !== "unknown"
    ? new FatalStorageError({ ...fatal.diagnostic, remoteOutcome, remoteOperation })
    : fatal;
}

/** A browser/backend mutation can finish after shutdown has already started. */
export function reportRemoteOutcome(operation: string, outcome: RemoteOutcome): void {
  if (
    !fatal ||
    (fatal.diagnostic.remoteOutcome === outcome && fatal.diagnostic.remoteOperation === operation)
  )
    return;
  fatal.diagnostic.remoteOutcome = outcome;
  fatal.diagnostic.remoteOperation = operation;
  fatal.diagnostic.error +=
    outcome === "succeeded"
      ? ` Remote ${operation} succeeded. Do not repeat it.`
      : ` Remote ${operation}: ${outcome}.`;
  fatal.message = fatal.diagnostic.error;
  publishDiagnostic();
}

async function localWrite(
  operation: string,
  write: () => Promise<void>,
  remoteOutcome: RemoteOutcome = "unknown",
  remoteOperation?: string,
): Promise<void> {
  assertStorageHealthy(remoteOutcome, remoteOperation);
  try {
    await write();
  } catch (error) {
    throw stopStorage(operation, error, remoteOutcome, remoteOperation);
  }
  assertStorageHealthy(remoteOutcome, remoteOperation);
}

export function setLocal(
  operation: string,
  values: Record<string, unknown>,
  remoteOutcome?: RemoteOutcome,
  remoteOperation?: string,
): Promise<void> {
  return localWrite(
    operation,
    () => browser.storage.local.set(values),
    remoteOutcome,
    remoteOperation,
  );
}

export function removeLocal(operation: string, keys: string | string[]): Promise<void> {
  return localWrite(operation, () => browser.storage.local.remove(keys));
}

let healthCheck: Promise<void> | undefined;
/** Every new background instance checks reads, writes and removal before accepting normal work. */
export function checkStorageOnStartup(): Promise<void> {
  assertStorageHealthy();
  healthCheck ??= (async () => {
    const key = "pouch_storage_health";
    try {
      await browser.storage.local.get(key);
    } catch (error) {
      throw stopStorage("startup storage read check", error, "unknown");
    }
    await setLocal("startup storage health check", { [key]: true });
    await removeLocal("startup storage health cleanup", key);
  })();
  return healthCheck;
}
