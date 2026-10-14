import { expect, test } from "bun:test";
import firefox from "../src/manifest.json" with { type: "json" };
import chromium from "../src/chromium/manifest.json" with { type: "json" };

// Both builds run the same code, so a permission added to one manifest only
// fails at runtime in the other browser.
test("Firefox and Chromium manifests ask for the same permissions", () => {
  expect([...chromium.permissions].sort()).toEqual([...firefox.permissions].sort());
  expect([...chromium.optional_host_permissions].sort()).toEqual(
    [...firefox.optional_permissions].sort(),
  );
});
