# Browser Recall — Development Guide

## Prerequisites

- [Rust](https://rustup.rs/) via `rustup`; the repository pins Rust 1.97.0 in
  `rust-toolchain.toml`, and GitHub CI uses the same version
- Node.js 24+ (for npm scripts, test runners)
- `cargo-llvm-cov` 0.8.5 (for the coverage workflow included in full CI)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Node dependencies
npm install

# Install the pinned Rust coverage command
cargo install cargo-llvm-cov --version 0.8.5 --locked
```

## Building

Use one command for a complete local build:

```bash
npm run build
```

This is the canonical build command. It builds every artifact needed for manual install and testing:

- `dist/extension/chrome/` — the self-contained Chrome extension to load from `chrome://extensions/` with "Load unpacked". This is the directory Chrome must use; do not load `apps/extension/` directly.
- `dist/extension/firefox/` — the Firefox WebExtension variant. It uses the same code but stages a Firefox background module script manifest instead of Chrome's service worker manifest.
- `dist/desktop/ui/` — the staged desktop web UI consumed by Tauri. This is an intermediate build artifact, not something to install directly.
- `dist/desktop/<platform>/bin/` — the raw desktop executable copied from Cargo/Tauri release output when the desktop app is built.
- `dist/desktop/<platform>/app/`, `dist/desktop/<platform>/dmg/`, and other bundle-type folders — desktop app bundles collected from Tauri release output.

Tauri still uses `target/` internally as a Rust build cache, but release artifacts that users need are collected under `dist/`.

Artifact collection stages a complete platform tree before replacing
`dist/desktop/<platform>/`. On Windows this allows `npm run build` to finish
while a previously collected executable is still running: the executable is
retired and the staged executable is installed inside the stable platform
directory, which WebView2 may keep locked as a whole, before stale
non-executable output is replaced by the staged remainder. If any promotion
step fails, the collector restores the complete prior executable and remainder
tree before reporting the failure. If Windows retains the renamed old
executable until its process exits, the collector explicitly reports that the
new executable was installed successfully, explains that closing the window
only hides the app, and reports the retained old file separately. Quit Browser
Recall from its tray menu to release that file; the next build retries cleanup
automatically.

The canonical build intentionally does not create an installer. It produces an
`.app` bundle on macOS and the raw desktop executable on other platforms.
Installer packaging is a release-only step because macOS may open installer UI
during DMG creation.

On macOS, the canonical desktop build signs the complete `.app` bundle and then runs `scripts/verify-macos-app-bundle.mjs`. Local builds use Tauri's ad-hoc `-` identity so `Info.plist` and resources are bound instead of leaving only the linker-signed executable; `scripts/finalize-macos-app-bundle.mjs` replaces the per-build CDHash designated requirement with the stable bundle identifier. `scripts/build-tauri-app.mjs` classifies Tauri's missing-notarization-credentials message as expected local-build information while preserving every other warning; distribution builds still show and enforce notarization failures. This stabilizes local OS identity but does not authenticate a publisher. If an Apple Development or Developer ID Application certificate is installed, set `APPLE_SIGNING_IDENTITY` to the identity reported by `security find-identity -v -p codesigning`; Tauri gives that environment variable precedence and the local ad-hoc finalization is skipped. DMG builds fail before bundling unless this Apple identity is present, and distribution also requires notarization.

### Specialized Builds

These commands exist for focused development only. Prefer `npm run build` when preparing artifacts for manual testing.

```bash
npm run build:extension                         # stage dist/extension/chrome/ and dist/extension/firefox/
npm run build:desktop-ui                        # only stage dist/desktop/ui/
npm run build --workspace @browser-recall/desktop      # build the desktop app bundle
npm run build:dmg --workspace @browser-recall/desktop  # release-only DMG packaging
```

### Extension Icons

Place PNG icons in `apps/extension/icons/`:

- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

See `apps/extension/icons/README.md` for details.

### Desktop Icons

Desktop and extension raster assets are generated from the root SVG sources:

```bash
npm run generate:icons
```

The command is cross-platform. It renders every desktop slot directly at its
native target size so already-antialiased SVG edges are not softened by a
second downsampling pass. The Windows `.ico` includes 16, 20, 24, 28, 32, 36,
40, 48, 56, 64, 72, 80, 96, 112, 128, and 256 px representations for standard
shell DPI variants. At runtime, the Windows desktop assigns matching small and
large representations to its HWND and refreshes them after monitor DPI changes.
The macOS `.icns` includes every standard and Retina PNG-backed slot without
requiring `iconutil`. Extension toolbar slots retain their separately tuned
supersampling pipeline. Commit the regenerated assets with any source icon
change. Tauri's build script watches the desktop PNG, ICO, and ICNS files so
the executable and app bundle are re-embedded after regeneration.

## Loading the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `dist/extension/chrome/` directory
5. The extension appears in your toolbar

For Firefox development, open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select `dist/extension/firefox/manifest.json`.

You can also validate and launch the Firefox build with Mozilla's `web-ext`:

```bash
npx web-ext lint --source-dir dist/extension/firefox
npx web-ext run --source-dir dist/extension/firefox --firefox /path/to/firefox
```

### First Run

1. Start Browser Recall Desktop with `npm run dev:desktop`
2. Load `dist/extension/chrome/` as an unpacked extension
3. Open the extension popup and click `Refresh`
4. Approve the connection dialog in the desktop app

The extension options page is only a stub. The main UI runs in the desktop app window.

### After Code Changes

- **Extension JavaScript/HTML changes**: Reload the extension at `chrome://extensions/`
- **Desktop/Rust changes**: Rebuild or rerun the relevant Rust target, then restart that process

## Testing

### Full Local CI

Run the complete cross-platform CI test and lint chain locally with:

```bash
npm run ci
```

GitHub's locally safe jobs delegate to the same `ci:*` package scripts, so local
and hosted verification cannot drift into different command sets. The native
macOS lifecycle and Windows single-instance jobs are explicit exceptions: they
require their platform-specific environments described below and are not part
of `npm run ci`. Run the complete local chain before committing and the relevant
native smoke on its required platform when those paths change.

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
npm run test:visual                          # build UI; run native WKWebView, Chromium, and tagged WebKit visual checks
```

Config: `playwright.config.js`. Tests: `tests/e2e/*.spec.js`. Runs use one worker; Chromium is the default channel, and the tagged desktop visual pass selects WebKit explicitly.

Hosted CI also runs `npm run ci:test-extension-e2e`, covering the popup,
snapshot-highlight, snapshot resource/shadow-DOM, and actual platform-font
regression suites with pinned Chromium, followed by the staged Firefox
compatibility smoke suite. The Windows job separately runs the Win32-only
locked-artifact replacement test before building and launching the native smoke
executable.

Two opt-in local smokes cross native browser boundaries that headless
Playwright cannot: `npm run test:shortcut:native` launches a disposable headed
Chromium profile on macOS and sends a system Option+R event, while
`npm run test:firefox:real` launches the staged Firefox artifact through the
pinned `web-ext@10.5.0` runner and verifies Firefox's actual content-script API
shape. The latter uses `FIREFOX_BINARY` when set and otherwise uses the standard
macOS Firefox path.

Canonical local and hosted runs use Playwright's pinned Chromium. When that
browser has not yet been downloaded but stable Google Chrome is installed, a
focused desktop-only run can explicitly select the system Chrome channel:

```powershell
$env:BROWSER_RECALL_PLAYWRIGHT_ENGINE = 'chrome'
npx playwright test tests/e2e/desktop-visual.spec.js --grep "settings renders nullable profiles"
Remove-Item Env:BROWSER_RECALL_PLAYWRIGHT_ENGINE
```

This opt-in changes only the local browser executable; CI continues to install
and run the pinned Chromium build. Chrome-branded builds 137 and newer reject
command-line loading of unpacked extensions, so do not use the `chrome` channel
for extension E2E. On Windows, installed Edge remains a valid local Chromium
extension runner when the pinned browser cannot be downloaded:

```powershell
$env:BROWSER_RECALL_PLAYWRIGHT_ENGINE = 'msedge'
npx playwright test tests/e2e/extension-font-fallback.spec.js
Remove-Item Env:BROWSER_RECALL_PLAYWRIGHT_ENGINE
```

`npm run test:visual` is the canonical desktop visual check. It first stages
`dist/desktop/ui/`, runs a native macOS WKWebView chart-layout probe when on
macOS, runs the full `tests/e2e/desktop-visual.spec.js` suite in Chromium, then
runs its `@webkit` cases against WebKit. The native probe loads the staged
production CSS and verifies that highlighting a chart bar cannot move the page
list; it skips on non-macOS hosts. Install both browsers with
`npm run ci:install-desktop-visual-browsers`.

The native macOS lifecycle test registers a real status item and must never run in a persistent personal login session. Run it only in an ephemeral macOS user or disposable CI runner:

```bash
BROWSER_RECALL_ISOLATED_MACOS_SESSION=1 npm run test:desktop-native
```

It verifies the actual bundle, painted startup-error reporting, repaired-storage relaunch, accessible tray placement/menu activation, repeated reopening, focus, and frame preservation. Playwright separately covers visible Resume command wiring, while Rust exercises the real absent-daemon repair-and-restart boundary and concurrent start serialization. The smoke test unregisters its test app before deleting the temporary bundle, but the ephemeral-session requirement remains because Control Center can retain status-item ownership state independently of Launch Services. GitHub CI runs this scenario on a fresh macOS 26 VM so the native test covers the Control Center generation where the regression occurred without polluting a developer login session.

Windows has a separate native single-instance smoke test. Build the desktop app,
close any running Browser Recall instance, then run:

```powershell
npm run test:desktop-single-instance
```

It launches the real executable twice, verifies that the second process exits,
and waits for the original process to log the forwarded
`browser-recall://settings` route. Before launch it also uses the native Win32
icon API to verify that every generated ICO representation is embedded in the
executable pixel-for-pixel, then inspects the running HWND to require native
DPI-sized small and taskbar icons. The processes use disposable configuration,
log, and WebView2 profiles and suppress protocol and launch-at-login
registration, so the smoke does not read product data, start sync, reuse the
installed app's browser state, or replace the user's OS registrations. The
production single-instance identifier is still exercised,
so a running Browser Recall process must be closed first. Run the resource-only
icon check without stopping an existing desktop process with
`node tests/smoke/windows-desktop-single-instance.mjs --icons-only`. Hosted CI
runs the complete smoke test on `windows-latest`.

When running under a filesystem/process sandbox, Chromium launch may require an unsandboxed command approval. If every visual test fails at `0ms` with `browserType.launch: Target page, context or browser has been closed`, `SIGABRT`, or `kill EPERM`, rerun the same command with browser-launch permissions instead of changing the tests or package script. A focused `npx playwright test ... -g "<name>"` run can pass while the sandboxed npm visual script fails, because the failure is at browser launch before any test code runs.

If tests fail with Chrome process errors:

```bash
pkill -9 -f 'Google Chrome'
```

### Playwright Browser Setup

Playwright needs a Chromium binary. Install it if you haven't:

```bash
npm run ci:install-playwright
```

### Coverage Monitor

Use the coverage monitor to find uncovered production lines worth reviewing and to track the long-term test investment mix:

```bash
npm run coverage:js       # generate per-line JS coverage data for stable JS tests
npm run coverage:rust     # generate Rust llvm-cov coverage data for the workspace
npm run coverage:monitor  # print uncovered line ranges and suite LoC mix
npm run coverage          # run JS coverage, Rust coverage, then the monitor
```

`coverage:rust` uses the pinned `cargo-llvm-cov` prerequisite above and stages the desktop UI required by Tauri's compile-time context before covering all workspace targets. Coverage percentages are context, not a target. The useful output is the uncovered file/line list from the stable JS coverage source plus Rust llvm-cov missing-line output: review those gaps and decide whether they represent real user workflows that deserve E2E or daemon integration coverage. `coverage:monitor` also enforces the E2E-first policy by keeping JS unit and inline Rust unit LoC at or below their current baselines unless `ALLOW_UNIT_TEST_GROWTH=1` is set for an explicit architecture exception.

GitHub CI's **Cold Script Smoke** job runs the coverage workflow and a daemon-backed Playwright check of the manual seeded-data helper. `npm run test:cold-scripts` builds the daemon before Playwright starts so a cold Rust compile does not consume the fixture's daemon-startup timeout. Run that focused local check after installing Playwright Chromium.

### Manual Testing

Launch a temporary daemon and Chrome profile with the staged extension loaded. Nothing touches your personal browser profile.

```bash
npm run manual              # blank state
npm run manual:seed         # pre-seeded with 3 pages, 1 note
npm run manual:case <name>  # loads seeds/<name>.mjs
```

Closing the browser prints a data diff showing everything that changed during the session.

Seed cases live in `seeds/` (gitignored). Each `.mjs` file exports a function returning `{ events, entities, deviceId, settings }`. The seed builder (`scripts/lib/seed-builder.mjs`) is shared by manual tooling and the daemon-backed cold-script E2E workflow.

## Debugging

- **Desktop app**: run `npm run dev:desktop` and watch the Tauri / Rust logs in that terminal
- **Background service worker**: `chrome://extensions/` -> extension details -> "Inspect views: service worker"
- **Content script**: Open DevTools on any webpage and check the console
- **Popup**: Right-click the extension icon -> "Inspect popup"
- **Debug logging**: Enable in Settings -> Advanced -> Debug logging. Logs go to the service worker console via `logDebug()`.

## Adding a Locale

Add the locale code, native display name, and any system-locale aliases to
`SUPPORTED_LOCALES` in `packages/core/i18n.js`, then add a complete
`packages/core/locales/<code>/messages.json` catalog. Run
`npm run locales:check`; extension and desktop builds run the same validation
before staging. Catalogs must preserve keys, placeholders, HTML tags,
`<code>`/`<kbd>` contents, product names, browser names, shortcuts, and other
protected technical terms from English.

## Formatting

```bash
npm run fmt              # format all JS/JSON files in-place
npm run fmt:check        # check formatting (CI mode, no writes)
cargo fmt                # format Rust code
cargo fmt -- --check     # check Rust formatting (CI mode)
```

## Lint & Analysis

```bash
npm run lint:unused      # unused files/exports/deps
npm run lint:duplicates  # duplicated code blocks
cargo clippy --workspace --all-targets -- -D warnings  # Rust lints
```

## Replay Verification

Replays the full JSONL event log through `effectOf` and diffs the result against on-disk checkpoints. Useful for validating that the replay engine reproduces the expected state.
Existing note objects are used as replay base state only when no log event references them. Notes with log history are rebuilt from those events so tombstone idempotence does not hide their related replay effects. Differences caused by selective checkpoint timing, including an earlier `createdAt` recovered from visit logs, are reported separately from genuine data discrepancies.

```bash
cargo run -q -p browser-recall-replay --bin replay-verify --                         # default output
cargo run -q -p browser-recall-replay --bin replay-verify -- --write /tmp/my-replay  # custom output dir
cargo run -q -p browser-recall-replay --bin replay-verify -- --verbose               # show all diffs (not just 5 per category)
```

## Project Structure

```
.
├── apps/desktop/
│   ├── src-tauri/          # Tauri shell and desktop bridge
│   └── ui/                 # Main Browser Recall interface
├── apps/extension/         # Chromium/Firefox connector extension
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
