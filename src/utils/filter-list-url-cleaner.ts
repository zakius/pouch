import { logger } from "./logger";

let filterRules: FilterRule[] = [];
let isInitialized = false;
const CACHE_KEY = "filter_list_url_cleaning_rules";
const CACHE_VERSION = "1.0";
const CACHE_EXPIRY_KEY = "filter_list_cache_expiry";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Default filter lists for URL cleaning and tracking parameter removal
const DEFAULT_FILTER_LISTS = [
	{
		name: "LegitimateURLShortener",
		url: "https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt",
	},
	{
		name: "AdGuard",
		url: "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt",
	},
];

// Injectable filter lists (can be overridden for testing)
let filterLists = DEFAULT_FILTER_LISTS;

interface FilterListInfo {
	lastModified?: string;
	etag?: string;
	content: string;
}

async function loadFilterList(url: string): Promise<FilterListInfo> {
	try {
		// Handle different URL schemes
		if (url.startsWith("data:")) {
			// Data URL - decode base64 content
			const base64Match = url.match(/^data:text\/plain;base64,(.+)$/);
			if (base64Match) {
				const content = atob(base64Match[1]);
				return {
					content,
					lastModified: undefined,
					etag: undefined,
				};
			}
		}
		
		if (url.startsWith("file://")) {
			// File URL - try to read local file (works in Node.js/test environments)
			try {
				// Check if we're in a Node.js environment (test runner)
				if (typeof process !== 'undefined' && process.versions?.node) {
					const fs = await import('fs/promises');
					const path = await import('path');
					
					// Convert file:// URL to local path
					const filePath = url.replace('file://', '');
					const content = await fs.readFile(filePath, 'utf-8');
					
					return {
						content,
						lastModified: undefined,
						etag: undefined,
					};
				} else {
					// Browser environment - not supported
					logger.warn(`File URLs not supported in browser environment: ${url}`);
					return { content: "" };
				}
			} catch (error) {
				logger.warn(`Failed to read local file ${url}:`, error);
				return { content: "" };
			}
		}
		
		// HTTP/HTTPS URLs - use fetch
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch filter list: ${response.status}`);
		}

		return {
			lastModified: response.headers.get("last-modified") || undefined,
			etag: response.headers.get("etag") || undefined,
			content: await response.text(),
		};
	} catch (error) {
		logger.warn(`Failed to load filter list from ${url}:`, error);
		return { content: "" };
	}
}

function parseFilterListHeaders(content: string): {
	lastModified?: string;
	version?: string;
} {
	const lines = content.split("\n");
	const headers: { lastModified?: string; version?: string } = {};

	for (const line of lines.slice(0, 20)) {
		// Check first 20 lines for headers
		const trimmed = line.trim();
		if (trimmed.startsWith("! Last modified:")) {
			headers.lastModified = trimmed.replace("! Last modified:", "").trim();
		} else if (trimmed.startsWith("! Version:")) {
			headers.version = trimmed.replace("! Version:", "").trim();
		} else if (trimmed.startsWith("! Updated:")) {
			headers.lastModified = trimmed.replace("! Updated:", "").trim();
		}
	}

	return headers;
}

interface FilterRule {
	pattern: string;
	params: string[];
	domain?: string;
	isRegex?: boolean;
	isException?: boolean; // @@ prefix indicates exception rule
}

function parseFilterList(raw: string): FilterRule[] {
	const ruleMap = new Map<string, FilterRule>();
	const lines = raw.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		// Skip comments, empty lines, and non-removeparam rules
		if (
			!trimmed ||
			trimmed.startsWith("!") ||
			trimmed.startsWith("#") ||
			!trimmed.includes("$removeparam=")
		) {
			continue;
		}

		// Parse $removeparam rules according to AdGuard syntax
		const removeParamIndex = trimmed.indexOf("$removeparam=");
		if (removeParamIndex === -1) continue;

		// Check for exception rule (starts with @@)
		const isException = trimmed.startsWith("@@");
		const ruleText = isException ? trimmed.substring(2) : trimmed;
		const removeParamIndexInRule = ruleText.indexOf("$removeparam=");
		
		if (removeParamIndexInRule === -1) continue;

		const patternPart = ruleText.substring(0, removeParamIndexInRule);
		const removeParamPart = ruleText.substring(
			removeParamIndexInRule + "$removeparam=".length,
		);

		// Skip if there are other filter options (we only want removeparam)
		if (
			removeParamPart.includes("$") &&
			!removeParamPart.startsWith("$removeparam=")
		) {
			continue;
		}

		// Parse the pattern part
		let pattern: string;
		let domain: string | undefined;
		let isRegex = false;

		if (!patternPart || patternPart.trim() === "") {
			// Global rule: $removeparam=param
			pattern = "*";
		} else if (patternPart.startsWith("||") && patternPart.includes("^")) {
			// Domain pattern: ||domain^$removeparam=param
			pattern = patternPart;
			domain = patternPart.substring(2, patternPart.indexOf("^"));
		} else if (patternPart.startsWith("|") && patternPart.endsWith("|")) {
			// Exact domain pattern: |domain|$removeparam=param
			pattern = patternPart;
			domain = patternPart.substring(1, patternPart.length - 1);
		} else if (patternPart.includes("://") && patternPart.includes("*")) {
			// Regex pattern: ://domain.com/@*$removeparam=param
			pattern = patternPart;
			isRegex = true;
			const domainMatch = patternPart.match(/:\/\/([^\/\?\*]+)/);
			if (domainMatch) {
				domain = domainMatch[1];
			}
		} else if (patternPart.startsWith("?") && patternPart.includes("^")) {
			// Query parameter pattern: ?param=value^$removeparam=param
			pattern = patternPart;
			isRegex = true;
			// Extract the parameter name from the query pattern
			const paramMatch = patternPart.match(/\?([^=]+)=/);
			if (paramMatch) {
				// This is a global rule that applies when the specific query parameter exists
				domain = undefined;
			}
		} else if (
			!patternPart.includes("*") &&
			!patternPart.includes("^") &&
			!patternPart.includes("|") &&
			!patternPart.includes("://") &&
			!patternPart.startsWith("?")
		) {
			// Simple domain pattern: domain.com$removeparam=param
			pattern = patternPart;
			domain = patternPart;
		} else if (patternPart.includes("*")) {
			// Wildcard pattern: *.domain.com$removeparam=param
			pattern = patternPart;
			isRegex = true;
			const domainMatch = patternPart.match(/([a-zA-Z0-9.-]+)/);
			if (domainMatch) {
				domain = domainMatch[1];
			}
		} else {
			// Fallback: treat as simple pattern
			pattern = patternPart;
			domain = patternPart;
		}

		// Parse parameters (can be comma-separated)
		const params = removeParamPart
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p);

		// Group parameters by pattern
		const existingRule = ruleMap.get(pattern);
		if (existingRule) {
			existingRule.params.push(...params);
		} else {
			ruleMap.set(pattern, {
				pattern,
				params,
				domain,
				isRegex,
				isException,
			});
		}
	}

	return Array.from(ruleMap.values());
}

async function loadCachedRules(): Promise<FilterRule[] | null> {
	try {
		const result = await browser.storage.local.get([
			CACHE_KEY,
			`${CACHE_KEY}_version`,
			CACHE_EXPIRY_KEY,
		]);
		const cachedRules = result[CACHE_KEY];
		const cachedVersion = result[`${CACHE_KEY}_version`];
		const cacheExpiry = result[CACHE_EXPIRY_KEY];

		// Check if cache is valid and not expired
		if (
			cachedRules &&
			cachedVersion === CACHE_VERSION &&
			cacheExpiry &&
			Date.now() < cacheExpiry
		) {
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

async function saveCachedRules(
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

async function initializeEngine(): Promise<void> {
	if (isInitialized) return;

	try {
		logger.info("Initializing URL cleaning with filter lists...");

		// Try to load cached rules first
		const cachedRules = await loadCachedRules();
		if (cachedRules) {
			filterRules = cachedRules;
			isInitialized = true;
			return;
		}

		// Load filter lists if no cache
		const filterListVersions: Record<string, string> = {};

		for (const list of filterLists) {
			const filterInfo = await loadFilterList(list.url);
			if (filterInfo.content) {
				const totalLines = filterInfo.content.split("\n").length;
				const rules = parseFilterList(filterInfo.content);
				filterRules.push(...rules);

				// Parse headers for version info
				const headers = parseFilterListHeaders(filterInfo.content);
				const version = headers.lastModified || headers.version || "unknown";
				filterListVersions[list.name] = version;

				logger.info(
					`Loaded ${rules.length} URL cleaning rules from ${totalLines} total lines in filter list: ${list.name} (${version})`,
				);
			}
		}

		await saveCachedRules(filterRules, filterListVersions);

		isInitialized = true;
		logger.info(
			`URL cleaning initialized with ${filterRules.length} total rules`,
		);
	} catch (error) {
		logger.error("Failed to initialize URL cleaning:", error);
		filterRules = [];
		isInitialized = false;
	}
}

function matchesPattern(
	hostname: string,
	pattern: string,
	isRegex?: boolean,
): boolean {
	// Handle global patterns
	if (pattern === "*") {
		return true;
	}

	// Handle AdGuard domain patterns: ||domain^
	if (pattern.startsWith("||") && pattern.includes("^")) {
		const domain = pattern.substring(2, pattern.indexOf("^"));
		return hostname === domain || hostname.endsWith(`.${domain}`);
	}

	// Handle exact domain patterns: |domain|
	if (pattern.startsWith("|") && pattern.endsWith("|")) {
		const domain = pattern.substring(1, pattern.length - 1);
		return hostname === domain;
	}

	// Handle regex patterns (including :// patterns and query parameter patterns)
	if (isRegex || pattern.includes("://") || pattern.startsWith("?")) {
		try {
			// Handle :// patterns like ://youtube.com/@*$removeparam=si
			if (pattern.includes("://")) {
				// Extract the domain part and convert to hostname matching
				const domainMatch = pattern.match(/:\/\/([^\/\?\*]+)/);
				if (domainMatch) {
					const domain = domainMatch[1];
					// Check if hostname matches the domain
					if (hostname === domain || hostname.endsWith("." + domain)) {
						return true;
					}
				}
				return false;
			}

			// Handle query parameter patterns like ?from=glia^$removeparam=from
			if (pattern.startsWith("?")) {
				// This is a global rule that applies to all domains when the query parameter exists
				// The actual URL matching will be done in applyFilterRules by checking the URL
				return true;
			}

			// Handle other regex patterns with wildcards
			let regexPattern = pattern
				.replace(/\*/g, ".*") // * matches any characters
				.replace(/\./g, "\\.") // Escape dots
				.replace(/\^/g, "$"); // ^ matches end of string

			const regex = new RegExp("^" + regexPattern + "$");
			return regex.test(hostname);
		} catch (error) {
			// If regex compilation fails, fall back to simple matching
			return false;
		}
	}

	// Handle simple domain patterns (no special characters)
	if (
		!pattern.includes("*") &&
		!pattern.includes("^") &&
		!pattern.includes("|") &&
		!pattern.includes("://")
	) {
		return hostname === pattern || hostname.endsWith("." + pattern);
	}

	// Handle wildcard patterns with *
	if (pattern.includes("*")) {
		try {
			const regexPattern = pattern.replace(/\*/g, ".*").replace(/\./g, "\\.");
			const regex = new RegExp("^" + regexPattern + "$");
			return regex.test(hostname);
		} catch (error) {
			return false;
		}
	}

	return false;
}

function applyFilterRules(urlString: string): string {
	try {
		const url = new URL(urlString);
		const hostname = url.hostname;

		// Separate regular rules from exception rules
		const regularRules = filterRules.filter(rule => !rule.isException);
		const exceptionRules = filterRules.filter(rule => rule.isException);

		// Check if any regular filter rules apply to this domain
		const applicableRegularRules = regularRules.filter((rule) => {
			// For query parameter patterns, we need to check the actual URL
			if (rule.pattern.startsWith("?")) {
				// Extract the query parameter pattern: ?param=value^
				const paramMatch = rule.pattern.match(/\?([^=]+)=([^$^]+)/);
				if (paramMatch) {
					const paramName = paramMatch[1];
					const paramValue = paramMatch[2];
					// Check if the URL has this parameter with this value
					return url.searchParams.get(paramName) === paramValue;
				}
				return false;
			}
			// For other patterns, use hostname matching
			return matchesPattern(hostname, rule.pattern, rule.isRegex);
		});

		// Check if any exception rules apply to this domain
		const applicableExceptionRules = exceptionRules.filter((rule) => {
			// For query parameter patterns, we need to check the actual URL
			if (rule.pattern.startsWith("?")) {
				// Extract the query parameter pattern: ?param=value^
				const paramMatch = rule.pattern.match(/\?([^=]+)=([^$^]+)/);
				if (paramMatch) {
					const paramName = paramMatch[1];
					const paramValue = paramMatch[2];
					// Check if the URL has this parameter with this value
					return url.searchParams.get(paramName) === paramValue;
				}
				return false;
			}
			// For other patterns, use hostname matching
			return matchesPattern(hostname, rule.pattern, rule.isRegex);
		});

		if (applicableRegularRules.length === 0) {
			// No regular filter rules for this domain, keep all parameters
			return urlString;
		}

		// Collect parameters to remove from regular rules
		const paramsToRemove = new Set<string>();
		for (const rule of applicableRegularRules) {
			for (const param of rule.params) {
				paramsToRemove.add(param);
			}
		}

		// Remove parameters that are protected by exception rules
		for (const rule of applicableExceptionRules) {
			for (const param of rule.params) {
				paramsToRemove.delete(param);
			}
		}

		// Remove the parameters that are not protected by exceptions
		for (const param of paramsToRemove) {
			url.searchParams.delete(param);
		}

		// Remove the ? character if no parameters are left
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
		// Initialize filter rules if not already done
		await initializeEngine();

		// Apply filter rules if available
		if (filterRules.length > 0) {
			return applyFilterRules(urlString);
		} else {
			// If no filter rules loaded, return original URL
			logger.warn("No filter rules loaded, returning original URL");
			return urlString;
		}
	} catch (error) {
		logger.error("Error in URL cleaning:", error);
		return urlString;
	}
}

// Function to manually refresh filter lists (useful for settings/options page)
export async function refreshFilterLists(): Promise<void> {
	logger.info("Manually refreshing filter lists...");

	// Clear cache
	try {
		await browser.storage.local.remove([
			CACHE_KEY,
			`${CACHE_KEY}_version`,
			CACHE_EXPIRY_KEY,
			`${CACHE_KEY}_filter_versions`,
		]);
	} catch (error) {
		logger.warn("Failed to clear cache:", error);
	}

	// Reset initialization state
	isInitialized = false;
	filterRules = [];

	// Re-initialize
	await initializeEngine();
}

// Functions for dependency injection (mainly for testing)
export function setFilterLists(lists: Array<{ name: string; url: string }>): void {
	filterLists = lists;
}

export function resetFilterLists(): void {
	filterLists = DEFAULT_FILTER_LISTS;
}

export function getFilterLists(): Array<{ name: string; url: string }> {
	return [...filterLists];
}

// Export for testing
export { initializeEngine, isInitialized };
