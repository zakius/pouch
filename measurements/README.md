# Effect migration measurements

Use this procedure for #74 and #81 from an exclusive checkout. Build Firefox first because that build removes Chromium output. Keep the Bun version and host constant when comparing samples.

```sh
bun install --frozen-lockfile
# ZIP updates retain obsolete entries; remove generated archives before measuring.
rm -f dist/packages/pouch-*.zip
bun run package
bun run package:chromium
python3 scripts/measure-effect.py measurements/effect-74-pilot.json
```

The script measures ten fresh Bun processes per target. Each imports the packaged, minified background entry and waits for the first `getArticles` message response. The timer starts immediately before import and includes module evaluation, startup storage checks, token loading, repository initialization, and the response. It excludes process creation and waits no fixed delay. Report the raw samples and median.

Storage, bookmark, alarm, tab, permission, and fetch APIs are in-memory mocks. Filter downloads return fixed data. These measurements represent packaged JavaScript startup under Bun with mocked extension APIs. They do not measure browser worker wake or real storage/network latency.

The JSON records package ZIP bytes, all minified JavaScript bytes, background entry bytes, source commit, Bun version, and OS. ZIP bytes can vary slightly with timestamps. JavaScript byte totals are the primary bundle-size comparison. Chromium measurements exclude the separate Quick Actions companion because the migration changes Pouch's background.

The baseline records source commit `94ee9a479a0cdfc294b1baa30f651a7416019a68` before changing product code or dependencies. The script existed before that run. Formatting it afterward did not change its behavior. Both runs use Bun 1.4.3 on the same Linux host. Each target gets ten cold processes, with filesystem caches left warm.

T3 preview opened successfully and reported HeadlessChrome 154.0.8037.92. Its page exposed neither `browser` nor `chrome.runtime`, and its tools provide no extension installation or Firefox execution control. Real extension startup, worker wake, and permission gestures remain browser-verification work for the integration owner. This report contains no actual browser startup measurements.

# Effect diagnostics

