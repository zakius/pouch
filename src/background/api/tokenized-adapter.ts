/**
 * Tokenized Adapter Interface
 *
 * Defines the interface for adapters that use token-based authentication
 * and can work with the centralized TokenManager.
 */

import type { TokenManager, TokenRefreshConfig } from "../token-manager";

export interface TokenizedAdapter {
  readonly tokens: TokenManager;

  getServiceName(): string;

  getTokenRefreshConfig(): TokenRefreshConfig | null;

  createTokenMetadata(tokenData: Record<string, unknown>): {
    accessToken: string;
    refreshToken: string;
    tokenType: string;
    expiresAt: number;
    issuedAt: number;
    scope?: string;
    refreshCount: number;
  };

  getBaseUrl(): string;

  getAuthEndpoint(): string;

  reAuthenticate?(): Promise<void>;
}
