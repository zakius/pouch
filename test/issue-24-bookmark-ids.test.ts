import { afterEach, beforeEach, expect, test, mock } from "bun:test";
import type { Article } from "../src/types/common";
import { BookmarksAdapter } from "../src/background/api/adapters/bookmarks-adapter";
import { ArticlesRepository } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

const stringIdBookmarks = [
  {
    id: "12abcDEF_-xy",
    title: "First",
    url: "https://example.com/first",
    dateAdded: 1700000000000,
  },
  {
    id: "12xyz",
    title: "Second",
    url: "https://example.com/second",
    dateAdded: 1700000001000,
  },
  {
    id: "abcDEF123_-x",
    title: "Third",
    url: "https://example.com/third",
    dateAdded: 1700000002000,
  },
];

afterEach(async () => {
  mock.restore();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
});

function makeBrowserMock(options: {
  bookmarks?: { id: string; title: string; url?: string; dateAdded?: number }[];
  removedIds?: unknown[];
}) {
  const folder = { id: "folder-1", title: "Pouch", children: options.bookmarks ?? [] };
  Object.assign(globalThis, {
    browser: {
      bookmarks: {
        getTree: async () => [folder],
        getChildren: async (_folderId: string) => folder.children,
        create: async (details: { id?: string; title: string; url: string }) => ({
          id: details.id ?? "new-ID_1",
          title: details.title,
          url: details.url,
          dateAdded: 1700000030000,
        }),
        remove: async (id: string) => {
          options.removedIds?.push(id);
        },
      },
      storage: {
        local: {
          data: {} as Record<string, unknown>,
          get: async function (keys: string[]) {
            const out: Record<string, unknown> = {};
            for (const key of keys) {
              if (key in this.data) out[key] = this.data[key];
            }
            return out;
          },
          set: async function (values: Record<string, unknown>) {
            Object.assign(this.data, values);
          },
          remove: async function (keys: string[]) {
            for (const key of keys) delete this.data[key];
          },
        },
      },
      idle: { queryState: async () => "active" },
    },
  });
}

beforeEach(() => {
  makeBrowserMock({ bookmarks: stringIdBookmarks });
});

test("sync preserves native alphanumeric bookmark IDs, including shared numeric prefixes", async () => {
  const adapter = new BookmarksAdapter();
  const result = await adapter.sync({ mode: "overwrite" });
  expect(result.articles.map((a) => a.id)).toEqual([
    "12abcDEF_-xy",
    "12xyz",
    "abcDEF123_-x",
  ]);
});

test("saveArticle returns the bookmark's native string ID", async () => {
  const adapter = new BookmarksAdapter();
  const saved = await adapter.saveArticle({ url: "https://example.com/new", title: "New" });
  expect(saved.id).toBe("new-ID_1");
});

test("deleteArticle passes the exact original ID to the browser", async () => {
  const removedIds: unknown[] = [];
  makeBrowserMock({ bookmarks: stringIdBookmarks, removedIds });
  const adapter = new BookmarksAdapter();
  await adapter.deleteArticle("12abcDEF_-xy");
  await adapter.deleteArticle("12xyz");
  expect(removedIds).toEqual(["12abcDEF_-xy", "12xyz"]);
});

test("repository deleteArticle removes string-ID articles from cache and forwards the exact ID", async () => {
  const removedIds: unknown[] = [];
  makeBrowserMock({ bookmarks: stringIdBookmarks, removedIds });
  const repo = new ArticlesRepository();
  await repo.initialize({
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig: {},
  } as Parameters<ArticlesRepository["initialize"]>[0]);
  await repo.syncWithAPI({ mode: "overwrite" });
  expect(await repo.getArticle("12xyz")).toBeDefined();

  await repo.deleteArticle("12xyz");

  expect(removedIds).toEqual(["12xyz"]);
  expect(await repo.getArticle("12xyz")).toBeUndefined();
  expect(await repo.getArticle("12abcDEF_-xy")).toBeDefined();
});

test("sync rebuilds the cache and replaces previously corrupted numeric IDs", async () => {
  const corrupted: Article[] = [
    {
      id: Number.NaN,
      title: "Corrupted",
      url: "https://example.com/first",
      created_at: "2023-11-14T22:13:20.000Z",
    },
  ];
  makeBrowserMock({ bookmarks: stringIdBookmarks });
  const storage = (
    (globalThis as unknown as { browser: { storage: { local: { data: Record<string, unknown> } } } })
      .browser.storage.local
  );
  storage.data.articles = corrupted;

  const repo = new ArticlesRepository();
  await repo.initialize({
    ...DEFAULT_SETTINGS,
    backend: "bookmarks",
    apiConfig: {},
  } as Parameters<ArticlesRepository["initialize"]>[0]);
  await repo.syncWithAPI({ mode: "overwrite" });

  const articles = await repo.getAllArticles();
  expect(articles.map((a) => a.id)).toEqual(["12abcDEF_-xy", "12xyz", "abcDEF123_-x"]);
});
