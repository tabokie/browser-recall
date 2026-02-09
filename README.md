# Portal Extension

A Chrome extension for tracking and searching your interaction history with external data sources (webpages, documents, etc.). Built with Rust (compiled to WebAssembly) for performance-critical operations and JavaScript for Chrome extension APIs.

## Architecture

- **Rust/WASM Core** (`src/lib.rs`): Search engine, ranking algorithms, data structures
- **Chrome Extension** (`extension/`): UI, browser integration, data capture
  - `background.js`: Service worker managing interactions and storage
  - `content.js`: Captures user intent, attention, and page content
  - `popup.html/js`: Search interface
  - `options.html/js`: Settings and data management

## Features

### Current Implementation

- ✅ **Interaction Tracking**: Automatically captures page visits with:
  - URL and title
  - Timestamp
  - User intent (search queries, input fields)
  - Page content (text extraction)
  - Attention patterns (scroll depth, time on page, highlights, clicks)

- ✅ **Search Engine**: Multiple ranking algorithms
  - Content-based ranking
  - Context-based ranking (temporal)
  - Lineage-based ranking (TODO: implement graph traversal)
  - Attention-based ranking (TODO: weight by engagement)
  - Hybrid ranking (TODO: combine multiple signals)

- ✅ **User Interface**:
  - Popup for quick search
  - Options page for settings and data management
  - Export/import functionality

### Roadmap (from DESIGN.md)

- [ ] **Lineage Tracking**:
  - Native hyperlink tracking
  - Temporal proximity heuristics
  - SLM confidence rating

- [ ] **Notes and Ideas**: Integration with note-taking

- [ ] **Advanced Search**:
  - Materialized views (pinned searches → topics)
  - Change subscriptions
  - Built-in categorization searches

- [ ] **Additional Portals**:
  - PDF reader with annotations
  - Text import with timestamp extraction
  - LLM chat integration

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

1. **Browse normally**: The extension automatically tracks your page visits

2. **Search your history**:
   - Click the extension icon
   - Enter a search query
   - Select a ranking algorithm (Content, Context, Lineage, Attention, Hybrid)
   - Click on results to revisit pages

3. **Review patterns**: Open the options page to see statistics and manage data

4. **Export data**: Use the options page to export your interaction history as JSON

## Project Structure

```
.
├── src/
│   └── lib.rs              # Rust/WASM core (search engine, data structures)
├── extension/
│   ├── manifest.json       # Chrome extension configuration
│   ├── background.js       # Service worker (WASM integration, storage)
│   ├── content.js          # Page interaction capture
│   ├── popup.html/js       # Search UI
│   ├── options.html/js     # Settings UI
│   └── pkg/                # Generated WASM output (git-ignored)
├── Cargo.toml              # Rust dependencies
├── package.json            # Build scripts
└── DESIGN.md               # System design document
```

## Technology Stack

- **Rust**: Core logic, search algorithms, data structures
- **WebAssembly**: Compile Rust to run in browser
- **Chrome Extension API**: Browser integration, storage, tabs
- **Vanilla JavaScript**: UI and extension logic (no frameworks for minimal size)

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
