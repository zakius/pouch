/**
 * Centralized Token Manager
 * 
 * Handles token storage, refresh, and lifecycle management for all API adapters.
 * Provides a unified interface for token-based authentication across different services.
 */

import { logger } from "../utils/logger";

export interface TokenMetadata {
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	expiresAt: number;
	issuedAt: number;
	scope?: string;
	lastRefreshAttempt?: number;
	refreshCount: number;
	serviceName: string;
}

export interface TokenRefreshConfig {
	serviceName: string;
	refreshUrl: string;
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	additionalParams?: Record<string, string>;
}

export interface TokenManagerConfig {
	storageKey: string;
	refreshBufferMs: number;
	maxRefreshAttempts: number;
	refreshCooldownMs: number;
}

export class TokenManager {
	private tokens: Map<string, TokenMetadata> = new Map();
	private refreshTimers: Map<string, number> = new Map();
	private config: TokenManagerConfig;

	constructor(config: Partial<TokenManagerConfig> = {}) {
		this.config = {
			storageKey: "api_tokens",
			refreshBufferMs: 5 * 60 * 1000, // 5 minutes
			maxRefreshAttempts: 3,
			refreshCooldownMs: 30 * 1000, // 30 seconds
			...config,
		};
	}

	/**
	 * Store a token for a service
	 */
	public storeToken(serviceName: string, tokenData: Omit<TokenMetadata, "serviceName">): void {
		const tokenMetadata: TokenMetadata = {
			...tokenData,
			serviceName,
		};

		this.tokens.set(serviceName, tokenMetadata);
		this.scheduleTokenRefresh(serviceName);
		this.persistTokens();

		logger.info(`Token stored for ${serviceName}`, {
			expiresAt: new Date(tokenMetadata.expiresAt).toISOString(),
			scope: tokenMetadata.scope,
		});
	}

	/**
	 * Get a valid access token for a service
	 */
	public async getAccessToken(serviceName: string): Promise<string> {
		const token = this.tokens.get(serviceName);
		if (!token) {
			throw new Error(`No token found for service: ${serviceName}`);
		}

		// Check if token needs refresh
		if (this.needsRefresh(token)) {
			await this.refreshToken(serviceName);
		}

		const updatedToken = this.tokens.get(serviceName);
		if (!updatedToken) {
			throw new Error(`Token refresh failed for service: ${serviceName}`);
		}

		return updatedToken.accessToken;
	}

	/**
	 * Get token metadata for a service
	 */
	public getTokenMetadata(serviceName: string): TokenMetadata | null {
		return this.tokens.get(serviceName) || null;
	}

	/**
	 * Check if a token is valid and not expired
	 */
	public isTokenValid(serviceName: string): boolean {
		const token = this.tokens.get(serviceName);
		if (!token) {
			return false;
		}
		return Date.now() < token.expiresAt;
	}

	/**
	 * Refresh a token for a service
	 */
	public async refreshToken(serviceName: string, refreshConfig?: TokenRefreshConfig): Promise<void> {
		const token = this.tokens.get(serviceName);
		if (!token) {
			throw new Error(`No token found for service: ${serviceName}`);
		}

		// Prevent multiple simultaneous refresh attempts
		if (token.lastRefreshAttempt && 
			Date.now() - token.lastRefreshAttempt < this.config.refreshCooldownMs) {
			logger.debug(`Refresh cooldown active for ${serviceName}`);
			return;
		}

		token.lastRefreshAttempt = Date.now();
		token.refreshCount++;

		// If we've exceeded max refresh attempts, clear the token
		if (token.refreshCount > this.config.maxRefreshAttempts) {
			logger.warn(`Max refresh attempts exceeded for ${serviceName}, clearing token`);
			this.clearToken(serviceName);
			throw new Error(`Max refresh attempts exceeded for ${serviceName}`);
		}

		if (!token.refreshToken) {
			logger.warn(`No refresh token available for ${serviceName}`);
			this.clearToken(serviceName);
			throw new Error(`No refresh token available for ${serviceName}`);
		}

		try {
			// Use provided refresh config or create default one
			const config = refreshConfig || this.createDefaultRefreshConfig(serviceName, token);
			
			const response = await fetch(config.refreshUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: config.clientId,
					client_secret: config.clientSecret,
					refresh_token: config.refreshToken,
					...config.additionalParams,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				logger.error(`Token refresh failed for ${serviceName}: ${response.status} ${errorText}`);
				this.clearToken(serviceName);
				throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
			}

			const tokenData = await response.json();
			this.updateTokenFromResponse(serviceName, tokenData);
			
			logger.info(`Token refreshed successfully for ${serviceName}`, {
				expiresAt: new Date(this.tokens.get(serviceName)!.expiresAt).toISOString(),
				refreshCount: this.tokens.get(serviceName)!.refreshCount,
			});

		} catch (error) {
			logger.error(`Token refresh error for ${serviceName}:`, error);
			this.clearToken(serviceName);
			throw error;
		}
	}

