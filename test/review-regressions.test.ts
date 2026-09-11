import { afterEach, expect, spyOn, test, mock } from "bun:test";
import * as v from "valibot";
import { ApiClient } from "../src/background/api/api-client";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import { tokenManager } from "../src/background/token-manager";
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

test("HTTP failures reject requests and fail connection tests", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("test");
  const fetchMock = spyOn(globalThis, "fetch");
  for (const status of [401, 403, 404, 500]) {
    fetchMock.mockResolvedValue(new Response("failure", { status }));
    const client = new ApiClient(
      "test",
      "https://example.com",
      {},
      { autoRetryOnAuth: false, rateLimit: { delayMs: 0 } },
    );
    await expect(client.delete("/articles/1")).rejects.toThrow(String(status));
    expect(await client.testConnection()).toBe(false);
  }
  fetchMock.mockResolvedValue(
    new Response(null, { status: 204, headers: { "Content-Type": "application/json" } }),
  );
  const client = new ApiClient("test", "https://example.com");
  expect((await client.delete("/articles/1", { authenticated: false })).status).toBe(204);
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
  await expect(repository.deleteArticle(1)).rejects.toThrow("Deletion failed");
  expect(await repository.getAllArticles()).toEqual([article]);
  expect(storage[keys.articles]).toEqual([article]);
  remove.mockResolvedValue(undefined);
  await repository.deleteArticle(1);
  expect(await repository.getAllArticles()).toEqual([]);
  expect(storage[keys.articles]).toEqual([]);
});
