import { beforeEach, expect, test } from "bun:test";
import { LogLevel } from "../src/utils/log-levels";
import { DEFAULT_SETTINGS, type Settings } from "../src/utils/settings";

type Listener = (event: unknown) => void;

class FakeElement {
  id = "";
  tagName: string;
  name = "";
  type = "";
  method = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  className = "";
  textContent = "";
  htmlFor = "";
  children: FakeElement[] = [];
  listeners = new Map<string, Listener[]>();
  private classes = new Set<string>();

  constructor(tagName: string, id = "") {
    this.tagName = tagName.toLowerCase();
    this.id = id;
  }

  get innerHTML(): string {
    return "";
  }

  set innerHTML(_markup: string) {
    this.children = [];
  }

  classList = {
    add: (...names: string[]) => {
      for (const name of names) this.classes.add(name);
    },
    remove: (...names: string[]) => {
      for (const name of names) this.classes.delete(name);
    },
    contains: (name: string) => this.classes.has(name),
  };

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  closest(selector: string): FakeElement | null {
    if (selector.startsWith("#") && this.id === selector.slice(1)) return this;
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const tag = selector.toLowerCase();
    const walk = (node: FakeElement): FakeElement[] =>
      node.children.flatMap((child) => [
        ...(child.tagName === tag ? [child] : []),
        ...walk(child),
      ]);
    return walk(this);
  }
}

class FakeHTMLFormElement extends FakeElement {
  constructor() {
    super("form");
  }
}

class FakeHTMLInputElement extends FakeElement {
  constructor(id = "") {
    super("input", id);
  }
}

function findById(roots: Iterable<FakeElement>, id: string): FakeElement | null {
  for (const root of roots) {
    if (root.id === id) return root;
    const found = findById(root.children, id);
    if (found) return found;
  }
  return null;
}

const staticElements = new Map<string, FakeElement>([
  ["backend-select", new FakeElement("select", "backend-select")],
  ["config-container", new FakeElement("div", "config-container")],
  ["save", new FakeElement("button", "save")],
  ["test-connection", new FakeElement("button", "test-connection")],
  ["enable-verbose-logging", new FakeHTMLInputElement("enable-verbose-logging")],
  ["status", new FakeElement("div", "status")],
  ["normalize-on-save", new FakeHTMLInputElement("normalize-on-save")],
  ["normalize-on-compare", new FakeHTMLInputElement("normalize-on-compare")],
]);

let domReadyHandler: (() => Promise<void>) | undefined;
const bodyListeners = new Map<string, Listener[]>();

const fakeDocument = {
  getElementById: (id: string) => findById(staticElements.values(), id),
  querySelectorAll: () => [...staticElements.values()],
  createElement: (tagName: string) => {
    const lower = tagName.toLowerCase();
    if (lower === "form") return new FakeHTMLFormElement();
    if (lower === "input") return new FakeHTMLInputElement();
    return new FakeElement(lower);
  },
  addEventListener: (type: string, handler: () => Promise<void>) => {
    if (type === "DOMContentLoaded") domReadyHandler = handler;
  },
  body: {
    addEventListener: (type: string, handler: Listener) => {
      const existing = bodyListeners.get(type) ?? [];
      existing.push(handler);
      bodyListeners.set(type, existing);
    },
  },
};

let storedSettings: Settings = {
  ...DEFAULT_SETTINGS,
  backend: "raindrop",
  apiConfig: { apiKey: "initial-secret" },
};
let syncGetError: Error | undefined;
let sentMessages: Record<string, unknown>[] = [];
let messageHandler: (message: Record<string, unknown>) => Promise<unknown> = async () => ({
  success: true,
});

const fakeBrowser = {
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: async (message: Record<string, unknown>) => {
      if (message.type === "getStorageDiagnostic") return null;
      sentMessages.push(message);
      return messageHandler(message);
    },
  },
  storage: {
    sync: {
      get: async () => {
        if (syncGetError) throw syncGetError;
        return { ...storedSettings };
      },
    },
  },
  permissions: {
    request: async () => true,
    getAll: async () => ({ origins: [] }),
    remove: async () => true,
  },
};

Object.assign(globalThis, {
  HTMLFormElement: FakeHTMLFormElement,
  HTMLInputElement: FakeHTMLInputElement,
  document: fakeDocument,
  browser: fakeBrowser,
});

await import("../src/options/options");

function el(id: string): FakeElement {
  const found = fakeDocument.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found;
}

function clickButton(id: string): void {
  const target = el(id);
  for (const listener of bodyListeners.get("click") ?? []) {
    listener({ target, preventDefault: () => {} });
  }
}

