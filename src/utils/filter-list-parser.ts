/**
 * Filter List Parser Library
 *
 * A reusable library for parsing AdGuard-style filter lists and extracting
 * $removeparam rules and metadata from headers.
 */

export interface FilterListMetadata {
	lastModified?: string;
	version?: string;
	totalLines: number;
	ruleCount: number;
}

export interface FilterRule {
	pattern: string;
	params: string[];
	domain?: string;
	isRegex?: boolean;
	isException?: boolean; // @@ prefix indicates exception rule
}

export interface ParsedFilterList {
	rules: FilterRule[];
	metadata: FilterListMetadata;
}

/**
 * Parse filter list headers to extract metadata
 */
export function parseFilterListHeaders(content: string): {
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

/**
 * Parse a filter list string and extract $removeparam rules
 */
export function parseFilterList(raw: string): FilterRule[] {
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
			const domainMatch = patternPart.match(/:\/\/([^/?*]+)/);
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

/**
 * Parse a complete filter list string and return rules with metadata
 */
export function parseCompleteFilterList(content: string): ParsedFilterList {
	const rules = parseFilterList(content);
	const headers = parseFilterListHeaders(content);
	const totalLines = content.split("\n").length;

	return {
		rules,
		metadata: {
			...headers,
			totalLines,
			ruleCount: rules.length,
		},
	};
}

/**
 * Check if a hostname matches a filter pattern
 */
export function matchesPattern(
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
				const domainMatch = pattern.match(/:\/\/([^/?*]+)/);
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
			const regexPattern = pattern
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
		!pattern.includes("://") &&
		!pattern.startsWith("?")
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
