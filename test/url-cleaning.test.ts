import { test, expect, describe, afterEach } from "bun:test";
import {
	cleanUrl,
	filterRuleCount,
	initializeWithFilterRules,
	initializeWithRawFilterLists,
} from "../src/utils/filter-list-url-cleaner";
import {
	initializeUrlCleanerWithRemoteLists,
	loadFilterLists,
	refreshFilterLists,
	resetFilterListSources,
	saveCachedFilterLists,
	setFilterListSources,
} from "../src/utils/filter-list-manager";
import { parseCompleteFilterList } from "../src/utils/filter-list-parser";
import testFilterContent from "./test-data/test-filters.txt";

await initializeWithRawFilterLists([
	{ name: "TestFilters", content: testFilterContent }
]);

describe("Filter List URL Cleaning", () => {	

	test("should keep sc_eh parameter on puma.com domains (not in test filter list)", async () => {
		const input = "https://puma.com/test?sc_eh=test&important=keep";
		const output = await cleanUrl(input);
		expect(output).toBe("https://puma.com/test?sc_eh=test&important=keep");
	});

	test("should keep sc_eh parameter on puma.com subdomains (not in test filter list)", async () => {
		const input = "https://shop.puma.com/test?sc_eh=test&important=keep";
		const output = await cleanUrl(input);
		expect(output).toBe("https://shop.puma.com/test?sc_eh=test&important=keep");
	});

	test("should keep sc_eh parameter on non-puma domains", async () => {
		const input = "https://nike.com/test?sc_eh=test&important=keep";
		const output = await cleanUrl(input);
		expect(output).toBe("https://nike.com/test?sc_eh=test&important=keep");
	});

	test("should remove si parameter on YouTube URLs", async () => {
		const input = "https://youtube.com/@channelname/video?si=test123&v=abc123";
		const output = await cleanUrl(input);
		expect(output).toBe("https://youtube.com/@channelname/video?v=abc123");
	});

	test("should remove si parameter on YouTube channel URLs", async () => {
		const input = "https://youtube.com/@anotherchannel?si=test456&list=PL123";
		const output = await cleanUrl(input);
		expect(output).toBe("https://youtube.com/@anotherchannel?list=PL123");
	});

	test("should remove si parameter on YouTube watch URLs", async () => {
		const input = "https://youtube.com/watch?v=abc123&si=test789&t=30s";
		const output = await cleanUrl(input);
		expect(output).toBe("https://youtube.com/watch?v=abc123&t=30s");
	});

	test("should remove utm_source parameter (global rule in test filter list)", async () => {
		const input = "https://example.com/test?utm_source=test&gclid=test&fbclid=test";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?gclid=test&fbclid=test");
	});

	test("should remove utm_medium parameter (global rule in test filter list)", async () => {
		const input = "https://google.com/search?q=test&utm_medium=email&utm_campaign=newsletter&important=value";
		const output = await cleanUrl(input);
		expect(output).toBe("https://google.com/search?q=test&utm_campaign=newsletter&important=value");
	});

	test("should apply global rules when no exception rules match", async () => {
		const input = "https://puma.com/test?sc_eh=domain_specific&utm_source=global&important=keep";
		const output = await cleanUrl(input);
		expect(output).toBe("https://puma.com/test?sc_eh=domain_specific&important=keep");
	});

	test("should handle mixed YouTube and other domain rules", async () => {
		const input = "https://youtube.com/@test?si=regex_pattern&sc_eh=should_keep&important=keep";
		const output = await cleanUrl(input);
		expect(output).toBe("https://youtube.com/@test?sc_eh=should_keep&important=keep");
	});

	test("should remove Amazon tracking parameters", async () => {
		const input = "https://amazon.com/product?asin=B123456789&ref=homepage&tag=affiliate";
		const output = await cleanUrl(input);
		expect(output).toBe("https://amazon.com/product?asin=B123456789");
	});

	test("should handle URLs with no tracking parameters", async () => {
		const input = "https://example.com/clean?important=value&useful=param";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/clean?important=value&useful=param");
	});

	test("should handle malformed URLs gracefully", async () => {
		const input = "not-a-valid-url";
		const output = await cleanUrl(input);
		expect(output).toBe("not-a-valid-url");
	});

	test("should handle query parameter patterns", async () => {
		const input = "https://example.com/test?from=glia&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?keep=this");
	});

	test("should not remove parameters with different values in query patterns", async () => {
		const input = "https://example.com/test?from=other&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?from=other&keep=this");
	});

	test("should handle exception rules for utm_medium", async () => {
		const input = "https://rd.bizrate.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://rd.bizrate.com/test?utm_medium=email&keep=this");
	});

	test("should handle exception rules for utm_source", async () => {
		const input = "https://special-site.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://special-site.com/test?utm_source=newsletter&keep=this");
	});

	test("should apply global rules when no exception rules match", async () => {
		const input = "https://normal-site.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://normal-site.com/test?keep=this");
	});

    test("should apply global rules when no exception rules match", async () => {
		const input = "https://normal-site.com/test?utm_medium=email&utm_source=newsletter&keep=this&si=test";
		const output = await cleanUrl(input);
		expect(output).toBe("https://normal-site.com/test?keep=this");
	});

	test("should handle mixed query parameter and exception rules", async () => {
		const input = "https://rd.bizrate.com/test?from=glia&utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://rd.bizrate.com/test?utm_medium=email&keep=this");
	});

	test("should skip rules with unsupported domain modifiers", async () => {
		const input = "https://example.com/test?token=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?token=abc&keep=this");
	});

	test("should remove path-scoped parameters on matching paths", async () => {
		const input = "https://tracker.test/tracking/pixel?track_id=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://tracker.test/tracking/pixel?keep=this");
	});

	test("should not remove path-scoped parameters on non-matching paths", async () => {
		const input = "https://tracker.test/other/page?track_id=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://tracker.test/other/page?track_id=abc&keep=this");
	});

	test("should not remove path-scoped parameters on other domains", async () => {
		const input = "https://evil.test/tracking/pixel?track_id=abc";
		const output = await cleanUrl(input);
		expect(output).toBe("https://evil.test/tracking/pixel?track_id=abc");
	});

	test("should remove parameters for ||domain/path^ rules on matching paths", async () => {
		const input = "https://shop.test/path/page?sid=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://shop.test/path/page?keep=this");
	});

	test("should not remove parameters for ||domain/path^ rules on other paths", async () => {
		const input = "https://shop.test/elsewhere?sid=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://shop.test/elsewhere?sid=abc&keep=this");
	});

	test("should match wildcard hostnames without breaking dot escaping", async () => {
		const input = "https://sub.wildcard.test/page?wc=abc&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://sub.wildcard.test/page?keep=this");
		const input2 = "https://wildcard.test/page?wc=abc&keep=this";
		const output2 = await cleanUrl(input2);
		expect(output2).toBe("https://wildcard.test/page?wc=abc&keep=this");
	});
});

