import { expect, spyOn, test } from "bun:test";
import { getAccountStorageKeys } from "../src/background/articles-repository";
import { runOperation } from "../src/background/api/effect-adapter";
import { tokenManager } from "../src/background/token-manager";
import { LogLevel, logger } from "../src/utils/logger";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

// A settings save while an article save is still waiting for its backend.
type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;
type StorageChangedListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;
const listeners: Listener[] = [];
const storageChangedListeners: StorageChangedListener[] = [];
const event = { addListener: () => {} };
const bookmarksSettings = { ...DEFAULT_SETTINGS, backend: "bookmarks" as const, apiConfig: {} };
const syncStore: Record<string, unknown> = { ...bookmarksSettings };
const localStore: Record<string, unknown> = {};
const saved: { id: string; title: string; url: string; dateAdded: number }[] = [];
let activeTabs: { id: number; url: string }[] = [];
const tabUiUpdates: { tabId: number; title: string }[] = [];

function emitStorageChanged(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) {
  for (const listener of storageChangedListeners) listener(changes, areaName);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
let createStarted = deferred();
let releaseCreate = deferred();
let afterRemove: (() => Promise<void>) | undefined;
let rejectSyncSet: Error | undefined;

const pick = (store: Record<string, unknown>, keys: string | string[] | null) =>
  keys === null
    ? { ...store }
    : Object.fromEntries(
        (typeof keys === "string" ? [keys] : keys)
          .filter((key) => key in store)
          .map((key) => [key, store[key]]),
      );

Object.assign(globalThis, {
  browser: {
    runtime: {
      getURL: (path: string) => path,
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      onInstalled: event,
      onStartup: event,
      sendMessage: async () => {},
    },
    storage: {
      onChanged: {
        addListener: (listener: StorageChangedListener) => storageChangedListeners.push(listener),
      },
      sync: {
        get: async (keys: string | string[]) => pick(syncStore, keys),
        set: async (values: Record<string, unknown>) => {
          if (rejectSyncSet) throw rejectSyncSet;
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: syncStore[key], newValue: value };
          }
          Object.assign(syncStore, values);
          emitStorageChanged(changes, "sync");
        },
      },
      local: {
        get: async (keys: string | string[] | null) => pick(localStore, keys),
        set: async (values: Record<string, unknown>) => Object.assign(localStore, values),
        remove: async (keys: string | string[]) => {
          for (const key of typeof keys === "string" ? [keys] : keys) delete localStore[key];
          await afterRemove?.();
        },
      },
    },
    bookmarks: {
      getTree: async () => [{ id: "folder", title: "Pouch", children: [] }],
      getChildren: async () => [...saved],
      create: async (details: { title: string; url: string }) => {
        createStarted.resolve();
        await releaseCreate.promise;
        const bookmark = { id: `b${saved.length}`, ...details, dateAdded: 1700000000000 };
        saved.push(bookmark);
        return bookmark;
      },
      remove: async () => {},
    },
    alarms: {
      clear: async () => {},
      create: async () => {},
      get: async () => undefined,
      onAlarm: event,
    },
    contextMenus: {
      create: (_details: unknown, callback?: () => void) => callback?.(),
      update: async () => {},
      onClicked: event,
      removeAll: async () => {},
    },
    idle: { queryState: async () => "active" },
    pageAction: {
      onClicked: event,
      setIcon: async () => {},
      setTitle: async (details: { tabId: number; title: string }) => {
        tabUiUpdates.push(details);
      },
      show: async () => {},
    },
    commands: { onCommand: event },
    notifications: { create: async () => "", onClicked: event },
    permissions: { onRemoved: event, contains: async () => true },
    tabs: {
      query: async () => activeTabs,
      get: async (tabId: number) => activeTabs.find((tab) => tab.id === tabId) ?? {},
      onUpdated: event,
      onActivated: event,
    },
  },
  fetch: (async () =>
    new Response(JSON.stringify({ result: true, items: [], count: 0 }))) as unknown as typeof fetch,
});

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    for (const listener of listeners) if (listener(message, {}, resolve)) return;
  });
}

await import("../src/background/background");
await sendMessage({ type: "getStorageDiagnostic" });

test("a save that keeps the account identity keeps an in-flight save in the cache", async () => {
  const url = "https://example.com/in-flight";
  const save = sendMessage({ type: "saveArticle", payload: { url, title: "In flight" } });
  await createStarted.promise;
  // Only a non-identity setting changes.
  const settings = { ...bookmarksSettings, normalizeOnSave: true };
  expect(await sendMessage({ type: "saveSettings", payload: { settings } })).toEqual({
    success: true,
  });
  releaseCreate.resolve();
  expect(await save).toMatchObject({ url });
  // The remote save succeeded, so the page must not look unsaved.
  expect(await sendMessage({ type: "checkArticle", payload: { url } })).toMatchObject({ url });
});

