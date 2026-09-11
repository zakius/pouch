import * as v from "valibot";
import {
  bookmarksSettingsSchema,
  instapaperSettingsSchema,
  karakeepSettingsSchema,
  linkaceSettingsSchema,
  linkwardenSettingsSchema,
  raindropSettingsSchema,
  wallabagSettingsSchema,
} from "./settings-schemas";
import { baseSettingsSchema } from "./base-settings-schema";
import { LogLevel } from "./log-levels";
import { logger } from "./logger";
export const settingsSchema = v.variant("backend", [
  bookmarksSettingsSchema,
  wallabagSettingsSchema,
  raindropSettingsSchema,
  instapaperSettingsSchema,
  karakeepSettingsSchema,
  linkaceSettingsSchema,
  linkwardenSettingsSchema,
]);
export type Settings = v.InferInput<typeof settingsSchema>;
export type BaseSettings = v.InferInput<typeof baseSettingsSchema>;
export const DEFAULT_SETTINGS: Settings = {
  backend: "bookmarks",
  apiConfig: {},
  logLevel: LogLevel.ERROR,
  normalizeOnSave: false,
  normalizeOnCompare: false,
};
export async function getSettings(): Promise<Settings> {
  try {
    const result = await browser.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
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
