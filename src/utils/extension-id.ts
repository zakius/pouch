import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Bun macro: the Chromium extension ID fixed by a manifest's `key`. Chromium
 * hashes the public key and spells the first 32 hex digits with a to p.
 * The path is relative to src.
 */
export function extensionId(manifestPath: string): string {
  const { key } = JSON.parse(readFileSync(join(import.meta.dir, "..", manifestPath), "utf8")) as {
    key: string;
  };
  return createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}
