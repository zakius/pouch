import { refreshFilterLists } from "../utils/filter-list-manager";
import { logger } from "../utils/logger";
import { getSettings, type Settings, saveSettings } from "../utils/settings";
import { initializeUrlCanonizer } from "../utils/url-helpers";
import { ArticlesRepository } from "./articles-repository";

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
const REFRESH_INTERVAL = 5;
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
			try {
				switch (message.type) {
					case "saveSettings": {
						const { settings } = message.payload;
						await saveSettings(settings);
						await logger.initialize();
						articlesRepository = new ArticlesRepository();
						await articlesRepository.initialize(settings);
						logger.info("Settings saved and API re-initialized.");
						return sendResponse({ success: true });
					}
					case "saveArticle": {
						articlesRepository = await getArticlesRepository();
						const savedArticle = await articlesRepository.saveArticle(
							message.payload,
						);
						return sendResponse(savedArticle);
					}
					case "checkArticle": {
						articlesRepository = await getArticlesRepository();
						const foundArticle = await articlesRepository.findSaved(
							message.payload.url,
						);
						return sendResponse(foundArticle);
					}
					case "getArticles": {
						articlesRepository = await getArticlesRepository();
						logger.debug("Handling getArticles request:", {
							page: message.payload.page,
							perPage: message.payload.perPage,
						});
						const articles = await articlesRepository.getRecentArticles(
							message.payload.page,
							message.payload.perPage,
							message.payload.search,
						);
						logger.debug("Articles retrieved:", articles);
						return sendResponse(
							articles || { items: [], page: 1, pages: 0, total: 0 },
						);
					}
					case "deleteArticle": {
						articlesRepository = await getArticlesRepository();
						if (!message.payload.articleId) {
							throw new Error("Article ID is required");
						}
						const result = await articlesRepository.deleteArticle(
							message.payload.articleId,
						);
						return sendResponse(result);
					}
					case "testConnection": {
						const testRepo = new ArticlesRepository();
						await testRepo.initialize(message.payload.settings);
						const success = await testRepo.testConnection();
						if (success) {
							return sendResponse({ success: true });
						} else {
							return sendResponse({
								success: false,
								error: "Connection failed",
							});
						}
					}
					default:
						sendResponse({ error: "Unknown message type" });
				}
			} catch (error) {
				logger.error(`Error handling message:`, error);
				sendResponse({ error: (error as Error).message });
			}
		})();
		return true;
	},
);
browser.contextMenus.onClicked.addListener(
	async (info: OnClickData, tab?: Tab) => {
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
		}
	},
);
browser.pageAction.onClicked.addListener(async (tab) => {
	if (!tab.url || !isValidHttpUrl(tab.url)) {
		logger.warn("Page action clicked on invalid URL:", tab.url);
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
		logger.error("Error handling page action click:", error);
	}
});
async function isDarkTheme(): Promise<boolean> {
	try {
		const theme = await browser.theme.getCurrent();
		return theme.colors?.frame === "dark";
	} catch {
		return false;
	}
}
async function getIconPath(isSaved: boolean): Promise<string> {
	const dark = await isDarkTheme();
	const iconPrefix = isSaved ? "page-action-saved" : "page-action-unsaved";
	const themeSuffix = dark ? "dark" : "light";
	return browser.runtime.getURL(`icons/${iconPrefix}-${themeSuffix}.svg`);
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
		const iconPath = await getIconPath(isSaved);
		await browser.pageAction.setIcon({ tabId, path: iconPath });
		await browser.pageAction.setTitle({
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

		// Refresh filter lists on startup to ensure they're up to date
		try {
			logger.info("Refreshing filter lists on startup...");
			await refreshFilterLists();
			logger.info("Filter lists refreshed on startup");
		} catch (error) {
			logger.warn("Failed to refresh filter lists on startup:", error);
		}

		const articlesRepository = await getArticlesRepository();
		try {
			await articlesRepository.syncWithAPI();
		} catch (error) {
			logger.warn("Failed to sync during initialization:", error);
			// Don't fail initialization if sync fails - this is expected for unconfigured APIs
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
		browser.alarms.create("refresh", { periodInMinutes: REFRESH_INTERVAL });
		// Create alarm for filter list refresh (once per day)
		browser.alarms.create("refresh-filters", { periodInMinutes: 24 * 60 });
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (
				(changeInfo.status === "complete" || "favIconUrl" in changeInfo) &&
				tab.url &&
				isValidHttpUrl(tab.url)
			) {
				void updateUiForTab(tabId);
			}
		});
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
			await articlesRepository.syncWithAPI();
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
