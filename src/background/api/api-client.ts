import { assertStorageHealthy, storageShutdownSignal } from "../../utils/fatal-storage";
/**
 * API Client with Token Management
 *
 * A unified HTTP client that handles token management, authentication,
 * retry logic, and rate limiting for all API adapters.
 */

import { logger } from "../../utils/logger";
import { permissionErrorMessageForUrl } from "../../utils/backend-permissions";
import { type TokenManager, type TokenRefreshConfig, tokenManager } from "../token-manager";
import type { TokenizedAdapter } from "./tokenized-adapter";

export interface ApiClientConfig {
  baseUrl: string;

  defaultHeaders?: Record<string, string>;

  rateLimit?: {
    delayMs?: number;

    maxRetries?: number;

    lowLimitThreshold?: number;
  };

  timeoutMs?: number;

  autoRetryOnAuth?: boolean;

  maxAuthRetries?: number;
}

interface RequiredApiClientConfig {
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  rateLimit: {
    delayMs: number;
    maxRetries: number;
    lowLimitThreshold: number;
  };
  timeoutMs: number;
  autoRetryOnAuth: boolean;
  maxAuthRetries: number;
}

export interface RequestOptions extends RequestInit {
  authenticated?: boolean;

  timeout?: number;

  retryOnAuth?: boolean;

  headers?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface AuthHandlers {
  getTokenRefreshConfig?: () => TokenRefreshConfig | null;
  reAuthenticate?: () => Promise<void>;
}

export class ApiClient {
  private config: RequiredApiClientConfig;
  private serviceName: string;
  private authHandlers: AuthHandlers;
  private lastRequestTime = 0;

  constructor(
    serviceName: string,
    baseUrl: string,
    authHandlers: AuthHandlers = {},
    config: Partial<ApiClientConfig> = {},
    private readonly tokens: TokenManager = tokenManager,
  ) {
    this.serviceName = serviceName;
    this.authHandlers = authHandlers;
    this.config = {
      baseUrl: config.baseUrl || baseUrl,
      defaultHeaders: config.defaultHeaders || {},
      rateLimit: {
        delayMs: config.rateLimit?.delayMs || 1000,
        maxRetries: config.rateLimit?.maxRetries || 3,
        lowLimitThreshold: config.rateLimit?.lowLimitThreshold || 10,
        ...config.rateLimit,
      },
      timeoutMs: config.timeoutMs || 30000,
      autoRetryOnAuth: config.autoRetryOnAuth ?? true,
      maxAuthRetries: config.maxAuthRetries || 2,
    };
  }

