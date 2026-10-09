import { expect } from "bun:test";
import { ArticlesRepository } from "../../src/background/articles-repository";
import { FatalStorageFailure, runOperation } from "../../src/background/api/effect-adapter";
import { getStorageDiagnostic, FatalStorageError } from "../../src/utils/fatal-storage";
import { DEFAULT_SETTINGS } from "../../src/utils/settings";
import { setFilterListSources } from "../../src/utils/filter-list-manager";
import { initializeUrlCanonizer } from "../../src/utils/url-helpers";
import { errorResponse } from "../../src/background/runtime-message";

let mutations = 0;
let failWrites = false;
Object.assign(globalThis, {
  browser: {
    bookmarks: {
      getTree: async () => [{ id: "folder", title: "Pouch" }],
      getChildren: async () => [{ id: "12abcDEF_-xy", title: "Saved", url: "https://example.com" }],
      create: async () => {
        mutations++;
        return { id: "12abcDEF_-xy", title: "Saved", url: "https://example.com" };
      },
      remove: async () => {
        mutations++;
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {
          if (failWrites) throw new Error("quota exceeded secret=credentials");
        },
      },
    },
    idle: { queryState: async () => "active" },
  },
});
setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
await initializeUrlCanonizer();
failWrites = true;
const repo = new ArticlesRepository();
await repo.initialize(DEFAULT_SETTINGS);
const operation = process.argv[2];
const effect =
  operation === "save"
    ? repo.saveArticle({ url: "https://example.com", title: "Saved" })
    : operation === "delete"
      ? repo.deleteArticle("12abcDEF_-xy")
      : repo.syncWithAPI();
try {
  await runOperation(effect);
  throw new Error("local write unexpectedly succeeded");
} catch (error) {
  expect(error).toBeInstanceOf(FatalStorageFailure);
  expect(error).toBeInstanceOf(FatalStorageError);
  const failure = error as FatalStorageFailure;
  expect(failure._tag).toBe("FatalStorageFailure");
  expect(failure.diagnostic.remoteOutcome).toBe("succeeded");
  expect(failure.diagnostic.remoteOperation).toBe(operation);
  expect(getStorageDiagnostic()?.code).toBe("FATAL_LOCAL_STORAGE");
  const response = JSON.parse(JSON.stringify(errorResponse(error)));
  expect(response.details.remoteOutcome).toBe("succeeded");
  expect(response.code).toBe("FATAL_LOCAL_STORAGE");
  expect(response.error).toContain("Do not repeat it");
  expect(JSON.stringify(response)).not.toContain("credentials");
}
await expect(runOperation(repo.testConnection)).rejects.toBeInstanceOf(FatalStorageFailure);
await expect(
  runOperation(repo.saveArticle({ url: "https://example.com/again", title: "Again" })),
).rejects.toBeInstanceOf(FatalStorageFailure);
expect(mutations).toBe(operation === "sync" ? 0 : 1);
console.log("typed-fatal-ok");
