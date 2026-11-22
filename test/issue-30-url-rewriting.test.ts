import { runOperation } from "../src/background/api/effect-adapter";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as factory from "../src/utils/adapter-factory";
import { DEFAULT_SETTINGS, type Settings } from "../src/utils/settings";
import { ArticlesRepository, getAccountStorageKeys } from "../src/background/articles-repository";
import type { Article } from "../src/types/common";
import {
  refreshFilterLists,
  resetFilterListSources,
  setFilterListSources,
} from "../src/utils/filter-list-manager";
import { initializeWithRawFilterLists } from "../src/utils/filter-list-url-cleaner";
import * as urlHelpers from "../src/utils/url-helpers";
import {
  canonicalizeUrl,
  clearCanonicalUrlCache,
  initializeUrlCanonizer,
} from "../src/utils/url-helpers";
import testFilterContent from "./test-data/test-filters.txt";

const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");

const keys = getAccountStorageKeys(DEFAULT_SETTINGS);

const emptySource = [{ name: "empty", url: `data:text/plain;base64,${btoa("!")}` }];

function withStorage(): { storage: Record<string, unknown> } {
  const storage: Record<string, unknown> = {};
  Object.assign(globalThis, {
    browser: {
      storage: {
        local: {
          get: async (keys?: string | string[]) => {
            if (!keys) return { ...storage };
            const names = typeof keys === "string" ? [keys] : keys;
            return Object.fromEntries(
              names.filter((k) => k in storage).map((k) => [k, storage[k]]),
            );
          },
          set: async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          },
          remove: async (keys: string | string[]) => {
            for (const key of typeof keys === "string" ? [keys] : keys) delete storage[key];
          },
        },
      },
    },
  });
  return { storage };
}

function dataUrl(content: string): string {
  return `data:text/plain;base64,${btoa(content)}`;
}

function useAdapter(saveArticle: (input: { url: string; title: string }) => Article) {
  spyOn(factory, "getReadyAdapter").mockReturnValue(
    Effect.succeed({
      saveArticle: (input: { url: string; title: string }) => Effect.succeed(saveArticle(input)),
    }) as never,
  );
}

beforeEach(async () => {
  withStorage();
  setFilterListSources(emptySource);
  clearCanonicalUrlCache();
  await initializeUrlCanonizer();
});

afterEach(async () => {
  mock.restore();
  resetFilterListSources();
  await initializeWithRawFilterLists([{ name: "TestFilters", content: testFilterContent }]);
  if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
  else Reflect.deleteProperty(globalThis, "browser");
  clearCanonicalUrlCache();
});

test("URL-valued query parameters on ordinary hosts are preserved", async () => {
  for (const url of [
    "https://example.com/search?q=https%3A%2F%2Fother.example%2F",
    "https://app.example/launch?url=https%3A%2F%2Fservice.example%2Fcallback",
    "https://forum.example/login?next=https%3A%2F%2Fforum.example%2Finbox",
    "https://shop.example/exit?redirect=https%3A%2F%2Fpartner.example%2Flanding",
    "https://id.example/authorize?redirect_uri=https%3A%2F%2Fclient.example%2Fcb&dest=https%3A%2F%2Fclient.example%2Fx",
  ]) {
    expect(await canonicalizeUrl(url)).toBe(url);
  }
});

test("Google redirect boundary URLs are unwrapped", async () => {
  expect(
    await canonicalizeUrl("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle"),
  ).toBe("https://example.com/article");
  expect(
    await canonicalizeUrl("https://google.com/imgres?imgurl=https%3A%2F%2Fexample.com%2Fpic.jpg"),
  ).toBe("https://example.com/pic.jpg");
});

test("Hosts that merely end in google.com are not unwrapped", async () => {
  for (const url of [
    "https://notgoogle.com/url?q=https%3A%2F%2Fexample.com%2F",
    "https://evilgoogle.com/url?q=https%3A%2F%2Fexample.com%2F",
    "https://sub.notgoogle.com/url?q=https%3A%2F%2Fexample.com%2F",
  ]) {
    expect(await canonicalizeUrl(url)).toBe(url);
  }
});

test("AMP URLs are still unwrapped", async () => {
  expect(await canonicalizeUrl("https://www.google.com/amp/s/example.com/article")).toBe(
    "https://example.com/article",
  );
});

test("AMP paths on hosts that merely end in google.com are not unwrapped", async () => {
  const url = "https://evilgoogle.com/amp/s/example.com/article";
  expect(await canonicalizeUrl(url)).toBe(url);
});

