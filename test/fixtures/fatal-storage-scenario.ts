import assert from "node:assert/strict";
import {
  ArticlesRepository,
  getAccountStorageKeys,
  removeStaleAccountKeys,
} from "../../src/background/articles-repository";
import { TokenManager } from "../../src/background/token-manager";
import { ApiClient } from "../../src/background/api/api-client";
import { DEFAULT_SETTINGS } from "../../src/utils/settings";
import {
  checkStorageOnStartup,
  getStorageDiagnostic,
  FatalStorageError,
  setLocal,
  storageShutdownSignal,
  onFatalStorage,
} from "../../src/utils/fatal-storage";
import {
  saveCachedFilterLists,
  clearFilterListCache,
  refreshFilterLists,
  setFilterListSources,
} from "../../src/utils/filter-list-manager";

const { POUCH_ID, QUICK_ACTIONS_ID } = await import("../../src/utils/chromium");
const scenario = process.argv[2];
const settings = { ...DEFAULT_SETTINGS, backend: "bookmarks" } as const;
const keys = getAccountStorageKeys(settings);
const original = {
  id: "old-GUID",
  title: "Old",
  url: "https://example.com/old",
  created_at: "2026-01-01",
};
const store: Record<string, unknown> = { [keys.articles]: [original] };
let rejectSet = false;
let rejectRemove = false;
let rejectRead = false;
let failKey: string | undefined;
let writes = 0;
let removes = 0;
let remoteSaves = 0;
let remoteDeletes = 0;
let remoteReads = 0;
let fetches = 0;
let commands = 0;
const notifications: string[] = [];
const broadcasts: unknown[] = [];
const events: Record<string, (...args: any[]) => any> = {};
const event = (name: string) => ({
  addListener: (listener: (...args: any[]) => any) => {
    events[name] = listener;
  },
});
const quota = new DOMException(
  "QUOTA_BYTES exceeded https://user:secret@example.com token=SECRET",
  "QuotaExceededError",
);
Object.assign(globalThis, {
  browser: {
    storage: {
      local: {
        get: async (names: string | string[] | null) => {
          if (rejectRead) throw new Error("Storage unavailable");
          if (names === null) return { ...store };
          return Object.fromEntries(
            (typeof names === "string" ? [names] : names).map((key) => [key, store[key]]),
          );
        },
        set: async (values: Record<string, unknown>) => {
          writes++;
          if (rejectSet || (failKey && failKey in values)) throw quota;
          Object.assign(store, values);
        },
        remove: async (names: string | string[]) => {
          removes++;
          if (rejectRemove) throw quota;
          for (const key of typeof names === "string" ? [names] : names) delete store[key];
        },
      },
      sync: {
        get: async () => settings,
        set: async () => {
          commands++;
        },
      },
    },
    bookmarks: {
      getTree: async () => [{ id: "folder", title: "Pouch", children: [] }],
      getChildren: async () => {
        remoteReads++;
        return [];
      },
      create: async (details: Record<string, string>) => {
        remoteSaves++;
        return { ...details, id: "new-GUID" };
      },
      remove: async () => {
        remoteDeletes++;
      },
    },
    idle: { queryState: async () => "active" },
    permissions: { contains: async () => true, onRemoved: event("permission") },
    alarms: { get: async () => undefined, create: async () => {}, onAlarm: event("alarm") },
    runtime: {
      onMessage: event("message"),
      onInstalled: event("installed"),
      onStartup: event("startup"),
      onMessageExternal: event("external"),
      sendMessage: async (message: unknown) => {
        broadcasts.push(message);
      },
      getURL: (path: string) => path,
      openOptionsPage: async () => {},
    },
    notifications: {
      create: async (_id: string, data: { message: string }) => {
        notifications.push(data.message);
      },
      onClicked: event("notification"),
    },
    contextMenus: {
      onClicked: event("menu"),
      removeAll: async () => {},
      create: (_details: unknown, callback?: () => void) => {
        callback?.();
      },
      update: async () => {},
    },
    commands: { onCommand: event("command") },
    pageAction: {
      onClicked: event("page"),
      setIcon: async () => {},
      setTitle: async () => {},
      show: async () => {},
    },
    tabs: {
      query: async () => [],
      get: async () => ({}),
      onRemoved: event("removed"),
      onUpdated: event("tab"),
      onActivated: event("active"),
    },
  },
  fetch: async () => {
    fetches++;
    return new Response("! empty", { status: 200 });
  },
});
setFilterListSources([{ name: "empty", url: "data:text/plain;base64,ISBlbXB0eQ==" }]);
const repository = new ArticlesRepository();
await repository.initialize(settings);
const priorCache = await repository.getAllArticles();
const tokens = new TokenManager();
const baseToken = {
  accessToken: "old",
  refreshToken: "refresh",
  tokenType: "Bearer",
  expiresAt: Date.now() + 60000,
  issuedAt: Date.now(),
  refreshCount: 0,
};
const rejectsFatal = async (work: () => unknown) => {
  await assert.rejects(async () => {
    await work();
  }, FatalStorageError);
  assert.equal(getStorageDiagnostic()?.code, "FATAL_LOCAL_STORAGE");
  assert.equal(storageShutdownSignal().aborted, true);
};
const queuedFailure = async () => {
  rejectSet = true;
  const first = repository.updateArticles([]);
  const second = repository.mergeArticles([{ ...original, id: "queued" }]);
  await Promise.all([rejectsFatal(() => first), rejectsFatal(() => second)]);
  assert.equal(writes, 1);
};

