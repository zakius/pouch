import { createBookmarksAdapter } from "../background/api/adapters/bookmarks-adapter";
import type {
  BookmarksSettings,
  InstapaperSettings,
  RaindropSettings,
  WallabagSettings,
} from "./settings-schemas";
import { BookmarksAdapter } from "../background/api/adapters/bookmarks-adapter";
import {
  InstapaperAdapter,
  createInstapaperAdapter,
} from "../background/api/adapters/instapaper-adapter";
import { KarakeepAdapter } from "../background/api/adapters/karakeep-adapter";
import { LinkaceAdapter } from "../background/api/adapters/linkace-adapter";
import { LinkwardenAdapter } from "../background/api/adapters/linkwarden-adapter";
import {
  RaindropAdapter,
  createRaindropAdapter,
} from "../background/api/adapters/raindrop-adapter";
import {
  WallabagAdapter,
  createWallabagAdapter,
} from "../background/api/adapters/wallabag-adapter";
import type { ReadItLaterAPI } from "../background/api/read-it-later-adapter";
import type { TokenManager } from "../background/token-manager";

const adapters = {
  bookmarks: BookmarksAdapter,
  wallabag: WallabagAdapter,
  instapaper: InstapaperAdapter,
  raindrop: RaindropAdapter,
  karakeep: KarakeepAdapter,
  linkace: LinkaceAdapter,
  linkwarden: LinkwardenAdapter,
};

export const availableBackends = Object.keys(adapters) as (keyof typeof adapters)[];

export function getAdapter(backend: keyof typeof adapters, tokens?: TokenManager): ReadItLaterAPI {
  const AdapterClass: (new (tokens?: TokenManager) => ReadItLaterAPI) | undefined =
    adapters[backend];
  if (!AdapterClass) {
    throw new Error("Invalid backend specified");
  }
  return new AdapterClass(tokens);
}

export function getReadyAdapter(
  settings: BookmarksSettings | WallabagSettings | InstapaperSettings | RaindropSettings,
  tokens?: TokenManager,
) {
  switch (settings.backend) {
    case "bookmarks":
      return createBookmarksAdapter(settings);
    case "wallabag":
      return createWallabagAdapter(settings, tokens);
    case "instapaper":
      return createInstapaperAdapter(settings, tokens);
    case "raindrop":
      return createRaindropAdapter(settings);
  }
}
