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

## Development

- `bun run watch` - Start development server and watch for changes.
- `bun run package` - Build for production.
- `bun run release` - Build the extension for release (no signing).
- `bun run release:sign` - Build and sign the extension for AMO (requires AMO_API_KEY and AMO_API_SECRET).
- `bun run lint` - Run oxlint (with type-aware, type-checked rules) to check code quality.
- `bun run format` - Format the source files with oxfmt.

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

## License

MIT License
