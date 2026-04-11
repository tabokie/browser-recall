# Browser Recall — Development Guide

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js 18+ (for npm scripts, test runners)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Install Node dependencies
npm install
```

## Building

### WASM Module

The Rust search engine in `src/lib.rs` compiles to WebAssembly via wasm-pack. Output goes to `extension/pkg/`.

```bash
# Production build (optimized, smaller)
npm run build

# Development build (faster compilation, larger output, debug symbols)
npm run dev
```

Under the hood these run:

```bash
wasm-pack build --target web --out-dir extension/pkg          # production
wasm-pack build --target web --out-dir extension/pkg --dev    # development
```

### Extension Icons

Place PNG icons in `extension/icons/`:

- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

See `extension/icons/README.md` for details.

## Loading the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension/` directory
5. The extension appears in your toolbar

### First Run

The extension opens the options page automatically. Click "Select Directory" to choose where to store data (e.g., `~/portal-data/`). Grant the filesystem permission when prompted.

### After Code Changes

- **Rust changes**: Rebuild WASM (`npm run build`), then reload the extension at `chrome://extensions/`
- **JavaScript/HTML changes**: Just reload the extension (click the refresh icon at `chrome://extensions/`)

## Testing

### Unit Tests (Vitest)

~600 tests covering pure logic: replay, search helpers, rule engine, utilities, sync, caching.

```bash
npm test                           # run all unit tests
npx vitest run tests/replay.test.js  # run a specific file
npx vitest                         # watch mode
```

Config: `vitest.config.js`. Tests: `tests/**/*.test.js`.

### E2E Tests (Playwright)

~331 tests covering full extension flows: history, lists, settings, sync, snapshots, recycle bin, rules, downtime.

```bash
npx playwright test                          # run all E2E tests
npx playwright test tests/e2e/lists.spec.js  # run a specific file
npx playwright test --headed                 # visible browser
```

Config: `playwright.config.js`. Tests: `tests/e2e/*.spec.js`. Single worker, chromium channel.

If tests fail with Chrome process errors:

```bash
pkill -9 -f 'Google Chrome'
```

### Playwright Browser Setup

Playwright needs a Chromium binary. Install it if you haven't:

```bash
npx playwright install chromium
```

### Manual Testing

Launch a temporary Chrome instance with the extension loaded in isolated OPFS storage. Nothing touches your personal browser profile.

```bash
npm run manual              # blank state
npm run manual:seed         # pre-seeded with 3 pages, 1 note
npm run manual:case <name>  # loads seeds/<name>.mjs
npm run manual:onboarding   # first-run onboarding flow
```

Closing the browser prints a data diff showing everything that changed during the session.

Seed cases live in `seeds/` (gitignored). Each `.mjs` file exports a function returning `{ events, entities, deviceId, settings }`. The seed builder (`tests/seed-builder.mjs`) converts event arrays to filesystem-ready file arrays.

## Debugging

- **Background service worker**: `chrome://extensions/` -> extension details -> "Inspect views: service worker"
- **Content script**: Open DevTools on any webpage and check the console
- **Popup**: Right-click the extension icon -> "Inspect popup"
- **Offscreen document**: `chrome://extensions/` -> extension details -> look for "Inspect views: offscreen.html"
- **Debug logging**: Enable in Settings -> Advanced -> Debug logging. Logs go to the service worker console via `logDebug()`.

## Formatting

```bash
npm run fmt              # format all JS/JSON files in-place
npm run fmt:check        # check formatting (CI mode, no writes)
cargo fmt                # format Rust code
cargo fmt -- --check     # check Rust formatting (CI mode)
```

## Lint & Analysis

```bash
npx knip --include files,exports,duplicates   # unused files/exports/deps
npx jscpd extension/ --min-lines 5 --min-tokens 50  # duplicated code blocks
cargo clippy --target wasm32-unknown-unknown -- -D warnings  # Rust lints
```

## Replay Verification

Replays the full JSONL event log through `effectOf` and diffs the result against on-disk checkpoints. Useful for validating that the replay engine reproduces the expected state.

```bash
npm run replay:verify                                   # default output
node scripts/replay-verify.mjs --write /tmp/my-replay   # custom output dir
node scripts/replay-verify.mjs --verbose                 # show all diffs (not just 5 per category)
```

Before replay, the script normalizes known data inconsistencies:
- Rewrites `pin_to_list` entries that reference a list by its post-rename name before the rename event
- Adjusts `create_list` timestamps when pins predate the list's creation
- Filters null items from `pin_to_list`/`unpin_from_list` entries

Diff results are classified into three categories:
- **schema-gap** — field added/removed by code evolution (e.g. `createdAt` on old pages)
- **timing-drift** — replay and disk differ because the checkpoint was written at an intermediate state
- **data** — genuine discrepancy worth investigating

## Project Structure

```
.
├── src/lib.rs              # Rust/WASM search engine
├── extension/              # Loadable Chrome extension
│   ├── manifest.json       # MV3 manifest
│   ├── background.js       # Service worker (business logic hub)
│   ├── offscreen.js        # Filesystem I/O worker (port-only)
│   ├── content.js          # Page capture, attention tracking
│   ├── popup.html/js       # Quick search + page actions
│   ├── options.html/js     # Dashboard, explore, lists, settings
│   ├── replay.js           # Event-sourced log replay (pure)
│   ├── rule-engine.js      # Rule matching (pure)
│   ├── filesystem-storage.js  # File System Access API wrapper
│   ├── entity-cache.js     # Session cache with LRU eviction
│   ├── sync-manager.js     # Sync orchestration (injected deps)
│   ├── savepage/           # Save Page WE fork (HTML snapshots)
│   └── pkg/                # Generated WASM output
├── tests/
│   ├── *.test.js           # Vitest unit tests
│   ├── e2e/                # Playwright E2E specs
│   ├── seed-builder.mjs    # Test data builder
│   └── fixtures/           # Test data files
├── scripts/                # Manual test browser + replay verification
├── seeds/                  # Manual test seed cases (gitignored)
├── plans/                  # Implementation plans
├── Cargo.toml              # Rust dependencies
└── package.json            # npm scripts and dev dependencies
```

