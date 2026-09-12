import * as v from "valibot";
import { availableBackends, getAdapter } from "../utils/adapter-factory";
import {
  ensureBackendPermissions,
  missingPermissionMessage,
  pruneBackendPermissions,
} from "../utils/backend-permissions";
import { LogLevel } from "../utils/log-levels";
import { logger } from "../utils/logger";
import { getSettings, type Settings, settingsSchema } from "../utils/settings";

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
const configDrafts: Record<string, Record<string, string>> = {};
async function initialize(): Promise<void> {
  try {
    assertDom(dom);
    const settings = await getSettings();
    for (const backend of availableBackends) {
      const adapter = getAdapter(backend);
      const option = document.createElement("option");
      option.value = backend;
      option.textContent = adapter.displayName;
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
    showStatus(`Error initializing options: ${(error as Error).message}`, "error");
  }
}
async function loadBackend(backend: Settings["backend"]): Promise<void> {
  assertDom(dom);
  const previousForm = dom.configContainer.querySelector("form");
  if (previousForm instanceof HTMLFormElement) {
    const previousBackend = availableBackends.find(
      (candidate) => `${candidate}-config` === previousForm.id,
    );
    if (previousBackend) {
      const draft: Record<string, string> = {};
      for (const input of Array.from(previousForm.querySelectorAll("input"))) {
        if (input.name) {
          draft[input.name] = input.value;
        }
      }
      configDrafts[previousBackend] = draft;
    }
  }
  const factory = getAdapter(backend);
  const formConfig = factory.formConfig;
  dom.configContainer.innerHTML = "";
  const form = document.createElement("form");
  form.id = `${backend}-config`;
  for (const field of formConfig) {
    const fieldContainer = document.createElement("div");
    fieldContainer.className = "form-group";
    const label = document.createElement("label");
    label.htmlFor = field.name as string;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = (field.name as string).toLowerCase().includes("password") ? "password" : "text";
    input.id = field.name as string;
    input.name = field.name as string;
    input.className = "form-control";
    const config = configDrafts[backend] || configCache[backend] || {};
    input.value = (config as Record<string, string>)[field.name as string] || "";
    fieldContainer.appendChild(label);
    fieldContainer.appendChild(input);
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
    const response = await browser.runtime.sendMessage({
      type: "saveSettings",
      payload: { settings },
    });
    if (response?.success) {
      await pruneBackendPermissions(settings);
      showStatus("Settings saved successfully", "success");
    } else {
      showStatus(`Error saving settings: ${response?.error || "Unknown error"}`, "error");
    }
  } catch (error: unknown) {
    logger.warn("Failed to notify background script about settings update:", error);
    showStatus(`Error saving settings: ${(error as Error).message}`, "error");
  } finally {
    dom.saveButton.disabled = false;
  }
}
async function handleTestConnection(): Promise<void> {
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
    const response = await browser.runtime.sendMessage({
      type: "testConnection",
      payload: { settings },
    });
    if (response.success) {
      showStatus("Connection successful! Remember to save your settings.", "success");
    } else {
      showStatus(`Connection failed: ${response.error}`, "error");
    }
  } catch (error) {
    logger.error("Error testing connection:", error);
    showStatus(`Error testing connection: ${(error as Error).message}`, "error");
  } finally {
    dom.testConnectionButton.disabled = false;
  }
}
function getSettingsFromForm(): Settings | null {
  assertDom(dom);
  const getInputValue = (id: string): string => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    return input?.value || "";
  };
  const factory = getAdapter(dom.backendSelect.value as Settings["backend"]);
  const apiConfig: Record<string, string> = {};
  for (const field of factory.formConfig) {
    apiConfig[field.name as string] = getInputValue(field.name as string);
  }
  const rawSettings = {
    backend: dom.backendSelect.value,
    logLevel:
      dom.enableVerboseLoggingCheckbox instanceof HTMLInputElement &&
      dom.enableVerboseLoggingCheckbox.checked
        ? LogLevel.DEBUG
        : LogLevel.INFO,
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
function showStatus(message: string, type: StatusType = "info"): void {
  assertDom(dom);
  dom.statusDiv.textContent = message;
  dom.statusDiv.className = `status ${type}`;
  setTimeout(() => {
    dom.statusDiv.classList.add("show");
  }, 10);
  setTimeout(() => {
    dom.statusDiv.classList.remove("show");
    setTimeout(() => {
      dom.statusDiv.textContent = "";
    }, 300);
  }, 3000);
}
document.addEventListener("DOMContentLoaded", initialize);
