import { Effect } from "effect";
import {
  parseRuntimeMessage,
  errorResponse,
  invalidRequest,
  InvalidRequest,
} from "./runtime-message";
import {
  BrowserFailure,
  forkDetachLogged,
  runOperation,
  storageHealthy,
  storagePromise,
} from "./api/effect-adapter";
import {
  FatalStorageError,
  browserReportedReason,
  checkStorageOnStartup,
  getStorageDiagnostic,
  onFatalStorage,
  safeCause,
} from "../utils/fatal-storage";
import {
  IS_CHROMIUM,
  type PageStateMessage,
  QUICK_ACTIONS_ID,
  type QuickActionMessage,
} from "../utils/chromium";
import { refreshFilterLists } from "../utils/filter-list-manager";
import { logger } from "../utils/logger";
import { getMissingOrigins, messageForOrigins } from "../utils/backend-permissions";
import { getSettings, saveSettings } from "../utils/settings";
import { clearCanonicalUrlCache, initializeUrlCanonizer } from "../utils/url-helpers";
import { ArticlesRepository, getAccountIdentity } from "./articles-repository";
import { TOKEN_CHECK_ALARM_NAME, TokenManager, tokenManager } from "./token-manager";

/**
 * Validates a URL string. Returns true if valid, false otherwise.
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes search input by trimming and removing control characters.
 */
function sanitizeSearch(search: string): string {
  // Trim whitespace
  let sanitized = search.trim();
  // Remove control characters (except tab, newline, carriage return)
  // eslint-disable-next-line no-control-regex -- sanitizing input, not creating control characters
  sanitized = sanitized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return sanitized;
}

interface OnClickData {
  menuItemId: string | number;
  linkUrl?: string;
}
interface Tab {
  id?: number;
  url?: string;
  title?: string;
}
const REFRESH_INTERVAL = 30;

/** A browser API call; its rejection is an operational failure of that call. */
const browserCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) =>
      browserReportedReason(error)
        ? new BrowserFailure(operation, "rejected", safeCause(error))
        : new BrowserFailure(operation, "unavailable"),
  });

/**
 * The boundary of every listener: runs its Effect, then logs and optionally presents the
 * classified failure (operational, fatal storage, interruption or defect).
 */
function run<A, E>(
  label: string,
  effect: Effect.Effect<A, E>,
  present?: (error: Error) => void,
): Promise<A | undefined> {
  return runOperation(effect).catch((error: Error) => {
    logger.error(`${label} failed:`, error);
    present?.(error);
    return undefined;
  });
}

// The worker owns one repository: an account change retires the old account's work.
const articlesRepository = new ArticlesRepository();
let repositoryInitialized = false;

// Filter lists may download, so requests don't wait for them; initialize does.
const urlCanonizer = Effect.runSync(
  Effect.cached(
    storagePromise(initializeUrlCanonizer).pipe(
      Effect.catchTag("FatalStorageFailure", (error) =>
        Effect.sync(() => logger.error("URL initialization failed:", error)),
      ),
    ),
  ),
);
// What every start of the background needs, also each time Chromium's service worker wakes up:
// a fresh worker checks storage and reloads tokens before any other work.
const startup = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      yield* storagePromise(checkStorageOnStartup);
      yield* Effect.promise(() => logger.initialize());
      yield* storageHealthy;
      yield* forkDetachLogged("URL initialization", urlCanonizer);
      yield* tokenManager.loadTokens;
      yield* storageHealthy;
      logger.info("Token manager initialized");
    }),
  ),
);

const readStorageDiagnostic = startup.pipe(
  Effect.map(() => getStorageDiagnostic() ?? null),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      logger.error("Storage initialization failed:", cause);
      return getStorageDiagnostic() ?? { error: "Storage initialization failed" };
    }),
  ),
);

const getArticlesRepository = Effect.gen(function* () {
  yield* storageHealthy;
  yield* startup;
  yield* storageHealthy;
  if (!repositoryInitialized) {
    const settings = yield* Effect.promise(() => getSettings());
    // saveSettings may have initialized it with newer settings meanwhile.
    if (!repositoryInitialized) articlesRepository.initialize(settings);
    repositoryInitialized = true;
  }
  return articlesRepository;
});

const syncInBackground = (reason: string) =>
  articlesRepository.syncWithAPI({ mode: "overwrite" }).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        logger.info(`${reason} completed`, {
          mode: result.syncResult.mode,
          total: result.total,
          metadata: result.syncResult.metadata,
        }),
      ),
    ),
    Effect.catch((error) => Effect.sync(() => logger.warn(`${reason} failed:`, error))),
  );

