import { logger } from "./logger";

const REMOTE_LIST_URL =
	"https://raw.githubusercontent.com/newhouse/url-tracking-stripper/master/src/data/param-list.csv";
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
async function fetchAndParseList(): Promise<string[]> {
	try {
		const response = await fetch(REMOTE_LIST_URL);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const csvText = await response.text();
		const parameters = csvText.split(",").map((param) => param.trim());
		if (parameters.length === 0) {
			throw new Error("Parsed list is empty");
		}
		return parameters;
	} catch (error) {
		logger.error(
			"Failed to fetch or parse remote tracking parameter list:",
			error,
		);
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
	logger.info("Refreshing tracking parameter list from remote source...");
	const remoteList = await fetchAndParseList();
	if (remoteList.length > 0) {
		const finalList = mergeAndDeduplicate(
			remoteList,
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
			"Failed to fetch new tracking parameter list. Will continue using the existing or default list.",
		);
	}
}
