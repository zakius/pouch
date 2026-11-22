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
  expect(created).toEqual([{ title: "Pouch" }]);
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

test("the message boundary sends plain errors by recovery category", async () => {
  const codeOf = (effect: Effect.Effect<unknown, unknown>) =>
    runOperation(effect).then(
      () => undefined,
      (error: unknown) => errorResponse(error).code,
    );
  expect(await codeOf(Effect.interrupt)).toBe("OPERATION_INTERRUPTED");
  expect(await codeOf(Effect.die(new TypeError("bug")))).toBe("INTERNAL_DEFECT");
  // A failure outside the typed contract is a defect, not a message to show.
  expect(errorResponse(new TypeError("SECRET")).code).toBe("INTERNAL_DEFECT");
  expect(JSON.stringify(errorResponse(new TypeError("SECRET")))).not.toContain("SECRET");
  const response = errorResponse(new BrowserFailure("read tab", "unavailable"));
  expect(response).toMatchObject({ code: "BrowserFailure", details: { operation: "read tab" } });
  expect(structuredClone(response)).toEqual(response);
});

test("the runner preserves interruption separately from defects", async () => {
  await expect(runOperation(Effect.interrupt)).rejects.toBeInstanceOf(OperationInterrupted);
  await expect(runOperation(Effect.die(new Error("bug")))).rejects.toBeInstanceOf(OperationDefect);
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
  await expect(runOperation(repo.syncWithAPI())).rejects.toBeInstanceOf(PermissionFailure);
  granted = true;
  expect((await runOperation(repo.syncWithAPI())).items.map((article) => article.id)).toEqual([bookmarkId]);
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
    await runOperation(repo.testConnection);
    rejectArticles = true;
    const error = await (
      operation === "save"
        ? runOperation(repo.saveArticle({ title: "Saved", url: "https://example.com" }))
        : runOperation(repo.deleteArticle(bookmarkId))
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
    expect(await runOperation(repo.getAllArticles)).toEqual([]);
    if (operation === "delete") browser.bookmarks.getChildren = async () => [];
    const synced = await runOperation(repo.syncWithAPI());
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

test("acquisition uses bookmarks.search, skips managed/non-folder nodes, and prefers syncing folders", async () => {
  const searchQueries: unknown[] = [];
  let getTreeCalls = 0;
  browser.bookmarks.getTree = async () => {
    getTreeCalls++;
    return [];
  };
  browser.bookmarks.search = async (query) => {
    searchQueries.push(query);
    return [
      { id: "managed-folder", title: "Pouch", unmodifiable: "managed" as const },
      { id: "bookmark-item", title: "Pouch", url: "https://pouch.example" },
      { id: "separator-item", title: "Pouch", type: "separator" as const, url: "data:" },
      { id: "local-folder", title: "Pouch", syncing: false } as browser.bookmarks.BookmarkTreeNode,
      { id: "account-folder", title: "Pouch", syncing: true } as browser.bookmarks.BookmarkTreeNode,
    ];
  };

  const api = await runOperation(createBookmarksAdapter(settings));
  expect(searchQueries).toEqual([{ title: "Pouch" }]);
  expect(getTreeCalls).toBe(0);
  expect(created).toEqual([]);

  await runOperation(api.saveArticle({ title: "Saved", url: "https://example.com" }));
  expect(created).toEqual([
    { parentId: "account-folder", title: "Saved", url: "https://example.com" },
  ]);
});

test("acquisition creates Pouch folder without parentId when search finds only unmodifiable folders", async () => {
  browser.bookmarks.search = async () => [
    { id: "managed-folder", title: "Pouch", unmodifiable: "managed" as const },
  ];

  const api = await runOperation(createBookmarksAdapter(settings));
  expect(created).toEqual([{ title: "Pouch" }]);
  expect("parentId" in created[0]).toBe(false);
  await runOperation(api.saveArticle({ title: "Saved", url: "https://example.com" }));
  expect(created[1].parentId).toBe(bookmarkId);
});

test("mid-session folder deletion recovers automatically on saveArticle, sync, and testConnection", async () => {
  let activeFolderId: string | undefined = "folder-v1";
  let nextFolderSeq = 2;
  const folderChildren = new Map<string, browser.bookmarks.BookmarkTreeNode[]>([["folder-v1", []]]);

  browser.bookmarks.search = async () =>
    activeFolderId ? [{ id: activeFolderId, title: "Pouch", type: "folder" }] : [];
  browser.bookmarks.get = async (id) => {
    const key = Array.isArray(id) ? id[0] : id;
    if (key !== activeFolderId) throw new Error("No bookmarks found for the provided GUID.");
    return [{ id: key, title: "Pouch", type: "folder" }];
  };
  browser.bookmarks.getChildren = async (id) => {
    if (id !== activeFolderId) throw new Error("Can't find bookmark for id.");
    return folderChildren.get(id) ?? [];
  };
  browser.bookmarks.create = async (details) => {
    created.push(details);
    if (!details.url) {
      activeFolderId = `folder-v${nextFolderSeq++}`;
      folderChildren.set(activeFolderId, []);
      return { id: activeFolderId, title: details.title ?? "Pouch", type: "folder" };
    }
    if (details.parentId !== activeFolderId) {
      throw new Error("Can't find parent bookmark for id.");
    }
    const item = {
      id: `bm-${created.length}`,
      parentId: details.parentId,
      title: details.title ?? "",
      url: details.url,
      dateAdded: 1700000000000,
    };
    folderChildren.get(activeFolderId)!.push(item);
    return item;
  };

  const api = await runOperation(createBookmarksAdapter(settings));

  // Delete folder mid-session -> saveArticle recreates Pouch folder without parentId and retries once
  activeFolderId = undefined;
  const saved = await runOperation(api.saveArticle({ title: "After Delete", url: "https://example.com/1" }));
  expect(saved.url).toBe("https://example.com/1");
  expect(activeFolderId).toBe("folder-v2");
  expect(created).toEqual([
    { parentId: "folder-v1", title: "After Delete", url: "https://example.com/1" },
    { title: "Pouch" },
    { parentId: "folder-v2", title: "After Delete", url: "https://example.com/1" },
  ]);

  // Replace folder (e.g. Firefox Sync replaces folder GUID) -> sync re-locates new folderId and reads it
  activeFolderId = "folder-synced";
  folderChildren.set("folder-synced", [
    {
      id: "synced-bm",
      title: "Synced",
      url: "https://example.com/synced",
      dateAdded: 1700000005000,
    },
  ]);
  const synced = await runOperation(api.sync());
  expect(synced.articles.map((a) => a.id)).toEqual(["synced-bm"]);

  // Delete folder again -> testConnection recovers and returns true
  activeFolderId = undefined;
  expect(await runOperation(api.testConnection)).toBe(true);
  expect(activeFolderId).toBe("folder-v3");
});

test("Chromium and Firefox missing-node error strings classify as missing-folder", async () => {
  const api = await runOperation(createBookmarksAdapter(settings));
  const messages = [
    "Can't find bookmark for id.",
    "Can't find parent bookmark for id.",
    "No bookmarks found for the provided GUID.",
    "parentGuid must be valid",
    "root is null",
  ];
  for (const message of messages) {
    browser.bookmarks.getChildren = () => Promise.reject(new Error(message));
    const error = await runOperation(api.sync()).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BrowserFailure);
    expect(errorResponse(error).details).toMatchObject({ reason: "missing-folder" });
  }
});

for (const missingMessage of [
  "Can't find bookmark for id.",
  "No bookmarks found for the provided GUID.",
]) {
  test(`deleteArticle treats already-removed bookmark (${missingMessage}) as idempotent success when folder exists`, async () => {
    const key = getAccountStorageKeys(settings).articles;
    const stored: Record<string, unknown> = {
      [key]: [
        {
          id: "ghost-id",
          title: "Ghost",
          url: "https://example.com/ghost",
          canonicalUrl: "https://example.com/ghost",
          created_at: "2023-11-14T22:13:20.000Z",
        },
      ],
    };
    let folderExists = true;
    let getCalls = 0;
    Object.assign(browser, {
      storage: {
        local: {
          get: async (keys: string[]) =>
            Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
          set: async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          },
        },
      },
      idle: { queryState: async () => "active" },
    });
    browser.bookmarks.get = async (id) => {
      getCalls++;
      if (!folderExists) throw new Error(missingMessage);
      return [{ id: Array.isArray(id) ? id[0] : id, title: "Pouch", type: "folder" }];
    };
    browser.bookmarks.remove = async () => {
      throw new Error(missingMessage);
    };

    setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
    await initializeUrlCanonizer();
    const repo = new ArticlesRepository();
    repo.initialize(settings);

    await expect(runOperation(repo.deleteArticle("ghost-id"))).resolves.toEqual({
      success: true,
      id: "ghost-id",
    });
    expect(getCalls).toBe(1);
    expect(await runOperation(repo.getAllArticles)).toEqual([]);
    expect(stored[key]).toEqual([]);

    // When the Pouch folder itself is missing, deleteArticle still reports missing-folder.
    folderExists = false;
    const error = await runOperation(repo.deleteArticle("ghost-id")).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BrowserFailure);
    expect(errorResponse(error).details).toMatchObject({ reason: "missing-folder" });
  });
}

