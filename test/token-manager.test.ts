import { runOperation } from "../src/background/api/effect-adapter";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  hashAccountIdentity,
  type TokenMetadata,
  TokenManager,
} from "../src/background/token-manager";

interface AlarmsMock {
  create: ReturnType<typeof mock>;
  clear: ReturnType<typeof mock>;
  existing?: { name: string; periodInMinutes: number };
}

function setupBrowser() {
  const storage: Record<string, unknown> = {};
  const alarms: AlarmsMock = {
    create: mock(() => ({})),
    clear: mock(async () => true),
  };
  Object.assign(globalThis, {
    browser: {
      permissions: { contains: async () => true },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storage[key] }),
          set: async (values: Record<string, unknown>) => {
            Object.assign(storage, values);
          },
        },
      },
      alarms: {
        create: alarms.create,
        clear: alarms.clear,
        get: async () => alarms.existing,
      },
    },
  });
  return { storage, alarms };
}

const baseToken = {
  accessToken: "old-access",
  refreshToken: "refresh-token",
  tokenType: "Bearer",
  expiresAt: Date.now() + 60 * 1000,
  issuedAt: Date.now(),
  refreshCount: 0,
};

const refreshConfig = {
  serviceName: "wallabag",
  refreshUrl: "https://example.com/oauth/v2/token",
  clientId: "id",
  clientSecret: "secret",
  refreshToken: "refresh-token",
};

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      ...overrides,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

afterEach(() => {
  mock.restore();
  Reflect.deleteProperty(globalThis, "browser");
});

test("getAccessToken refreshes an expiring token with supplied configuration", async () => {
  setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 5 * 60 * 1000 });
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse());
  const accessToken = await runOperation(manager.getAccessToken("wallabag"));

  expect(accessToken).toBe("new-access");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(refreshConfig.refreshUrl);
  expect(String(init.body)).toContain("refresh_token=refresh-token");
});

test("checkAndRefreshTokens refreshes an expiring token without creating a repeating alarm", async () => {
  const { alarms, storage } = setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 0 });
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", { ...baseToken, expiresAt: Date.now() + 60 * 1000 }));

  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse());
  await runOperation(manager.checkAndRefreshTokens);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const metadata = manager.getTokenMetadata("wallabag");
  expect(metadata?.accessToken).toBe("new-access");
  expect(Array.from(storage.api_tokens as [string, TokenMetadata][])).toHaveLength(1);
  expect(alarms.create).not.toHaveBeenCalled();
});

test("storeToken does not schedule token-refresh-check, and loadTokens and clearToken clear leftover alarms", async () => {
  const { alarms, storage } = setupBrowser();
  storage.api_tokens = [["wallabag", { ...baseToken, serviceName: "wallabag" }]];
  alarms.existing = { name: "token-refresh-check", periodInMinutes: 5 };

  const manager = new TokenManager();
  await runOperation(manager.loadTokens);
  expect(alarms.create).not.toHaveBeenCalled();
  expect(alarms.clear).toHaveBeenCalledWith("token-refresh-check");

  alarms.clear.mockClear();
  await runOperation(manager.storeToken("wallabag", baseToken));
  expect(alarms.create).not.toHaveBeenCalled();

  await runOperation(manager.clearToken("wallabag"));
  expect(alarms.clear).toHaveBeenCalledWith("token-refresh-check");

  // Even with no stored tokens, loadTokens clears any leftover alarm.
  alarms.clear.mockClear();
  delete storage.api_tokens;
  await runOperation(new TokenManager().loadTokens);
  expect(alarms.create).not.toHaveBeenCalled();
  expect(alarms.clear).toHaveBeenCalledWith("token-refresh-check");

  // Non-persisting TokenManager (e.g. testConnection draft) never touches browser alarms.
  alarms.clear.mockClear();
  const ephemeral = new TokenManager({ persist: false });
  await runOperation(ephemeral.storeToken("wallabag", baseToken));
  await runOperation(ephemeral.clearToken("wallabag"));
  expect(alarms.create).not.toHaveBeenCalled();
  expect(alarms.clear).not.toHaveBeenCalled();
});

