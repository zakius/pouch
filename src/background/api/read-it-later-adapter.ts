import type { Article } from "../../types/common";
import type { BaseSettings } from "../../utils/settings";

export interface SavingArticle {
  url: string;
  title: string;
}

export interface FormConfigItem<TObject> {
  name: keyof TObject;
  label: string;
}

export type FormConfig = FormConfigItem<Record<string, unknown>>[];

export type SyncMode = "overwrite" | "update";

export interface SyncResult {
  articles: Article[];
  mode: SyncMode;
  metadata?: {
    totalFetched?: number;
    totalProcessed?: number;
    lastSyncTimestamp?: string;
    apiVersion?: string;
    syncDecision?: {
      reason: string;
      wasFullSync: boolean;
      timeSinceLastFullSync?: number;
      isBrowserIdle?: boolean;
    };
  };
}

export interface SyncOptions {
  mode?: SyncMode;
  forceRefresh?: boolean;
  lastSyncTimestamp?: string;
  lastFullSyncTimestamp?: number;
  isBrowserIdle?: boolean;
}

export interface ReadItLaterAPI<T extends BaseSettings = BaseSettings> {
  displayName: string;
  initialize(settings: T): Promise<void>;
  testConnection(): Promise<boolean>;
  saveArticle(article: SavingArticle): Promise<Article>;
  deleteArticle(id: number | string): Promise<void>;
  sync(options?: SyncOptions): Promise<SyncResult>;
  formConfig: FormConfig;
}
