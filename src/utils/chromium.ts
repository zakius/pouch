// The Chromium build is two extensions: Pouch itself and Pouch Quick Actions,
// whose page action saves the current page. Chromium allows one action per
// extension, so they talk over runtime messages. The keys in their manifests
// fix their IDs.
import { extensionId } from "./extension-id" with { type: "macro" };

export const IS_CHROMIUM = process.env.POUCH_TARGET === "chromium";
export const POUCH_ID = extensionId("chromium/manifest.json");
export const QUICK_ACTIONS_ID = extensionId("quick-actions/manifest.json");

/** Pouch to Quick Actions: show a tab's save state. */
export interface PageStateMessage {
  type: "pageState";
  tabId: number;
  saved: boolean;
}
export type QuickActionStateMessage = PageStateMessage | { type: "fatalStorage"; error: string };

/** Quick Actions to Pouch: change or refresh page state, or check storage health. */
export type QuickActionMessage =
  | { type: "togglePage"; tabId: number }
  | { type: "refreshUi" }
  | { type: "getStorageDiagnostic" };

// Chromium has no browser namespace, and MV3's chrome.* returns promises too.
// Imported first by each entry point, so it runs before other code.
const scope = globalThis as unknown as { browser?: unknown; chrome?: unknown };
if (IS_CHROMIUM) {
  scope.browser ??= scope.chrome;
}
