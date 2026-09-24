import { BookmarksAdapter } from "../background/api/adapters/bookmarks-adapter";
import { InstapaperAdapter } from "../background/api/adapters/instapaper-adapter";
import { KarakeepAdapter } from "../background/api/adapters/karakeep-adapter";
import { LinkaceAdapter } from "../background/api/adapters/linkace-adapter";
import { LinkwardenAdapter } from "../background/api/adapters/linkwarden-adapter";
import { RaindropAdapter } from "../background/api/adapters/raindrop-adapter";
import { WallabagAdapter } from "../background/api/adapters/wallabag-adapter";
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