test("Comparison without normalization matches exact saved URLs only", async () => {
  const { storage } = withStorage();
  const saved: Article = {
    id: 1,
    url: "https://www.youtube.com/watch?v=abc123",
    title: "Video",
    created_at: "2026-01-01",
  };
  storage[keys.articles] = [saved];
  const repository = new ArticlesRepository();
  await repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: false });
  expect(await runOperation(repository.findSaved("https://www.youtube.com/watch?v=abc123"))).toEqual(saved);
  expect(await runOperation(repository.findSaved("https://youtu.be/abc123"))).toBeUndefined();
  expect(await runOperation(repository.findSaved("https://www.youtube.com/watch?v=abc123&si=x"))).toBeUndefined();
});

test("Comparison with normalization canonicalizes both sides", async () => {
  const { storage } = withStorage();
  const saved: Article = {
    id: 1,
    url: "https://www.youtube.com/watch?v=abc123",
    title: "Video",
    created_at: "2026-01-01",
  };
  storage[keys.articles] = [saved];
  const repository = new ArticlesRepository();
  await repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: true });
  expect(await runOperation(repository.findSaved("https://youtu.be/abc123"))).toEqual(saved);
  expect(await runOperation(repository.findSaved("https://example.com/other"))).toBeUndefined();
});

test("Duplicate detection follows the comparison setting", async () => {
  const { storage } = withStorage();
  const existing: Article = {
    id: 1,
    url: "https://www.youtube.com/watch?v=abc123",
    title: "Video",
    created_at: "2026-01-01",
  };
  storage[keys.articles] = [existing];

  const exactRepository = new ArticlesRepository();
  await exactRepository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: false });
  useAdapter(() => ({
    id: 2,
    url: "https://youtu.be/abc123",
    title: "Video",
    created_at: "2026-01-02",
  }));
  await runOperation(exactRepository.saveArticle({ url: "https://youtu.be/abc123", title: "Video" }));
  expect(((await runOperation(exactRepository.getAllArticles)) as Article[]).length).toBe(2);

  const { storage: canonicalStorage } = withStorage();
  canonicalStorage[keys.articles] = [existing];
  const canonicalRepository = new ArticlesRepository();
  await canonicalRepository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: true });
  useAdapter(() => ({
    id: 3,
    url: "https://youtu.be/abc123",
    title: "Video",
    created_at: "2026-01-02",
  }));
  await runOperation(canonicalRepository.saveArticle({ url: "https://youtu.be/abc123", title: "Video" }));
  const articles = (await runOperation(canonicalRepository.getAllArticles)) as Article[];
  expect(articles.length).toBe(1);
  expect(articles[0].id).toBe(1);
});

test("Saving honors normalizeOnSave independently", async () => {
  useAdapter((input) => ({ id: 7, url: input.url, title: input.title, created_at: "2026-01-01" }));

  const rawRepository = new ArticlesRepository();
  await rawRepository.initialize({ ...DEFAULT_SETTINGS, normalizeOnSave: false });
  const rawSaved = await runOperation(rawRepository.saveArticle({
    url: "https://youtu.be/abc123",
    title: "Video",
  }));
  expect(rawSaved.url).toBe("https://youtu.be/abc123");
  expect(rawSaved.canonicalUrl).toBe("https://www.youtube.com/watch?v=abc123");

  clearCanonicalUrlCache();
  const { storage } = withStorage();
  storage[keys.articles] = [];
  const normalizedRepository = new ArticlesRepository();
  await normalizedRepository.initialize({
    ...DEFAULT_SETTINGS,
    normalizeOnSave: true,
    normalizeOnCompare: false,
  });
  const normalizedSaved = await runOperation(normalizedRepository.saveArticle({
    url: "https://youtu.be/abc123",
    title: "Video",
  }));
  expect(normalizedSaved.url).toBe("https://www.youtube.com/watch?v=abc123");
});

test("URLs canonicalized before filter rules load are not cached", async () => {
  const target = "https://late.test/page?track=1&keep=1";
  await initializeWithRawFilterLists([]);
  expect(await canonicalizeUrl(target)).toBe(target);
  await initializeWithRawFilterLists([{ name: "rules", content: "$removeparam=track" }]);
  expect(await canonicalizeUrl(target)).toBe("https://late.test/page?keep=1");
});

