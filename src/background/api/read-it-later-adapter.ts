import type { Article } from "../../types/common";

export interface SavingArticle {
  url: string;
  title: string;
  /** True for unvisited hyperlinks (e.g. context-menu "Save link") where the server should follow redirects. */
  resolveFinalUrl?: boolean;
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
  maxKnownNumericId?: number;
}
