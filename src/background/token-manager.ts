import { logger } from "../utils/logger";

const TOKEN_CHECK_ALARM_NAME = "token-refresh-check";

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

export interface TokenRefreshResult {
  success: boolean;
  requiresReauth: boolean;
  error?: string;
}

export interface TokenManagerConfig {
  storageKey: string;
  refreshBufferMs: number;
  maxRefreshAttempts: number;
  refreshCooldownMs: number;
  checkIntervalMinutes: number;
  expirationThresholdChecks: number;
}

export class TokenManager {
  private tokens: Map<string, TokenMetadata> = new Map();
  private alarmInitialized: boolean = false;
  private config: TokenManagerConfig;
  private refreshConfigProviders: Map<string, () => TokenRefreshConfig | null> = new Map();
  private refreshPromises: Map<string, Promise<TokenRefreshResult>> = new Map();

  constructor(config: Partial<TokenManagerConfig> = {}) {
    this.config = {
      storageKey: "api_tokens",
      refreshBufferMs: 5 * 60 * 1000, // 5 minutes
      maxRefreshAttempts: 3,
      refreshCooldownMs: 30 * 1000, // 30 seconds
      checkIntervalMinutes: 5, // Check every 5 minutes
      expirationThresholdChecks: 3, // Refresh if expiring in < 3 check periods (15 minutes)
      ...config,
    };
  }

