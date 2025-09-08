import { logger } from "./logger";
import { TidyURL } from "@protontech/tidy-url";

const STORAGE_KEY = "tracking_parameters_list";
const LAST_UPDATED_KEY = "tracking_parameters_last_updated";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ESSENTIAL_TRACKING_PARAMETERS = ["gclid", "dclid", "fbclid", "msclkid"];
const DEFAULT_TRACKING_PARAMETERS = [
	"__hsfp",
	"__hssc",
	"__hstc",
	"__s",
	"_hsenc",
	"_hsmi",
	"_ke",
	"_kx",
	"igshid",
	"li_fat_id",
	"mc_cid",
	"mc_eid",
	"oly_anon_id",
	"oly_enc_id",
	"rb_clickid",
	"s_kwcid",
	"twclid",
	"vero_conv",
	"vero_id",
	"wickedid",
	"yclid",
];

function mergeAndDeduplicate(...lists: string[][]): string[] {
	const combined = lists.flat();
	return [...new Set(combined)];
}

async function getTidyUrlTrackingParameters(): Promise<string[]> {
	try {
		// TidyURL has built-in tracking parameter detection
		// We'll use a test URL to extract the parameters it would remove
		const testUrl = "https://example.com/test?utm_source=test&gclid=test&fbclid=test&__hstc=test&custom_param=keep";
		const cleaned = TidyURL.clean(testUrl);
		
		// Extract parameters that were removed by comparing original and cleaned URLs
		const originalUrl = new URL(testUrl);
		const cleanedUrl = new URL(cleaned.url);
		
		const removedParams: string[] = [];
		for (const [key] of originalUrl.searchParams) {
			if (!cleanedUrl.searchParams.has(key)) {
				removedParams.push(key);
			}
		}
		
		logger.info(`TidyURL detected ${removedParams.length} tracking parameters`);
		return removedParams;
	} catch (error) {
		logger.error("Failed to get tracking parameters from TidyURL:", error);
		return [];
	}
}
export async function getTrackingParameters(): Promise<string[]> {
	const result = await browser.storage.local.get(STORAGE_KEY);
	const storedList = result[STORAGE_KEY];
	if (storedList && storedList.length > 0) {
		return storedList;
	}
	return mergeAndDeduplicate(
		DEFAULT_TRACKING_PARAMETERS,
		ESSENTIAL_TRACKING_PARAMETERS,
	);
}
export async function updateTrackingParametersIfNeeded(): Promise<void> {
	const lastUpdatedResult = await browser.storage.local.get(LAST_UPDATED_KEY);
	const lastUpdated = lastUpdatedResult[LAST_UPDATED_KEY] || 0;
	if (Date.now() - lastUpdated < REFRESH_INTERVAL_MS) {
		logger.info("Tracking parameter list is up-to-date. Skipping refresh.");
		return;
	}
	logger.info("Refreshing tracking parameter list using TidyURL...");
	const tidyUrlList = await getTidyUrlTrackingParameters();
	if (tidyUrlList.length > 0) {
		const finalList = mergeAndDeduplicate(
			tidyUrlList,
			ESSENTIAL_TRACKING_PARAMETERS,
			DEFAULT_TRACKING_PARAMETERS,
		);
		await browser.storage.local.set({ [STORAGE_KEY]: finalList });
		await browser.storage.local.set({
			[LAST_UPDATED_KEY]: Date.now(),
		});
		logger.info(
			`Successfully updated tracking parameter list with ${finalList.length} items.`,
		);
	} else {
		logger.warn(
			"Failed to get tracking parameter list from TidyURL. Will continue using the existing or default list.",
		);
	}
}
