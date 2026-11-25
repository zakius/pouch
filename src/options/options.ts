import {
  initializeStorageDiagnostics,
  isStorageStopped,
  showStorageDiagnostic,
} from "../utils/storage-diagnostics-ui";
import "../utils/chromium";
import * as v from "valibot";
import {
  ensureBackendPermissions,
  missingPermissionMessage,
  pruneBackendPermissions,
} from "../utils/backend-permissions";
import { LogLevel } from "../utils/log-levels";
import { logger } from "../utils/logger";
import { getSettings, type Settings, settingsSchema } from "../utils/settings";
import { backendForms } from "../utils/settings-schemas";

const availableBackends = Object.keys(backendForms) as Settings["backend"][];

type DomElementsNullable = {
  backendSelect: HTMLSelectElement | null;
  configContainer: HTMLElement | null;
  saveButton: HTMLButtonElement | null;
  testConnectionButton: HTMLButtonElement | null;
  enableVerboseLoggingCheckbox: HTMLInputElement | null;
  statusDiv: HTMLElement | null;
  normalizeOnSaveCheckbox: HTMLElement | null;
  normalizeOnCompareCheckbox: HTMLElement | null;
};
type DomElements = {
  [K in keyof DomElementsNullable]-?: NonNullable<DomElementsNullable[K]>;
};
const dom: DomElementsNullable = {
  backendSelect: document.getElementById("backend-select") as HTMLSelectElement,
  configContainer: document.getElementById("config-container"),
  saveButton: document.getElementById("save") as HTMLButtonElement,
  testConnectionButton: document.getElementById("test-connection") as HTMLButtonElement,
  enableVerboseLoggingCheckbox: document.getElementById(
    "enable-verbose-logging",
  ) as HTMLInputElement | null,
  statusDiv: document.getElementById("status"),
  normalizeOnSaveCheckbox: document.getElementById("normalize-on-save"),
  normalizeOnCompareCheckbox: document.getElementById("normalize-on-compare"),
};
function assertDom(d: DomElementsNullable): asserts d is DomElements {
  const missingElements = Object.entries(d)
    .filter(([, element]) => !element)
    .map(([key]) => key);
  if (missingElements.length > 0) {
    throw new Error(`Required DOM elements not found: ${missingElements.join(", ")}`);
  }
}
const configCache: {
  [key in Settings["backend"]]?: Partial<Settings["apiConfig"]>;
} = {};
const configDrafts: Record<string, Record<string, string | boolean>> = {};
async function initialize(): Promise<void> {
  try {
    assertDom(dom);
    await initializeStorageDiagnostics((message) => showStatus(message, "error"));
    if (isStorageStopped()) return;
    const settings = await getSettings();
    if (isStorageStopped()) return;
    for (const backend of availableBackends) {
      const option = document.createElement("option");
      option.value = backend;
      option.textContent = backendForms[backend].displayName;
      dom.backendSelect.appendChild(option);
    }
    configCache[settings.backend] = settings.apiConfig;
    dom.backendSelect.value = settings.backend;
    if (dom.enableVerboseLoggingCheckbox instanceof HTMLInputElement) {
      dom.enableVerboseLoggingCheckbox.checked = settings.logLevel === LogLevel.DEBUG;
    }
    if (dom.normalizeOnSaveCheckbox instanceof HTMLInputElement) {
      dom.normalizeOnSaveCheckbox.checked = settings.normalizeOnSave;
    }
    if (dom.normalizeOnCompareCheckbox instanceof HTMLInputElement) {
      dom.normalizeOnCompareCheckbox.checked = settings.normalizeOnCompare;
    }
    await loadBackend(settings.backend);
    dom.backendSelect.addEventListener("change", () =>
      loadBackend(dom.backendSelect.value as Settings["backend"]),
    );
    document.body.addEventListener("click", handleBodyClick);
  } catch (error) {
    logger.error("Error initializing options:", error);
    if (isStorageStopped()) return;
    if (dom.backendSelect) dom.backendSelect.disabled = true;
    if (dom.saveButton) dom.saveButton.disabled = true;
    if (dom.testConnectionButton) dom.testConnectionButton.disabled = true;
    showStatus(`Error initializing options: ${(error as Error).message}`, "error");
  }
}
async function loadBackend(backend: Settings["backend"]): Promise<void> {
  if (isStorageStopped()) return;
  assertDom(dom);
  const previousForm = dom.configContainer.querySelector("form");
  if (previousForm instanceof HTMLFormElement) {
    const previousBackend = availableBackends.find(
      (candidate) => `${candidate}-config` === previousForm.id,
    );
    if (previousBackend) {
      const draft: Record<string, string | boolean> = {};
      for (const input of Array.from(previousForm.querySelectorAll("input"))) {
        if (input.name) {
          draft[input.name] = input.type === "checkbox" ? input.checked : input.value;
        }
      }
      configDrafts[previousBackend] = draft;
    }
  }
  const { formConfig } = backendForms[backend];
  dom.testConnectionButton.hidden = backend === "bookmarks";
  dom.configContainer.innerHTML = "";
  const form = document.createElement("form");
  form.id = `${backend}-config`;
  form.method = "post";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!dom.saveButton.disabled) {
      void handleSaveSettings();
    }
  });
  for (const field of formConfig) {
    const fieldContainer = document.createElement("div");
    const label = document.createElement("label");
    label.htmlFor = field.name;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type =
      field.type ?? (field.name.toLowerCase().includes("password") ? "password" : "text");
    input.id = field.name;
    input.name = field.name;
    const config = (configDrafts[backend] || configCache[backend] || {}) as Record<
      string,
      string | boolean | undefined
    >;
    if (field.type === "checkbox") {
      fieldContainer.className = "form-group-checkbox";
      input.checked = config[field.name] === true;
      fieldContainer.appendChild(input);
      fieldContainer.appendChild(label);
    } else {
      fieldContainer.className = "form-group";
      input.className = "form-control";
      const storedValue = config[field.name];
      input.value = typeof storedValue === "string" ? storedValue : "";
      fieldContainer.appendChild(label);
      fieldContainer.appendChild(input);
    }
    form.appendChild(fieldContainer);
  }
  dom.configContainer.appendChild(form);
}
function handleBodyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (!target) return;

  if (target.id === "save" || target.closest("#save")) {
    event.preventDefault();
    const button = (target.id === "save" ? target : target.closest("#save")) as HTMLButtonElement;
    if (button && !button.disabled) {
      void handleSaveSettings();
    }
    return;
  }

  if (target.id === "test-connection" || target.closest("#test-connection")) {
    event.preventDefault();
    const button = (
      target.id === "test-connection" ? target : target.closest("#test-connection")
    ) as HTMLButtonElement;
    if (button && !button.disabled) {
      void handleTestConnection();
    }
    return;
  }
}

