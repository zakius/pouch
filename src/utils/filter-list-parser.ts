/**
 * Filter List Parser Library
 *
 * A reusable library for parsing ABP-style filter lists and extracting
 * $removeparam rules and metadata from headers.
 */

export interface FilterListMetadata {
  lastModified?: string;
  version?: string;
  expires?: number; // Unix timestamp
  totalLines: number;
  ruleCount: number;
}

export interface ParamRegexSpec {
  pattern: string;
  flags: string;
}

export interface FilterRule {
  pattern: string;
  params: string[];
  paramRegexes?: ParamRegexSpec[];
  domain?: string;
  isRegex?: boolean;
  isException?: boolean; // @@ prefix indicates exception rule
  scope?: "domain" | "url"; // "url" rules include a path and must match the full URL
}

// Modifiers that do not narrow applicability for top-level document navigation URLs.
// All other modifiers (domain=, third-party, image, xhr, ~document, badfilter, ...)
// restrict scope or request type and cause the rule to be skipped rather than broadened.
const SAFE_DOCUMENT_MODIFIERS = new Set(["doc", "document", "important", "all"]);

function findClosingRegexSlash(input: string, openSlashIndex: number): number {
  let inCharClass = false;
  for (let i = openSlashIndex + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\") {
      if (i + 1 >= input.length) {
        return -1;
      }
      i++;
      continue;
    }
    if (ch === "[" && !inCharClass) {
      inCharClass = true;
    } else if (ch === "]" && inCharClass) {
      inCharClass = false;
    } else if (ch === "/" && !inCharClass) {
      return i;
    }
  }
  return -1;
}

function splitFilterOptions(optionsPart: string): string[] | null {
  const options: string[] = [];
  let current = "";

  for (let i = 0; i < optionsPart.length; i++) {
    const ch = optionsPart[i];
    if (ch === ",") {
      options.push(current.trim());
      current = "";
      continue;
    }

    current += ch;

    // Keep commas inside removeparam=/regex/[flags] (or ~/regex/) intact.
    if (ch === "/") {
      const normalized = current.trimStart().toLowerCase();
      if (normalized === "removeparam=/" || normalized === "removeparam=~/") {
        const closingSlash = findClosingRegexSlash(optionsPart, i);
        if (closingSlash === -1) {
          return null;
        }
        current += optionsPart.slice(i + 1, closingSlash + 1);
        i = closingSlash;
      }
    }
  }

  options.push(current.trim());
  return options;
}

function parseRemoveParamValue(
  rawValue: string,
): { kind: "literal"; param: string } | { kind: "regex"; regex: ParamRegexSpec } | null {
  if (!rawValue || rawValue.startsWith("~")) {
    return null;
  }

  if (rawValue.startsWith("/")) {
    const closingSlash = findClosingRegexSlash(rawValue, 0);
    if (closingSlash <= 1) {
      return null;
    }
    const pattern = rawValue.slice(1, closingSlash);
    const flags = rawValue.slice(closingSlash + 1);
    // Only allow stateless flags (none or case-insensitive `i`).
    if (flags !== "" && flags !== "i") {
      return null;
    }
    try {
      new RegExp(pattern, flags);
    } catch {
      return null;
    }
    return { kind: "regex", regex: { pattern, flags } };
  }

  if (rawValue.includes("=") || rawValue.includes("$") || rawValue.includes("/")) {
    return null;
  }

  return { kind: "literal", param: rawValue };
}

// Convert an ABP-style wildcard pattern to a regex source:
// literal characters are escaped first, then * expands to .* and ^ to a URL separator.
function wildcardToRegexSource(pattern: string): string {
  let source = "";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "^") {
      source += "(?:[/?#]|$)";
    } else if (/[.*+?^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return source;
}

function testWildcardPattern(pattern: string, candidate: string, anchorEnd = true): boolean {
  try {
    let body = pattern;
    let shouldAnchorEnd = anchorEnd;
    if (!anchorEnd && (body.endsWith("$") || body.endsWith("|"))) {
      body = body.slice(0, -1);
      shouldAnchorEnd = true;
    }
    return new RegExp(`^${wildcardToRegexSource(body)}${shouldAnchorEnd ? "$" : ""}`).test(
      candidate,
    );
  } catch {
    return false;
  }
}

export interface ParsedFilterList {
  rules: FilterRule[];
  metadata: FilterListMetadata;
}

function parseExpiresValue(expiresStr: string): number | undefined {
  const trimmed = expiresStr.trim().toLowerCase();

  const now = Date.now();

  const dayMatch = trimmed.match(/^(\d+)\s*days?$/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    return now + days * 24 * 60 * 60 * 1000;
  }

  const weekMatch = trimmed.match(/^(\d+)\s*weeks?$/);
  if (weekMatch) {
    const weeks = parseInt(weekMatch[1], 10);
    return now + weeks * 7 * 24 * 60 * 60 * 1000;
  }

  const monthMatch = trimmed.match(/^(\d+)\s*months?$/);
  if (monthMatch) {
    const months = parseInt(monthMatch[1], 10);
    const date = new Date(now);
    date.setMonth(date.getMonth() + months);
    return date.getTime();
  }

  const hourMatch = trimmed.match(/^(\d+)\s*hours?$/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1], 10);
    return now + hours * 60 * 60 * 1000;
  }

  const parsedDate = new Date(expiresStr);
  if (!Number.isNaN(parsedDate.getTime())) {
    return parsedDate.getTime();
  }

  return undefined;
}

