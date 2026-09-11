import { refreshFilterLists } from "../utils/filter-list-manager";
import { logger } from "../utils/logger";
import { getSettings, type Settings, saveSettings } from "../utils/settings";
import { initializeUrlCanonizer } from "../utils/url-helpers";
import { ArticlesRepository } from "./articles-repository";
import { tokenManager } from "./token-manager";

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
  // eslint-disable-next-line no-control-regex -- We're sanitizing input, not creating control characters
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
    articleId: number;
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
const REFRESH_INTERVAL = 30; // 30 minutes - smart sync will handle full syncs when needed
let articlesRepository: ArticlesRepository;
let initializePromise: Promise<void> | null = null;
async function getArticlesRepository(): Promise<ArticlesRepository> {
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
            // Clear tokens for the old backend before switching
            const oldSettings = await getSettings();
            if (oldSettings.backend !== settings.backend) {
              await tokenManager.clearToken(oldSettings.backend);
            }
            await saveSettings(settings);
            await logger.initialize();
            articlesRepository = new ArticlesRepository();
            await articlesRepository.initialize(settings);
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
              // Search was modified during sanitization
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
            if (typeof articleId !== "number" || articleId < 0 || !Number.isInteger(articleId)) {
              safeSendResponse({
                error: "Article ID is required and must be a non-negative integer",
              });
              return;
            }
            articlesRepository = await getArticlesRepository();
            const result = await articlesRepository.deleteArticle(articleId);
            safeSendResponse(result);
            return;
          }
          case "testConnection": {
            try {
              const testRepo = new ArticlesRepository();
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
const ERROR_NOTIFICATION_ID = "pouch-error";
function notifyError(operation: string, error: unknown): void {
  void browser.notifications.create(ERROR_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "icons/icon.svg",
    title: `Pouch — failed to ${operation}`,
    message: (error as Error).message || "Unknown error",
  });
}
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
browser.pageAction.onClicked.addListener((tab) => {
  void togglePageSave(tab);
});
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
    const iconPath = getIconPath(isSaved);
    await browser.pageAction.setIcon({ tabId, path: iconPath });
    browser.pageAction.setTitle({
      tabId,
      title: isSaved ? "Article saved" : "Save to Pouch",
    });
    await browser.pageAction.show(tabId);
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
function isValidHttpUrl(url: string) {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "http:" || urlObj.protocol === "https:";
  } catch {
    return false;
  }
}
async function initialize(): Promise<void> {
  if (initializePromise) {
    return initializePromise;
  }
  initializePromise = (async () => {
    await browser.contextMenus.removeAll();
    await logger.initialize();
    logger.info("Background script initialized");
    await initializeUrlCanonizer();

    await tokenManager.loadTokens();
    logger.info("Token manager initialized");

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
    browser.contextMenus.create({
      id: "save-link",
      title: "Save link",
      contexts: ["link"],
    });
    browser.contextMenus.create({
      id: "save-page",
      title: "Save page",
      contexts: ["browser_action"],
    });
    void browser.alarms.create("refresh", { periodInMinutes: REFRESH_INTERVAL });
    void browser.alarms.create("refresh-filters", { periodInMinutes: 24 * 60 });
    browser.tabs.onUpdated.addListener(
      (tabId, changeInfo, tab) => {
        if (changeInfo.status === "complete" && tab.url && isValidHttpUrl(tab.url)) {
          void updateUiForTab(tabId);
        }
      },
      { properties: ["status"] },
    );
    browser.tabs.onActivated.addListener(async (activeInfo) => {
      await updateUiForTab(activeInfo.tabId);
    });
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
  if (alarm.name === "refresh") {
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
});

initialize().catch((error) => {
  logger.error("Failed to initialize extension:", error);
});