async function handleSaveSettings(): Promise<void> {
  if (isStorageStopped()) return;
  assertDom(dom);
  const settings = getSettingsFromForm();
  if (!settings) {
    return;
  }
  configCache[settings.backend] = settings.apiConfig;
  dom.saveButton.disabled = true;
  try {
    if (!(await ensureBackendPermissions(settings))) {
      showStatus(missingPermissionMessage(settings), "error");
      return;
    }
    const response: unknown = await browser.runtime.sendMessage({
      type: "saveSettings",
      payload: { settings },
    });
    if (showStorageDiagnostic(response) || isStorageStopped()) return;
    const outcome = parseOutcome(response);
    if (outcome.success) {
      await pruneBackendPermissions(settings);
      showStatus("Settings saved successfully", "success");
    } else {
      showStatus(`Error saving settings: ${outcome.error}`, "error");
    }
  } catch (error: unknown) {
    logger.warn("Failed to notify background script about settings update:", error);
    if (isStorageStopped()) return;
    showStatus(`Error saving settings: ${(error as Error).message}`, "error");
  } finally {
    dom.saveButton.disabled = isStorageStopped();
  }
}
const outcomeSchema = v.object({
  success: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

/** Reads a background reply to saveSettings or testConnection. */
function parseOutcome(response: unknown): { success: boolean; error: string } {
  const parsed = v.safeParse(outcomeSchema, response);
  const error = (parsed.success && parsed.output.error) || "Unknown error";
  return { success: parsed.success && parsed.output.success === true, error };
}
async function handleTestConnection(): Promise<void> {
  if (isStorageStopped()) return;
  assertDom(dom);
  const settings = getSettingsFromForm();
  if (!settings) {
    return;
  }
  showStatus("Testing connection...", "info");
  dom.testConnectionButton.disabled = true;
  try {
    if (!(await ensureBackendPermissions(settings))) {
      showStatus(missingPermissionMessage(settings), "error");
      return;
    }
    const response: unknown = await browser.runtime.sendMessage({
      type: "testConnection",
      payload: { settings },
    });
    if (showStorageDiagnostic(response) || isStorageStopped()) return;
    const outcome = parseOutcome(response);
    if (outcome.success) {
      showStatus("Connection successful! Remember to save your settings.", "success");
    } else {
      showStatus(`Connection failed: ${outcome.error}`, "error");
    }
  } catch (error) {
    logger.error("Error testing connection:", error);
    if (isStorageStopped()) return;
    showStatus(`Error testing connection: ${(error as Error).message}`, "error");
  } finally {
    dom.testConnectionButton.disabled = isStorageStopped();
  }
}
const OPTIONAL_FORM_FIELDS = new Set(["password"]);

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getSettingsFromForm(): Settings | null {
  assertDom(dom);
  const backend = dom.backendSelect.value as Settings["backend"];
  const backendForm = backendForms[backend];
  if (!backendForm) {
    showStatus("Invalid settings: Unsupported backend selected", "error");
    logger.error("Invalid settings provided: unsupported backend", backend);
    return null;
  }
  const getInputElement = (id: string): HTMLInputElement | null =>
    document.getElementById(id) as HTMLInputElement | null;
  const apiConfig: Record<string, string | boolean> = {};
  const validationErrors: string[] = [];
  for (const field of backendForm.formConfig) {
    const input = getInputElement(field.name);
    if (field.type === "checkbox") {
      apiConfig[field.name] = Boolean(input?.checked);
      continue;
    }
    const rawValue = input?.value || "";
    const isOptional = OPTIONAL_FORM_FIELDS.has(field.name);
    const value = isOptional ? rawValue : rawValue.trim();
    if (!isOptional && value.length === 0) {
      validationErrors.push(`${field.label} is required`);
    } else if (field.name === "url" && !isHttpUrl(value)) {
      validationErrors.push(`${field.label} must be a valid http:// or https:// URL`);
    }
    apiConfig[field.name] = value;
  }
  if (validationErrors.length > 0) {
    const errorMessage = validationErrors.join(", ");
    showStatus(`Invalid settings: ${errorMessage}`, "error");
    logger.error("Invalid settings provided:", errorMessage);
    return null;
  }
  const rawSettings = {
    backend,
    logLevel:
      dom.enableVerboseLoggingCheckbox instanceof HTMLInputElement &&
      dom.enableVerboseLoggingCheckbox.checked
        ? LogLevel.DEBUG
        : LogLevel.ERROR,
    normalizeOnSave:
      dom.normalizeOnSaveCheckbox instanceof HTMLInputElement &&
      dom.normalizeOnSaveCheckbox.checked,
    normalizeOnCompare:
      dom.normalizeOnCompareCheckbox instanceof HTMLInputElement &&
      dom.normalizeOnCompareCheckbox.checked,
    apiConfig,
  };
  const result = v.safeParse(settingsSchema, rawSettings);
  if (!result.success) {
    const errorMessage = result.issues
      .map((issue: { message: string }) => issue.message)
      .join(", ");
    showStatus(`Invalid settings: ${errorMessage}`, "error");
    logger.error("Invalid settings provided:", errorMessage);
    return null;
  }
  return result.output;
}
type StatusType = "info" | "success" | "error";
let statusShowTimer: ReturnType<typeof setTimeout> | undefined;
let statusHideTimer: ReturnType<typeof setTimeout> | undefined;
let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
function showStatus(message: string, type: StatusType = "info"): void {
  if (isStorageStopped() && !message.startsWith("Pouch stopped:")) return;
  assertDom(dom);
  clearTimeout(statusShowTimer);
  clearTimeout(statusHideTimer);
  clearTimeout(statusClearTimer);
  statusShowTimer = undefined;
  statusHideTimer = undefined;
  statusClearTimer = undefined;
  dom.statusDiv.textContent = message;
  dom.statusDiv.className = `status ${type}`;
  statusShowTimer = setTimeout(() => {
    statusShowTimer = undefined;
    dom.statusDiv.classList.add("show");
  }, 10);
  // Errors stay until the next status so they can be read at any pace.
  if (isStorageStopped() || type === "error") return;
  statusHideTimer = setTimeout(() => {
    statusHideTimer = undefined;
    if (isStorageStopped()) return;
    dom.statusDiv.classList.remove("show");
    statusClearTimer = setTimeout(() => {
      statusClearTimer = undefined;
      if (isStorageStopped()) return;
      dom.statusDiv.textContent = "";
    }, 300);
  }, 3000);
}
document.addEventListener("DOMContentLoaded", initialize);
