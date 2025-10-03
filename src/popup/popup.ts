import type { Article } from "../types/common";
import { logger } from "../utils/logger";

// Cache key for browser storage
const FAVICON_CACHE_KEY = "faviconCache";

// In-memory favicon cache for immediate access
let faviconCache: Record<string, string> = {};

// Load favicon cache into memory for immediate access
async function loadFaviconCache(): Promise<void> {
	try {
		const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
		faviconCache = result[FAVICON_CACHE_KEY] || {};
		logger.debug("Loaded favicon cache:", Object.keys(faviconCache).length, "entries");
	} catch (error) {
		logger.debug("Failed to load favicon cache:", error);
		faviconCache = {};
	}
}

async function getCachedFavicon(hostname: string): Promise<string> {
	try {
		// Check persistent cache
		const result = await browser.storage.local.get(FAVICON_CACHE_KEY);
		const faviconCache = result[FAVICON_CACHE_KEY] || {};

		logger.debug(
			"Checking cache for",
			hostname,
			"available keys:",
			Object.keys(faviconCache),
		);

		if (faviconCache[hostname]) {
			logger.debug(
				"Using cached favicon for",
				hostname,
				"length:",
				faviconCache[hostname].length,
			);

			// Debug smallweb specifically
			if (hostname.includes("smallweb")) {
				console.log("smallweb cached favicon found:", {
					hostname,
					length: faviconCache[hostname].length,
					prefix: faviconCache[hostname].substring(0, 100),
					hasDataPrefix: faviconCache[hostname].startsWith("data:"),
				});
			}

			return faviconCache[hostname];
		}

		// If not cached, try to load it on-demand
		logger.debug(
			"No cached favicon found for",
			hostname,
			"attempting to load on-demand",
		);
		try {
			const response = await browser.runtime.sendMessage({
				type: "loadFavicon",
				payload: { hostname },
			});

			if (response?.success) {
				logger.debug("Successfully loaded favicon on-demand for", hostname);
				return response.favicon;
			}
		} catch (error) {
			logger.debug("Failed to load favicon on-demand for", hostname, error);
		}
	} catch (error) {
		logger.debug("Failed to get cached favicon for", hostname, error);
	}

	// Fallback to default icon if not cached
	logger.debug("No cached favicon found for", hostname, "using fallback");
	return "icons/icon.svg";
}

