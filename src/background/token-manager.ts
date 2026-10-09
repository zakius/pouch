import { Effect } from "effect";
import * as v from "valibot";
import { requestJson, isOAuthRejection } from "./api/effect-api-client";
import {
  CredentialsFailure,
  InvalidResponseFailure,
  fromLegacyPromise,
  runOperation,
  type TransportError,
} from "./api/effect-adapter";
import {
  assertStorageHealthy,
  getStorageDiagnostic,
  setLocal,
  type RemoteOutcome,
} from "../utils/fatal-storage";
import { logger } from "../utils/logger";

export function fromTokenPromise<A>(operation: () => Promise<A>): Effect.Effect<A, TransportError> {
  return fromLegacyPromise(operation).pipe(
    Effect.catchTags({ ConfigurationFailure: Effect.die, IncompleteSnapshotFailure: Effect.die }),
  );
}

function isHeaderToken(value: string): boolean {
  try {
    new Headers({ Authorization: `Bearer ${value}` });
    return value.trim().length > 0 && !/[\r\n]/.test(value);
  } catch {
    return false;
  }
}

export const oauthTokenSchema = v.object({
  access_token: v.pipe(v.string(), v.check(isHeaderToken)),
  refresh_token: v.optional(v.pipe(v.string(), v.minLength(1))),
  token_type: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z]+$/))),
  expires_in: v.optional(v.pipe(v.number(), v.finite(), v.minValue(1))),
  scope: v.optional(v.nullable(v.string())),
});
export function parseOAuthToken(
  data: unknown,
  operation: string,
): Effect.Effect<
  v.InferOutput<typeof oauthTokenSchema>,
  CredentialsFailure | InvalidResponseFailure
> {
  if (isOAuthRejection(data)) return Effect.fail(new CredentialsFailure(operation));
  const parsed = v.safeParse(oauthTokenSchema, data);
  return parsed.success
    ? Effect.succeed(parsed.output)
    : Effect.fail(new InvalidResponseFailure(operation, "token"));
}

export const TOKEN_CHECK_ALARM_NAME = "token-refresh-check";

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
  failure?: TransportError;
}

export interface TokenManagerConfig {
  storageKey: string;
  refreshBufferMs: number;
  refreshCooldownMs: number;
  checkIntervalMinutes: number;
  expirationThresholdChecks: number;
  /** False keeps tokens in memory only: no storage writes and no refresh alarm. */
  persist: boolean;
}

export class TokenManager {
  private tokens: Map<string, TokenMetadata> = new Map();
  private alarmInitialized: boolean = false;
  private config: TokenManagerConfig;
  private refreshConfigProviders: Map<string, () => TokenRefreshConfig | null> = new Map();
  private refreshEffects = new Map<string, Effect.Effect<TokenRefreshResult, TransportError>>();
  private accountGenerations = new Map<string, number>();
  /** Null identity marks a failed binding whose previous-account token may still be stored. */
  private accountBindings = new Map<string, { identity: string | null; ready: Promise<number> }>();

  /**
   * Every acquisition for an identity shares its binding, so no caller sees the new generation
   * before the previous account's token deletion has committed or failed.
   */
  public async bindAccount(serviceName: string, identity: string): Promise<number> {
    let binding = this.accountBindings.get(serviceName);
    if (binding?.identity !== identity) {
      const replacing = binding !== undefined;
      this.invalidateAccount(serviceName);
      const generation = this.accountGenerations.get(serviceName) ?? 0;
      const ready = replacing
        ? this.commitTokens((tokens) => {
            this.assertAccount(serviceName, generation);
            tokens.delete(serviceName);
          }).then(() => generation)
        : Promise.resolve(generation);
      const current = { identity, ready };
      binding = current;
      this.accountBindings.set(serviceName, current);
      ready.catch(() => {
        if (this.accountBindings.get(serviceName) === current)
          this.accountBindings.set(serviceName, { identity: null, ready });
      });
    }
    await binding.ready;
    // A same-account clear keeps the binding and only advances the generation.
    if (this.accountBindings.get(serviceName) !== binding)
      throw new CredentialsFailure("account ownership");
    return this.accountGenerations.get(serviceName) ?? 0;
  }

