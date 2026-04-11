# Browser Recall

A Chrome extension that captures your browsing history, attention patterns, highlights, notes, and snapshots into human-readable files on your local machine. Your data never leaves your computer.

## Key Features

- **File System Storage** — JSONL files on disk, no export needed, readable by any tool
- **Smart Search** — WASM-powered search across history, notes, and snapshots with multiple ranking algorithms
- **Attention Tracking** — scroll depth, time on page, highlights, clicks
- **Notes & Highlights** — inline text highlights extracted as first-class note entities
- **Lists** — curated collections with keyword and function rule auto-pinning
- **Snapshots** — self-contained HTML archives of any page (via Save Page WE)
- **Multi-Device Sync** — optional sync via your own GitHub repository
- **Privacy-First** — all data stays on your machine, no telemetry, no server

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js 18+

### Build & Load

```bash
npm install
npm run build
```

Then load the extension in Chrome:

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory
4. Click "Select Directory" in the options page to choose your data folder

See [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed setup, testing, and debugging instructions.

## Architecture

Chrome MV3 extension with event-sourced storage. The JSONL log is the source of truth; entity files are derived checkpoints.

- **background.js** — service worker, business logic hub, event-sourced log buffer
- **offscreen.js** — filesystem I/O via File System Access API (port-only)
- **content.js** — page capture, attention tracking, highlights
- **popup.js** — quick search and page actions per tab
- **options.js** — dashboard with explore view, lists, settings
- **replay.js** — idempotent event replay (pure, no Chrome APIs)
- **src/lib.rs** — Rust search engine compiled to WASM

Data flow: content script captures -> background creates log entries -> offscreen flushes to filesystem. UI pages read entity checkpoints and replay recent log entries.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical deep-dive.

## Documentation


| Document                             | Description                                      |
| ------------------------------------ | ------------------------------------------------ |
| [DESIGN.md](./DESIGN.md)             | Product philosophy and design rationale          |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Entity storage, caching, replay, sync, deletion  |
| [CODEBASE_MAP.md](./CODEBASE_MAP.md) | File index, message routing, feature-to-code map |
| [DEVELOPMENT.md](./DEVELOPMENT.md)   | Building, testing, debugging, migration scripts  |
| [PRIVACY.md](./PRIVACY.md)           | Privacy policy                                   |


## Technology Stack

- **Rust / WebAssembly** — search engine with ranking algorithms
- **Chrome Extension MV3** — service worker, offscreen documents, tabs, storage APIs
- **File System Access API** — direct filesystem read/write from the browser
- **Vanilla JavaScript** — no frameworks, minimal extension size
- **Playwright + Vitest** — E2E and unit test suites

## Browser Support

Requires File System Access API:

- Chrome 86+
- Edge 86+
- Firefox and Safari are not supported (no File System Access API)

## License

MIT