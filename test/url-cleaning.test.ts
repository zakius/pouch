import { test, expect, describe, beforeEach } from "bun:test";
import { 
	cleanUrl, 
	initializeWithRawFilterLists
} from "../src/utils/filter-list-url-cleaner";
import { readFileSync } from "fs";

describe("Filter List URL Cleaning", () => {
	beforeEach(async () => {
		// Load test filter list content directly
		const testFilterContent = readFileSync("test-filters.txt", "utf-8");
		await initializeWithRawFilterLists([
			{ name: "TestFilters", content: testFilterContent }
		]);
	});

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
		// Test ?from=glia^$removeparam=from pattern
		const input = "https://example.com/test?from=glia&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?keep=this");
	});

	test("should not remove parameters with different values in query patterns", async () => {
		// Test that ?from=glia^$removeparam=from only matches from=glia, not from=other
		const input = "https://example.com/test?from=other&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://example.com/test?from=other&keep=this");
	});

	test("should handle exception rules for utm_medium", async () => {
		// Test that @@||rd.bizrate.com^$removeparam=utm_medium protects utm_medium on rd.bizrate.com
		const input = "https://rd.bizrate.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://rd.bizrate.com/test?utm_medium=email&keep=this");
	});

	test("should handle exception rules for utm_source", async () => {
		// Test that @@||special-site.com^$removeparam=utm_source protects utm_source on special-site.com
		const input = "https://special-site.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://special-site.com/test?utm_source=newsletter&keep=this");
	});

	test("should apply global rules when no exception rules match", async () => {
		// Test that global utm_medium and utm_source removal works on sites without exceptions
		const input = "https://normal-site.com/test?utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://normal-site.com/test?keep=this");
	});

    test("should apply global rules when no exception rules match", async () => {
		// Test that global utm_medium and utm_source removal works on sites without exceptions
		const input = "https://normal-site.com/test?utm_medium=email&utm_source=newsletter&keep=this&si=test";
		const output = await cleanUrl(input);
		expect(output).toBe("https://normal-site.com/test?keep=this");
	});

	test("should handle mixed query parameter and exception rules", async () => {
		// Test that query parameter patterns work alongside exception rules
		const input = "https://rd.bizrate.com/test?from=glia&utm_medium=email&utm_source=newsletter&keep=this";
		const output = await cleanUrl(input);
		expect(output).toBe("https://rd.bizrate.com/test?utm_medium=email&keep=this");
	});
});