	/**
	 * Clear a token for a service
	 */
	public clearToken(serviceName: string): void {
		this.tokens.delete(serviceName);
		this.clearRefreshTimer(serviceName);
		this.persistTokens();
		logger.info(`Token cleared for ${serviceName}`);
	}

	/**
	 * Clear all tokens
	 */
	public clearAllTokens(): void {
		this.tokens.clear();
		this.refreshTimers.forEach((timer) => clearTimeout(timer));
		this.refreshTimers.clear();
		this.persistTokens();
		logger.info("All tokens cleared");
	}

	/**
	 * Get health information for all tokens
	 */
	public getTokenHealth(): Record<string, { isValid: boolean; expiresAt?: string; refreshCount?: number }> {
		const health: Record<string, { isValid: boolean; expiresAt?: string; refreshCount?: number }> = {};
		
		for (const [serviceName, token] of this.tokens) {
			health[serviceName] = {
				isValid: Date.now() < token.expiresAt,
				expiresAt: new Date(token.expiresAt).toISOString(),
				refreshCount: token.refreshCount,
			};
		}
		
		return health;
	}

	/**
	 * Load tokens from storage
	 */
	public async loadTokens(): Promise<void> {
		try {
			const result = await browser.storage.local.get(this.config.storageKey);
			const storedTokens = result[this.config.storageKey];
			
			if (storedTokens) {
				this.tokens = new Map(storedTokens);
				// Reschedule refresh timers for loaded tokens
				for (const serviceName of this.tokens.keys()) {
					this.scheduleTokenRefresh(serviceName);
				}
				logger.info(`Loaded ${this.tokens.size} tokens from storage`);
			}
		} catch (error) {
			logger.error("Failed to load tokens from storage:", error);
		}
	}

	/**
	 * Save tokens to storage
	 */
	private async persistTokens(): Promise<void> {
		try {
			const tokensArray = Array.from(this.tokens.entries());
			await browser.storage.local.set({
				[this.config.storageKey]: tokensArray,
			});
		} catch (error) {
			logger.error("Failed to persist tokens:", error);
		}
	}

	/**
	 * Check if a token needs refresh
	 */
	private needsRefresh(token: TokenMetadata): boolean {
		return Date.now() >= token.expiresAt - this.config.refreshBufferMs;
	}

	/**
	 * Schedule automatic token refresh
	 */
	private scheduleTokenRefresh(serviceName: string): void {
		this.clearRefreshTimer(serviceName);

		const token = this.tokens.get(serviceName);
		if (!token) {
			return;
		}

		const refreshTime = token.expiresAt - this.config.refreshBufferMs;
		const delay = Math.max(0, refreshTime - Date.now());

		const timer = setTimeout(async () => {
			try {
				await this.refreshToken(serviceName);
			} catch (error) {
				logger.error(`Scheduled token refresh failed for ${serviceName}:`, error);
			}
		}, delay);

		this.refreshTimers.set(serviceName, timer);
		logger.debug(`Token refresh scheduled for ${serviceName} in ${Math.round(delay / 1000)} seconds`);
	}

	/**
	 * Clear refresh timer for a service
	 */
	private clearRefreshTimer(serviceName: string): void {
		const timer = this.refreshTimers.get(serviceName);
		if (timer) {
			clearTimeout(timer);
			this.refreshTimers.delete(serviceName);
		}
	}

	/**
	 * Create default refresh config for a service
	 */
	private createDefaultRefreshConfig(serviceName: string, token: TokenMetadata): TokenRefreshConfig {
		// This is a fallback - adapters should provide their own refresh config
		throw new Error(`No refresh config provided for service: ${serviceName}`);
	}

	/**
	 * Update token from API response
	 */
	private updateTokenFromResponse(serviceName: string, tokenData: any): void {
		const token = this.tokens.get(serviceName);
		if (!token) {
			throw new Error(`No existing token found for service: ${serviceName}`);
		}

		const now = Date.now();
		const expiresIn = tokenData.expires_in || 3600; // Default to 1 hour

		// Update token metadata
		token.accessToken = tokenData.access_token;
		token.refreshToken = tokenData.refresh_token || token.refreshToken;
		token.tokenType = tokenData.token_type || token.tokenType;
		token.expiresAt = now + (expiresIn * 1000);
		token.issuedAt = now;
		token.scope = tokenData.scope || token.scope;

		this.tokens.set(serviceName, token);
		this.scheduleTokenRefresh(serviceName);
		this.persistTokens();
	}
}

// Global token manager instance
export const tokenManager = new TokenManager();
