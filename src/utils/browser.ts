export const isFirefox: boolean =
	typeof browser !== "undefined" && /firefox/i.test(navigator.userAgent);
export const isChromium: boolean =
	typeof chrome !== "undefined" && /chrome|chromium/i.test(navigator.userAgent);
export const isMV3: boolean =
	typeof chrome !== "undefined" &&
	browser.runtime &&
	browser.runtime.getManifest &&
	browser.runtime.getManifest().manifest_version === 3;
export const b = isFirefox ? browser : chrome;
export const features = {
	hasPageAction: typeof browser.pageAction !== "undefined",
	hasThemeApi: typeof browser.theme?.getCurrent === "function",
	isManifestV3: browser.runtime.getManifest().manifest_version === 3,
};