test("sync filters Firefox separators, stabilizes missing dateAdded, and always uses overwrite mode", async () => {
  browser.bookmarks.getChildren = async () => [
    { id: "sep1", type: "separator", url: "data:", title: "" },
    { id: "sub1", type: "folder", title: "Subfolder" },
    { id: "bm-no-date", type: "bookmark", title: "No Date", url: "https://example.com/no-date" },
    {
      id: "bm-dated",
      type: "bookmark",
      title: "Dated",
      url: "https://example.com/dated",
      dateAdded: 1700000000000,
    },
  ];
  const api = await runOperation(createBookmarksAdapter(settings));
  const result = await runOperation(api.sync({ mode: "update" }));
  expect(result.mode).toBe("overwrite");
  expect(result.articles).toEqual([
    {
      id: "bm-no-date",
      title: "No Date",
      url: "https://example.com/no-date",
      created_at: "1970-01-01T00:00:00.000Z",
    },
    {
      id: "bm-dated",
      title: "Dated",
      url: "https://example.com/dated",
      created_at: new Date(1700000000000).toISOString(),
    },
  ]);
});

test("ArticlesRepository skips redundant storage.local writes on unchanged syncs", async () => {
  const keys = getAccountStorageKeys(settings);
  const stored: Record<string, unknown> = {};
  const writtenKeys: string[] = [];
  let remoteBookmarks: browser.bookmarks.BookmarkTreeNode[] = [
    {
      id: "bm-1",
      title: "Stable",
      url: "https://example.com/stable",
      dateAdded: 1700000000000,
    },
  ];
  Object.assign(browser, {
    storage: {
      local: {
        get: async (names: string[]) =>
          Object.fromEntries(names.filter((k) => k in stored).map((k) => [k, stored[k]])),
        set: async (values: Record<string, unknown>) => {
          writtenKeys.push(...Object.keys(values));
          Object.assign(stored, values);
        },
      },
    },
    idle: { queryState: async () => "active" },
  });
  browser.bookmarks.getChildren = async () => remoteBookmarks;

  setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
  await initializeUrlCanonizer();
  const repo = new ArticlesRepository();
  repo.initialize(settings);

  // First sync writes articles + timestamps.
  await runOperation(repo.syncWithAPI());
  expect(writtenKeys.filter((k) => k === keys.articles)).toHaveLength(1);
  expect(writtenKeys).toContain(keys.lastSyncTimestamp);

  // Second unchanged sync skips writing articles, but still updates sync timestamps.
  writtenKeys.length = 0;
  await runOperation(repo.syncWithAPI());
  expect(writtenKeys.filter((k) => k === keys.articles)).toHaveLength(0);
  expect(writtenKeys).toContain(keys.lastSyncTimestamp);

  // Third sync with a changed title writes articles again.
  writtenKeys.length = 0;
  remoteBookmarks = [
    {
      id: "bm-1",
      title: "Renamed",
      url: "https://example.com/stable",
      dateAdded: 1700000000000,
    },
  ];
  await runOperation(repo.syncWithAPI());
  expect(writtenKeys.filter((k) => k === keys.articles)).toHaveLength(1);
  expect((await runOperation(repo.getAllArticles))[0]?.title).toBe("Renamed");
});