const saveSettingsMessage = Effect.fn("background.saveSettings")(function* (
  settings: Parameters<typeof saveSettings>[0],
) {
  const oldSettings = yield* Effect.promise(() => getSettings());
  if (getAccountIdentity(oldSettings) !== getAccountIdentity(settings))
    yield* tokenManager.clearToken(oldSettings.backend);
  yield* storageHealthy;
  yield* browserCall("save settings", () => saveSettings(settings));
  yield* storageHealthy;
  // Retire a replaced account before cleanup: its late writes must not recreate removed keys.
  // The same account keeps its in-flight work and only takes the new settings.
  articlesRepository.initialize(settings);
  repositoryInitialized = true;
  yield* articlesRepository.removeStaleKeys(settings);
  clearCanonicalUrlCache();
  yield* Effect.promise(() => logger.initialize());
  yield* forkDetachLogged(
    "Sync after settings change",
    syncInBackground("Sync after settings change"),
  );
  logger.info("Settings saved and API re-initialized.");
  return { success: true };
});

const handleMessage = Effect.fn("background.message")(function* (rawMessage: unknown) {
  const message = yield* Effect.try({
    try: () => parseRuntimeMessage(rawMessage),
    catch: () => new InvalidRequest(),
  });
  if (message.type === "getStorageDiagnostic") return yield* readStorageDiagnostic;
  yield* storageHealthy;
  yield* startup;
  yield* storageHealthy;
  switch (message.type) {
    case "saveSettings":
      return yield* saveSettingsMessage(message.payload.settings);
    case "saveArticle": {
      const url = message.payload.url?.trim();
      const title = (message.payload.title || "").trim();
      if (!url) return invalidRequest("URL is required");
      if (!isValidUrl(url)) return invalidRequest("Invalid URL format");
      const repository = yield* getArticlesRepository;
      const savedArticle = yield* repository.saveArticle({ url, title });
      yield* refreshActiveTabUi;
      return savedArticle;
    }
    case "checkArticle": {
      const url = message.payload.url?.trim();
      if (!url || !isValidUrl(url)) return undefined;
      const repository = yield* getArticlesRepository;
      return yield* repository.findSaved(url);
    }
    case "getArticles": {
      const { page, perPage, search } = message.payload;
      if (page !== undefined && (page < 1 || !Number.isInteger(page)))
        return invalidRequest("Invalid page number");
      if (perPage !== undefined && (perPage < 1 || perPage > 1000 || !Number.isInteger(perPage)))
        return invalidRequest("Invalid perPage value");
      const sanitizedSearch = search !== undefined ? sanitizeSearch(search) : undefined;
      if (search !== undefined && sanitizedSearch !== search) {
        logger.debug("Search term sanitized", { original: search, sanitized: sanitizedSearch });
      }
      const repository = yield* getArticlesRepository;
      logger.debug("Handling getArticles request:", { page, perPage });
      const articles = yield* repository.getRecentArticles(page, perPage, sanitizedSearch);
      logger.debug("Articles retrieved:", articles);
      return articles;
    }
    case "deleteArticle": {
      const articleId = message.payload.articleId;
      const isValidId =
        typeof articleId === "number"
          ? articleId >= 0 && Number.isInteger(articleId)
          : articleId.length > 0;
      if (!isValidId)
        return invalidRequest("Article ID is required and must be a non-negative integer");
      const repository = yield* getArticlesRepository;
      const result = yield* repository.deleteArticle(articleId);
      yield* refreshActiveTabUi;
      return result;
    }
    case "testConnection": {
      // Draft credentials get their own in-memory TokenManager so they never touch the active account's tokens.
      const testRepo = new ArticlesRepository(new TokenManager({ persist: false }));
      testRepo.initialize(message.payload.settings);
      return yield* testRepo.testConnection.pipe(
        Effect.as({ success: true }),
        Effect.catch((error) => Effect.succeed({ success: false, ...errorResponse(error) })),
      );
    }
  }
});

