import { beforeEach, expect, test } from "bun:test";
import type { Article } from "../src/types/common";
import { CredentialsFailure } from "../src/background/api/effect-adapter";
import { errorResponse } from "../src/background/runtime-message";

interface FakeElement {
  id: string;
  className: string;
  title: string;
  textContent: string;
  innerHTML: string;
  href: string;
  target: string;
  rel: string;
  disabled: boolean;
  selected: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  children: FakeElement[];
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
  };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(): void;
  closest(): null;
}

const elementClasses = new WeakMap<FakeElement, Set<string>>();

function makeElement(id = ""): FakeElement {
  const el: FakeElement = {
    id,
    className: "",
    title: "",
    textContent: "",
    innerHTML: "",
    href: "",
    target: "",
    rel: "",
    disabled: false,
    selected: false,
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    classList: {
      add: (...names: string[]) => {
        const set = elementClasses.get(el);
        if (set) names.forEach((n) => set.add(n));
      },
      remove: (...names: string[]) => {
        const set = elementClasses.get(el);
        if (set) names.forEach((n) => set.delete(n));
      },
      contains: (name: string) => elementClasses.get(el)?.has(name) ?? false,
    },
    setAttribute(name: string, value: string) {
      el.attributes[name] = value;
    },
    getAttribute(name: string) {
      return el.attributes[name];
    },
    appendChild(child: FakeElement) {
      el.children.push(child);
      return child;
    },
    addEventListener() {},
    closest: () => null,
  };
  elementClasses.set(el, new Set());
  return el;
}

const elements = new Map<string, FakeElement>();
for (const id of [
  "search",
  "articles",
  "prev-page",
  "next-page",
  "page-info",
  "page-select",
  "save-page-button",
  "article-list",
  "empty-message",
  "no-results-message",
  "sr-live",
]) {
  elements.set(id, makeElement(id));
}
let domReadyHandler: (() => void | Promise<void>) | undefined;
let bodyClickHandler: ((event: MouseEvent) => void) | undefined;
let handleMessage: (message: Record<string, unknown>) => Promise<unknown>;

type AnyRecord = Record<string, unknown>;

const fakeDocument = {
  getElementById: (id: string) => elements.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [...elements.values()],
  createElement: () => makeElement(),
  createTextNode: (text: string) => ({ text }),
  addEventListener: (_: string, handler: () => void | Promise<void>) => {
    domReadyHandler = handler;
  },
  body: {
    addEventListener: (_: string, handler: (event: MouseEvent) => void) => {
      bodyClickHandler = handler;
    },
  },
};

const fakeBrowser = {
  tabs: {
    query: async (_options: AnyRecord): Promise<AnyRecord[]> => [
      { id: 1, url: "https://example.com/", title: "Example" },
    ],
  },
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: (message: AnyRecord) =>
      message.type === "getStorageDiagnostic" ? Promise.resolve(null) : handleMessage(message),
    openOptionsPage: async (): Promise<void> => {},
  },
};

Object.assign(globalThis, { document: fakeDocument, browser: fakeBrowser });

const popup = await import("../src/popup/popup");

function el(id: string): FakeElement {
  const element = elements.get(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element;
}

function articles(): FakeElement {
  return el("articles");
}

function errorMessageText(): string {
  const errorDiv = articles().children.find((child) => child.className === "error-message");
  if (!errorDiv) return "";
  return errorDiv.children
    .map((node) =>
      typeof (node as FakeElement).textContent === "string"
        ? (node as FakeElement).textContent
        : String((node as { text?: string }).text ?? ""),
    )
    .join("");
}

function click(target: FakeElement): void {
  bodyClickHandler?.({
    target,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent);
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 2000) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function initializePopup(): Promise<void> {
  await domReadyHandler?.();
}

function listResponse(items: Article[]): AnyRecord {
  return { items, page: 1, pages: items.length > 0 ? 1 : 0, total: items.length };
}

const exampleArticle: Article = {
  id: 7,
  url: "https://example.com/",
  title: "Example",
  created_at: "2026-01-01",
};

function makeDeleteButton(articleId: number | string): FakeElement {
  const button = makeElement();
  button.classList.add("delete-button");
  button.dataset.articleId = String(articleId);
  return button;
}

beforeEach(() => {
  for (const element of elements.values()) {
    element.title = "";
    element.textContent = "";
    element.innerHTML = "";
    element.disabled = false;
    element.selected = false;
    element.style = {};
    element.dataset = {};
    element.attributes = {};
    element.children = [];
    element.classList.remove(...(elementClasses.get(element) ?? []));
  }
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([]);
    if (message.type === "checkArticle") return undefined;
    return {};
  };
});

test("failed save shows the background's reason and a settings link", async () => {
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([]);
    if (message.type === "checkArticle") return undefined;
    if (message.type === "saveArticle") return errorResponse(new CredentialsFailure("save"));
    return {};
  };
  await initializePopup();
  await until(() => el("save-page-button").style.display === "block", "save button visible");

  click(el("save-page-button"));
  await until(() => !el("save-page-button").disabled, "save button re-enabled");

  const error = errorMessageText();
  expect(error).toBe(
    "The server did not accept your login details. Check them in Pouch settings. Check Settings",
  );
  expect(el("articles").style.display).toBe("block");
  expect(el("sr-live").textContent).toContain("did not accept your login details");
  expect(el("save-page-button").classList.contains("saved")).toBe(false);
});

