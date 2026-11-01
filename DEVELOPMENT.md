# Browser Recall — Development

Use [Architecture](docs/ARCHITECTURE.md) for system contracts,
[Codebase Map](docs/CODEBASE_MAP.md) for implementation locations,
[Testing](docs/TESTING.md) for regression and native checks, and
[Documentation](docs/DOCUMENTATION.md) for screenshot maintenance.

## Prerequisites

- Node.js 24+ and dependencies from `package-lock.json`.
- Rust 1.97.0 with Rustfmt, Clippy, and LLVM tools, pinned by `rust-toolchain.toml`.
- `cargo-llvm-cov` 0.8.5 for coverage and full local verification.
- PowerShell 7.6.6 on macOS/Linux; Windows uses built-in Windows PowerShell 5.1.
  Set `BROWSER_RECALL_TEST_POWERSHELL` when the executable is outside `PATH`.
- Firefox for real extension checks; CI pins Firefox 157.0.1. Set `FIREFOX_BINARY`
  when Firefox is outside the default system path.
- Xcode Command Line Tools on macOS, MSVC/WebView2 on Windows, or the Linux system
  dependencies in `.github/workflows/ci.yml`.

```bash
npm ci
npm run ci:check-prerequisites
cargo install cargo-llvm-cov --version 0.8.5 --locked
npm run ci:install-playwright
npm run ci:install-desktop-visual-browsers
```

Playwright installs Linux libraries/fonts with `--with-deps`, which may require
administrator privileges. See the official [PowerShell installation guide](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell)
for installation options.

## Build and run

```bash
npm run build
```

The build prepares Chromium/Firefox extensions and the desktop application. Load
extensions from `dist/extension/`, never directly from `apps/extension/`.

| Output                                                | Use                         |
| ----------------------------------------------------- | --------------------------- |
| `dist/extension/chrome/`                              | Unpacked Chromium extension |
| `dist/extension/firefox/manifest.json`                | Firefox temporary add-on    |
| `dist/desktop/ui/`                                    | Assets consumed by Tauri    |
| `dist/desktop/macos/app/Browser Recall.app`           | macOS application bundle    |
| `dist/desktop/windows/bin/browser-recall-desktop.exe` | Windows executable          |
| `dist/desktop/linux/bin/browser-recall-desktop`       | Linux executable            |

Build intermediates remain in `target/`. Verified staged output replaces
`dist/desktop/<platform>/`; failed replacement restores the previous output or
reports the retained backup. The `bin/` directory copies the release executable
without recompiling. On macOS, use the app bundle, which already contains the
executable; documentation bundles are excluded from normal collection.

Quit Browser Recall from the tray before replacing a running Windows executable.
Locked leftover files are reported and cleanup is retried on the next build.

Focused commands:

```bash
npm run build:extension
npm run build:desktop-ui
npm run build --workspace @browser-recall/desktop
npm run dev:desktop
```

