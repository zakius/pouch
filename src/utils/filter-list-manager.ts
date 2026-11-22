import * as v from "valibot";
import {
  assertStorageHealthy,
  setLocal,
  removeLocal,
  storageShutdownSignal,
} from "./fatal-storage";
/**
 * Filter List Manager
 *
 * Handles loading, caching, and refreshing of filter lists.
 * Separates content loading from URL cleaning logic.
 */

import { type FilterRule, parseCompleteFilterList } from "./filter-list-parser";
import { filterRuleCount, initializeWithFilterRules } from "./filter-list-url-cleaner";
import { logger } from "./logger";
import { clearCanonicalUrlCache, markUrlCanonizerInitialized } from "./url-helpers";

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

const cachedRulesSchema = v.array(
  v.object({
    pattern: v.string(),
    params: v.array(v.string()),
    domain: v.optional(v.string()),
    isRegex: v.optional(v.boolean()),
    isException: v.optional(v.boolean()),
    scope: v.optional(v.picklist(["domain", "url"])),
  }),
);
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const FILTER_LIST_FETCH_TIMEOUT_MS = 15_000;

export interface CachedFilterRulesState {
  freshRules: FilterRule[] | null;
  staleRules: FilterRule[] | null;
}

export type CacheHydrationStatus = "fresh" | "stale" | "missing";

export interface CacheHydrationResult {
  status: CacheHydrationStatus;
  rules: FilterRule[];
}

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
  assertStorageHealthy();
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
          return { name: "error", content: "" };
        }
      } catch (error) {
        logger.warn(`Failed to read local file ${url}:`, error);
        return { name: "error", content: "" };
      }
    }

    // raw.githubusercontent.com sends Access-Control-Allow-Origin: * and this
    // request is CORS-simple (plain GET, no custom headers), so the background
    // page fetch works without any host permission. ETag is not
    // CORS-exposed, so it reads back as null; cache expiry is the 24h TTL.
    const response = await fetch(url, {
      signal: AbortSignal.any([
        storageShutdownSignal(),
        AbortSignal.timeout(FILTER_LIST_FETCH_TIMEOUT_MS),
      ]),
    });
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
    assertStorageHealthy();
    logger.warn(`Failed to load filter list from ${url}:`, error);
    return { name: "error", content: "" };
  }
}

export async function readCachedFilterLists(): Promise<CachedFilterRulesState> {
  assertStorageHealthy();
  try {
    const result = await browser.storage.local.get([
      CACHE_KEY,
      `${CACHE_KEY}_version`,
      CACHE_EXPIRY_KEY,
    ]);
    assertStorageHealthy();
    const cachedRules = v.safeParse(cachedRulesSchema, result[CACHE_KEY]);
    const cachedVersion: unknown = result[`${CACHE_KEY}_version`];
    const storedExpiry: unknown = result[CACHE_EXPIRY_KEY];
    const cacheExpiry = typeof storedExpiry === "number" ? storedExpiry : undefined;

    if (cachedRules.success && cachedVersion === CACHE_VERSION && cachedRules.output.length > 0) {
      if (cacheExpiry !== undefined && Date.now() < cacheExpiry) {
        logger.info(`Loaded ${cachedRules.output.length} cached URL cleaning rules`);
        return { freshRules: cachedRules.output, staleRules: null };
      }

      logger.info(
        `Loaded ${cachedRules.output.length} expired cached URL cleaning rules; will refresh filter lists`,
      );
      return { freshRules: null, staleRules: cachedRules.output };
    }

    if (cacheExpiry !== undefined && Date.now() >= cacheExpiry) {
      logger.info("Cache expired, will refresh filter lists");
    }

    return { freshRules: null, staleRules: null };
  } catch (error) {
    assertStorageHealthy();
    logger.warn("Failed to load cached rules:", error);
    return { freshRules: null, staleRules: null };
  }
}

export async function loadCachedFilterLists(): Promise<FilterRule[] | null> {
  const { freshRules } = await readCachedFilterLists();
  return freshRules;
}

export async function saveCachedFilterLists(
  rules: FilterRule[],
  filterListVersions?: Record<string, string>,
): Promise<void> {
  try {
    const cacheExpiry = Date.now() + CACHE_DURATION_MS;
    await setLocal("persist filter cache", {
      [CACHE_KEY]: rules,
      [`${CACHE_KEY}_version`]: CACHE_VERSION,
      [CACHE_EXPIRY_KEY]: cacheExpiry,
      [`${CACHE_KEY}_filter_versions`]: filterListVersions || {},
    });
    logger.info(`Cached ${rules.length} URL cleaning rules (expires in 24h)`);
  } catch (error) {
    assertStorageHealthy();
    logger.warn("Failed to cache rules:", error);
  }
}

