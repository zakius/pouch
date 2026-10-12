# Pouch Extension

A browser extension for saving articles to your favorite read-it-later service, inspired by the classic Pocket extension.

## Features

- Save articles with a single click
- Keyboard shortcuts: `Alt+Shift+P` opens the popup, `Alt+Shift+S` saves or removes the current page (customizable under Manage Extension Shortcuts)
- Browser action for quick access to your saved articles
- Dark mode support
- Page action for saving the current page
- Background sync to keep your article list up-to-date
- Support for multiple read-it-later services:
  - Browser Bookmarks
  - Instapaper
  - Karakeep
  - LinkAce
  - Linkwarden
  - Raindrop.io
  - Wallabag

## Development Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```
3. Start development server:
   ```bash
   bun run watch
   ```
4. Load the extension in Firefox:
   - Open `about:debugging`
   - Click "This Firefox"
   - Click "Load Temporary Add-on"
   - Select the `manifest.json` file from the `dist/unpackaged` directory.

## Building

To build the extension for production:

```bash
bun run package
```

The built extension will be available in the `dist/packages` directory.

### Chromium

```bash
bun run package:chromium
```

builds the same source for Chromium as two MV3 extensions in `dist/packages`:

- `pouch-chromium-<version>.zip`: Pouch, without its page action. Chromium allows one action per extension.
- `pouch-quick-actions-chromium-<version>.zip`: Pouch Quick Actions, a toolbar button that saves or removes the current page. It asks Pouch over runtime messages, so it needs Pouch.

Load both unpacked (`chrome://extensions`, developer mode, "Load unpacked" on each folder). The `key`s in their manifests fix their IDs, which the two use to find each other (`src/utils/chromium.ts`). Code that differs between the builds checks `IS_CHROMIUM`. The Chromium build has its own extension ID, so its settings start empty. Releases attach both packages.

Releases also attach both as signed `.crx` files that update themselves. To install them in an ungoogled-chromium-based browser such as Helium:

1. Download `pouch-chromium-<version>.crx` and, if you want the toolbar button, `pouch-quick-actions-chromium-<version>.crx` from the [latest release](https://github.com/zakius/pouch/releases/latest).
2. Set `chrome://flags/#extension-mime-request-handling` to "Always prompt for install".
3. Open each file in the browser, or drag it onto `chrome://extensions`.

After that, the browser updates Pouch from the release's `updates.xml` and Quick Actions from `updates-quick.xml`.

## Development

- `bun run watch` - Start development server and watch for changes.
- `bun run package` - Build for production.
- `bun run release` - Build the extension for release (no signing).
- `bun run release:sign` - Build and sign the extension for AMO (requires AMO_API_KEY and AMO_API_SECRET).
- `bun run lint` - Run oxlint (with type-aware, type-checked rules) to check code quality.
- `bun run format` - Format the source files with oxfmt.
- `bun run test` - Run the tests, each file with fresh globals and modules (`--isolate`: tests import the background script with their own `browser` mock).

## Project Structure

```
pouch-extension/
src/
├── background/     # Background scripts
├── icons/          # Extension icons
├── options/        # Options page
├── popup/          # Browser action popup
├── types/          # TypeScript type definitions
└── utils/          # Utility functions
```

## Local storage failures

If a local storage write fails, Pouch stops saves, deletes, sync, and maintenance. The popup, settings page, and browser notification show the failed operation, safe browser details, and the remote outcome when known. Do not repeat a confirmed remote save. Stopping Pouch cannot undo operations already sent to the browser or backend.

Restart the extension after fixing the storage problem. Each new background instance checks local storage reads, writes, and removal before accepting normal work. Chromium can terminate its MV3 worker and discard the in-memory failure state. Its next worker checks storage before resuming.

Pouch does not automatically retry or reconcile a remote mutation after a local failure.

## License

MIT License
