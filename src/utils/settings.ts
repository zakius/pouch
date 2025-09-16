import * as v from "valibot";
import { bookmarksSettingsSchema } from "../background/api/adapters/bookmarks-adapter";
import { instapaperSettingsSchema } from "../background/api/adapters/instapaper-adapter";
import { karakeepSettingsSchema } from "../background/api/adapters/karakeep-adapter";
import { linkwardenSettingsSchema } from "../background/api/adapters/linkwarden-adapter";
import { raindropSettingsSchema } from "../background/api/adapters/raindrop-adapter";
import { syncSettingsSchema } from "../background/api/adapters/sync-adapter";
import { wallabagSettingsSchema } from "../background/api/adapters/wallabag-adapter";
import type { baseSettingsSchema } from "./base-settings-schema";
import { LogLevel } from "./log-levels";
import { logger } from "./logger";
export const settingsSchema = v.variant("backend", [
	bookmarksSettingsSchema,
	wallabagSettingsSchema,
	raindropSettingsSchema,
	instapaperSettingsSchema,
	karakeepSettingsSchema,
	linkwardenSettingsSchema,
	syncSettingsSchema,
]);
export type Settings = v.Input<typeof settingsSchema>;
export type BaseSettings = v.Input<typeof baseSettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
	backend: "sync",
	apiConfig: {},
	logLevel: LogLevel.ERROR,
	normalizeOnSave: false,
	normalizeOnCompare: false,
};
export async function getSettings(): Promise<Settings> {
	try {
		const result = await browser.storage.sync.get(
			Object.keys(DEFAULT_SETTINGS),
		);
		logger.debug("Retrieved settings from storage:", result);
		const mergedSettings = { ...DEFAULT_SETTINGS, ...result };
		return v.parse(settingsSchema, mergedSettings);
	} catch (error) {
		logger.error("Error getting or validating settings:", error);
		return DEFAULT_SETTINGS;
	}
}
export async function saveSettings(settings: Settings) {
	try {
		const validatedSettings = v.parse(settingsSchema, settings);
		logger.debug("Saving settings:", validatedSettings);
		await browser.storage.sync.set(validatedSettings);
	} catch (error) {
		logger.error("Error saving settings:", error);
		throw error;
	}
}
