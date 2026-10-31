# Browser Recall — Development

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Browser Recall works and
[CODEBASE_MAP.md](docs/CODEBASE_MAP.md) for where features are implemented.

## Prerequisites

- Node.js 24+ and npm dependencies from `package-lock.json`.
- PowerShell for the portable Windows environment rollback checks. Install
  [PowerShell 7.6.6](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell)
  on macOS/Linux; GitHub Actions pins the same release. Windows uses built-in
  Windows PowerShell 5.1. Set `BROWSER_RECALL_TEST_POWERSHELL` to select an explicit
  executable when PowerShell is outside `PATH`.
- Firefox for the real Firefox extension check; CI pins Firefox 157.0.1. Set
  `FIREFOX_BINARY` if Firefox is not installed at the default system path.
- Rust 1.97.0 with Rustfmt, Clippy, and LLVM tools, pinned in `rust-toolchain.toml`.
- Platform build tools: Xcode Command Line Tools on macOS, MSVC/WebView2 on Windows,
  or Tauri's Linux system dependencies listed in `.github/workflows/ci.yml`.
- `cargo-llvm-cov` 0.8.5 for the full coverage/CI workflow.

```bash
npm ci
npm run ci:check-prerequisites
cargo install cargo-llvm-cov --version 0.8.5 --locked
npm run ci:install-playwright
npm run ci:install-desktop-visual-browsers
```

Playwright installation includes Linux system libraries and fonts through
`--with-deps`; Linux installation may require administrator privileges.

## Build and run

Mac App Store channel builds enable native StoreKit review requests and disable
GitHub update checks and installation:

```bash
npm run build:app-store --workspace @browser-recall/desktop
cargo test --locked -p browser-recall-desktop --features mac-app-store --test reviews
```

The channel build requires macOS and Xcode with the Swift compiler. The build
command produces a Tauri app bundle; App Store signing, provisioning, sandbox
entitlements, and submission remain distribution setup. Regular build and GitHub
release commands omit `mac-app-store`. The native release-validation workflow
compiles and tests the Mac App Store channel before building the GitHub artifacts.

Configuration loading tolerates fields omitted by older releases. `ConfigStore`
fills absent fields from fresh-install defaults and saves the complete
configuration atomically. A missing `device_id` uses the machine-derived identity;
a missing `data_dir` returns to setup; a missing `setup_complete` is inferred from
the existing data-folder path. Existing settings, pairing credentials, and review
history are preserved. Malformed supplied values and unknown fields remain errors.
Missing connector metadata uses an unnamed `Browser`, an unknown approval time
of `0`, or `null` for nullable metadata. Connector identities and pairing tokens
remain required: configuration loading cannot invent an approved connection.
Nested sync timestamps default to `null`. Missing review attempts default to an
empty array. A missing first-opening timestamp uses the first request minus the
shared seven-day delay, or the current time when no requests exist. Existing
request timestamps and counts are preserved, and recovered values are persisted
once.

Review history is the nullable `review_requests` field in local `config.json`,
defaulting to `null` when absent. Mac App Store builds record `first_opened_at` and zero to two
`requested_at` timestamps in milliseconds. The first request requires seven days
since first opening, and the second requires thirty days since the first request.
A StoreKit call consumes the attempt even when StoreKit displays no dialog. The
schedule has no expiry windows and is not reset by changing collections. Browser
tests verify quiet timing and cancellation; Rust integration tests verify the
persisted schedule, cancellation during file locking, and reservation rollback
through the production configuration store. The no-tray native review probe uses
production AppKit code with a recording presenter, preserving the content view and
checking focus, visibility, sheets and native activity. The native review probe
uses actual focus in an unlocked session; a locked session verifies rejection
through the production focus gate and exercises remaining checks with controlled
focus. No App Store rating dialog is shown.

### Product website

The product page lives in `website/` and uses plain HTML, CSS, and JavaScript.
The website build copies the existing Browser Recall icon, product fonts, and
verified documentation screenshots into `dist/website/`. The first three demos
reuse production components: Timeline search/results, saved browser highlights,
and popup list chips. Timeline search and the saved highlight are display-only.
Timeline rows support selection using the production highlight styles. The desktop
sidebar switches between Timeline and Book, whose sample content comes from
`scripts/lib/documentation-seed.mjs`. Book retains the full multi-day sample
inside the same fixed-height viewport as Timeline. Content beyond the viewport
is clipped, and the outer page owns scrolling. The build reads desktop and popup
HTML/CSS directly;
isolated iframe documents prevent website styles from changing product controls.
Book uses `apps/desktop/ui/book-elements.js` for the same day, page, and highlight
markup as the desktop app, with editing and page links omitted in the read-only
demo. Hosts retain data loading, grouping, and event handlers. Book also uses
`apps/desktop/ui/book-typesetting.js`, shared with the desktop app,
and the same locked Justif package, English hyphenation, and punctuation settings.
The website build copies Justif and its license into local assets; typesetting
does not load remote scripts.
The demo keeps a compact sidebar visible at phone widths, hiding Timeline site
and time columns when space is limited. Overlay navigation is used only when
the embedded viewport is narrower than 320px.
No application build or daemon is needed. Install Node.js 24+ and run `npm ci` first.

