import { test, expect, mock } from "bun:test";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;
const listeners: Listener[] = [];
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

Object.assign(globalThis, {
  browser: {
    runtime: {
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
      getChildren: async () => [],
      create: async () => ({ id: "x", title: "t", url: "u" }),
      remove: async () => {},
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
      onClicked: { addListener: () => {} },
      removeAll: async () => {},
    },
    idle: { queryState: async () => "active" },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    pageAction: {
      onClicked: { addListener: () => {} },
      show: async () => {},
      hide: async () => {},
    },
    commands: { onCommand: { addListener: () => {} } },
    notifications: { create: async () => {}, onClicked: { addListener: () => {} } },
    permissions: {
      onRemoved: { addListener: () => {} },
      contains: async () => true,
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => {},
      create: async () => ({}),
      get: async () => ({}),
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
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
