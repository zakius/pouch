import { spyOn } from "bun:test";
import { Effect } from "effect";
import * as factory from "../../src/utils/adapter-factory";
import { BookmarksAdapter } from "../../src/background/api/adapters/bookmarks-adapter";
import { BrowserFailure, type EffectAdapter } from "../../src/background/api/effect-adapter";

// Keep coordination tests' controlled Promise gates behind the migrated ready-adapter seam.
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
      const api = new BookmarksAdapter();
      yield* controlled(() => api.initialize(settings));
      const ready: EffectAdapter = {
        displayName: api.displayName,
        formConfig: api.formConfig,
        saveArticle: (article) => controlled(() => api.saveArticle(article)),
        deleteArticle: (id) => controlled(() => api.deleteArticle(id)),
        sync: (options) => controlled(() => api.sync(options)),
        testConnection: controlled(() => api.testConnection()).pipe(Effect.as(true as const)),
      };
      return ready;
    }),
  );
}
