import { type QuickActionStateMessage, POUCH_ID } from "../utils/chromium";

let fatalError: string | undefined;
let generation = 0;
const pageStates = new Map<number, { saved: boolean; title?: string }>();

// Like Firefox's page action: off until Pouch reports a page it can save.
const initiallyDisabled = browser.action.disable();

async function render(): Promise<void> {
  await initiallyDisabled;
  for (;;) {
    const currentGeneration = generation;
    const error = fatalError;
    const states = new Map(pageStates);
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
      await update();
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
      void render();
    });
  }
});

browser.runtime.onMessageExternal.addListener(async (message: QuickActionStateMessage, sender) => {
  if (sender.id !== POUCH_ID) return;
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
    const diagnostic = await browser.runtime
      .sendMessage(POUCH_ID, { type: "getStorageDiagnostic" })
      .catch(() => undefined);
    if (diagnostic !== null || generation !== currentGeneration) return;
    fatalError = undefined;
  }
  pageStates.set(message.tabId, { saved: message.saved });
  generation++;
  await render();
});
browser.tabs.onRemoved.addListener((tabId) => {
  pageStates.delete(tabId);
  generation++;
});

// Pouch may have started first: ask it for the active tab's state.
browser.runtime.sendMessage(POUCH_ID, { type: "refreshUi" }).catch(() => {});
