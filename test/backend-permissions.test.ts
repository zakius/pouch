import { afterEach, expect, mock, spyOn, test } from "bun:test";

type Listener = (granted: { origins?: string[]; permissions?: string[] }) => void;

const permissionState: Record<string, unknown> = {};
const removedOrigins: string[][] = [];

Object.assign(globalThis, {
  browser: {
    permissions: {
      onRemoved: { addListener: (_l: Listener) => {} },
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => permissionState[origin] === true),
      request: async ({ origins }: { origins: string[] }) => {
        for (const origin of origins) permissionState[origin] = true;
        return true;
      },
      remove: async ({ origins }: { origins: string[] }) => {
        removedOrigins.push(origins);
        for (const origin of origins) delete permissionState[origin];
      },
      getAll: async () => ({
        origins: Object.keys(permissionState).filter((key) => permissionState[key] === true),
        permissions: [],
      }),
    },
  },
});

const {
  ensureBackendPermissions,
  getBackendOrigins,
  getMissingOrigins,
  hasBackendPermissions,
  missingPermissionMessage,
  originPatternFromUrl,
  pruneBackendPermissions,
} = await import("../src/utils/backend-permissions");
const { requestJson } = await import("../src/background/api/effect-api-client");
const { runOperation } = await import("../src/background/api/effect-adapter");
const manifest = (await import("../src/manifest.json")).default;

const selfHostedSettings = {
  backend: "karakeep",
  logLevel: 3,
  normalizeOnSave: false,
  normalizeOnCompare: false,
  apiConfig: { url: "https://k3s.local", token: "t" },
} as const;

afterEach(() => {
  mock.restore();
  for (const key of Object.keys(permissionState)) delete permissionState[key];
  removedOrigins.length = 0;
});

test("bookmarks backend needs no host origins", () => {
  expect(
    getBackendOrigins({
      backend: "bookmarks",
      logLevel: 3,
      normalizeOnSave: false,
      normalizeOnCompare: false,
      apiConfig: {},
    }),
  ).toEqual([]);
});

test("fixed-origin backends map to their service origins", () => {
  expect(
    getBackendOrigins({
      backend: "instapaper",
      logLevel: 3,
      normalizeOnSave: false,
      normalizeOnCompare: false,
      apiConfig: { consumerKey: "k", consumerSecret: "s", username: "u" },
    }),
  ).toEqual(["https://www.instapaper.com/*"]);
  expect(
    getBackendOrigins({
      backend: "raindrop",
      logLevel: 3,
      normalizeOnSave: false,
      normalizeOnCompare: false,
      apiConfig: { apiKey: "a" },
    }),
  ).toEqual(["https://api.raindrop.io/*"]);
});

test("self-hosted backends derive one origin from the configured URL", () => {
  expect(getBackendOrigins(selfHostedSettings)).toEqual(["https://k3s.local/*"]);
});

test("origin patterns reject non-http URLs and unparseable input", () => {
  expect(originPatternFromUrl("ftp://files.example.com")).toBeNull();
  expect(originPatternFromUrl("not a url")).toBeNull();
  expect(originPatternFromUrl(undefined)).toBeNull();
  expect(originPatternFromUrl("http://10.0.0.8:8080/wallabag")).toBe("http://10.0.0.8:8080/*");
});

test("manifest requires no host permissions; all host origins are optional", () => {
  const hostPattern = /^[a-z*]+:\/\//;
  expect(manifest.permissions.filter((p: string) => hostPattern.test(p))).toEqual([]);
  for (const origin of [
    "*://*/*",
    "https://www.instapaper.com/*",
    "https://api.raindrop.io/*",
  ]) {
    expect(manifest.optional_permissions).toContain(origin);
  }
});

test("getMissingOrigins lists ungranted backend origins only", async () => {
  permissionState["https://k3s.local/*"] = true;
  expect(await getMissingOrigins(selfHostedSettings)).toEqual([]);
  expect(await getMissingOrigins({ ...selfHostedSettings, backend: "bookmarks" })).toEqual([]);
  delete permissionState["https://k3s.local/*"];
  expect(await getMissingOrigins(selfHostedSettings)).toEqual(["https://k3s.local/*"]);
});

test("hasBackendPermissions is true with no origins and reflects grants otherwise", async () => {
  const bookmarksSettings = { ...selfHostedSettings, backend: "bookmarks" } as const;
  expect(await hasBackendPermissions(bookmarksSettings)).toBe(true);
  expect(await hasBackendPermissions(selfHostedSettings)).toBe(false);
  permissionState["https://k3s.local/*"] = true;
  expect(await hasBackendPermissions(selfHostedSettings)).toBe(true);
});

test("ensureBackendPermissions requests ungranted origins from a user gesture", async () => {
  expect(await ensureBackendPermissions(selfHostedSettings)).toBe(true);
  expect(permissionState["https://k3s.local/*"]).toBe(true);
});

test("ensureBackendPermissions calls permissions.request synchronously", async () => {
  const request = spyOn(browser.permissions, "request");
  const contains = spyOn(browser.permissions, "contains");
  const pending = ensureBackendPermissions(selfHostedSettings);
  // Firefox drops the user-gesture context at the first await.
  expect(request).toHaveBeenCalledTimes(1);
  expect(contains).not.toHaveBeenCalled();
  expect(await pending).toBe(true);
});

test("pruneBackendPermissions revokes origins the backend no longer needs", async () => {
  permissionState["https://old.example.com/*"] = true;
  permissionState["https://k3s.local/*"] = true;
  await pruneBackendPermissions(selfHostedSettings);
  expect(removedOrigins).toEqual([["https://old.example.com/*"]]);
  expect(permissionState["https://k3s.local/*"]).toBe(true);
});

test("pruneBackendPermissions keeps the user's all-sites grant", async () => {
  permissionState["*://*/*"] = true;
  await pruneBackendPermissions(selfHostedSettings);
  expect(removedOrigins).toEqual([]);
  expect(permissionState["*://*/*"]).toBe(true);
});

test("missingPermissionMessage names the origin and points at settings", () => {
  const message = missingPermissionMessage(selfHostedSettings);
  expect(message).toContain("https://k3s.local");
  expect(message.toLowerCase()).toContain("permission");
  expect(message.toLowerCase()).toContain("settings");
});

test("a request without the host permission fails with PermissionFailure before fetching", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("NetworkError when attempting to fetch resource."),
  );
  await expect(
    runOperation(requestJson({ operation: "karakeep.sync", url: "https://k3s.local/bookmarks" })),
  ).rejects.toMatchObject({ _tag: "PermissionFailure" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a granted origin keeps network errors as NetworkFailure", async () => {
  permissionState["https://k3s.local/*"] = true;
  spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("NetworkError when attempting to fetch resource."),
  );
  await expect(
    runOperation(requestJson({ operation: "karakeep.sync", url: "https://k3s.local/bookmarks" })),
  ).rejects.toMatchObject({ _tag: "NetworkFailure" });
});
