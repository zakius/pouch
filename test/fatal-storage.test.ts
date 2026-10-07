import { expect, test } from "bun:test";

// Each scenario gets a fresh worker: the production latch intentionally has no reset API.
for (const scenario of [
  "articles",
  "delete",
  "queued",
  "sync-articles",
  "timestamps",
  "tokens",
  "token-clear",
  "token-clear-all",
  "token-refresh",
  "token-refresh-failed",
  "draft",
  "token-schema",
  "ui-initial",
  "options-ui",
  "ui-broadcast",
  "filter-set",
  "filter-remove",
  "clear",
  "stale",
  "startup-set",
  "startup-remove",
  "startup-read",
  "startup-healthy",
  "network",
  "interrupt",
  "late-save",
  "background",
  "worker-restart",
]) {
  test(`fatal local storage: ${scenario}`, () => {
    const result = Bun.spawnSync(
      [process.execPath, `${import.meta.dir}/fixtures/fatal-storage-scenario.ts`, scenario],
      {
        env: {
          ...process.env,
          POUCH_TARGET: scenario === "worker-restart" ? "chromium" : "firefox",
        },
        timeout: 10_000,
      },
    );
    expect({
      status: result.exitCode,
      error: result.exitCode === 0 ? "" : result.stderr.toString(),
    }).toEqual({ status: 0, error: "" });
  });
}
