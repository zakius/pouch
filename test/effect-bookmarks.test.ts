import { setFilterListSources, resetFilterListSources } from "../src/utils/filter-list-manager";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { getAccountStorageKeys, ArticlesRepository } from "../src/background/articles-repository";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import { createBookmarksAdapter } from "../src/background/api/adapters/bookmarks-adapter";
import {
  BrowserFailure,
  ConfigurationFailure,
  PermissionFailure,
  OperationDefect,
  OperationInterrupted,
  fromLegacyPromise,
  runOperation,
  recordMutationSuccess,
} from "../src/background/api/effect-adapter";
import { getStorageDiagnostic } from "../src/utils/fatal-storage";
import type { Article } from "../src/types/common";
import { DEFAULT_SETTINGS } from "../src/utils/settings";
import type { BookmarksSettings } from "../src/utils/settings-schemas";
import { errorResponse, parseRuntimeMessage } from "../src/background/runtime-message";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
const settings: BookmarksSettings = { ...DEFAULT_SETTINGS, backend: "bookmarks", apiConfig: {} };
let granted = true;
let created: { title: string; url?: string; parentId?: string }[];
let removed: string[];
let tree = [{ id: "folder", title: "Pouch", children: [] }];
let bookmarkId = "12abcDEF_-xy";
let failRead = false;
beforeEach(() => {
  granted = true;
  created = [];
  removed = [];
  tree = [{ id: "folder", title: "Pouch", children: [] }];
  bookmarkId = "12abcDEF_-xy";
  failRead = false;
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => granted },
      bookmarks: {
        getTree: async () => tree,
        create: async (details: { title: string; url?: string; parentId?: string }) => {
          created.push(details);
          return { ...details, id: bookmarkId, dateAdded: 1700000000000 };
        },
        getChildren: async () => {
          if (failRead) throw new Error("secret=https://private.example/token");
          return [
            {
              id: bookmarkId,
              title: "Saved",
              url: "https://example.com",
              dateAdded: 1700000000000,
            },
          ];
        },
        remove: async (id: string) => {
          removed.push(id);
        },
      },
    },
  });
});
afterEach(() => {
  resetFilterListSources();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
});

for (const id of ["12abcDEF_-xy", "18446744073709551616"]) {
  test(`ready bookmark operations preserve string ID ${id}`, async () => {
    bookmarkId = id;
    const api = await runOperation(createBookmarksAdapter(settings));
    expect(created).toEqual([]);
    expect(await runOperation(api.testConnection)).toBe(true);
    expect(
      (await runOperation(api.saveArticle({ title: "Saved", url: "https://example.com" }))).id,
    ).toBe(id);
    expect((await runOperation(api.sync())).articles[0].id).toBe(id);
    await runOperation(api.deleteArticle(id));
    expect(removed).toEqual([id]);
  });
}

test("acquisition creates its folder before returning ready operations", async () => {
  tree = [];
  const api = await runOperation(createBookmarksAdapter(settings));
  expect(created).toEqual([{ title: "Pouch", parentId: "unfiled_____" }]);
  await runOperation(api.saveArticle({ title: "Saved", url: "https://example.com" }));
  expect(created[1].parentId).toBe(bookmarkId);
});

test("ready operations capture the acquired browser implementation", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  Object.assign(globalThis, {
    browser: {
      bookmarks: {
        remove: () => {
          throw new Error("wrong account");
        },
      },
    },
  });
  await runOperation(api.deleteArticle(bookmarkId));
  expect(removed).toEqual([bookmarkId]);
});

test("configuration and permission acquisition failures remain distinct", async () => {
  await expect(
    runOperation(
      createBookmarksAdapter({ ...settings, backend: "wallabag" } as unknown as BookmarksSettings),
    ),
  ).rejects.toBeInstanceOf(ConfigurationFailure);
  granted = false;
  await expect(runOperation(createBookmarksAdapter(settings))).rejects.toBeInstanceOf(
    PermissionFailure,
  );
  expect(created).toEqual([]);
});

test("permission revocation blocks mutations on a ready adapter", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  granted = false;
  await expect(runOperation(api.deleteArticle(bookmarkId))).rejects.toBeInstanceOf(
    PermissionFailure,
  );
  expect(removed).toEqual([]);
});

test("connection and sync retain safe actionable browser failure details", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  failRead = true;
  for (const operation of [api.testConnection, api.sync()]) {
    const exit = await Effect.runPromiseExit(operation);
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    try {
      await runOperation(operation);
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserFailure);
      const response = errorResponse(error);
      expect(response.code).toBe("BrowserFailure");
      expect(response.error).toContain("Check browser bookmarks access");
      expect(JSON.stringify(response)).not.toContain("private.example");
      expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    }
  }
});

