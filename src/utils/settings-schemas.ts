import * as v from "valibot";
import { baseSettingsSchema } from "./base-settings-schema";

export const bookmarksSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("bookmarks"),
  apiConfig: v.object({}),
});
export type BookmarksSettings = v.InferInput<typeof bookmarksSettingsSchema>;

export const instapaperConfigSchema = v.object({
  consumerKey: v.string(),
  consumerSecret: v.string(),
  username: v.string(),
  password: v.optional(v.string()),
});
export const instapaperSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("instapaper"),
  apiConfig: instapaperConfigSchema,
});
export type InstapaperSettings = v.InferInput<typeof instapaperSettingsSchema>;

export const karakeepConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  token: v.string(),
});
export const karakeepSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("karakeep"),
  apiConfig: karakeepConfigSchema,
});
export type KarakeepSettings = v.InferInput<typeof karakeepSettingsSchema>;

export const linkaceConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  token: v.string(),
});
export const linkaceSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("linkace"),
  apiConfig: linkaceConfigSchema,
});
export type LinkaceSettings = v.InferInput<typeof linkaceSettingsSchema>;

export const linkwardenConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  token: v.string(),
});
export const linkwardenSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("linkwarden"),
  apiConfig: linkwardenConfigSchema,
});
export type LinkwardenSettings = v.InferInput<typeof linkwardenSettingsSchema>;

export const raindropConfigSchema = v.object({
  apiKey: v.string(),
});
export const raindropSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("raindrop"),
  apiConfig: raindropConfigSchema,
});
export type RaindropSettings = v.InferInput<typeof raindropSettingsSchema>;

export const wallabagConfigSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  clientId: v.string(),
  clientSecret: v.string(),
  username: v.string(),
  password: v.optional(v.string()),
});
export const wallabagSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("wallabag"),
  apiConfig: wallabagConfigSchema,
});
export type WallabagSettings = v.InferInput<typeof wallabagSettingsSchema>;