  public assertAccount(serviceName: string, generation: number): void {
    if ((this.accountGenerations.get(serviceName) ?? 0) !== generation)
      throw new CredentialsFailure("account ownership");
  }

  private invalidateAccount(serviceName: string): void {
    this.accountGenerations.set(serviceName, (this.accountGenerations.get(serviceName) ?? 0) + 1);
    this.refreshEffects.delete(serviceName);
    this.refreshConfigs.delete(serviceName);
    this.refreshConfigProviders.delete(serviceName);
  }

  public async discardRejectedToken(serviceName: string, expected: TokenMetadata): Promise<void> {
    await this.commitTokens((tokens) => {
      if (tokens.get(serviceName) !== expected) throw new CredentialsFailure("account ownership");
      tokens.delete(serviceName);
    });
    this.refreshEffects.delete(serviceName);
  }

  private refreshConfigs = new Map<string, TokenRefreshConfig>();

  constructor(config: Partial<TokenManagerConfig> = {}) {
    this.config = {
      storageKey: "api_tokens",
      refreshBufferMs: 5 * 60 * 1000, // 5 minutes
      refreshCooldownMs: 30 * 1000, // 30 seconds
      checkIntervalMinutes: 5, // Check every 5 minutes
      expirationThresholdChecks: 3, // Refresh if expiring in < 3 check periods (15 minutes)
      persist: true,
      ...config,
    };
  }

  public async initializeAlarm(): Promise<void> {
    assertStorageHealthy();
    if (this.alarmInitialized || !this.config.persist) {
      return;
    }

    try {
      // Chromium keeps alarms while its service worker sleeps: recreating
      // the alarm on every wake would push it back each time. The background
      // script's onAlarm listener calls checkAndRefreshTokens().
      const existing = await browser.alarms.get(TOKEN_CHECK_ALARM_NAME);
      assertStorageHealthy();
      if (existing?.periodInMinutes !== this.config.checkIntervalMinutes) {
        await browser.alarms.create(TOKEN_CHECK_ALARM_NAME, {
          periodInMinutes: this.config.checkIntervalMinutes,
        });
        if (getStorageDiagnostic()) await browser.alarms.clear(TOKEN_CHECK_ALARM_NAME);
      }
      assertStorageHealthy();

      this.alarmInitialized = true;
      logger.info("Token refresh alarm initialized", {
        interval: `${this.config.checkIntervalMinutes} minutes`,
      });
    } catch (error) {
      assertStorageHealthy();
      logger.error("Failed to initialize token refresh alarm:", error);
    }
  }

