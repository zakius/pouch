import { assertStorageHealthy } from "./fatal-storage";
import { initializeUrlCleanerWithRemoteLists } from "./filter-list-manager";
import { cleanUrl as filterListCleanUrl, filterRuleCount } from "./filter-list-url-cleaner";

// Offline starts load zero rules without throwing, so retry until rules arrive, at most every 5 minutes.
const INIT_RETRY_MS = 5 * 60_000;
let urlCanonizerInitialized = false;
let lastInitAttempt = -Infinity;

export async function initializeUrlCanonizer(): Promise<void> {
  if (urlCanonizerInitialized || Date.now() - lastInitAttempt < INIT_RETRY_MS) return;
  lastInitAttempt = Date.now();

  try {
    await initializeUrlCleanerWithRemoteLists();
  } catch (error) {
    assertStorageHealthy();
    console.warn("Failed to initialize filter list cleaner:", error);
  }

  urlCanonizerInitialized = filterRuleCount() > 0;
}
const redirectTargets: { host: string; paths: string[]; params: string[] }[] = [
  {
    host: "google.com",
    paths: ["/url", "/imgres"],
    params: ["q", "url", "imgurl"],
  },
];

function handleOpenRedirects(url: URL): URL {
  const host = url.hostname.toLowerCase();
  const target = redirectTargets.find(
    (t) => t.paths.includes(url.pathname) && (host === t.host || host.endsWith(`.${t.host}`)),
  );
  if (!target) {
    return url;
  }
  for (const param of target.params) {
    const potentialUrl = url.searchParams.get(param);
    if (potentialUrl) {
      try {
        const newUrl = new URL(potentialUrl);
        if (newUrl.protocol === "http:" || newUrl.protocol === "https:") {
          return newUrl;
        }
      } catch {}
    }
  }
  return url;
}
function deAmpUrl(url: URL): URL {
  const host = url.hostname;
  if ((host === "google.com" || host.endsWith(".google.com")) && url.pathname.startsWith("/amp/")) {
    // Google AMP viewer paths: /amp/s/<host>/<path> for https, /amp/<host>/<path> for http.
    const pathParts = url.pathname.slice("/amp/".length).split("/");
    const secure = pathParts[0] === "s";
    if (secure) pathParts.shift();
    if (pathParts[0]) {
      try {
        const newUrl = new URL(`${secure ? "https" : "http"}://${pathParts.join("/")}`);
        newUrl.search = url.search;
        return newUrl;
      } catch {}
    }
  }
  return url;
}
function canonicalizeTwitterUrl(url: URL): URL {
  const twitterDomains = ["twitter.com", "x.com", "fxtwitter.com", "vxtwitter.com", "fixvx.com"];
  if (twitterDomains.includes(url.hostname.replace(/^(?:www|mobile)\./, ""))) {
    url.hostname = "x.com";
  }
  return url;
}
function canonicalizeYoutubeUrl(url: URL): URL {
  const youtubeDomains = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  if (youtubeDomains.includes(url.hostname.toLowerCase())) {
    let videoId: string | null = null;
    if (url.pathname.startsWith("/shorts/")) {
      videoId = url.pathname.split("/")[2];
    } else if (url.hostname.endsWith("youtu.be")) {
      videoId = url.pathname.split("/")[1];
    } else {
      videoId = url.searchParams.get("v");
    }
    url.hostname = "www.youtube.com";
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

// ponytail: crude cap, swap for an LRU if 1000 entries ever turns out to be too few
const canonicalUrlCache = new Map<string, string>();
const CANONICAL_CACHE_LIMIT = 1000;

export function clearCanonicalUrlCache(): void {
  canonicalUrlCache.clear();
}

export async function canonicalizeUrl(urlString: string): Promise<string> {
  assertStorageHealthy();
  const cached = canonicalUrlCache.get(urlString);
  if (cached !== undefined) {
    return cached;
  }
  try {
    await initializeUrlCanonizer();

    const cleanedUrl = await filterListCleanUrl(urlString);
    let url = new URL(cleanedUrl);

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

    // A result computed without filter rules would outlive the rules' arrival.
    if (urlCanonizerInitialized) {
      if (canonicalUrlCache.size >= CANONICAL_CACHE_LIMIT) {
        canonicalUrlCache.clear();
      }
      canonicalUrlCache.set(urlString, url.toString());
    }

    return url.toString();
  } catch {
    assertStorageHealthy();
    return urlString;
  }
}