test("browser acquisition rejection is typed while synchronous implementation errors are defects", async () => {
  browser.bookmarks.getTree = () => Promise.reject(new Error("read failed"));
  await expect(runOperation(createBookmarksAdapter(settings))).rejects.toBeInstanceOf(
    BrowserFailure,
  );
  browser.bookmarks.getTree = () => {
    throw new TypeError("implementation bug");
  };
  await expect(runOperation(createBookmarksAdapter(settings))).rejects.toBeInstanceOf(
    OperationDefect,
  );
});

test("runner and Promise bridge preserve interruption separately from defects", async () => {
  await expect(runOperation(Effect.interrupt)).rejects.toBeInstanceOf(OperationInterrupted);
  await expect(runOperation(Effect.die(new Error("bug")))).rejects.toBeInstanceOf(OperationDefect);
  const interrupted = new OperationInterrupted(Cause.interrupt(1));
  await expect(
    runOperation(fromLegacyPromise(() => Promise.reject(interrupted))),
  ).rejects.toBeInstanceOf(OperationInterrupted);
  await expect(
    runOperation(fromLegacyPromise(() => Promise.reject(new TypeError("bug")))),
  ).rejects.toBeInstanceOf(OperationDefect);
  const controller = new AbortController();
  controller.abort();
  await expect(runOperation(Effect.never, controller.signal)).rejects.toBeInstanceOf(
    OperationInterrupted,
  );
});

for (const invalid of [
  null,
  {},
  { type: "saveArticle" },
  { type: "saveArticle", payload: { url: 4 } },
  { type: "deleteArticle", payload: { articleId: {} } },
  { type: "testConnection", payload: { settings: { ...settings, backend: "wallabag" } } },
]) {
  test(`runtime seam rejects malformed plain request ${JSON.stringify(invalid)}`, () => {
    try {
      parseRuntimeMessage(invalid);
      throw new Error("accepted malformed input");
    } catch (error) {
      expect(errorResponse(error).code).toBe("INVALID_REQUEST");
    }
  });
}

for (const operation of ["save", "delete", "sync"]) {
  test(`typed fatal ${operation} records remote success and blocks future bookmark work`, async () => {
    const child = Bun.spawn(["bun", "test/fixtures/effect-bookmarks-fatal.ts", operation], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(stdout).toContain("typed-fatal-ok");
  });
}

test("a failed native sync acquisition permits a later retry", async () => {
  Object.assign(browser, {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    idle: { queryState: async () => "active" },
  });
  setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
  await initializeUrlCanonizer();
  const repo = new ArticlesRepository();
  await repo.initialize(settings);
  granted = false;
  await expect(repo.syncWithAPI()).rejects.toBeInstanceOf(PermissionFailure);
  granted = true;
  expect((await repo.syncWithAPI()).items.map((article) => article.id)).toEqual([bookmarkId]);
});

for (const operation of ["save", "delete"]) {
  for (const phase of ["remote", "commit", "prepare", "fatal", "failed-commit", "sync"]) {
    test(`${operation} cancellation at ${phase} preserves mutation bookkeeping and fatal gates`, async () => {
      const child = Bun.spawn(
        ["bun", "test/fixtures/effect-bookmarks-cancellation.ts", operation, phase],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
      expect(stdout).toContain("cancellation-ok");
    });
  }
}

test("browser failures distinguish safe reasons and redact rejection payloads", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  const cases = [
    [new Error("Bookmark folder not found password=secret"), "missing-folder"],
    [
      new DOMException("Permission denied secret=https://private.example/token", "NotAllowedError"),
      "permission-denied",
    ],
    [new Error("Browser API unavailable token=secret"), "unavailable"],
    [
      { message: "Permission denied", password: "secret", url: "https://private.example" },
      "unknown",
    ],
  ] as const;
  for (const [rejection, reason] of cases) {
    browser.bookmarks.getChildren = () => Promise.reject(rejection);
    const error = await runOperation(api.testConnection).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BrowserFailure);
    const response = errorResponse(error);
    expect(response.details).toMatchObject({ reason });
    if (reason === "permission-denied")
      expect(response.details).toMatchObject({ cause: { name: "NotAllowedError" } });
    expect(JSON.stringify(response)).not.toMatch(/secret|private.example|password|token/);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  }
});