export async function clearFilterListCache(): Promise<void> {
  try {
    await removeLocal("clear filter cache", [
      CACHE_KEY,
      `${CACHE_KEY}_version`,
      CACHE_EXPIRY_KEY,
      `${CACHE_KEY}_filter_versions`,
    ]);
    logger.info("Cleared filter list cache");
  } catch (error) {
    assertStorageHealthy();
    logger.warn("Failed to clear cache:", error);
  }
}

export async function loadFilterLists(): Promise<{
  rules: FilterRule[];
  results: FilterListResult[];
  versions: Record<string, string>;
  allSucceeded: boolean;
}> {
  assertStorageHealthy();
  const sources = [...filterListSources];

  const settled = await Promise.all(
    sources.map(async (source) => {
      assertStorageHealthy();
      try {
        const content = await loadFilterListContent(source.url);
        if (content.name !== "error" && content.content.trim().length > 0) {
          const parsed = parseCompleteFilterList(content.content);
          const version = parsed.metadata.lastModified || parsed.metadata.version || "unknown";

          logger.info(
            `Loaded ${parsed.metadata.ruleCount} URL cleaning rules from ${parsed.metadata.totalLines} total lines in filter list: ${source.name} (${version})`,
          );

          return {
            ok: true as const,
            source,
            rules: parsed.rules,
            version,
            metadata: parsed.metadata,
          };
        }
        return { ok: false as const, source };
      } catch (error) {
        assertStorageHealthy();
        logger.warn(`Failed to load filter list ${source.name}:`, error);
        return { ok: false as const, source };
      }
    }),
  );

  assertStorageHealthy();

  const allRules: FilterRule[] = [];
  const results: FilterListResult[] = [];
  const versions: Record<string, string> = {};
  let allSucceeded = sources.length > 0;

  for (const entry of settled) {
    if (entry.ok) {
      allRules.push(...entry.rules);
      versions[entry.source.name] = entry.version;
      results.push({
        name: entry.source.name,
        rules: entry.rules,
        metadata: entry.metadata,
      });
    } else {
      allSucceeded = false;
    }
  }

  return { rules: allRules, results, versions, allSucceeded };
}

export function initializeFilterListManager(): void {
  if (filterListSources.length === 0) {
    resetFilterListSources();
  }
}

export async function hydrateFilterRulesFromCache(): Promise<CacheHydrationResult> {
  assertStorageHealthy();
  initializeFilterListManager();

  const { freshRules, staleRules } = await readCachedFilterLists();
  assertStorageHealthy();

  if (freshRules && freshRules.length > 0) {
    initializeWithFilterRules(freshRules);
    markUrlCanonizerInitialized();
    logger.info(`Initialized URL cleaner with ${freshRules.length} cached filter rules`);
    return { status: "fresh", rules: freshRules };
  }

  if (staleRules && staleRules.length > 0) {
    initializeWithFilterRules(staleRules);
    markUrlCanonizerInitialized();
    logger.info(
      `Initialized URL cleaner with ${staleRules.length} stale cached filter rules pending remote refresh`,
    );
    return { status: "stale", rules: staleRules };
  }

  return { status: "missing", rules: [] };
}

export async function fetchAndApplyRemoteFilterLists(): Promise<{
  applied: boolean;
  allSucceeded: boolean;
  ruleCount: number;
}> {
  assertStorageHealthy();
  initializeFilterListManager();

  logger.info("Loading filter lists from remote sources...");
  const { rules, versions, allSucceeded } = await loadFilterLists();
  assertStorageHealthy();

  if (allSucceeded && rules.length > 0) {
    await saveCachedFilterLists(rules, versions);
    assertStorageHealthy();
    initializeWithFilterRules(rules);
    markUrlCanonizerInitialized();
    clearCanonicalUrlCache();
    return { applied: true, allSucceeded: true, ruleCount: rules.length };
  }

  if (!allSucceeded) {
    logger.warn(
      "Failed to load all remote filter lists; keeping existing cached and in-memory rules",
    );
  } else if (filterRuleCount() === 0) {
    initializeWithFilterRules([]);
  } else {
    logger.warn("Remote filter lists returned zero rules; keeping existing filter rules");
  }

  return { applied: false, allSucceeded, ruleCount: rules.length };
}

export async function refreshFilterLists(): Promise<void> {
  assertStorageHealthy();
  logger.info("Refreshing filter lists...");
  await fetchAndApplyRemoteFilterLists();
}

export async function initializeUrlCleanerWithRemoteLists(): Promise<void> {
  assertStorageHealthy();
  const hydration = await hydrateFilterRulesFromCache();
  if (hydration.status === "fresh") {
    return;
  }

  await fetchAndApplyRemoteFilterLists();
}
