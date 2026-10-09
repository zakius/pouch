import { createBookmarksAdapter } from "../background/api/adapters/bookmarks-adapter";
import { createInstapaperAdapter } from "../background/api/adapters/instapaper-adapter";
import { createKarakeepAdapter } from "../background/api/adapters/karakeep-adapter";
import { createLinkaceAdapter } from "../background/api/adapters/linkace-adapter";
import { createLinkwardenAdapter } from "../background/api/adapters/linkwarden-adapter";
import { createRaindropAdapter } from "../background/api/adapters/raindrop-adapter";
import { createWallabagAdapter } from "../background/api/adapters/wallabag-adapter";
import type { TokenManager } from "../background/token-manager";
import type { Settings } from "./settings";

export function getReadyAdapter(settings: Settings, tokens?: TokenManager) {
  switch (settings.backend) {
    case "bookmarks":
      return createBookmarksAdapter(settings);
    case "wallabag":
      return createWallabagAdapter(settings, tokens);
    case "instapaper":
      return createInstapaperAdapter(settings, tokens);
    case "raindrop":
      return createRaindropAdapter(settings);
    case "linkace":
      return createLinkaceAdapter(settings);
    case "karakeep":
      return createKarakeepAdapter(settings);
    case "linkwarden":
      return createLinkwardenAdapter(settings);
  }
}
