// The Chromium build is two extensions: Pouch itself and Pouch Quick Actions,
// whose page action saves the current page. Chromium allows one action per
// extension, so they talk over runtime messages. Their IDs come from the
// public keys in build.ts.
export const IS_CHROMIUM = process.env.POUCH_TARGET === "chromium";
export const POUCH_ID = "hekmnhcdhmakfhnjhklpopfbaecdhkga";
export const QUICK_ACTIONS_ID = "bllnfamgbjpkdhihpmgoapkempmgpnlg";

/** Pouch to Quick Actions: show a tab's save state. */
export interface PageStateMessage {
  type: "pageState";
  tabId: number;
  saved: boolean;
}
export type QuickActionStateMessage = PageStateMessage | { type: "fatalStorage"; error: string };

/** Quick Actions to Pouch: save or remove a tab's page, or resend the active tab's state. */
export type QuickActionMessage = { type: "togglePage"; tabId: number } | { type: "refreshUi" };

// Chromium has no browser namespace, and MV3's chrome.* returns promises too.
// Imported first by each entry point, so it runs before other code.
const scope = globalThis as unknown as { browser?: unknown; chrome?: unknown };
if (IS_CHROMIUM) {
  scope.browser ??= scope.chrome;
}
