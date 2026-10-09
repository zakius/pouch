import { expect, test } from "bun:test";
import { getAccountStorageKeys } from "../src/background/articles-repository";
import { DEFAULT_SETTINGS } from "../src/utils/settings";

// A settings save while an article save is still waiting for its backend.
type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;
const listeners: Listener[] = [];
const event = { addListener: () => {} };
const bookmarksSettings = { ...DEFAULT_SETTINGS, backend: "bookmarks" as const, apiConfig: {} };
const syncStore: Record<string, unknown> = { ...bookmarksSettings };
const localStore: Record<string, unknown> = {};
const saved: { id: string; title: string; url: string; dateAdded: number }[] = [];

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
      sync: {
        get: async (keys: string | string[]) => pick(syncStore, keys),
        set: async (values: Record<string, unknown>) => {
          if (rejectSyncSet) throw rejectSyncSet;
          Object.assign(syncStore, values);
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
    pageAction: { onClicked: event },
    commands: { onCommand: event },
    notifications: { create: async () => "", onClicked: event },
    permissions: { onRemoved: event, contains: async () => true },
    tabs: { query: async () => [], get: async () => ({}), onUpdated: event, onActivated: event },
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
