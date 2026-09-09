import type { Article } from "../types/common";
import { logger } from "../utils/logger";

const searchInput = document.getElementById("search") as HTMLInputElement | null;
const articlesContainer = document.getElementById("articles") as HTMLElement | null;
const prevButton = document.getElementById("prev-page") as HTMLButtonElement | null;
const nextButton = document.getElementById("next-page") as HTMLButtonElement | null;
const pageInfo = document.getElementById("page-info") as HTMLElement | null;
const pageSelect = document.getElementById("page-select") as HTMLSelectElement | null;
const savePageButton = document.getElementById("save-page-button") as HTMLButtonElement | null;
const articleListContainer = document.getElementById("article-list");
const emptyMessage = document.getElementById("empty-message");
const noResultsMessage = document.getElementById("no-results-message");
let currentTab: browser.tabs.Tab | undefined;
let savedArticleForCurrentPage: Article | undefined;
const itemsPerPage = 10;
let currentPage = 1;
let totalPages = 1;
let isLoadingArticles = false;
let isSavingOrDeleting = false;
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let latestRequestId = 0;
let pendingReload = false;
const searchDebounceMs = 300;
async function initializePopup(): Promise<void> {
  try {
    logger.debug("Initializing popup...");

    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    currentTab = tabs[0];
    if (!searchInput || !pageSelect) return;
    searchInput.addEventListener("input", handleSearch);
    pageSelect.addEventListener("change", handlePageSelect);
    document.body.addEventListener("click", handleBodyClick);
    await loadRecentArticles();
    await updateSavePageButtonState();
  } catch (error: unknown) {
    logger.error("Error initializing popup:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to initialize popup";
    showError(`Could not load articles. ${errorMessage}`, true);
  }
}
async function loadRecentArticles(): Promise<void> {
  if (isLoadingArticles) {
    pendingReload = true;
    return;
  }
  isLoadingArticles = true;
  const requestId = ++latestRequestId;
  try {
    const searchTerm = (searchInput?.value || "").trim().toLowerCase();
    logger.debug("Requesting recent articles from background script...");

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

    if (requestId !== latestRequestId) {
      logger.debug("Discarding stale articles response:", requestId);
      return;
    }

    logger.debug("Received response from background:", response);

    if (response.error) {
      logger.error("Background script reported error:", response.error);
      throw new Error(response.error);
    }

    const newTotalPages = response.pages ?? 0;
    const requestedPage = response.page ?? 1;

    if (newTotalPages > 0 && requestedPage > newTotalPages) {
      currentPage = newTotalPages;
      isLoadingArticles = false;
      await loadRecentArticles();
      return;
    }

    totalPages = newTotalPages || 1;
    currentPage = requestedPage;

    const responsePages = response.pages ?? 0;
    if ((response.items?.length ?? 0) === 0 && responsePages >= 1 && currentPage > responsePages) {
      currentPage = responsePages;
      isLoadingArticles = false;
      await loadRecentArticles();
      return;
    }
    await displayArticles(response.items || []);
  } catch (error) {
    logger.error("Runtime error:", error);
    showError("Could not connect to the background service.", false);
    throw new Error("Could not connect to the background service.");
  } finally {
    isLoadingArticles = false;
    if (pendingReload) {
      pendingReload = false;
      void loadRecentArticles();
    }
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
  ) {
    return;
  }
  logger.debug(`Page ${currentPage} of ${totalPages}, showing ${articles.length} articles.`);
  const searchValue = searchInput?.value || "";
  const searchTerm = searchValue.trim().toLowerCase();
  const hasArticles = articles.length > 0;
  const isSearching = searchTerm !== "";
  emptyMessage.style.display = !hasArticles && !isSearching ? "block" : "none";
  noResultsMessage.style.display = !hasArticles && isSearching ? "block" : "none";
  articlesContainer.style.display = hasArticles ? "block" : "none";
  const pagination = document.querySelector(".pagination") as HTMLElement;
  if (pagination) {
    pagination.style.display = totalPages > 1 ? "flex" : "none";
  }
  // If page is empty (not a search) and not the first page, step back
  if (!hasArticles && !isSearching && currentPage > 1) {
    currentPage = Math.min(currentPage - 1, Math.max(totalPages, 1));
    void loadRecentArticles();
    return;
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

  // Create all article elements
  for (const article of articles) {
    logger.debug("Creating element for article:", article.title);
    const articleElement = createArticleElement(article);
    articlesContainer.appendChild(articleElement);
  }
}
function handleSearch(): void {
  const searchValue = searchInput?.value || "";
  const trimmedSearch = searchValue.trim();
  if (trimmedSearch.length > 1000) {
    logger.warn("Search term too long, truncating");
    if (searchInput) {
      searchInput.value = trimmedSearch.substring(0, 1000);
    }
  }
  currentPage = 1;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    void loadRecentArticles();
  }, searchDebounceMs);
}
function handleBodyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (!target) return;

  const deleteButton = target.classList.contains("delete-button")
    ? (target as HTMLButtonElement)
    : (target.closest(".delete-button") as HTMLButtonElement | null);
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    void handleDeleteArticle(deleteButton);
    return;
  }

  if (target.id === "settings-button" || target.closest("#settings-button")) {
    event.preventDefault();
    void browser.runtime.openOptionsPage();
    return;
  }

  if (target.id === "save-page-button" || target.closest("#save-page-button")) {
    event.preventDefault();
    void handleSavePageClick();
    return;
  }

  if (target.id === "prev-page" || target.closest("#prev-page")) {
    event.preventDefault();
    const button = (
      target.id === "prev-page" ? target : target.closest("#prev-page")
    ) as HTMLButtonElement;
    if (button && !button.disabled) {
      changePage(-1);
    }
    return;
  }

  if (target.id === "next-page" || target.closest("#next-page")) {
    event.preventDefault();
    const button = (
      target.id === "next-page" ? target : target.closest("#next-page")
    ) as HTMLButtonElement;
    if (button && !button.disabled) {
      changePage(1);
    }
    return;
  }

  if (target.id === "open-settings-link" || target.classList.contains("settings-link")) {
    event.preventDefault();
    void browser.runtime.openOptionsPage();
    return;
  }
}

