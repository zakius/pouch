import { logger } from "./logger";

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

// Extended list of common tracking parameters
const EXTENDED_TRACKING_PARAMETERS = [
	// Google Analytics & Ads
	"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
	"gclid", "dclid", "gclsrc", "wbraid", "gbraid",
	
	// Facebook/Meta
	"fbclid", "fb_action_ids", "fb_action_types", "fb_source",
	
	// Microsoft/Bing
	"msclkid", "msclickid",
	
	// Twitter/X
	"twclid", "s", "t",
	
	// LinkedIn
	"li_fat_id", "li_source", "li_medium",
	
	// HubSpot
	"__hsfp", "__hssc", "__hstc", "_hsenc", "_hsmi",
	
	// Mailchimp
	"mc_cid", "mc_eid",
	
	// Other common tracking parameters
	"__s", "_ke", "_kx", "igshid", "oly_anon_id", "oly_enc_id",
	"rb_clickid", "s_kwcid", "vero_conv", "vero_id", "wickedid", "yclid",
	
	// Amazon
	"tag", "linkCode", "camp", "creative", "creativeASIN",
	
	// YouTube
	"feature", "list", "index", "t",
	
	// Reddit
	"ref_source", "ref_campaign",
	
	// Pinterest
	"pp", "epik",
	
	// Snapchat
	"sc_cid",
	
	// TikTok
	"tt_medium", "tt_content",
	
	// Additional common ones
	"ref", "referrer", "source", "campaign", "medium", "affiliate",
	"partner", "promo", "discount", "coupon", "voucher", "offer",
	"click_id", "clickid", "click", "clid", "cid", "aid", "pid",
	"rid", "sid", "vid", "uid", "bid", "tid", "eid", "oid",
	"ref_id", "refid", "refcode", "promocode", "promo_code",
	"affiliate_id", "affiliateid", "affid", "affiliate_code",
	"tracking_id", "trackingid", "trackid", "track_code",
	"session_id", "sessionid", "sessid", "session",
	"user_id", "userid", "uid", "user",
	"visitor_id", "visitorid", "vid", "visitor",
	"customer_id", "customerid", "cid", "customer",
	"subscriber_id", "subscriberid", "subid", "subscriber",
	"member_id", "memberid", "mid", "member",
	"account_id", "accountid", "aid", "account",
	"profile_id", "profileid", "pid", "profile",
	"device_id", "deviceid", "did", "device",
	"browser_id", "browserid", "bid", "browser",
	"ip_address", "ipaddress", "ip", "ip_addr",
	"location", "geo", "country", "region", "city",
	"language", "lang", "locale", "lng",
	"currency", "curr", "money", "price",
	"category", "cat", "type", "kind",
	"brand", "manufacturer", "maker", "producer",
	"product", "item", "sku", "model", "variant",
	"color", "size", "weight", "dimension",
	"quantity", "qty", "amount", "count",
	"price", "cost", "value", "total", "sum",
	"discount", "sale", "off", "percent", "pct",
	"free", "trial", "demo", "sample", "test",
	"new", "latest", "recent", "updated", "modified",
	"popular", "trending", "featured", "recommended",
	"best", "top", "rated", "reviewed", "review",
	"comment", "feedback", "rating", "score",
	"share", "social", "facebook", "twitter", "linkedin",
	"email", "newsletter", "subscribe", "unsubscribe",
	"notification", "alert", "reminder", "update",
	"download", "upload", "file", "document", "pdf",
	"video", "audio", "image", "photo", "picture",
	"gallery", "album", "collection", "library",
	"search", "query", "keyword", "term", "phrase",
	"filter", "sort", "order", "arrange", "group",
	"page", "pagination", "offset", "limit", "count",
	"next", "previous", "first", "last", "begin", "end",
	"start", "stop", "pause", "resume", "continue",
	"play", "pause", "stop", "rewind", "forward",
	"volume", "mute", "unmute", "sound", "audio",
	"fullscreen", "windowed", "minimize", "maximize",
	"close", "open", "show", "hide", "display",
	"visible", "invisible", "active", "inactive",
	"enabled", "disabled", "on", "off", "true", "false",
	"yes", "no", "1", "0", "null", "undefined", "empty"
];

async function getExtendedTrackingParameters(): Promise<string[]> {
	// Return our comprehensive list of tracking parameters
	logger.info(`Using extended tracking parameter list with ${EXTENDED_TRACKING_PARAMETERS.length} parameters`);
	return EXTENDED_TRACKING_PARAMETERS;
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
	logger.info("Refreshing tracking parameter list using extended list...");
	const extendedList = await getExtendedTrackingParameters();
	if (extendedList.length > 0) {
		const finalList = mergeAndDeduplicate(
			extendedList,
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
			"Failed to get extended tracking parameter list. Will continue using the existing or default list.",
		);
	}
}
