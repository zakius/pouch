import { Effect, Semaphore } from "effect";
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
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "../utils/settings";
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
  active?: boolean;
  windowId?: number;
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
function run<A, E extends Error>(
  label: string,
  effect: Effect.Effect<A, E>,
  present?: (error: Error) => void,
): Promise<A | undefined> {
  return runOperation(effect).catch((error: unknown) => {
    logger.error(`${label} failed:`, error);
    present?.(error instanceof Error ? error : new Error(String(error)));
    return undefined;
  });
}

// The worker owns one repository: an account change retires the old account's work.
const articlesRepository = new ArticlesRepository();
const settingsSaveLock = Semaphore.makeUnsafe(1);
const SETTINGS_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
let initializedSettings: Settings | undefined;
let pendingLocalSettingsWrites = 0;

const readSettings = browserCall("read settings", () => getSettings());

function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.backend === b.backend &&
    a.logLevel === b.logLevel &&
    a.normalizeOnSave === b.normalizeOnSave &&
    a.normalizeOnCompare === b.normalizeOnCompare &&
    getAccountIdentity(a) === getAccountIdentity(b)
  );
}

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
  if (!initializedSettings) {
    const settings = yield* readSettings;
    // saveSettings or storage.onChanged may have initialized it with newer settings meanwhile.
    if (!initializedSettings) {
      articlesRepository.initialize(settings);
      initializedSettings = settings;
    }
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
  return yield* Semaphore.withPermit(
    settingsSaveLock,
    Effect.gen(function* () {
      const oldSettings = initializedSettings ?? (yield* readSettings);
      const accountChanged = getAccountIdentity(oldSettings) !== getAccountIdentity(settings);
      const normalizationChanged =
        oldSettings.normalizeOnSave !== settings.normalizeOnSave ||
        oldSettings.normalizeOnCompare !== settings.normalizeOnCompare;
      yield* storageHealthy;
      yield* Effect.sync(() => {
        pendingLocalSettingsWrites++;
      }).pipe(
        Effect.andThen(browserCall("save settings", () => saveSettings(settings))),
        Effect.andThen(storageHealthy),
        Effect.andThen(accountChanged ? tokenManager.clearToken(oldSettings.backend) : Effect.void),
        Effect.andThen(storageHealthy),
        Effect.tap(() =>
          Effect.sync(() => {
            // Retire a replaced account before cleanup: its late writes must not recreate removed keys.
            // The same account keeps its in-flight work and only takes the new settings.
            articlesRepository.initialize(settings);
            initializedSettings = settings;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pendingLocalSettingsWrites--;
          }),
        ),
      );
      if (accountChanged) yield* articlesRepository.removeStaleKeys(settings);
      if (accountChanged || normalizationChanged) clearCanonicalUrlCache();
      logger.setLevel(settings.logLevel);
      yield* refreshActiveTabUi;
      if (accountChanged || normalizationChanged) {
        yield* forkDetachLogged(
          "Sync after settings change",
          syncInBackground("Sync after settings change"),
        );
      }
      logger.info("Settings saved and API re-initialized.");
      return { success: true };
    }),
  );
});

