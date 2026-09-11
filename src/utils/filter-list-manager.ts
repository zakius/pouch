/**
 * Filter List Manager
 *
 * Handles loading, caching, and refreshing of filter lists.
 * Separates content loading from URL cleaning logic.
 */

import { type FilterRule, parseCompleteFilterList } from "./filter-list-parser";
import { initializeWithFilterRules } from "./filter-list-url-cleaner";
import { logger } from "./logger";

export interface FilterListSource {
  name: string;
  url: string;
}

export interface FilterListContent {
  name: string;
  content: string;
  lastModified?: string;
  etag?: string;
}

export interface FilterListResult {
  name: string;
  rules: FilterRule[];
  metadata: {
    lastModified?: string;
    version?: string;
    totalLines: number;
    ruleCount: number;
  };
}

const CACHE_KEY = "filter_list_url_cleaning_rules";
const CACHE_VERSION = "1.1";
const CACHE_EXPIRY_KEY = "filter_list_cache_expiry";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

let filterListSources: FilterListSource[] = [];

export function setFilterListSources(sources: FilterListSource[]): void {
  filterListSources = sources;
}

export function getFilterListSources(): FilterListSource[] {
  return [...filterListSources];
}

export function resetFilterListSources(): void {
  filterListSources = [
    {
      name: "LegitimateURLShortener",
      url: "https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt",
    },
    {
      name: "AdGuard",
      url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt",
    },
  ];
}

export async function loadFilterListContent(url: string): Promise<FilterListContent> {
  try {
    if (url.startsWith("data:")) {
      const base64Match = url.match(/^data:text\/plain;base64,(.+)$/);
      if (base64Match) {
        const content = atob(base64Match[1]);
        return {
          name: "data-url",
          content,
          lastModified: undefined,
          etag: undefined,
        };
      }
    }

    if (url.startsWith("file://")) {
      try {
        if (process?.versions?.node) {
          const fs = await import("node:fs/promises");

          const filePath = url.replace("file://", "");
          const content = await fs.readFile(filePath, "utf-8");

          return {
            name: "file-url",
            content,
            lastModified: undefined,
            etag: undefined,
          };
        } else {
          logger.warn(`File URLs not supported in browser environment: ${url}`);
          return { name: "file-url", content: "" };
        }
      } catch (error) {
        logger.warn(`Failed to read local file ${url}:`, error);
        return { name: "file-url", content: "" };
      }
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch filter list: ${response.status}`);
    }

    return {
      name: "http-url",
      content: await response.text(),
      lastModified: response.headers.get("last-modified") || undefined,
      etag: response.headers.get("etag") || undefined,
    };
  } catch (error) {
    logger.warn(`Failed to load filter list from ${url}:`, error);
    return { name: "error", content: "" };
  }
}

export async function loadCachedFilterLists(): Promise<FilterRule[] | null> {
  try {
    const result = await browser.storage.local.get([
      CACHE_KEY,
      `${CACHE_KEY}_version`,
      CACHE_EXPIRY_KEY,
    ]);
    const cachedRules = result[CACHE_KEY];
    const cachedVersion = result[`${CACHE_KEY}_version`];
    const cacheExpiry = result[CACHE_EXPIRY_KEY];

    if (cachedRules && cachedVersion === CACHE_VERSION && cacheExpiry && Date.now() < cacheExpiry) {
      logger.info(`Loaded ${cachedRules.length} cached URL cleaning rules`);
      return cachedRules;
    }

    if (cacheExpiry && Date.now() >= cacheExpiry) {
      logger.info("Cache expired, will refresh filter lists");
    }

    return null;
  } catch (error) {
    logger.warn("Failed to load cached rules:", error);
    return null;
  }
}

export async function saveCachedFilterLists(
  rules: FilterRule[],
  filterListVersions?: Record<string, string>,
): Promise<void> {
  try {
    const cacheExpiry = Date.now() + CACHE_DURATION_MS;
    await browser.storage.local.set({
      [CACHE_KEY]: rules,
      [`${CACHE_KEY}_version`]: CACHE_VERSION,
      [CACHE_EXPIRY_KEY]: cacheExpiry,
      [`${CACHE_KEY}_filter_versions`]: filterListVersions || {},
    });
    logger.info(`Cached ${rules.length} URL cleaning rules (expires in 24h)`);
  } catch (error) {
    logger.warn("Failed to cache rules:", error);
  }
}

export async function clearFilterListCache(): Promise<void> {
  try {
    await browser.storage.local.remove([
      CACHE_KEY,
      `${CACHE_KEY}_version`,
      CACHE_EXPIRY_KEY,
      `${CACHE_KEY}_filter_versions`,
    ]);
    logger.info("Cleared filter list cache");
  } catch (error) {
    logger.warn("Failed to clear cache:", error);
  }
}

export async function loadFilterLists(): Promise<{
  rules: FilterRule[];
  results: FilterListResult[];
  versions: Record<string, string>;
}> {
  const allRules: FilterRule[] = [];
  const results: FilterListResult[] = [];
  const versions: Record<string, string> = {};

  for (const source of filterListSources) {
    try {
      const content = await loadFilterListContent(source.url);
      if (content.content) {
        const parsed = parseCompleteFilterList(content.content);
        allRules.push(...parsed.rules);

        const version = parsed.metadata.lastModified || parsed.metadata.version || "unknown";
        versions[source.name] = version;

        results.push({
          name: source.name,
          rules: parsed.rules,
          metadata: parsed.metadata,
        });

        logger.info(
          `Loaded ${parsed.metadata.ruleCount} URL cleaning rules from ${parsed.metadata.totalLines} total lines in filter list: ${source.name} (${version})`,
        );
      }
    } catch (error) {
      logger.warn(`Failed to load filter list ${source.name}:`, error);
    }
  }

  return { rules: allRules, results, versions };
}

export function initializeFilterListManager(): void {
  if (filterListSources.length === 0) {
    resetFilterListSources();
  }
}

export async function refreshFilterLists(): Promise<void> {
  logger.info("Refreshing filter lists...");
  await clearFilterListCache();
  await initializeUrlCleanerWithRemoteLists();
}

export async function initializeUrlCleanerWithRemoteLists(): Promise<void> {
  initializeFilterListManager();

  const cachedRules = await loadCachedFilterLists();
  if (cachedRules && cachedRules.length > 0) {
    initializeWithFilterRules(cachedRules);
    logger.info(`Initialized URL cleaner with ${cachedRules.length} cached filter rules`);
    return;
  }

  logger.info("No valid cache found, loading filter lists from remote sources...");
  const { rules, versions } = await loadFilterLists();

  if (rules.length > 0) {
    await saveCachedFilterLists(rules, versions);
  }

  initializeWithFilterRules(rules);
}
