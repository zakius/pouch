import { Effect } from "effect";
import { reportRemoteOutcome } from "../../../utils/fatal-storage";
import * as v from "valibot";
import { bookmarksSettingsSchema, type BookmarksSettings } from "../../../utils/settings-schemas";
import type { Article } from "../../../types/common";
import {
  BrowserFailure,
  ConfigurationFailure,
  PermissionFailure,
  recordMutationSuccess,
  storageHealthy,
  type AcquisitionError,
  type EffectAdapter,
  type FatalStorageFailure,
} from "../effect-adapter";
import type { SavingArticle } from "../read-it-later-adapter";
export { bookmarksSettingsSchema };
export type { BookmarksSettings };

type BookmarkNode = browser.bookmarks.BookmarkTreeNode & { syncing?: boolean };

const MISSING_NODE_PATTERN =
  /(?:bookmark|folder|parent).*not found|no (?:bookmarks?|folder|parent)|can't find (?:parent )?bookmark for id|parentguid must be valid|root is null/i;

function isModifiablePouchFolder(node: BookmarkNode): boolean {
  if (node.title !== "Pouch") return false;
  if (node.unmodifiable) return false;
  return node.type ? node.type === "folder" : !node.url;
}

function pickPreferredFolder(nodes: readonly BookmarkNode[]): BookmarkNode | undefined {
  let fallback: BookmarkNode | undefined;
  for (const node of nodes) {
    if (!isModifiablePouchFolder(node)) continue;
    if (node.syncing === true) return node;
    fallback ??= node;
  }
  return fallback;
}

function collectFolders(nodes: readonly BookmarkNode[], out: BookmarkNode[] = []): BookmarkNode[] {
  for (const node of nodes) {
    if (isModifiablePouchFolder(node)) out.push(node);
    if (node.children) collectFolders(node.children, out);
  }
  return out;
}

function toArticle(bookmark: BookmarkNode): Article {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url || "",
    created_at: new Date(bookmark.dateAdded ?? 0).toISOString(),
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
        catch: (error) => {
          const message =
            error instanceof Error ? error.message : typeof error === "string" ? error : "";
          const name =
            error instanceof Error &&
            [
              "NotFoundError",
              "NotAllowedError",
              "SecurityError",
              "InvalidStateError",
              "TypeError",
              "Error",
            ].includes(error.name)
              ? error.name
              : undefined;
          const reason =
            name === "NotFoundError" || MISSING_NODE_PATTERN.test(message)
              ? "missing-folder"
              : name === "NotAllowedError" ||
                  name === "SecurityError" ||
                  /permission denied|access denied|not permitted/i.test(message)
                ? "permission-denied"
                : /unavailable|disabled|not supported/i.test(message)
                  ? "unavailable"
                  : "unknown";
          return new BrowserFailure(operation, reason, name ? { name } : undefined);
        },
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

  const findExistingFolder = Effect.gen(function* () {
    if (typeof bookmarks.search === "function") {
      const matches = yield* call("search Pouch folder", () =>
        bookmarks.search({ title: "Pouch" }),
      );
      return pickPreferredFolder(matches);
    }
    const tree = yield* call("read bookmarks tree", () => bookmarks.getTree());
    return pickPreferredFolder(collectFolders(tree));
  });

  const resolveOrCreateFolder = Effect.gen(function* () {
    const existing = yield* findExistingFolder;
    if (existing) return existing;
    yield* storageHealthy;
    return yield* call("create Pouch folder", () => bookmarks.create({ title: "Pouch" }));
  });

  let folderId = (yield* resolveOrCreateFolder).id;
  yield* storageHealthy;

  const verifyFolderExists = (operation: string): Effect.Effect<void, BrowserFailure> =>
    Effect.gen(function* () {
      if (typeof bookmarks.get === "function") {
        const nodes = yield* call(operation, () => bookmarks.get(folderId));
        if (nodes.length === 0) {
          return yield* Effect.fail(new BrowserFailure(operation, "missing-folder"));
        }
        return;
      }
      yield* call(operation, () => bookmarks.getChildren(folderId));
    });

  const withFolderRecovery = <A>(
    run: () => Effect.Effect<A, BrowserFailure>,
  ): Effect.Effect<A, BrowserFailure | FatalStorageFailure> =>
    run().pipe(
      Effect.catchIf(
        (error) => error.reason === "missing-folder",
        () =>
          Effect.gen(function* () {
            yield* storageHealthy;
            const folder = yield* resolveOrCreateFolder;
            folderId = folder.id;
            yield* storageHealthy;
            return yield* run();
          }),
      ),
    );

  const adapter: EffectAdapter = {
    saveArticle: Effect.fn("bookmarks.save")(function* (article: SavingArticle) {
      yield* storageHealthy;
      yield* permissionHealthy.pipe(Effect.interruptible);
      yield* storageHealthy;
      return yield* Effect.gen(function* () {
        const bookmark = yield* withFolderRecovery(() =>
          call("save bookmark", () =>
            bookmarks.create({ parentId: folderId, title: article.title, url: article.url }),
          ),
        );
        reportRemoteOutcome("save", "succeeded");
        yield* recordMutationSuccess("save");
        return toArticle(bookmark);
      }).pipe(Effect.uninterruptible);
    }),
    deleteArticle: Effect.fn("bookmarks.delete")(function* (id: number | string) {
      yield* storageHealthy;
      yield* permissionHealthy.pipe(Effect.interruptible);
      yield* storageHealthy;
      yield* Effect.gen(function* () {
        yield* call("delete bookmark", () => bookmarks.remove(String(id))).pipe(
          Effect.catchIf(
            (error) => error.reason === "missing-folder",
            () =>
              Effect.gen(function* () {
                yield* storageHealthy;
                yield* verifyFolderExists("verify Pouch folder");
              }),
          ),
        );
        reportRemoteOutcome("delete", "succeeded");
        yield* recordMutationSuccess("delete");
      }).pipe(Effect.uninterruptible);
    }),
    sync: Effect.fn("bookmarks.sync")(function* () {
      yield* storageHealthy;
      yield* permissionHealthy;
      yield* storageHealthy;
      const children = yield* withFolderRecovery(() =>
        call("read Pouch bookmarks", () => bookmarks.getChildren(folderId)),
      );
      const articles = children
        .filter((bookmark) => bookmark.type !== "separator" && Boolean(bookmark.url))
        .map(toArticle);
      return {
        articles,
        mode: "overwrite" as const,
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
      yield* withFolderRecovery(() => verifyFolderExists("test bookmarks connection"));
      yield* storageHealthy;
      return true as const;
    }).pipe(Effect.withSpan("bookmarks.testConnection")),
  };
  return adapter;
}) satisfies (settings: BookmarksSettings) => Effect.Effect<EffectAdapter, AcquisitionError>;