const handleSyncSettingsChange = (changes: Record<string, browser.storage.StorageChange>) =>
  Semaphore.withPermit(
    settingsSaveLock,
    Effect.gen(function* () {
      yield* storageHealthy;
      yield* startup;
      yield* storageHealthy;
      if (pendingLocalSettingsWrites > 0) return;
      const settings = yield* readSettings;
      yield* storageHealthy;
      if (pendingLocalSettingsWrites > 0) return;
      if (initializedSettings && settingsEqual(initializedSettings, settings)) return;
      const accountChanged = initializedSettings
        ? getAccountIdentity(initializedSettings) !== getAccountIdentity(settings)
        : "backend" in changes || "apiConfig" in changes;
      const normalizationChanged = initializedSettings
        ? initializedSettings.normalizeOnSave !== settings.normalizeOnSave ||
          initializedSettings.normalizeOnCompare !== settings.normalizeOnCompare
        : "normalizeOnSave" in changes || "normalizeOnCompare" in changes;
      if (accountChanged) {
        const oldBackend =
          initializedSettings?.backend ??
          (typeof changes.backend?.oldValue === "string"
            ? changes.backend.oldValue
            : settings.backend);
        yield* tokenManager.clearToken(oldBackend);
      }
      yield* storageHealthy;
      articlesRepository.initialize(settings);
      initializedSettings = settings;
      if (accountChanged) yield* articlesRepository.removeStaleKeys(settings);
      if (accountChanged || normalizationChanged) clearCanonicalUrlCache();
      logger.setLevel(settings.logLevel);
      yield* refreshActiveTabUi;
      logger.info("Applied out-of-band synced settings change.");
    }),
  );

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
      if (!isValidHttpUrl(url)) return invalidRequest("Only HTTP and HTTPS URLs can be saved");
      const repository = yield* getArticlesRepository;
      const savedArticle = yield* repository.saveArticle({ url, title });
      yield* refreshActiveTabUi;
      return savedArticle;
    }
    case "checkArticle": {
      const url = message.payload.url?.trim();
      if (!url || !isValidHttpUrl(url)) return undefined;
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
      if (info.menuItemId === "save-link" && info.linkUrl) {
        const linkUrl = info.linkUrl.trim();
        if (!isValidHttpUrl(linkUrl)) {
          logger.warn("Ignoring link with invalid URL:", info.linkUrl);
          return;
        }
        const repository = yield* getArticlesRepository;
        yield* repository.saveArticle({ url: linkUrl, title: "" });
        if (tab?.id !== undefined) yield* updateUiForTab(tab.id);
      } else if (info.menuItemId === "save-page" && tab) {
        yield* togglePageSave(tab);
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
  if (IS_CHROMIUM) return;
  const tabs = await browser.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const tabId = tab.id;
    await Promise.resolve()
      .then(() =>
        browser.pageAction.setIcon({
          tabId,
          path: browser.runtime.getURL("icons/icon.svg"),
        }),
      )
      .catch(() => {});
    await Promise.resolve()
      .then(() =>
        browser.pageAction.setTitle({
          tabId,
          title: "Pouch stopped: local storage failed",
        }),
      )
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
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (error) {
    logger.warn("Failed to read settings while checking permissions:", error);
    return;
  }
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
const inFlightToggles = new Set<string>();
const togglePageSave = (tab: Tab) =>
  Effect.gen(function* () {
    const url = tab.url?.trim();
    if (!url || !isValidHttpUrl(url)) {
      logger.warn("Ignoring page with invalid URL:", tab.url);
      return;
    }
    const keys = tab.id !== undefined ? [`tab:${tab.id}`, `url:${url}`] : [`url:${url}`];
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        if (keys.some((key) => inFlightToggles.has(key))) {
          logger.debug("Ignoring concurrent toggle already in flight:", { tabId: tab.id, url });
          return false;
        }
        for (const key of keys) inFlightToggles.add(key);
        return true;
      }),
      (acquired) =>
        acquired
          ? Effect.gen(function* () {
              const repository = yield* getArticlesRepository;
              yield* toggle(repository, url, tab.title || "Untitled");
              if (tab.id !== undefined) yield* updateUiForTab(tab.id);
            })
          : Effect.void,
      (acquired) =>
        acquired
          ? Effect.sync(() => {
              for (const key of keys) inFlightToggles.delete(key);
            })
          : Effect.void,
    );
  });
