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

type FormField = { name: string; label: string };
/** What the options page shows per backend, kept apart from the adapters so it needs no Effect code. */
export const backendForms: Record<
  "bookmarks" | "wallabag" | "instapaper" | "raindrop" | "karakeep" | "linkace" | "linkwarden",
  { displayName: string; formConfig: FormField[] }
> = {
  bookmarks: { displayName: "Browser Bookmarks", formConfig: [] },
  wallabag: {
    displayName: "Wallabag",
    formConfig: [
      { name: "url", label: "API URL" },
      { name: "clientId", label: "Client ID" },
      { name: "clientSecret", label: "Client Secret" },
      { name: "username", label: "Username" },
      { name: "password", label: "Password" },
    ],
  },
  instapaper: {
    displayName: "Instapaper",
    formConfig: [
      { name: "consumerKey", label: "OAuth Consumer Key" },
      { name: "consumerSecret", label: "OAuth Consumer Secret" },
      { name: "username", label: "Instapaper Username" },
      { name: "password", label: "Instapaper Password" },
    ],
  },
  raindrop: {
    displayName: "Raindrop.io",
    formConfig: [{ name: "apiKey", label: "API Key (Test Token)" }],
  },
  karakeep: {
    displayName: "Karakeep",
    formConfig: [
      { name: "url", label: "API URL" },
      { name: "token", label: "API Token" },
    ],
  },
  linkace: {
    displayName: "LinkAce",
    formConfig: [
      { name: "url", label: "API URL" },
      { name: "token", label: "API Token" },
    ],
  },
  linkwarden: {
    displayName: "Linkwarden",
    formConfig: [
      // Sync uses /api/v1/search, which older servers answer with HTTP 404.
      { name: "url", label: "API URL (needs Linkwarden 2.10 or later)" },
      { name: "token", label: "API Token" },
    ],
  },
};
