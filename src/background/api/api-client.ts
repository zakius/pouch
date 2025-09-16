/**
 * API Client with Token Management
 *
 * A unified HTTP client that handles token management, authentication,
 * retry logic, and rate limiting for all API adapters.
 */

import { logger } from "../../utils/logger";
import { tokenManager, type TokenRefreshConfig } from "../token-manager";
import type { TokenizedAdapter } from "./tokenized-adapter";

export interface ApiClientConfig {
	/**
	 * Base URL for the API
	 */
	baseUrl: string;
	
	/**
	 * Default headers to include with all requests
	 */
	defaultHeaders?: Record<string, string>;
	
	/**
	 * Rate limiting configuration
	 */
	rateLimit?: {
		/**
		 * Delay between requests in milliseconds
		 */
		delayMs?: number;
		
		/**
		 * Maximum number of retries for rate-limited requests
		 */
		maxRetries?: number;
		
		/**
		 * Threshold for low rate limit warnings
		 */
		lowLimitThreshold?: number;
	};
	
	/**
	 * Request timeout in milliseconds
	 */
	timeoutMs?: number;
	
	/**
	 * Whether to automatically retry on 401/403 errors
	 */
	autoRetryOnAuth?: boolean;
	
	/**
	 * Maximum number of authentication retries
	 */
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
	/**
	 * Whether to include authentication headers
	 */
	authenticated?: boolean;
	
	/**
	 * Custom timeout for this request
	 */
	timeout?: number;
	
	/**
	 * Whether to retry on authentication failure
	 */
	retryOnAuth?: boolean;
	
	/**
	 * Additional headers for this request
	 */
	headers?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
	data: T;
	status: number;
	statusText: string;
	headers: Headers;
}

export interface AuthHandlers {
	getTokenRefreshConfig?: () => TokenRefreshConfig;
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
		config: Partial<ApiClientConfig> = {}
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