async function selectBackend(backend: Settings["backend"]): Promise<void> {
  const select = el("backend-select");
  select.value = backend;
  select.dispatchEvent("change", {});
  await Promise.resolve();
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  storedSettings = {
    ...DEFAULT_SETTINGS,
    backend: "raindrop",
    logLevel: LogLevel.ERROR,
    apiConfig: { apiKey: "initial-secret" },
  };
  syncGetError = undefined;
  sentMessages = [];
  messageHandler = async () => ({ success: true });
  bodyListeners.clear();
  for (const element of staticElements.values()) {
    element.value = "";
    element.checked = false;
    element.disabled = false;
    element.hidden = false;
    element.className = "";
    element.textContent = "";
    element.children = [];
    element.listeners.clear();
  }
});

test("options form sets method=post and submit prevents default GET leak while saving settings", async () => {
  await domReadyHandler?.();

  const form = el("config-container").querySelector("form");
  expect(form).not.toBeNull();
  expect(form?.id).toBe("raindrop-config");
  expect(form?.method).toBe("post");

  el("apiKey").value = "  super-secret-token  ";
  let prevented = false;
  form?.dispatchEvent("submit", {
    preventDefault: () => {
      prevented = true;
    },
  });
  expect(prevented).toBe(true);

  await waitUntil(() => sentMessages.length === 1, "saveSettings message sent");
  expect(sentMessages[0]).toEqual({
    type: "saveSettings",
    payload: {
      settings: {
        backend: "raindrop",
        logLevel: LogLevel.ERROR,
        normalizeOnSave: false,
        normalizeOnCompare: false,
        apiConfig: { apiKey: "super-secret-token" },
      },
    },
  });
});

test("options form rejects empty required credentials and non-HTTP URLs before Save and Test Connection", async () => {
  await domReadyHandler?.();

  // Raindrop empty / whitespace-only apiKey rejected for both Save and Test Connection.
  el("apiKey").value = "   ";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("API Key (Test Token) is required");
  expect(el("status").className).toBe("status error");

  clickButton("test-connection");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("API Key (Test Token) is required");

  // Karakeep rejects non-HTTP(S) URLs and missing token.
  await selectBackend("karakeep");
  for (const badUrl of ["ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "not-a-url"]) {
    el("url").value = badUrl;
    el("token").value = "valid-token";
    clickButton("save");
    expect(sentMessages).toEqual([]);
    expect(el("status").textContent).toContain("http:// or https://");

    clickButton("test-connection");
    expect(sentMessages).toEqual([]);
  }

  el("url").value = "https://keep.example.com";
  el("token").value = "  ";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("API Token is required");

  // Instapaper API v2 uses a single required Access Token password field (no user password stored).
  await selectBackend("instapaper");
  const instapaperInputs = el("config-container").querySelectorAll("input");
  expect(instapaperInputs).toHaveLength(1);
  expect(instapaperInputs[0].name).toBe("token");
  expect(instapaperInputs[0].type).toBe("password");
  expect(el("config-container").querySelector("label")?.textContent).toBe("Access Token");

  el("token").value = "   ";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("Access Token is required");

  clickButton("test-connection");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("Access Token is required");

  el("token").value = "  instapaper-v2-token  ";
  clickButton("save");
  await waitUntil(() => sentMessages.length === 1, "Instapaper v2 token saved");
  expect(sentMessages[0]).toMatchObject({
    type: "saveSettings",
    payload: {
      settings: {
        backend: "instapaper",
        apiConfig: {
          token: "instapaper-v2-token",
        },
      },
    },
  });
});

test("options initialization surfaces storage.sync read failures and disables controls instead of falling back to bookmarks", async () => {
  syncGetError = new Error("storage.sync read failed");
  await domReadyHandler?.();

  expect(el("status").textContent).toContain("storage.sync read failed");
  expect(el("status").className).toBe("status error");
  expect(el("save").disabled).toBe(true);
  expect(el("test-connection").disabled).toBe(true);
  expect(el("backend-select").disabled).toBe(true);
  expect(el("config-container").querySelector("form")).toBeNull();
});

test("rapid showStatus calls cancel the inner 300ms clear timer so newer messages are not wiped blank", async () => {
  await domReadyHandler?.();

  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  type Scheduled = {
    id: number;
    callback: () => void;
    delay: number;
    cleared: boolean;
    fired: boolean;
  };
  let nextId = 1;
  const scheduled: Scheduled[] = [];

  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const entry: Scheduled = { id: nextId++, callback, delay, cleared: false, fired: false };
    scheduled.push(entry);
    return entry.id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout> | undefined) => {
    const entry = scheduled.find((item) => item.id === (id as unknown as number));
    if (entry) entry.cleared = true;
  }) as typeof clearTimeout;

  try {
    // Trigger a success status (which schedules the 3000ms hide timer).
    el("apiKey").value = "good-key";
    clickButton("save");
    const deadline = Date.now() + 2000;
    while (el("status").textContent !== "Settings saved successfully") {
      if (Date.now() > deadline) throw new Error("Timed out waiting for saved status");
      await new Promise((resolve) => origSetTimeout(resolve, 5));
    }

    expect(el("status").textContent).toBe("Settings saved successfully");
    const hideTimer = scheduled.find((t) => t.delay === 3000 && !t.cleared && !t.fired);
    expect(hideTimer).toBeDefined();

    // Fire the 3000ms fade-out timer; this schedules the inner 300ms clear timer.
    hideTimer!.fired = true;
    hideTimer!.callback();
    const clearTimer = scheduled.find((t) => t.delay === 300 && !t.cleared && !t.fired);
    expect(clearTimer).toBeDefined();

    // Before 300ms passes, trigger a newer error message.
    el("apiKey").value = "";
    clickButton("save");
    expect(el("status").textContent).toContain("API Key (Test Token) is required");

    // The inner 300ms clear timer MUST have been cleared!
    expect(clearTimer!.cleared).toBe(true);
    // Firing any remaining unfired, non-cleared timers leaves the newer error intact.
    for (const timer of [...scheduled]) {
      if (!timer.cleared && !timer.fired) {
        timer.fired = true;
        timer.callback();
      }
    }
    expect(el("status").textContent).toContain("API Key (Test Token) is required");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});

