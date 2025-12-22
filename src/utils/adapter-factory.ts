import { BookmarksAdapter } from "../background/api/adapters/bookmarks-adapter";
import { InstapaperAdapter } from "../background/api/adapters/instapaper-adapter";
import { KarakeepAdapter } from "../background/api/adapters/karakeep-adapter";
import { LinkaceAdapter } from "../background/api/adapters/linkace-adapter";
import { LinkwardenAdapter } from "../background/api/adapters/linkwarden-adapter";
import { RaindropAdapter } from "../background/api/adapters/raindrop-adapter";
import { WallabagAdapter } from "../background/api/adapters/wallabag-adapter";
import type { ReadItLaterAPI } from "../background/api/read-it-later-adapter";

const adapters = {
  bookmarks: BookmarksAdapter,
  wallabag: WallabagAdapter,
  instapaper: InstapaperAdapter,
  raindrop: RaindropAdapter,
  karakeep: KarakeepAdapter,
  linkace: LinkaceAdapter,
  linkwarden: LinkwardenAdapter,
};

const adapterCache = new Map<keyof typeof adapters, ReadItLaterAPI>();

export const availableBackends = Object.keys(adapters) as (keyof typeof adapters)[];

export function getAdapter(backend: keyof typeof adapters): ReadItLaterAPI {
  const cachedAdapter = adapterCache.get(backend);
  if (cachedAdapter) {
    return cachedAdapter;
  }

  const AdapterClass = adapters[backend];
  if (AdapterClass) {
    const instance = new AdapterClass();
    adapterCache.set(backend, instance);
    return instance;
  }
  throw new Error("Invalid backend specified");
}
