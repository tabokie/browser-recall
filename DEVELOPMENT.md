# Browser Recall — Development

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Browser Recall works and
[CODEBASE_MAP.md](docs/CODEBASE_MAP.md) for where features are implemented.

## Prerequisites

- Node.js 24+ and npm dependencies from `package-lock.json`.
- Rust 1.97.0 with Rustfmt, Clippy, and LLVM tools, pinned in `rust-toolchain.toml`.
- Platform build tools: Xcode Command Line Tools on macOS, MSVC/WebView2 on Windows,
  or Tauri's Linux system dependencies listed in `.github/workflows/ci.yml`.
- `cargo-llvm-cov` 0.8.5 for the full coverage/CI workflow.

```bash
npm ci
cargo install cargo-llvm-cov --version 0.8.5 --locked
npm run ci:install-playwright
npm run ci:install-desktop-visual-browsers
```

Playwright installation includes Linux system libraries and fonts through
`--with-deps`; Linux installation may require administrator privileges.

## Build and run

```bash
npm run build
```

`npm run build` prepares the Chromium and Firefox extensions and builds the desktop
app. Load an extension from `dist/extension/`, not `apps/extension/`.

| Output | Use |
| --- | --- |
| `dist/extension/chrome/` | Chrome/Chromium unpacked extension |
| `dist/extension/firefox/` | Firefox temporary add-on |
| `dist/desktop/ui/` | Desktop HTML, JavaScript, CSS, and fonts used by Tauri |
| `dist/desktop/<platform>/bin/` | Desktop executable |
| `dist/desktop/macos/app/` | macOS app bundle |
| `dist/desktop/<platform>/<bundle>/` | Release-only installer outputs |

Cargo and Tauri keep build files in `target/`. After a successful build, the build
scripts replace the platform's output directory in `dist/desktop/`. If replacement
fails, the scripts restore the previous output.

Windows builds can replace the output while an earlier Browser Recall process
still runs. Windows may prevent deletion of the executable used by that process.
The build reports undeleted files and retries cleanup on the next build. Quit
Browser Recall from the tray menu to release the executable.

### Focused commands

```bash
npm run build:extension
npm run build:desktop-ui
npm run build --workspace @browser-recall/desktop
npm run dev:desktop
```

`npm run build` produces a macOS `.app` and executables on other platforms.
Installer packaging is a separate release step:

```bash
npm run build:dmg --workspace @browser-recall/desktop
```

macOS local builds use ad-hoc signing, which does not require an Apple certificate.
The signature uses a stable app identifier, and the build verifies the complete
bundle. Set `APPLE_SIGNING_IDENTITY` to an installed Apple signing identity for
certificate signing. DMG builds require an Apple signing identity; distribution
also requires notarization credentials.

### Connect the browser

1. Start Browser Recall and complete folder/device setup.
2. In `chrome://extensions/`, enable Developer mode and load
   `dist/extension/chrome/`.
3. Open the popup, click Refresh, and approve pairing in the desktop app.
4. Enable **Allow access to file URLs** in extension details for desktop-opened
   file snapshots.

Firefox development uses `about:debugging#/runtime/this-firefox` and
`dist/extension/firefox/manifest.json`. The extension options page directs users to
the desktop app.

After extension changes, rebuild the extension and reload the extension. After
Rust changes, rebuild and restart the relevant desktop or daemon process.

### Icons and locales

`npm run generate:icons` renders root SVG sources into desktop ICO/ICNS slots,
extension icons, and tray assets. Inspect actual target sizes and commit generated
assets with source changes.

Add locales to `SUPPORTED_LOCALES` in `packages/core/i18n.js` and create a complete
`packages/core/locales/<code>/messages.json`. Run `npm run locales:check`.
Builds check that every translation has the required keys, placeholders, and HTML,
and preserves keyboard shortcuts, code, and product and technical names.

## Verification

Run focused checks during development. Run `npm run ci` before committing.
Local checks and GitHub Actions use the same `ci:*` package scripts. Tests of native
windows, tray actions, and process startup run separately.

| Command | Scope |
| --- | --- |
| `npm test` | Vitest unit and integration suites |
| `npm run test:integration` | JavaScript integration suites |
| `npm run build:test-daemon` | Build the daemon before Playwright tests that use the daemon |
| `npm run test:e2e` | Playwright workflows |
| `npm run test:visual` | Build UI assets; run native WKWebView, Chromium, and selected WebKit tests |
| `npm run ci:test-rust` | Build UI assets and run Rust workspace tests |
| `npm run test:cold-scripts` | Run manual test-data generation against the daemon |
| `npm run coverage` | JavaScript/Rust coverage and uncovered-line monitor |
| `npm run ci` | Documentation check, tests, browser installation, coverage, and lint |

