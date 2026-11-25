import {
  type FilterRule,
  type ParamRegexSpec,
  matchesPattern,
  parseCompleteFilterList,
} from "./filter-list-parser";
import { logger } from "./logger";

let filterRules: FilterRule[] = [];
let regularFilterRules: FilterRule[] = [];
let exceptionFilterRules: FilterRule[] = [];
let rulesGeneration = 0;
let isInitialized = false;
const compiledRegexCache = new Map<string, RegExp | null>();

function compileParamRegex(spec: ParamRegexSpec): RegExp | null {
  const key = `${spec.flags}\0${spec.pattern}`;
  if (compiledRegexCache.has(key)) {
    return compiledRegexCache.get(key) ?? null;
  }
  let compiled: RegExp | null = null;
  if (spec.flags === "" || spec.flags === "i") {
    try {
      compiled = new RegExp(spec.pattern, spec.flags);
    } catch {
      compiled = null;
    }
  }
  compiledRegexCache.set(key, compiled);
  return compiled;
}

export function filterRuleCount(): number {
  return filterRules.length;
}

export function filterRulesGeneration(): number {
  return rulesGeneration;
}

export function initializeWithFilterRules(rules: FilterRule[]): void {
  filterRules = rules;
  regularFilterRules = rules.filter((rule) => !rule.isException);
  exceptionFilterRules = rules.filter((rule) => rule.isException);
  compiledRegexCache.clear();
  rulesGeneration++;
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
    regularFilterRules = [];
    exceptionFilterRules = [];
    rulesGeneration++;
    isInitialized = false;
  }
}

function applyFilterRules(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (!url.search) {
      return urlString;
    }

    const hostname = url.hostname;

    const applicableRegularRules = regularFilterRules.filter((rule) => {
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

    const applicableExceptionRules = exceptionFilterRules.filter((rule) => {
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

    const paramsToRemove = new Set<string>();
    const regexesToRemove: RegExp[] = [];
    for (const rule of applicableRegularRules) {
      for (const param of rule.params) {
        paramsToRemove.add(param);
      }
      if (rule.paramRegexes) {
        for (const spec of rule.paramRegexes) {
          const compiled = compileParamRegex(spec);
          if (compiled) {
            regexesToRemove.push(compiled);
          }
        }
      }
    }

    const exceptionParams = new Set<string>();
    const exceptionRegexes: RegExp[] = [];
    for (const rule of applicableExceptionRules) {
      for (const param of rule.params) {
        exceptionParams.add(param);
      }
      if (rule.paramRegexes) {
        for (const spec of rule.paramRegexes) {
          const compiled = compileParamRegex(spec);
          if (compiled) {
            exceptionRegexes.push(compiled);
          }
        }
      }
    }

    if (paramsToRemove.size === 0 && regexesToRemove.length === 0) {
      return urlString;
    }

    // Filter the raw pairs: searchParams would re-encode kept ones (%20 -> +, flag -> flag=).
    const kept = url.search
      .slice(1)
      .split("&")
      .filter((pair) => {
        const entry = new URLSearchParams(pair).entries().next().value;
        if (entry === undefined) {
          return true;
        }
        const [name, value] = entry;
        const pairForRegex = pair.includes("=") ? `${name}=${value}` : name;

        const matchesRegular =
          paramsToRemove.has(name) || regexesToRemove.some((regex) => regex.test(pairForRegex));
        if (!matchesRegular) {
          return true;
        }

        return (
          exceptionParams.has(name) || exceptionRegexes.some((regex) => regex.test(pairForRegex))
        );
      });
    url.search = kept.join("&");

    return url.toString();
  } catch (error) {
    logger.error("Error applying filter rules:", error);
    return urlString;
  }
}

export async function cleanUrl(urlString: string): Promise<string> {
  try {
    if (!isInitialized) {
      return urlString;
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