browser.runtime.onMessage.addListener(
  (
    rawMessage: unknown,
    _sender: browser.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    void runOperation(handleMessage(rawMessage))
      .catch((error: unknown) => {
        logger.error("Error handling message:", error);
        return errorResponse(error);
      })
      .then((response) => {
        // A fatal stop reported anywhere replaces the response, even a late success.
        const fatal = getStorageDiagnostic();
        sendResponse(fatal ? errorResponse(new FatalStorageError(fatal)) : response);
      });
    return true;
  },
);
browser.contextMenus.onClicked.addListener((info: OnClickData, tab?: Tab) =>
  run(
    "Context menu",
    Effect.gen(function* () {
      const repository = yield* getArticlesRepository;
      if (info.menuItemId === "save-link" && info.linkUrl) {
        yield* repository.saveArticle({ url: info.linkUrl, title: "" });
        if (tab?.id !== undefined) yield* updateUiForTab(tab.id);
      } else if (info.menuItemId === "save-page" && tab?.url) {
        yield* toggle(repository, tab.url, tab.title ?? "");
        if (tab.id) yield* updateUiForTab(tab.id);
      }
    }),
    (error) => notifyError(info.menuItemId === "save-page" ? "toggle page" : "save link", error),
  ),
);
// Chromium's service worker can't draw an SVG. A relative path would resolve under background/.
const NOTIFICATION_ICON = browser.runtime.getURL(
  IS_CHROMIUM ? "icons/icon-128.png" : "icons/icon.svg",
);
const ERROR_NOTIFICATION_ID = "pouch-error";
onFatalStorage((diagnostic) => {
  void browser.notifications
    .create(ERROR_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: "Pouch stopped: local storage failed",
      message: diagnostic.error,
    })
    .catch((error) => logger.error("Storage notification failed:", error));
  void browser.runtime.sendMessage({ type: "fatalStorage", diagnostic }).catch(() => {});
  if (IS_CHROMIUM) {
    void browser.runtime
      .sendMessage(QUICK_ACTIONS_ID, { type: "fatalStorage", error: diagnostic.error })
      .catch(() => {});
  }
  void showFatalUi();
});
async function showFatalUi(): Promise<void> {
  await browser.contextMenus
    .update("save-page", { title: "Pouch stopped: local storage failed", enabled: false })
    .catch(() => {});
  await browser.contextMenus
    .update("save-link", { title: "Pouch stopped: local storage failed", enabled: false })
    .catch(() => {});
  if (!IS_CHROMIUM) {
    await browser.tabs
      .query({})
      .then(async (tabs) => {
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          await browser.pageAction.setIcon({
            tabId: tab.id,
            path: browser.runtime.getURL("icons/icon.svg"),
          });
          await Promise.resolve(
            browser.pageAction.setTitle({
              tabId: tab.id,
              title: "Pouch stopped: local storage failed",
            }),
          );
        }
      })
      .catch(() => {});
  }
}
function notifyError(operation: string, error: Error): void {
  void browser.notifications
    .create(ERROR_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: `Pouch — failed to ${operation}`,
      message: getStorageDiagnostic()?.error || error.message || "Unknown error",
    })
    .catch((notificationError) => logger.error("Error notification failed:", notificationError));
}
const notifyToggleFailure = (error: Error) => notifyError("toggle page", error);
const PERMISSIONS_NOTIFICATION_ID = "pouch-permissions";
async function warnIfPermissionsMissing(): Promise<void> {
  if (getStorageDiagnostic()) return;
  const settings = await getSettings();
  const missing = await getMissingOrigins(settings);
  if (missing.length === 0) {
    return;
  }
  try {
    await browser.notifications.create(PERMISSIONS_NOTIFICATION_ID, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: "Pouch — permission needed",
      message: messageForOrigins(missing),
    });
  } catch (error) {
    logger.warn("Failed to create permission notification:", error);
  }
}
browser.permissions.onRemoved.addListener(() => {
  void warnIfPermissionsMissing();
});
browser.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === PERMISSIONS_NOTIFICATION_ID || notificationId === ERROR_NOTIFICATION_ID) {
    void browser.runtime.openOptionsPage();
  }
});
const toggle = (repository: ArticlesRepository, url: string, title: string) =>
  Effect.gen(function* () {
    const existingArticle = yield* repository.findSaved(url);
    if (existingArticle) {
      logger.info("Article already saved, deleting:", existingArticle.id);
      yield* repository.deleteArticle(existingArticle.id);
    } else {
      logger.info("Article not saved, saving:", { url, title });
      yield* repository.saveArticle({ url, title });
    }
  });
const togglePageSave = (tab: Tab) =>
  Effect.gen(function* () {
    if (!tab.url || !isValidHttpUrl(tab.url)) {
      logger.warn("Ignoring page with invalid URL:", tab.url);
      return;
    }
    const repository = yield* getArticlesRepository;
    yield* toggle(repository, tab.url, tab.title || "Untitled");
    if (tab.id) yield* updateUiForTab(tab.id);
  });