test("Filter refresh invalidates canonical results", async () => {
  const { storage } = withStorage();
  const target = "https://cache.test/page?track=1&keep=1";
  setFilterListSources([{ name: "rules", url: dataUrl("$removeparam=track\n$removeparam=other") }]);
  clearCanonicalUrlCache();
  await initializeWithRawFilterLists([
    { name: "rules", content: "$removeparam=track\n$removeparam=other" },
  ]);
  expect(await canonicalizeUrl(target)).toBe("https://cache.test/page?keep=1");

  setFilterListSources([
    { name: "rules", url: dataUrl("$removeparam=other\n@@||cache.test^$removeparam=track") },
  ]);
  await refreshFilterLists();
  expect(await canonicalizeUrl(target)).toBe("https://cache.test/page?track=1&keep=1");
  expect(await canonicalizeUrl(target)).toBe("https://cache.test/page?track=1&keep=1");
  expect(Object.keys(storage).length).toBeGreaterThan(0);
});

test("Existing stored articles are compared against recomputed canonical values", async () => {
  const { storage } = withStorage();
  const staleCanonical: Article = {
    id: 1,
    url: "https://cache.test/page?track=1&keep=1",
    canonicalUrl: "https://cache.test/page?keep=1",
    title: "Stale",
    created_at: "2026-01-01",
  };
  storage[keys.articles] = [staleCanonical];
  setFilterListSources([
    { name: "rules", url: dataUrl("$removeparam=other\n@@||cache.test^$removeparam=track") },
  ]);
  await refreshFilterLists();

  const repository = new ArticlesRepository();
  await repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: true });
  expect(await runOperation(repository.findSaved("https://cache.test/page?track=1&keep=1"))).toEqual(
    staleCanonical,
  );
});

test("The same article with and without tracking params shows as saved", async () => {
  const { storage } = withStorage();
  await initializeWithRawFilterLists([{ name: "rules", content: "$removeparam=utm_source" }]);
  const saved: Article = {
    id: 1,
    url: "https://news.example/story?q=a%20b&flag",
    title: "Story",
    created_at: "2026-01-01",
  };
  storage[keys.articles] = [saved];
  const repository = new ArticlesRepository();
  await repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: true });
  expect(
    await runOperation(
      repository.findSaved("https://news.example/story?q=a%20b&utm_source=feed&flag"),
    ),
  ).toEqual(saved);
});

test("Removing tracking params leaves the other params byte-for-byte", async () => {
  await initializeWithRawFilterLists([{ name: "rules", content: "$removeparam=utm_source" }]);
  expect(
    await canonicalizeUrl("https://e.example/p?utm_source=x&q=a+b%2Bc&x=%E2%9C%93&flag#top"),
  ).toBe("https://e.example/p?q=a+b%2Bc&x=%E2%9C%93&flag#top");
  expect(await canonicalizeUrl("https://e.example/p?utm_source=x")).toBe("https://e.example/p");
  expect(await canonicalizeUrl("https://e.example/p?utm%5Fsource=x&k=1")).toBe(
    "https://e.example/p?k=1",
  );
});

test("AMP URLs without the s/ segment unwrap to the http article", async () => {
  expect(await canonicalizeUrl("https://www.google.com/amp/www.example.com/page")).toBe(
    "http://www.example.com/page",
  );
});

test("YouTube Shorts and youtu.be links with a trailing slash identify the video", async () => {
  for (const url of ["https://www.youtube.com/shorts/abc123/", "https://youtu.be/abc123/"]) {
    expect(await canonicalizeUrl(url)).toBe("https://www.youtube.com/watch?v=abc123");
  }
});

test("Twitter and X subdomains canonicalize to x.com", async () => {
  for (const url of [
    "https://mobile.twitter.com/a/status/1",
    "https://www.twitter.com/a/status/1",
    "https://mobile.x.com/a/status/1",
  ]) {
    expect(await canonicalizeUrl(url)).toBe("https://x.com/a/status/1");
  }
});

