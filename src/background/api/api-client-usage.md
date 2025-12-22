# ApiClient Usage Guide

The `ApiClient` is a unified HTTP client that handles token management, authentication, retry logic, and rate limiting for all API adapters. It provides a clean interface for making authenticated requests while automatically handling token refresh and error scenarios.

## Features

- **Automatic Token Management**: Handles access token retrieval and refresh automatically
- **Multiple Authentication Types**: Supports static API keys, OAuth with refresh tokens, and OAuth without refresh
- **Retry Logic**: Automatically retries failed requests with token refresh
- **Re-authentication Fallback**: Falls back to full re-authentication when refresh tokens are invalid
- **Rate Limiting**: Built-in rate limiting with configurable delays and retry logic
- **Error Handling**: Comprehensive error handling with proper logging
- **Type Safety**: Full TypeScript support with proper typing

## Basic Usage

### 1. Import the ApiClient

```typescript
import { createApiClient, type ApiClient } from "../api-client";
```

### 2. Initialize in your adapter

```typescript
export class MyAdapter implements ReadItLaterAPI<MySettings>, TokenizedAdapter {
    private apiClient!: ApiClient;

    async initialize(settings: MySettings): Promise<void> {
        // Store your token in the token manager first
        const tokenMetadata = this.createTokenMetadata(tokenData);
        await tokenManager.storeToken(this.getServiceName(), tokenMetadata);

        // Initialize the API client (no circular dependency!)
        this.apiClient = createApiClient(this, {
            baseUrl: "https://api.example.com",
            rateLimit: {
                delayMs: 1000,
                maxRetries: 3,
                lowLimitThreshold: 10,
            },
        });
    }
}
```

### 3. Use the API client for requests

```typescript
// GET request
async getArticles(): Promise<Article[]> {
    const response = await this.apiClient.get("/articles");
    return response.data;
}

// POST request
async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.apiClient.post("/articles", {
        url: article.url,
        title: article.title,
    });
    return response.data;
}

// DELETE request
async deleteArticle(id: number): Promise<void> {
    await this.apiClient.delete(`/articles/${id}`);
}

// PUT request
async updateArticle(id: number, article: Partial<Article>): Promise<Article> {
    const response = await this.apiClient.put(`/articles/${id}`, article);
    return response.data;
}
```

## Configuration Options

### ApiClientConfig

```typescript
interface ApiClientConfig {
    baseUrl: string;                    // Base URL for the API
    defaultHeaders?: Record<string, string>; // Default headers
    rateLimit?: {
        delayMs?: number;               // Delay between requests (default: 1000ms)
        maxRetries?: number;            // Max retries for rate limits (default: 3)
        lowLimitThreshold?: number;     // Warning threshold (default: 10)
    };
    timeoutMs?: number;                 // Request timeout (default: 30000ms)
    autoRetryOnAuth?: boolean;          // Auto retry on 401/403 (default: true)
    maxAuthRetries?: number;            // Max auth retries (default: 2)
}
```

### RequestOptions

```typescript
interface RequestOptions extends RequestInit {
    authenticated?: boolean;            // Include auth headers (default: true)
    timeout?: number;                   // Custom timeout for this request
    retryOnAuth?: boolean;              // Retry on auth failure (default: true)
    headers?: Record<string, string>;   // Additional headers
}
```

## Authentication Types

### 1. Static API Keys (like Raindrop)

```typescript
// No refresh token needed
getTokenRefreshConfig(): TokenRefreshConfig {
    throw new Error("Static API keys don't support refresh");
}

createTokenMetadata(_tokenData: Record<string, unknown>) {
    const now = Date.now();
    return {
        accessToken: this.apiKey,
        refreshToken: "", // No refresh token
        tokenType: "Bearer",
        expiresAt: now + 365 * 24 * 60 * 60 * 1000, // 1 year
        issuedAt: now,
        scope: undefined,
        refreshCount: 0,
    };
}
```

### 2. OAuth with Refresh Tokens (like Wallabag)

```typescript
getTokenRefreshConfig(): TokenRefreshConfig {
    return {
        serviceName: this.getServiceName(),
        refreshUrl: `${this.apiUrl}/oauth/v2/token`,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: tokenManager.getTokenMetadata(this.getServiceName())?.refreshToken || "",
    };
}

createTokenMetadata(tokenData: TokenResponse) {
    const now = Date.now();
    const expiresIn = tokenData.expires_in || 3600;

    return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || "",
        tokenType: tokenData.token_type || "Bearer",
        expiresAt: now + expiresIn * 1000,
        issuedAt: now,
        scope: tokenData.scope,
        refreshCount: 0,
    };
}

// Optional: Implement re-authentication for when refresh tokens fail
async reAuthenticate(): Promise<void> {
    logger.info(`Performing full re-authentication for ${this.getServiceName()}`);
    await this.authenticate(); // Your existing authentication method
}
```

### 3. OAuth without Refresh Tokens (like Instapaper)