export function parseFilterList(raw: string): {
  rules: FilterRule[];
  metadata: {
    lastModified?: string;
    version?: string;
    expires?: number;
  };
} {
  const ruleMap = new Map<string, FilterRule>();
  const lines = raw.split("\n");
  const metadata: {
    lastModified?: string;
    version?: string;
    expires?: number;
  } = {};

  let firstNonCommentLineFound = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!firstNonCommentLineFound && trimmed.startsWith("!")) {
      if (trimmed.startsWith("! Last modified:")) {
        metadata.lastModified = trimmed.replace("! Last modified:", "").trim();
      } else if (trimmed.startsWith("! Version:")) {
        metadata.version = trimmed.replace("! Version:", "").trim();
      } else if (trimmed.startsWith("! Updated:")) {
        metadata.lastModified = trimmed.replace("! Updated:", "").trim();
      } else if (trimmed.startsWith("! Expires:")) {
        const expiresStr = trimmed.replace("! Expires:", "").trim();
        const expiresTimestamp = parseExpiresValue(expiresStr);
        if (expiresTimestamp !== undefined) {
          metadata.expires = expiresTimestamp;
        }
      }
      continue;
    }

    if (
      !firstNonCommentLineFound &&
      trimmed &&
      !trimmed.startsWith("!") &&
      !trimmed.startsWith("#")
    ) {
      firstNonCommentLineFound = true;
    }

    if (
      !trimmed ||
      trimmed.startsWith("!") ||
      trimmed.startsWith("#") ||
      !trimmed.toLowerCase().includes("removeparam=")
    ) {
      continue;
    }

    const isException = trimmed.startsWith("@@");
    const ruleText = isException ? trimmed.substring(2) : trimmed;

    // Regex URL patterns (e.g. /^https?:\/\/...$/$removeparam=...) are not supported.
    if (ruleText.startsWith("/")) {
      continue;
    }

    const dollarIndex = ruleText.indexOf("$");
    if (dollarIndex === -1) {
      continue;
    }

    const patternPart = ruleText.substring(0, dollarIndex);
    const optionsPart = ruleText.substring(dollarIndex + 1);

    const options = splitFilterOptions(optionsPart);
    if (!options) {
      continue;
    }

    let removeParamRawValue: string | undefined;
    let hasUnsupportedOption = false;

    for (const option of options) {
      if (!option) {
        hasUnsupportedOption = true;
        break;
      }
      if (option.toLowerCase().startsWith("removeparam=")) {
        if (removeParamRawValue !== undefined) {
          hasUnsupportedOption = true;
          break;
        }
        removeParamRawValue = option.slice("removeparam=".length);
      } else if (!SAFE_DOCUMENT_MODIFIERS.has(option.toLowerCase())) {
        // Scope-modifying or non-document options (domain=, third-party, image, xhr, ...)
        // are not supported. Skip the whole rule rather than broadening its scope.
        hasUnsupportedOption = true;
        break;
      }
    }

    if (hasUnsupportedOption || removeParamRawValue === undefined) {
      continue;
    }

    const parsedParam = parseRemoveParamValue(removeParamRawValue);
    if (!parsedParam) {
      continue;
    }

    let pattern: string;
    let domain: string | undefined;
    let isRegex = false;
    let scope: "domain" | "url" = "domain";

    if (!patternPart || patternPart.trim() === "") {
      pattern = "*";
    } else if (patternPart.startsWith("||")) {
      pattern = patternPart;
      const rest = patternPart.substring(2);
      const separatorIndex = rest.search(/[\^/]/);
      if (separatorIndex === -1) {
        domain = rest;
      } else {
        domain = rest.substring(0, separatorIndex);
        if (rest.substring(separatorIndex).replace(/^\^/, "").length > 0) {
          scope = "url";
        }
      }
    } else if (patternPart.startsWith("|") && patternPart.endsWith("|")) {
      pattern = patternPart;
      domain = patternPart.substring(1, patternPart.length - 1);
    } else if (patternPart.includes("://")) {
      pattern = patternPart;
      isRegex = true;
      const domainMatch = patternPart.match(/:\/\/([^/?*]+)/);
      if (domainMatch) {
        domain = domainMatch[1];
        const pathPart = patternPart.substring(
          patternPart.indexOf(domainMatch[1]) + domainMatch[1].length,
        );
        if (pathPart && pathPart !== "/") {
          scope = "url";
        }
      }
    } else if (patternPart.startsWith("?") && patternPart.includes("^")) {
      pattern = patternPart;
      isRegex = true;
      const paramMatch = patternPart.match(/\?([^=]+)=/);
      if (paramMatch) {
        domain = undefined;
      }
    } else if (
      !patternPart.includes("*") &&
      !patternPart.includes("^") &&
      !patternPart.includes("|") &&
      !patternPart.includes("://") &&
      !patternPart.startsWith("?")
    ) {
      pattern = patternPart;
      domain = patternPart;
    } else if (patternPart.includes("*")) {
      pattern = patternPart;
      isRegex = true;
      const domainMatch = patternPart.match(/([a-zA-Z0-9.-]+)/);
      if (domainMatch) {
        domain = domainMatch[1];
      }
    } else {
      pattern = patternPart;
      domain = patternPart;
    }

    const ruleKey = `${isException ? "@@" : ""}${pattern}`;
    const existingRule = ruleMap.get(ruleKey);
    if (existingRule) {
      if (parsedParam.kind === "literal") {
        if (!existingRule.params.includes(parsedParam.param)) {
          existingRule.params.push(parsedParam.param);
        }
      } else {
        existingRule.paramRegexes ??= [];
        const duplicate = existingRule.paramRegexes.some(
          (entry) =>
            entry.pattern === parsedParam.regex.pattern && entry.flags === parsedParam.regex.flags,
        );
        if (!duplicate) {
          existingRule.paramRegexes.push(parsedParam.regex);
        }
      }
    } else {
      const newRule: FilterRule = {
        pattern,
        params: parsedParam.kind === "literal" ? [parsedParam.param] : [],
        domain,
        isRegex,
        isException,
        scope,
      };
      if (parsedParam.kind === "regex") {
        newRule.paramRegexes = [parsedParam.regex];
      }
      ruleMap.set(ruleKey, newRule);
    }
  }

  return {
    rules: Array.from(ruleMap.values()),
    metadata,
  };
}

