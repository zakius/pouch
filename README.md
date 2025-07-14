# Pouch Extension

A browser extension for saving articles to your favorite read-it-later service, inspired by the classic Pocket extension.

## Features

- Save articles with a single click
- Browser action for quick access to your articles
- Dark mode support
- Keyboard shortcuts for quick actions
- Page action for saving the current page
- View tags from your read-it-later service
- Reading time estimation
- Offline access to cached articles
- Background sync to keep your article list up-to-date
- Beautiful and intuitive user interface

## Development Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start development server:
   ```bash
   npm run dev
   ```
4. Load the extension in Firefox:
   - Open `about:debugging`
   - Click "This Firefox"
   - Click "Load Temporary Add-on"
   - Select the `manifest.json` file from the project directory

## Building

To build the extension for production:

```bash
npm run build
```

The built extension will be available in the `web-ext-artifacts` directory.

## Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier

## Project Structure

```
pouch-extension/
├── background/     # Background scripts
├── popup/         # Browser action popup
├── content/       # Content scripts
├── options/       # Options page
├── icons/         # Extension icons
├── assets/        # Static assets
│   └── styles/    # CSS styles
└── utils/         # Utility functions
```

## License

MIT License
