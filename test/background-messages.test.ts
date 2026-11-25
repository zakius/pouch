import { test, expect } from "bun:test";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;
type MenuClickListener = (info: { menuItemId: string | number; linkUrl?: string }, tab?: MockTab) => unknown;
type TabUpdatedListener = (
  tabId: number,
  changeInfo: { status?: string; url?: string },
  tab: MockTab,
) => unknown;
type TabActivatedListener = (activeInfo: { tabId: number; windowId?: number }) => unknown;
type WindowFocusListener = (windowId: number) => unknown;
type PageActionClickListener = (tab: MockTab) => unknown;
type CommandListener = (command: string) => unknown;

interface MockTab {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
}

const listeners: Listener[] = [];
let menuClickListener: MenuClickListener | undefined;
let tabUpdatedListener: TabUpdatedListener | undefined;
let tabUpdatedFilter: unknown;
let tabActivatedListener: TabActivatedListener | undefined;
let windowFocusListener: WindowFocusListener | undefined;
let pageActionClickListener: PageActionClickListener | undefined;
let commandListener: CommandListener | undefined;

const syncStore: Record<string, unknown> = {
  backend: "wallabag",
  logLevel: 3,
  normalizeOnSave: false,
  normalizeOnCompare: false,
  apiConfig: {
    url: "https://wallabag.example.com",
    clientId: "cid",
    clientSecret: "secret",
    username: "user",
    password: "pass",
  },
};
const localStore: Record<string, unknown> = {};
const fetchCalls: string[] = [];
const menuUpdates: { id: string; props: Record<string, unknown> }[] = [];
const pageActionTitles: { tabId: number; title: string }[] = [];
const pageActionIcons: { tabId: number; path: string }[] = [];
let rejectBookmarkRead = false;
let bookmarkCreateCount = 0;
let bookmarkRemoveCount = 0;
let bookmarkSeq = 1;
let onBookmarkCreate:
  | ((details: { title?: string; url?: string }) => Promise<{ id: string; title: string; url: string }>)
  | undefined;
let onBookmarkRemove: ((id: string) => Promise<void>) | undefined;
let mockTabs = new Map<number, MockTab>();
let mockWindows = new Map<number, { id: number; focused: boolean }>();
let mockQueryTabs: ((query: Record<string, unknown>) => MockTab[]) | undefined;

