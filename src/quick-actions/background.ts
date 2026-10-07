import { type QuickActionStateMessage, POUCH_ID } from "../utils/chromium";

let fatalError: string | undefined;
let generation = 0;

// Like Firefox's page action: off until Pouch reports a page it can save.
void browser.action.disable();

async function showFatal(): Promise<void> {
  if (!fatalError) return;
  await browser.action.disable();
  await browser.action.setBadgeText({ text: "!" });
  await browser.action.setTitle({ title: fatalError });
  for (const tab of await browser.tabs.query({})) {
    if (tab.id === undefined) continue;
    await browser.action.disable(tab.id);
    await browser.action.setTitle({ tabId: tab.id, title: fatalError });
  }
}

browser.action.onClicked.addListener((tab) => {
  if (fatalError) return;
  if (tab.id !== undefined) {
    browser.runtime.sendMessage(POUCH_ID, { type: "togglePage", tabId: tab.id }).catch(() => {
      if (fatalError) return;
      void browser.action.setTitle({ tabId: tab.id, title: "Pouch isn't installed" });
    });
  }
});

browser.runtime.onMessageExternal.addListener(async (message: QuickActionStateMessage, sender) => {
  if (sender.id !== POUCH_ID) return;
  if (message?.type === "fatalStorage") {
    fatalError = message.error;
    generation++;
    await showFatal();
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
  const { tabId, saved } = message;
  const icon = `icons/${saved ? "saved" : "unsaved"}`;
  for (const update of [
    () => browser.action.setBadgeText({ text: "" }),
    () => browser.action.setIcon({ tabId, path: { 16: `${icon}-16.png`, 32: `${icon}-32.png` } }),
    () => browser.action.setTitle({ tabId, title: saved ? "Article saved" : "Save to Pouch" }),
    () => browser.action.enable(tabId),
  ]) {
    await update();
    if (generation !== currentGeneration) {
      await showFatal();
      return;
    }
  }
});

// Pouch may have started first: ask it for the active tab's state.
browser.runtime.sendMessage(POUCH_ID, { type: "refreshUi" }).catch(() => {});
