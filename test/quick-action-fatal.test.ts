import { afterAll, expect, test } from "bun:test";
import { POUCH_ID } from "../src/utils/chromium";

const original = Object.getOwnPropertyDescriptor(globalThis, "browser");
const disabled: (number | undefined)[] = [];
const enabled: number[] = [];
const badges: string[] = [];
const titles: string[] = [];
let diagnostic: unknown = { code: "FATAL_LOCAL_STORAGE" };
let holdBadge = false;
let releaseBadge!: () => void;
let badgeStarted!: () => void;
let listener!: (message: unknown, sender: { id: string }) => Promise<void>;
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
      setIcon: async () => {},
      onClicked: { addListener: () => {} },
    },
    tabs: { query: async () => [{ id: 1 }, { id: 2 }] },
    runtime: {
      sendMessage: async () => diagnostic,
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

test("Chromium Quick Actions shows fatal diagnostics and disables each tab until reinitialization", async () => {
  await listener({ type: "pageState", tabId: 1, saved: false }, { id: POUCH_ID });
  await listener(
    { type: "fatalStorage", error: "Pouch stopped. Remote save succeeded." },
    { id: "untrusted" },
  );
  expect(disabled).toEqual([undefined]);
  holdBadge = true;
  const ready = new Promise<void>((resolve) => {
    badgeStarted = resolve;
  });
  const pending = listener({ type: "pageState", tabId: 1, saved: false }, { id: POUCH_ID });
  await ready;
  await listener(
    { type: "fatalStorage", error: "Pouch stopped. Remote save succeeded." },
    { id: POUCH_ID },
  );
  holdBadge = false;
  releaseBadge();
  await pending;
  expect(disabled).toEqual([undefined, undefined, 1, 2, undefined, 1, 2]);
  expect(badges.at(-1)).toBe("!");
  expect(titles.at(-1)).toContain("Remote save succeeded");
  await listener({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
  expect(badges.at(-1)).toBe("!");
  expect(enabled).toEqual([1]);
  diagnostic = null;
  await listener({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
  expect(badges.at(-1)).toBe("");
  expect(enabled).toEqual([1, 1]);
});
