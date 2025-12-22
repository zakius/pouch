/**
 * Tokenized Adapter Interface
 *
 * Defines the interface for adapters that use token-based authentication
 * and can work with the centralized TokenManager.
 */

import type { TokenRefreshConfig } from "../token-manager";

export interface TokenizedAdapter {
  getServiceName(): string;

  getTokenRefreshConfig(): TokenRefreshConfig;

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