test("concurrent refresh callers share a single request and result", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  let resolveFetch: ((response: Response) => void) | undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );

  const first = runOperation(manager.refreshToken("wallabag"));
  const second = runOperation(manager.refreshToken("wallabag"));
  for (let i = 0; i < 100 && !resolveFetch; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  resolveFetch?.(tokenResponse());
  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(firstResult.success).toBe(true);
  expect(secondResult).toEqual(firstResult);
});

test("the rotated refresh token is used by subsequent refreshes", async () => {
  setupBrowser();
  const manager = new TokenManager({ refreshCooldownMs: 0 });
  manager.setRefreshConfigProvider("wallabag", () => ({
    ...refreshConfig,
    refreshToken: manager.getTokenMetadata("wallabag")?.refreshToken ?? "",
  }));
  await runOperation(manager.storeToken("wallabag", baseToken));

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(tokenResponse()),
  );
  await runOperation(manager.refreshToken("wallabag"));
  await runOperation(manager.refreshToken("wallabag"));

  const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
  expect(bodies[0]).toContain("refresh_token=refresh-token");
  expect(bodies[1]).toContain("refresh_token=new-refresh");
});

test("a network failure preserves credentials and does not require reauth", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const result = await runOperation(manager.refreshToken("wallabag"));

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
  const stillUsable = await runOperation(manager.getAccessToken("wallabag"));
  expect(stillUsable).toBe("old-access");
});

test("a rate-limited refresh preserves credentials", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429 }));
  const result = await runOperation(manager.refreshToken("wallabag"));

  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});

test("a definitive rejection clears credentials and requires reauth", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"error":"invalid_grant"}', { status: 400 }),
  );
  const result = await runOperation(manager.refreshToken("wallabag"));

  expect(result.requiresReauth).toBe(true);
  expect(manager.getTokenMetadata("wallabag")).toBeNull();
});

test("an invalid refresh response preserves credentials", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));

  spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse({ access_token: "" }));
  const result = await runOperation(manager.refreshToken("wallabag"));

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});

test("tokens survive a restart through storage", async () => {
  const { storage } = setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 0 });
  await runOperation(manager.storeToken("wallabag", { ...baseToken, expiresAt: Date.now() + 3600 * 1000 }));

  const reloaded = new TokenManager({ refreshBufferMs: 0 });
  await runOperation(reloaded.loadTokens);

  expect(reloaded.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
  const accessToken = await runOperation(reloaded.getAccessToken("wallabag"));
  expect(accessToken).toBe("old-access");
  expect(storage.api_tokens).toBeDefined();
});

test("static keys are returned without refresh attempts", async () => {
  setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 5 * 60 * 1000 });
  await runOperation(manager.storeToken("instapaper", {
    ...baseToken,
    refreshToken: "",
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  }));

  const fetchMock = spyOn(globalThis, "fetch");
  const accessToken = await runOperation(manager.getAccessToken("instapaper"));

  expect(accessToken).toBe("old-access");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(manager.getTokenMetadata("instapaper")).not.toBeNull();
});

test("refresh without configuration fails without deleting the token", async () => {
  setupBrowser();
  const manager = new TokenManager();
  await runOperation(manager.storeToken("wallabag", baseToken));

  const result = await runOperation(manager.refreshToken("wallabag"));

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});