test("interrupted outcome bookkeeping is isolated between runner invocations", async () => {
  const submitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstController = new AbortController();
  const first = runOperation(
    Effect.gen(function* () {
      submitted.resolve();
      yield* Effect.promise(() => release.promise);
      yield* recordMutationSuccess("save");
    }).pipe(Effect.uninterruptible),
    firstController.signal,
  ).catch((error: unknown) => error);
  await submitted.promise;
  firstController.abort();
  const unrelated = await runOperation(Effect.interrupt).catch((error: unknown) => error);
  expect(errorResponse(unrelated).details).toEqual({});
  release.resolve();
  expect(errorResponse(await first).details).toEqual({
    remoteOperation: "save",
    remoteOutcome: "succeeded",
  });
});

for (const operation of ["save", "delete"] as const) {
  test(`${operation} success survives a local article read failure without repeating the mutation`, async () => {
    const key = getAccountStorageKeys(settings).articles;
    let rejectArticles = false;
    let writes = 0;
    let stored: Article[] = [];
    Object.assign(browser, {
      storage: {
        local: {
          get: async (keys: string[]) => {
            if (rejectArticles && keys.includes(key))
              throw new Error("read failed secret=https://private.example/token");
            return { [key]: stored };
          },
          set: async (values: Record<string, Article[]>) => {
            writes++;
            if (values[key]) stored = values[key];
          },
        },
      },
      idle: { queryState: async () => "active" },
    });
    setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
    await initializeUrlCanonizer();
    const repo = new ArticlesRepository();
    await repo.initialize(settings);
    await repo.testConnection();
    rejectArticles = true;
    const error = await (
      operation === "save"
        ? repo.saveArticle({ title: "Saved", url: "https://example.com" })
        : repo.deleteArticle(bookmarkId)
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BrowserFailure);
    const response = errorResponse(error);
    expect(response.code).toBe("BrowserFailure");
    expect(response.details).toEqual({
      operation: "read local articles",
      reason: "unknown",
      remoteOperation: operation,
      remoteOutcome: "succeeded",
    });
    expect(response.error).toContain(`Remote ${operation} succeeded`);
    expect(response.error).toContain("Do not repeat it");
    expect(response.error).not.toContain("try again");
    expect(JSON.stringify(response)).not.toMatch(/secret|private.example|token/);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(writes).toBe(0);
    expect(created).toHaveLength(operation === "save" ? 1 : 0);
    expect(removed).toHaveLength(operation === "delete" ? 1 : 0);
    expect(getStorageDiagnostic()).toBeUndefined();
    rejectArticles = false;
    expect(await repo.getAllArticles()).toEqual([]);
    if (operation === "delete") browser.bookmarks.getChildren = async () => [];
    const synced = await repo.syncWithAPI();
    expect(synced.items).toHaveLength(operation === "save" ? 1 : 0);
    expect(stored).toHaveLength(operation === "save" ? 1 : 0);
    expect(created).toHaveLength(operation === "save" ? 1 : 0);
    expect(removed).toHaveLength(operation === "delete" ? 1 : 0);
    const unrelated = await runOperation(Effect.fail(new BrowserFailure("unrelated read"))).catch(
      (error: unknown) => error,
    );
    expect(errorResponse(unrelated).details).not.toHaveProperty("remoteOutcome");
  });
}

test("post-mutation typed failures and defects keep distinct codes and safe known outcomes", async () => {
  for (const failure of [
    new ConfigurationFailure("post-save configuration"),
    new PermissionFailure("post-save permission", "bookmarks"),
    new BrowserFailure("post-save browser"),
    new TypeError("secret=https://private.example/token"),
  ]) {
    const error = await runOperation(
      Effect.gen(function* () {
        yield* recordMutationSuccess("save");
        if (failure instanceof TypeError) return yield* Effect.die(failure);
        return yield* Effect.fail(failure);
      }),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(
      failure instanceof TypeError ? OperationDefect : failure.constructor,
    );
    const response = errorResponse(error);
    expect(response.code).toBe(failure instanceof TypeError ? "INTERNAL_DEFECT" : failure._tag);
    expect(response.details).toMatchObject({ remoteOperation: "save", remoteOutcome: "succeeded" });
    expect(response.error).toContain("Do not repeat it");
    expect(response.error).not.toContain("try again");
    expect(JSON.stringify(response)).not.toMatch(/secret|private.example|token/);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  }
});

test("a bookmark conversion defect after create retains confirmed success", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  browser.bookmarks.create = async (details) => {
    created.push(details);
    return { ...details, id: bookmarkId, dateAdded: Infinity };
  };
  const error = await runOperation(
    api.saveArticle({ title: "Saved", url: "https://example.com" }),
  ).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(OperationDefect);
  expect(created).toHaveLength(1);
  const response = errorResponse(error);
  expect(response.code).toBe("INTERNAL_DEFECT");
  expect(response.details).toEqual({ remoteOperation: "save", remoteOutcome: "succeeded" });
  expect(response.error).toContain("Remote save succeeded");
  expect(response.error).toContain("Do not repeat it");
});

