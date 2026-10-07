import { performance } from "node:perf_hooks";
type Listener = (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean;
const listeners: Listener[] = [];
const syncStore: Record<string, unknown> = {
  backend: "bookmarks",
  logLevel: 0,
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
      onMessageExternal: { addListener: () => {} },
      sendMessage: async () => {},
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

const started = performance.now();
await import(process.argv[2]);
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Startup timed out")), 5000);
  listeners[0]({ type: "getArticles", payload: {} }, {}, (response) => {
    clearTimeout(timeout);
    if (response && typeof response === "object" && "error" in response) reject(response);
    else resolve();
  });
});
console.log(JSON.stringify({ startupMs: performance.now() - started }));
process.exit(0);