```bash
npm run build:website
npm run preview:website
```

Open `http://127.0.0.1:4173/browser-recall/`. The preview uses the GitHub Pages
project path so relative asset links are exercised before deployment. Stop the
preview with Ctrl+C. Re-run the preview command after editing source files.

```bash
npm run ci:install-desktop-visual-browsers
npm run test:website
```

Playwright checks Timeline/Book navigation, the display-only controls, list
selection, page scrolling over previews, keyboard tabs, mobile layout,
screenshots, and installation links, including without JavaScript. Chromium and
mobile WebKit cover phone layouts and a consistent 510px demo height across all
feature tabs. Chromium also drives native touch scrolling. Playwright cannot
drive native swipes in mobile WebKit, so a separate WebKit project verifies wheel
scroll chaining at phone width; native Safari swipes still need a device check.
The interactive illustration uses fictional content and keeps edits only in the
current page; the illustration does not connect to Browser Recall data.

`website/analytics.js` loads GoatCounter asynchronously on HTTPS pages outside
localhost, using the blog's `https://tabokie.goatcounter.com/count` endpoint.
Page views use the fixed `/browser-recall/` path so query strings and fragment
links do not split the count. Automatic click events are disabled. Local HTTP
previews and embedded demo documents do not load GoatCounter.

`.github/workflows/website.yml` builds, checks, and publishes the product website
in one job. Relevant pull requests run the checks without entering the GitHub Pages
deployment environment. Relevant pushes to `main` publish `dist/website/` after
the checks pass. In GitHub repository
**Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**
once before the first deployment. The expected project URL is
`https://tabokie.github.io/browser-recall/`. **Actions → Product Website → Run
workflow** can publish the current `main` manually. GitHub Pages receives only the
built website directory, including the selected presentation modules and public
assets needed by the demos. No user data or application backend is included.

### Application

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
| `dist/desktop/macos/app/Browser Recall.app` | macOS app to launch or copy to Applications |
| `dist/desktop/windows/bin/browser-recall-desktop.exe` | Windows executable to launch; also used by native Windows tests |
| `dist/desktop/linux/bin/browser-recall-desktop` | Linux executable to launch |
| `dist/desktop/macos/bin/browser-recall-desktop` | Standalone macOS executable; normal macOS use launches the app bundle |

`dist/desktop/<platform>/bin/` contains a copy of the release executable from
`target/release/`; collection does not compile a second executable. On macOS,
`Browser Recall.app` already contains the executable under `Contents/MacOS/`, so
the additional `bin/` copy is not needed to launch the app bundle.

Bundle outputs follow `dist/desktop/<platform>/<bundle>/`, where `<platform>` is
the operating system and `<bundle>` is the Tauri bundle type. For example,
`dist/desktop/macos/app/` uses the `app` bundle type. The `app` bundle is produced
by a normal macOS build; installer bundles require a separate packaging command.

Cargo and Tauri keep build files in `target/`. After a successful build, the build
scripts replace the platform's output directory in `dist/desktop/`. If replacement
fails, the scripts restore the previous output. If restoration also fails, the
error identifies the retained backup directory for recovery.

macOS app collection copies only `Browser Recall.app` from Cargo's bundle directory.
Other bundles left by documentation screenshot runs are excluded from build output.

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
Installer packaging uses the separate signed release command described below.
Windows release builds produce a current-user NSIS installer; macOS release
builds produce a disk image and updater archive in `release-assets/`.

The separate Apple certificate packaging command remains available:

```bash
npm run build:dmg --workspace @browser-recall/desktop
```

`build:dmg` collects macOS disk images (`.dmg` files) into
`dist/desktop/macos/dmg/`. The command uses the same signed app build and disk-image
packager as Release, and retains the verified app and executable beside the disk
image. Signing, verification, and disk-image creation finish in staging before
replacing the previous macOS output. Regular Windows
and Linux local builds produce executables. Linux installer packaging is not
provided by the release workflow.

### Local builds with or without a developer certificate

After installing the prerequisites and running `npm ci`, build without a developer
certificate:

```bash
npm run build:unsigned --workspace @browser-recall/desktop
```

On macOS, `build:unsigned` means **ad-hoc signing**: a local signature that uses no
Apple certificate or Apple account. The signature uses a stable app identifier,
and the build verifies the complete bundle. Windows and Linux builds produce
executables without a developer certificate. The explicit command ignores Apple
certificate, notarization, and update-package credentials inherited from the shell.

To sign a macOS build with your own developer certificate:

