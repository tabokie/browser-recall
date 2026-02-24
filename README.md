# Portal Extension

A Chrome extension for tracking and searching your interaction history with external data sources (webpages, documents, etc.). Built with **file-system-first architecture** - your data is always stored in human-readable files on your local machine.

## 🌟 Key Features

- **📁 File System Storage**: Human-readable JSONL files, no export needed
- **🔍 Smart Search**: WASM-powered search with multiple ranking algorithms
- **👁️ Attention Tracking**: Scroll, time, highlights, clicks
- **🎯 Intent Capture**: Search queries, navigation patterns
- **🔒 Privacy-First**: All data stays on your machine

## Architecture

Chrome MV3 extension with event-sourced storage. Background service worker holds business logic; offscreen document handles filesystem I/O only.

- **Rust/WASM Core** (`src/lib.rs`): Search engine, ranking algorithms
- **Chrome Extension** (`extension/`):
  - `background.js`: Service worker — all message routing, business logic, write buffer
  - `offscreen.js`: Filesystem I/O worker (port-only, minimal)
  - `content.js`: Page capture, attention tracking, highlights
  - `popup.html/js`: Quick search + page actions
  - `options.html/js`: Dashboard, explore view, settings
  - `replay.js`: Shared replay module for idempotent log replay
  - `filesystem-storage.js`: File System Access API wrapper

**Storage**: Event-sourced JSONL logs (`history/YYYY-MM-DD.jsonl`) are source of truth. Entity checkpoints (`pages/`, `lists/`, `notes/`) are derived state. Cache hierarchy: `chrome.storage.session` (hot) → `chrome.storage.local` (log buffer) → filesystem (cold).

**Data Flow**:
1. Content script captures → Background worker creates log entries → Offscreen flushes to filesystem
2. Options/Popup reads entity checkpoints + replays recent log entries

## Features

### Current Implementation

- ✅ **Interaction Tracking**: Automatically captures page visits with:
  - URL and title
  - Timestamp
  - User intent (search queries, input fields)
  - Page content (text extraction)
  - Attention patterns (scroll depth, time on page, highlights, clicks)

- ✅ **Search Engine**: WASM-powered with content and attention ranking

- ✅ **User Interface**:
  - Popup for quick search and page actions
  - Options page with dashboard, explore view, and settings

- ✅ **Notes**: Highlights extracted as first-class note entities

- ✅ **Lists**: Curated collections with query-builder explore views

- ✅ **Lineage Tracking**: Parent/child page relationships, referrer graphs

## Setup

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js (for package scripts, optional)

### Build

1. **Build the WASM module:**
   ```bash
   wasm-pack build --target web --out-dir extension/pkg
   ```

   Or use npm:
   ```bash
   npm run build
   ```

2. **Load the extension in Chrome:**
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `extension` directory

3. **Configure storage location:**
   - Extension will open options page automatically
   - Click "Select Directory"
   - Choose where to store your data (e.g., `~/portal-data/`)
   - Grant permission

### Development

Watch mode for automatic rebuilds:
```bash
wasm-pack build --target web --out-dir extension/pkg --dev --watch
```

Or:
```bash
npm run watch
```

## Usage

### Capturing Interactions

1. **Browse normally**: The extension automatically tracks your page visits
2. **Data is written immediately** to your selected directory as JSONL files
3. **No export needed**: Files are always up-to-date

### Searching

1. Click the extension icon for quick search
2. Use the options page explore view for advanced query-builder filtering

## Project Structure

```
.
├── src/
│   └── lib.rs                # Rust/WASM core (search engine)
├── extension/
│   ├── manifest.json         # Chrome MV3 manifest
│   ├── background.js         # Service worker (business logic, message routing)
│   ├── content.js            # Page capture, attention, highlights
│   ├── offscreen.js/html     # Filesystem I/O worker
│   ├── popup.html/js         # Quick search UI
│   ├── options.html/js       # Dashboard, explore, settings
│   ├── replay.js             # Event-sourced log replay
│   ├── utils.js              # Shared utilities
│   ├── filesystem-storage.js # File System Access API wrapper
│   ├── entity-cache.js       # Entity caching
│   ├── search-helpers.js     # Search utilities
│   ├── qb-tree.js            # Query builder trees
│   ├── virtual-scroller.js   # Virtual scrolling
│   ├── savepage/             # SavePage WE integration (HTML snapshots)
│   └── pkg/                  # Generated WASM output
├── scripts/                  # Data migration scripts
├── tests/                    # Vitest test suite
├── Cargo.toml                # Rust dependencies
├── package.json              # Build scripts
└── DESIGN.md                 # System design document
```

## Technology Stack

- **Rust**: Core logic, search algorithms, data structures
- **WebAssembly**: Compile Rust to run in browser
- **Chrome Extension API**: Browser integration, storage, tabs
- **File System Access API**: Direct filesystem access for data storage
- **Offscreen Documents**: Background filesystem I/O in MV3
- **Vanilla JavaScript**: UI and extension logic (no frameworks for minimal size)

## Browser Support

**File System Access API required**:
- ✅ Chrome 86+
- ✅ Edge 86+
- ❌ Firefox (not yet supported)
- ❌ Safari (not yet supported)

## Design Philosophy

Based on [DESIGN.md](./DESIGN.md):

- **Capture everything**: Intent, data, and attention at finest detail
- **Search, don't graph**: Lists over graphs to reduce cognitive load
- **Context over content**: Categorize by activity patterns, not just content
- **Lineage tracking**: Build thought process maps
- **Privacy-first**: All data stored locally

## Contributing

This is a personal project, but suggestions and ideas are welcome!

## License

MIT
