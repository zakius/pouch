import { type QuickActionStateMessage, POUCH_ID } from "../utils/chromium";

let fatalError: string | undefined;
let generation = 0;
const pageStates = new Map<number, { saved: boolean; title?: string }>();

// Like Firefox's page action: off until Pouch reports a page it can save.
const initiallyDisabled = browser.action.disable();

/**
 * Applies `tabId`'s state, or the fatal state and then every state reported since. Chromium
 * clears a tab's action on navigation, so reapplying other tabs' states would revive stale ones;
 * only a fatal stop, which clears them, needs its late per-tab calls undone.
 */
async function render(tabId?: number): Promise<void> {
  await initiallyDisabled;
  for (;;) {
    const currentGeneration = generation;
    const error = fatalError;
    const tabState = tabId === undefined ? undefined : pageStates.get(tabId);
    const states =
      tabId === undefined ? new Map(pageStates) : new Map(tabState ? [[tabId, tabState]] : []);
    const updates: (() => Promise<void>)[] = [
      () => browser.action.disable(),
      () => browser.action.setBadgeText({ text: error ? "!" : "" }),
      () => browser.action.setTitle({ title: error ?? "Save to Pouch" }),
    ];
    if (error) {
      for (const tab of await browser.tabs.query({})) {
        if (tab.id === undefined) continue;
        const tabId = tab.id;
        updates.push(
          () => browser.action.disable(tabId),
          () => browser.action.setTitle({ tabId, title: error }),
        );
      }
    } else {
      for (const [tabId, { saved, title }] of states) {
        const icon = `icons/${saved ? "saved" : "unsaved"}`;
        updates.push(
          () =>
            browser.action.setIcon({ tabId, path: { 16: `${icon}-16.png`, 32: `${icon}-32.png` } }),
          () =>
            browser.action.setTitle({
              tabId,
              title: title ?? (saved ? "Article saved" : "Save to Pouch"),
            }),
          () => browser.action.enable(tabId),
        );
      }
    }
    for (const update of updates) {
      if (generation !== currentGeneration) break;
      // A tab can close before its update lands; that must not skip the remaining updates.
      await update().catch(() => {});
    }
    // Browser calls already dispatched can finish after a state change in either direction.
    if (generation === currentGeneration) return;
  }
}

browser.action.onClicked.addListener((tab) => {
  if (fatalError) return;
  if (tab.id !== undefined) {
    const tabId = tab.id;
    const currentGeneration = generation;
    browser.runtime.sendMessage(POUCH_ID, { type: "togglePage", tabId }).catch(() => {
      if (fatalError || generation !== currentGeneration) return;
      pageStates.set(tabId, { saved: false, title: "Pouch isn't installed" });
      generation++;
      void render(tabId);
    });
  }
});

async function handleExternalMessage(message: QuickActionStateMessage): Promise<void> {
  if (message?.type === "fatalStorage") {
    fatalError = message.error;
    pageStates.clear();
    generation++;
    await render();
    return;
  }
  if (message?.type !== "pageState") return;
  const currentGeneration = generation;
  if (fatalError) {
    // A new Pouch worker health-checks storage before returning a null diagnostic.
    const diagnostic: unknown = await browser.runtime
      .sendMessage(POUCH_ID, { type: "getStorageDiagnostic" })
      .catch(() => undefined);
    if (diagnostic !== null || generation !== currentGeneration) return;
    fatalError = undefined;
  }
  pageStates.set(message.tabId, { saved: message.saved });
  generation++;
  await render(message.tabId);
}

browser.runtime.onMessageExternal.addListener(
  (
    message: QuickActionStateMessage,
    sender: browser.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (sender.id !== POUCH_ID) return undefined;
    void handleExternalMessage(message).then(
      () => sendResponse(undefined),
      () => sendResponse(undefined),
    );
    return true;
  },
);
browser.tabs.onRemoved.addListener((tabId) => {
  pageStates.delete(tabId);
  generation++;
});

function requestRefreshUi(): void {
  // Pouch may have started first: ask it for the active tab's state.
  void browser.runtime.sendMessage(POUCH_ID, { type: "refreshUi" }).catch(() => {});
}

browser.runtime.onInstalled?.addListener(requestRefreshUi);
browser.runtime.onStartup?.addListener(requestRefreshUi);
