import {
  IS_CHROMIUM,
  type PageStateMessage,
  QUICK_ACTIONS_ID,
  type QuickActionMessage,
} from "../utils/chromium";
import { refreshFilterLists } from "../utils/filter-list-manager";
import { logger } from "../utils/logger";
import { getMissingOrigins, messageForOrigins } from "../utils/backend-permissions";
import { getSettings, type Settings, saveSettings } from "../utils/settings";
import { clearCanonicalUrlCache, initializeUrlCanonizer } from "../utils/url-helpers";
import {
  ArticlesRepository,
  getAccountIdentity,
  removeStaleAccountKeys,
} from "./articles-repository";
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

interface SaveArticleMessage {
  type: "saveArticle";
  payload: {
    url: string;
    title: string;
  };
}
interface CheckArticleMessage {
  type: "checkArticle";
  payload: {
    url: string;
  };
}
interface GetArticlesMessage {
  type: "getArticles";
  payload: {
    page?: number;
    perPage?: number;
    search?: string;
  };
}
interface DeleteArticleMessage {
  type: "deleteArticle";
  payload: {
    articleId: number | string;
  };
}
interface SaveSettingsMessage {
  type: "saveSettings";
  payload: {
    settings: Settings;
  };
}
interface TestConnectionMessage {
  type: "testConnection";
  payload: {
    settings: Settings;
  };
}
type Message =
  | SaveArticleMessage
  | CheckArticleMessage
  | GetArticlesMessage
  | DeleteArticleMessage
  | SaveSettingsMessage
  | TestConnectionMessage;
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
let articlesRepository: ArticlesRepository;
let initializePromise: Promise<void> | null = null;
let startupPromise: Promise<void> | null = null;
let urlCanonizerPromise: Promise<void> | null = null;
// What every start of the background needs, also each time Chromium's
// service worker wakes up. The URL rules may download filter lists, so
// requests don't wait for them; initialize() does.
function startup(): Promise<void> {
  startupPromise ??= (async () => {
    await logger.initialize();
    urlCanonizerPromise = initializeUrlCanonizer();
    await tokenManager.loadTokens();
    logger.info("Token manager initialized");
  })();
  return startupPromise;
}
async function getArticlesRepository(): Promise<ArticlesRepository> {
  await startup();
  if (!articlesRepository) {
    const settings = await getSettings();
    articlesRepository = new ArticlesRepository();
    await articlesRepository.initialize(settings);
  }
  return articlesRepository;
}
browser.runtime.onMessage.addListener(
  (
    message: Message,
    _sender: browser.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    void (async () => {
      let responseSent = false;
      const safeSendResponse = (response: unknown) => {
        if (!responseSent) {
          responseSent = true;
          sendResponse(response);
        }
      };
      try {
        switch (message.type) {
          case "saveSettings": {
            const { settings } = message.payload;
            const oldSettings = await getSettings();
            if (getAccountIdentity(oldSettings) !== getAccountIdentity(settings)) {
              await tokenManager.clearToken(oldSettings.backend);
            }
            await saveSettings(settings);
            await removeStaleAccountKeys(settings);
            clearCanonicalUrlCache();
            await logger.initialize();
            articlesRepository = new ArticlesRepository();
            await articlesRepository.initialize(settings);
            void articlesRepository
              .syncWithAPI({ mode: "overwrite" })
              .then((result) => {
                logger.info("Sync after settings change completed", {
                  mode: result.syncResult.mode,
                  total: result.total,
                });
              })
              .catch((error) => {
                logger.warn("Sync after settings change failed:", error);
              });
            logger.info("Settings saved and API re-initialized.");
            safeSendResponse({ success: true });
            return;
          }
          case "saveArticle": {
            const url = message.payload.url?.trim();
            const title = (message.payload.title || "").trim();
            if (!url || url.length === 0) {
              safeSendResponse({ error: "URL is required" });
              return;
            }
            if (!isValidUrl(url)) {
              safeSendResponse({ error: "Invalid URL format" });
              return;
            }
            articlesRepository = await getArticlesRepository();
            const savedArticle = await articlesRepository.saveArticle({
              url,
              title,
            });
            await refreshActiveTabUi();
            safeSendResponse(savedArticle);
            return;
          }
          case "checkArticle": {
            const url = message.payload.url?.trim();
            if (!url || url.length === 0) {
              safeSendResponse(undefined);
              return;
            }
            if (!isValidUrl(url)) {
              safeSendResponse(undefined);
              return;
            }
            articlesRepository = await getArticlesRepository();
            const foundArticle = await articlesRepository.findSaved(url);
            safeSendResponse(foundArticle);
            return;
          }
          case "getArticles": {
            const page = message.payload.page;
            const perPage = message.payload.perPage;
            const search = message.payload.search;

            if (
              page !== undefined &&
              (typeof page !== "number" || page < 1 || !Number.isInteger(page))
            ) {
              safeSendResponse({ error: "Invalid page number" });
              return;
            }
            if (
              perPage !== undefined &&
              (typeof perPage !== "number" ||
                perPage < 1 ||
                perPage > 1000 ||
                !Number.isInteger(perPage))
            ) {
              safeSendResponse({ error: "Invalid perPage value" });
              return;
            }
            const sanitizedSearch =
              search !== undefined && typeof search === "string"
                ? sanitizeSearch(search)
                : undefined;
            if (search !== undefined && sanitizedSearch !== search) {
              logger.debug("Search term sanitized", {
                original: search,
                sanitized: sanitizedSearch,
              });
            }

            articlesRepository = await getArticlesRepository();
            logger.debug("Handling getArticles request:", {
              page: message.payload.page,
              perPage: message.payload.perPage,
            });
            const articles = await articlesRepository.getRecentArticles(
              page,
              perPage,
              sanitizedSearch,
            );
            logger.debug("Articles retrieved:", articles);
            safeSendResponse(articles || { items: [], page: 1, pages: 0, total: 0 });
            return;
          }
          case "deleteArticle": {
            const articleId = message.payload.articleId;
            const isValidId =
              typeof articleId === "number"
                ? articleId >= 0 && Number.isInteger(articleId)
                : typeof articleId === "string" && articleId.length > 0;
            if (!isValidId) {
              safeSendResponse({
                error: "Article ID is required and must be a non-negative integer",
              });
              return;
            }
            articlesRepository = await getArticlesRepository();
            const result = await articlesRepository.deleteArticle(articleId);
            await refreshActiveTabUi();
            safeSendResponse(result);
            return;
          }
          case "testConnection": {
            try {
              // Draft credentials get their own in-memory TokenManager so they never touch the active account's tokens.
              const testRepo = new ArticlesRepository(new TokenManager({ persist: false }));
              await testRepo.initialize(message.payload.settings);
              const success = await testRepo.testConnection();
              safeSendResponse({
                success,
                error: success ? undefined : "Connection failed",
              });
            } catch (error) {
              safeSendResponse({
                success: false,
                error: (error as Error).message,
              });
            }
            return;
          }
          default: {
            safeSendResponse({ error: "Unknown message type" });
            return;
          }
        }
      } catch (error) {
        logger.error(`Error handling message:`, error);
        if (!responseSent) {
          safeSendResponse({ error: (error as Error).message || "Unknown error" });
        }
      }
    })();
    return true;
  },
);
browser.contextMenus.onClicked.addListener(async (info: OnClickData, tab?: Tab) => {
  try {
    const articlesRepository = await getArticlesRepository();
    if (info.menuItemId === "save-link" && info.linkUrl) {
      await articlesRepository.saveArticle({
        url: info.linkUrl,
        title: "",
      });
      if (tab?.id !== undefined) {
        await updateUiForTab(tab.id);
      }
    } else if (info.menuItemId === "save-page" && tab?.url) {
      const existingArticle = await articlesRepository.findSaved(tab.url);
      if (existingArticle) {
        await articlesRepository.deleteArticle(existingArticle.id);
      } else {
        await articlesRepository.saveArticle({
          url: tab.url,
          title: tab.title ?? "",
        });
      }
      if (tab.id) {
        await updateUiForTab(tab.id);
      }
    }
  } catch (error) {
    logger.error("Error saving link:", error);
    notifyError(info.menuItemId === "save-page" ? "toggle page" : "save link", error);
  }
});
// Chromium's service worker can't draw an SVG.
const NOTIFICATION_ICON = IS_CHROMIUM ? "icons/icon-128.png" : "icons/icon.svg";
const ERROR_NOTIFICATION_ID = "pouch-error";
function notifyError(operation: string, error: unknown): void {
  void browser.notifications.create(ERROR_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title: `Pouch — failed to ${operation}`,
    message: (error as Error).message || "Unknown error",
  });
}
const PERMISSIONS_NOTIFICATION_ID = "pouch-permissions";
async function warnIfPermissionsMissing(): Promise<void> {
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
  if (notificationId === PERMISSIONS_NOTIFICATION_ID) {
    void browser.runtime.openOptionsPage();
  }
});
async function togglePageSave(tab: Tab): Promise<void> {
  if (!tab.url || !isValidHttpUrl(tab.url)) {
    logger.warn("Ignoring page with invalid URL:", tab.url);
    return;
  }
  try {
    const articlesRepository = await getArticlesRepository();
    const existingArticle = await articlesRepository.findSaved(tab.url);
    if (existingArticle) {
      logger.info("Article already saved, deleting:", existingArticle.id);
      await articlesRepository.deleteArticle(existingArticle.id);
    } else {
      logger.info("Article not saved, saving:", {
        url: tab.url,
        title: tab.title || "Untitled",
      });
      await articlesRepository.saveArticle({
        url: tab.url,
        title: tab.title || "Untitled",
      });
    }
    if (tab.id) {
      await updateUiForTab(tab.id);
    }
  } catch (error) {
    logger.error("Error toggling page save:", error);
    notifyError("toggle page", error);
  }
}
if (IS_CHROMIUM) {
  browser.runtime.onMessageExternal.addListener(async (message: QuickActionMessage, sender) => {
    if (sender.id !== QUICK_ACTIONS_ID) {
      return;
    }
    if (message?.type === "togglePage") {
      await togglePageSave(await browser.tabs.get(message.tabId));
    } else if (message?.type === "refreshUi") {
      await refreshActiveTabUi();
    }
  });
} else {
  browser.pageAction.onClicked.addListener((tab) => {
    void togglePageSave(tab);
  });
}
browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-save-page") {
    return;
  }
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tab = tabs[0];
  if (tab) {
    await togglePageSave(tab);
  }
});
function getIconPath(isSaved: boolean): string {
  return browser.runtime.getURL(`icons/page-action-${isSaved ? "saved" : "unsaved"}.svg`);
}
async function updateUiForTab(tabId: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || !isValidHttpUrl(tab.url)) {
      return;
    }
    const articlesRepository = await getArticlesRepository();
    const existingArticle = await articlesRepository.findSaved(tab.url);
    const isSaved = !!existingArticle;
    if (IS_CHROMIUM) {
      const state: PageStateMessage = { type: "pageState", tabId, saved: isSaved };
      // Quick Actions may not be installed.
      await browser.runtime.sendMessage(QUICK_ACTIONS_ID, state).catch(() => {});
    } else {
      await browser.pageAction.setIcon({ tabId, path: getIconPath(isSaved) });
      browser.pageAction.setTitle({
        tabId,
        title: isSaved ? "Article saved" : "Save to Pouch",
      });
      await browser.pageAction.show(tabId);
    }
    await browser.contextMenus.update("save-page", {
      title: isSaved ? "Remove page" : "Save page",
      enabled: true,
    });
  } catch (error) {
    logger.error("Error updating UI for tab:", error);
    await browser.contextMenus.update("save-page", {
      title: "Unable to determine page status",
      enabled: false,
    });
  }
}
// Popup-initiated saves and deletes bypass the page-action toggle, so the
// icon and the context-menu entry would go stale until the next navigation or
// tab switch. Refresh the tab the popup is acting on.
async function refreshActiveTabUi(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id !== undefined) {
      await updateUiForTab(tab.id);
    }
  } catch (error) {
    logger.error("Error refreshing active tab UI:", error);
  }
}
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
    void updateUiForTab(tabId);
  }
};
// Chromium has no filter argument and rejects one.
if (IS_CHROMIUM) {
  browser.tabs.onUpdated.addListener(onTabUpdated);
} else {
  browser.tabs.onUpdated.addListener(onTabUpdated, { properties: ["status"] });
}
browser.tabs.onActivated.addListener(async (activeInfo) => {
  await updateUiForTab(activeInfo.tabId);
});

