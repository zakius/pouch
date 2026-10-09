import * as v from "valibot";
import { settingsSchema } from "../utils/settings";
import { FatalStorageError } from "../utils/fatal-storage";
import { isAdapterError, OperationDefect, OperationInterrupted } from "./api/effect-adapter";

const messageSchema = v.variant("type", [
  v.object({ type: v.literal("getStorageDiagnostic") }),
  v.object({
    type: v.literal("saveArticle"),
    payload: v.object({ url: v.string(), title: v.optional(v.string(), "") }),
  }),
  v.object({ type: v.literal("checkArticle"), payload: v.object({ url: v.string() }) }),
  v.object({
    type: v.literal("deleteArticle"),
    payload: v.object({ articleId: v.union([v.string(), v.number()]) }),
  }),
  v.object({
    type: v.literal("getArticles"),
    payload: v.object({
      page: v.optional(v.number()),
      perPage: v.optional(v.number()),
      search: v.optional(v.string()),
    }),
  }),
  v.object({ type: v.literal("saveSettings"), payload: v.object({ settings: settingsSchema }) }),
  v.object({ type: v.literal("testConnection"), payload: v.object({ settings: settingsSchema }) }),
]);

export class InvalidRequest extends Error {
  readonly _tag = "InvalidRequest";
  constructor(message = "Invalid runtime request") {
    super(message);
  }
}
export function parseRuntimeMessage(message: unknown) {
  const parsed = v.safeParse(messageSchema, message);
  if (!parsed.success) throw new InvalidRequest();
  return parsed.output;
}

export function errorResponse(error: unknown) {
  if (error instanceof FatalStorageError) {
    const { operation, cause, remoteOutcome, remoteOperation } = error.diagnostic;
    return { ...error.diagnostic, details: { operation, cause, remoteOutcome, remoteOperation } };
  }
  if (isAdapterError(error) && error._tag !== "FatalStorageFailure") {
    return {
      error: error.message,
      code: error._tag,
      details: {
        operation: error.operation,
        ...(error._tag === "HttpFailure" ? { status: error.status } : {}),
        ...(error._tag === "RateLimitFailure" ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error._tag === "TimeoutFailure" ? { timeoutMs: error.timeoutMs } : {}),
        ...(error._tag === "InvalidResponseFailure" ? { responseKind: error.responseKind } : {}),
        ...(error._tag === "ProviderFailure" && error.providerCode !== undefined
          ? { providerCode: error.providerCode }
          : {}),
        ...error.mutation,
        ...(error._tag === "BrowserFailure"
          ? { reason: error.reason, ...(error.cause ? { cause: error.cause } : {}) }
          : {}),
        ...(error._tag === "PermissionFailure" ? { permission: error.permission } : {}),
      },
    };
  }
  if (error instanceof InvalidRequest)
    return { error: error.message, code: "INVALID_REQUEST", details: {} };
  if (error instanceof OperationInterrupted)
    return { error: error.message, code: "OPERATION_INTERRUPTED", details: error.mutation ?? {} };
  if (error instanceof OperationDefect)
    return { error: error.message, code: "INTERNAL_DEFECT", details: error.mutation ?? {} };
  // #81 removes the legacy Promise error response after every backend has a typed failure contract.
  return {
    error: error instanceof Error ? error.message : "Unknown error",
    code: "LEGACY_FAILURE",
    details: {},
  };
}
