import { logger } from "./logger";
import type { Settings } from "./settings";

/**
 * Host origins baked into adapters. Everything else (self-hosted instances)
 * is derived from the apiConfig URL at request time.
 */
const FIXED_BACKEND_ORIGINS: Partial<Record<Settings["backend"], string[]>> = {
  instapaper: ["https://www.instapaper.com/*"],
  raindrop: ["https://api.raindrop.io/*"],
};

export function originPatternFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return null;
  }
}

export function getBackendOrigins(settings: Settings): string[] {
  if (settings.backend === "bookmarks") return [];
  const fixed = FIXED_BACKEND_ORIGINS[settings.backend];
  if (fixed) return fixed;
  const pattern = originPatternFromUrl((settings.apiConfig as { url?: string }).url);
  return pattern ? [pattern] : [];
}

export function messageForOrigins(origins: string[]): string {
  const labels = origins.map((pattern) => pattern.replace(/\/\*$/, "")).join(" and ");
  return `Pouch needs permission to access ${labels}. Open Pouch settings and save to grant access.`;
}

export function missingPermissionMessage(settings: Settings): string {
  return messageForOrigins(getBackendOrigins(settings));
}

export async function getMissingOrigins(settings: Settings): Promise<string[]> {
  const origins = getBackendOrigins(settings);
  if (origins.length === 0) return [];
  try {
    const missing: string[] = [];
    for (const origin of origins) {
      if (!(await browser.permissions.contains({ origins: [origin] }))) {
        missing.push(origin);
      }
    }
    return missing;
  } catch (error) {
    logger.warn("Failed to check host permissions:", error);
    return [];
  }
}

export async function hasBackendPermissions(settings: Settings): Promise<boolean> {
  return (await getMissingOrigins(settings)).length === 0;
}

/**
 * Must be called from a user input handler (e.g. a click on Save) — the
 * browser shows a permission prompt for each origin not yet granted.
 */
export async function ensureBackendPermissions(settings: Settings): Promise<boolean> {
  const origins = getBackendOrigins(settings);
  if (origins.length === 0) return true;
  try {
    if (await browser.permissions.contains({ origins })) return true;
    return await browser.permissions.request({ origins });
  } catch (error) {
    logger.warn("Failed to request host permissions:", error);
    return false;
  }
}

/**
 * Revokes optional origins that are granted but no longer needed by the
 * current backend (e.g. after switching services or changing an instance URL).
 */
export async function pruneBackendPermissions(settings: Settings): Promise<void> {
  try {
    const granted = await browser.permissions.getAll();
    const needed = new Set(getBackendOrigins(settings));
    const stale = (granted.origins ?? []).filter((origin) => !needed.has(origin));
    if (stale.length === 0) return;
    await browser.permissions.remove({ origins: stale });
    logger.info("Revoked unused host permissions:", stale);
  } catch (error) {
    logger.warn("Failed to prune host permissions:", error);
  }
}

/**
 * Message for a fetch that failed because the origin's host permission is not
 * granted, or null when it is granted (or the URL has no such origin).
 */
export async function permissionErrorMessageForUrl(url: string): Promise<string | null> {
  const pattern = originPatternFromUrl(url);
  if (!pattern) return null;
  try {
    if (await browser.permissions.contains({ origins: [pattern] })) return null;
    return messageForOrigins([pattern]);
  } catch {
    return null;
  }
}