Focused examples:

```bash
npx vitest run tests/integration/page-identity-parity.test.js
npm run build:test-daemon
npx playwright test tests/e2e/popup-lists.spec.js
npx playwright test tests/e2e/desktop-visual.spec.js --grep 'scroll'
cargo test -p browser-recall-daemon --test read_projections
```

Playwright uses one worker and the Chromium version installed by Playwright. Build
the daemon before starting tests that use the daemon; compiling Rust during test
setup can exceed the startup timeout. To test a build without cached Rust output,
set `CARGO_TARGET_DIR` to a temporary directory and run the same `ci:*` command.

### Product coverage

Test desktop and extension changes through Playwright user scenarios. Connect the
extension to a real daemon when possible. Use Rust integration tests for daemon
commands and native app behavior that Playwright cannot exercise.

When existing tests miss a bug, add the missing scenario and confirm the test fails
before fixing the code. Tests for missing permissions or failed message delivery
must cause those failures. Tests that generate random data must use a fixed random
seed so a failure can be reproduced.

`coverage:monitor` reports untested production lines and counts test lines. Use
coverage to find missing scenarios rather than chase a percentage. Adding JavaScript
unit-test lines or inline Rust unit-test lines requires an explicit architecture
exception using `ALLOW_UNIT_TEST_GROWTH=1`.

### Desktop visual baselines

`npm run test:visual` runs the native macOS WKWebView chart-layout probe, all
Chromium desktop visual tests, and `@webkit` cases. The native probe skips on
other operating systems. Desktop visual tests replace Tauri calls with test
responses. Separate Rust and native tests check the real desktop integration.

Generate and verify reference screenshots on macOS 26 with the Playwright browser
versions in the lockfile. Book and search-tracer tests cover scrollbars that overlay
content and scrollbars that reserve 11 px of space. Keep reference screenshots for
both layouts. WebKit Book screenshots use exact matching;
inspect differences before changing baselines or tolerances.

The Book test renames the bundled Gentium Book Plus family to expose missing
font weights. System-font tests check that Chinese, Japanese, and Korean characters
render distinctly before comparing font families. Failed GitHub Actions runs keep expected, actual, and difference PNGs
for seven days.

If every visual test fails before execution with `browserType.launch`, `SIGABRT`,
or `kill EPERM`, rerun the same command with browser-launch permissions. A sandbox
launch failure does not justify changing product code or assertions.

### Native platform checks

The macOS window lifecycle test registers a real tray item. Run the test only in a
temporary macOS login session or disposable CI runner:

```bash
BROWSER_RECALL_ISOLATED_MACOS_SESSION=1 npm run test:desktop-native
```

The macOS window lifecycle test checks visible startup errors, relaunch after
storage repair, tray activation, window reopening, focus, and saved window size and
position. Failure screenshots and logs remain under
`test-results/native-lifecycle/` before the temporary app is removed.

On Windows, close any running Browser Recall process before the single-instance
test:

```powershell
npm run test:desktop-single-instance
```

The Windows single-instance test uses temporary configuration and WebView2 profiles,
verifies executable and window icons at different display scales, and checks deep
links passed from a second process to the first. Run the
icon check without closing the app:

```bash
node tests/smoke/windows-desktop-single-instance.mjs --icons-only
```

`npm run ci:test-windows-cleanup` checks test cleanup. Windows cleanup must stop
the app and child processes before deleting profiles. Files that remain locked or
cannot be deleted cause the test to fail. Windows CI builds before browser setup.

Tests on macOS and Linux do not compile Rust code restricted to Windows. For the additional
Windows GNU type check, install MinGW and the Rust target:

```bash
rustup target add x86_64-pc-windows-gnu
npm run check:desktop:windows
```

On macOS, MinGW is available through `brew install mingw-w64`. The cross-check
builds UI assets and checks all desktop targets; Windows CI still verifies
MSVC linking and runtime behavior. `.gitattributes` keeps imported script shebangs
LF across operating systems.

### Browser-specific tests

```bash
npm run test:firefox:smoke
npm run test:firefox:real
npm run test:shortcut:native
```

`test:firefox:real` uses `web-ext@10.5.0` and the browser specified by `FIREFOX_BINARY`
when provided. `test:shortcut:native` sends Option+R to a temporary Chromium window
on macOS.

Focused local desktop tests may set `BROWSER_RECALL_PLAYWRIGHT_ENGINE=chrome`
when pinned Chromium is unavailable. Extension tests require pinned Chromium or
an explicit `msedge` channel; Chrome-branded builds reject command-line unpacked
extension loading. The `ci:*` scripts always use the pinned browsers.

