import { setFilterListSources, resetFilterListSources } from "../src/utils/filter-list-manager";
import { initializeUrlCanonizer } from "../src/utils/url-helpers";
import { ArticlesRepository } from "../src/background/articles-repository";
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