for (const shared of [
  new ConfigurationFailure("read configuration"),
  new PermissionFailure("read permissions", "bookmarks"),
  new BrowserFailure("read local articles", "permission-denied", { name: "NotAllowedError" }),
]) {
  test(`${shared._tag} reuse preserves supplied failure and earlier responses`, async () => {
    const original = Object.getOwnPropertyDescriptors(shared);
    const failed = Effect.fail(shared);
    const save = await runOperation(
      recordMutationSuccess("save").pipe(Effect.andThen(failed)),
    ).catch((error: unknown) => error);
    const savedResponse = JSON.stringify(errorResponse(save));
    const unrelated = await runOperation(failed).catch((error: unknown) => error);
    const deleted = await runOperation(
      recordMutationSuccess("delete").pipe(Effect.andThen(failed)),
    ).catch((error: unknown) => error);
    expect(save).toBeInstanceOf(shared.constructor);
    expect(deleted).toBeInstanceOf(shared.constructor);
    expect(Object.prototype.toString.call(save)).toBe("[object Error]");
    expect(Object.getPrototypeOf(save)).toBe(Object.getPrototypeOf(shared));
    expect(save).not.toBe(shared);
    expect(deleted).not.toBe(shared);
    expect(deleted).not.toBe(save);
    expect(unrelated).toBe(shared);
    expect(Object.getOwnPropertyDescriptors(shared)).toEqual(original);
    expect(errorResponse(unrelated).details).not.toHaveProperty("remoteOutcome");
    expect(JSON.stringify(errorResponse(save))).toBe(savedResponse);
    for (const [error, operation] of [
      [save, "save"],
      [deleted, "delete"],
    ] as const) {
      const response = errorResponse(error);
      expect(response.code).toBe(shared._tag);
      expect(response.details).toMatchObject({
        operation: shared.operation,
        remoteOperation: operation,
        remoteOutcome: "succeeded",
      });
      expect(response.error).toContain(`Remote ${operation} succeeded`);
      expect(response.error).toContain("Do not repeat it");
      if (shared instanceof BrowserFailure)
        expect(response.details).toMatchObject({
          reason: "permission-denied",
          cause: { name: "NotAllowedError" },
        });
      if (shared instanceof PermissionFailure)
        expect(response.details).toMatchObject({ permission: "bookmarks" });
    }
  });
}

test("concurrent runners sharing a failure keep independent save and delete outcomes", async () => {
  const shared = new BrowserFailure("read local articles");
  const failed = Effect.fail(shared);
  const original = Object.getOwnPropertyDescriptors(shared);
  const submitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = runOperation(
    Effect.gen(function* () {
      yield* recordMutationSuccess("save");
      submitted.resolve();
      yield* Effect.promise(() => release.promise);
      return yield* failed;
    }),
  ).catch((error: unknown) => error);
  await submitted.promise;
  const deleted = await runOperation(
    recordMutationSuccess("delete").pipe(Effect.andThen(failed)),
  ).catch((error: unknown) => error);
  const deleteResponse = JSON.stringify(errorResponse(deleted));
  const unrelated = await runOperation(failed).catch((error: unknown) => error);
  release.resolve();
  const saved = await save;
  expect(saved).toBeInstanceOf(BrowserFailure);
  expect(deleted).toBeInstanceOf(BrowserFailure);
  expect(saved).not.toBe(deleted);
  expect(saved).not.toBe(shared);
  expect(deleted).not.toBe(shared);
  expect(unrelated).toBe(shared);
  expect(errorResponse(unrelated).details).not.toHaveProperty("remoteOutcome");
  expect(Object.getOwnPropertyDescriptors(shared)).toEqual(original);
  expect(errorResponse(saved).details).toMatchObject({
    remoteOperation: "save",
    remoteOutcome: "succeeded",
  });
  expect(errorResponse(deleted).details).toMatchObject({
    remoteOperation: "delete",
    remoteOutcome: "succeeded",
  });
  expect(JSON.stringify(errorResponse(deleted))).toBe(deleteResponse);
});