describe("Filter List Resilience & Cold Start", () => {
	const originalBrowser = Object.getOwnPropertyDescriptor(globalThis, "browser");
	const originalFetch = globalThis.fetch;

	function withLocalStorage(initial: Record<string, unknown> = {}) {
		const storage: Record<string, unknown> = { ...initial };
		let removeCalls = 0;
		Object.assign(globalThis, {
			browser: {
				storage: {
					local: {
						get: async (keys?: string | string[] | null) => {
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
							removeCalls++;
							for (const key of typeof keys === "string" ? [keys] : keys) delete storage[key];
						},
					},
				},
			},
		});
		return {
			storage,
			getRemoveCalls: () => removeCalls,
		};
	}

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		if (originalBrowser) Object.defineProperty(globalThis, "browser", originalBrowser);
		else Reflect.deleteProperty(globalThis, "browser");
		resetFilterListSources();
		await initializeWithRawFilterLists([{ name: "TestFilters", content: testFilterContent }]);
	});

	test("offline/failing refreshFilterLists preserves cached and in-memory rules and keeps cleaning URLs", async () => {
		const { storage, getRemoveCalls } = withLocalStorage();
		setFilterListSources([
			{ name: "ListA", url: "https://filters.example/a.txt" },
			{ name: "ListB", url: "https://filters.example/b.txt" },
		]);
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/a.txt")) return new Response("$removeparam=utm_a", { status: 200 });
			return new Response("$removeparam=utm_b", { status: 200 });
		}) as typeof fetch;

		await initializeUrlCleanerWithRemoteLists();
		const cachedBefore = structuredClone(storage);
		const countBefore = filterRuleCount();
		expect(countBefore).toBe(2);
		expect(await cleanUrl("https://example.com/page?utm_a=1&utm_b=2&keep=3")).toBe(
			"https://example.com/page?keep=3",
		);

		globalThis.fetch = (async () => {
			throw new TypeError("Network offline");
		}) as typeof fetch;

		await refreshFilterLists();

		expect(getRemoveCalls()).toBe(0);
		expect(storage).toEqual(cachedBefore);
		expect(filterRuleCount()).toBe(countBefore);
		expect(await cleanUrl("https://example.com/page?utm_a=1&utm_b=2&keep=3")).toBe(
			"https://example.com/page?keep=3",
		);
	});

	test("partial failure (1 of 2 filter lists fails) does not overwrite cache or drop the other list's rules", async () => {
		const { storage, getRemoveCalls } = withLocalStorage();
		setFilterListSources([
			{ name: "ListA", url: "https://filters.example/a.txt" },
			{ name: "ListB", url: "https://filters.example/b.txt" },
		]);
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/a.txt")) return new Response("$removeparam=utm_a", { status: 200 });
			return new Response("$removeparam=utm_b", { status: 200 });
		}) as typeof fetch;

		await initializeUrlCleanerWithRemoteLists();
		const cachedBefore = structuredClone(storage);
		expect(await cleanUrl("https://example.com/page?utm_a=1&utm_b=2&utm_new=3&keep=4")).toBe(
			"https://example.com/page?utm_new=3&keep=4",
		);

		// Verify parallel fetching and AbortSignal wiring while 1 of 2 sources fails.
		let started = 0;
		let bothStarted!: () => void;
		const parallelGate = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const signals: Array<AbortSignal | undefined> = [];

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init?.signal ?? undefined);
			started++;
			if (started === 2) bothStarted();
			await parallelGate;
			if (String(input).endsWith("/a.txt")) {
				return new Response("$removeparam=utm_a\n$removeparam=utm_new", { status: 200 });
			}
			return new Response("Service Unavailable", { status: 503 });
		}) as typeof fetch;

		await refreshFilterLists();

		expect(started).toBe(2);
		expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
		expect(getRemoveCalls()).toBe(0);
		expect(storage).toEqual(cachedBefore);
		expect(filterRuleCount()).toBe(2);
		// List B's rule is preserved and partial List A update was not applied.
		expect(await cleanUrl("https://example.com/page?utm_a=1&utm_b=2&utm_new=3&keep=4")).toBe(
			"https://example.com/page?utm_new=3&keep=4",
		);

		const loaded = await loadFilterLists();
		expect(loaded.allSucceeded).toBe(false);
	});

	test("expired cache on offline startup still hydrates stale rules instead of wiping URL cleaning", async () => {
		const { storage } = withLocalStorage();
		await saveCachedFilterLists(parseCompleteFilterList("$removeparam=utm_stale").rules);
		storage.filter_list_cache_expiry = Date.now() - 60_000;
		const expiredCacheBefore = structuredClone(storage);

		initializeWithFilterRules([]);
		expect(filterRuleCount()).toBe(0);

		setFilterListSources([
			{ name: "ListA", url: "https://filters.example/a.txt" },
			{ name: "ListB", url: "https://filters.example/b.txt" },
		]);
		globalThis.fetch = (async () => {
			throw new TypeError("Network offline");
		}) as typeof fetch;

		await initializeUrlCleanerWithRemoteLists();

		expect(filterRuleCount()).toBe(1);
		expect(storage).toEqual(expiredCacheBefore);
		expect(await cleanUrl("https://example.com/page?utm_stale=1&keep=2")).toBe(
			"https://example.com/page?keep=2",
		);
	});

	for (const scenario of [
		"fresh-cache-race",
		"expired-cache-slow-remote",
		"missing-cache-offline-cooldown",
	]) {
		test(`cold-start url canonizer: ${scenario}`, () => {
			const result = Bun.spawnSync(
				[process.execPath, `${import.meta.dir}/fixtures/url-canonizer-cold-start.ts`, scenario],
				{ timeout: 10_000 },
			);
			expect({
				status: result.exitCode,
				error: result.exitCode === 0 ? "" : result.stderr.toString(),
			}).toEqual({ status: 0, error: "" });
		});
	}
});
