/**
 * Tokenized Adapter Interface
 *
 * Defines the interface for adapters that use token-based authentication
 * and can work with the centralized TokenManager.
 */

import type { TokenRefreshConfig } from "../token-manager";

export interface TokenizedAdapter {
	/**
	 * Get the service name for token management
	 */
	getServiceName(): string;

	/**
	 * Get the token refresh configuration
	 */
	getTokenRefreshConfig(): TokenRefreshConfig;

	/**
	 * Create token metadata from authentication response
	 */
	createTokenMetadata(tokenData: Record<string, unknown>): {
		accessToken: string;
		refreshToken: string;
		tokenType: string;
		expiresAt: number;
		issuedAt: number;
		scope?: string;
		refreshCount: number;
	};

	/**
	 * Get the base URL for the service
	 */
	getBaseUrl(): string;

	/**
	 * Get the authentication endpoint URL
	 */
	getAuthEndpoint(): string;
}