test("an account change retires the old account before removing its keys", async () => {
  createStarted = deferred();
  releaseCreate = deferred();
  const oldKeys = getAccountStorageKeys({ ...bookmarksSettings, normalizeOnSave: true });
  expect(localStore[oldKeys.articles]).toBeDefined();
  const save = sendMessage({
    type: "saveArticle",
    payload: { url: "https://example.com/late", title: "Late" },
  });
  await createStarted.promise;
  // The old account's save completes right after its keys are removed.
  let activeAtRemove: unknown = "not removed";
  afterRemove = async () => {
    afterRemove = undefined;
    // The old account's cached article is visible only while the old account is still active.
    activeAtRemove = await sendMessage({
      type: "checkArticle",
      payload: { url: "https://example.com/in-flight" },
    });
    releaseCreate.resolve();
  };
  const raindrop = { ...DEFAULT_SETTINGS, backend: "raindrop", apiConfig: { apiKey: "key" } };
  expect(await sendMessage({ type: "saveSettings", payload: { settings: raindrop } })).toEqual({
    success: true,
  });
  await save;
  expect(activeAtRemove).toBeUndefined();
  expect(Object.keys(localStore).filter((key) => key.endsWith(oldKeys.articles.slice(9)))).toEqual(
    [],
  );
});

test("a rejected settings write reports the browser's reason", async () => {
  rejectSyncSet = new Error("QUOTA_BYTES_PER_ITEM quota exceeded.");
  const response = await sendMessage({
    type: "saveSettings",
    payload: { settings: bookmarksSettings },
  });
  rejectSyncSet = undefined;
  expect(response).toMatchObject({
    code: "BrowserFailure",
    error:
      "Browser save settings failed. Browser reported: quota_bytes. Fix the reported cause and try again.",
    details: {
      reason: "rejected",
      cause: { name: "Error", message: "Browser reported: quota_bytes" },
    },
  });
});

test("out-of-band storage.sync change updates logger, repository, tokens, and active tab UI without double-triggering on saveSettings", async () => {
  const wallabagA = {
    ...DEFAULT_SETTINGS,
    backend: "wallabag" as const,
    logLevel: LogLevel.ERROR,
    apiConfig: {
      url: "https://a.example",
      clientId: "cid-a",
      clientSecret: "secret-a",
      username: "user-a",
      password: "pass-a",
    },
  };
  const wallabagB = {
    ...wallabagA,
    logLevel: LogLevel.DEBUG,
    apiConfig: {
      url: "https://b.example",
      clientId: "cid-b",
      clientSecret: "secret-b",
      username: "user-b",
      password: "pass-b",
    },
  };

  // Own saveSettings write emits storage.onChanged via our mock sync.set, and must NOT double-trigger UI refresh.
  activeTabs = [{ id: 11, url: "https://example.com/synced" }];
  tabUiUpdates.length = 0;
  const setLevelSpy = spyOn(logger, "setLevel");
  expect(await sendMessage({ type: "saveSettings", payload: { settings: wallabagA } })).toEqual({
    success: true,
  });
  await Bun.sleep(20);
  expect(setLevelSpy).toHaveBeenCalledTimes(1);
  expect(tabUiUpdates).toEqual([]);

  // Seed Account A token and cached article, plus Account B cached article.
  await runOperation(
    tokenManager.storeToken("wallabag", {
      accessToken: "token-a",
      refreshToken: "refresh-a",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      issuedAt: Date.now(),
      refreshCount: 0,
    }),
  );
  const keysA = getAccountStorageKeys(wallabagA);
  const keysB = getAccountStorageKeys(wallabagB);
  localStore[keysA.articles] = [
    { id: "a1", title: "A", url: "https://example.com/only-a", created_at: "2026-01-01" },
  ];
  localStore[keysB.articles] = [
    { id: "b1", title: "B", url: "https://example.com/synced", created_at: "2026-01-01" },
  ];

  // Unrelated local storage change must be ignored.
  setLevelSpy.mockClear();
  emitStorageChanged({ backend: { oldValue: "wallabag", newValue: "raindrop" } }, "local");
  await Bun.sleep(20);
  expect(setLevelSpy).not.toHaveBeenCalled();
  expect(tokenManager.getTokenMetadata("wallabag")?.accessToken).toBe("token-a");

  // Out-of-band sync change to Account B clears Account A's token, re-initializes repo, updates logger, and refreshes active tab UI.
  Object.assign(syncStore, wallabagB);
  emitStorageChanged(
    {
      apiConfig: { oldValue: wallabagA.apiConfig, newValue: wallabagB.apiConfig },
      logLevel: { oldValue: wallabagA.logLevel, newValue: wallabagB.logLevel },
    },
    "sync",
  );
  await Bun.sleep(30);

  expect(setLevelSpy).toHaveBeenCalledWith(LogLevel.DEBUG);
  expect(tokenManager.getTokenMetadata("wallabag")).toBeNull();
  expect(localStore[keysA.articles]).toBeUndefined();
  expect(
    await sendMessage({ type: "checkArticle", payload: { url: "https://example.com/synced" } }),
  ).toMatchObject({ id: "b1" });
  expect(tabUiUpdates).toContainEqual({ tabId: 11, title: "Article saved" });
  setLevelSpy.mockRestore();
});