On macOS, `dev:desktop` requires a disposable user account; see
[Native checks](docs/TESTING.md#native-checks). Use Finder to launch the regular
application in a personal account.

To connect Chromium:

1. Start Browser Recall and choose a data folder and device identity.
2. Enable Developer mode at `chrome://extensions/` and load `dist/extension/chrome/`.
3. Open the popup, click Refresh, and approve pairing in the desktop app.
4. Enable **Allow access to file URLs** for snapshots opened as local files.

For Firefox, use `about:debugging#/runtime/this-firefox` and the generated
`manifest.json`. Rebuild/reload after extension changes; rebuild/restart after
Rust changes.

## Signing and packaging

Explicit local build modes ignore inherited release credentials:

```bash
npm run build:unsigned --workspace @browser-recall/desktop
npm run build:signed --workspace @browser-recall/desktop
```

On macOS, unsigned means ad-hoc signing with a stable application identifier.
Signed mode requires one valid installed Apple identity and verifies the collected
bundle against the selected certificate. Neither local mode imports certificates,
notarizes, or signs update packages. Linux supports unsigned mode.

Create an Apple Development certificate through **Xcode → Settings → Accounts →
Manage Certificates**, then select the full name or SHA-1 hash:

```bash
security find-identity -v -p codesigning
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" \
  npm run build:signed --workspace @browser-recall/desktop
codesign -dvvv "dist/desktop/macos/app/Browser Recall.app"
npm run verify:macos-bundle --workspace @browser-recall/desktop
```

Missing or ambiguous identities fail before compilation. Developer ID Application
signing and notarization require separate distribution credentials. See Apple's
[certificate setup](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates)
and [Tauri signing](https://v2.tauri.app/distribute/sign/macos/) guides.

On Windows, install the certificate/private key in `Cert:\CurrentUser\My`:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object Subject, Thumbprint, NotAfter
$env:WINDOWS_SIGNING_CERTIFICATE = "YOUR_40_CHARACTER_CERTIFICATE_THUMBPRINT"
npm run build:signed --workspace @browser-recall/desktop
```

The build verifies certificate validity and the SHA-256 Authenticode signature.
Set `WINDOWS_SIGNING_TIMESTAMP_URL` when timestamping is needed. Unsigned mode
ignores both Windows signing variables; release signing covers payload and installer.

Regular builds retain environment-based signing: ad-hoc on macOS unless
`APPLE_SIGNING_IDENTITY` is set. The separate macOS disk-image command requires an
Apple signing identity and writes `dist/desktop/macos/dmg/`:

```bash
npm run build:dmg --workspace @browser-recall/desktop
```

Local, release, and disk-image builds share `scripts/build-desktop.mjs`, verify
staged artifacts before replacing output, and report phase durations. Linux
installer packaging is not provided by Release.

### Mac App Store channel

```bash
npm run build:app-store --workspace @browser-recall/desktop
cargo test --locked -p browser-recall-desktop --features mac-app-store --test reviews
```

The `mac-app-store` feature enables StoreKit review requests and disables GitHub
updates. The build requires macOS and Xcode's Swift compiler. App Store signing,
provisioning, entitlements, and submission remain distribution setup. Regular
builds omit the feature. Native CI tests the channel before GitHub packaging.
See [Desktop app](docs/ARCHITECTURE.md#desktop-app) for review timing and persistence.

## GitHub releases and updates

Run **Actions → Release → Run workflow** for a tested branch/tag, choosing draft
or prerelease as needed. Every build uses the dispatch commit. Existing releases
are never overwritten.

Root `package.json` defines the product version. Align desktop/extension package
manifests, desktop Cargo/Tauri metadata, extension `manifest.json`, and both
lockfiles. `scripts/lib/product-version.mjs` validates every release entry point.
Use three numeric components, each at most 65535; select prerelease through the
workflow input rather than a version suffix. Tags use `v<version>`.

| Asset                                               | Purpose                                               |
| --------------------------------------------------- | ----------------------------------------------------- |
| `browser-recall-v<version>-windows-x64-setup.exe`   | Current-user NSIS installer/update                    |
| `browser-recall-v<version>-macos-<arch>.dmg`        | Apple Silicon (`arm64`) or Intel (`x64`) installation |
| `browser-recall-v<version>-macos-<arch>.app.tar.gz` | macOS updater payload                                 |
| `browser-recall-v<version>-extension-<browser>.zip` | Chromium (`chrome`) or Firefox extension              |
| `*.sig`, `latest.json`, `SHA256SUMS`                | Update signatures, update manifest, checksums         |

Release waits for package, installation, update/relaunch, and extension archive
checks. Extension ZIPs contain `manifest.json` at the root and are compared with
production output. Native checks run on Windows x64 and both macOS architectures;
regular CI omits macOS x64 and uses disposable updater keys. Only Release publishes
packages, with artifacts retained for seven days before publication.

For a local release build:

```bash
TAURI_SIGNING_PRIVATE_KEY="/absolute/path/to/updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run build:release --workspace @browser-recall/desktop
```

Set the GitHub secret `TAURI_SIGNING_PRIVATE_KEY` to the key's **contents**, and set
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when needed. The public key in `tauri.conf.json`
must match. Keep a secure backup: replacing the trusted public key strands older
installations. Never commit private keys.

Update signatures are separate from operating-system signing. Default release
packages use ad-hoc macOS signing without notarization and unsigned Windows
binaries. Windows setup installs WebView2 when needed. Installation approval and
SmartScreen still apply.

Release builds check GitHub's latest stable published release five seconds after
startup and every twelve hours. Settings provides manual checks, progress, errors,
and **Update and restart**. Development and isolated test profiles skip automatic
checks. Installation verifies signatures, waits for commands/sync, saves accepted
writes, and restarts. Collection, configuration, and pairing remain outside the
application and survive updates. See [Testing](docs/TESTING.md#updates-and-isolation)
for native update validation.

For manual upgrades, quit the application completely. On macOS, replace Browser
Recall.app in Applications from the matching disk image, eject the image, and
reopen. On Windows, run the new setup executable. Closing the window only hides
the application.

## Verification

Run focused checks while editing and `npm run ci` before committing code. For
Markdown-only edits, check formatting, links, and the full document's readability.
Local verification does not replace native platform coverage; report pending checks.

The repository formatter excludes Markdown. Check edited Markdown explicitly after
the editorial review:

```bash
npx prettier --ignore-path /dev/null --check path/to/document.md
```

| Command                                                 | Scope                                                    |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `npm test` / `npm run test:integration`                 | JavaScript suites / integration suites                   |
| `npm run build:test-daemon`                             | Build the daemon before daemon-backed browser tests      |
| `npm run test:e2e`                                      | Playwright user scenarios                                |
| `npm run test:visual`                                   | Native macOS probes, Chromium, selected WebKit cases     |
| `npm run ci:test-rust`                                  | UI assets and Rust workspace tests                       |
| `npm run ci:test-extension-rendering`                   | Chromium system-font checks without a daemon             |
| `npm run coverage` / `npm run coverage:monitor`         | Coverage and missing-scenario reports                    |
| `npm run ci`                                            | Complete local verification                              |
| `npm run fmt:check` / `cargo fmt -- --check`            | Formatting                                               |
| `cargo clippy --workspace --all-targets -- -D warnings` | Rust lint                                                |
| `npm run lint:unused` / `npm run lint:duplicates`       | Unused code/dependencies and duplicated extension blocks |

Examples:

```bash
npx vitest run tests/integration/page-identity-parity.test.js
npm run build:test-daemon
npx playwright test tests/e2e/popup-lists.spec.js
npm run test:visual:chromium -- --grep scroll
cargo test -p browser-recall-daemon --test read_projections
```

Playwright uses one worker and pinned browsers. Set `CARGO_TARGET_DIR` to a temporary
directory to test without cached Rust output. Keep local/hosted toolchain pins
aligned. For a Windows GNU type check on macOS/Linux, install MinGW and the target:

```bash
rustup target add x86_64-pc-windows-gnu
npm run check:desktop:windows
```

macOS can install MinGW with `brew install mingw-w64`. The cross-check does not
verify MSVC linking or Windows runtime behavior.

## Manual testing and stored data

```bash
npm run manual
npm run manual:seed
npm run manual:case -- <name>
```

Manual scripts use temporary daemon/browser profiles. Gitignored
`seeds/<name>.mjs` returns `events`, `entities`, `deviceId`, and `settings`; seed
helpers apply setting events before explicit overrides. Prefer daemon-backed
Playwright scenarios for repeatable coverage.

Inspect desktop terminal/native logs, background service-worker tools, or the
page/popup DevTools. **Settings → Advanced → Debug logging** enables runtime
logging until restart. Stop only processes owned by the failed test.

### Replay verification

The production verifier compares saved data with replayed logs. Always pass the
selected data folder explicitly; the verifier does not read desktop configuration.
The output directory is **deleted and recreated** on every run, so use a separate
disposable directory:

```bash
recall_data_dir="/absolute/path/to/chosen-data-folder"
recall_replay_dir="$(mktemp -d)"
cargo run -q -p browser-recall-replay --bin replay-verify -- \
  --data-dir "$recall_data_dir" --write "$recall_replay_dir" --verbose
```

Reports classify differences as `schema-gap`, `timing-drift`, or `data`; labels
identify fields, not proven causes. Unlogged note files are read directly because
logs cannot reconstruct those files.

### Snapshot identity repair

Quit Browser Recall before repairing older snapshot metadata:

```bash
npm run migrate:snapshot-identity -- --data-dir "/absolute/path/to/data-folder" --check
npm run migrate:snapshot-identity -- --data-dir "/absolute/path/to/data-folder"
```

The migration validates URLs, slugs, checkpoints, and paths before replacing HTML
through same-volume temporary files. `--check` exits 1 when repair is pending;
invalid data is an error. Logs, checkpoints, and Markdown remain unchanged.

## Website, icons, and locales

The static product website needs no daemon or application build:

```bash
npm run build:website
npm run preview:website
npm run test:website
```

Open `http://127.0.0.1:4173/browser-recall/`; restart preview after source edits.
The demos use production presentation modules with fictional data. Tests cover
navigation, mobile layouts, scrolling, screenshots, and installation links.
Mobile WebKit wheel checks do not establish native Safari swipe behavior.

`.github/workflows/website.yml` checks relevant pull requests and publishes checked
`main` builds. Set **Settings → Pages → Source → GitHub Actions** before first
publication. **Actions → Product Website → Run workflow** publishes current `main`.
Only `dist/website/` is deployed. See [Privacy](docs/PRIVACY.md#website-analytics)
for website analytics.

`npm run generate:icons` renders SVG sources into native slots, extension icons,
and tray assets. Inspect actual target sizes, including 16 px, and commit generated
assets with source changes. `-- --readme` generates only the README icon strip.

Add locales to `SUPPORTED_LOCALES` in `packages/core/i18n.js` with a complete
`packages/core/locales/<code>/messages.json`, then run `npm run locales:check`.
Builds validate keys, placeholders, HTML, shortcuts, and technical/product names.
