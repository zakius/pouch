import { spyOn } from "bun:test";
import { Effect } from "effect";
import * as factory from "../../src/utils/adapter-factory";
import { createBookmarksAdapter } from "../../src/background/api/adapters/bookmarks-adapter";
import {
  BrowserFailure,
  runOperation,
  type EffectAdapter,
} from "../../src/background/api/effect-adapter";
import type { SavingArticle, SyncOptions } from "../../src/background/api/read-it-later-adapter";
import type { Settings } from "../../src/utils/settings";
import type { BookmarksSettings } from "../../src/utils/settings-schemas";

let ready: EffectAdapter | undefined;
const api = () => ready ?? Effect.runSync(Effect.die("bookmarks fixture is not initialized"));
/** Promise seams coordination tests gate and spy on; by default they use the bookmarks adapter. */
export const bookmarks = {
  async initialize(settings: Settings) {
    ready = await runOperation(
      createBookmarksAdapter({ ...settings, backend: "bookmarks", apiConfig: {} } as BookmarksSettings),
    );
  },
  saveArticle: (article: SavingArticle) => runOperation(api().saveArticle(article)),
  deleteArticle: (id: number | string) => runOperation(api().deleteArticle(id)),
  sync: (options?: SyncOptions) => runOperation(api().sync(options)),
  testConnection: () => runOperation(api().testConnection),
};

export function mockReadyAdapter() {
  function controlled<A>(promise: () => Promise<A>) {
    return Effect.tryPromise({
      try: promise,
      catch: (error) =>
        new BrowserFailure(error instanceof Error ? error.message : "test operation"),
    });
  }
  return spyOn(factory, "getReadyAdapter").mockImplementation((settings) =>
    Effect.gen(function* () {
      yield* controlled(() => bookmarks.initialize(settings));
      const ready: EffectAdapter = {
        saveArticle: (article) => controlled(() => bookmarks.saveArticle(article)),
        deleteArticle: (id) => controlled(() => bookmarks.deleteArticle(id)),
        sync: (options) => controlled(() => bookmarks.sync(options)),
        testConnection: controlled(() => bookmarks.testConnection()).pipe(Effect.as(true as const)),
      };
      return ready;
    }),
  );
}
