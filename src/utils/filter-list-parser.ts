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
			!trimmed.includes("$removeparam=")
		) {
			continue;
		}

		const removeParamIndex = trimmed.indexOf("$removeparam=");
		if (removeParamIndex === -1) continue;

		const isException = trimmed.startsWith("@@");
		const ruleText = isException ? trimmed.substring(2) : trimmed;
		const removeParamIndexInRule = ruleText.indexOf("$removeparam=");

		if (removeParamIndexInRule === -1) continue;

		const patternPart = ruleText.substring(0, removeParamIndexInRule);
		const removeParamPart = ruleText.substring(
			removeParamIndexInRule + "$removeparam=".length,
		);

		if (
			removeParamPart.includes("$") &&
			!removeParamPart.startsWith("$removeparam=")
		) {
			continue;
		}

		let pattern: string;
		let domain: string | undefined;
		let isRegex = false;

		if (!patternPart || patternPart.trim() === "") {
			pattern = "*";
		} else if (patternPart.startsWith("||") && patternPart.includes("^")) {
			pattern = patternPart;
			domain = patternPart.substring(2, patternPart.indexOf("^"));
		} else if (patternPart.startsWith("|") && patternPart.endsWith("|")) {
			pattern = patternPart;
			domain = patternPart.substring(1, patternPart.length - 1);
		} else if (patternPart.includes("://") && patternPart.includes("*")) {
			pattern = patternPart;
			isRegex = true;
			const domainMatch = patternPart.match(/:\/\/([^/?*]+)/);
			if (domainMatch) {
				domain = domainMatch[1];
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

		const params = removeParamPart
			.split(",")
			.map((p) => p.trim())
			.filter((p) => p);

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

export function matchesPattern(
	hostname: string,
	pattern: string,
	isRegex?: boolean,
): boolean {
	if (pattern === "*") {
		return true;
	}

	if (pattern.startsWith("||") && pattern.includes("^")) {
		const domain = pattern.substring(2, pattern.indexOf("^"));
		return hostname === domain || hostname.endsWith(`.${domain}`);
	}

	if (pattern.startsWith("|") && pattern.endsWith("|")) {
		const domain = pattern.substring(1, pattern.length - 1);
		return hostname === domain;
	}

	if (isRegex || pattern.includes("://") || pattern.startsWith("?")) {
		try {
			if (pattern.includes("://")) {
				const domainMatch = pattern.match(/:\/\/([^/?*]+)/);
				if (domainMatch) {
					const domain = domainMatch[1];
					if (hostname === domain || hostname.endsWith(`.${domain}`)) {
						return true;
					}
				}
				return false;
			}

			if (pattern.startsWith("?")) {
				return true;
			}

			const regexPattern = pattern
				.replace(/\*/g, ".*") // * matches any characters
				.replace(/\./g, "\\.") // Escape dots
				.replace(/\^/g, "$"); // ^ matches end of string

			const regex = new RegExp(`^${regexPattern}$`);
			return regex.test(hostname);
		} catch (_error) {
			return false;
		}
	}

	if (
		!pattern.includes("*") &&
		!pattern.includes("^") &&
		!pattern.includes("|") &&
		!pattern.includes("://") &&
		!pattern.startsWith("?")
	) {
		return hostname === pattern || hostname.endsWith(`.${pattern}`);
	}

	if (pattern.includes("*")) {
		try {
			const regexPattern = pattern.replace(/\*/g, ".*").replace(/\./g, "\\.");
			const regex = new RegExp(`^${regexPattern}$`);
			return regex.test(hostname);
		} catch (_error) {
			return false;
		}
	}

	return false;
}
