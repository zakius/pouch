import "../src/utils/settings";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { InstapaperAdapter } from "../src/background/api/adapters/instapaper-adapter";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const bookmark = (id: number) => ({
  type: "bookmark",
  bookmark_id: id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  time: 1700000000,
});

const syncResponse = (bookmarks: number[], deleteIds?: number[]) => ({
  user: { type: "user", user_id: 1, username: "test" },
  bookmarks: bookmarks.map(bookmark),
  ...(deleteIds ? { delete_ids: deleteIds } : {}),
});

const makeAdapter = () => {
  const adapter = new InstapaperAdapter();
  const internal = adapter as unknown as {
    config: Record<string, string>;
    accessToken: string;
    accessTokenSecret: string;
  };
  internal.config = {
    consumerKey: "key",
    consumerSecret: "secret",
    username: "user",
  };
  internal.accessToken = "token";
  internal.accessTokenSecret = "token-secret";
  return adapter;
};

let calls = 0;

const listBodies = (handler: (call: number) => unknown) =>
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = new URLSearchParams(init?.body as string);
    if (body.get("limit")) {
      calls++;
      return json(handler(calls));
    }
    return json("oauth_token=t&oauth_token_secret=s");
  });

afterEach(() => {
  mock.restore();
  calls = 0;
});

test("sync returns an empty snapshot for an empty account", async () => {
  listBodies(() => syncResponse([]));
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles).toEqual([]);
  expect(result.mode).toBe("overwrite");
  expect(result.metadata?.totalFetched).toBe(0);
});

test("sync stops after a short page", async () => {
  const fetchMock = listBodies(() => syncResponse([1, 2, 3]));
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles.map((a) => a.id)).toEqual([1, 2, 3]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("sync requests the next page after an exactly-500 page", async () => {
  const full = Array.from({ length: 500 }, (_, i) => i + 1);
  const fetchMock = listBodies((call) =>
    call === 1 ? syncResponse(full) : syncResponse([]),
  );
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles).toHaveLength(500);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync accumulates multiple batches with stable ids", async () => {
  const full = Array.from({ length: 500 }, (_, i) => i + 1);
  const fetchMock = listBodies((call) =>
    call === 1 ? syncResponse(full) : syncResponse([501, 502]),
  );
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles.map((a) => a.id)).toEqual([...full, 501, 502]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync fails instead of looping on a repeated full page", async () => {
  const full = Array.from({ length: 500 }, (_, i) => i + 1);
  const fetchMock = listBodies(() => syncResponse(full));
  await expect(makeAdapter().sync({ mode: "overwrite" })).rejects.toThrow(
    "already-seen bookmarks",
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync dedupes bookmarks repeated across pages", async () => {
  const full = Array.from({ length: 500 }, (_, i) => i + 1);
  const fetchMock = listBodies((call) =>
    call === 1 ? syncResponse(full) : syncResponse([500, 501]),
  );
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles.map((a) => a.id)).toEqual([...full, 501]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("sync ignores delete_ids it cannot apply and still returns the snapshot", async () => {
  listBodies(() => syncResponse([1, 2], [1]));
  const result = await makeAdapter().sync({ mode: "update" });
  expect(result.articles.map((a) => a.id)).toEqual([1, 2]);
  expect(result.mode).toBe("update");
});

test("sync does not send the unsupported have parameter", async () => {
  const bodies: URLSearchParams[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = new URLSearchParams(init?.body as string);
    if (body.get("limit")) {
      bodies.push(body);
      return json(syncResponse([1]));
    }
    return json("oauth_token=t&oauth_token_secret=s");
  });
  await makeAdapter().sync({ mode: "update" });
  expect(bodies[0].has("have")).toBe(false);
});

test("authenticate signs the xAuth access_token request with OAuth", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("oauth_token=t&oauth_token_secret=s"),
  );
  await new InstapaperAdapter().initialize({
    apiConfig: { consumerKey: "key", consumerSecret: "secret", username: "user", password: "pw" },
  } as never);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toEndWith("/api/1/oauth/access_token");
  const auth = (init?.headers as Record<string, string>).Authorization;
  expect(auth).toStartWith("OAuth ");
  expect(auth).toContain('oauth_consumer_key="key"');
  expect(auth).toContain("oauth_signature=");
});