test("failed save without a background reason falls back to a retry hint", async () => {
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([]);
    if (message.type === "checkArticle") return undefined;
    if (message.type === "saveArticle") throw new Error("Receiving end does not exist.");
    return {};
  };
  await initializePopup();
  await until(() => el("save-page-button").style.display === "block", "save button visible");

  click(el("save-page-button"));
  await until(() => !el("save-page-button").disabled, "save button re-enabled");

  expect(errorMessageText()).toBe("Failed to save article. Please try again.");
});

test("failed row deletion shows an error instead of announcing success", async () => {
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([exampleArticle]);
    if (message.type === "checkArticle") return exampleArticle;
    if (message.type === "deleteArticle") return { error: "backend rejected the delete" };
    return {};
  };
  await initializePopup();
  await until(() => el("save-page-button").classList.contains("saved"), "save button saved");

  const deleteButton = makeDeleteButton(7);
  click(deleteButton);
  click(deleteButton);
  await until(() => !deleteButton.disabled, "delete button re-enabled");

  expect(el("sr-live").textContent).not.toBe("Article deleted.");
  const error = errorMessageText();
  expect(error).toBe("backend rejected the delete");
  expect(el("articles").style.display).toBe("block");
});

test("deleting the active page row refreshes saved state and enables the button after success", async () => {
  let saved = exampleArticle;
  let deleted = false;
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse(deleted ? [] : [exampleArticle]);
    if (message.type === "checkArticle") return saved;
    if (message.type === "deleteArticle") {
      deleted = true;
      saved = undefined as unknown as Article;
      return {};
    }
    return {};
  };
  await initializePopup();
  await until(() => el("save-page-button").classList.contains("saved"), "save button saved");

  const deleteButton = makeDeleteButton(7);
  click(deleteButton);
  click(deleteButton);
  await until(
    () => !deleteButton.disabled && !el("save-page-button").classList.contains("saved"),
    "delete finished and saved state refreshed",
  );

  expect(el("save-page-button").disabled).toBe(false);
  expect(el("save-page-button").textContent).toBe("+");
  expect(el("sr-live").textContent).toBe("Article deleted.");
  expect(el("articles").style.display).toBe("none");
  expect(el("empty-message").style.display).toBe("block");
});

test("slow status refresh keeps the save button busy and consecutive clicks are ignored", async () => {
  let checkCount = 0;
  let refreshStatus: ((value: Article | undefined) => void) | undefined;
  let saveCount = 0;
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([]);
    if (message.type === "checkArticle") {
      checkCount += 1;
      if (checkCount === 1) return undefined;
      return new Promise<Article | undefined>((resolve) => {
        refreshStatus = resolve;
      });
    }
    if (message.type === "saveArticle") {
      saveCount += 1;
      return {};
    }
    return {};
  };
  await initializePopup();
  await until(() => el("save-page-button").style.display === "block", "save button visible");

  const saveButton = el("save-page-button");
  click(saveButton);
  await until(() => saveCount === 1, "save requested");
  expect(saveButton.disabled).toBe(true);

  click(saveButton);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(saveCount).toBe(1);

  refreshStatus?.(exampleArticle);
  await until(() => !saveButton.disabled, "save button re-enabled");
  expect(saveButton.classList.contains("saved")).toBe(true);
  expect(saveButton.textContent).toBe("✓");
  expect(saveButton.getAttribute("aria-pressed")).toBe("true");
});

test("initialization failure surfaces error content even when the list was empty", async () => {
  handleMessage = async (message) => {
    if (message.type === "getArticles") return { error: "storage unavailable" };
    if (message.type === "checkArticle") return undefined;
    return {};
  };
  await initializePopup();
  await until(() => errorMessageText() !== "", "error shown after empty list");
  expect(el("articles").style.display).toBe("block");
});

const stringIdArticle: Article = {
  id: "12abcDEF_-xy",
  url: "https://example.com/bookmarked",
  title: "Bookmarked",
  created_at: "2026-01-02",
};

test("articles with native string IDs render and delete passes the exact ID", async () => {
  const otherStringIdArticle: Article = { ...stringIdArticle, id: "12xyz", title: "Other" };
  let deletePayloads: unknown[] = [];
  handleMessage = async (message) => {
    if (message.type === "getArticles") {
      return listResponse([stringIdArticle, otherStringIdArticle]);
    }
    if (message.type === "checkArticle") return undefined;
    if (message.type === "deleteArticle") {
      deletePayloads = [...deletePayloads, message.payload.articleId];
      return {};
    }
    return {};
  };
  await initializePopup();
  await until(() => articles().children.length === 2, "both string-ID articles rendered");

  const deleteButton = makeDeleteButton("12abcDEF_-xy");
  click(deleteButton);
  click(deleteButton);
  await until(() => deletePayloads.length === 1, "delete sent for string ID");

  expect(deletePayloads[0]).toBe("12abcDEF_-xy");
});

test("fatal storage response shows confirmed remote success and blocks another save", async () => {
  let saves = 0;
  const diagnostic = {
    code: "FATAL_LOCAL_STORAGE",
    error:
      "Pouch stopped: persist articles failed. QuotaExceededError: quota. Remote save succeeded. Do not repeat it. Restart the extension.",
    remoteOutcome: "succeeded",
  };
  handleMessage = async (message) => {
    if (message.type === "getArticles") return listResponse([]);
    if (message.type === "checkArticle") return undefined;
    if (message.type === "saveArticle") {
      saves++;
      return diagnostic;
    }
    return {};
  };
  await initializePopup();
  click(el("save-page-button"));
  await until(
    () => errorMessageText().includes("Remote save succeeded"),
    "fatal diagnostic visible",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(el("save-page-button").disabled).toBe(true);
  expect(el("save-page-button").textContent).toBe("!");
  click(el("save-page-button"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saves).toBe(1);
});
