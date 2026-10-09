import type { StorageDiagnostic } from "./fatal-storage";

let stopped = false;
let renderError: ((message: string) => void) | undefined;

export function isStorageStopped(): boolean {
  return stopped;
}

export function showStorageDiagnostic(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    !("code" in value) ||
    value.code !== "FATAL_LOCAL_STORAGE" ||
    !("error" in value) ||
    typeof value.error !== "string"
  )
    return false;
  stopped = true;
  renderError?.(value.error);
  document
    .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      "input, button, select",
    )
    .forEach((control) => {
      if (control.id !== "settings-button") control.disabled = true;
      if (control.id === "save-page-button") {
        control.textContent = "!";
        control.title = "Pouch stopped: local storage failed";
        control.setAttribute("aria-label", control.title);
      }
    });
  return true;
}

export async function initializeStorageDiagnostics(
  render: (message: string) => void,
): Promise<void> {
  renderError = render;
  browser.runtime.onMessage.addListener(
    (message: { type?: string; diagnostic?: StorageDiagnostic }) => {
      if (message.type === "fatalStorage") showStorageDiagnostic(message.diagnostic);
    },
  );
  showStorageDiagnostic(await browser.runtime.sendMessage({ type: "getStorageDiagnostic" }));
}
