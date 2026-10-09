import { expect, test } from "bun:test";

// A token alarm that wakes Chromium's service worker, before any backend use:
// no password login, and the stored token stays for the adapter's own refresh.
type AlarmListener = (alarm: { name: string }) => Promise<void>;
const alarmListeners: AlarmListener[] = [];
const fetchCalls: string[] = [];
const event = { addListener: () => {} };
const settings = {
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
const expiring = {
  serviceName: "wallabag",
  accessToken: "old",
  refreshToken: "ref",
  tokenType: "Bearer",
  expiresAt: Date.now() + 60 * 1000,
  issuedAt: Date.now(),
  refreshCount: 0,
};
const local: Record<string, unknown> = { api_tokens: [["wallabag", expiring]] };
const pick = (store: Record<string, unknown>, keys: string | string[] | null) =>
  keys === null
    ? { ...store }
    : Object.fromEntries(
        (typeof keys === "string" ? [keys] : keys)
          .filter((k) => k in store)
          .map((k) => [k, store[k]]),
      );

Object.assign(globalThis, {
  browser: {
    runtime: {
      onMessage: event,
      onInstalled: event,
      onStartup: event,
      onMessageExternal: event,
      getURL: (path: string) => path,
    },
    storage: {
      sync: { get: async (keys: string | string[]) => pick(settings, keys), set: async () => {} },
      local: {
        get: async (keys: string | string[] | null) => pick(local, keys),
        set: async (values: Record<string, unknown>) => Object.assign(local, values),
        remove: async () => {},
      },
    },
    alarms: {
      create: async () => {},
      get: async () => ({ name: "token-refresh-check", periodInMinutes: 5 }),
      onAlarm: { addListener: (l: AlarmListener) => alarmListeners.push(l) },
    },
    contextMenus: { onClicked: event },
    notifications: { onClicked: event },
    permissions: { onRemoved: event, contains: async () => true },
    commands: { onCommand: event },
    pageAction: { onClicked: event },
    tabs: { onUpdated: event, onActivated: event },
  },
  fetch: (async (input: unknown) => {
    fetchCalls.push(String(input));
    return new Response(
      JSON.stringify({ access_token: "new", refresh_token: "ref2", expires_in: 3600 }),
      { status: 200 },
    );
  }) as typeof fetch,
});

test("the token alarm in a freshly woken background neither logs in nor drops tokens", async () => {
  await import("../src/background/background.ts");
  // Filter lists are fetched too; count only the backend.
  fetchCalls.length = 0;
  for (const listener of alarmListeners) {
    await listener({ name: "token-refresh-check" });
  }
  await Bun.sleep(10);
  expect(fetchCalls.filter((url) => url.startsWith("https://wallabag.example.com"))).toEqual([]);
  expect(local.api_tokens).toEqual([["wallabag", expiring]]);
});
