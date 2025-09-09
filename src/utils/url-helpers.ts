import { initializeUrlCleanerWithRemoteLists } from "./filter-list-manager";
import { cleanUrl as filterListCleanUrl } from "./filter-list-url-cleaner";
import { getTrackingParameters } from "./tracking-params-manager";

let loadedTrackingParameters: string[] = [];
let urlCanonizerInitialized = false;

export async function initializeUrlCanonizer(): Promise<void> {
	if (urlCanonizerInitialized) return;

	// Initialize tracking parameters
	loadedTrackingParameters = await getTrackingParameters();

	// Initialize filter list cleaner with remote filter lists
	try {
		await initializeUrlCleanerWithRemoteLists();
	} catch (error) {
		console.warn("Failed to initialize filter list cleaner:", error);
	}

	urlCanonizerInitialized = true;
}
function handleOpenRedirects(url: URL): URL {
	const redirectParams = [
		"url",
		"u",
		"q",
		"next",
		"redirect",
		"redirect_uri",
		"redirect_url",
		"destination",
		"dest",
	];
	for (const param of redirectParams) {
		const potentialUrl = url.searchParams.get(param);
		if (potentialUrl) {
			try {
				const newUrl = new URL(potentialUrl);
				if (newUrl.protocol === "http:" || newUrl.protocol === "https:") {
					return newUrl;
				}
			} catch (_e) {}
		}
	}
	return url;
}
function deAmpUrl(url: URL): URL {
	if (url.hostname.endsWith("google.com") && url.pathname.startsWith("/amp/")) {
		const pathParts = url.pathname.split("/");
		if (pathParts.length > 3) {
			const originalHostAndPath = pathParts.slice(3).join("/");
			try {
				const newUrlString = `https://${originalHostAndPath}`;
				const newUrl = new URL(newUrlString);
				newUrl.search = url.search;
				return newUrl;
			} catch (_e) {}
		}
	}
	return url;
}
function canonicalizeTwitterUrl(url: URL): URL {
	const twitterDomains = [
		"twitter.com",
		"x.com",
		"fxtwitter.com",
		"vxtwitter.com",
		"fixvx.com",
	];
	if (twitterDomains.includes(url.hostname.toLowerCase())) {
		url.hostname = "x.com";
	}
	return url;
}
function canonicalizeYoutubeUrl(url: URL): URL {
	const youtubeDomains = ["youtube.com", "m.youtube.com", "youtu.be"];
	if (youtubeDomains.includes(url.hostname.toLowerCase())) {
		url.hostname = "www.youtube.com";
		let videoId: string | null = null;
		if (url.pathname.startsWith("/shorts/")) {
			videoId = url.pathname.substring("/shorts/".length);
		} else if (url.hostname.endsWith("youtu.be")) {
			videoId = url.pathname.substring(1);
		} else {
			videoId = url.searchParams.get("v");
		}
		if (videoId) {
			url.pathname = "/watch";
			url.search = `?v=${videoId}`;
		}
	}
	return url;
}
function canonicalizeAmazonUrl(url: URL): URL {
	const amazonDomains = [
		"amazon.com",
		"amazon.co.uk",
		"amazon.de",
		"amazon.fr",
		"amazon.ca",
		"amazon.es",
		"amazon.it",
		"amazon.co.jp",
		"amazon.cn",
		"amazon.in",
		"amazon.com.au",
		"amazon.com.br",
		"amazon.com.mx",
		"amazon.nl",
		"amazon.pl",
		"amazon.se",
		"amazon.sg",
		"amazon.ae",
		"amazon.sa",
		"amazon.com.tr",
		"amazon.com.be",
		"amazon.eg",
		"amazon.co.za",
	];
	const fullAmazonHostnames = amazonDomains.flatMap((domain) => [
		`www.${domain}`,
		`smile.${domain}`,
		domain,
	]);
	const host = url.hostname.toLowerCase();
	if (fullAmazonHostnames.includes(host)) {
		const asinRegex = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
		const match = url.pathname.match(asinRegex);
		if (match?.[1]) {
			const asin = match[1];
			url.pathname = `/dp/${asin}`;
			url.search = "";
		}
	}
	return url;
}
function removeTrackingParameters(url: URL): URL {
	const params = url.searchParams;
	const trackingParamsSet = new Set(loadedTrackingParameters);
	const paramsToDelete: string[] = [];

	// Remove all tracking parameters
	for (const key of params.keys()) {
		if (key.startsWith("utm_") || trackingParamsSet.has(key)) {
			paramsToDelete.push(key);
		}
	}

	paramsToDelete.forEach((param) => {
		params.delete(param);
	});

	url.search = params.toString();
	return url;
}

export async function canonicalizeUrl(urlString: string): Promise<string> {
	try {
		// First, use filter lists for comprehensive URL cleaning
		const cleanedUrl = await filterListCleanUrl(urlString);
		let url = new URL(cleanedUrl);

		// Apply our custom canonicalization logic
		const maxRedirects = 5;
		for (let i = 0; i < maxRedirects; i++) {
			const originalUrlString = url.toString();
			const newUrl = handleOpenRedirects(url);
			if (newUrl.toString() === originalUrlString) {
				break;
			}
			url = newUrl;
		}
		url = deAmpUrl(url);
		url = canonicalizeTwitterUrl(url);
		url = canonicalizeYoutubeUrl(url);
		url = canonicalizeAmazonUrl(url);

		// Apply additional tracking parameter removal using our custom list
		// This ensures we don't lose any parameters that filter lists might not catch
		url = removeTrackingParameters(url);

		return url.toString();
	} catch (_error) {
		return urlString;
	}
}
