import { expect } from "bun:test";
import {
  ArticlesRepository,
  getAccountStorageKeys,
} from "../../src/background/articles-repository";
import {
  FatalStorageFailure,
  OperationInterrupted,
  runOperation,
} from "../../src/background/api/effect-adapter";
import { getStorageDiagnostic, setLocal } from "../../src/utils/fatal-storage";
import { DEFAULT_SETTINGS } from "../../src/utils/settings";
import { setFilterListSources } from "../../src/utils/filter-list-manager";
import { initializeUrlCanonizer } from "../../src/utils/url-helpers";
import { errorResponse } from "../../src/background/runtime-message";

const [operation, phase] = process.argv.slice(2);
const deadline = setTimeout(() => {
  console.error(`Timed out waiting for ${operation}/${phase}`);
  process.exit(1);
}, 3000);
const gate = Promise.withResolvers<void>();
const entered = Promise.withResolvers<void>();
const syncGate = Promise.withResolvers<void>();
const syncEntered = Promise.withResolvers<void>();
let syncing = false;
const article = { id: "12abcDEF_-xy", title: "Saved", url: "https://example.com" };
const key = getAccountStorageKeys(DEFAULT_SETTINGS).articles;
let stored = operation === "delete" ? [article] : [];
let mutations = 0;
let writes = 0;
let gatePreparation = false;
Object.assign(globalThis, {
  browser: {
    permissions: {
      contains: async () => {
        if (gatePreparation && phase === "prepare") {
          entered.resolve();
          await gate.promise;
        }
        return true;
      },
    },
    bookmarks: {
      getTree: async () => [{ id: "folder", title: "Pouch" }],
      getChildren: async () => {
        if (syncing) {
          syncEntered.resolve();
          await syncGate.promise;
          return operation === "delete" ? [article] : [];
        }
        return [];
      },
      create: async () => {
        mutations++;
        if (phase !== "commit" && phase !== "prepare") {
          entered.resolve();
          await gate.promise;
        }
        return article;
      },
      remove: async () => {
        mutations++;
        if (phase !== "commit" && phase !== "prepare") {
          entered.resolve();
          await gate.promise;
        }
      },
    },
    idle: { queryState: async () => "active" },
    storage: {
      local: {
        get: async () => ({ [key]: stored }),
        set: async (values: Record<string, typeof stored>) => {
          writes++;
          if (phase === "fatal" || phase === "failed-commit") throw new Error("quota exceeded");
          if (phase === "commit") {
            entered.resolve();
            await gate.promise;
          }
          if (values[key]) stored = values[key];
        },
      },
    },
  },
});
setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
await initializeUrlCanonizer();
const repo = new ArticlesRepository();
await repo.initialize(DEFAULT_SETTINGS);
await repo.testConnection();
await repo.getAllArticles();
writes = 0;
gatePreparation = true;
let syncResult;
if (phase === "sync") {
  syncing = true;
  syncResult = repo.syncWithAPI();
  await syncEntered.promise;
}
const controller = new AbortController();
const effect =
  operation === "save" ? repo.saveArticleEffect(article) : repo.deleteArticleEffect(article.id);
const result = runOperation(effect, controller.signal).catch((error: unknown) => error);
await entered.promise;
controller.abort();
if (phase === "fatal") await setLocal("unrelated write", {}).catch(() => {});
gate.resolve();
const error = await result;
if (phase === "fatal" || phase === "failed-commit") {
  expect(error).toBeInstanceOf(FatalStorageFailure);
  expect(getStorageDiagnostic()?.remoteOperation).toBe(operation);
  expect(getStorageDiagnostic()?.remoteOutcome).toBe("succeeded");
  expect(errorResponse(error).details).toMatchObject({
    remoteOperation: operation,
    remoteOutcome: "succeeded",
  });
  expect(stored).toHaveLength(operation === "delete" ? 1 : 0);
  expect(writes).toBe(1);
} else {
  expect(error).toBeInstanceOf(OperationInterrupted);
  if (phase === "prepare") {
    expect(mutations).toBe(0);
    expect(writes).toBe(0);
    expect(errorResponse(error).details).toEqual({});
  } else {
    expect(mutations).toBe(1);
    expect(writes).toBe(1);
    expect(stored).toHaveLength(operation === "save" ? 1 : 0);
    expect(await repo.getAllArticles()).toHaveLength(operation === "save" ? 1 : 0);
    expect(errorResponse(error).details).toEqual({
      remoteOperation: operation,
      remoteOutcome: "succeeded",
    });
    expect(errorResponse(error).error).toContain("Do not repeat it");
  }
}
if (syncResult) {
  syncGate.resolve();
  const synced = await syncResult;
  expect(synced.items).toHaveLength(operation === "save" ? 1 : 0);
  expect(await repo.getAllArticles()).toHaveLength(operation === "save" ? 1 : 0);
  expect(stored).toHaveLength(operation === "save" ? 1 : 0);
  expect(mutations).toBe(1);
}
clearTimeout(deadline);
console.log("cancellation-ok");
