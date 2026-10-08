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

The temporary Promise bridges in `effect-adapter.ts`, `BookmarksAdapter`, and repository sync/commit coordination have removal tracked by #81, after #80 migrates shared coordination. Ready bookmark save/delete and connection testing already compose native Effects. The browser boundary classifies Promise rejections. Synchronous implementation exceptions, Effect defects, and interruption remain separate at the runner. Fatal writes retain the #72 shutdown latch and known remote outcome.

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

Typecheck, type-aware lint, formatting, diff checks, both package builds, and all three ZIP integrity checks passed. Strict Effect diagnostics checked 34 product files with zero errors, warnings, or messages. A temporary floating Effect proof failed with `effect(floatingEffect)` and exit 1, then was removed. Firefox manifest validation still reports zero errors and the existing Android warning. Browser performance acceptance and live extension lifecycle verification remain provisional.
