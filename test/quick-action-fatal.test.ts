import { afterAll, expect, test } from "bun:test";
import { POUCH_ID } from "../src/utils/chromium";
import quickActionsManifest from "../src/quick-actions/manifest.json" with { type: "json" };

const original = Object.getOwnPropertyDescriptor(globalThis, "browser");
const disabled: (number | undefined)[] = [];
const enabled: number[] = [];
const badges: string[] = [];
const titles: string[] = [];
const sentMessages: { target: string; message: unknown }[] = [];
const closedTab = 999;
let diagnostic: unknown = { code: "FATAL_LOCAL_STORAGE" };
let holdBadge = false;
let releaseBadge!: () => void;
let badgeStarted!: () => void;
let listener!: (
  message: unknown,
  sender: { id: string },
  sendResponse: (response?: unknown) => void,
) => unknown;
let onInstalledListener: (() => void) | undefined;
let onStartupListener: (() => void) | undefined;
let onRemovedListener: ((tabId: number) => void) | undefined;
Object.assign(globalThis, {
  browser: {
    action: {
      disable: async (id?: number) => {
        disabled.push(id);
      },
      enable: async (id: number) => {
        enabled.push(id);
      },
      setBadgeText: async ({ text }: { text: string }) => {
        if (holdBadge && text === "") {
          badgeStarted();
          await new Promise<void>((resolve) => {
            releaseBadge = resolve;
          });
        }
        badges.push(text);
      },
      setTitle: async ({ title }: { title: string }) => {
        titles.push(title);
      },
      setIcon: async ({ tabId }: { tabId: number }) => {
        if (tabId === closedTab) throw new Error(`No tab with id: ${tabId}.`);
      },
      onClicked: { addListener: () => {} },
    },
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }],
      onRemoved: {
        addListener: (cb: (tabId: number) => void) => {
          onRemovedListener = cb;
        },
      },
    },
    runtime: {
      sendMessage: async (target: string, message: unknown) => {
        sentMessages.push({ target, message });
        return diagnostic;
      },
      onInstalled: {
        addListener: (cb: () => void) => {
          onInstalledListener = cb;
        },
      },
      onStartup: {
        addListener: (cb: () => void) => {
          onStartupListener = cb;
        },
      },
      onMessageExternal: {
        addListener: (callback: typeof listener) => {
          listener = callback;
        },
      },
    },
  },
});
await import("../src/quick-actions/background");
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "browser", original);
  else Reflect.deleteProperty(globalThis, "browser");
});

function sendExternal(message: unknown, sender: { id: string }): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const sendResponse = (response?: unknown) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const result = listener(message, sender, sendResponse);
    if (result !== true && !settled) {
      settled = true;
      resolve(result);
    }
  });
}

test("Quick Actions manifest defaults disabled and avoids top-level refreshUi wakes", () => {
  expect(quickActionsManifest.action.default_state).toBe("disabled");
  // Loading the service worker or firing tabs.onRemoved must not ping-pong Pouch with refreshUi.
  expect(sentMessages).toEqual([]);
  onRemovedListener?.(42);
  expect(sentMessages).toEqual([]);

  onInstalledListener?.();
  expect(sentMessages).toEqual([{ target: POUCH_ID, message: { type: "refreshUi" } }]);

  sentMessages.length = 0;
  onStartupListener?.();
  expect(sentMessages).toEqual([{ target: POUCH_ID, message: { type: "refreshUi" } }]);
  sentMessages.length = 0;
});

test("Quick Actions onMessageExternal uses sendResponse + return true for POUCH_ID and returns undefined for foreign senders", async () => {
  let foreignResponded = false;
  const foreignResult = listener(
    { type: "fatalStorage", error: "spoofed" },
    { id: "untrusted" },
    () => {
      foreignResponded = true;
    },
  );
  expect(foreignResult).toBeUndefined();
  expect(foreignResponded).toBe(false);

  let pouchResponded = false;
  let resolveResponse!: () => void;
  const responsePromise = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  const pouchResult = listener(
    { type: "pageState", tabId: 10, saved: false },
    { id: POUCH_ID },
    () => {
      pouchResponded = true;
      resolveResponse();
    },
  );
  expect(pouchResult).toBe(true);
  await responsePromise;
  expect(pouchResponded).toBe(true);
  enabled.length = 0;
  disabled.length = 0;
  badges.length = 0;
  titles.length = 0;
});

test("Chromium Quick Actions shows fatal diagnostics and disables each tab until reinitialization", async () => {
  await sendExternal({ type: "pageState", tabId: 1, saved: false }, { id: POUCH_ID });
  await sendExternal(
    { type: "fatalStorage", error: "Pouch stopped. Remote save succeeded." },
    { id: "untrusted" },
  );
  expect(disabled.every((id) => id === undefined)).toBe(true);
  holdBadge = true;
  const ready = new Promise<void>((resolve) => {
    badgeStarted = resolve;
  });
  const pending = sendExternal({ type: "pageState", tabId: 1, saved: false }, { id: POUCH_ID });
  await ready;
  await sendExternal(
    { type: "fatalStorage", error: "Pouch stopped. Remote save succeeded." },
    { id: POUCH_ID },
  );
  holdBadge = false;
  releaseBadge();
  await pending;
  expect(disabled).toContain(1);
  expect(disabled).toContain(2);
  expect(badges.at(-1)).toBe("!");
  expect(titles.at(-1)).toContain("Remote save succeeded");
  await sendExternal({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
  expect(badges.at(-1)).toBe("!");
  expect(enabled).toEqual([1]);
  diagnostic = undefined;
  await sendExternal({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
  expect(badges.at(-1)).toBe("!");
  expect(enabled).toEqual([1]);
  diagnostic = null;
  await sendExternal({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
  expect(badges.at(-1)).toBe("");
  expect(enabled).toEqual([1, 1]);
});

test("Quick Actions updates only the reported tab, even after a state for a closed tab", async () => {
  enabled.length = 0;
  await sendExternal({ type: "pageState", tabId: closedTab, saved: true }, { id: POUCH_ID });
  await sendExternal({ type: "pageState", tabId: 3, saved: true }, { id: POUCH_ID });
  expect(enabled).toEqual([closedTab, 3]);
});
