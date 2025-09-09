import {
	type FilterRule,
	matchesPattern,
	parseCompleteFilterList,
} from "./filter-list-parser";
import { logger } from "./logger";

let filterRules: FilterRule[] = [];
let isInitialized = false;

/**
 * Initialize the URL cleaner with an array of raw filter lists
 */
export async function initializeWithRawFilterLists(
	filterLists: Array<{ name: string; content: string }>,
): Promise<void> {
	try {
		logger.info(
			`Initializing URL cleaning with ${filterLists.length} raw filter lists...`,
		);

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

		filterRules = allRules;
		isInitialized = true;

		logger.info(
			`URL cleaning initialized with ${filterRules.length} total rules from raw content`,
		);
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

		// Separate regular rules from exception rules
		const regularRules = filterRules.filter((rule) => !rule.isException);
		const exceptionRules = filterRules.filter((rule) => rule.isException);

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
		if (!isInitialized) {
			throw new Error("URL cleaner not initialized");
		}

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
