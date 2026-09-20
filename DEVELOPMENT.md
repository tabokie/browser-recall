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
5. Open the extension details and enable **Allow access to file URLs** so snapshots opened from Browser Recall Desktop can expose their embedded identity to the connector. If the setting is disabled, the snapshot popup explains the requirement and opens the extension details page.
6. The extension appears in your toolbar

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

`npm run build:test-daemon` is the explicit prerequisite for daemon-backed
Playwright runs. The extension CI, Windows font CI, and cold-script commands
run that build before Playwright starts. Compiling inside a 30-second fixture
can fail only on a fresh runner; a prior local test run hides the problem by
warming Cargo's cache. For a focused direct `npx playwright test` invocation,
run `npm run build:test-daemon` first.

To verify the same boundary locally with an empty build cache on macOS/Linux:

```bash
CARGO_TARGET_DIR="$(mktemp -d /tmp/browser-recall-ci-cold.XXXXXX)" npm run ci:test-windows-extension-font
```

The font scenario is cross-platform despite the CI job name. The temporary
Cargo directory isolates the cold build from the normal cache; remove that
specific temporary directory after inspection. This command exercises build,
daemon launch, connector pairing, and the browser assertion without spending
a GitHub Actions run.

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
regression suites with pinned Chromium. Navigation regressions include delayed
YouTube metadata and failed delivery recovery; the full highlight-note editing
suite covers daemon title cleanup when only Timeline retains the earlier visit,
and PDF panel save/retry behavior through the real daemon. The staged
Firefox compatibility smoke suite follows those capture checks. The Windows
job separately runs the Win32-only locked-artifact replacement test before
building and launching the native smoke executable.

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

Chromium element snapshots for highlight history and the search tracer include
the measured main-panel scrollbar gutter in their filenames. macOS can use
an overlay scrollbar (0 px gutter) or a reserved scrollbar (11 px), changing
both available width and centered-sheet pixel alignment. Both Book and search
tracer scenarios explicitly set and assert each gutter, independent of system
preferences. Keep both baselines;
an unrecognized gutter produces a missing-baseline failure rather than reusing
another layout. Desktop visual CI runs on macOS 26, matching the macOS major
version used to capture the committed baselines. Run baseline generation and
verification on macOS 26 with the locked Playwright browsers. WebKit highlight
history snapshots use exact pixel matching; do not compensate for a different
macOS rendering environment by loosening one screenshot assertion at a time.

The visual suite also runs the native startup paint-check helper against a
browser that first produces a blank frame and then loads the paused desktop
surface. The same test requires a persistently blank frame to fail. The native
lifecycle smoke waits up to 15 seconds for a painted frame instead of assuming
that a native window title means the webview has loaded. On failure the native
smoke retains its screenshot, bitmap, isolated app logs, and error under
`test-results/native-lifecycle/` before cleaning up its temporary app. These
files are retained locally; the workflow does not upload them automatically.

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

Both browser-install commands use `--with-deps`. On Linux this installs
Playwright's system libraries and fonts, including CJK fonts; downloading only
the browser leaves font fallback dependent on the runner image. The CJK font
scenario checks distinct rendered glyphs before comparing platform font names,
so identical missing-glyph boxes cannot masquerade as successful rendering.
Linux dependency installation may require administrator privileges.

### Reproducing CI Environment Differences