export function parseCompleteFilterList(content: string): ParsedFilterList {
  const { rules, metadata } = parseFilterList(content);
  const totalLines = content.split("\n").length;

  return {
    rules,
    metadata: {
      ...metadata,
      totalLines,
      ruleCount: rules.length,
    },
  };
}

export function matchesPattern(hostname: string, pattern: string, fullUrl?: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.startsWith("||")) {
    const rest = pattern.substring(2);
    const separatorIndex = rest.search(/[\^/]/);
    const domain = separatorIndex === -1 ? rest : rest.substring(0, separatorIndex);
    const tail = separatorIndex === -1 ? "" : rest.substring(separatorIndex);

    const hostMatches = domain.includes("*")
      ? testWildcardPattern(domain, hostname)
      : hostname === domain || hostname.endsWith(`.${domain}`);
    if (!hostMatches) {
      return false;
    }
    if (!tail || tail === "^") {
      return true;
    }
    if (fullUrl === undefined) {
      return false;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(fullUrl);
    } catch {
      return false;
    }
    const candidate = tail.includes("?")
      ? `${parsedUrl.pathname}${parsedUrl.search}`
      : parsedUrl.pathname;
    return testWildcardPattern(tail, candidate, false);
  }
  if (pattern.startsWith("|") && pattern.endsWith("|")) {
    const domain = pattern.substring(1, pattern.length - 1);
    return hostname === domain;
  }

  if (pattern.includes("://")) {
    const domainMatch = pattern.match(/:\/\/([^/?*]+)/);
    if (!domainMatch) {
      return false;
    }
    const domain = domainMatch[1];
    const hostMatches = hostname === domain || hostname.endsWith(`.${domain}`);
    if (!hostMatches) {
      return false;
    }
    const pathPart = pattern.substring(pattern.indexOf(domain) + domain.length);
    if (!pathPart || pathPart === "/" || pathPart === "/*") {
      return true;
    }
    return fullUrl !== undefined && testWildcardPattern(pattern, fullUrl, false);
  }

  if (pattern.startsWith("?")) {
    return true;
  }

  if (
    !pattern.includes("*") &&
    !pattern.includes("^") &&
    !pattern.includes("|") &&
    !pattern.includes("://")
  ) {
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  }

  return testWildcardPattern(pattern, hostname);
}
