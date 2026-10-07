import { Effect } from "effect";
import * as v from "valibot";
import { IS_CHROMIUM } from "../../../utils/chromium";
import { bookmarksSettingsSchema, type BookmarksSettings } from "../../../utils/settings-schemas";
import { DEFAULT_SETTINGS } from "../../../utils/settings";
import type { Article } from "../../../types/common";
import {
  BrowserFailure,
  ConfigurationFailure,
  PermissionFailure,
  runOperation,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
} from "../effect-adapter";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";
export { bookmarksSettingsSchema };
export type { BookmarksSettings };

type BookmarkNode = browser.bookmarks.BookmarkTreeNode;

function findFolder(nodes: BookmarkNode[]): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.title === "Pouch" && !node.url) return node;
    const found = node.children && findFolder(node.children);
    if (found) return found;
  }
  return undefined;
}

function toArticle(bookmark: BookmarkNode): Article {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url || "",
    created_at: new Date(bookmark.dateAdded || Date.now()).toISOString(),
  };
}

// Capture the browser API at acquisition so later account/draft work cannot replace it.
export const createBookmarksAdapter = Effect.fn("bookmarks.acquire")(function* (
  settings: BookmarksSettings,
) {
  if (!v.safeParse(bookmarksSettingsSchema, settings).success) {
    return yield* Effect.fail(new ConfigurationFailure("bookmarks.acquire"));
  }
  yield* storageHealthy;
  const bookmarks = browser.bookmarks;
  if (!bookmarks)
    return yield* Effect.fail(new PermissionFailure("bookmarks.acquire", "bookmarks"));

  function call<A>(operation: string, request: () => Promise<A>): Effect.Effect<A, BrowserFailure> {
    // Synchronous implementation exceptions are defects; browser Promise rejection is an expected browser failure.
    return Effect.suspend(() => {
      const requestPromise = request();
      return Effect.tryPromise({
        try: () => requestPromise,
        catch: () => new BrowserFailure(operation),
      });
    });
  }

  const permissions = browser.permissions;
  const permissionHealthy = Effect.gen(function* () {
    if (!permissions) return;
    const granted = yield* call("check bookmarks permission", () =>
      permissions.contains({ permissions: ["bookmarks"] }),
    );
    if (!granted)
      return yield* Effect.fail(new PermissionFailure("bookmarks permission check", "bookmarks"));
  });
  yield* permissionHealthy;
  yield* storageHealthy;

  const tree = yield* call("read bookmarks tree", () => bookmarks.getTree());
  let folder = findFolder(tree);
  if (!folder) {
    yield* storageHealthy;
    folder = yield* call("create Pouch folder", () =>
      bookmarks.create({
        title: "Pouch",
        parentId: IS_CHROMIUM ? "2" : "unfiled_____",
      }),
    );
  }
  const folderId = folder.id;
  yield* storageHealthy;

  const adapter: EffectAdapter = {
    displayName: "Browser Bookmarks",
    formConfig: [],
    saveArticle: Effect.fn("bookmarks.save")(function* (article: SavingArticle) {
      yield* storageHealthy;
      yield* permissionHealthy;
      yield* storageHealthy;
      const bookmark = yield* call("save bookmark", () =>
        bookmarks.create({
          parentId: folderId,
          title: article.title,
          url: article.url,
        }),
      );
      return toArticle(bookmark);
    }),
    deleteArticle: Effect.fn("bookmarks.delete")(function* (id: number | string) {
      yield* storageHealthy;
      yield* permissionHealthy;
      yield* storageHealthy;
      yield* call("delete bookmark", () => bookmarks.remove(String(id)));
    }),
    sync: Effect.fn("bookmarks.sync")(function* (options?: SyncOptions) {
      yield* storageHealthy;
      yield* permissionHealthy;
      yield* storageHealthy;
      const children = yield* call("read Pouch bookmarks", () => bookmarks.getChildren(folderId));
      const articles = children.filter((bookmark) => bookmark.url).map(toArticle);
      return {
        articles,
        mode: options?.mode || "overwrite",
        metadata: {
          totalFetched: articles.length,
          totalProcessed: articles.length,
          lastSyncTimestamp: new Date().toISOString(),
          apiVersion: "1.0",
        },
      };
    }),
    testConnection: Effect.gen(function* () {
      yield* storageHealthy;
      yield* permissionHealthy;
      yield* storageHealthy;
      yield* call("test bookmarks connection", () => bookmarks.getChildren(folderId));
      yield* storageHealthy;
      return true as const;
    }).pipe(Effect.withSpan("bookmarks.testConnection")),
  };
  return adapter;
}) satisfies (settings: BookmarksSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;

/** Temporary legacy adapter entry point. Remove in #81 after callers accept ready Effect adapters. */
export class BookmarksAdapter implements ReadItLaterAPI<BookmarksSettings> {
  readonly displayName = "Browser Bookmarks";
  readonly formConfig = [];
  private ready: Promise<EffectAdapter> | undefined;

  private acquire(
    settings: unknown = { ...DEFAULT_SETTINGS, backend: "bookmarks", apiConfig: {} },
  ): Promise<EffectAdapter> {
    this.ready ??= runOperation(
      Effect.suspend(() => {
        const result = v.safeParse(bookmarksSettingsSchema, settings);
        return result.success
          ? createBookmarksAdapter(result.output)
          : Effect.fail(new ConfigurationFailure("bookmarks.acquire"));
      }),
    ).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  async initialize(settings?: unknown): Promise<void> {
    await this.acquire(settings);
  }
  async testConnection(): Promise<boolean> {
    return runOperation((await this.acquire()).testConnection);
  }
  async saveArticle(article: SavingArticle): Promise<Article> {
    return runOperation((await this.acquire()).saveArticle(article));
  }
  async deleteArticle(id: number | string): Promise<void> {
    return runOperation((await this.acquire()).deleteArticle(id));
  }
  async sync(options?: SyncOptions): Promise<SyncResult> {
    return runOperation((await this.acquire()).sync(options));
  }
}