- The Book date headings require the bundled Gentium Book Plus **bold italic**
  face. Regular and italic faces alone allowed WebKit to use an installed bold
  italic font on the developer machine while synthesizing the weight on CI.
  The Book visual scenario aliases the CSS family in served HTML/CSS so installed
  fonts cannot fill missing weights, and verifies the bold italic face loaded.
  Removing that face reproduces the original 282-pixel WebKit mismatch locally.
  Chromium runs the Book and search tracer scenarios with explicit 0- and
  11-pixel gutters so both snapshot variants are checked on every run.
  The three WOFF2 assets come from the official
  [SIL Gentium Plus 6.200 release](https://software.sil.org/gentium/download/previous-versions/)
  and use the existing `apps/desktop/ui/fonts/OFL.txt` license.
- Windows native smoke cleanup must terminate the process tree while the desktop
  parent is still alive. Killing the parent first can leave WebView2 descendants
  holding the disposable profile open. `npm run ci:test-windows-cleanup`
  includes a real Windows descendant with an exclusive file lock to exercise
  the shared teardown helper; that case is explicitly skipped on other hosts.
  Windows CI runs cleanup tests immediately after `npm ci`, before compiling
  the desktop. Executable-artifact tests still run after the build.
  The same suite checks an already-signalled process and nested read-only files
  on every host. Windows releases its test lock only after the cleanup helper
  reports an actual failed removal, then asserts that a retry occurred.
  This handshake avoids relying on a fixed sleep to overlap removal and release.
  Profile removal uses awaited `node:fs/promises.rm`: Node 24.20.0's native
  `rmSync` maps Windows permission-denied errors to `EPERM` without retrying
  them and lacks the asynchronous implementation's read-only-file handling.
  The helper owns the bounded retry loop so failed attempts can be observed.
  Persistent errors still fail and identify the child path that cannot be removed.
  Teardown attempts every process stop and profile removal even after an error;
  multiple errors are retained in an `AggregateError`, with the original smoke
  failure first and as the cause.
- macOS Rust tests and Clippy do not compile `#[cfg(target_os = "windows")]`
  branches. Before changing Windows host code, run the real Windows target
  check locally. On macOS, install the MinGW compiler and Windows Rust standard
  library once, then use:

  ```bash
  brew install mingw-w64
  rustup target add x86_64-pc-windows-gnu
  npm run check:desktop:windows
  ```

  This command stages the UI and checks every desktop target, including the
  login-item integration test, against the locked Windows dependencies. It was
  verified with Rust 1.97.0 and Homebrew MinGW-w64 14.0.0_3. It catches Windows
  type errors such as calling `into_owned()` on `winreg::RegValue.bytes`, which
  is already a `Vec<u8>`. It does not execute Windows code or validate MSVC
  linking, WebView2, registry access, or single-instance delivery; the native
  Windows job remains required. That job builds before installing browsers so
  compile errors fail early. The cross-check is an additional platform check,
  not part of the host-only `npm run ci` chain.
- `.gitattributes` keeps text checkouts LF even when Windows Git enables
  `core.autocrlf`. The pinned Vite transform mishandles a CRLF shebang in an
  imported `.mjs` script, causing Vitest to report a syntax error at the importing
  test. A disposable checkout with `core.autocrlf=true` followed by
  `npm run ci:test-windows-artifacts` exercises this import boundary on macOS too;
  the native locked-executable scenario still requires Windows. Existing Windows
  checkouts need their working files checked out again to apply the LF policy.
- The stale-receiver popup scenario forces a state revision after preparing
  the popup, keeps `getPageIdentity` delivery failing across every reread, and
  verifies recovery after the test fault is cleared. A one-shot fault allowed
  slower CI navigation to recover before the assertion and left the test reading
  hidden diagnostic markup. Run it with
  `npx playwright test tests/e2e/popup-lists.spec.js -g "receiver is stale"`.
- macOS 15 and macOS 26 are different visual baseline environments even with
  the same Playwright version. Keep the visual job and baseline host aligned;
  the workflow invariant test guards the macOS 26 runner and browser dependency
  installation commands. Matching the major version is not sufficient evidence
  that raster output matches: inspect actual and diff images before attributing
  a mismatch to the operating system or updating a baseline. The Book scenario
  uses strict soft screenshot assertions to report all six visual states in
  one failed run; its longer timeout allows those diagnostics to complete.
  Failed visual jobs retain synthetic expected, actual, and diff PNGs in the
  `desktop-visual-failure-screenshots` GitHub Actions artifact for seven days.
  Download that artifact from the failed run before considering another run.
  Linux font fallback and Windows native behavior still need their actual
  operating systems for complete verification.

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

### Documentation Screenshots

The README uses native macOS screenshots from the
real Tauri app, backed by the real daemon and a fictional reading collection.

```bash
npm run docs:screenshots
```

Run from a logged-in macOS desktop with Xcode Command Line Tools, the normal
build prerequisites, and Accessibility and Screen Recording permission for the
terminal or agent hosting the command. The command builds the desktop UI,
daemon, and a separate **Browser Recall Documentation** application. The
documentation window briefly comes to the foreground; leave the window alone
until capture finishes.

`scripts/lib/documentation-seed.mjs` owns the fixed reading data: 40 distinct
pages, six pinned pages, and nine highlights from three pages across three days.
Only two highlights have notes: a long highlight with a short note, and a short
highlight with a long note. Native capture checks that both notes and the last
highlight fit within the window. The capture command starts a temporary daemon
to obtain complete current settings, applies
the seed through the production Rust replay tool, and opens the native app with
an isolated profile. The separate compiled application identifier also isolates
Tauri's single-instance socket; a distinct executable name isolates native
keyboard targeting. Login-item and URL-handler registration are disabled for the
temporary app.

`scripts/lib/documentation-window.swift` uses macOS Accessibility to navigate
real controls and Core Graphics to capture only the app window. The capture
command uses System Events to submit the search query. Each screen must contain
the expected reading material and reach a stable rendered state before
capture succeeds. No application HTML, CSS, bridge responses, or screenshot
pixels are replaced for documentation.

The complete image set and `docs/images/capture.json` are updated only after
Timeline, Lists, Search, and Book pass in both Amber and Mono. The capture
command selects Mono through the real Settings control and verifies persistence.
The README presents each pair side by side. The capture manifest records
the source commit, seed hash, image hashes, dimensions, and capture time. Data and
requested window size are fixed; macOS may constrain the window to the display.
Relative-time labels, display scale, and OS rendering can vary between runs.
Inspect all eight PNGs before committing. On a navigation or
capture failure, inspect `test-results/documentation/`.

The command closes the temporary application and removes the temporary profile
after completion or a capture error. Existing browsing data and the regular
`dist/desktop/` app are not used for capture. `npm run test:cold-scripts` checks the
documentation seed at the real daemon/connector boundary in canonical CI; native capture is a separate macOS
maintainer command.

Capture the browser extension separately with:

```bash
npm run docs:screenshots:browser
```

The browser workflow requires a logged-in macOS desktop and the same native
capture permissions as desktop screenshots. The browser workflow uses an isolated
headed Chromium profile, the production extension with test-control hooks, and a
temporary real daemon. Install the repository's
Playwright Chromium build first with `npm run ci:install-playwright`.
`tests/e2e/documentation-browser.spec.js` serves a fictional article, seeds the
shared reading collection through Rust replay, and starts the example article
without highlights. The first screenshot shows the real toolbar popup over the
unmarked article. The second shows the live note editor after creating a single
highlight through the extension. Core Graphics captures the named browser window,
including the separate popup window. Capture includes only the isolated Chromium
process's window IDs, so overlapping applications cannot appear in exported
images. The helper tab stays in a minimized window
outside the captured browser window. Extension markup, styles, and daemon
responses are unmodified. The scenario saves the new note and checks daemon
persistence before exporting images.

The documentation scenario requests English through the browser fixture. On
macOS, a disposable launcher passes `-AppleLanguages '(en)'` to headed Chromium;
the override applies only to that process. The capture checks actual English
popup labels before exporting, and the manifest records the locale.

`scripts/capture-browser-documentation.mjs` exports both images and
`docs/images/browser-capture.json` after the scenario passes. A normal Playwright
run uses headless Chromium, keeps two content images in test artifacts, and
leaves documentation assets untouched. Inspect both browser images after
regeneration. Run native desktop capture
and browser capture separately so browser windows cannot take focus during
native input.

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

## Snapshot Identity Migration

Snapshot HTML must contain both `x-browser-recall-slug` and
`x-browser-recall-url`. Before running a build that requires this identity,
migrate the persistent snapshot corpus using the authoritative page
checkpoints:

```bash
npm run migrate:snapshot-identity -- --data-dir /absolute/path/to/browser-data --check
npm run migrate:snapshot-identity -- --data-dir /absolute/path/to/browser-data
```

The migration validates snapshot/page identities and shards, corrects obsolete
metadata, adds missing metadata, and replaces each changed HTML file atomically.
The `--check` form is read-only and exits nonzero while files remain pending.

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