`effect` is pinned to 4.0.1. Developer tooling uses `@effect/tsgo` 0.51.1, TypeScript 7.0.2, Oxlint 1.87.0, and oxlint-tsgolint 7.0.2003. TypeScript 7.0.2 replaces the older native-preview compiler. These versions match the [official supported package list](https://github.com/Effect-TS/tsgo#supported-package-versions). See also the [v4 devtools documentation](https://effect.website/docs/v4/getting-started/devtools).

The package's `prepare` script patches only the project-local TypeScript binary through the official `effect-tsgo patch --typescript --no-oxlint` command. The dedicated diagnostics CLI requires a supported Oxlint binding even without Oxlint patching. The patch leaves global compilers untouched. Oxlint retains its own type-aware checks.

```sh
bun run typecheck
bun run diagnostics:effect
bun run lint
```

`lint` includes Effect diagnostics, and the quality workflow runs on `effect` PRs. Floating Effects, missing Effect/layer requirements, scope leaks, unknown error channels, and bad catch return types are errors in tsconfig. Other useful diagnostics retain their defaults. The standalone command uses `--strict` so warnings also fail the check.

A temporary `src/effect-diagnostic-proof.ts` containing the following emitted an Effect error and failed diagnostics:

```ts
import { Effect } from "effect";
Effect.succeed(1);
```

```text
error effect(floatingEffect): This Effect value is neither yielded nor used in an assignment.
1 errors, 0 warnings and 0 messages.
```

The proof fixture no longer exists. Clean product diagnostics checked 34 files and reported zero errors, warnings, and messages. The proof used the same project configuration and CLI command as the quality checks.

#81 removed the temporary Promise bridges. Every background listener runs one Effect through `runOperation`, which keeps operational failures, fatal storage, defects, and interruption separate. Fatal writes retain the #72 shutdown latch and known remote outcome.

# Bookmarks pilot (#73)

The baseline and pilot JSON files retain all twenty samples. The pilot executes product source commit `877d33ee84b5216bb934ab2cc3048225eb44d8a2`.

- Firefox: minified JavaScript 159,942 → 256,645 bytes. Background entry 80,609 → 130,833 bytes. ZIP 53,029 → 84,640 bytes. Mocked startup median 4.898 → 8.921 ms.
- Chromium: minified JavaScript 160,053 → 256,756 bytes. Background entry 80,646 → 130,870 bytes. ZIP 62,088 → 109,549 bytes. Mocked startup median 4.463 → 7.081 ms.

Both targets add 96,703 minified JavaScript bytes (about 60%). Mocked startup adds 4.023 ms for Firefox and 2.619 ms for Chromium. Effect also enters the options bundle through the legacy adapter factory. No runtime devtools server or external tracing infrastructure runs.

This is a substantial relative bundle increase, with a small absolute startup increase under the mocked host. The implementation passes the behavior pilot. Browser performance acceptance remains provisional until the integration owner measures real extension worker wake. Repeat this procedure for #74 and assess the combined pilot before migrating the remaining adapters.

Validation: 199 tests passed, including all retained #72 fatal lifecycle tests. Typecheck, type-aware Oxlint, formatting, diff checks, Effect diagnostics, and both package builds passed. Firefox `web-ext lint` reported zero errors and one existing Android minimum-version warning. Mozilla's validator rejects Chromium manifests for unsupported service workers and missing Firefox add-on IDs. Its Chromium output is not a Chromium compatibility verdict.

Both packaged background entries execute in the measurement script, and the build retains MV3 manifests and the separate Quick Actions package. Native extension installation remains outside the available preview controls.

## Review fixes (#73)

The follow-up samples in `effect-73-fix.json` execute product source commit `bc39ba80d1881bb25a16c024e2bed6585a0642dc`. They use the same host, script, ten cold processes, and mocked APIs as the original pilot.

- Firefox: minified JavaScript 260,656 bytes, background entry 132,940 bytes, ZIP 85,837 bytes, mocked startup median 8.844 ms.
- Chromium: minified JavaScript 260,767 bytes, background entry 132,977 bytes, ZIP 94,974 bytes, mocked startup median 7.120 ms.

The fixes add 4,011 JavaScript bytes per target over the original pilot. The increase over baseline is 100,714 bytes per target (about 63%). Startup samples vary between runs and remain measurements of a mocked Bun host.

Create Chromium packages without an existing ZIP when measuring or validating package contents. The build updates an existing ZIP and can retain stale hashed bundles. The first follow-up archive included obsolete options bundles from baseline and pilot builds. Removing the generated Chromium ZIPs before rebuilding produced the sizes recorded here. Preserve the original samples as historical evidence, but do not interpret their Chromium ZIP comparison as a clean-package comparison. JavaScript totals come from the unpackaged directories and exclude stale archive entries.

Validation after the fixes: 213 tests passed with 437 assertions across 16 files. Cancellation coverage gates save/delete before submission, during the browser mutation, during local commit, and during overwrite-sync replay. It also verifies late remote success after fatal shutdown, failed local commit after cancellation, and isolation between runner invocations. Browser failure coverage distinguishes missing folders, denied permission, unavailable APIs, and unknown payloads without exposing credentials.

Typecheck, type-aware lint, formatting, diff checks, both package builds, and all three ZIP integrity checks passed. Strict Effect diagnostics checked 34 product files with zero errors, warnings, or messages. A temporary floating Effect proof failed with `effect(floatingEffect)` and exit 1, then the developer deleted it. Firefox manifest validation still reports zero errors and the existing Android warning. Browser performance acceptance and live extension lifecycle verification remain provisional.

## Combined bookmarks and Wallabag pilot (#74)

[effect-74-pilot.json](./effect-74-pilot.json) records product commit `ada3f4cbe794239e955f959826ac171d4817c5f3`. Each target has ten raw samples from the existing procedure. The reported Bun version (1.4.3), host, timer boundaries, and mocks match the baseline records. These timings exclude process creation. They measure module import and the first response with mocked browser APIs, including startup checks. They do not measure live extension startup, OAuth request latency, or MV3 worker wake.

Firefox minified JavaScript grows from 159,942 to 292,781 bytes, and the background entry from 80,609 to 148,659 bytes. The mocked import median grows from 4.898 to 9.907 ms.

Chromium JavaScript grows from 160,053 to 292,892 bytes, and the background entry from 80,646 to 148,696 bytes. Its mocked median grows from 4.463 to 7.820 ms.

Both targets add 132,839 JavaScript bytes, about 83%. Compared with the approved #73 product at `310fe8834dd7b697e99a6d5ed2f640b3049560df`, this slice adds 31,097 bytes per target, about 12%.

Clean Firefox and Chromium Pouch ZIPs contain 96,656 and 105,715 bytes. Quick Actions remains 11,515 bytes. The generated archives were absent before packaging. All three pass CRC, duplicate-entry, exact file/byte comparison against unpackaged output, and target/version/background-manifest checks. Historical Chromium ZIPs contain stale entries, so their deltas cannot establish package growth. The raw JavaScript totals provide the baseline comparison.

Wallabag authentication, refresh, save, delete, pagination, and connection testing now use one Effect transport. Effect replaces the request retry loop, timeout timers, abort-listener waits, and refresh Promise map on these paths. Independent budgets remain explicit counters inside Effect.retry. Effect.cachedWithTTL shares complete refresh results and retains transient recovery reasons through the cooldown. Effect.sleep and a semaphore preserve account-local request spacing.

Definitive OAuth rejection permits reauthentication. Transient failures preserve tokens, including after repeated attempts. Persistence precedes publication of token and article state. The runner combines caller cancellation with the storage shutdown signal, so fatal failure interrupts active retry waits. Browser alarms continue to trigger maintenance.

The legacy HTTP client remains for the five unmigrated adapters. Wallabag's legacy class only forwards to the ready implementation. Repository initialization, sync/commit queues, and token persistence still use temporary Promise boundaries. Issues #80 and #81 own their replacement. This pilot removes the duplicate Wallabag HTTP and authentication orchestration without creating a second permanent implementation.

**Decision: accept the combined pilot for expansion to #75 through #79 after independent review.** The bundle increase is material, especially against the small baseline. The clean Pouch packages remain below 106 KB, and the added mocked import time remains about five milliseconds for Firefox and three for Chromium. Those absolute costs support continuing the migration, given typed recovery, complete shared refresh failures, bounded cancellation/timeout behavior, and fatal persistence checks. The measurement is a development-host result, so live browser performance acceptance remains open for #81. Further slices must retain these measurements and avoid unnecessary module imports or duplicate transport implementations.

Validation: 265 tests pass with 760 assertions across 17 files. The suite retains the 221 baseline tests and adds OAuth/transport, mutation-outcome, draft/active isolation, and fatal token/article/timestamp regressions.

Typecheck, type-aware lint, source and modified-test formatting, and strict Effect diagnostics pass. Diagnostics check 35 product files with zero errors, warnings, or messages. A temporary floating Effect fails diagnostics with effect(floatingEffect) and exit 1. The developer deleted that fixture. Firefox validation reports zero errors/notices and the existing Android minimum-version warning.

T3 preview opens HeadlessChrome 154.0.8037.92, but the page exposes neither browser nor chrome.runtime. The available tools provide no extension installation or Firefox control. Live extension install/startup, worker wake, permission gestures, and browser lifecycle remain unverified. Tests cover credentials isolation, request cancellation, fatal shutdown, and alarm behavior under mocks. They do not establish native browser compatibility. The permission request still runs directly from the user gesture.

## Final integration (#81)

[effect-81-final.json](./effect-81-final.json) records `main` (`4a43fd5`, before the migration), the #74 pilot (`ada3f4c`), and this branch (`096b407`). It uses the procedure above with one change: the startup mock now provides `runtime.getURL`, which the background needs for its notification icon. Other sessions kept the 1-minute load near 28 on 32 cores for over 40 minutes. The three checkouts were therefore measured interleaved in two rounds under the same load, 20 samples per target each. Compare the times relative to each other. Their absolute values are higher than the earlier low-load records.

| Build | Firefox JS / background / ZIP (bytes) | Chromium JS / background / ZIP (bytes) | Mocked startup median, Firefox / Chromium |
|---|---|---|---|
| `main` | 150,590 / 75,898 / 49,827 | 150,701 / 75,935 / 58,920 | 9.9 / 9.3 ms |
| #74 pilot | 292,781 / 148,659 / 96,656 | 292,892 / 148,696 / 105,715 | 22.4 / 17.8 ms |
| #81 final | 185,260 / 140,589 / 65,260 | 185,371 / 140,626 / 74,405 | 23.7 / 20.8 ms |

- All seven adapters fit in a smaller background than the pilot's two adapters plus the legacy HTTP client: 140.6 KB against 148.7 KB.
- The options page reads its forms from `settings-schemas.ts` and bundles no Effect code. It drops from 121.7 KB in the pilot to 21.1 KB, below the 54.1 KB on `main`.
- Total JavaScript is 23% above `main` and 37% below the pilot.
- Under the same load, mocked startup is about 1 ms (Firefox) and 3 ms (Chromium) slower than the pilot, and about 2.2 times `main`.

An earlier pair of runs at load 2.9 is not recorded here, because it overlapped this branch's test suite. It measured `main` at 4.7 / 4.3 ms and this branch at 11.0 / 9.7 ms. The recorded low-load pilot was 9.9 / 7.8 ms.

**Decision: accept.** The packaged extension is smaller than the pilot and only 23% larger than `main`. The added startup is a few milliseconds of module evaluation and the Effect runtime, under a mocked host. In real Chromium 150, the worker restarted and answered `getArticles` within the smoke run. No step waited on startup. The size and typed-recovery gains outweigh this cost. This judgment does not cover real worker-wake latency, which nobody measured.
