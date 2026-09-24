import "../src/utils/settings";
import { createHmac } from "node:crypto";
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

/** Recomputes the OAuth signature from pre-encoded `key=value` request params. */
const expectValidSignature = ([url, init]: [unknown, RequestInit?], requestParams: string[]) => {
  const auth = (init?.headers as Record<string, string>).Authorization;
  const header = Object.fromEntries(
    [...auth.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, decodeURIComponent(v)]),
  );
  const params = [
    ...requestParams,
    "oauth_consumer_key=key",
    `oauth_nonce=${header.oauth_nonce}`,
    "oauth_signature_method=HMAC-SHA1",
    `oauth_timestamp=${header.oauth_timestamp}`,
    "oauth_token=token",
    "oauth_version=1.0",
  ]
    .sort()
    .join("&");
  const base = `POST&${encodeURIComponent(String(url))}&${encodeURIComponent(params)}`;
  const expected = createHmac("sha1", "secret&token-secret").update(base).digest("base64");
  expect(header.oauth_signature).toBe(expected);
};

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

test("sync pages past 500 bookmarks by sending seen ids as a signed have param", async () => {
  const all = Array.from({ length: 1234 }, (_, i) => i + 1);
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const have = new Set(new URLSearchParams(init?.body as string).get("have")?.split(","));
    return json(syncResponse(all.filter((id) => !have.has(String(id))).slice(0, 500)));
  });
  const result = await makeAdapter().sync({ mode: "overwrite" });
  expect(result.articles.map((a) => a.id)).toEqual(all);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const [first, second] = fetchMock.mock.calls;
  expect(new URLSearchParams(first[1]?.body as string).has("have")).toBe(false);
  expect(new URLSearchParams(second[1]?.body as string).get("have")).toBe(
    all.slice(0, 500).join(","),
  );
  expectValidSignature(second, [`have=${all.slice(0, 500).join("%2C")}`, "limit=500"]);
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

test("saveArticle signs RFC 3986-encoded params so URLs with ( ) verify", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () =>
    json([bookmark(1)]),
  );
  await makeAdapter().saveArticle({
    url: "https://en.wikipedia.org/wiki/Foo_(bar)",
    title: "t",
  } as never);
  expectValidSignature(
    fetchMock.mock.calls[0],
    ["title=t", "url=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FFoo_%28bar%29"],
  );
});
