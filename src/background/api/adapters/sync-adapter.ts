import * as v from "valibot";
import type { Article } from "../../../types/common";
import { baseSettingsSchema } from "../../../utils/base-settings-schema";
import type {
  ReadItLaterAPI,
  SavingArticle,
  SyncOptions,
  SyncResult,
} from "../read-it-later-adapter";

const STORAGE_KEY = "pouch-articles";
export const syncSettingsSchema = v.object({
  ...baseSettingsSchema.entries,
  backend: v.literal("sync"),
  apiConfig: v.object({}),
});
export type SyncSettings = v.InferInput<typeof syncSettingsSchema>;
export class SyncAdapter implements ReadItLaterAPI<SyncSettings> {
  public readonly displayName = "Sync (Built-in)";
  formConfig = [];
  async initialize(): Promise<void> {
    return Promise.resolve();
  }
  async testConnection(): Promise<boolean> {
    return Promise.resolve(true);
  }
  private async _getArticlesFromStorage(): Promise<Article[]> {
    const result = await browser.storage.sync.get(STORAGE_KEY);
    return result?.[STORAGE_KEY] || [];
  }
  private async _setArticlesInStorage(articles: Article[]): Promise<void> {
    await browser.storage.sync.set({ [STORAGE_KEY]: articles });
  }
  async saveArticle(article: SavingArticle): Promise<Article> {
    const articles = await this._getArticlesFromStorage();
    const newArticle: Article = {
      ...article,
      id: Date.now(),
      created_at: new Date().toISOString(),
    };
    articles.push(newArticle);
    await this._setArticlesInStorage(articles);
    return newArticle;
  }
  async deleteArticle(id: number): Promise<void> {
    const articles = await this._getArticlesFromStorage();
    const filteredArticles = articles.filter((a) => a.id !== id);
    await this._setArticlesInStorage(filteredArticles);
  }
  async sync(options?: SyncOptions): Promise<SyncResult> {
    const articles = await this._getArticlesFromStorage();
    const mode = options?.mode || "overwrite";

    return {
      articles,
      mode,
      metadata: {
        totalFetched: articles.length,
        totalProcessed: articles.length,
        lastSyncTimestamp: new Date().toISOString(),
      },
    };
  }
}