  async get<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: "GET",
    });
  }

  async post<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  async put<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  async delete<T = unknown>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: "DELETE",
    });
  }

  async patch<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  async request<T = unknown>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    assertStorageHealthy();
    const url = this.buildUrl(endpoint);
    const requestOptions = await this.buildRequestOptions(options);

    logger.debug(`Making API request: ${requestOptions.method || "GET"} ${url}`, {
      service: this.serviceName,
      authenticated: options.authenticated ?? true,
    });

    await this.applyRateLimit();

    const { response, dispose } = await this.makeRequestWithRetry(url, requestOptions);
    try {
      if (!response.ok) {
        throw new Error(
          `${this.serviceName} API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = await this.parseResponse<T>(response);

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
    } catch (error) {
      assertStorageHealthy();
      if (error instanceof Error && error.name === "AbortError" && !options.signal?.aborted) {
        throw new Error(`Request timeout after ${options.timeout || this.config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      dispose();
    }
  }

  async publicRequest<T = unknown>(
    endpoint: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      ...options,
      authenticated: false,
    });
  }

  async testConnection(endpoint: string = "/"): Promise<boolean> {
    try {
      const response = await this.request(endpoint, {
        method: "GET",
        timeout: 10000, // Shorter timeout for connection tests
      });
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      assertStorageHealthy();
      logger.error(`Connection test failed for ${this.serviceName}:`, error);
      return false;
    }
  }

  getTokenHealth(): {
    isValid: boolean;
    expiresAt?: string;
    refreshCount?: number;
  } {
    const health = this.tokens.getTokenHealth();
    return health[this.serviceName] || { isValid: false };
  }

  async clearToken(): Promise<void> {
    await this.tokens.clearToken(this.serviceName);
    logger.info(`Token cleared for ${this.serviceName}`);
  }

  private buildUrl(endpoint: string): string {
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint;
    }

    const baseUrl = this.config.baseUrl.endsWith("/")
      ? this.config.baseUrl.slice(0, -1)
      : this.config.baseUrl;
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    return `${baseUrl}${cleanEndpoint}`;
  }

  private async buildRequestOptions(options: RequestOptions): Promise<RequestOptions> {
    const headers: Record<string, string> = {
      ...this.config.defaultHeaders,
      ...options.headers,
    };

    if (options.authenticated !== false) {
      try {
        const authHeader = await this.getAuthHeader();
        if (authHeader) {
          headers.Authorization = authHeader;
        }
      } catch (error) {
        assertStorageHealthy();
        logger.warn(`Failed to get auth header for ${this.serviceName}:`, error);
      }
    }

    return {
      ...options,
      headers,
    };
  }

  private async getAuthHeader(): Promise<string | null> {
    try {
      const accessToken = await this.tokens.getAccessToken(this.serviceName);
      const tokenMetadata = this.tokens.getTokenMetadata(this.serviceName);

      if (!accessToken) {
        return null;
      }

      const tokenType = tokenMetadata?.tokenType || "Bearer";
      return `${tokenType} ${accessToken}`;
    } catch (error) {
      assertStorageHealthy();
      logger.debug(`Failed to get access token for ${this.serviceName}:`, error);
      return null;
    }
  }

  private async makeRequestWithRetry(
    url: string,
    options: RequestOptions,
  ): Promise<{ response: Response; dispose: () => void }> {
    const timeout = options.timeout || this.config.timeoutMs;
    const callerSignal = AbortSignal.any([
      storageShutdownSignal(),
      ...(options.signal ? [options.signal] : []),
    ]);
    let rateLimitRetries = this.config.rateLimit.maxRetries;
    let authRetries = this.config.maxAuthRetries;

    for (;;) {
      assertStorageHealthy();
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      let response: Response;
      try {
        response = await fetch(url, { ...options, signal });
      } catch (error) {
        clearTimeout(timeoutId);
        if (callerSignal?.aborted) {
          throw callerSignal.reason instanceof Error
            ? callerSignal.reason
            : new Error("Request cancelled");
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Request timeout after ${timeout}ms`);
        }
        if (error instanceof TypeError) {
          const permissionError = await permissionErrorMessageForUrl(url);
          if (permissionError) {
            throw new Error(permissionError);
          }
        }
        throw error;
      }

      const canRetryAuth =
        (response.status === 401 || response.status === 403) &&
        options.authenticated !== false &&
        this.config.autoRetryOnAuth &&
        options.retryOnAuth !== false &&
        authRetries > 0;

      if (canRetryAuth) {
        clearTimeout(timeoutId);
        authRetries -= 1;
        logger.warn(
          `Authentication failed (${response.status}) for ${this.serviceName}, ${authRetries} retries remaining`,
        );

        if (await this.handleAuthFailure()) {
          options = await this.buildRequestOptions(options);
          continue;
        }
      }

      if (response.status === 429 && rateLimitRetries > 0) {
        clearTimeout(timeoutId);
        rateLimitRetries -= 1;
        await this.waitForRetry(this.parseRetryAfterDelay(response), callerSignal ?? undefined);
        continue;
      }

      this.checkRateLimit(response);

      return {
        response,
        dispose: () => clearTimeout(timeoutId),
      };
    }
  }

  private parseRetryAfterDelay(response: Response): number {
    const retryAfter = response.headers.get("Retry-After");
    const rateLimitReset = response.headers.get("X-RateLimit-Reset");

    let delay: number | null = null;

    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) {
        delay = Math.max(0, seconds * 1000);
      } else {
        const retryDate = Date.parse(retryAfter);
        if (!Number.isNaN(retryDate)) {
          delay = Math.max(0, retryDate - Date.now());
        }
      }
    } else if (rateLimitReset) {
      const resetTime = Number.parseInt(rateLimitReset, 10);
      if (Number.isFinite(resetTime)) {
        delay = Math.max(0, resetTime * 1000 - Date.now());
      }
    }

    return delay ?? this.config.rateLimit.delayMs;
  }

  private async waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Request cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delay);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async handleAuthFailure(): Promise<boolean> {
    try {
      const refreshSuccess = await this.attemptTokenRefresh();
      if (refreshSuccess) {
        return true;
      }

      logger.warn(
        `Token refresh failed for ${this.serviceName}, attempting full re-authentication`,
      );
      return await this.attemptReAuthentication();
    } catch (error) {
      assertStorageHealthy();
      logger.error(`Error handling auth failure for ${this.serviceName}:`, error);
      return false;
    }
  }

  private async attemptTokenRefresh(): Promise<boolean> {
    try {
      if (!this.authHandlers.getTokenRefreshConfig) {
        logger.debug(`${this.serviceName} doesn't support token refresh`);
        return false;
      }

      const refreshConfig = this.authHandlers.getTokenRefreshConfig();

      // Adapter signaled no refresh support
      if (!refreshConfig) {
        logger.debug(`${this.serviceName} doesn't support token refresh (static API key)`);
        return false;
      }

      const refreshResult = await this.tokens.refreshToken(this.serviceName, refreshConfig);

      if (refreshResult.success) {
        logger.info(`Token refreshed successfully for ${this.serviceName}`);
        return true;
      } else if (refreshResult.requiresReauth) {
        logger.warn(`Token refresh failed for ${this.serviceName}, requires re-authentication`);
        return false;
      }

      return false;
    } catch (error) {
      assertStorageHealthy();
      logger.error(`Error during token refresh for ${this.serviceName}:`, error);
      return false;
    }
  }

  private async attemptReAuthentication(): Promise<boolean> {
    try {
      if (!this.authHandlers.reAuthenticate) {
        logger.warn(`${this.serviceName} doesn't support re-authentication`);
        return false;
      }

      await this.tokens.clearToken(this.serviceName);

      await this.authHandlers.reAuthenticate();

      logger.info(`Full re-authentication successful for ${this.serviceName}`);
      return true;
    } catch (error) {
      assertStorageHealthy();
      logger.error(`Error during re-authentication for ${this.serviceName}:`, error);
      return false;
    }
  }

  private checkRateLimit(response: Response): void {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const reset = response.headers.get("X-RateLimit-Reset");

    if (remaining && parseInt(remaining, 10) < this.config.rateLimit.lowLimitThreshold) {
      logger.warn(`Low rate limit for ${this.serviceName}: ${remaining} requests remaining`);

      if (reset) {
        const resetTime = parseInt(reset, 10) * 1000;
        const delay = Math.max(0, resetTime - Date.now());
        logger.info(`Rate limit resets in ${Math.round(delay / 1000)} seconds`);
      }
    }
  }

  private async applyRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.config.rateLimit.delayMs) {
      const delay = this.config.rateLimit.delayMs - timeSinceLastRequest;
      logger.debug(`Rate limiting: waiting ${delay}ms`);
      await this.waitForRetry(delay, storageShutdownSignal());
    }

    this.lastRequestTime = Date.now();
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return response.json() as Promise<T>;
    } else if (contentType.includes("text/")) {
      return response.text() as Promise<T>;
    } else {
      return response as unknown as T;
    }
  }
}

export function createApiClient(
  adapter: TokenizedAdapter,
  config?: Partial<ApiClientConfig>,
): ApiClient {
  const authHandlers: AuthHandlers = {
    getTokenRefreshConfig: () => adapter.getTokenRefreshConfig.call(adapter),
    reAuthenticate: adapter.reAuthenticate
      ? () => {
          return adapter.reAuthenticate?.call(adapter) ?? Promise.resolve();
        }
      : undefined,
  };

  adapter.tokens.setRefreshConfigProvider(adapter.getServiceName(), () =>
    adapter.getTokenRefreshConfig.call(adapter),
  );

  return new ApiClient(
    adapter.getServiceName(),
    adapter.getBaseUrl(),
    authHandlers,
    config,
    adapter.tokens,
  );
}