if (IS_CHROMIUM) {
  browser.runtime.onMessageExternal.addListener((message: QuickActionMessage, sender) => {
    if (sender.id !== QUICK_ACTIONS_ID) return undefined;
    // After shutdown the diagnostic is answered without the stopped runtime.
    const diagnostic = getStorageDiagnostic();
    if (message?.type === "getStorageDiagnostic")
      return runOperation(readStorageDiagnostic).catch(
        () => getStorageDiagnostic() ?? { error: "Storage initialization failed" },
      );
    if (diagnostic)
      return browser.runtime
        .sendMessage(QUICK_ACTIONS_ID, { type: "fatalStorage", error: diagnostic.error })
        .then(
          () => undefined,
          () => undefined,
        );
    return run(
      "Quick Actions",
      Effect.gen(function* () {
        if (message?.type === "togglePage") {
          const tab = yield* browserCall("read tab", () => browser.tabs.get(message.tabId));
          yield* togglePageSave(tab);
        } else if (message?.type === "refreshUi") {
          yield* refreshActiveTabUi;
        }
        return undefined;
      }),
      notifyToggleFailure,
    );
  });
} else {
  browser.pageAction.onClicked.addListener((tab) => {
    void run("Page action", togglePageSave(tab), notifyToggleFailure);
  });
}
browser.commands.onCommand.addListener((command) =>
  run(
    "Command",
    Effect.gen(function* () {
      if (command !== "toggle-save-page") return;
      yield* storageHealthy;
      const tabs = yield* browserCall("query tabs", () =>
        browser.tabs.query({ active: true, currentWindow: true }),
      );
      if (tabs[0]) yield* togglePageSave(tabs[0]);
    }),
    notifyToggleFailure,
  ),
);
function getIconPath(isSaved: boolean): string {
  return browser.runtime.getURL(`icons/page-action-${isSaved ? "saved" : "unsaved"}.svg`);
}
/** Never fails: an unknown page state shows as such, and a fatal stop shows the stopped UI. */
const updateUiForTab = (tabId: number) =>
  Effect.gen(function* () {
    yield* storageHealthy;
    const tab = yield* browserCall("read tab", () => browser.tabs.get(tabId));
    yield* storageHealthy;
    if (!tab.url || !isValidHttpUrl(tab.url)) return;
    const repository = yield* getArticlesRepository;
    const isSaved = !!(yield* repository.findSaved(tab.url));
    yield* storageHealthy;
    if (IS_CHROMIUM) {
      const state: PageStateMessage = { type: "pageState", tabId, saved: isSaved };
      // Quick Actions may not be installed.
      yield* Effect.promise(() =>
        browser.runtime.sendMessage(QUICK_ACTIONS_ID, state).catch(() => {}),
      );
    } else {
      yield* browserCall("set page icon", () =>
        browser.pageAction.setIcon({ tabId, path: getIconPath(isSaved) }),
      );
      yield* storageHealthy;
      yield* browserCall("set page title", () =>
        Promise.resolve(
          browser.pageAction.setTitle({
            tabId,
            title: isSaved ? "Article saved" : "Save to Pouch",
          }),
        ),
      );
      yield* storageHealthy;
      yield* browserCall("show page action", () => browser.pageAction.show(tabId));
    }
    yield* storageHealthy;
    yield* browserCall("update menu", () =>
      browser.contextMenus.update("save-page", {
        title: isSaved ? "Remove page" : "Save page",
        enabled: true,
      }),
    );
    yield* storageHealthy;
  }).pipe(
    Effect.catch((error) =>
      Effect.promise(async () => {
        if (!getStorageDiagnostic()) {
          logger.error("Error updating UI for tab:", error);
          await browser.contextMenus
            .update("save-page", { title: "Unable to determine page status", enabled: false })
            .catch(() => {});
        }
        if (getStorageDiagnostic()) await showFatalUi();
      }),
    ),
    // Shutdown waits for dispatched browser calls, so the fatal UI is applied after them.
    Effect.uninterruptible,
  );