1. In **Xcode → Settings → Accounts**, select your Apple account and team, open
   **Manage Certificates**, and create an **Apple Development** certificate for
   local development. The certificate and corresponding private key must be in
   your Mac's Keychain. See Apple's [certificate setup instructions](https://developer.apple.com/documentation/xcode/sharing-your-teams-signing-certificates).
2. List valid code-signing identities:

   ```bash
   security find-identity -v -p codesigning
   ```

3. Copy the full quoted certificate name, or the certificate's SHA-1 hash, and run:

   ```bash
   APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" \
     npm run build:signed --workspace @browser-recall/desktop
   ```

On macOS, `build:signed` requires exactly one valid installed signing identity.
Missing or ambiguous identities fail before compilation; use the SHA-1 hash to
distinguish certificates with identical names. The build verifies that the collected
app was signed with the selected certificate. The explicit local commands do not
import certificates, notarize the app, or sign update packages. No repository
signing secrets or tracked configuration edits are needed.

On Windows, install your code-signing certificate and private key in
`Cert:\CurrentUser\My`. List code-signing certificates and select a SHA-1
thumbprint in PowerShell:

```powershell
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object Subject, Thumbprint, NotAfter
$env:WINDOWS_SIGNING_CERTIFICATE = "YOUR_40_CHARACTER_CERTIFICATE_THUMBPRINT"
npm run build:signed --workspace @browser-recall/desktop
```

Windows signing uses [PowerShell Authenticode signing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature)
and needs no additional signing SDK. The build checks certificate validity and
private-key availability before compilation, then signs with SHA-256 and verifies
the staged executable's signature and selected certificate. Set
`WINDOWS_SIGNING_TIMESTAMP_URL` to your certificate provider's timestamp service
when timestamping is needed. `build:unsigned` ignores both Windows signing variables.
The environment-based regular and release builds also honor
`WINDOWS_SIGNING_CERTIFICATE`; the release build signs both the installer payload
and the installer through Tauri's custom signing command. Linux builds support
the unsigned mode.

Both commands write `dist/desktop/macos/app/Browser Recall.app` on macOS, replacing
the previous macOS output. Inspect the signature with:

```bash
codesign -dvvv "dist/desktop/macos/app/Browser Recall.app"
npm run verify:macos-bundle --workspace @browser-recall/desktop
```

The regular `npm run build` preserves the existing environment-based behavior:
ad-hoc signing by default, or certificate signing when `APPLE_SIGNING_IDENTITY` is
set. Use the explicit commands to choose a local signing mode independently of
release credentials. [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)
describes ad-hoc signing and Apple certificate configuration.

`build:dmg` requires an Apple signing identity. The release command uses the
configured macOS app identity, defaulting to ad-hoc signing, and signs update
packages with a separate key. Distributing a macOS app with **Developer ID
Application** signing and notarization requires separate Apple credentials;
an Apple Development signature is intended for local development.

Local, release, and disk-image builds share `scripts/build-desktop.mjs`. Certificate
checks run on staged output before replacing a previous verified build. Build
phase timings appear in the console and GitHub Actions step summaries; compare
hosted cache-hit and cache-miss runs before assessing runtime improvements.

### GitHub releases and desktop updates

`.github/workflows/release.yml` runs through `workflow_dispatch`.
Open **Actions → Release → Run workflow**, select a tested commit's
branch or tag, and choose whether to keep a draft or mark a prerelease. Every
build uses the dispatch commit. Existing releases are never overwritten.

Browser Recall uses one product version, defined in root `package.json`. Keep
`apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`,
`apps/desktop/src-tauri/tauri.conf.json`, `apps/extension/package.json`, and
`apps/extension/manifest.json` aligned, and update both lockfiles when changing
the version. `scripts/lib/product-version.mjs` validates these files and both
lockfiles for CI release preparation, local release builds, and update manifest
generation. Every release entry point rejects a mismatch. Both browser extension
archives retain the same version as the desktop installers and release tag.
Use three numeric components, each at most 65535, to satisfy browser manifest
requirements. Use the workflow's prerelease input for preview releases; browser
manifest versions cannot contain semantic-version prerelease suffixes. The release
tag is `v` followed by the product version.

| Asset | Purpose |
| --- | --- |
| `browser-recall-v<version>-windows-x64-setup.exe` | Current-user Windows installer and update package |
| `browser-recall-v<version>-macos-arm64.dmg` | Apple Silicon installation; drag Browser Recall.app into Applications |
| `browser-recall-v<version>-macos-x64.dmg` | Intel installation; drag Browser Recall.app into Applications |
| `browser-recall-v<version>-macos-<arch>.app.tar.gz` | macOS update package, consumed by Browser Recall |
| `browser-recall-v<version>-extension-chrome.zip` | Chrome/Chromium extension; extract and load the folder unpacked |
| `browser-recall-v<version>-extension-firefox.zip` | Firefox extension; extract and temporarily load `manifest.json` through `about:debugging` |
| `*.sig` | Update-package signatures |
| `latest.json` | Tauri update manifest for Windows x64 and both macOS architectures |
| `SHA256SUMS` | Checksums for installers, extension archives, and update packages |

Release builds use Node.js 24 and Rust 1.97.0 on native Windows and macOS runners.
Regular CI and Release call `.github/workflows/desktop-release-validation.yml`
with Windows x64 and macOS arm64 validation. Release also builds and validates
macOS x64 packages; regular CI omits the Intel Mac runner. Regular CI generates
a disposable signing key and embeds its public key only in that runner's checkout;
CI packages are never uploaded for publication. Release uses the repository's
signing secrets and uploads the verified packages. Signature verification uses
Cargo's release profile so the native job does not rebuild the desktop dependency
tree in the debug profile.
Run the release build locally with a signing key in the environment:

```bash
TAURI_SIGNING_PRIVATE_KEY="/absolute/path/to/updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run build:release --workspace @browser-recall/desktop
```

Set the GitHub Actions repository secret `TAURI_SIGNING_PRIVATE_KEY` to the
private key's **contents**, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key
has a password. The public key in `tauri.conf.json` must match. Keep a durable,
secure backup of the private key: replacing the public key strands installed
versions that trust the old key. Never commit a private key.

The release build signs the final package after macOS bundle finalization. A Rust
check downloads the package through the production Tauri updater and verifies
that the embedded public key accepts its signature. On macOS, the check also
installs the package into a temporary application bundle and runs the production
bundle verifier. CI verifies the disk image's application bundle. Windows CI
checks installation, the installed executable, native single-instance behavior,
and uninstallation. Windows verification requires `7z` on `PATH` (provided by
the Windows CI runner) and compares the executable with the payload extracted
from the NSIS installer. Tauri patches the packaged executable's bundle type
and restores the raw build executable afterward, so those two files differ.
Both native platforms also run the real app at version 0.0.1,
check a local update manifest, install the signed release package through the
native Update and restart control, and verify a different process running the new
version. A connector session remains open until shutdown; accepted note edits,
settings, the selected data folder, and the pairing token must survive. The
connector reconnects and successfully writes another note edit after relaunch.
Both platforms run this test only in a disposable session. CI retains native
update logs and accessibility text on failure. Release artifacts are kept for
seven days before publication.

Run the native update check after building a signed release package:

```bash
BROWSER_RECALL_ISOLATED_MACOS_SESSION=1 node tests/smoke/desktop-update-lifecycle.mjs
```

On macOS, use a disposable macOS user account or CI runner, set
`BROWSER_RECALL_ISOLATED_MACOS_SESSION=1`, and quit Browser Recall first. The check
refuses to stop a user's running app and uses a temporary application,
configuration, and collection. On Windows, use a disposable session and set
`BROWSER_RECALL_ISOLATED_WINDOWS_SESSION=1`.
The Windows check temporarily saves its profile, connector port, registration
guards, and WebView2 settings in the disposable user's environment registry.
The elevated NSIS installer relaunches through `CreateProcessWithTokenW`, which
rebuilds the environment from the Windows user profile and loses process-only
overrides. Teardown restores the original registry values and value types; if
restoration fails, the check retains the rollback file and reports its path.
`npm run ci:test-windows-cleanup` includes a Windows GitHub runner regression that
launches a real subprocess through the same Windows API before and after setup
and verifies restoration after a simulated failure. The regression helper
duplicates the desktop user's token, matching the installer, and reports the
Windows API operation and error code on failure. The final Windows validation
gate prints failed test names and errors from the individual JSON reports.
The rollback JSON reader runs without registry access on every platform and is
required by JavaScript tests and coverage. Missing PowerShell fails explicitly;
`npm run ci:check-prerequisites` checks PowerShell before the full local suite and
the hosted tests. Portable PowerShell processes run asynchronously with closed
standard input and a 60-second deadline, including startup. A subprocess regression
delays startup beyond the former 10-second limit and runs the real reader.
The regression checks absent values and saved string/expandable
string values, including Windows PowerShell 5.1's JSON array pipeline behavior.
The regression serializes each entry visited by restoration's `foreach` loop;
Windows PowerShell 5.1 can add `value`/`Count` properties when reserializing the
whole parsed array.
The native update check
authenticates the retained connector before inspecting the relaunched interface.
The macOS check waits for the Accessibility window before positioning the window;
process registration alone does not establish window readiness. A readiness
timeout retains the native helper's error, including Accessibility failures.
The check builds an older fixture with a local HTTP endpoint; released binaries
retain the production HTTPS endpoint. No test updater endpoint is added to the
production runtime.
Desktop and standalone daemon startup share strict `BROWSER_RECALL_PORTS`
parsing. The native update check uses a dedicated port throughout the update, so
installed browser extensions cannot discover and pair with the test daemon.
Windows MSVC integration-test executables embed a Common Controls version 6
manifest separately from the packaged application. Routine CI and Release start
the Windows integration-test harness during release-package signature verification,
so missing native startup dependencies fail before installation tests.

To upgrade manually on macOS, quit Browser Recall using Quit, open the new disk
image for the Mac's architecture, drag Browser Recall.app into Applications, choose
Replace, eject the disk image, and reopen Browser Recall from Applications. Closing
the window only hides the app. On Windows, quit Browser Recall and run the new setup
executable. Collections, preferences, and browser pairing are preserved. An older
installation without self-update needs this manual upgrade once.

The release workflow builds both production extensions once on Ubuntu 24.04 with
Node.js 24. Extension ZIP archives contain `manifest.json` at the archive root.
The workflow extracts each archive and compares its complete contents with the
build output, then includes both archives in release checksums. Publication waits
for every desktop and extension build to pass. The archives contain production
code; test control handlers are omitted by the normal extension build.

Browser Recall checks for updates five seconds after release-build startup and
every twelve hours while running. GitHub's latest-release endpoint selects stable
published releases. Development builds and isolated native/documentation profiles
do not check automatically. Settings provides manual checking, progress, errors,
and **Update and restart**; an available update also appears in the sidebar.
Downloads are authenticated before installation. Installation waits for native
commands and sync, closes daemon connector sessions, and saves accepted checkpoint
writes. The update coordinator retains its operation lock through daemon recovery
or restart. Errors become retryable only after recovery finishes. Update
installation does not depend on GitHub sync form validation or credentials.

Update-package signatures are separate from operating-system code signing.
The default release still uses ad-hoc macOS signing without notarization and
unsigned Windows binaries. macOS installation approval and Windows SmartScreen
behavior are unchanged. The Windows installer installs WebView2 Runtime when
needed. Preferences and the selected collection remain outside the application.
Browser extensions are installed separately.

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
`npm run generate:icons -- --readme` regenerates only the README icon strip:
`icons/browser-recall-icons-40px-gap-12px.svg` (196 × 40 pixels). The strip preserves
the visible order of the four right-aligned extension icons in the README.

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
| `npm run ci:test-extension-rendering` | Real Chromium extension font rendering with an isolated rejecting connector endpoint; no Rust build or daemon |
| `npm run test:e2e` | Playwright workflows |
| `npm run test:visual` | Build UI assets; run native WKWebView, Chromium, and selected WebKit tests |
| `npm run ci:test-rust` | Build UI assets and run Rust workspace tests |
| `npm run test:cold-scripts` | Run manual test-data generation against the daemon |
| `npm run coverage` | All JavaScript tests and Rust workspace tests with coverage, then uncovered-line monitor |
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

Regular CI has six runner jobs: Tests, Coverage and Lint, extension E2E,
macOS visual regression, two native release-validation jobs, and Windows extension
rendering. Native packaging and Windows extension rendering start independently
in parallel with Tests, Coverage and Lint. Tests, Coverage and Lint uses an Ubuntu
runner and validates PowerShell availability, release versions, README images,
and JavaScript formatting before installing desktop build tooling.
Pinned actionlint 1.7.12 validates workflow syntax and reusable-workflow inputs.
JavaScript tests run once with V8 coverage. Rust workspace tests run once under
`cargo llvm-cov`; both Rust reports reuse that execution. A newer push cancels the
older regular CI run for the same branch. Release publication remains serialized.

Native platform scenarios remain in regular CI: Windows installed-app
single-instance/deep-link behavior, cleanup and replacement; macOS startup
recovery, five tray reopen cycles, session guards, and lightweight documentation
registration regressions. Windows extension rendering runs on relevant changes.
Shared macOS window and routing scenarios run on arm64;
macOS arm64 runs signed-package installation and real update/relaunch in regular
CI. Release runs package and update validation on both macOS architectures.
Windows installed-app validation runs three consecutive fresh-profile launches.
An isolated Windows test records `profile.startup-stages.log` beside the profile
before Tauri creates the webview and around icon, configuration and logging initialization.
The recorder does not pre-create the profile or change cold WebView2 initialization. A startup
failure reports those stages, profile filenames and owned process metadata in a
GitHub annotation, including when a GUI executable has no standard output. The
process inspection has a five-second deadline; the startup wait remains fifteen
seconds. Progress recording is disabled without an explicit test profile.
Failed macOS validation records the Rust host, runner architecture, and build-script
executable formats in `test-results/native-build/executables.txt`, alongside the
existing native failure artifacts. This distinguishes incompatible executables
and architecture mismatches without relying on Cargo's exit status alone.
The macOS window frame check runs before release compilation in the minimal
`browser-recall-native-tests` Cargo package, which imports the production frame
module and depends only on AppKit bindings. Windows extension rendering keeps a
separate job but installs npm dependencies and Chromium only when selected; the
initial Node setup disables automatic npm caching, and the npm cache is restored
only after selection. The job uses no Rust toolchain, Rust cache, or daemon.
The browser fixture reserves a
rejecting local connector endpoint so the extension cannot pair with a personal
daemon. The full macOS documentation scenario runs inside native validation when
selected, reuses the finalized production app, and builds only the no-tray
documentation app. The scenario requires the production URL handler to remain
selected. Launch Services may select any extracted copy with the production
bundle identifier; registration must preserve the selected application identity.
Release always runs both optional scenarios before publication.

`scripts/select-platform-checks.mjs` selects Windows extension rendering for
extension/shared-core sources, rendering fixtures, browser/build configuration,
dependencies, and relevant workflow changes. The full macOS documentation scenario
is selected for native desktop sources, documentation/native build and registration
helpers, Rust/npm dependencies, and relevant workflow changes. The selector uses
all commits in a push or the pull request's merge-base diff, including deleted
and renamed source paths. Both scenarios run for manual/release validation and
initial pushes; an unavailable force-push predecessor explicitly selects both.
Malformed event data and other Git failures stop validation. Checkouts retain
complete commit history with historical blobs omitted. Unrelated changes leave
the Windows job at checkout, Node setup, and selection; macOS retains the cheap
registration regressions without compiling a documentation app.
Timings must be measured on hosted runners; removing duplicate builds and test
executions does not establish a new wall-clock duration by itself.
Release packaging and native update validation report separate phase durations in
the job log and GitHub step summary. The [performance record](docs/DESKTOP_RELEASE_VALIDATION_PERFORMANCE.md)
preserves the hosted baseline, link-time optimization comparison, reproduction
commands, and historical hosted results. Measure the new policy on hosted runners
before claiming a wall-clock improvement.

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

`npm run test:visual` runs the native macOS WKWebView chart-layout and review
presentation probes, all Chromium desktop visual tests, and `@webkit` cases. The native probes skip on
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

The macOS window lifecycle test, native update test, and `npm run dev:desktop`
register real menu bar items. All three workflows refuse to run without
`BROWSER_RECALL_ISOLATED_MACOS_SESSION=1`. The flag is an explicit acknowledgement
of the caller's provisioned environment; the flag cannot prove account isolation.
Set the flag only in a disposable macOS user account or CI runner:

```bash
BROWSER_RECALL_ISOLATED_MACOS_SESSION=1 npm run test:desktop-native
```

Temporary data folders, `HOME`, and bundle identifiers do not isolate Control
Center's per-user menu bar ownership records. Launch Services unregistration does
not remove incorrect Control Center ownership links. Do not bypass the session
guard in a personal login session. Browser-based visual tests and the invisible
AppKit window frame test below do not register Browser Recall tray items.

Launch the regular Browser Recall app from Finder for personal use. Keep a single
installed app for daily use and avoid launching temporary copies from Codex or a
terminal. If a menu bar icon disappears again, inspect Control Center's protected
`trackedApplications` records for Browser Recall under a blocked foreign app. An
enabled Browser Recall permission alone does not rule out incorrect ownership.
Back up preferences before repairing a confirmed ownership link; preserve other
applications' permissions.

The macOS window lifecycle test checks visible startup errors, relaunch after
storage repair, tray activation, window reopening, focus, and saved window size and
position. The test places the baseline window inside the display's usable area
before checking exact frame preservation across five tray reopen cycles. Failure
screenshots, display bounds, baseline geometry, and logs remain under
`test-results/native-lifecycle/` before the temporary app is removed.
The shared Desktop Release Validation workflow uploads that directory on failure
and retains the diagnostics for seven days.

The macOS window frame regression uses an invisible AppKit window and forces size
and position changes while the content view has an inset. The regression calls
production frame restoration directly and runs before the tray lifecycle test:

```bash
cargo test --locked --release -p browser-recall-native-tests --test macos_window_frame
```

The snapshot folder check calls production snapshot-opening code, verifies that
Finder selects the snapshot HTML file and optional Markdown file, then closes only
the test window. The check also covers snapshots without Markdown and missing
snapshot HTML. The check requires a macOS desktop session and does not launch
Browser Recall or register a menu bar item:

```bash
cargo test --locked -p browser-recall-desktop --test snapshot_open -- --ignored
```

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
cannot be deleted cause the test to fail. Windows native validation and browser
setup run on separate runners.
Windows signing, cleanup, and artifact checks run in separate steps with three-minute
deadlines. All three checks run before a combined gate blocks packaging if any
check failed. JSON reports are saved under `test-results/windows-validation/`
and uploaded with native failure diagnostics. Windows extension rendering uses
`test-results/extension-rendering/` and uploads its own failure artifact from the parallel
job. The disposable certificate test closes PowerShell's standard input,
streams progress, and terminates PowerShell after 25 seconds; asynchronous process
execution also lets Vitest enforce its test deadline. The test creates a fresh
unsigned x64 executable with the Windows .NET Framework `csc.exe` compiler and
checks that Authenticode reports `NotSigned` before signing. Copied Windows system
executables can retain catalog signatures, which PowerShell prefers over embedded
signatures. The test checks rejection of a valid signature from another signer as
well as tampering. The test creates a fresh code-signing certificate through
.NET's `CertificateRequest`, avoiding the
`New-SelfSignedCertificate` setup command that stalled on Windows CI. The test
imports the private key into `CurrentUser\My` for real Authenticode signing and
trusts only the public certificate in `LocalMachine\Root`. `CurrentUser\Root`
can display a native confirmation dialog even with PowerShell's
`-NonInteractive` option, so certificate-store changes require an elevated
disposable GitHub runner. Separate progress messages identify both installations. Cleanup
removes the certificate from both stores and disposes the temporary private key,
including after a signing failure. macOS and Linux skip the native signing
scenario; passing tests on those platforms do not verify Windows certificate
installation or Authenticode behavior.

Native update teardown preserves the original failure and attempts every cleanup
even if diagnostics, process termination, or uninstalling also fails. Process
cleanup uses the original child before process-ID discovery and rediscovers the
installed executable after relaunch. The cleanup regression exercises both paths
with real subprocesses without launching Browser Recall. Native launch errors
are reported directly instead of being replaced by readiness timeouts.

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

`test:firefox:real` uses `web-ext@10.5.0`, a headless Firefox browser, and an isolated
real daemon. The check verifies production content-script startup, navigation,
query normalization, persisted visits, and exclusion of a page opened while paused
until that page is refreshed after recording resumes. Visit persistence is checked before querying page identity,
so the check cannot rescue failed automatic navigation. Every setup allocation
shares the cleanup boundary, including daemon startup. The check runs in
`ci:test-extension-e2e`, in both local CI
and hosted CI, and verifies options-page messages in prepared and direct popups.
The Firefox check opens actual toolbar popups to verify live resizing as daemon
commands create and delete lists. Exact `getRecordingState` failures in disposable
extension copies exercise short and long fatal-error messages; titles and Reload
buttons must remain inside the window, and long messages must scroll without
horizontal overflow. The same failure fixture is used by the Chromium popup E2E
suite and is omitted from production bundles.
The Chromium failure scenario also forces a 16px message scrollbar; fatal errors
keep scrolling inside the message rather than the native popup viewport.
The Chromium popup sizing check also starts in a wider provisional viewport;
the document root must keep the same width as the content before native resizing.
Standalone popup screenshots also keep a wider viewport: Playwright resizes the
hosting browser window, and a 296px host can clip the next native toolbar popup.
Native popup measurements are retained as JSON test attachments on failures.
Popup diagnostics and Firefox teardown use `withCleanup` to preserve the original
failure together with any diagnostic or cleanup errors, and attempt every cleanup.
On macOS and Linux, the launcher owns a separate process group so cleanup can
terminate Firefox descendants even after `npx` exits. Cleanup closes HTTP
connections and finishes before the check prints its success message.
Cleanup force-kills only a process group that remains after graceful shutdown;
an exited process group must not receive a redundant `SIGKILL`.
macOS can deny signals even after group members are defunct or exiting. Cleanup
confirms those `Z`/`E` states through the native process table and still waits for
output pipes to close. Permission errors for live or uninspectable groups remain
failures.
Firefox process inspection and pipe closure share an overall cleanup deadline.
`timeoutMs` sets the graceful shutdown period; the total budget is twice that
period, including any timed process inspection.
The macOS native validation job runs these process-readiness integration tests,
including denied signals against a real defunct process group.
`test:firefox:smoke` uses simulated browser APIs and does not launch
Firefox. `test:shortcut:native` sends Option+R to a temporary Chromium window on
macOS.

Focused local desktop tests may set `BROWSER_RECALL_PLAYWRIGHT_ENGINE=chrome`
when pinned Chromium is unavailable. Extension tests require pinned Chromium.
Both extension fixtures share browser selection and reject explicit `chrome`,
`msedge`, and `webkit` choices before launching a browser. Google Chrome and
Microsoft Edge removed the command-line flags needed to load unpacked extensions.
The subprocess regressions verify these errors without requiring any installed
browser, so JavaScript coverage can run before Playwright installation. Actual
font rendering runs in extension E2E after Playwright setup. The `ci:*` scripts
always use the pinned browsers.

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

### Repair snapshot identity metadata

Snapshots require embedded URL and slug metadata. To repair older snapshots,
quit Browser Recall Desktop and run the migration against the chosen data folder:

```bash
npm run migrate:snapshot-identity -- --data-dir "/absolute/path/to/data-folder" --check
npm run migrate:snapshot-identity -- --data-dir "/absolute/path/to/data-folder"
```

`--check` reports `scanned`, `current`, `pending`, and `updated` counts without
writing; its exit code is 1 when repair is pending. Invalid page URLs, mismatched
slugs, missing page checkpoints, and invalid snapshot paths produce errors.
The migration validates the collection before writing and replaces each affected
HTML file through a temporary file on the same volume. Page checkpoints, logs,
and Markdown files remain unchanged. A second run reports no pending repairs.

## Documentation screenshots

Documentation capture is a manual macOS workflow. Both commands require a logged-in
macOS desktop, Xcode Command Line Tools, Accessibility permission, Screen Recording
permission, and the Chromium version installed by Playwright.

```bash
npm run docs:screenshots
npm run docs:screenshots:browser
```

Desktop documentation capture uses the Cargo feature `no-tray`, which omits the
menu bar item. The shared documentation launcher requires `BrowserRecallNoTray` bundle metadata
before executing a binary, then runs the binary with `--check-no-tray` before
launch. Older bundles without the metadata are rejected without execution.
The check exits before initializing native application services. Desktop and browser
documentation capture do not require the disposable-session flag.

Run desktop and browser capture separately so native focus does not interfere.
The documentation build uses `scripts/documentation-tauri.conf.json` to disable
URL schemes in the retained bundle and temporary capture copy. The capture
verifies the retained bundle before launching the copy. Native macOS CI also
checks that registering the retained bundle preserves Browser Recall URL routing
and that app URL activation reopens a hidden window in the same process. The URL
routing baseline is read after the build, immediately before registration, so
production app discovery during the build cannot produce a false failure. The
production fixture check compares `CFBundleIdentifier` because release validation
extracts multiple copies of the same app. The selected bundle identifier must
remain unchanged across documentation registration and activation; paths appear
in failure diagnostics. A native regression registers two discoverable production
copies and forces Launch Services to switch copies between checks, using a unique
URL scheme that does not affect personal routing. The regression also rejects a
different application identity and verifies teardown after validation fails with
a valid, unregistered documentation bundle on disk. `MacosAppRegistrations` owns
successful registrations and unregisters only those bundles during cleanup.
The check uses a
temporary no-tray app and profile and targets the app explicitly to preserve the
user's default URL handler. Neither documentation check requires a fresh account:

```bash
npx vitest run tests/integration/macos-documentation-url-routing.test.js
node tests/smoke/macos-documentation-url-routing.mjs
```

Capture uses separate test app identifiers, browser profiles, fictional data, and a real
daemon. The regular app and personal browsing data are not used. Leave capture
windows alone until completion.

| Capture | Window layout | PNG output with wallpaper |
| --- | --- | --- |
| Timeline, Amber and Mono | 960 × 620 points | 2080 × 1400 pixels |
| Book, Amber | 960 × 620 points | 2080 × 1400 pixels |
| Browser popup and highlight editor | 800 × 434 points | 1760 × 1028 pixels |

Every screenshot places the captured window over a fixed light Sonoma wallpaper,
with 40 points of margin and native shadows. The wallpaper asset is
`scripts/assets/documentation-sonoma-light.png`, exported at 2560 × 2560 pixels
from Apple's built-in `/System/Library/Desktop Pictures/Sonoma.heic` light image.
The capture centers and crops the asset to fill each output image. Capture manifests
record the wallpaper's SHA-256 hash and crop, and the documentation checker verifies
the asset even with `--images-only`.

The capture uses transparent native window pixels and never reads the current
desktop wallpaper. Other application windows, desktop icons, widgets, the Dock,
and menu bar are excluded. The window and margin must fit on one display. The
combined Timeline image keeps the wallpaper outside the diagonal color-scheme divider.

The capture scripts operate the real app and browser. The scripts check content,
window dimensions, language, and whether rendering has finished before saving
images and capture manifests. Before each Timeline capture, the desktop script
scrolls the time chart to the beginning of the fixed fixture's activity. The script
verifies the fixture's month label inside the chart viewport before and after
capture, so advancing machine dates cannot leave the screenshot showing empty
recent days. Both commands share native helper compilation,
capture arguments, and pixel-stability checks. Browser capture uses
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

Export the Chrome Web Store variants from the verified browser captures on macOS:

```bash
node scripts/export-chrome-web-store-screenshots.mjs
```

The exporter writes the popup and highlight editor to
`docs/images/chrome-web-store/` as 1280 × 800, 24-bit RGB PNGs without alpha,
alongside `capture.json`. The export manifest records the browser image hashes,
conversion source hashes, and output hashes and dimensions. Temporary export files
stay on the destination volume; conversion failures preserve the previous export.
The exporter crops only the wallpaper at the sides and scales uniformly, preserving
the complete browser window. The documentation images keep their original dimensions.

The full checker verifies source-file hashes, image hashes and dimensions, inputs
to the combined image, Chrome Web Store export freshness and RGB format, and README
image links. `--images-only` still checks that Chrome Web Store exports match their
browser source images, but skips capture and conversion source-code fingerprints.
Linux CI checks image integrity;
local CI also checks whether source files have changed since capture. Package
manifest fingerprints include product versions, dependencies, runtime exports,
and toolchain fields; package scripts and descriptive metadata are excluded.
Prose-only, package-command-only, and daemon-only edits do not require new screenshots. Desktop freshness
includes native shell source, capabilities, build scripts, and Cargo dependency
and toolchain files. Never update capture manifests without a successful capture.

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
