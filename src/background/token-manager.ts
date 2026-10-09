import { Effect, Semaphore } from "effect";
import * as v from "valibot";
import { requestJson, isOAuthRejection } from "./api/effect-api-client";
import {
  CredentialsFailure,
  InvalidResponseFailure,
  localRead,
  storagePromise,
  storageHealthy,
  storageHealthyAfter,
  type TransportError,
} from "./api/effect-adapter";
import { getStorageDiagnostic, setLocal, type RemoteOutcome } from "../utils/fatal-storage";
import { logger } from "../utils/logger";

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
  private accountBindings = new Map<
    string,
    { identity: string | null; ready: Effect.Effect<number, TransportError> }
  >();
  private readonly commits = Semaphore.makeUnsafe(1);

  /**
   * Every acquisition for an identity shares its binding, so no caller sees the new generation
   * before the previous account's token deletion has committed or failed.
   */
  public bindAccount(serviceName: string, identity: string): Effect.Effect<number, TransportError> {
    return Effect.gen({ self: this }, function* () {
      let generation = 0;
      const deletion = yield* Effect.cached(
        Effect.suspend(() =>
          this.commitTokens((tokens) => {
            this.assertAccount(serviceName, generation);
            tokens.delete(serviceName);
          }),
        ).pipe(Effect.map(() => generation)),
      );
      let binding = this.accountBindings.get(serviceName);
      if (binding?.identity !== identity) {
        const replacing = binding !== undefined;
        this.invalidateAccount(serviceName);
        generation = this.accountGenerations.get(serviceName) ?? 0;
        const current = {
          identity,
          ready: replacing
            ? deletion.pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (this.accountBindings.get(serviceName) === current)
                      this.accountBindings.set(serviceName, { identity: null, ready: deletion });
                  }),
                ),
              )
            : Effect.succeed(generation),
        };
        binding = current;
        this.accountBindings.set(serviceName, current);
      }
      yield* binding.ready;
      // A same-account clear keeps the binding and only advances the generation.
      if (this.accountBindings.get(serviceName) !== binding)
        return yield* Effect.fail(new CredentialsFailure("account ownership"));
      return this.accountGenerations.get(serviceName) ?? 0;
    });
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

  public discardRejectedToken(
    serviceName: string,
    expected: TokenMetadata,
  ): Effect.Effect<void, TransportError> {
    return this.commitTokens((tokens) => {
      if (tokens.get(serviceName) !== expected) throw new CredentialsFailure("account ownership");
      tokens.delete(serviceName);
    }).pipe(Effect.tap(() => Effect.sync(() => this.refreshEffects.delete(serviceName))));
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

  public readonly initializeAlarm: Effect.Effect<void, TransportError> = Effect.gen(
    { self: this },
    function* () {
      yield* storageHealthy;
      if (this.alarmInitialized || !this.config.persist) return;
      // Chromium keeps alarms while its service worker sleeps: recreating
      // the alarm on every wake would push it back each time. The background
      // script's onAlarm listener calls checkAndRefreshTokens.
      const created = yield* Effect.tryPromise(async () => {
        const existing = await browser.alarms.get(TOKEN_CHECK_ALARM_NAME);
        if (getStorageDiagnostic()) return false;
        if (existing?.periodInMinutes !== this.config.checkIntervalMinutes) {
          await browser.alarms.create(TOKEN_CHECK_ALARM_NAME, {
            periodInMinutes: this.config.checkIntervalMinutes,
          });
          if (getStorageDiagnostic()) await browser.alarms.clear(TOKEN_CHECK_ALARM_NAME);
        }
        return true;
      }).pipe(
        // An alarm created while shutdown starts is cleared before shutdown completes.
        Effect.uninterruptible,
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.error("Failed to initialize token refresh alarm:", error);
            return false;
          }),
        ),
      );
      yield* storageHealthy;
      if (!created) return;
      this.alarmInitialized = true;
      logger.info("Token refresh alarm initialized", {
        interval: `${this.config.checkIntervalMinutes} minutes`,
      });
    },
  );

  public storeToken(
    serviceName: string,
    tokenData: Omit<TokenMetadata, "serviceName">,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
    accountGeneration?: number,
  ): Effect.Effect<void, TransportError> {
    const tokenMetadata: TokenMetadata = { ...tokenData, serviceName };
    return this.commitTokens(
      (tokens) => {
        if (accountGeneration !== undefined) this.assertAccount(serviceName, accountGeneration);
        tokens.set(serviceName, tokenMetadata);
      },
      remoteOutcome,
      remoteOperation,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.refreshEffects.delete(serviceName);
          logger.info(`Token stored for ${serviceName}`, {
            expiresAt: new Date(tokenMetadata.expiresAt).toISOString(),
            scope: tokenMetadata.scope,
          });
        }),
      ),
      Effect.andThen(this.initializeAlarm),
    );
  }

  public setRefreshConfigProvider(
    serviceName: string,
    provider: () => TokenRefreshConfig | null,
  ): void {
    this.refreshConfigProviders.set(serviceName, provider);
  }

  public getAccessToken(serviceName: string): Effect.Effect<string, TransportError> {
    return Effect.gen({ self: this }, function* () {
      yield* storageHealthy;
      const token = this.tokens.get(serviceName);
      if (!token) {
        logger.error(
          `No token found for service: ${serviceName}. Available services: ${Array.from(this.tokens.keys()).join(", ")}`,
        );
        return yield* Effect.fail(new CredentialsFailure("access token"));
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
        return yield* Effect.fail(new InvalidResponseFailure("access token", "token"));

      if (this.needsRefresh(token)) {
        logger.info(`Token for ${serviceName} needs refresh, attempting refresh...`);
        const refreshResult = yield* this.refreshToken(serviceName);
        const currentToken = this.tokens.get(serviceName);
        if (!refreshResult.success) {
          logger.error(`Token refresh failed for service: ${serviceName}. ${refreshResult.error}`);
          if (!currentToken || Date.now() >= currentToken.expiresAt) {
            return yield* Effect.fail(
              refreshResult.failure ?? new CredentialsFailure("access token"),
            );
          }
          logger.warn(`Using existing token for ${serviceName} until expiry after failed refresh`);
        }
      }

      yield* storageHealthy;
      const updatedToken = this.tokens.get(serviceName);
      if (!updatedToken) {
        logger.error(`No token available for service: ${serviceName} after refresh attempt`);
        return yield* Effect.fail(new CredentialsFailure("access token"));
      }
      return updatedToken.accessToken;
    });
  }

  public getTokenMetadata(serviceName: string): TokenMetadata | null {
    return this.tokens.get(serviceName) || null;
  }

  public refreshToken(
    serviceName: string,
    refreshConfig?: TokenRefreshConfig,
  ): Effect.Effect<TokenRefreshResult, TransportError> {
    return Effect.gen({ self: this }, function* () {
      yield* storageHealthy;
      if (refreshConfig) this.refreshConfigs.set(serviceName, refreshConfig);
      if (!this.refreshEffects.has(serviceName)) {
        // Cache failures through the cooldown so waiting requests retain the same recovery reason.
        const shared = yield* Effect.cachedWithTTL(this.performRefresh(serviceName), (exit) =>
          exit._tag === "Success" && !exit.value.success ? this.config.refreshCooldownMs : 0,
        );
        if (!this.refreshEffects.has(serviceName)) this.refreshEffects.set(serviceName, shared);
      }
      return yield* this.refreshEffects.get(serviceName) ?? this.performRefresh(serviceName);
    });
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
          this.updateTokenFromResponse(
            serviceName,
            data,
            attempt.lastRefreshAttempt,
            token,
            generation,
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
              yield* this.commitTokens(
                (tokens) => {
                  this.assertAccount(serviceName, generation);
                  if (tokens.get(serviceName) !== token)
                    throw new CredentialsFailure("token refresh");
                  tokens.delete(serviceName);
                },
                "failed",
                "token refresh",
              );
            else
              yield* this.commitTokens((tokens) => {
                this.assertAccount(serviceName, generation);
                if (tokens.get(serviceName) !== token)
                  throw new CredentialsFailure("token refresh");
                tokens.set(serviceName, attempt);
              });
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

  public clearToken(
    serviceName: string,
    remoteOutcome?: RemoteOutcome,
  ): Effect.Effect<void, TransportError> {
    return Effect.suspend(() => {
      this.invalidateAccount(serviceName);
      return this.commitTokens(
        (tokens) => tokens.delete(serviceName),
        remoteOutcome,
        "token refresh",
      );
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.refreshEffects.delete(serviceName);
          logger.info(`Token cleared for ${serviceName}`);
        }),
      ),
    );
  }

  /** A read failure starts without tokens: the adapters log in again. */
  public readonly loadTokens: Effect.Effect<void, TransportError> = Effect.gen(
    { self: this },
    function* () {
      const result = yield* localRead("load tokens", this.config.storageKey).pipe(
        Effect.catchTag("BrowserFailure", (error) =>
          Effect.sync(() => {
            logger.error("Failed to load tokens from storage:", error);
            return {} as Record<string, unknown>;
          }),
        ),
      );
      const storedTokens = result[this.config.storageKey] as [string, TokenMetadata][] | undefined;
      if (!storedTokens) return;
      this.tokens = new Map(storedTokens);
      logger.info(`Loaded ${this.tokens.size} tokens from storage`);
      if (this.tokens.size > 0) yield* this.initializeAlarm;
    },
  );

  /** Refreshes tokens that expire soon; the alarm waits for them, which keeps an MV3 worker alive. */
  public readonly checkAndRefreshTokens: Effect.Effect<void, TransportError> = Effect.gen(
    { self: this },
    function* () {
      yield* storageHealthy;
      const now = Date.now();
      const thresholdMs =
        this.config.checkIntervalMinutes * this.config.expirationThresholdChecks * 60 * 1000;
      // Static API keys have no refresh token.
      const expiring = [...this.tokens].filter(
        ([, token]) => token.refreshToken && token.expiresAt - now < thresholdMs,
      );
      yield* Effect.forEach(
        expiring,
        ([serviceName, token]) => {
          logger.info(
            `Token for ${serviceName} expiring soon (${Math.round((token.expiresAt - now) / 1000 / 60)} minutes), refreshing`,
          );
          return this.refreshToken(serviceName).pipe(
            Effect.catchIf(
              (error) => error._tag !== "FatalStorageFailure",
              (error) =>
                Effect.sync(() =>
                  logger.error(`Periodic refresh failed for ${serviceName}:`, error),
                ),
            ),
          );
        },
        { concurrency: "unbounded", discard: true },
      );
    },
  );

  /** One token write at a time; a rejected write latches fatal storage before the map changes. */
  private commitTokens(
    change: (tokens: Map<string, TokenMetadata>) => unknown,
    remoteOutcome?: RemoteOutcome,
    remoteOperation?: string,
  ): Effect.Effect<void, TransportError> {
    const commit = Effect.gen({ self: this }, function* () {
      yield* storageHealthyAfter(remoteOutcome, remoteOperation);
      const tokens = new Map(this.tokens);
      yield* Effect.try({
        try: () => change(tokens),
        catch: (error) => {
          if (error instanceof CredentialsFailure) return error;
          throw error;
        },
      });
      if (this.config.persist)
        yield* storagePromise(() =>
          setLocal(
            "persist tokens",
            { [this.config.storageKey]: Array.from(tokens.entries()) },
            remoteOutcome,
            remoteOperation,
          ),
        );
      yield* storageHealthy;
      this.tokens = tokens;
    });
    return Semaphore.withPermit(this.commits, commit).pipe(
      Effect.uninterruptible,
      Effect.tapError(() => storageHealthyAfter(remoteOutcome, remoteOperation)),
    );
  }

  private needsRefresh(token: TokenMetadata): boolean {
    return Date.now() >= token.expiresAt - this.config.refreshBufferMs;
  }

  private updateTokenFromResponse(
    serviceName: string,
    tokenData: v.InferOutput<typeof oauthTokenSchema>,
    lastRefreshAttempt: number,
    expected: TokenMetadata,
    generation: number,
  ): Effect.Effect<void, TransportError> {
    const now = Date.now();
    const token: TokenMetadata = {
      ...expected,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token ?? expected.refreshToken,
      tokenType: tokenData.token_type ?? expected.tokenType,
      expiresAt: now + (tokenData.expires_in ?? 3600) * 1000,
      issuedAt: now,
      scope: tokenData.scope ?? expected.scope,
      refreshCount: 0,
      lastRefreshAttempt,
    };
    return this.commitTokens(
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