Object.assign(globalThis, {
  browser: {
    runtime: {
      getURL: (path: string) => path,
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      contextMenus: undefined,
    },
    storage: {
      sync: {
        get: async (keys: string | string[]) => {
          const names = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const key of names) if (key in syncStore) out[key] = syncStore[key];
          return out;
        },
        set: async (v: Record<string, unknown>) => Object.assign(syncStore, v),
      },
      local: {
        get: async (keys: string | string[] | null) => {
          if (keys === null) return { ...localStore };
          const names = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const key of names) if (key in localStore) out[key] = localStore[key];
          return out;
        },
        set: async (v: Record<string, unknown>) => Object.assign(localStore, v),
        remove: async (keys: string | string[]) => {
          for (const k of typeof keys === "string" ? [keys] : keys) delete localStore[k];
        },
      },
    },
    bookmarks: {
      getTree: async () => [{ id: "1", title: "Pouch", children: [] }],
      getChildren: async () => {
        if (rejectBookmarkRead) throw new Error("permission denied https://private.example/token");
        return [];
      },
      create: async (details: { title?: string; url?: string }) => {
        bookmarkCreateCount++;
        if (onBookmarkCreate) return onBookmarkCreate(details);
        return {
          id: `bm-${bookmarkSeq++}`,
          title: details.title ?? "",
          url: details.url ?? "",
        };
      },
      remove: async (id: string) => {
        bookmarkRemoveCount++;
        if (onBookmarkRemove) return onBookmarkRemove(id);
      },
    },
    alarms: {
      clear: async () => {},
      create: async () => {},
      get: async () => undefined,
      onAlarm: { addListener: () => {} },
    },
    contextMenus: {
      create: (_details: unknown, callback?: () => void) => {
        callback?.();
        return "menu";
      },
      update: async (id: string, props: Record<string, unknown>) => {
        menuUpdates.push({ id, props });
      },
      onClicked: {
        addListener: (l: MenuClickListener) => {
          menuClickListener = l;
        },
      },
      removeAll: async () => {},
    },
    idle: { queryState: async () => "active" },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    pageAction: {
      onClicked: {
        addListener: (l: PageActionClickListener) => {
          pageActionClickListener = l;
        },
      },
      setIcon: async (details: { tabId: number; path: string }) => {
        pageActionIcons.push(details);
      },
      setTitle: async (details: { tabId: number; title: string }) => {
        pageActionTitles.push(details);
      },
      show: async () => {},
      hide: async () => {},
    },
    commands: {
      onCommand: {
        addListener: (l: CommandListener) => {
          commandListener = l;
        },
      },
    },
    notifications: { create: async () => {}, onClicked: { addListener: () => {} } },
    permissions: {
      onRemoved: { addListener: () => {} },
      contains: async () => true,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      get: async (windowId: number) => {
        const win = mockWindows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}`);
        return win;
      },
      onFocusChanged: {
        addListener: (l: WindowFocusListener) => {
          windowFocusListener = l;
        },
      },
    },
    tabs: {
      query: async (query: Record<string, unknown>) => {
        if (mockQueryTabs) return mockQueryTabs(query);
        const all = [...mockTabs.values()];
        return all.filter((tab) => {
          if (query.active !== undefined && tab.active !== query.active) return false;
          if (query.windowId !== undefined && tab.windowId !== query.windowId) return false;
          return true;
        });
      },
      sendMessage: async () => {},
      create: async () => ({}),
      get: async (tabId: number) => mockTabs.get(tabId) ?? {},
      onUpdated: {
        addListener: (l: TabUpdatedListener, filter?: unknown) => {
          tabUpdatedListener = l;
          tabUpdatedFilter = filter;
        },
      },
      onActivated: {
        addListener: (l: TabActivatedListener) => {
          tabActivatedListener = l;
        },
      },
    },
  },
  fetch: (async (input: unknown) => {
    fetchCalls.push(String(input));
    return new Response(
      JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
      {
        status: 200,
      },
    );
  }) as typeof fetch,
});

function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    for (const l of listeners) {
      const handled = l(message, {}, (r) => resolve(r));
      if (handled) return;
    }
    resolve(undefined);
  });
}

test("saveSettings and testConnection respond", async () => {
  await import("../src/background/background.ts");
  await Bun.sleep(50);
  expect(listeners.length).toBeGreaterThan(0);

  const wallabagSettings = {
    backend: "wallabag",
    logLevel: 3,
    normalizeOnSave: false,
    normalizeOnCompare: false,
    apiConfig: {
      url: "https://wallabag.example.com",
      clientId: "cid",
      clientSecret: "secret",
      username: "user",
      password: "pass",
    },
  };

  const saveP = Promise.race([
    sendMessage({ type: "saveSettings", payload: { settings: wallabagSettings } }),
    Bun.sleep(3000).then(() => "TIMEOUT"),
  ]);
  const saveResult = await saveP;
  console.log("saveSettings response:", JSON.stringify(saveResult));

  const testP = Promise.race([
    sendMessage({ type: "testConnection", payload: { settings: wallabagSettings } }),
    Bun.sleep(5000).then(() => "TIMEOUT"),
  ]);
  const testResult = await testP;
  console.log("testConnection response:", JSON.stringify(testResult), "fetches:", fetchCalls);
  expect(saveResult).not.toBe("TIMEOUT");
  expect(testResult).not.toBe("TIMEOUT");
});


test("runtime bookmark connection failures expose safe details and malformed requests are rejected", async () => {
  await import("../src/background/background.ts");
  const settings = { backend: "bookmarks", apiConfig: {}, logLevel: 3, normalizeOnSave: false, normalizeOnCompare: false };
  rejectBookmarkRead = true;
  const response = await sendMessage({ type: "testConnection", payload: { settings } });
  expect(response).toMatchObject({ success: false, code: "BrowserFailure", details: { operation: "test bookmarks connection" } });
  expect(JSON.stringify(response)).not.toContain("private.example");
  expect(response).toHaveProperty("error");
  for (const message of [null, { type: "saveArticle" }, { type: "saveArticle", payload: { url: 42 } }]) {
    expect(await sendMessage(message)).toMatchObject({ code: "INVALID_REQUEST", details: {} });
  }
  rejectBookmarkRead = false;
  expect(await sendMessage({ type: "testConnection", payload: { settings } })).toEqual({ success: true });
});

test("non-HTTP(S) URLs are rejected by saveArticle, save-link, and save-page", async () => {
  await import("../src/background/background.ts");
  const bookmarksSettings = {
    backend: "bookmarks",
    apiConfig: {},
    logLevel: 3,
    normalizeOnSave: false,
    normalizeOnCompare: false,
  };
  expect(await sendMessage({ type: "saveSettings", payload: { settings: bookmarksSettings } })).toEqual({
    success: true,
  });
  await Bun.sleep(20);

  bookmarkCreateCount = 0;
  const nonHttpUrls = [
    "chrome://settings",
    "about:newtab",
    "javascript:alert(1)",
    "mailto:user@example.com",
    "data:text/html,<h1>hi</h1>",
    "file:///etc/passwd",
  ];

  for (const url of nonHttpUrls) {
    const response = await sendMessage({ type: "saveArticle", payload: { url, title: "Bad" } });
    expect(response).toMatchObject({ code: "INVALID_REQUEST", details: {} });

    await menuClickListener?.({ menuItemId: "save-link", linkUrl: url }, { id: 1, url: "https://ok.example/", active: true });
    await menuClickListener?.({ menuItemId: "save-page" }, { id: 1, url, title: "Bad", active: true });
  }

  expect(bookmarkCreateCount).toBe(0);
});

test("background tab updates do not overwrite active save-page menu, non-HTTP disables it, SPA url and window focus update UI", async () => {
  await import("../src/background/background.ts");
  expect(tabUpdatedFilter).toEqual({ properties: ["status", "url"] });

  const bookmarksSettings = {
    backend: "bookmarks",
    apiConfig: {},
    logLevel: 3,
    normalizeOnSave: false,
    normalizeOnCompare: false,
  };
  await sendMessage({ type: "saveSettings", payload: { settings: bookmarksSettings } });
  await Bun.sleep(20);

  const savedUrl = "https://saved.example/article";
  const saveRes = await sendMessage({
    type: "saveArticle",
    payload: { url: savedUrl, title: "Saved Article" },
  });
  expect(saveRes).toMatchObject({ url: savedUrl });

  mockWindows = new Map([
    [1, { id: 1, focused: true }],
    [2, { id: 2, focused: false }],
  ]);
  mockTabs = new Map([
    [1, { id: 1, url: savedUrl, active: true, windowId: 1 }],
    [2, { id: 2, url: "https://bg.example/other", active: false, windowId: 1 }],
    [3, { id: 3, url: "https://other-win.example/page", active: true, windowId: 2 }],
    [4, { id: 4, url: "about:newtab", active: true, windowId: 1 }],
  ]);
  menuUpdates.length = 0;
  pageActionTitles.length = 0;

  // Activate saved tab -> save-page menu shows Remove page.
  await tabActivatedListener?.({ tabId: 1, windowId: 1 });
  expect(menuUpdates.at(-1)).toEqual({
    id: "save-page",
    props: { title: "Remove page", enabled: true },
  });

  // Background tab finishes loading -> per-tab pageAction updates, global save-page menu does NOT.
  const menuCountBeforeBg = menuUpdates.length;
  tabUpdatedListener?.(2, { status: "complete" }, mockTabs.get(2)!);
  await Bun.sleep(30);
  expect(pageActionTitles.some((t) => t.tabId === 2 && t.title === "Save to Pouch")).toBe(true);
  expect(menuUpdates.length).toBe(menuCountBeforeBg);

  // Active tab in an unfocused window finishes loading -> global save-page menu does NOT change.
  tabUpdatedListener?.(3, { status: "complete" }, mockTabs.get(3)!);
  await Bun.sleep(30);
  expect(pageActionTitles.some((t) => t.tabId === 3 && t.title === "Save to Pouch")).toBe(true);
  expect(menuUpdates.length).toBe(menuCountBeforeBg);

  // SPA navigation (changeInfo.url without status: "complete") updates active tab UI & context menu.
  const spaUrl = "https://saved.example/spa-unsaved";
  mockTabs.set(1, { id: 1, url: spaUrl, active: true, windowId: 1 });
  tabUpdatedListener?.(1, { url: spaUrl }, mockTabs.get(1)!);
  await Bun.sleep(30);
  expect(menuUpdates.at(-1)).toEqual({
    id: "save-page",
    props: { title: "Save page", enabled: true },
  });

  // Switching to a non-HTTP active tab disables save-page and resets its title.
  await tabActivatedListener?.({ tabId: 4, windowId: 1 });
  expect(menuUpdates.at(-1)).toEqual({
    id: "save-page",
    props: { title: "Save page", enabled: false },
  });

  // Window focus change to WINDOW_ID_NONE (-1) is ignored.
  const menuCountBeforeNone = menuUpdates.length;
  windowFocusListener?.(-1);
  await Bun.sleep(30);
  expect(menuUpdates.length).toBe(menuCountBeforeNone);

  // Focusing window 2 refreshes window 2's active tab UI.
  mockWindows.set(1, { id: 1, focused: false });
  mockWindows.set(2, { id: 2, focused: true });
  mockTabs.set(3, { id: 3, url: savedUrl, active: true, windowId: 2 });
  windowFocusListener?.(2);
  await Bun.sleep(30);
  expect(menuUpdates.at(-1)).toEqual({
    id: "save-page",
    props: { title: "Remove page", enabled: true },
  });

  mockTabs = new Map();
  mockWindows = new Map();
});

test("concurrent togglePageSave calls on the same tab/URL coalesce into a single save or delete", async () => {
  await import("../src/background/background.ts");
  const bookmarksSettings = {
    backend: "bookmarks",
    apiConfig: {},
    logLevel: 3,
    normalizeOnSave: false,
    normalizeOnCompare: false,
  };
  await sendMessage({ type: "saveSettings", payload: { settings: bookmarksSettings } });
  await Bun.sleep(20);

  const toggleUrl = "https://toggle-lock.example/page";
  const tab: MockTab = { id: 20, url: toggleUrl, title: "Lock Test", active: true, windowId: 1 };
  mockWindows = new Map([[1, { id: 1, focused: true }]]);
  mockTabs = new Map([[20, tab]]);

  // Concurrent saves via pageAction + context menu save-page
  let releaseCreate!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    onBookmarkCreate = async (details) => {
      resolve();
      await new Promise<void>((r) => {
        releaseCreate = r;
      });
      return { id: "bm-lock-1", title: details.title ?? "", url: details.url ?? "" };
    };
  });
  bookmarkCreateCount = 0;

  pageActionClickListener?.(tab);
  await createStarted;
  const secondSave = menuClickListener?.({ menuItemId: "save-page" }, tab);
  await secondSave;
  releaseCreate();
  await Bun.sleep(30);
  onBookmarkCreate = undefined;
  expect(bookmarkCreateCount).toBe(1);

  // Concurrent deletes via keyboard command + context menu save-page
  let releaseRemove!: () => void;
  const removeStarted = new Promise<void>((resolve) => {
    onBookmarkRemove = async () => {
      resolve();
      await new Promise<void>((r) => {
        releaseRemove = r;
      });
    };
  });
  bookmarkRemoveCount = 0;

  const firstDelete = commandListener?.("toggle-save-page");
  await removeStarted;
  const secondDelete = menuClickListener?.({ menuItemId: "save-page" }, tab);
  await secondDelete;
  releaseRemove();
  await firstDelete;
  await Bun.sleep(30);
  onBookmarkRemove = undefined;
  expect(bookmarkRemoveCount).toBe(1);

  // After completion, lock is released and a subsequent toggle saves again.
  await menuClickListener?.({ menuItemId: "save-page" }, tab);
  expect(bookmarkCreateCount).toBe(2);

  mockTabs = new Map();
  mockWindows = new Map();
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
});

test("Chromium onMessageExternal uses sendResponse + return true for QUICK_ACTIONS_ID and returns undefined for foreign senders", () => {
  const script = `
    import assert from "node:assert/strict";

    let externalListener;
    let savedBookmarks = [];
    const sentExternal = [];
    const syncStore = {
      backend: "bookmarks",
      logLevel: 3,
      normalizeOnSave: false,
      normalizeOnCompare: false,
      apiConfig: {},
    };
    const localStore = {};
    const event = { addListener: () => {} };

    globalThis.chrome = {
      runtime: {
        getURL: (p) => p,
        onMessage: event,
        onInstalled: event,
        onStartup: event,
        onMessageExternal: {
          addListener: (l) => {
            externalListener = l;
          },
        },
        sendMessage: async (target, msg) => {
          sentExternal.push({ target, msg });
        },
      },
      storage: {
        sync: {
          get: async (keys) => {
            const names = typeof keys === "string" ? [keys] : keys;
            const out = {};
            for (const k of names) if (k in syncStore) out[k] = syncStore[k];
            return out;
          },
          set: async (v) => Object.assign(syncStore, v),
        },
        local: {
          get: async (keys) => {
            if (keys === null) return { ...localStore };
            const names = typeof keys === "string" ? [keys] : keys;
            const out = {};
            for (const k of names) if (k in localStore) out[k] = localStore[k];
            return out;
          },
          set: async (v) => Object.assign(localStore, v),
          remove: async (keys) => {
            for (const k of typeof keys === "string" ? [keys] : keys) delete localStore[k];
          },
        },
      },
      bookmarks: {
        getTree: async () => [{ id: "1", title: "Pouch", children: [] }],
        getChildren: async () => savedBookmarks,
        create: async (details) => {
          const item = { id: "bm-1", title: details.title ?? "", url: details.url ?? "" };
          savedBookmarks.push(item);
          return item;
        },
        remove: async () => {},
      },
      alarms: { clear: async () => true, create: async () => {}, get: async () => undefined, onAlarm: event },
      contextMenus: { create: (_d, cb) => cb?.(), update: async () => {}, onClicked: event, removeAll: async () => {} },
      idle: { queryState: async () => "active" },
      notifications: { create: async () => {}, onClicked: event },
      permissions: { onRemoved: event, contains: async () => true },
      windows: { WINDOW_ID_NONE: -1, get: async () => ({ id: 1, focused: true }), onFocusChanged: event },
      commands: { onCommand: event },
      tabs: {
        query: async () => [{ id: 5, url: "https://example.com/ext", title: "Ext", active: true, windowId: 1 }],
        get: async () => ({ id: 5, url: "https://example.com/ext", title: "Ext", active: true, windowId: 1 }),
        onUpdated: event,
        onActivated: event,
      },
    };

    const { QUICK_ACTIONS_ID } = await import("./src/utils/chromium.ts");
    await import("./src/background/background.ts");
    assert.equal(typeof externalListener, "function");

    let foreignCalled = false;
    const foreignReturn = externalListener(
      { type: "getStorageDiagnostic" },
      { id: "untrusted-extension" },
      () => {
        foreignCalled = true;
      },
    );
    assert.equal(foreignReturn, undefined);
    assert.equal(foreignCalled, false);

    const callTrusted = (msg) =>
      new Promise((resolve) => {
        const ret = externalListener(msg, { id: QUICK_ACTIONS_ID }, (resp) => resolve({ ret, resp }));
        assert.equal(ret, true, "trusted onMessageExternal must return true, not a Promise");
      });

    const diag = await callTrusted({ type: "getStorageDiagnostic" });
    assert.equal(diag.ret, true);
    assert.equal(diag.resp, null);

    const refresh = await callTrusted({ type: "refreshUi" });
    assert.equal(refresh.ret, true);
    assert.equal(refresh.resp, undefined);
    assert.ok(sentExternal.some((e) => e.target === QUICK_ACTIONS_ID && e.msg?.type === "pageState"));

    const toggle = await callTrusted({ type: "togglePage", tabId: 5 });
    assert.equal(toggle.ret, true);
    assert.equal(toggle.resp, undefined);
    assert.equal(savedBookmarks.length, 1);
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, POUCH_TARGET: "chromium" },
    timeout: 10_000,
  });
  expect({
    status: result.exitCode,
    stderr: result.stderr.toString(),
  }).toEqual({ status: 0, stderr: "" });
});