switch (scenario) {
  case "articles":
    rejectSet = true;
    await rejectsFatal(() =>
      repository.saveArticle({ url: "https://example.com/new", title: "New" }),
    );
    assert.equal(remoteSaves, 1);
    assert.equal(getStorageDiagnostic()?.remoteOutcome, "succeeded");
    assert.match(getStorageDiagnostic()!.error, /Remote save succeeded/);
    break;
  case "delete":
    rejectSet = true;
    await rejectsFatal(() => repository.deleteArticle(original.id));
    assert.equal(remoteDeletes, 1);
    assert.equal(getStorageDiagnostic()?.remoteOperation, "delete");
    break;
  case "queued":
    await queuedFailure();
    break;
  case "sync-articles":
    rejectSet = true;
    await rejectsFatal(() => repository.syncWithAPI({ mode: "overwrite" }));
    assert.equal(getStorageDiagnostic()?.remoteOutcome, "succeeded");
    assert.equal(getStorageDiagnostic()?.remoteOperation, "sync");
    break;
  case "timestamps":
    failKey = keys.lastSyncTimestamp;
    await rejectsFatal(() => repository.syncWithAPI({ mode: "overwrite" }));
    assert.equal(store[keys.lastSyncTimestamp], undefined);
    assert.equal(Reflect.get(repository, "lastSyncTimestamp"), null);
    assert.equal(getStorageDiagnostic()?.operation, "persist sync timestamps");
    break;
  case "tokens":
    rejectSet = true;
    await rejectsFatal(() => tokens.storeToken("service", baseToken));
    assert.equal(tokens.getTokenMetadata("service"), null);
    break;
  case "token-clear":
  case "token-clear-all":
  case "token-refresh":
  case "token-refresh-failed": {
    await tokens.storeToken("service", baseToken);
    const before = structuredClone(tokens.getTokenMetadata("service"));
    rejectSet = true;
    if (scenario === "token-clear") await rejectsFatal(() => tokens.clearToken("service"));
    else if (scenario === "token-clear-all") await rejectsFatal(() => tokens.clearAllTokens());
    else {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
          status: scenario === "token-refresh-failed" ? 401 : 200,
        });
      await rejectsFatal(() =>
        tokens.refreshToken("service", {
          serviceName: "service",
          refreshUrl: "https://example.com/token",
          clientId: "id",
          clientSecret: "secret",
          refreshToken: "refresh",
        }),
      );
      assert.equal(
        getStorageDiagnostic()?.remoteOutcome,
        scenario === "token-refresh-failed" ? "failed" : "succeeded",
      );
    }
    assert.deepEqual(tokens.getTokenMetadata("service"), before);
    assert.equal(store.api_tokens instanceof Array, true);
    break;
  }
  case "options-ui": {
    const elements = new Map(
      [
        "backend-select",
        "config-container",
        "save",
        "test-connection",
        "enable-verbose-logging",
        "status",
        "normalize-on-save",
        "normalize-on-compare",
      ].map((id) => [
        id,
        {
          id,
          disabled: false,
          textContent: "",
          className: "",
          classList: { add: () => {}, remove: () => {} },
        },
      ]),
    );
    let ready!: () => Promise<void>;
    const timers: (() => void)[] = [];
    Object.assign(globalThis, {
      document: {
        getElementById: (id: string) => elements.get(id),
        querySelectorAll: () => [...elements.values()],
        addEventListener: (_event: string, listener: () => Promise<void>) => {
          ready = listener;
        },
      },
      setTimeout: (callback: () => void) => {
        timers.push(callback);
        return 1;
      },
    });
    rejectSet = true;
    await rejectsFatal(() => setLocal("persist articles", {}, "succeeded", "save"));
    rejectRead = true;
    (browser.runtime.sendMessage as unknown) = async () => getStorageDiagnostic();
    await import("../../src/options/options");
    await ready();
    for (const timer of timers) timer();
    assert.match(elements.get("status")!.textContent, /Remote save succeeded/);
    assert.equal(timers.length, 1);
    assert.equal(elements.get("save")!.disabled, true);
    break;
  }
  case "ui-initial":
  case "ui-broadcast": {
    const control = {
      id: "save-page-button",
      disabled: false,
      textContent: "+",
      title: "Save",
      setAttribute: () => {},
    };
    Object.assign(globalThis, { document: { querySelectorAll: () => [control] } });
    let displayed = "";
    (browser.runtime.sendMessage as unknown) = async () =>
      scenario === "ui-initial" ? getStorageDiagnostic() : null;
    const { initializeStorageDiagnostics } = await import("../../src/utils/storage-diagnostics-ui");
    if (scenario === "ui-broadcast")
      await initializeStorageDiagnostics((message) => {
        displayed = message;
      });
    rejectSet = true;
    await rejectsFatal(() => setLocal("persist articles", {}, "succeeded", "save"));
    rejectRead = true;
    if (scenario === "ui-initial")
      await initializeStorageDiagnostics((message) => {
        displayed = message;
      });
    else events.message({ type: "fatalStorage", diagnostic: getStorageDiagnostic() });
    assert.match(displayed, /Remote save succeeded/);
    assert.equal(control.disabled, true);
    assert.equal(control.textContent, "!");
    break;
  }
  case "token-schema": {
    await tokens.storeToken("service", baseToken);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ access_token: 12 }), { status: 200 });
    const result = await tokens.refreshToken("service", {
      serviceName: "service",
      refreshUrl: "https://example.com/token",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /Invalid refresh response/);
    assert.equal(getStorageDiagnostic(), undefined);
    break;
  }
  case "draft": {
    rejectSet = true;
    const draft = new TokenManager({ persist: false });
    await draft.storeToken("service", baseToken);
    assert.equal(writes, 0);
    assert.equal(getStorageDiagnostic(), undefined);
    break;
  }
  case "filter-set":
    rejectSet = true;
    await rejectsFatal(() => saveCachedFilterLists([]));
    break;
  case "filter-remove":
    rejectRemove = true;
    await rejectsFatal(() => clearFilterListCache());
    break;
  case "clear":
    rejectRemove = true;
    await rejectsFatal(() => repository.clear());
    break;
  case "stale":
    store.articles = [];
    rejectRemove = true;
    await rejectsFatal(() => removeStaleAccountKeys(settings));
    break;
  case "startup-set":
    rejectSet = true;
    await rejectsFatal(() => checkStorageOnStartup());
    break;
  case "startup-remove":
    rejectRemove = true;
    await rejectsFatal(() => checkStorageOnStartup());
    break;
  case "startup-read":
    rejectRead = true;
    await rejectsFatal(() => checkStorageOnStartup());
    break;
  case "startup-healthy":
    await Promise.all([checkStorageOnStartup(), checkStorageOnStartup()]);
    assert.equal(writes, 1);
    assert.equal(removes, 1);
    assert.equal(store.pouch_storage_health, undefined);
    assert.equal(getStorageDiagnostic(), undefined);
    break;
  case "network": {
    globalThis.fetch = async () => {
      throw new TypeError("Network down");
    };
    const client = new ApiClient("test", "https://example.com");
    await assert.rejects(client.get("/", { authenticated: false }), /Network down/);
    assert.equal(getStorageDiagnostic(), undefined);
    await repository.updateArticles([original]);
    break;
  }
  case "interrupt": {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = async (_url, init) => {
      started();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    };
    const request = new ApiClient("test", "https://example.com").get("/", { authenticated: false });
    const failure = rejectsFatal(() => request);
    await ready;
    rejectSet = true;
    await rejectsFatal(() => setLocal("test failure", {}));
    await failure;
    break;
  }
  case "late-save": {
    let complete!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    (browser.bookmarks.create as unknown) = async () => {
      started();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return { id: "late-GUID", title: "Late", url: "https://example.com/late" };
    };
    const save = repository.saveArticle({ url: "https://example.com/late", title: "Late" });
    const failure = rejectsFatal(() => save);
    await ready;
    rejectSet = true;
    await rejectsFatal(() => setLocal("other work", {}));
    complete();
    await failure;
    assert.equal(getStorageDiagnostic()?.remoteOperation, "save");
    assert.match(getStorageDiagnostic()!.error, /Remote save succeeded/);
    break;
  }
  case "background":
  case "worker-restart": {
    if (scenario === "worker-restart") rejectSet = true;
    await import("../../src/background/background");
    const message = (request: unknown) =>
      new Promise<any>((resolve) => {
        events.message(request, {}, resolve);
      });
    if (scenario === "background") {
      await message({ type: "getArticles", payload: {} });
      assert.equal(
        (await message({ type: "saveArticle", payload: { url: "invalid", title: "Invalid" } }))
          .error,
        "Invalid URL format",
      );
      assert.equal(getStorageDiagnostic(), undefined);
      rejectSet = true;
      const result = await message({
        type: "saveArticle",
        payload: { url: "https://example.com/new", title: "New" },
      });
      assert.equal(result.code, "FATAL_LOCAL_STORAGE");
      assert.equal(result.remoteOutcome, "succeeded");
    }
    const diagnostic = await message({ type: "getStorageDiagnostic" });
    assert.equal(diagnostic.code, "FATAL_LOCAL_STORAGE");
    rejectRead = true;
    const counts = [writes, removes, remoteSaves, remoteDeletes, remoteReads, commands, fetches];
    for (const request of [
      { type: "saveArticle", payload: { url: "https://example.com/new", title: "New" } },
      { type: "deleteArticle", payload: { articleId: original.id } },
      { type: "getArticles", payload: {} },
      { type: "saveSettings", payload: { settings } },
      { type: "testConnection", payload: { settings } },
    ])
      assert.equal((await message(request)).code, "FATAL_LOCAL_STORAGE");
    await events.command("toggle-save-page");
    for (const name of ["refresh", "refresh-filters", "token-refresh-check"])
      await events.alarm({ name });
    await events.menu({ menuItemId: "save-link", linkUrl: "https://example.com/new" });
    assert.deepEqual(
      [writes, removes, remoteSaves, remoteDeletes, remoteReads, commands, fetches],
      counts,
    );
    assert.equal((await message({ type: "getStorageDiagnostic" })).code, "FATAL_LOCAL_STORAGE");
    assert.ok(notifications.some((text) => text.includes("Pouch stopped")));
    assert.ok(broadcasts.length > 0);
    break;
  }
  case "quick-recovery-disable":
  case "quick-recovery-badge":
  case "quick-recovery-title":
  case "quick-recovery-tab-disable":
  case "quick-recovery-tab-title": {
    const state = { enabled: false, badge: "", title: "" };
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let held = false;
    let holding = true;
    const hold = async (operation: string) => {
      if (!holding || held || scenario !== `quick-recovery-${operation}`) return;
      held = true;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    (browser.tabs.query as any) = async () => [{ id: 1 }];
    Object.assign(browser, {
      action: {
        disable: async (id?: number) => {
          if (holding) await hold(id === undefined ? "disable" : "tab-disable");
          state.enabled = false;
        },
        enable: async () => {
          state.enabled = true;
        },
        setBadgeText: async ({ text }: { text: string }) => {
          if (text === "!") await hold("badge");
          state.badge = text;
        },
        setTitle: async ({ tabId, title }: { tabId?: number; title: string }) => {
          assert.equal(typeof title, "string", "diagnostic title must be an immutable string");
          if (title === "Previous worker stopped")
            await hold(tabId === undefined ? "title" : "tab-title");
          state.title = title;
        },
        setIcon: async () => {},
        onClicked: event("quickClick"),
      },
    });
    // The default disable is not the fatal operation under test.
    holding = false;
    await import("../../src/quick-actions/background");
    const quickListener = events.external;
    holding = true;
    const fatal = quickListener(
      { type: "fatalStorage", error: "Previous worker stopped" },
      { id: POUCH_ID },
    );
    await ready;
    await import("../../src/background/background");
    const pouchListener = events.external;
    (browser.runtime.sendMessage as any) = async (target: string, message: any) => {
      if (target === POUCH_ID) return pouchListener(message, { id: QUICK_ACTIONS_ID });
      if (target === QUICK_ACTIONS_ID) return quickListener(message, { id: POUCH_ID });
    };
    await quickListener({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
    assert.equal(
      state.enabled,
      true,
      "healthy recovery completes while the old fatal call is pending",
    );
    holding = false;
    release();
    await fatal;
    assert.deepEqual(state, { enabled: true, badge: "", title: "Article saved" });
    break;
  }
  case "quick-normal-disable":
  case "quick-normal-badge":
  case "quick-normal-title":
  case "quick-normal-icon":
  case "quick-normal-tab-title":
  case "quick-normal-enable": {
    const state = { enabled: false, badge: "", title: "" };
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let holding = false;
    let held = false;
    const hold = async (operation: string) => {
      if (!holding || held || scenario !== `quick-normal-${operation}`) return;
      held = true;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    (browser.tabs.query as any) = async () => [{ id: 1 }];
    Object.assign(browser, {
      action: {
        disable: async () => {
          await hold("disable");
          state.enabled = false;
        },
        enable: async () => {
          await hold("enable");
          state.enabled = true;
        },
        setBadgeText: async ({ text }: { text: string }) => {
          if (text === "") await hold("badge");
          state.badge = text;
        },
        setTitle: async ({ tabId, title }: { tabId?: number; title: string }) => {
          if (!title.includes("stopped")) await hold(tabId === undefined ? "title" : "tab-title");
          state.title = title;
        },
        setIcon: async () => {
          await hold("icon");
        },
        onClicked: event("quickClick"),
      },
    });
    await import("../../src/quick-actions/background");
    const quickListener = events.external;
    holding = true;
    const normal = quickListener({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
    await ready;
    await quickListener({ type: "fatalStorage", error: "Pouch stopped" }, { id: POUCH_ID });
    holding = false;
    release();
    await normal;
    assert.deepEqual(state, { enabled: false, badge: "!", title: "Pouch stopped" });
    break;
  }
  case "startup-token-get-race":
  case "startup-token-create-race":
  case "startup-refresh-create-race":
  case "startup-menu-create-race":
  case "startup-page-menu-create-race":
  case "startup-filter-alarm-create-race":
  case "startup-remove-all-race":
  case "startup-token-get-race-chromium":
  case "startup-menu-create-race-chromium": {
    const ordering = scenario.replace("-chromium", "");
    store.api_tokens = [["service", { ...baseToken, serviceName: "service" }]];
    const menus = new Map<string, any>();
    const alarms = new Set<string>();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const hold = async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    (browser.alarms.get as any) = async () => {
      if (ordering === "startup-token-get-race") await hold();
      return undefined;
    };
    (browser.alarms.create as any) = async (name: string) => {
      if (
        (ordering === "startup-token-create-race" && name === "token-refresh-check") ||
        (ordering === "startup-refresh-create-race" && name === "refresh") ||
        (ordering === "startup-filter-alarm-create-race" && name === "refresh-filters")
      )
        await hold();
      alarms.add(name);
    };
    (browser.alarms.clear as any) = async (name: string) => {
      alarms.delete(name);
      return true;
    };
    (browser.contextMenus.create as any) = (details: any, callback?: () => void) => {
      void (async () => {
        if (
          (ordering === "startup-menu-create-race" && details.id === "save-link") ||
          (ordering === "startup-page-menu-create-race" && details.id === "save-page")
        )
          await hold();
        menus.set(details.id, { enabled: true, ...details });
        callback?.();
      })();
      return details.id;
    };
    (browser.contextMenus.update as any) = async (id: string, details: any) => {
      if (!menus.has(id)) throw new Error("Menu does not exist");
      Object.assign(menus.get(id), details);
    };
    (browser.contextMenus.removeAll as any) = async () => {
      if (ordering === "startup-remove-all-race") await hold();
      menus.clear();
    };
    await import("../../src/background/background");
    const initialization = (
      scenario.endsWith("-chromium") ? events.installed({ reason: "install" }) : events.startup()
    ).catch((error: unknown) => error);
    await ready;
    rejectSet = true;
    await rejectsFatal(() => setLocal("startup race failure", {}));
    release();
    await initialization;
    assert.ok(
      [...menus.values()].every((menu) => menu.enabled === false),
      "startup must not leave enabled menus after shutdown",
    );
    assert.equal(alarms.has("refresh"), ordering === "startup-filter-alarm-create-race");
    assert.equal(alarms.has("refresh-filters"), false);
    assert.equal(
      alarms.has("token-refresh-check"),
      [
        "startup-refresh-create-race",
        "startup-menu-create-race",
        "startup-page-menu-create-race",
        "startup-filter-alarm-create-race",
      ].includes(ordering),
    );
    for (const callback of [() => events.startup(), () => events.installed({ reason: "update" })]) {
      await assert.rejects(callback, FatalStorageError);
    }
    const counts = [remoteReads, fetches, writes];
    for (const name of ["refresh", "refresh-filters", "token-refresh-check"])
      await events.alarm({ name });
    assert.deepEqual([remoteReads, fetches, writes], counts);
    break;
  }
  case "external-health":
  case "external-fatal": {
    const enabled: number[] = [];
    const titles: string[] = [];
    Object.assign(browser, {
      action: {
        disable: async () => {},
        enable: async (id: number) => {
          enabled.push(id);
        },
        setBadgeText: async () => {},
        setIcon: async () => {},
        setTitle: async ({ title }: { title: string }) => {
          titles.push(title);
        },
        onClicked: event("quickClick"),
      },
    });
    await import("../../src/quick-actions/background");
    const quickListener = events.external;
    await quickListener(
      { type: "fatalStorage", error: "Previous worker stopped" },
      { id: POUCH_ID },
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const originalSet = browser.storage.local.set;
    (browser.storage.local.set as any) = async (values: Record<string, unknown>) => {
      if ("pouch_storage_health" in values) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await originalSet(values);
    };
    await import("../../src/background/background");
    const pouchListener = events.external;
    await ready;
    const before = writes;
    assert.equal(
      await pouchListener({ type: "getStorageDiagnostic" }, { id: "untrusted" }),
      undefined,
    );
    assert.equal(writes, before, "unauthorized diagnostic request must not write storage");
    (browser.runtime.sendMessage as any) = async (target: string, message: any) => {
      if (target === POUCH_ID) return pouchListener(message, { id: QUICK_ACTIONS_ID });
      if (target === QUICK_ACTIONS_ID) return quickListener(message, { id: POUCH_ID });
    };
    const pending = quickListener({ type: "pageState", tabId: 1, saved: true }, { id: POUCH_ID });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(enabled, [], "page state alone cannot recover before the health check");
    if (scenario === "external-fatal") rejectSet = true;
    release();
    await pending;
    const diagnostic = await pouchListener(
      { type: "getStorageDiagnostic" },
      { id: QUICK_ACTIONS_ID },
    );
    if (scenario === "external-health") {
      assert.equal(diagnostic, null);
      assert.deepEqual(enabled, [1]);
      assert.equal(titles.at(-1), "Article saved");
      assert.equal(store.pouch_storage_health, undefined);
      assert.ok(removes > 0, "healthy response requires health cleanup");
    } else {
      assert.equal(diagnostic.code, "FATAL_LOCAL_STORAGE");
      assert.deepEqual(enabled, []);
      assert.match(titles.at(-1)!, /Pouch stopped/);
    }
    break;
  }
  case "firefox-icon-race":
  case "firefox-title-race":
  case "firefox-show-race": {
    (browser.bookmarks.getChildren as any) = async () => [
      { ...original, dateAdded: Date.parse(original.created_at) },
    ];
    await import("../../src/background/background");
    await events.startup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let fatalShown!: () => void;
    const fatalReady = new Promise<void>((resolve) => {
      fatalShown = resolve;
    });
    const completed: string[] = [];
    const titles: string[] = [];
    const icons: string[] = [];
    (browser.tabs.get as any) = async () => ({ id: 1, url: original.url });
    (browser.tabs.query as any) = async () => [{ id: 1, url: original.url }];
    for (const method of ["setIcon", "setTitle", "show"] as const) {
      (browser.pageAction[method] as any) = async (details: any) => {
        const normal =
          method === "show" ||
          details.title === "Article saved" ||
          details.title === "Save to Pouch" ||
          details.path?.includes("page-action");
        const held =
          scenario ===
          `firefox-${{ setIcon: "icon", setTitle: "title", show: "show" }[method]}-race`;
        if (normal && held) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        completed.push(`${method}:${normal ? "normal" : "fatal"}`);
        if (method === "setIcon") icons.push(details.path);
        if (method === "setTitle") {
          titles.push(details.title);
          if (!normal) fatalShown();
        }
      };
    }
    const ui = events.active({ tabId: 1 });
    await ready;
    rejectSet = true;
    await rejectsFatal(() => setLocal("race failure", {}));
    await fatalReady;
    release();
    await ui;
    assert.equal(titles.at(-1), "Pouch stopped: local storage failed");
    assert.equal(icons.at(-1), "icons/icon.svg");
    const heldMethod = {
      "firefox-icon-race": "setIcon",
      "firefox-title-race": "setTitle",
      "firefox-show-race": "show",
    }[scenario];
    assert.ok(
      completed.lastIndexOf("setTitle:fatal") > completed.lastIndexOf(`${heldMethod}:normal`),
      "fatal presentation must complete after the pending normal write",
    );
    break;
  }
  case "ui-race":
  case "ui-menu-race": {
    await import("../../src/background/background");
    await new Promise<void>((resolve) =>
      events.message({ type: "getStorageDiagnostic" }, {}, resolve),
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const updates: any[] = [];
    (browser.tabs.get as any) = async () => ({ id: 1, url: "https://example.com/old" });
    (browser.contextMenus.update as any) = async (id: string, values: any) => {
      if (scenario === "ui-menu-race" && values.enabled === true) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      updates.push({ id, ...values });
    };
    (browser.runtime.sendMessage as any) = async (_target: unknown, message: any) => {
      if (scenario === "ui-race" && message?.type === "pageState") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const ui = events.active({ tabId: 1 });
    await ready;
    rejectSet = true;
    await rejectsFatal(() => setLocal("race failure", {}));
    release();
    await ui;
    assert.equal(
      updates.at(-1)?.enabled,
      false,
      "normal context menu must stay disabled after fatal storage",
    );
    break;
  }
  case "auth-outcome":
  case "instapaper-auth-outcome": {
    const { WallabagAdapter } = await import("../../src/background/api/adapters/wallabag-adapter");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "new-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "bearer",
        }),
        { status: 200 },
      );
    rejectSet = true;
    if (scenario === "auth-outcome") {
      const adapter = new WallabagAdapter(tokens);
      await rejectsFatal(() =>
        adapter.initialize({
          ...settings,
          backend: "wallabag",
          apiConfig: {
            url: "https://example.com",
            clientId: "client",
            clientSecret: "secret",
            username: "user",
            password: "password",
          },
        }),
      );
    } else {
      const { InstapaperAdapter } =
        await import("../../src/background/api/adapters/instapaper-adapter");
      globalThis.fetch = async () => new Response("oauth_token=token&oauth_token_secret=secret");
      await rejectsFatal(() =>
        new InstapaperAdapter(tokens).initialize({
          ...settings,
          backend: "instapaper",
          apiConfig: {
            consumerKey: "client",
            consumerSecret: "secret",
            username: "user",
            password: "password",
          },
        }),
      );
    }
    assert.equal(getStorageDiagnostic()?.remoteOperation, "authentication");
    assert.equal(tokens.getTokenMetadata("service"), null);
    assert.equal(
      getStorageDiagnostic()?.remoteOutcome,
      "succeeded",
      "successful token acquisition is a known remote outcome",
    );
    break;
  }
  case "queued-outcome":
  case "queued-mutations": {
    let writeStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let rejectWrite!: (error: unknown) => void;
    (browser.storage.local.set as any) = async () => {
      writeStarted();
      await new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      });
    };
    let queuedSave!: () => void;
    const queued = new Promise<void>((resolve) => {
      queuedSave = resolve;
    });
    const enqueue = Reflect.get(repository, "enqueueCommit").bind(repository);
    let commits = 0;
    Reflect.set(repository, "enqueueCommit", (work: any, ...outcome: any[]) => {
      const result = enqueue(work, ...outcome);
      if (++commits === 2) queuedSave();
      return result;
    });
    const first = repository.updateArticles([]);
    const firstFailure = rejectsFatal(() => first);
    await ready;
    let saveDiagnostic: any;
    let deleteDiagnostic: any;
    const save = repository
      .saveArticle({ url: "https://example.com/new", title: "New" })
      .catch((error) => {
        saveDiagnostic = error.diagnostic;
        throw error;
      });
    const saveFailure = rejectsFatal(() => save);
    await queued;
    assert.equal(remoteSaves, 1);
    let deleted: Promise<void> | undefined;
    if (scenario === "queued-mutations") {
      let deletionQueued!: () => void;
      const deletionReady = new Promise<void>((resolve) => {
        deletionQueued = resolve;
      });
      Reflect.set(repository, "enqueueCommit", (work: any, ...outcome: any[]) => {
        const result = enqueue(work, ...outcome);
        deletionQueued();
        return result;
      });
      deleted = rejectsFatal(() =>
        repository.deleteArticle(original.id).catch((error) => {
          deleteDiagnostic = error.diagnostic;
          throw error;
        }),
      );
      await deletionReady;
      assert.equal(remoteDeletes, 1);
    }
    rejectWrite(quota);
    await Promise.all([firstFailure, saveFailure, deleted]);
    assert.equal(saveDiagnostic.remoteOutcome, "succeeded");
    assert.equal(saveDiagnostic.remoteOperation, "save");
    if (scenario === "queued-mutations") {
      assert.equal(deleteDiagnostic.remoteOutcome, "succeeded");
      assert.equal(deleteDiagnostic.remoteOperation, "delete");
    }
    assert.equal(
      getStorageDiagnostic()?.remoteOutcome,
      "succeeded",
      "queued completed save must retain its known success",
    );
    assert.equal(
      getStorageDiagnostic()?.remoteOperation,
      scenario === "queued-mutations" ? "delete" : "save",
    );
    assert.match(getStorageDiagnostic()!.error, /Remote save succeeded. Do not repeat it/);
    if (scenario === "queued-mutations")
      assert.match(getStorageDiagnostic()!.error, /Remote delete succeeded. Do not repeat it/);
    break;
  }
  default:
    throw new Error(`Unknown scenario ${scenario}`);
}

if (getStorageDiagnostic()) {
  assert.equal(getStorageDiagnostic()!.error.includes("SECRET"), false);
  assert.equal(getStorageDiagnostic()!.error.includes("https://"), false);
  const count = [writes, removes, remoteSaves, remoteDeletes, fetches];
  await rejectsFatal(() =>
    repository.saveArticle({ url: "https://example.com/blocked", title: "Blocked" }),
  );
  await rejectsFatal(() => repository.deleteArticle(original.id));
  await rejectsFatal(() => repository.syncWithAPI());
  await rejectsFatal(() => refreshFilterLists());
  await rejectsFatal(() => tokens.checkAndRefreshTokens());
  assert.deepEqual([writes, removes, remoteSaves, remoteDeletes, fetches], count);
  if (!["timestamps", "background", "worker-restart"].includes(scenario!)) {
    assert.strictEqual(Reflect.get(repository, "articlesCache"), priorCache);
    assert.deepEqual(priorCache, [original]);
  }
  let received: unknown;
  onFatalStorage((diagnostic) => {
    received = diagnostic;
  });
  assert.strictEqual(received, getStorageDiagnostic());
}
