import { Effect, Fiber } from "effect";
import { forkDetachLogged, runOperation } from "../src/background/api/effect-adapter";
import { logger } from "../src/utils/logger";
import { afterEach, expect, spyOn, test, mock } from "bun:test";
import * as v from "valibot";
import { requestJson } from "../src/background/api/effect-api-client";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS, settingsSchema } from "../src/utils/settings";
import { canonicalizeUrl } from "../src/utils/url-helpers";
import { cleanUrl, initializeWithRawFilterLists } from "../src/utils/filter-list-url-cleaner";
import {
  initializeUrlCleanerWithRemoteLists,
  setFilterListSources,
  resetFilterListSources,
} from "../src/utils/filter-list-manager";
import testFilterContent from "./test-data/test-filters.txt";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

const keys = getAccountStorageKeys(DEFAULT_SETTINGS);
afterEach(async () => {
  mock.restore();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
  resetFilterListSources();
  await initializeWithRawFilterLists([{ name: "TestFilters", content: testFilterContent }]);
});

test("LinkAce settings pass the shared schema", () => {
  expect(
    v.safeParse(settingsSchema, {
      ...DEFAULT_SETTINGS,
      backend: "linkace",
      apiConfig: { url: "https://example.com", token: "test" },
    }).success,
  ).toBe(true);
});

test("YouTube short, mobile, and desktop URLs identify the same video", async () => {
  Object.assign(globalThis, { browser: { storage: { local: { get: async () => ({}) } } } });
  setFilterListSources([{ name: "empty", url: "data:text/plain;base64,IQ==" }]);
  for (const url of [
    "https://youtu.be/abc123",
    "https://youtube.com/watch?v=abc123",
    "https://m.youtube.com/shorts/abc123",
    "https://www.youtube.com/shorts/abc123",
  ]) {
    expect(await canonicalizeUrl(url)).toBe("https://www.youtube.com/watch?v=abc123");
  }
});

test("filter exceptions survive fresh loading and cache loading", async () => {
  const storage: Record<string, unknown> = {};
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: async () => storage,
          set: async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          },
        },
      },
    },
  });
  const content =
    "||example.com^$removeparam=keep\n@@||example.com^$removeparam=keep\n$removeparam=tracking";
  setFilterListSources([{ name: "exceptions", url: `data:text/plain;base64,${btoa(content)}` }]);
  for (let i = 0; i < 2; i++) {
    await initializeUrlCleanerWithRemoteLists();
    expect(await cleanUrl("https://example.com/?keep=yes&tracking=no")).toBe(
      "https://example.com/?keep=yes",
    );
  }
});

test("HTTP failures reject requests with their recovery category", async () => {
  Object.assign(globalThis, { browser: { permissions: { contains: async () => true } } });
  const fetchMock = spyOn(globalThis, "fetch");
  const request = () =>
    runOperation(
      requestJson({
        operation: "test.delete",
        url: "https://example.com/articles/1",
        init: { method: "DELETE" },
      }),
    );
  for (const [status, tag] of [
    [401, "CredentialsFailure"],
    [403, "CredentialsFailure"],
    [404, "HttpFailure"],
    [500, "HttpFailure"],
  ] as const) {
    fetchMock.mockResolvedValue(new Response("failure", { status }));
    await expect(request()).rejects.toMatchObject({ _tag: tag });
  }
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  expect(await request()).toBeUndefined();
});

test("failed remote deletion preserves cached articles", async () => {
  const article = {
    id: 1,
    url: "https://example.com/",
    title: "Example",
    created_at: "2026-01-01",
  };
  const storage = {
    [keys.articles]: [article],
  };
  const remove = mock(async (): Promise<void> => {
    throw new Error("Deletion failed");
  });
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: async () => storage,
          set: async (values: object) => {
            Object.assign(storage, values);
          },
        },
      },
      bookmarks: { getTree: async () => [{ id: "folder", title: "Pouch" }], remove },
    },
  });
  const repository = new ArticlesRepository();
  await repository.initialize(DEFAULT_SETTINGS);
  await expect(runOperation(repository.deleteArticle(1))).rejects.toThrow("Browser delete bookmark failed");
  expect(await runOperation(repository.getAllArticles)).toEqual([article]);
  expect(storage[keys.articles]).toEqual([article]);
  remove.mockResolvedValue(undefined);
  await runOperation(repository.deleteArticle(1));
  expect(await runOperation(repository.getAllArticles)).toEqual([]);
  expect(storage[keys.articles]).toEqual([]);
});

test("a detached fiber that dies is logged, and an interrupted one is not", async () => {
  const error = spyOn(logger, "error").mockImplementation(() => {});
  await Effect.runPromise(
    forkDetachLogged("Background work", Effect.die(new Error("boom"))).pipe(
      Effect.flatMap(Fiber.await),
    ),
  );
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]?.[0]).toBe("Background work failed:");
  expect(String(error.mock.calls[0]?.[1])).toContain("boom");

  await Effect.runPromise(
    forkDetachLogged("Interrupted work", Effect.interrupt).pipe(Effect.flatMap(Fiber.await)),
  );
  expect(error).toHaveBeenCalledTimes(1);
});