	/**
	 * Make an authenticated GET request
	 */
	async get<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
		return this.request<T>(endpoint, {
			...options,
			method: "GET",
		});
	}

	/**
	 * Make an authenticated POST request
	 */
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

	/**
	 * Make an authenticated PUT request
	 */
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

	/**
	 * Make an authenticated DELETE request
	 */
	async delete<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
		return this.request<T>(endpoint, {
			...options,
			method: "DELETE",
		});
	}

	/**
	 * Make an authenticated PATCH request
	 */
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

	/**
	 * Make a raw request with full control over options
	 */
	async request<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
		const url = this.buildUrl(endpoint);
		const requestOptions = await this.buildRequestOptions(options);
		
		logger.debug(`Making API request: ${requestOptions.method || "GET"} ${url}`, {
			service: this.serviceName,
			authenticated: options.authenticated ?? true,
		});

		// Apply rate limiting
		await this.applyRateLimit();

		// Make the request with retry logic
		const response = await this.makeRequestWithRetry(url, requestOptions, options);
		
		// Parse response
		const data = await this.parseResponse<T>(response);
		
		return {
			data,
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		};
	}

	/**
	 * Make a request without authentication (for public endpoints)
	 */
	async publicRequest<T = unknown>(
		endpoint: string,
		options: RequestOptions = {},
	): Promise<ApiResponse<T>> {
		return this.request<T>(endpoint, {
			...options,
			authenticated: false,
		});
	}

	/**
	 * Test the connection to the API
	 */
	async testConnection(endpoint: string = "/"): Promise<boolean> {
		try {
			const response = await this.request(endpoint, {
				method: "GET",
				timeout: 10000, // Shorter timeout for connection tests
			});
			return response.status < 500; // Consider 4xx as connection working
		} catch (error) {
			logger.error(`Connection test failed for ${this.serviceName}:`, error);
			return false;
		}
	}

	/**
	 * Get the current token health
	 */
	getTokenHealth(): { isValid: boolean; expiresAt?: string; refreshCount?: number } {
		const health = tokenManager.getTokenHealth();
		return health[this.serviceName] || { isValid: false };
	}

	/**
	 * Clear the stored token (force re-authentication)
	 */
	async clearToken(): Promise<void> {
		await tokenManager.clearToken(this.serviceName);
		logger.info(`Token cleared for ${this.serviceName}`);
	}

	/**
	 * Build the full URL for an endpoint
	 */
	private buildUrl(endpoint: string): string {
		// Handle absolute URLs
		if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
			return endpoint;
		}
		
		// Ensure base URL ends with / and endpoint doesn't start with /
		const baseUrl = this.config.baseUrl.endsWith("/") 
			? this.config.baseUrl.slice(0, -1) 
			: this.config.baseUrl;
		const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
		
		return `${baseUrl}${cleanEndpoint}`;
	}

	/**
	 * Build request options with authentication and default headers
	 */
	private async buildRequestOptions(options: RequestOptions): Promise<RequestInit> {
		const headers: Record<string, string> = {
			...this.config.defaultHeaders,
			...options.headers,
		};

		// Add authentication if requested
		if (options.authenticated !== false) {
			try {
				const authHeader = await this.getAuthHeader();
				if (authHeader) {
					headers.Authorization = authHeader;
				}
			} catch (error) {
				logger.warn(`Failed to get auth header for ${this.serviceName}:`, error);
				// Continue without auth header - let the request fail and be handled by retry logic
			}
		}

		return {
			...options,
			headers,
		};
	}

	/**
	 * Get the authentication header for the request
	 */
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

	/**
	 * Make a request with retry logic for authentication failures
	 */
	private async makeRequestWithRetry(
		url: string,
		options: RequestInit,
		requestOptions: RequestOptions,
		attempt: number = 1,
	): Promise<Response> {
		const timeout = requestOptions.timeout || this.config.timeoutMs;
		
		// Create abort controller for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			// Handle authentication failures
			if ((response.status === 401 || response.status === 403) && 
				requestOptions.authenticated !== false && 
				this.config.autoRetryOnAuth &&
				attempt <= this.config.maxAuthRetries) {
				
				logger.warn(`Authentication failed (${response.status}) for ${this.serviceName}, attempt ${attempt}`);
				
				// Try to refresh token and retry
				const refreshResult = await this.handleAuthFailure();
				if (refreshResult && attempt < this.config.maxAuthRetries) {
					// Retry with new token
					const newOptions = await this.buildRequestOptions(requestOptions);
					return this.makeRequestWithRetry(url, newOptions, requestOptions, attempt + 1);
				}
			}

			// Handle rate limiting
			if (response.status === 429) {
				await this.handleRateLimit(response);
				if (attempt <= this.config.rateLimit.maxRetries) {
					return this.makeRequestWithRetry(url, options, requestOptions, attempt + 1);
				}
			}

			// Check for low rate limit
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

	/**
	 * Handle authentication failure by attempting token refresh, then full re-authentication
	 */
	private async handleAuthFailure(): Promise<boolean> {
		try {
			// First, try token refresh if supported
			const refreshSuccess = await this.attemptTokenRefresh();
			if (refreshSuccess) {
				return true;
			}

			// If refresh failed or is not supported, try full re-authentication
			logger.warn(`Token refresh failed for ${this.serviceName}, attempting full re-authentication`);
			return await this.attemptReAuthentication();
		} catch (error) {
			logger.error(`Error handling auth failure for ${this.serviceName}:`, error);
			return false;
		}
	}

	/**
	 * Attempt to refresh the token using the refresh token
	 */
	private async attemptTokenRefresh(): Promise<boolean> {
		try {
			// Check if this service supports token refresh
			if (!this.authHandlers.getTokenRefreshConfig) {
				logger.debug(`${this.serviceName} doesn't support token refresh`);
				return false;
			}

			const refreshConfig = this.authHandlers.getTokenRefreshConfig();

			// Attempt to refresh the token
			const refreshResult = await tokenManager.refreshToken(
				this.serviceName,
				refreshConfig,
			);

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

	/**
	 * Attempt full re-authentication using the adapter's reAuthenticate method
	 */
	private async attemptReAuthentication(): Promise<boolean> {
		try {
			// Check if the service supports re-authentication
			if (!this.authHandlers.reAuthenticate) {
				logger.warn(`${this.serviceName} doesn't support re-authentication`);
				return false;
			}

			// Clear existing tokens first
			await tokenManager.clearToken(this.serviceName);

			// Perform full re-authentication
			await this.authHandlers.reAuthenticate();
			
			logger.info(`Full re-authentication successful for ${this.serviceName}`);
			return true;
		} catch (error) {
			logger.error(`Error during re-authentication for ${this.serviceName}:`, error);
			return false;
		}
	}

	/**
	 * Handle rate limiting by waiting for the specified delay
	 */
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
		await new Promise(resolve => setTimeout(resolve, delay));
	}

	/**
	 * Check for low rate limit and warn if approaching limit
	 */
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

	/**
	 * Apply rate limiting between requests
	 */
	private async applyRateLimit(): Promise<void> {
		const now = Date.now();
		const timeSinceLastRequest = now - this.lastRequestTime;
		
		if (timeSinceLastRequest < this.config.rateLimit.delayMs) {
			const delay = this.config.rateLimit.delayMs - timeSinceLastRequest;
			logger.debug(`Rate limiting: waiting ${delay}ms`);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
		
		this.lastRequestTime = Date.now();
	}

	/**
	 * Parse the response based on content type
	 */
	private async parseResponse<T>(response: Response): Promise<T> {
		const contentType = response.headers.get("content-type") || "";
		
		if (contentType.includes("application/json")) {
			return response.json() as Promise<T>;
		} else if (contentType.includes("text/")) {
			return response.text() as Promise<T>;
		} else {
			// For other content types, return the response as-is
			return response as unknown as T;
		}
	}
}

/**
 * Factory function to create an ApiClient for a given adapter
 */
export function createApiClient(
	adapter: TokenizedAdapter,
	config?: Partial<ApiClientConfig>,
): ApiClient {
	const authHandlers: AuthHandlers = {
		getTokenRefreshConfig: () => adapter.getTokenRefreshConfig(),
		reAuthenticate: adapter.reAuthenticate ? (() => {
			const reAuth = adapter.reAuthenticate;
			return reAuth ? reAuth() : Promise.resolve();
		}) : undefined,
	};

	return new ApiClient(
		adapter.getServiceName(),
		adapter.getBaseUrl(),
		authHandlers,
		config
	);
}