  public async initializeAlarm(): Promise<void> {
    if (this.alarmInitialized) {
      return;
    }

    try {
      // Clear any existing alarm
      await browser.alarms.clear(TOKEN_CHECK_ALARM_NAME);

      // Create periodic alarm
      await browser.alarms.create(TOKEN_CHECK_ALARM_NAME, {
        periodInMinutes: this.config.checkIntervalMinutes,
      });

      // Set up alarm listener
      browser.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name === TOKEN_CHECK_ALARM_NAME) {
          await this.checkAndRefreshTokens();
        }
      });

      this.alarmInitialized = true;
      logger.info("Token refresh alarm initialized", {
        interval: `${this.config.checkIntervalMinutes} minutes`,
      });
    } catch (error) {
      logger.error("Failed to initialize token refresh alarm:", error);
    }
  }

  public async storeToken(
    serviceName: string,
    tokenData: Omit<TokenMetadata, "serviceName">,
  ): Promise<void> {
    const tokenMetadata: TokenMetadata = {
      ...tokenData,
      serviceName,
    };

    this.tokens.set(serviceName, tokenMetadata);
    await this.persistTokens();

    logger.info(`Token stored for ${serviceName}`, {
      expiresAt: new Date(tokenMetadata.expiresAt).toISOString(),
      scope: tokenMetadata.scope,
    });

    // Ensure alarm is initialized
    await this.initializeAlarm();
  }

  public setRefreshConfigProvider(
    serviceName: string,
    provider: () => TokenRefreshConfig | null,
  ): void {
    this.refreshConfigProviders.set(serviceName, provider);
  }

  public async getAccessToken(serviceName: string): Promise<string> {
    const token = this.tokens.get(serviceName);
    if (!token) {
      logger.error(
        `No token found for service: ${serviceName}. Available services: ${Array.from(this.tokens.keys()).join(", ")}`,
      );
      throw new Error(
        `No token found for service: ${serviceName}. Please check your configuration and try re-authenticating.`,
      );
    }

    if (this.needsRefresh(token)) {
      logger.info(`Token for ${serviceName} needs refresh, attempting refresh...`);
      const refreshResult = await this.refreshToken(serviceName);
      const currentToken = this.tokens.get(serviceName);
      if (!refreshResult.success) {
        logger.error(`Token refresh failed for service: ${serviceName}. ${refreshResult.error}`);
        if (!currentToken || Date.now() >= currentToken.expiresAt) {
          throw new Error(
            `Token refresh failed for service: ${serviceName}. ${refreshResult.error}`,
          );
        }
        logger.warn(`Using existing token for ${serviceName} until expiry after failed refresh`);
      }
    }

    const updatedToken = this.tokens.get(serviceName);
    if (!updatedToken) {
      logger.error(`No token available for service: ${serviceName} after refresh attempt`);
      throw new Error(`No token available for service: ${serviceName}`);
    }

    return updatedToken.accessToken;
  }

  public getTokenMetadata(serviceName: string): TokenMetadata | null {
    return this.tokens.get(serviceName) || null;
  }

  public isTokenValid(serviceName: string): boolean {
    const token = this.tokens.get(serviceName);
    if (!token) {
      return false;
    }
    return Date.now() < token.expiresAt;
  }

  public async refreshToken(
    serviceName: string,
    refreshConfig?: TokenRefreshConfig,
  ): Promise<TokenRefreshResult> {
    const inFlight = this.refreshPromises.get(serviceName);
    if (inFlight) {
      logger.debug(`Refresh already in progress for ${serviceName}, sharing result`);
      return inFlight;
    }

    const promise = this.performRefresh(serviceName, refreshConfig).finally(() => {
      this.refreshPromises.delete(serviceName);
    });
    this.refreshPromises.set(serviceName, promise);
    return promise;
  }

  private async performRefresh(
    serviceName: string,
    refreshConfig?: TokenRefreshConfig,
  ): Promise<TokenRefreshResult> {
    const token = this.tokens.get(serviceName);
    if (!token) {
      return {
        success: false,
        requiresReauth: true,
        error: `No token found for service: ${serviceName}`,
      };
    }

    if (!token.refreshToken) {
      logger.debug(`Service ${serviceName} has no refresh token (static key)`);
      return {
        success: false,
        requiresReauth: false,
        error: `No refresh token available for service: ${serviceName}`,
      };
    }

    const config = refreshConfig ?? this.refreshConfigProviders.get(serviceName)?.() ?? null;
    if (!config) {
      return {
        success: false,
        requiresReauth: false,
        error: `No refresh configuration available for service: ${serviceName}`,
      };
    }

    if (
      token.lastRefreshAttempt &&
      Date.now() - token.lastRefreshAttempt < this.config.refreshCooldownMs
    ) {
      logger.debug(`Refresh cooldown active for ${serviceName}`);
      return {
        success: false,
        requiresReauth: false,
        error: "Refresh cooldown active",
      };
    }

    token.lastRefreshAttempt = Date.now();
    token.refreshCount++;

    if (token.refreshCount > this.config.maxRefreshAttempts) {
      logger.warn(`Max refresh attempts exceeded for ${serviceName}, clearing token`);
      await this.clearToken(serviceName);
      return {
        success: false,
        requiresReauth: true,
        error: `Max refresh attempts exceeded for ${serviceName}`,
      };
    }

    try {
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
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          await this.clearToken(serviceName);
          return {
            success: false,
            requiresReauth: true,
            error: `Token refresh failed: ${response.status} ${errorText}`,
          };
        }
        return {
          success: false,
          requiresReauth: false,
          error: `Token refresh failed: ${response.status} ${errorText}`,
        };
      }

      const tokenData = (await response.json()) as Record<string, unknown>;
      if (typeof tokenData?.access_token !== "string" || !tokenData.access_token) {
        logger.error(`Invalid refresh response for ${serviceName}`);
        return {
          success: false,
          requiresReauth: false,
          error: `Invalid refresh response for service: ${serviceName}`,
        };
      }

      await this.updateTokenFromResponse(serviceName, tokenData);

      logger.info(`Token refreshed successfully for ${serviceName}`, {
        expiresAt: new Date(this.tokens.get(serviceName)?.expiresAt || Date.now()).toISOString(),
        refreshCount: this.tokens.get(serviceName)?.refreshCount,
      });

      return { success: true, requiresReauth: false };
    } catch (error) {
      logger.error(`Token refresh error for ${serviceName}:`, error);
      return {
        success: false,
        requiresReauth: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async clearToken(serviceName: string): Promise<void> {
    this.tokens.delete(serviceName);
    await this.persistTokens();
    logger.info(`Token cleared for ${serviceName}`);
  }

  public async forceReauth(serviceName: string): Promise<void> {
    await this.clearToken(serviceName);
    logger.info(`Forced re-authentication for ${serviceName}`);
  }

  public async clearAllTokens(): Promise<void> {
    this.tokens.clear();
    await this.persistTokens();
    logger.info("All tokens cleared");
  }

  public getTokenHealth(): Record<
    string,
    { isValid: boolean; expiresAt?: string; refreshCount?: number }
  > {
    const health: Record<string, { isValid: boolean; expiresAt?: string; refreshCount?: number }> =
      {};

    for (const [serviceName, token] of this.tokens) {
      health[serviceName] = {
        isValid: Date.now() < token.expiresAt,
        expiresAt: new Date(token.expiresAt).toISOString(),
        refreshCount: token.refreshCount,
      };
    }

    return health;
  }

  public async loadTokens(): Promise<void> {
    try {
      const result = await browser.storage.local.get(this.config.storageKey);
      const storedTokens = result[this.config.storageKey];

      if (storedTokens) {
        this.tokens = new Map(storedTokens);
        logger.info(`Loaded ${this.tokens.size} tokens from storage`);

        // Initialize the alarm if there are any tokens
        if (this.tokens.size > 0) {
          await this.initializeAlarm();
        }
      }
    } catch (error) {
      logger.error("Failed to load tokens from storage:", error);
    }
  }

  private async checkAndRefreshTokens(): Promise<void> {
    const now = Date.now();
    const thresholdMs =
      this.config.checkIntervalMinutes * this.config.expirationThresholdChecks * 60 * 1000;

    for (const [serviceName, token] of this.tokens) {
      // Skip tokens without refresh capability (static API keys)
      if (!token.refreshToken) {
        continue;
      }

      const timeUntilExpiry = token.expiresAt - now;

      // Refresh if token will expire within threshold
      if (timeUntilExpiry < thresholdMs) {
        logger.info(
          `Token for ${serviceName} expiring soon (${Math.round(timeUntilExpiry / 1000 / 60)} minutes), scheduling refresh`,
        );
        // Fire and forget - don't await
        void this.refreshToken(serviceName).catch((error) => {
          logger.error(`Periodic refresh failed for ${serviceName}:`, error);
        });
      }
    }
  }

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

  private needsRefresh(token: TokenMetadata): boolean {
    return Date.now() >= token.expiresAt - this.config.refreshBufferMs;
  }

  private async updateTokenFromResponse(
    serviceName: string,
    tokenData: Record<string, unknown>,
  ): Promise<void> {
    const token = this.tokens.get(serviceName);
    if (!token) {
      throw new Error(`No existing token found for service: ${serviceName}`);
    }

    const now = Date.now();
    const expiresIn = tokenData.expires_in || 3600; // Default to 1 hour

    token.accessToken = (tokenData.access_token as string) || token.accessToken;
    token.refreshToken = (tokenData.refresh_token as string) || token.refreshToken;
    token.tokenType = (tokenData.token_type as string) || token.tokenType;
    token.expiresAt = now + (expiresIn as number) * 1000;
    token.issuedAt = now;
    token.scope = (tokenData.scope as string) || token.scope;

    this.tokens.set(serviceName, token);
    // Reset refresh count on successful refresh
    token.refreshCount = 0;
    await this.persistTokens();
  }
}

export const tokenManager = new TokenManager();
