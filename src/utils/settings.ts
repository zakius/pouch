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
import type { baseSettingsSchema } from "./base-settings-schema";
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
  let result: Record<string, unknown>;
  try {
    result = await browser.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  } catch (error) {
    logger.error("Error reading settings from storage:", error);
    throw error;
  }
  logger.debug("Retrieved settings from storage:", result);
  try {
    const definedEntries = Object.fromEntries(
      Object.entries(result ?? {}).filter(([, value]) => value !== undefined),
    );
    const mergedSettings = { ...DEFAULT_SETTINGS, ...definedEntries };
    return v.parse(settingsSchema, mergedSettings);
  } catch (error) {
    logger.error("Error validating settings:", error);
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
