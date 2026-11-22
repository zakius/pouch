import assert from "node:assert/strict";
import { setFilterListSources } from "../../src/utils/filter-list-manager";
import { parseCompleteFilterList } from "../../src/utils/filter-list-parser";
import { canonicalizeUrl, initializeUrlCanonizer } from "../../src/utils/url-helpers";

const scenario = process.argv[2];

const CACHE_KEY = "filter_list_url_cleaning_rules";
const CACHE_EXPIRY_KEY = "filter_list_cache_expiry";

const store: Record<string, unknown> = {};
let getCalls = 0;
let setCalls = 0;
let fetchCalls = 0;
let releaseRead!: () => void;
let readStarted!: () => void;
let readPaused = true;
const readReady = new Promise<void>((resolve) => {
  readStarted = resolve;
});
const readGate = new Promise<void>((resolve) => {
  releaseRead = resolve;
});

let releaseFetch!: () => void;
let fetchPaused = false;
const fetchGate = new Promise<void>((resolve) => {
  releaseFetch = resolve;
});
let fetchStartedCount = 0;
let onFetchStarted: (() => void) | undefined;

let onSetDone: (() => void) | undefined;

Object.assign(globalThis, {
  browser: {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          getCalls++;
          if (readPaused) {
            readPaused = false;
            readStarted();
            await readGate;
          }
          if (!keys) return { ...store };
          const names = typeof keys === "string" ? [keys] : keys;
          return Object.fromEntries(names.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (values: Record<string, unknown>) => {
          setCalls++;
          Object.assign(store, values);
          onSetDone?.();
        },
        remove: async (keys: string | string[]) => {
          for (const key of typeof keys === "string" ? [keys] : keys) delete store[key];
        },
      },
    },
  },
});

const cachedRules = parseCompleteFilterList("$removeparam=utm_source").rules;

switch (scenario) {
  case "fresh-cache-race": {
    store[CACHE_KEY] = cachedRules;
    store[`${CACHE_KEY}_version`] = "1.1";
    store[CACHE_EXPIRY_KEY] = Date.now() + 60_000;
    setFilterListSources([{ name: "ListA", url: "https://filters.example/a.txt" }]);
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("fresh cache must not fetch remotely");
    }) as typeof fetch;

    const initPromise = initializeUrlCanonizer();
    await readReady;
    const cleanPromise = canonicalizeUrl(
      "https://example.com/article?utm_source=newsletter&keep=1",
    );

    releaseRead();
    const [, cleaned] = await Promise.all([initPromise, cleanPromise]);
    assert.equal(cleaned, "https://example.com/article?keep=1");
    assert.equal(getCalls, 1);
    assert.equal(fetchCalls, 0);
    break;
  }

  case "expired-cache-slow-remote": {
    store[CACHE_KEY] = cachedRules;
    store[`${CACHE_KEY}_version`] = "1.1";
    store[CACHE_EXPIRY_KEY] = Date.now() - 60_000;
    setFilterListSources([
      { name: "ListA", url: "https://filters.example/a.txt" },
      { name: "ListB", url: "https://filters.example/b.txt" },
    ]);
    fetchPaused = true;
    const bothFetchesStarted = new Promise<void>((resolve) => {
      onFetchStarted = () => {
        if (fetchStartedCount === 2) resolve();
      };
    });
    const cacheUpdated = new Promise<void>((resolve) => {
      onSetDone = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls++;
      fetchStartedCount++;
      onFetchStarted?.();
      if (fetchPaused) await fetchGate;
      const url = String(input);
      if (url.endsWith("/a.txt")) return new Response("$removeparam=utm_source", { status: 200 });
      return new Response("$removeparam=fbclid", { status: 200 });
    }) as typeof fetch;

    const initPromise = initializeUrlCanonizer();
    await readReady;
    const cleanPromise = canonicalizeUrl(
      "https://example.com/article?utm_source=newsletter&fbclid=abc&keep=1",
    );

    // Release ONLY local storage read while remote fetches stay hung.
    releaseRead();
    const [, firstCleaned] = await Promise.all([initPromise, cleanPromise]);
    assert.equal(firstCleaned, "https://example.com/article?fbclid=abc&keep=1");
    assert.equal(getCalls, 1);

    // Ensure both remote fetches started in parallel, then let them finish.
    await bothFetchesStarted;
    fetchPaused = false;
    releaseFetch();
    await cacheUpdated;

    // Allow microtasks after saveCachedFilterLists to apply rules & clear canonicalUrlCache.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(setCalls, 1);
    const secondCleaned = await canonicalizeUrl(
      "https://example.com/article?utm_source=newsletter&fbclid=abc&keep=1",
    );
    assert.equal(secondCleaned, "https://example.com/article?keep=1");
    break;
  }

  case "missing-cache-offline-cooldown": {
    setFilterListSources([
      { name: "ListA", url: "https://filters.example/a.txt" },
      { name: "ListB", url: "https://filters.example/b.txt" },
    ]);
    fetchPaused = true;
    const bothFetchesStarted = new Promise<void>((resolve) => {
      onFetchStarted = () => {
        if (fetchStartedCount === 2) resolve();
      };
    });
    globalThis.fetch = (async () => {
      fetchCalls++;
      fetchStartedCount++;
      onFetchStarted?.();
      if (fetchPaused) await fetchGate;
      throw new TypeError("offline");
    }) as typeof fetch;

    const initPromise = initializeUrlCanonizer();
    await readReady;
    const firstCleanPromise = canonicalizeUrl("https://example.com/a?utm_source=x&keep=1");

    releaseRead();
    const [, firstCleaned] = await Promise.all([initPromise, firstCleanPromise]);
    assert.equal(firstCleaned, "https://example.com/a?utm_source=x&keep=1");
    assert.equal(getCalls, 1);

    await bothFetchesStarted;
    // While remote download is in flight, additional canonicalizeUrl calls must not duplicate work.
    const secondCleaned = await canonicalizeUrl("https://example.com/b?utm_source=y&keep=2");
    assert.equal(secondCleaned, "https://example.com/b?utm_source=y&keep=2");
    assert.equal(getCalls, 1);
    assert.equal(fetchCalls, 2);

    // Finish failing offline fetches and verify cooldown prevents immediate retries.
    fetchPaused = false;
    releaseFetch();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await canonicalizeUrl("https://example.com/c?utm_source=z&keep=3");
    assert.equal(getCalls, 1);
    assert.equal(fetchCalls, 2);
    break;
  }

  default:
    throw new Error(`Unknown scenario: ${scenario}`);
}
