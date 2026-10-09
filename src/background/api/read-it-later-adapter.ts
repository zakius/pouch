import type { Article } from "../../types/common";

export interface SavingArticle {
  url: string;
  title: string;
}

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