if (IS_CHROMIUM) {
  browser.runtime.onMessageExternal.addListener(
    (
      message: QuickActionMessage,
      sender: browser.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      if (sender.id !== QUICK_ACTIONS_ID) return undefined;
      // After shutdown the diagnostic is answered without the stopped runtime.
      const diagnostic = getStorageDiagnostic();
      if (message?.type === "getStorageDiagnostic") {
        void runOperation(readStorageDiagnostic)
          .catch(() => getStorageDiagnostic() ?? { error: "Storage initialization failed" })
          .then((result) => sendResponse(result));
        return true;
      }
      if (diagnostic) {
        void browser.runtime
          .sendMessage(QUICK_ACTIONS_ID, { type: "fatalStorage", error: diagnostic.error })
          .then(
            () => sendResponse(undefined),
            () => sendResponse(undefined),
          );
        return true;
      }
      void run(
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
      ).then(() => sendResponse(undefined));
      return true;
    },
  );
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
const isWindowFocused = (windowId?: number): Effect.Effect<boolean> =>
  windowId === undefined || typeof browser.windows?.get !== "function"
    ? Effect.succeed(true)
    : browserCall("read window", () => browser.windows.get(windowId)).pipe(
        Effect.map((win) => win.focused !== false),
        Effect.orElseSucceed(() => false),
      );
/** Never fails: an unknown page state shows as such, and a fatal stop shows the stopped UI. */
const updateUiForTab = (tabId: number, knownTab?: Tab) => {
  let shouldUpdateContextMenu = false;
  return Effect.gen(function* () {
    yield* storageHealthy;
    const tab: Tab = knownTab ?? (yield* browserCall("read tab", () => browser.tabs.get(tabId)));
    yield* storageHealthy;
    shouldUpdateContextMenu = tab.active !== false && (yield* isWindowFocused(tab.windowId));
    const url = tab.url?.trim();
    if (!url || !isValidHttpUrl(url)) {
      if (shouldUpdateContextMenu) {
        yield* browserCall("update menu", () =>
          browser.contextMenus.update("save-page", {
            title: "Save page",
            enabled: false,
          }),
        );
        yield* storageHealthy;
      }
      return;
    }
    const repository = yield* getArticlesRepository;
    const isSaved = !!(yield* repository.findSaved(url));
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
    if (shouldUpdateContextMenu) {
      yield* browserCall("update menu", () =>
        browser.contextMenus.update("save-page", {
          title: isSaved ? "Remove page" : "Save page",
          enabled: true,
        }),
      );
      yield* storageHealthy;
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.promise(async () => {
        if (!getStorageDiagnostic()) {
          logger.error("Error updating UI for tab:", error);
          if (shouldUpdateContextMenu) {
            await browser.contextMenus
              .update("save-page", { title: "Unable to determine page status", enabled: false })
              .catch(() => {});
          }
        }
        if (getStorageDiagnostic()) await showFatalUi();
      }),
    ),
    // Shutdown waits for dispatched browser calls, so the fatal UI is applied after them.
    Effect.uninterruptible,
  );
};
// Popup-initiated saves and deletes bypass the page-action toggle, so the
// icon and the context-menu entry would go stale until the next navigation or
// tab switch. Refresh the tab the popup is acting on.
const refreshActiveTabUiForWindow = (windowId?: number) =>
  Effect.gen(function* () {
    const queryInfo: browser.tabs._QueryQueryInfo =
      windowId !== undefined ? { active: true, windowId } : { active: true, currentWindow: true };
    const tabs = yield* browserCall("query tabs", () => browser.tabs.query(queryInfo));
    const tab = tabs[0];
    if (tab?.id !== undefined) yield* updateUiForTab(tab.id, tab);
  }).pipe(
    Effect.catchTag("BrowserFailure", (error) =>
      Effect.sync(() => logger.error("Error refreshing active tab UI:", error)),
    ),
  );
const refreshActiveTabUi = refreshActiveTabUiForWindow();
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
  if (changeInfo.status === "complete" || changeInfo.url !== undefined) {
    const updatedTab: Tab = changeInfo.url !== undefined ? { ...tab, url: changeInfo.url } : tab;
    void run("Tab update", updateUiForTab(tabId, updatedTab));
  }
};
// Chromium has no filter argument and rejects one.
if (IS_CHROMIUM) {
  browser.tabs.onUpdated.addListener(onTabUpdated);
} else {
  browser.tabs.onUpdated.addListener(onTabUpdated, { properties: ["status", "url"] });
}
browser.tabs.onActivated.addListener((activeInfo) =>
  run("Tab activation", updateUiForTab(activeInfo.tabId)),
);
const WINDOW_ID_NONE = browser.windows?.WINDOW_ID_NONE ?? -1;
browser.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId === WINDOW_ID_NONE || windowId === -1) return;
  void run("Window focus", refreshActiveTabUiForWindow(windowId));
});

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
        // Clear any legacy repeating alarm from earlier versions; checkAndRefreshTokens
        // stays safe (no password login, no token drop) if invoked before cleanup.
        yield* tokenManager.clearLegacyAlarm;
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
browser.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "sync" || pendingLocalSettingsWrites > 0) return;
  if (!Object.keys(changes).some((key) => SETTINGS_KEYS.has(key))) return;
  void run("Sync settings change", handleSyncSettingsChange(changes));
});

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
