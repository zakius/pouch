import { type PageStateMessage, POUCH_ID } from "../utils/chromium";

// Like Firefox's page action: off until Pouch reports a page it can save.
void browser.action.disable();

browser.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    browser.runtime.sendMessage(POUCH_ID, { type: "togglePage", tabId: tab.id }).catch(() => {
      void browser.action.setTitle({ tabId: tab.id, title: "Pouch isn't installed" });
    });
  }
});

browser.runtime.onMessageExternal.addListener((message: PageStateMessage, sender) => {
  if (sender.id !== POUCH_ID || message?.type !== "pageState") {
    return;
  }
  const { tabId, saved } = message;
  const icon = `icons/${saved ? "saved" : "unsaved"}`;
  void browser.action.setIcon({ tabId, path: { 16: `${icon}-16.png`, 32: `${icon}-32.png` } });
  void browser.action.setTitle({ tabId, title: saved ? "Article saved" : "Save to Pouch" });
  void browser.action.enable(tabId);
});

// Pouch may have started first: ask it for the active tab's state.
browser.runtime.sendMessage(POUCH_ID, { type: "refreshUi" }).catch(() => {});