const searchInput = document.getElementById(
	"search",
) as HTMLInputElement | null;
const articlesContainer = document.getElementById(
	"articles",
) as HTMLElement | null;
const prevButton = document.getElementById(
	"prev-page",
) as HTMLButtonElement | null;
const nextButton = document.getElementById(
	"next-page",
) as HTMLButtonElement | null;
const pageInfo = document.getElementById("page-info") as HTMLElement | null;
const pageSelect = document.getElementById(
	"page-select",
) as HTMLSelectElement | null;
const savePageButton = document.getElementById(
	"save-page-button",
) as HTMLButtonElement | null;
const settingsButton = document.getElementById(
	"settings-button",
) as HTMLButtonElement | null;
const articleListContainer = document.getElementById("article-list");
const emptyMessage = document.getElementById("empty-message");
const noResultsMessage = document.getElementById("no-results-message");
let currentTab: browser.tabs.Tab | undefined;
let savedArticleForCurrentPage: Article | undefined;
const itemsPerPage = 10;
let currentPage = 1;
let totalPages = 1;
async function initializePopup(): Promise<void> {
	try {
		logger.debug("Initializing popup...");
		
		// Load favicon cache for immediate access
		await loadFaviconCache();
		
		const tabs = await browser.tabs.query({
			active: true,
			currentWindow: true,
		});
		currentTab = tabs[0];
		if (
			!searchInput ||
			!prevButton ||
			!nextButton ||
			!pageSelect ||
			!savePageButton ||
			!settingsButton
		)
			return;
		searchInput.addEventListener("input", handleSearch);
		prevButton.addEventListener("click", () => changePage(-1));
		nextButton.addEventListener("click", () => changePage(1));
		pageSelect.addEventListener("change", handlePageSelect);
		savePageButton.addEventListener("click", handleSavePageClick);
		settingsButton.addEventListener("click", () => {
			browser.runtime.openOptionsPage();
		});
		await loadRecentArticles();
		await updateSavePageButtonState();
	} catch (error: unknown) {
		logger.error("Error initializing popup:", error);
		const errorMessage =
			error instanceof Error ? error.message : "Failed to initialize popup";
		showError(`Could not load articles. ${errorMessage}`, true);
	}
}
async function loadRecentArticles(): Promise<void> {
	const searchTerm = searchInput?.value.toLowerCase().trim() || "";
	logger.debug("Requesting recent articles from background script...");

	try {
		const response = (await browser.runtime.sendMessage({
			type: "getArticles",
			payload: {
				page: currentPage,
				perPage: itemsPerPage,
				search: searchTerm,
			},
		})) as {
			items?: Article[];
			page?: number;
			pages?: number;
			total?: number;
			error?: string;
		};

		logger.debug("Received response from background:", response);

		if (response.error) {
			logger.error("Background script reported error:", response.error);
			throw new Error(response.error);
		}

		totalPages = response.pages || 1;
		currentPage = response.page || 1;
		await displayArticles(response.items || []);
	} catch (error) {
		logger.error("Runtime error:", error);
		throw new Error("Could not connect to the background service.");
	}
}
async function displayArticles(articles: Article[]): Promise<void> {
	logger.debug("Displaying articles:", articles);
	if (
		!prevButton ||
		!nextButton ||
		!pageInfo ||
		!pageSelect ||
		!articlesContainer ||
		!articleListContainer ||
		!emptyMessage ||
		!noResultsMessage
	)
		return;
	logger.debug(
		`Page ${currentPage} of ${totalPages}, showing ${articles.length} articles.`,
	);
	const searchTerm = searchInput?.value.toLowerCase().trim() || "";
	const hasArticles = articles.length > 0;
	const isSearching = searchTerm !== "";
	emptyMessage.style.display = !hasArticles && !isSearching ? "block" : "none";
	noResultsMessage.style.display =
		!hasArticles && isSearching ? "block" : "none";
	articlesContainer.style.display = hasArticles ? "block" : "none";
	const pagination = document.querySelector(".pagination") as HTMLElement;
	if (pagination) {
		pagination.style.display = hasArticles ? "flex" : "none";
	}
	prevButton.disabled = currentPage === 1;
	nextButton.disabled = currentPage === totalPages || totalPages === 0;
	pageInfo.textContent = `of ${totalPages}`;
	pageSelect.innerHTML = "";
	for (let i = 1; i <= totalPages; i++) {
		const option = document.createElement("option");
		option.value = String(i);
		option.textContent = String(i);
		if (i === currentPage) {
			option.selected = true;
		}
		pageSelect.appendChild(option);
	}
	articlesContainer.innerHTML = "";

	// Create all article elements immediately (favicon loading is now non-blocking)
	for (const article of articles) {
		logger.debug("Creating element for article:", article.title);
		const articleElement = createArticleElement(article);
		articlesContainer.appendChild(articleElement);
	}
}
function handleSearch(): void {
	currentPage = 1;
	void loadRecentArticles();
}
function changePage(offset: number): void {
	const newPage = currentPage + offset;
	if (newPage >= 1 && (totalPages === 0 || newPage <= totalPages)) {
		currentPage = newPage;
		void loadRecentArticles();
	}
}
function handlePageSelect(event: Event): void {
	const target = event.target as HTMLSelectElement;
	const newPage = Number.parseInt(target.value, 10);
	if (newPage >= 1 && newPage <= totalPages) {
		currentPage = newPage;
		void loadRecentArticles();
	}
}
function showError(message: string, showSettingsLink = false): void {
	if (!articlesContainer) return;
	let finalMessage = `<div class="error-message">${message}`;
	if (showSettingsLink) {
		finalMessage += ` <a href="#" id="open-settings-link">Check Settings</a>`;
	}
	finalMessage += "</div>";
	articlesContainer.innerHTML = finalMessage;
	if (showSettingsLink) {
		document
			.getElementById("open-settings-link")
			?.addEventListener("click", (e) => {
				e.preventDefault();
				browser.runtime.openOptionsPage();
			});
	}
}
function createArticleElement(article: Article): HTMLElement {
	logger.debug("Creating article element:", article);
	const articleElement = document.createElement("div");
	articleElement.className = "article";
	const contentWrapper = document.createElement("a");
	contentWrapper.className = "article-content";
	contentWrapper.href = article.url;
	contentWrapper.target = "_blank";
	contentWrapper.rel = "noopener noreferrer";
	const titleWrapper = document.createElement("div");
	titleWrapper.className = "article-title-wrapper";
	const favicon = document.createElement("img");
	favicon.className = "article-favicon";

	favicon.crossOrigin = "anonymous";
	favicon.loading = "lazy";

	// Try to get favicon immediately (cached or load)
	try {
		const url = new URL(article.url);
		
		// Check in-memory cache first (immediate access)
		if (faviconCache[url.hostname]) {
			// Use cached favicon immediately
			logger.debug("Using cached favicon for", url.hostname);
			favicon.src = faviconCache[url.hostname];
		} else {
			// Not cached, set default and try to load
			favicon.src = "icons/icon.svg";
			
			// Try to load favicon on-demand
			getCachedFavicon(url.hostname).then((faviconSrc) => {
				if (faviconSrc !== "icons/icon.svg") {
					logger.debug("Loaded favicon for", url.hostname);
					favicon.src = faviconSrc;
					// Update in-memory cache for next time
					faviconCache[url.hostname] = faviconSrc;
				}
			}).catch((error) => {
				logger.debug("Failed to load favicon for", url.hostname, error);
			});
		}

		// Add error handling for the image
		favicon.onerror = () => {
			logger.debug("Favicon failed to load for", url.hostname);
			favicon.src = "icons/icon.svg";
		};

		favicon.onload = () => {
			logger.debug("Favicon successfully loaded for", url.hostname);
		};
	} catch (_e) {
		logger.debug("Error getting favicon for", article.url, _e);
		favicon.src = "icons/icon.svg";
	}
	titleWrapper.appendChild(favicon);
	const titleElement = document.createElement("h3");
	titleElement.className = "article-title";
	titleElement.textContent = article.title;
	titleWrapper.appendChild(titleElement);
	contentWrapper.appendChild(titleWrapper);
	const urlElement = document.createElement("div");
	urlElement.className = "article-url";
	urlElement.textContent = article.url;
	contentWrapper.appendChild(urlElement);
	articleElement.appendChild(contentWrapper);
	const removeButton = document.createElement("button");
	removeButton.textContent = "×";
	removeButton.className = "delete-button";
	removeButton.addEventListener("click", () => {
		browser.runtime
			.sendMessage({
				type: "deleteArticle",
				payload: { articleId: article.id },
			})
			.then(() => {
				logger.debug("Article deleted, reloading list");
				void loadRecentArticles();
			})
			.catch((error) => {
				logger.error("Error deleting article:", error);
			});
	});
	articleElement.appendChild(removeButton);
	return articleElement;
}
async function updateSavePageButtonState(): Promise<void> {
	if (!savePageButton || !currentTab?.url) {
		if (savePageButton) savePageButton.style.display = "none";
		return;
	}
	browser.runtime
		.sendMessage({ type: "checkArticle", payload: { url: currentTab.url } })
		.then((response: Article | undefined) => {
			savedArticleForCurrentPage = response;
			if (savePageButton) {
				if (response) {
					savePageButton.textContent = "X";
					savePageButton.title = "Remove current page";
					savePageButton.classList.add("saved");
				} else {
					savePageButton.textContent = "+";
					savePageButton.title = "Save current page";
					savePageButton.classList.remove("saved");
				}
				savePageButton.style.display = "block";
			}
		})
		.catch((error) => {
			logger.error("Error checking article:", error);
		});
}
async function handleSavePageClick(): Promise<void> {
	if (!currentTab?.url) return;
	if (savedArticleForCurrentPage) {
		browser.runtime
			.sendMessage({
				type: "deleteArticle",
				payload: { articleId: savedArticleForCurrentPage.id },
			})
			.then(async () => {
				logger.debug("Article deleted, reloading list and button state");
				await updateSavePageButtonState();
				await loadRecentArticles();
			})
			.catch((error) => {
				logger.error("Error deleting article:", error);
			});
	} else {
		browser.runtime
			.sendMessage({
				type: "saveArticle",
				payload: { url: currentTab.url, title: currentTab.title || "" },
			})
			.then(async () => {
				logger.debug("Article saved, reloading list and button state");
				await updateSavePageButtonState();
				await loadRecentArticles();
			})
			.catch((error) => {
				logger.error("Error saving article:", error);
			});
	}
}
document.addEventListener("DOMContentLoaded", initializePopup);