test("findSaved with >1000 articles indexes once, avoids thrashing, and invalidates on filter refresh", async () => {
  const { storage } = withStorage();
  const articleCount = 1200;
  const articles: Article[] = Array.from({ length: articleCount - 1 }, (_, i) => ({
    id: i + 1,
    url: `https://example.com/post-${i}`,
    title: `Post ${i}`,
    created_at: "2026-01-01",
  }));
  const trackedArticle: Article = {
    id: articleCount,
    url: "https://cache.test/page?track=1&keep=1",
    canonicalUrl: "https://cache.test/page?keep=1",
    title: "Tracked",
    created_at: "2026-01-01",
  };
  articles.push(trackedArticle);
  storage[keys.articles] = articles;

  setFilterListSources([{ name: "rules", url: dataUrl("$removeparam=track\n$removeparam=other") }]);
  await initializeWithRawFilterLists([
    { name: "rules", content: "$removeparam=track\n$removeparam=other" },
  ]);
  clearCanonicalUrlCache();

  const repository = new ArticlesRepository();
  repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: true });

  const canonicalizeSpy = spyOn(urlHelpers, "canonicalizeUrl");

  // First lookup computes target once and builds the canonical index once across all articles.
  const firstMatch = await runOperation(
    repository.findSaved("https://example.com/post-1198?track=abc"),
  );
  expect(firstMatch?.id).toBe(1199);
  expect(canonicalizeSpy).toHaveBeenCalledTimes(articleCount + 1);

  // Subsequent lookups only canonicalize the target URL once (O(1) index lookup).
  canonicalizeSpy.mockClear();
  expect(
    (await runOperation(repository.findSaved("https://example.com/post-0?track=xyz")))?.id,
  ).toBe(1);
  expect(canonicalizeSpy).toHaveBeenCalledTimes(1);

  expect(
    (await runOperation(repository.findSaved("https://cache.test/page?keep=1")))?.id,
  ).toBe(articleCount);
  expect(canonicalizeSpy).toHaveBeenCalledTimes(2);

  expect(
    await runOperation(repository.findSaved("https://example.com/not-saved?track=1")),
  ).toBeUndefined();
  expect(canonicalizeSpy).toHaveBeenCalledTimes(3);

  // Saving a new article does not re-canonicalize all 1,200 existing articles.
  useAdapter((input) => ({
    id: articleCount + 1,
    url: input.url,
    title: input.title,
    created_at: "2026-01-02",
  }));
  canonicalizeSpy.mockClear();
  await runOperation(
    repository.saveArticle({ url: "https://example.com/new-post?track=1", title: "New" }),
  );
  // 1 in saveArticle + 1 in apply (no O(N) scan)
  expect(canonicalizeSpy.mock.calls.length).toBeLessThanOrEqual(2);

  // Lookup after save reuses known canonicals for all articles and only canonicalizes the target.
  canonicalizeSpy.mockClear();
  expect(
    (await runOperation(repository.findSaved("https://example.com/new-post")))?.id,
  ).toBe(articleCount + 1);
  expect(canonicalizeSpy).toHaveBeenCalledTimes(1);

  // Refreshing filter lists clears the canonical cache and invalidates the repository index.
  setFilterListSources([
    { name: "rules", url: dataUrl("$removeparam=other\n@@||cache.test^$removeparam=track") },
  ]);
  await refreshFilterLists();

  canonicalizeSpy.mockClear();
  expect(
    (await runOperation(repository.findSaved("https://cache.test/page?track=1&keep=1")))?.id,
  ).toBe(articleCount);
  // Stale canonical URL no longer matches under the updated exception rule.
  expect(
    await runOperation(repository.findSaved("https://cache.test/page?keep=1")),
  ).toBeUndefined();

  // Once rebuilt under the new rules, lookups again canonicalize only the target URL.
  canonicalizeSpy.mockClear();
  expect(
    (await runOperation(repository.findSaved("https://cache.test/page?track=1&keep=1")))?.id,
  ).toBe(articleCount);
  expect(canonicalizeSpy).toHaveBeenCalledTimes(1);
});

test("findSaved with normalizeOnCompare false skips canonicalizeUrl completely", async () => {
  const { storage } = withStorage();
  storage[keys.articles] = Array.from({ length: 1050 }, (_, i) => ({
    id: i + 1,
    url: `https://example.com/raw-${i}`,
    title: `Raw ${i}`,
    created_at: "2026-01-01",
  }));

  const repository = new ArticlesRepository();
  repository.initialize({ ...DEFAULT_SETTINGS, normalizeOnCompare: false });

  const canonicalizeSpy = spyOn(urlHelpers, "canonicalizeUrl");
  expect((await runOperation(repository.findSaved("https://example.com/raw-1049")))?.id).toBe(
    1050,
  );
  expect(await runOperation(repository.findSaved("https://example.com/raw-missing"))).toBeUndefined();
  expect(canonicalizeSpy).toHaveBeenCalledTimes(0);
});