  public async storeToken(
    serviceName: string,
    tokenData: Omit<TokenMetadata, "serviceName">,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
    accountGeneration?: number,
  ): Promise<void> {
    const tokenMetadata: TokenMetadata = {
      ...tokenData,
      serviceName,
    };

    await this.commitTokens(
      (tokens) => {
        if (accountGeneration !== undefined) this.assertAccount(serviceName, accountGeneration);
        tokens.set(serviceName, tokenMetadata);
      },
      remoteOutcome,
      remoteOperation,
    );

    this.refreshEffects.delete(serviceName);
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
    assertStorageHealthy();
    const token = this.tokens.get(serviceName);
    if (!token) {
      logger.error(
        `No token found for service: ${serviceName}. Available services: ${Array.from(this.tokens.keys()).join(", ")}`,
      );
      throw new CredentialsFailure("access token");
    }

    if (
      !v.safeParse(
        v.object({
          accessToken: v.pipe(v.string(), v.check(isHeaderToken)),
          refreshToken: v.string(),
          tokenType: v.pipe(v.string(), v.regex(/^[a-zA-Z]+$/)),
          expiresAt: v.pipe(v.number(), v.finite()),
          issuedAt: v.pipe(v.number(), v.finite()),
        }),
        token,
      ).success
    )
      throw new InvalidResponseFailure("access token", "token");

    if (this.needsRefresh(token)) {
      logger.info(`Token for ${serviceName} needs refresh, attempting refresh...`);
      const refreshResult = await this.refreshToken(serviceName);
      const currentToken = this.tokens.get(serviceName);
      if (!refreshResult.success) {
        logger.error(`Token refresh failed for service: ${serviceName}. ${refreshResult.error}`);
        if (!currentToken || Date.now() >= currentToken.expiresAt) {
          throw refreshResult.failure ?? new CredentialsFailure("access token");
        }
        logger.warn(`Using existing token for ${serviceName} until expiry after failed refresh`);
      }
    }

    assertStorageHealthy();
    const updatedToken = this.tokens.get(serviceName);
    if (!updatedToken) {
      logger.error(`No token available for service: ${serviceName} after refresh attempt`);
      throw new CredentialsFailure("access token");
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
    assertStorageHealthy();
    if (refreshConfig) this.refreshConfigs.set(serviceName, refreshConfig);
    let shared = this.refreshEffects.get(serviceName);
    if (!shared) {
      // Cache failures through the cooldown so waiting requests retain the same recovery reason.
      shared = Effect.runSync(
        Effect.cachedWithTTL(this.performRefresh(serviceName), (exit) =>
          exit._tag === "Success" && !exit.value.success ? this.config.refreshCooldownMs : 0,
        ),
      );
      this.refreshEffects.set(serviceName, shared);
    }
    return runOperation(shared);
  }

  private performRefresh(serviceName: string): Effect.Effect<TokenRefreshResult, TransportError> {
    return Effect.gen({ self: this }, function* () {
      const generation = this.accountGenerations.get(serviceName) ?? 0;
      const token = this.tokens.get(serviceName);
      if (!token)
        return {
          success: false,
          requiresReauth: true,
          failure: new CredentialsFailure("token refresh"),
          error: "No token available",
        };
      if (!token.refreshToken)
        return { success: false, requiresReauth: false, error: "No refresh token available" };
      const config =
        this.refreshConfigProviders.get(serviceName)?.() ?? this.refreshConfigs.get(serviceName);
      if (!config)
        return {
          success: false,
          requiresReauth: false,
          error: "No refresh configuration available",
        };
      const attempt = {
        ...token,
        lastRefreshAttempt: Date.now(),
        refreshCount: token.refreshCount + 1,
      };
      const refreshed = yield* requestJson({
        operation: "token refresh",
        url: config.refreshUrl,
        responseKind: "token",
        rateRetries: 0,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            ...config.additionalParams,
            grant_type: "refresh_token",
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: token.refreshToken,
          }),
        },
      }).pipe(
        Effect.flatMap((data) => parseOAuthToken(data, "token refresh")),
        Effect.flatMap((data) =>
          fromTokenPromise(() =>
            this.updateTokenFromResponse(
              serviceName,
              data,
              attempt.lastRefreshAttempt,
              token,
              generation,
            ),
          ).pipe(Effect.as({ success: true, requiresReauth: false })),
        ),
        Effect.catch((failure) =>
          Effect.gen({ self: this }, function* () {
            const definitive = failure instanceof CredentialsFailure;
            if (failure._tag === "FatalStorageFailure") return yield* Effect.fail(failure);
            if (
              this.tokens.get(serviceName) !== token ||
              (this.accountGenerations.get(serviceName) ?? 0) !== generation
            )
              return {
                success: false,
                requiresReauth: false,
                error: "Token ownership changed",
                failure: new CredentialsFailure("token refresh"),
              };
            if (definitive)
              yield* fromTokenPromise(() =>
                this.commitTokens(
                  (tokens) => {
                    this.assertAccount(serviceName, generation);
                    if (tokens.get(serviceName) !== token)
                      throw new CredentialsFailure("token refresh");
                    tokens.delete(serviceName);
                  },
                  "failed",
                  "token refresh",
                ),
              );
            else
              yield* fromTokenPromise(() =>
                this.commitTokens((tokens) => {
                  this.assertAccount(serviceName, generation);
                  if (tokens.get(serviceName) !== token)
                    throw new CredentialsFailure("token refresh");
                  tokens.set(serviceName, attempt);
                }),
              );
            return {
              success: false,
              requiresReauth: definitive,
              error: failure.message,
              failure: definitive ? new CredentialsFailure("token refresh") : failure,
            };
          }),
        ),
      );
      return refreshed;
    });
  }

  public async clearToken(serviceName: string, remoteOutcome?: RemoteOutcome): Promise<void> {
    this.invalidateAccount(serviceName);
    await this.commitTokens((tokens) => tokens.delete(serviceName), remoteOutcome, "token refresh");
    this.refreshEffects.delete(serviceName);
    logger.info(`Token cleared for ${serviceName}`);
  }

  public async forceReauth(serviceName: string): Promise<void> {
    await this.clearToken(serviceName);
    logger.info(`Forced re-authentication for ${serviceName}`);
  }

  public async clearAllTokens(): Promise<void> {
    for (const serviceName of new Set([...this.accountGenerations.keys(), ...this.tokens.keys()]))
      this.invalidateAccount(serviceName);
    await this.commitTokens((tokens) => tokens.clear());
    this.refreshEffects.clear();
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
    assertStorageHealthy();
    try {
      const result = await browser.storage.local.get(this.config.storageKey);
      assertStorageHealthy();
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
      assertStorageHealthy();
      logger.error("Failed to load tokens from storage:", error);
    }
  }

  public async checkAndRefreshTokens(): Promise<void> {
    assertStorageHealthy();
    const now = Date.now();
    const thresholdMs =
      this.config.checkIntervalMinutes * this.config.expirationThresholdChecks * 60 * 1000;

    for (const [serviceName, token] of this.tokens) {
      assertStorageHealthy();
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

  private tokenCommitQueue: Promise<unknown> = Promise.resolve();

  private commitTokens(
    change: (tokens: Map<string, TokenMetadata>) => unknown,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Promise<void> {
    const result = this.tokenCommitQueue
      .then(async () => {
        assertStorageHealthy(remoteOutcome, remoteOperation);
        const tokens = new Map(this.tokens);
        change(tokens);
        if (this.config.persist) {
          await setLocal(
            "persist tokens",
            {
              [this.config.storageKey]: Array.from(tokens.entries()),
            },
            remoteOutcome,
            remoteOperation,
          );
        }
        assertStorageHealthy();
        this.tokens = tokens;
      })
      .catch((error: unknown) => {
        assertStorageHealthy(remoteOutcome, remoteOperation);
        throw error;
      });
    this.tokenCommitQueue = result.catch(() => {});
    return result;
  }

  private needsRefresh(token: TokenMetadata): boolean {
    return Date.now() >= token.expiresAt - this.config.refreshBufferMs;
  }

  private async updateTokenFromResponse(
    serviceName: string,
    tokenData: v.InferOutput<typeof oauthTokenSchema>,
    lastRefreshAttempt: number,
    expected: TokenMetadata,
    generation: number,
  ): Promise<void> {
    const existing = this.tokens.get(serviceName);
    if (existing !== expected) throw new CredentialsFailure("token refresh");
    const token = existing ? { ...existing } : undefined;
    if (!token) {
      throw new Error(`No existing token found for service: ${serviceName}`);
    }

    const now = Date.now();
    const expiresIn = tokenData.expires_in ?? 3600;

    token.accessToken = tokenData.access_token;
    token.refreshToken = tokenData.refresh_token ?? token.refreshToken;
    token.tokenType = tokenData.token_type ?? token.tokenType;
    token.expiresAt = now + expiresIn * 1000;
    token.issuedAt = now;
    token.scope = tokenData.scope ?? token.scope;

    token.refreshCount = 0;
    token.lastRefreshAttempt = lastRefreshAttempt;
    await this.commitTokens(
      (tokens) => {
        this.assertAccount(serviceName, generation);
        if (tokens.get(serviceName) !== expected) throw new CredentialsFailure("token refresh");
        tokens.set(serviceName, token);
      },
      "succeeded",
      "token refresh",
    );
  }
}

export const tokenManager = new TokenManager();
