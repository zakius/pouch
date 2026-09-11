import { type FilterRule, matchesPattern, parseCompleteFilterList } from "./filter-list-parser";
import { logger } from "./logger";

let filterRules: FilterRule[] = [];
let isInitialized = false;

export function initializeWithFilterRules(rules: FilterRule[]): void {
  filterRules = rules;
  isInitialized = true;
}

export async function initializeWithRawFilterLists(
  filterLists: Array<{ name: string; content: string }>,
): Promise<void> {
  try {
    logger.info(`Initializing URL cleaning with ${filterLists.length} raw filter lists...`);

    const allRules: FilterRule[] = [];

    for (const list of filterLists) {
      if (list.content.trim()) {
        const parsed = parseCompleteFilterList(list.content);
        allRules.push(...parsed.rules);

        logger.info(
          `Loaded ${parsed.rules.length} rules from ${list.name} (${parsed.metadata.totalLines} lines)`,
        );
      }
    }

    initializeWithFilterRules(allRules);

    logger.info(`URL cleaning initialized with ${filterRules.length} total rules from raw content`);
  } catch (error) {
    logger.error("Failed to initialize URL cleaning with raw content:", error);
    filterRules = [];
    isInitialized = false;
  }
}

function applyFilterRules(urlString: string): string {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;

    const regularRules = filterRules.filter((rule) => !rule.isException);
    const exceptionRules = filterRules.filter((rule) => rule.isException);

    const applicableRegularRules = regularRules.filter((rule) => {
      if (rule.pattern.startsWith("?")) {
        const paramMatch = rule.pattern.match(/\?([^=]+)=([^$^]+)/);
        if (paramMatch) {
          const paramName = paramMatch[1];
          const paramValue = paramMatch[2];
          return url.searchParams.get(paramName) === paramValue;
        }
        return false;
      }
      return matchesPattern(hostname, rule.pattern, url.href);
    });

    const applicableExceptionRules = exceptionRules.filter((rule) => {
      if (rule.pattern.startsWith("?")) {
        const paramMatch = rule.pattern.match(/\?([^=]+)=([^$^]+)/);
        if (paramMatch) {
          const paramName = paramMatch[1];
          const paramValue = paramMatch[2];
          return url.searchParams.get(paramName) === paramValue;
        }
        return false;
      }
      return matchesPattern(hostname, rule.pattern, url.href);
    });

    if (applicableRegularRules.length === 0) {
      return urlString;
    }

    const paramsToRemove = new Set<string>();
    for (const rule of applicableRegularRules) {
      for (const param of rule.params) {
        paramsToRemove.add(param);
      }
    }

    for (const rule of applicableExceptionRules) {
      for (const param of rule.params) {
        paramsToRemove.delete(param);
      }
    }

    for (const param of paramsToRemove) {
      url.searchParams.delete(param);
    }

    if (url.searchParams.size === 0) {
      url.search = "";
    }

    return url.toString();
  } catch (error) {
    logger.error("Error applying filter rules:", error);
    return urlString;
  }
}

export async function cleanUrl(urlString: string): Promise<string> {
  try {
    if (!isInitialized) {
      throw new Error("URL cleaner not initialized");
    }

    if (filterRules.length > 0) {
      return applyFilterRules(urlString);
    } else {
      logger.warn("No filter rules loaded, returning original URL");
      return urlString;
    }
  } catch (error) {
    logger.error("Error in URL cleaning:", error);
    return urlString;
  }
}