// Popup-initiated saves and deletes bypass the page-action toggle, so the
// icon and the context-menu entry would go stale until the next navigation or
// tab switch. Refresh the tab the popup is acting on.
const refreshActiveTabUi = Effect.gen(function* () {
  const tabs = yield* browserCall("query tabs", () =>
    browser.tabs.query({ active: true, currentWindow: true }),
  );
  const tab = tabs[0];
  if (tab?.id !== undefined) yield* updateUiForTab(tab.id);
}).pipe(
  Effect.catchTag("BrowserFailure", (error) =>
    Effect.sync(() => logger.error("Error refreshing active tab UI:", error)),
  ),
);
function isValidHttpUrl(url: string) {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "http:" || urlObj.protocol === "https:";
  } catch {
    return false;
  }
}
const onTabUpdated = (
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab,
) => {
  if (changeInfo.status === "complete" && tab.url && isValidHttpUrl(tab.url)) {
    void run("Tab update", updateUiForTab(tabId));
  }
};
// Chromium has no filter argument and rejects one.
if (IS_CHROMIUM) {
  browser.tabs.onUpdated.addListener(onTabUpdated);
} else {
  browser.tabs.onUpdated.addListener(onTabUpdated, { properties: ["status"] });
}
browser.tabs.onActivated.addListener((activeInfo) =>
  run("Tab activation", updateUiForTab(activeInfo.tabId)),
);

// A menu or alarm created while shutdown starts is disabled or cleared before shutdown completes.
const createMenu = (properties: browser.menus._CreateCreateProperties) =>
  Effect.gen(function* () {
    yield* storageHealthy;
    yield* Effect.callback<void>((resume) => {
      browser.contextMenus.create(properties, () => resume(Effect.void));
    });
    if (getStorageDiagnostic()) yield* Effect.promise(showFatalUi);
  }).pipe(Effect.uninterruptible, Effect.andThen(storageHealthy));

const createMaintenanceAlarm = (name: string, periodInMinutes: number) =>
  Effect.gen(function* () {
    yield* storageHealthy;
    yield* browserCall("create alarm", () => browser.alarms.create(name, { periodInMinutes }));
    if (getStorageDiagnostic()) yield* Effect.promise(() => browser.alarms.clear(name));
  }).pipe(Effect.uninterruptible, Effect.andThen(storageHealthy));

// Install and browser start; Chromium's menus and alarms outlive its service worker.
const initialize = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      yield* storageHealthy;
      yield* browserCall("remove menus", () => browser.contextMenus.removeAll());
      yield* storageHealthy;
      yield* startup;
      yield* storageHealthy;
      // Menus and alarms first: a Chromium service worker may be stopped while
      // the filter lists or the first sync still load.
      yield* createMenu({ id: "save-link", title: "Save link", contexts: ["link"] });
      yield* createMenu({
        id: "save-page",
        title: "Save page",
        contexts: [IS_CHROMIUM ? "action" : "browser_action"] as browser.menus.ContextType[],
      });
      yield* createMaintenanceAlarm("refresh", REFRESH_INTERVAL);
      yield* createMaintenanceAlarm("refresh-filters", 24 * 60);
      yield* urlCanonizer;
      yield* storageHealthy;
      logger.info("Background script initialized");
      yield* getArticlesRepository;
      yield* syncInBackground("Initial sync");
      yield* storageHealthy;
      yield* refreshActiveTabUi;
    }),
  ),
);
browser.alarms.onAlarm.addListener((alarm) =>
  run(
    `Alarm ${alarm.name}`,
    Effect.gen(function* () {
      yield* storageHealthy;
      yield* startup;
      yield* storageHealthy;
      if (alarm.name === TOKEN_CHECK_ALARM_NAME) {
        // Refreshes the tokens of the backends in use since the background
        // started. A Chromium service worker that this alarm woke has none: its
        // adapter logs in or refreshes when the backend is next used.
        yield* tokenManager.checkAndRefreshTokens;
      } else if (alarm.name === "refresh") {
        const repository = yield* getArticlesRepository;
        // Let the adapter decide the sync mode based on history and idle state
        const result = yield* repository.syncWithAPI();
        logger.info("Periodic sync completed", {
          mode: result.syncResult.mode,
          total: result.total,
          metadata: result.syncResult.metadata,
          syncDecision: result.syncResult.metadata?.syncDecision,
        });
      } else if (alarm.name === "refresh-filters") {
        logger.info("Refreshing filter lists...");
        yield* storagePromise(refreshFilterLists);
        logger.info("Filter lists refreshed successfully");
      }
    }),
  ),
);
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") {
    await run("Initialization", initialize);
  }
  if (details.reason === "update") {
    // Users upgrading from the wide-host-permission version lose network
    // access until they re-grant it for their backend's origin.
    await warnIfPermissionsMissing();
  }
});

browser.runtime.onStartup.addListener(() => run("Initialization", initialize));

// Chromium's service worker comes and goes: it initializes on install and
// browser start, and its menus and alarms outlive it.
void run("Initialization", IS_CHROMIUM ? startup : initialize);