test("Wallabag options form labels the URL field as Server URL", async () => {
  await domReadyHandler?.();
  await selectBackend("wallabag");

  const labels = el("config-container").querySelectorAll("label");
  const urlLabel = labels.find((label) => label.htmlFor === "url");
  expect(urlLabel?.textContent).toBe("Server URL");

  el("url").value = "not-a-url";
  el("clientId").value = "cid";
  el("clientSecret").value = "csecret";
  el("username").value = "user";
  el("password").value = "pass";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain("Server URL must be a valid http:// or https:// URL");
});

test("LinkAce options form labels the URL field as Instance URL (LinkAce 2.x)", async () => {
  await domReadyHandler?.();
  await selectBackend("linkace");

  const labels = el("config-container").querySelectorAll("label");
  const urlLabel = labels.find((label) => label.htmlFor === "url");
  expect(urlLabel?.textContent).toBe("Instance URL (LinkAce 2.x)");

  el("url").value = "not-a-url";
  el("token").value = "token";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain(
    "Instance URL (LinkAce 2.x) must be a valid http:// or https:// URL",
  );
});

test("Karakeep options form labels the URL field as Instance URL and persists includeArchived checkbox", async () => {
  await domReadyHandler?.();
  await selectBackend("karakeep");

  const labels = el("config-container").querySelectorAll("label");
  const urlLabel = labels.find((label) => label.htmlFor === "url");
  expect(urlLabel?.textContent).toBe("Instance URL");
  const archivedLabel = labels.find((label) => label.htmlFor === "includeArchived");
  expect(archivedLabel?.textContent).toBe("Include archived bookmarks");
  const archivedInput = el("includeArchived");
  expect(archivedInput.type).toBe("checkbox");
  expect(archivedInput.checked).toBe(false);

  el("url").value = "not-a-url";
  el("token").value = "token";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain(
    "Instance URL must be a valid http:// or https:// URL",
  );

  // Toggling includeArchived survives backend switches (drafts) and is saved as a boolean.
  el("url").value = "https://keep.example.com";
  archivedInput.checked = true;
  await selectBackend("raindrop");
  await selectBackend("karakeep");
  expect(el("includeArchived").checked).toBe(true);

  clickButton("save");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]).toMatchObject({
    type: "saveSettings",
    payload: {
      settings: {
        backend: "karakeep",
        apiConfig: {
          url: "https://keep.example.com",
          token: "token",
          includeArchived: true,
        },
      },
    },
  });
});

test("Linkwarden options form labels the URL field as Instance URL (needs Linkwarden 2.10 or later)", async () => {
  await domReadyHandler?.();
  await selectBackend("linkwarden");

  const labels = el("config-container").querySelectorAll("label");
  const urlLabel = labels.find((label) => label.htmlFor === "url");
  expect(urlLabel?.textContent).toBe("Instance URL (needs Linkwarden 2.10 or later)");

  el("url").value = "not-a-url";
  el("token").value = "token";
  clickButton("save");
  expect(sentMessages).toEqual([]);
  expect(el("status").textContent).toContain(
    "Instance URL (needs Linkwarden 2.10 or later) must be a valid http:// or https:// URL",
  );
});
