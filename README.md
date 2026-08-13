# Browser Recall

Browser Recall is a desktop-first browsing memory app: a Tauri desktop app and daemon own the data, UI, and sync, while the browser extension acts as a connector for capture and popup actions.

## Key Features

- **Desktop-First UI** — timeline, search, lists, recycle bin, settings, and sync live in the desktop app
- **Local File Storage** — JSONL and JSON checkpoints on disk, readable by any tool
- **Smart Search** — local search across history, notes, and snapshots
- **Attention Tracking** — scroll depth, time on page, highlights, clicks
- **Notes & Highlights** — inline text highlights extracted as first-class note entities
- **Lists** — curated collections with keyword and function rule auto-pinning
- **Snapshots** — self-contained HTML archives of any page (via Save Page WE)
- **Multi-Device Sync** — optional sync via your own GitHub repository
- **Privacy-First** — all data stays on your machine, no telemetry, no server

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- Node.js 24+

### Build & Load

```bash
npm install
```

Start the desktop app:

```bash
npm run dev:desktop
```

Then load the extension in Chrome:

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Run `npm run build:extension`
4. Click "Load unpacked" and select the `dist/extension/chrome/` directory
5. Open the popup and use `Refresh`
6. Approve the native connection prompt in Browser Recall Desktop

`npm run build:extension` also stages a Firefox development build at `dist/extension/firefox/`. Load it from `about:debugging#/runtime/this-firefox` with "Load Temporary Add-on" and select its `manifest.json`.

The extension's options page is now only a stub that opens the desktop app. The main product UI is in `apps/desktop/ui/`.

`Launch at login` supports Windows, Linux, and macOS 13+. macOS uses
`SMAppService`; the project does not carry legacy `LSSharedFileList` support.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed setup, testing, and debugging instructions.

## Architecture

The desktop app owns the main UI, local storage directory, daemon lifecycle, and GitHub sync. The connector extension owns capture, popup actions, pairing, and event buffering when the desktop app is temporarily unavailable.

- `apps/desktop/src-tauri/` — Tauri shell, deep links, tray, pairing approval, desktop bridge commands
- `apps/desktop/ui/` — main Browser Recall interface
- `crates/daemon/` — pairing, storage, WebSocket bridge, search, sync transport
- `apps/extension/` — WebExtension connector: Chrome service worker or Firefox background module script, popup, content capture, `connector/` bridge
- `crates/replay/` — pure event replay and entity effects

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full technical deep-dive.

## Documentation


| Document                             | Description                                      |
| ------------------------------------ | ------------------------------------------------ |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Entity storage, caching, replay, sync, deletion  |
| [CODEBASE_MAP.md](./docs/CODEBASE_MAP.md) | File index, message routing, feature-to-code map |
| [DEVELOPMENT.md](./DEVELOPMENT.md)   | Building, testing, and debugging                  |
| [PRIVACY.md](./docs/PRIVACY.md)      | Privacy policy                                   |


## Technology Stack

- **Rust + JavaScript** — replay, daemon, and local search logic
- **WebExtension MV3** — connector, popup, content capture
- **Tauri + Tokio** — desktop shell and local daemon runtime
- **Vanilla JavaScript** — no frameworks, minimal extension size
- **Playwright + Vitest** — E2E and unit test suites

## Browser Support

The connector is packaged for Chromium and Firefox:

- Chrome
- Edge
- Orion, by loading `dist/extension/chrome` as a Chrome extension
- Firefox, by loading `dist/extension/firefox`

Orion runs through its Chrome-extension compatibility surface and therefore
uses Browser Recall's Chromium adapter and compatibility paths.

The desktop app is required for normal use.

## License

MIT