test("cold-start TokenManager evicts persisted Account A token when binding Account B and hashes identity", async () => {
  const { storage } = setupBrowser();
  const identityA = JSON.stringify({
    url: "https://a.example",
    username: "alice",
    password: "SECRET_PASSWORD_A",
  });
  const identityB = JSON.stringify({
    url: "https://b.example",
    username: "bob",
    password: "SECRET_PASSWORD_B",
  });

  const first = new TokenManager({ refreshBufferMs: 0 });
  await runOperation(first.bindAccount("wallabag", identityA));
  await runOperation(
    first.storeToken("wallabag", { ...baseToken, accessToken: "token-a", expiresAt: Date.now() + 3600_000 }),
  );

  // Persisted token contains SHA-256 hash, never raw credentials.
  const storedJson = JSON.stringify(storage.api_tokens);
  expect(storedJson).toContain(await hashAccountIdentity(identityA));
  expect(storedJson).not.toContain("SECRET_PASSWORD_A");
  expect(storedJson).not.toContain("alice");

  // Same account survives cold start.
  const sameAccount = new TokenManager({ refreshBufferMs: 0 });
  await runOperation(sameAccount.loadTokens);
  await runOperation(sameAccount.bindAccount("wallabag", identityA));
  expect(sameAccount.getTokenMetadata("wallabag")?.accessToken).toBe("token-a");

  // Different account on cold start evicts Account A's token from memory and storage.local.
  const differentAccount = new TokenManager({ refreshBufferMs: 0 });
  await runOperation(differentAccount.loadTokens);
  expect(differentAccount.getTokenMetadata("wallabag")?.accessToken).toBe("token-a");
  await runOperation(differentAccount.bindAccount("wallabag", identityB));
  expect(differentAccount.getTokenMetadata("wallabag")).toBeNull();
  expect(storage.api_tokens).toEqual([]);
});

test("loadTokens handles corrupt or non-iterable api_tokens without throwing", async () => {
  const { storage } = setupBrowser();
  for (const corrupt of [42, "not-an-array", { wallabag: baseToken }, true]) {
    storage.api_tokens = corrupt;
    const manager = new TokenManager();
    await runOperation(manager.loadTokens);
    expect(manager.getTokenMetadata("wallabag")).toBeNull();
  }

  // Partially corrupt array skips malformed entries and keeps valid ones.
  const validEntry: [string, TokenMetadata] = [
    "wallabag",
    { ...baseToken, serviceName: "wallabag", accessToken: "valid-token" },
  ];
  storage.api_tokens = [
    "not-a-tuple",
    ["", { ...baseToken, serviceName: "empty-key" }],
    ["missing-access", { ...baseToken, serviceName: "missing-access", accessToken: "" }],
    ["nan-expiry", { ...baseToken, serviceName: "nan-expiry", expiresAt: Number.NaN }],
    ["negative-count", { ...baseToken, serviceName: "negative-count", refreshCount: -1 }],
    validEntry,
  ];
  const manager = new TokenManager();
  await runOperation(manager.loadTokens);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("valid-token");
  expect(manager.getTokenMetadata("missing-access")).toBeNull();
  expect(manager.getTokenMetadata("nan-expiry")).toBeNull();
  expect(manager.getTokenMetadata("negative-count")).toBeNull();
});

test("transient refresh failure does not perform unnecessary storage.local.set writes", async () => {
  setupBrowser();
  const setSpy = spyOn(browser.storage.local, "set");
  const manager = new TokenManager({ refreshCooldownMs: 0 });
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await runOperation(manager.storeToken("wallabag", baseToken));
  setSpy.mockClear();

  spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Offline"));
  const networkResult = await runOperation(manager.refreshToken("wallabag"));
  expect(networkResult.success).toBe(false);
  expect(networkResult.requiresReauth).toBe(false);
  expect(setSpy).not.toHaveBeenCalled();
  expect(manager.getTokenMetadata("wallabag")?.refreshCount).toBe(1);

  spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("busy", { status: 503 }));
  const serverResult = await runOperation(manager.refreshToken("wallabag"));
  expect(serverResult.success).toBe(false);
  expect(serverResult.requiresReauth).toBe(false);
  expect(setSpy).not.toHaveBeenCalled();
  expect(manager.getTokenMetadata("wallabag")?.refreshCount).toBe(2);
});
