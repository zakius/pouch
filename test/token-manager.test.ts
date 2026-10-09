import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { type TokenMetadata, TokenManager } from "../src/background/token-manager";

interface AlarmsMock {
  create: ReturnType<typeof mock>;
  existing?: { name: string; periodInMinutes: number };
}

function setupBrowser() {
  const storage: Record<string, unknown> = {};
  const alarms: AlarmsMock = {
    create: mock(() => ({})),
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
  await manager.storeToken("wallabag", baseToken);

  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse());
  const accessToken = await manager.getAccessToken("wallabag");

  expect(accessToken).toBe("new-access");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(refreshConfig.refreshUrl);
  expect(String(init.body)).toContain("refresh_token=refresh-token");
});

test("the periodic alarm refreshes an expiring token without deleting credentials", async () => {
  const { alarms, storage } = setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 0 });
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", { ...baseToken, expiresAt: Date.now() + 60 * 1000 });

  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse());
  await manager["checkAndRefreshTokens"]();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const metadata = manager.getTokenMetadata("wallabag");
  expect(metadata?.accessToken).toBe("new-access");
  expect(Array.from(storage.api_tokens as [string, TokenMetadata][])).toHaveLength(1);
  expect(alarms.create).toHaveBeenCalledWith("token-refresh-check", { periodInMinutes: 5 });
});

test("loading tokens keeps a running refresh alarm, as when Chromium's worker wakes", async () => {
  const { alarms, storage } = setupBrowser();
  storage.api_tokens = [["wallabag", { ...baseToken, serviceName: "wallabag" }]];
  alarms.existing = { name: "token-refresh-check", periodInMinutes: 5 };
  await new TokenManager().loadTokens();
  expect(alarms.create).not.toHaveBeenCalled();
});

test("concurrent refresh callers share a single request and result", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", baseToken);

  let resolveFetch: ((response: Response) => void) | undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );

  const first = manager.refreshToken("wallabag");
  const second = manager.refreshToken("wallabag");
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
  await manager.storeToken("wallabag", baseToken);

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(tokenResponse()),
  );
  await manager.refreshToken("wallabag");
  await manager.refreshToken("wallabag");

  const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
  expect(bodies[0]).toContain("refresh_token=refresh-token");
  expect(bodies[1]).toContain("refresh_token=new-refresh");
});

test("a network failure preserves credentials and does not require reauth", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", baseToken);

  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const result = await manager.refreshToken("wallabag");

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
  const stillUsable = await manager.getAccessToken("wallabag");
  expect(stillUsable).toBe("old-access");
});

test("a rate-limited refresh preserves credentials", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", baseToken);

  spyOn(globalThis, "fetch").mockResolvedValue(new Response("slow down", { status: 429 }));
  const result = await manager.refreshToken("wallabag");

  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});

test("a definitive rejection clears credentials and requires reauth", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", baseToken);

  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response('{"error":"invalid_grant"}', { status: 400 }),
  );
  const result = await manager.refreshToken("wallabag");

  expect(result.requiresReauth).toBe(true);
  expect(manager.getTokenMetadata("wallabag")).toBeNull();
});

test("an invalid refresh response preserves credentials", async () => {
  setupBrowser();
  const manager = new TokenManager();
  manager.setRefreshConfigProvider("wallabag", () => refreshConfig);
  await manager.storeToken("wallabag", baseToken);

  spyOn(globalThis, "fetch").mockResolvedValue(tokenResponse({ access_token: "" }));
  const result = await manager.refreshToken("wallabag");

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});

test("tokens survive a restart through storage", async () => {
  const { storage } = setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 0 });
  await manager.storeToken("wallabag", { ...baseToken, expiresAt: Date.now() + 3600 * 1000 });

  const reloaded = new TokenManager({ refreshBufferMs: 0 });
  await reloaded.loadTokens();

  expect(reloaded.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
  const accessToken = await reloaded.getAccessToken("wallabag");
  expect(accessToken).toBe("old-access");
  expect(storage.api_tokens).toBeDefined();
});

test("static keys are returned without refresh attempts", async () => {
  setupBrowser();
  const manager = new TokenManager({ refreshBufferMs: 5 * 60 * 1000 });
  await manager.storeToken("instapaper", {
    ...baseToken,
    refreshToken: "",
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  });

  const fetchMock = spyOn(globalThis, "fetch");
  const accessToken = await manager.getAccessToken("instapaper");

  expect(accessToken).toBe("old-access");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(manager.getTokenMetadata("instapaper")).not.toBeNull();
});

test("refresh without configuration fails without deleting the token", async () => {
  setupBrowser();
  const manager = new TokenManager();
  await manager.storeToken("wallabag", baseToken);

  const result = await manager.refreshToken("wallabag");

  expect(result.success).toBe(false);
  expect(result.requiresReauth).toBe(false);
  expect(manager.getTokenMetadata("wallabag")?.accessToken).toBe("old-access");
});