async function initialize(): Promise<void> {
  if (initializePromise) {
    return initializePromise;
  }
  initializePromise = (async () => {
    await browser.contextMenus.removeAll();
    await startup();
    // Menus and alarms first: a Chromium service worker may be stopped while
    // the filter lists or the first sync still load.
    browser.contextMenus.create({
      id: "save-link",
      title: "Save link",
      contexts: ["link"],
    });
    browser.contextMenus.create({
      id: "save-page",
      title: "Save page",
      contexts: [IS_CHROMIUM ? "action" : "browser_action"] as browser.menus.ContextType[],
    });
    void browser.alarms.create("refresh", { periodInMinutes: REFRESH_INTERVAL });
    void browser.alarms.create("refresh-filters", { periodInMinutes: 24 * 60 });
    await urlCanonizerPromise;
    logger.info("Background script initialized");

    const articlesRepository = await getArticlesRepository();
    try {
      const result = await articlesRepository.syncWithAPI({
        mode: "overwrite",
      });
      logger.info("Initial sync completed", {
        mode: result.syncResult.mode,
        total: result.total,
        metadata: result.syncResult.metadata,
      });
    } catch (error) {
      logger.warn("Failed to sync during initialization:", error);
    }
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs[0]?.id) {
      await updateUiForTab(tabs[0].id);
    }
  })();
  return initializePromise;
}
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TOKEN_CHECK_ALARM_NAME) {
    try {
      // A woken service worker has no adapter yet to say how to refresh.
      await (await getArticlesRepository()).initializeApi();
      await tokenManager.checkAndRefreshTokens();
    } catch (error) {
      logger.error("Error checking tokens:", error);
    }
  } else if (alarm.name === "refresh") {
    try {
      const articlesRepository = await getArticlesRepository();
      // Let the adapter decide the sync mode based on history and idle state
      const result = await articlesRepository.syncWithAPI();
      logger.info("Periodic sync completed", {
        mode: result.syncResult.mode,
        total: result.total,
        metadata: result.syncResult.metadata,
        syncDecision: result.syncResult.metadata?.syncDecision,
      });
    } catch (error) {
      logger.error("Error refreshing articles:", error);
    }
  } else if (alarm.name === "refresh-filters") {
    try {
      logger.info("Refreshing filter lists...");
      await refreshFilterLists();
      logger.info("Filter lists refreshed successfully");
    } catch (error) {
      logger.error("Error refreshing filter lists:", error);
    }
  }
});
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") {
    await initialize();
  }
  if (details.reason === "update") {
    // Users upgrading from the wide-host-permission version lose network
    // access until they re-grant it for their backend's origin.
    await warnIfPermissionsMissing();
  }
});

browser.runtime.onStartup.addListener(async () => {
  await initialize();
});

// Chromium's service worker comes and goes: it initializes on install and
// browser start, and its menus and alarms outlive it.
(IS_CHROMIUM ? startup() : initialize()).catch((error) => {
  logger.error("Failed to initialize extension:", error);
});