async function handleDeleteArticle(button: HTMLButtonElement): Promise<void> {
  if (isSavingOrDeleting) return;
  const articleIdStr = button.dataset.articleId;
  if (!articleIdStr) {
    logger.warn("Delete button missing article ID");
    return;
  }
  const articleId = Number.parseInt(articleIdStr, 10);
  if (Number.isNaN(articleId) || articleId < 0) {
    logger.warn("Invalid article ID:", articleIdStr);
    return;
  }
  isSavingOrDeleting = true;
  button.disabled = true;
  try {
    await browser.runtime.sendMessage({
      type: "deleteArticle",
      payload: { articleId },
    });
    logger.debug("Article deleted, reloading list");
    await loadRecentArticles();
  } catch (error) {
    logger.error("Error deleting article:", error);
    showError("Failed to delete article. Please try again.", false);
  } finally {
    isSavingOrDeleting = false;
    button.disabled = false;
  }
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
  if (!target) return;
  const pageValue = target.value;
  if (!pageValue || pageValue.trim() === "") return;
  const newPage = Number.parseInt(pageValue, 10);
  if (Number.isNaN(newPage) || newPage < 1 || newPage > totalPages) {
    logger.warn("Invalid page number selected:", newPage);
    return;
  }
  currentPage = newPage;
  void loadRecentArticles();
}
function showError(message: string, showSettingsLink = false): void {
  if (!articlesContainer || !articleListContainer) return;
  articlesContainer.innerHTML = "";
  const errorDiv = document.createElement("div");
  errorDiv.className = "error-message";
  const messageText = document.createTextNode(message);
  errorDiv.appendChild(messageText);
  if (showSettingsLink) {
    errorDiv.appendChild(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = "#";
    link.id = "open-settings-link";
    link.className = "settings-link";
    link.textContent = "Check Settings";
    errorDiv.appendChild(link);
  }
  articlesContainer.appendChild(errorDiv);
  if (emptyMessage) emptyMessage.style.display = "none";
  if (noResultsMessage) noResultsMessage.style.display = "none";
}
function createArticleElement(article: Article): HTMLElement {
  logger.debug("Creating article element:", article);
  if (!article.url || typeof article.url !== "string") {
    logger.warn("Invalid article URL:", article);
    throw new Error("Article URL is required and must be a string");
  }
  if (typeof article.id !== "number" || article.id < 0 || !Number.isInteger(article.id)) {
    logger.warn("Invalid article ID:", article);
    throw new Error("Article ID is required and must be a non-negative integer");
  }
  const articleElement = document.createElement("div");
  articleElement.className = "article";
  const contentWrapper = document.createElement("a");
  contentWrapper.className = "article-content";
  try {
    const urlObj = new URL(article.url);
    contentWrapper.href = urlObj.toString();
  } catch {
    logger.warn("Invalid URL format, using as-is:", article.url);
    contentWrapper.href = article.url;
  }
  contentWrapper.target = "_blank";
  contentWrapper.rel = "noopener noreferrer";
  const titleWrapper = document.createElement("div");
  titleWrapper.className = "article-title-wrapper";
  const titleElement = document.createElement("h3");
  titleElement.className = "article-title";
  titleElement.textContent = article.title || "";
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
  removeButton.title = "Delete article";
  removeButton.dataset.articleId = String(article.id);
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
  if (!currentTab?.url || !savePageButton || isSavingOrDeleting) return;
  const url = currentTab.url.trim();
  if (!url || url.length === 0) {
    logger.warn("Cannot save article: empty URL");
    return;
  }
  const title = (currentTab.title || "").trim();
  isSavingOrDeleting = true;
  savePageButton.disabled = true;
  try {
    if (savedArticleForCurrentPage) {
      if (typeof savedArticleForCurrentPage.id !== "number" || savedArticleForCurrentPage.id < 0) {
        logger.error("Invalid article ID:", savedArticleForCurrentPage.id);
        return;
      }
      await browser.runtime.sendMessage({
        type: "deleteArticle",
        payload: { articleId: savedArticleForCurrentPage.id },
      });
      logger.debug("Article deleted, reloading list and button state");
      await updateSavePageButtonState();
      await loadRecentArticles();
    } else {
      await browser.runtime.sendMessage({
        type: "saveArticle",
        payload: { url, title },
      });
      logger.debug("Article saved, reloading list and button state");
      await updateSavePageButtonState();
      await loadRecentArticles();
    }
  } catch (error) {
    logger.error("Error saving/deleting article:", error);
    const action = savedArticleForCurrentPage ? "delete" : "save";
    showError(`Failed to ${action} article. Please try again.`, false);
  } finally {
    isSavingOrDeleting = false;
    savePageButton.disabled = false;
  }
}
document.addEventListener("DOMContentLoaded", initializePopup);