## Manual testing and debugging

```bash
npm run manual
npm run manual:seed
npm run manual:case -- <name>
```

Manual testing starts a temporary daemon and browser profile, then prints changes
to stored data after the browser closes. Test-data scripts in gitignored
`seeds/<name>.mjs` return `events`, `entities`, `deviceId`, and `settings`. Test-data
generation starts with complete current daemon settings, applies setting events,
then explicit overrides.

| Component | Where to inspect |
| --- | --- |
| Desktop | `npm run dev:desktop` terminal and native logs |
| Background worker | Extension details → Inspect service worker |
| Content script | Page DevTools console |
| Popup | Inspect popup |
| Runtime diagnostics | Settings → Advanced → Debug logging; resets on restart |

Stop only the temporary process associated with a failed test. Inspect test setup
errors and logs before retrying browser setup.

## Check stored data

`replay-verify` checks whether saved JSON files agree with the event logs.
The replay verifier applies log entries using the same Rust code as the daemon,
then compares the rebuilt data with the files on disk. Set `recall_data_dir` to
the folder chosen during desktop setup:

```bash
recall_data_dir="/absolute/path/to/chosen-data-folder"
recall_replay_dir="$(mktemp -d)"
cargo run -q -p browser-recall-replay --bin replay-verify -- \
  --data-dir "$recall_data_dir" --write "$recall_replay_dir" --verbose
```

The verifier does not read the desktop app's folder setting. Without `--data-dir`,
the verifier reads `~/browser-data`.

Every run writes rebuilt data and replaces the output directory, including any
existing contents. `--write` selects the output directory; omitting `--write` uses
`/tmp/browser-replay`. The example creates a disposable directory. Never use the
data folder as the output directory.

Notes mentioned in the logs are rebuilt from the logs. Note files with no matching
log entries are loaded directly because the logs cannot reconstruct those notes.

The report uses three labels for differences:

- `schema-gap`: fields added or removed as the data format changed.
- `timing-drift`: differences in fields such as timestamps, time on page, or pin
  order that the verifier allows to differ between saved files and rebuilt data.
- `data`: other differences that need investigation.

The labels classify differences by field; the labels do not establish the cause.
Use `--verbose` to inspect the values. The report also lists records found only in
the rebuilt data or only on disk.

## Documentation screenshots

Documentation capture is a manual macOS workflow. Both commands require a logged-in
macOS desktop, Xcode Command Line Tools, Accessibility permission, Screen Recording
permission, and the Chromium version installed by Playwright.

```bash
npm run docs:screenshots
npm run docs:screenshots:browser
```

Run desktop and browser capture separately so native focus does not interfere.
Capture uses separate test app identifiers, browser profiles, fictional data, and a real
daemon. The regular app and personal browsing data are not used. Leave capture
windows alone until completion.

| Capture | Layout | PNG output |
| --- | --- | --- |
| Timeline, Amber and Mono | 960 × 500 points | 1920 × 1000 pixels |
| Book, Amber | 960 × 620 points | 1920 × 1240 pixels |
| Browser popup and highlight editor | 800 × 434 points | 1600 × 868 pixels |

The capture scripts operate the real app and browser. The scripts check content,
window dimensions, language, and whether rendering has finished before saving
images and capture manifests. Browser capture uses
English and verifies note persistence. Capture failures retain evidence in
`test-results/documentation/`.

Fixed output dimensions do not guarantee 2× source detail on a 1× display.
Use a high-density Mac and inspect source PNGs and the combined Timeline image.
Commit images with `docs/images/capture.json` and `docs/images/browser-capture.json`.

```bash
node scripts/compose-documentation-hero.mjs
npm run ci:check-docs
npm run ci:check-docs -- --images-only
```

To rebuild the combined Timeline image without taking new screenshots, source
files and input images must still match the hashes in the capture manifest.
Changes to the script that combines the images require new desktop screenshots.

The full checker verifies source-file hashes, image hashes and dimensions, inputs
to the combined image, and README image links. Linux CI checks image integrity;
local CI also checks whether source files have changed since capture. Prose-only
and backend-only edits do not require new screenshots. Never update capture
manifests without a successful capture.

## Formatting and analysis

```bash
npm run fmt
npm run fmt:check
cargo fmt
cargo fmt -- --check
npm run lint:unused
npm run lint:duplicates
cargo clippy --workspace --all-targets -- -D warnings
```

Rust toolchain pins must match local configuration and hosted CI. Use formatting
and analysis appropriate to the changed files; run the complete CI chain before
committing.
