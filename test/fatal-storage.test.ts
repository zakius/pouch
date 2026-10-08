import { expect, test } from "bun:test";

// Each scenario gets a fresh worker: the production latch intentionally has no reset API.
for (const scenario of [
  "quick-recovery-disable",
  "quick-recovery-badge",
  "quick-recovery-title",
  "quick-recovery-tab-disable",
  "quick-recovery-tab-title",
  "startup-token-get-race",
  "startup-token-create-race",
  "startup-refresh-create-race",
  "startup-menu-create-race",
  "quick-normal-disable",
  "quick-normal-badge",
  "quick-normal-title",
  "quick-normal-icon",
  "quick-normal-tab-title",
  "quick-normal-enable",
  "startup-page-menu-create-race",
  "startup-filter-alarm-create-race",
  "startup-remove-all-race",
  "startup-token-get-race-chromium",
  "startup-menu-create-race-chromium",
  "articles",
  "delete",
  "queued",
  "queued-outcome",
  "queued-mutations",
  "ui-race",
  "ui-menu-race",
  "firefox-icon-race",
  "firefox-title-race",
  "firefox-show-race",
  "external-health",
  "external-fatal",
  "auth-outcome",
  "instapaper-auth-outcome",
  "sync-articles",
  "timestamps",
  "tokens",
  "token-clear",
  "token-clear-all",
  "token-refresh",
  "token-refresh-failed",
  "token-refresh-transient",
  "wallabag-save-storage",
  "wallabag-delete-storage",
  "wallabag-sync-storage",
  "wallabag-sync-timestamp",
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
          POUCH_TARGET:
            [
              "worker-restart",
              "ui-race",
              "ui-menu-race",
              "external-health",
              "external-fatal",
            ].includes(scenario) ||
            scenario.startsWith("quick-") ||
            scenario.endsWith("-chromium")
              ? "chromium"
              : "firefox",
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
