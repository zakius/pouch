import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ApiClient } from "../src/background/api/api-client";
import { tokenManager } from "../src/background/token-manager";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });

const authHandlers = {
  getTokenRefreshConfig: () => ({
    serviceName: "test",
    refreshUrl: "https://example.com/token",
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
  }),
};

afterEach(() => {
  mock.restore();
});

test("an already-aborted signal rejects immediately", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new DOMException("aborted", "AbortError")), 10),
      ),
  );
  const client = new ApiClient("test", "https://example.com", {
    rateLimit: { delayMs: 0 },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(client.get("/items", { signal: controller.signal })).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("retryOnAuth=false disables authentication retries", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const refresh = spyOn(tokenManager, "refreshToken").mockResolvedValue({ success: true });
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("denied", { status: 401 }),
  );
  const client = new ApiClient("test", "https://example.com", {
    rateLimit: { delayMs: 0 },
  });
  await expect(client.get("/items", { retryOnAuth: false })).rejects.toThrow("401");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});

test("one permitted authentication retry recovers a 401", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  spyOn(tokenManager, "refreshToken").mockResolvedValue({ success: true });
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("denied", { status: 401 }))
    .mockResolvedValueOnce(json({ ok: true }));
  const client = new ApiClient("test", "https://example.com", authHandlers, {
    maxAuthRetries: 1,
    rateLimit: { delayMs: 0 },
  });
  const response = await client.get<{ ok: boolean }>("/items");
  expect(response.data).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("429 then success retries without consuming auth retries", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const refresh = spyOn(tokenManager, "refreshToken").mockResolvedValue({ success: true });
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  const client = new ApiClient("test", "https://example.com", {}, {
    rateLimit: { delayMs: 0, maxRetries: 3 },
  });
  const response = await client.get<{ ok: boolean }>("/items");
  expect(response.data).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
});

test("mixed auth and rate-limit failures recover independently", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  spyOn(tokenManager, "refreshToken").mockResolvedValue({ success: true });
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("denied", { status: 401 }))
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  const client = new ApiClient("test", "https://example.com", authHandlers, {
    maxAuthRetries: 2,
    rateLimit: { delayMs: 0, maxRetries: 2 },
  });
  const response = await client.get<{ ok: boolean }>("/items");
  expect(response.data).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("exhausted rate-limit budget returns promptly without a final wait", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    )
    .mockImplementation(() =>
      Promise.resolve(
        new Response(null, { status: 429, headers: { "Retry-After": "5" } }),
      ),
    );
  const client = new ApiClient("test", "https://example.com", {}, {
    rateLimit: { delayMs: 0, maxRetries: 1 },
  });
  const started = Date.now();
  await expect(client.get("/items")).rejects.toThrow("429");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("cancellation during rate-limit waiting rejects immediately", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
  );
  const client = new ApiClient("test", "https://example.com", {}, {
    rateLimit: { delayMs: 0, maxRetries: 3 },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await expect(client.get("/items", { signal: controller.signal })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("invalid Retry-After falls back to the configured delay", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "soon" } }),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  const client = new ApiClient("test", "https://example.com", {}, {
    rateLimit: { delayMs: 5, maxRetries: 3 },
  });
  const started = Date.now();
  const response = await client.get<{ ok: boolean }>("/items");
  expect(response.data).toEqual({ ok: true });
  expect(Date.now() - started).toBeGreaterThanOrEqual(4);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("Retry-After HTTP-date is parsed", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  const fetchMock = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": new Date(Date.now() + 2000).toUTCString() },
      }),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  const client = new ApiClient("test", "https://example.com", {}, {
    rateLimit: { delayMs: 0, maxRetries: 3 },
  });
  const started = Date.now();
  const response = await client.get<{ ok: boolean }>("/items");
  expect(response.data).toEqual({ ok: true });
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("timeout stays active while the response body stalls", async () => {
  spyOn(tokenManager, "getAccessToken").mockResolvedValue("token");
  let signal: AbortSignal | undefined;
  spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) => {
    signal = init.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "Content-Type": "text/plain" }),
      text: () =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
  }) as unknown as typeof fetch);
  const client = new ApiClient("test", "https://example.com", {}, {
    timeoutMs: 50,
    rateLimit: { delayMs: 0 },
  });
  await expect(client.get<string>("/items")).rejects.toThrow("Request timeout after 50ms");
});
