# Browser Recall — Development Guide

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- Node.js 18+ (for npm scripts, test runners)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node dependencies
npm install
```

## Building

Use one command for a complete local build:

```bash
npm run build
```

This is the canonical build command. It builds every artifact needed for manual install and testing:

- `dist/extension/` — the self-contained Chrome extension to load from `chrome://extensions/` with "Load unpacked". This is the directory Chrome must use; do not load `apps/extension/` directly.
- `dist/extension-firefox/` — the Firefox WebExtension variant. It uses the same code but stages a Firefox background module script manifest instead of Chrome's service worker manifest.
- `dist/desktop-ui/` — the staged desktop web UI consumed by Tauri. This is an intermediate build artifact, not something to install directly.
- `target/release/browser-recall-desktop` — the raw desktop executable produced by Cargo/Tauri.
- `target/release/bundle/macos/Browser Recall.app` — the macOS app bundle to launch manually after a release build.

On non-macOS platforms, Tauri writes platform-specific desktop bundle output under `target/release/bundle/`.

The canonical build intentionally does not create a DMG/installer. Installer packaging is a release-only step because macOS may open installer UI during DMG creation.

### Specialized Builds

These commands exist for focused development only. Prefer `npm run build` when preparing artifacts for manual testing.

```bash
npm run build:extension                         # stage dist/extension/ and dist/extension-firefox/
npm run build:desktop-ui                        # only stage dist/desktop-ui/
npm run build --workspace @browser-recall/desktop      # build the desktop app bundle
npm run build:dmg --workspace @browser-recall/desktop  # release-only DMG packaging
```

### Extension Icons

Place PNG icons in `apps/extension/icons/`:

- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

See `apps/extension/icons/README.md` for details.

## Loading the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `dist/extension/` directory
5. The extension appears in your toolbar

For Firefox development, open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select `dist/extension-firefox/manifest.json`.

You can also validate and launch the Firefox build with Mozilla's `web-ext`:

```bash
npx web-ext lint --source-dir dist/extension-firefox
npx web-ext run --source-dir dist/extension-firefox --firefox /path/to/firefox
```

### First Run

1. Start Browser Recall Desktop with `npm run dev:desktop`
2. Load `dist/extension/` as an unpacked extension
3. Open the extension popup and click `Refresh`
4. Approve the connection dialog in the desktop app

The extension options page is only a stub. The main UI runs in the desktop app window.

### After Code Changes

- **Extension JavaScript/HTML changes**: Reload the extension at `chrome://extensions/`
- **Desktop/Rust changes**: Rebuild or rerun the relevant Rust target, then restart that process

## Testing

### Unit Tests (Vitest)

~600 tests covering pure logic: search helpers, rule engine, utilities, sync, caching.

```bash
npm test                           # run all unit tests
npx vitest run tests/unit/utils.test.js   # run a specific file
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

Launch a temporary daemon and Chrome profile with the staged extension loaded. Nothing touches your personal browser profile.

```bash
npm run manual              # blank state
npm run manual:seed         # pre-seeded with 3 pages, 1 note
npm run manual:case <name>  # loads seeds/<name>.mjs
```

Closing the browser prints a data diff showing everything that changed during the session.

Seed cases live in `seeds/` (gitignored). Each `.mjs` file exports a function returning `{ events, entities, deviceId, settings }`. The seed builder (`scripts/lib/seed-builder.mjs`) is a manual-tool helper, not part of automated correctness coverage.

## Debugging

- **Desktop app**: run `npm run dev:desktop` and watch the Tauri / Rust logs in that terminal
- **Background service worker**: `chrome://extensions/` -> extension details -> "Inspect views: service worker"
- **Content script**: Open DevTools on any webpage and check the console
- **Popup**: Right-click the extension icon -> "Inspect popup"
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
npx jscpd apps/extension/ --min-lines 5 --min-tokens 50  # duplicated code blocks
cargo clippy --workspace --all-targets -- -D warnings        # Rust lints
```

## Replay Verification

Replays the full JSONL event log through `effectOf` and diffs the result against on-disk checkpoints. Useful for validating that the replay engine reproduces the expected state.

```bash
cargo run -q -p browser-recall-replay --bin replay-verify --                         # default output
cargo run -q -p browser-recall-replay --bin replay-verify -- --write /tmp/my-replay  # custom output dir
cargo run -q -p browser-recall-replay --bin replay-verify -- --verbose               # show all diffs (not just 5 per category)
```

## Data Schema Migration

The current desktop data layout is `logs/`, `objects/`, and `views/`. To verify migration from the legacy layout without writing files:

```bash
node scripts/migrate-browser-data-schema.mjs --root ~/browser-data --dry-run
```

Use `--apply` only after the dry run looks correct; the script writes a timestamped backup before modifying the data root.

Before replay, the script normalizes known data inconsistencies:
- Rewrites `pin_to_list` entries that reference a list by its post-rename name before the rename event
- Adjusts `create_list` timestamps when pins predate the list's creation
- Filters null urls from `pin_to_list`/`unpin_from_list` entries while preserving title alignment

Diff results are classified into three categories:
- **schema-gap** — field added/removed by code evolution (e.g. `createdAt` on old pages)
- **timing-drift** — replay and disk differ because the checkpoint was written at an intermediate state
- **data** — genuine discrepancy worth investigating

## Project Structure

```
.
├── apps/desktop/
│   ├── src-tauri/          # Tauri shell and desktop bridge
│   └── ui/                 # Main Browser Recall interface
├── apps/extension/         # Chrome connector extension
│   ├── manifest.json       # MV3 manifest
│   ├── background.js       # Connector service worker
│   ├── connector/          # Pairing, WS bridge, command buffer
│   ├── content.js          # Page capture, attention tracking
│   ├── popup.html/js       # Popup dashboard
│   ├── options-stub.html/js # Opens the desktop app
│   └── savepage/           # Save Page WE fork (HTML snapshots)
├── crates/daemon/          # Pairing, storage, search, sync transport
├── crates/replay/          # Pure event replay, entity effects, replay verifier
├── crates/search/src/lib.rs # Native search crate
├── packages/core/          # Shared JS modules during desktop split
├── tests/
│   ├── *.test.js           # Vitest unit tests
│   ├── e2e/                # Playwright E2E specs
│   ├── lib/seed-builder.mjs # Manual seed-data builder
│   └── fixtures/           # Test data files
├── scripts/                # Manual test browser + data migration helpers
├── seeds/                  # Manual test seed cases (gitignored)
├── plans/                  # Implementation plans
├── Cargo.toml              # Rust dependencies
└── package.json            # npm scripts and dev dependencies
```
