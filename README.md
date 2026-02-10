# Portal Extension

A Chrome extension for tracking and searching your interaction history with external data sources (webpages, documents, etc.). Built with **file-system-first architecture** - your data is always stored in human-readable files on your local machine.

## 🌟 Key Features

- **📁 File System Storage**: Human-readable JSONL files, no export needed
- **🔍 Smart Search**: WASM-powered search with multiple ranking algorithms
- **👁️ Attention Tracking**: Scroll, time, highlights, clicks
- **🎯 Intent Capture**: Search queries, navigation patterns
- **🔒 Privacy-First**: All data stays on your machine

## Architecture

**Storage**: File system as primary storage, IndexedDB as fast write buffer

- **Rust/WASM Core** (`src/lib.rs`): Search engine, ranking algorithms, data structures
- **Chrome Extension** (`extension/`): UI, browser integration, data capture
  - `background.js`: Service worker managing interactions and write buffer
  - `offscreen.js`: Filesystem I/O handler (flush buffer to files)
  - `content.js`: Captures user intent, attention, and page content
  - `popup.html/js`: Search interface (reads from filesystem)
  - `options.html/js`: Settings and storage configuration
  - `filesystem-storage.js`: File System Access API wrapper

**Data Flow**:
1. Content script captures → Background worker buffers → Offscreen flushes to files
2. Popup/Search reads from files + merges with buffer

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation.

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

3. **Configure storage location:**
   - Extension will open options page automatically
   - Click "Select Directory"
   - Choose where to store your data (e.g., `~/Documents/PortalHistory/`)
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

1. Click the extension icon
2. Enter a search query
3. Select a ranking algorithm (Content, Context, Lineage, Attention, Hybrid)
4. Click on results to revisit pages

### File Format

Your data is stored in daily JSONL files:

```
PortalHistory/
├── README.md              # Auto-generated documentation
├── 2026-02-08.jsonl      # Previous day
├── 2026-02-09.jsonl      # Today
└── 2026-02-10.jsonl      # Tomorrow
```

Each line is a complete JSON object:
```json
{"id":"...","timestamp":1707523200000,"url":"https://example.com","title":"Example","intent":"","content":"...","attention":"..."}
```

### Working with Your Data

**Command line**:
```bash
# Count interactions
wc -l *.jsonl

# Search for specific URL
grep "github.com" *.jsonl

# Extract all URLs
jq -r '.url' 2026-02-09.jsonl

# Analyze attention patterns
jq '.attention | fromjson | .scrollDepth' 2026-02-09.jsonl
```

**Python**:
```python
import json

with open('2026-02-09.jsonl', 'r') as f:
    interactions = [json.loads(line) for line in f]

# Your analysis here
```

See [FILESYSTEM_STORAGE.md](./FILESYSTEM_STORAGE.md) for more examples.

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
