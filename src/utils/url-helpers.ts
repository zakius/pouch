import { initializeUrlCleanerWithRemoteLists } from "./filter-list-manager";
import { cleanUrl as filterListCleanUrl } from "./filter-list-url-cleaner";

let urlCanonizerInitialized = false;

export async function initializeUrlCanonizer(): Promise<void> {
  if (urlCanonizerInitialized) return;

  try {
    await initializeUrlCleanerWithRemoteLists();
  } catch (error) {
    console.warn("Failed to initialize filter list cleaner:", error);
  }

  urlCanonizerInitialized = true;
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
  if (url.hostname.endsWith("google.com") && url.pathname.startsWith("/amp/")) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length > 3) {
      const originalHostAndPath = pathParts.slice(3).join("/");
      try {
        const newUrlString = `https://${originalHostAndPath}`;
        const newUrl = new URL(newUrlString);
        newUrl.search = url.search;
        return newUrl;
      } catch {}
    }
  }
  return url;
}
function canonicalizeTwitterUrl(url: URL): URL {
  const twitterDomains = ["twitter.com", "x.com", "fxtwitter.com", "vxtwitter.com", "fixvx.com"];
  if (twitterDomains.includes(url.hostname.toLowerCase())) {
    url.hostname = "x.com";
  }
  return url;
}
function canonicalizeYoutubeUrl(url: URL): URL {
  const youtubeDomains = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  if (youtubeDomains.includes(url.hostname.toLowerCase())) {
    let videoId: string | null = null;
    if (url.pathname.startsWith("/shorts/")) {
      videoId = url.pathname.substring("/shorts/".length);
    } else if (url.hostname.endsWith("youtu.be")) {
      videoId = url.pathname.substring(1);
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

    if (canonicalUrlCache.size >= CANONICAL_CACHE_LIMIT) {
      canonicalUrlCache.clear();
    }
    canonicalUrlCache.set(urlString, url.toString());

    return url.toString();
  } catch {
    return urlString;
  }
}
