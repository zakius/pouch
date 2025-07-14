import { InstapaperAdapter } from "../background/api/adapters/instapaper-adapter";
import { KarakeepAdapter } from "../background/api/adapters/karakeep-adapter";
import { LinkwardenAdapter } from "../background/api/adapters/linkwarden-adapter";
import { RaindropAdapter } from "../background/api/adapters/raindrop-adapter";
import { ReadeckAdapter } from "../background/api/adapters/readeck-adapter";
import { ShioriAdapter } from "../background/api/adapters/shiori-adapter";
import { SyncAdapter } from "../background/api/adapters/sync-adapter";
import { WallabagAdapter } from "../background/api/adapters/wallabag-adapter";
import type { ReadItLaterAPI } from "../background/api/read-it-later-adapter";

const adapters = {
	wallabag: WallabagAdapter,
	shiori: ShioriAdapter,
	instapaper: InstapaperAdapter,
	raindrop: RaindropAdapter,
	karakeep: KarakeepAdapter,
	linkwarden: LinkwardenAdapter,
	readeck: ReadeckAdapter,
	sync: SyncAdapter,
};
export const availableBackends = Object.keys(
	adapters,
) as (keyof typeof adapters)[];
export function createAdapter(backend: keyof typeof adapters): ReadItLaterAPI {
	const AdapterClass = adapters[backend];
	if (AdapterClass) {
		return new AdapterClass();
	}
	throw new Error("Invalid backend specified");
}