```typescript
getTokenRefreshConfig(): TokenRefreshConfig {
    // OAuth 1.0a doesn't support refresh tokens
    throw new Error("OAuth 1.0a doesn't support refresh tokens");
}

createTokenMetadata(_tokenData: Record<string, unknown>) {
    const now = Date.now();
    return {
        accessToken: this.accessToken || "",
        refreshToken: "", // No refresh token for OAuth 1.0a
        tokenType: "OAuth",
        expiresAt: now + 365 * 24 * 60 * 60 * 1000, // 1 year
        issuedAt: now,
        scope: undefined,
        refreshCount: 0,
    };
}

// Implement re-authentication for when tokens are invalid
async reAuthenticate(): Promise<void> {
    logger.info(`Performing full re-authentication for ${this.getServiceName()}`);
    await this.authenticate(); // Your existing OAuth 1.0a authentication method
}
```

## Error Handling

The ApiClient automatically handles common error scenarios:

### Authentication Errors (401/403)

- Automatically attempts token refresh if supported
- Falls back to full re-authentication if refresh fails or is unavailable
- Retries the original request with new tokens
- Supports both refresh token flow and full re-authentication

### Rate Limiting (429)

- Automatically waits for the specified delay
- Retries the request up to the configured limit
- Logs warnings when approaching rate limits

### Network Errors

- Proper timeout handling
- Connection error logging
- Graceful degradation

## Advanced Usage

### Custom Request Headers

```typescript
const response = await this.apiClient.get("/endpoint", {
    headers: {
        "X-Custom-Header": "value",
        "Accept": "application/vnd.api+json",
    },
});
```

### Public Endpoints (No Authentication)

```typescript
const response = await this.apiClient.publicRequest("/public/status");
```

### Custom Timeout

```typescript
const response = await this.apiClient.get("/slow-endpoint", {
    timeout: 60000, // 60 seconds
});
```

### Connection Testing

```typescript
async testConnection(): Promise<boolean> {
    return await this.apiClient.testConnection("/health");
}
```

## Migration from Old Adapters

### Before (Old Pattern)

```typescript
private async makeAuthenticatedRequest(url: string, options: RequestInit = {}): Promise<Response> {
    const accessToken = await tokenManager.getAccessToken(this.getServiceName());

    return this._fetchWithRateLimit(url, {
        ...options,
        headers: {
            ...options.headers,
            Authorization: `Bearer ${accessToken}`,
        },
    });
}

async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.makeAuthenticatedRequest(
        `${this.apiUrl}/articles`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(article),
        }
    );
    const data = await response.json();
    return this.mapArticle(data);
}
```

### After (New Pattern)

```typescript
async saveArticle(article: SavingArticle): Promise<Article> {
    const response = await this.apiClient.post("/articles", article);
    return this.mapArticle(response.data);
}
```

## Re-authentication Flow

The ApiClient implements a sophisticated authentication flow that handles various failure scenarios:

1. **Token Refresh First**: When a 401/403 error occurs, the client first attempts to refresh the token using the refresh token
2. **Re-authentication Fallback**: If refresh fails or is not supported, the client attempts full re-authentication
3. **Automatic Retry**: After successful authentication, the original request is automatically retried
4. **Graceful Degradation**: If all authentication attempts fail, the request fails with a clear error message

### Implementation Requirements

For adapters that support re-authentication, implement the optional `reAuthenticate()` method:

```typescript
async reAuthenticate(): Promise<void> {
    // Clear existing tokens
    await tokenManager.clearToken(this.getServiceName());

    // Perform full authentication flow
    await this.authenticate();

    // Tokens are automatically stored by the authentication method
}
```

## Architecture: No Circular Dependencies

The ApiClient is designed to avoid circular dependencies between adapters and the client:

### **Problem Solved**

- **Before**: Adapter → ApiClient → Adapter (circular reference)
- **After**: Adapter → ApiClient (with function references)

### **Solution**

The ApiClient uses an `AuthHandlers` interface that contains function references instead of storing the adapter directly:

```typescript
interface AuthHandlers {
    getTokenRefreshConfig?: () => TokenRefreshConfig;
    reAuthenticate?: () => Promise<void>;
}
```

This allows the ApiClient to call adapter methods without storing a reference to the adapter, breaking the circular dependency.

## Benefits

1. **No Circular Dependencies**: Clean architecture with proper separation of concerns
2. **Reduced Code Duplication**: No need to implement authentication logic in each adapter
3. **Consistent Error Handling**: All adapters handle errors the same way
4. **Automatic Token Management**: Tokens are refreshed automatically
5. **Re-authentication Fallback**: Handles cases where refresh tokens are invalid
6. **Built-in Rate Limiting**: No need to implement rate limiting per adapter
7. **Type Safety**: Full TypeScript support with proper typing
8. **Easier Testing**: Mock the ApiClient for unit tests
9. **Better Logging**: Centralized logging for all API requests

## Best Practices

1. **Initialize Once**: Create the ApiClient in the `initialize` method
2. **Use Appropriate HTTP Methods**: Use `get`, `post`, `put`, `delete` methods
3. **Handle Errors Gracefully**: The ApiClient handles most errors, but validate responses
4. **Configure Rate Limits**: Set appropriate rate limits for your API
5. **Test Connections**: Use `testConnection()` for health checks
6. **Clean Up**: Call `cleanup()` when the adapter is no longer needed
