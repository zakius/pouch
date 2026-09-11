/**
 * API Client with Token Management
 *
 * A unified HTTP client that handles token management, authentication,
 * retry logic, and rate limiting for all API adapters.
 */

import { logger } from "../../utils/logger";
import { type TokenRefreshConfig, tokenManager } from "../token-manager";
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
    const url = this.buildUrl(endpoint);
    const requestOptions = await this.buildRequestOptions(options);

    logger.debug(`Making API request: ${requestOptions.method || "GET"} ${url}`, {
      service: this.serviceName,
      authenticated: options.authenticated ?? true,
    });

    await this.applyRateLimit();

    const response = await this.makeRequestWithRetry(url, requestOptions, options);
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
      logger.error(`Connection test failed for ${this.serviceName}:`, error);
      return false;
    }
  }

  getTokenHealth(): {
    isValid: boolean;
    expiresAt?: string;
    refreshCount?: number;
  } {
    const health = tokenManager.getTokenHealth();
    return health[this.serviceName] || { isValid: false };
  }

  async clearToken(): Promise<void> {
    await tokenManager.clearToken(this.serviceName);
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

  private async buildRequestOptions(options: RequestOptions): Promise<RequestInit> {
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
      const accessToken = await tokenManager.getAccessToken(this.serviceName);
      const tokenMetadata = tokenManager.getTokenMetadata(this.serviceName);

      if (!accessToken) {
        return null;
      }

      const tokenType = tokenMetadata?.tokenType || "Bearer";
      return `${tokenType} ${accessToken}`;
    } catch (error) {
      logger.debug(`Failed to get access token for ${this.serviceName}:`, error);
      return null;
    }
  }

  private async makeRequestWithRetry(
    url: string,
    options: RequestInit,
    requestOptions: RequestOptions,
    attempt: number = 1,
  ): Promise<Response> {
    const timeout = requestOptions.timeout || this.config.timeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (
        (response.status === 401 || response.status === 403) &&
        requestOptions.authenticated !== false &&
        this.config.autoRetryOnAuth &&
        attempt <= this.config.maxAuthRetries
      ) {
        logger.warn(
          `Authentication failed (${response.status}) for ${this.serviceName}, attempt ${attempt}`,
        );

        const refreshResult = await this.handleAuthFailure();
        if (refreshResult && attempt < this.config.maxAuthRetries) {
          const newOptions = await this.buildRequestOptions(requestOptions);
          return this.makeRequestWithRetry(url, newOptions, requestOptions, attempt + 1);
        }
      }

      if (response.status === 429) {
        await this.handleRateLimit(response);
        if (attempt <= this.config.rateLimit.maxRetries) {
          return this.makeRequestWithRetry(url, options, requestOptions, attempt + 1);
        }
      }

      this.checkRateLimit(response);

      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${timeout}ms`);
      }

      throw error;
    }
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

      const refreshResult = await tokenManager.refreshToken(this.serviceName, refreshConfig);

      if (refreshResult.success) {
        logger.info(`Token refreshed successfully for ${this.serviceName}`);
        return true;
      } else if (refreshResult.requiresReauth) {
        logger.warn(`Token refresh failed for ${this.serviceName}, requires re-authentication`);
        return false;
      }

      return false;
    } catch (error) {
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

      await tokenManager.clearToken(this.serviceName);

      await this.authHandlers.reAuthenticate();

      logger.info(`Full re-authentication successful for ${this.serviceName}`);
      return true;
    } catch (error) {
      logger.error(`Error during re-authentication for ${this.serviceName}:`, error);
      return false;
    }
  }

  private async handleRateLimit(response: Response): Promise<void> {
    const retryAfter = response.headers.get("Retry-After");
    const rateLimitReset = response.headers.get("X-RateLimit-Reset");

    let delay = this.config.rateLimit.delayMs;

    if (retryAfter) {
      delay = parseInt(retryAfter, 10) * 1000;
    } else if (rateLimitReset) {
      const resetTime = parseInt(rateLimitReset, 10) * 1000;
      delay = Math.max(0, resetTime - Date.now());
    }

    logger.warn(`Rate limit hit for ${this.serviceName}, waiting ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
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
      await new Promise((resolve) => setTimeout(resolve, delay));
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

  return new ApiClient(adapter.getServiceName(), adapter.getBaseUrl(), authHandlers, config);
}
