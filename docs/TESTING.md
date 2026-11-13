# Testing

Use [Development](../DEVELOPMENT.md) for prerequisites and commands and
[Codebase Map](CODEBASE_MAP.md#verification) to find existing coverage.

## Choose the test boundary

Prefer Playwright end-to-end (E2E) scenarios connected to a real daemon.
Use Rust integration tests for daemon behavior that browser tests cannot verify,
and native application tests for windowing, installation, and updates. Desktop
visual tests simulate Tauri responses and verify layout and command calls only.

For a bug fix, reproduce the exact failure before changing production code. Force
the failed message, missing permission, or unfinished checkpoint directly. A final
notification or scheduler-dependent race does not establish coverage.

Combine features where interactions matter. Randomized inputs need an explicit
seed in the failure output. Use coverage reports to find valuable missing scenarios;
do not add unit tests simply to raise a percentage. JavaScript and inline Rust
unit-test growth requires a justified exception with `ALLOW_UNIT_TEST_GROWTH=1`.

## Deterministic fixtures

- Fix clocks and calendar dates when timestamps affect grouping or layout.
- Gate asynchronous responses when checking intermediate states, such as the first
  page of results. Wait for conditions or named transitions instead of sleeping.
- Keep real motion, including unrelated finite and infinite animations, in
  navigation regression coverage.
- After assigning `scrollTop`, read the resulting value: the browser may clamp the
  requested position. Compare virtual rows using the same viewport-relative
  `getBoundingClientRect()` differences as the implementation.
- Build the daemon before browser tests. Compiling Rust during fixture startup can
  exceed readiness deadlines.
- Generate manual seed data from complete daemon settings, apply setting events,
  then explicit overrides. Upgrade tests also need older configurations with
  omitted fields; current complete fixtures cannot test upgrade defaults.

Critical manual scripts need importable helpers and a noninteractive scenario with
the real daemon and extension connection.

For extension fixture helpers, background resets, and browser messaging pitfalls,
see [tests/AGENTS.md](../tests/AGENTS.md). When opening a popup as a regular page,
create a real HTTP tab first so the popup resolves the intended page.

## Visual and browser checks

`npm run test:visual` builds UI assets, runs native macOS WKWebView chart and review
probes, then Chromium and selected `@webkit` cases. Native probes skip elsewhere.
Generate baselines on macOS 26 with the browsers pinned by the lockfile. Inspect
expected, actual, and difference images before changing baselines or tolerances.
WebKit Book screenshots use exact matching.

Cover overlay and space-reserving scrollbars. Book and search-tracer fixtures use
11 px scrollbars; fatal popup coverage also forces a 16 px scrollbar. System-font
checks first verify that Chinese, Japanese, and Korean characters render distinctly.

Playwright `setViewportSize` also resizes the hosting Chromium window. A narrow
screenshot page can constrain a later native toolbar popup, especially on Linux.
Keep the host wide enough and capture document, viewport, visual viewport, and
native window bounds before blaming product CSS. Visible popup content must size
the native window through normal layout flow.

If every test fails before execution with `browserType.launch`, `SIGABRT`, or
`kill EPERM`, rerun with browser-launch permissions. Treat launch-only failures as
sandbox failures. Stop only test-owned processes when cleaning up.

For site-specific highlight failures, inspect the live DOM and saved note/page IDs
before attributing the failure to selectors, text matching, or content replacement.

Extension tests require pinned Chromium. The extension fixtures reject `chrome`,
`msedge`, and `webkit` before launch because those browsers cannot load the fixture
through the required command-line mechanism. Focused desktop tests may use
`BROWSER_RECALL_PLAYWRIGHT_ENGINE=chrome`; CI always uses pinned browsers.

`npm run test:firefox:real` uses Firefox, `web-ext@10.5.0`, and a real daemon. The
scenario covers automatic capture, navigation, pause/resume eligibility, options
messages, native popup resizing, and short/long startup errors. The shared failure
fixture forces `getRecordingState` errors and is omitted from production bundles.
`npm run test:firefox:smoke` simulates browser APIs; the command does not launch
Firefox. `npm run test:shortcut:native` checks Option+R in Chromium on macOS.

## Native checks

### macOS sessions

Tray lifecycle tests, native update tests, and `npm run dev:desktop` require a
**disposable macOS user account or CI runner**. Only in that account, acknowledge
provisioning with `BROWSER_RECALL_ISOLATED_MACOS_SESSION=1`. The flag cannot detect
account isolation. Never bypass the guard in a personal login session.

Temporary data folders, `HOME`, bundle identifiers, and Launch Services cleanup do
not isolate Control Center's per-user menu bar ownership records. Launch the
regular app from Finder for personal use. For a missing icon, inspect
`trackedApplications` for Browser Recall under a blocked foreign application.
Back up preferences before repairing a confirmed ownership link; preserve other
permissions.

| Check                                                          | Command or entry point                                                                   | Session requirement                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Startup recovery, tray, focus, five reopen cycles, saved frame | `npm run test:desktop-native`                                                            | Disposable account                           |
| Hidden frame restoration with an inset content view            | `cargo test --locked --release -p browser-recall-native-tests --test macos_window_frame` | No Browser Recall tray item                  |
| Finder selection of snapshot HTML and optional Markdown        | `cargo test --locked -p browser-recall-desktop --test snapshot_open -- --ignored`        | Desktop session; no Browser Recall tray item |
| Review presentation gates                                      | `tests/smoke/macos-review-presentation.mjs`                                              | No-tray probe; never shows StoreKit dialog   |
| Documentation registration and URL activation                  | `tests/smoke/macos-documentation-url-routing.mjs`                                        | Verified no-tray build                       |

Native click coordinates come from the Accessibility window frame; Quartz bounds
are for screenshots. Keep error controls below the titlebar drag region.
The review probe uses actual focus in an unlocked session; locked sessions verify
focus rejection and use controlled focus for the remaining checks.

Launch Services can choose among multiple extracted production bundles. URL
routing tests compare `CFBundleIdentifier` and retain paths as diagnostics. Require
an exact path only when selecting that particular copy is the behavior under test.

### Windows

Quit Browser Recall before `npm run test:desktop-single-instance`. The scenario
checks executable/window icons, startup, deep links, and second-instance routing
with temporary configuration and WebView2 profiles. Installed-app validation runs
three fresh-profile launches. `--icons-only` checks the executable without closing
a running application.

GUI application launches must preserve visibility. Node.js `windowsHide: true`
applies `SW_HIDE` to the first Windows `ShowWindow` call; use hidden launches only
for console helpers. A native graphical fixture checks the actual smoke launcher.
Cross-compilation cannot establish this runtime behavior.

Startup stages are written beside an explicit test profile before application
logging starts. Failure annotations include stages, elapsed time, profile entries,
exit status, output, and owned process metadata. Process inspection has a five-second
deadline; native setup must emit `desktop native startup complete` within fifteen
seconds. Earlier application logs do not establish readiness. A further observation
window of up to thirty seconds diagnoses late initialization but still fails the
original deadline.

Every installed-app smoke run retains startup stages, application logs, process
output, source revision, runner image version, live WebView2 process versions, and
readiness timing in `test-results/native-lifecycle/`. Both regular CI and Release upload the
`windows-startup-diagnostics` artifact even when Windows verification passes.
Compare the same source revision across both workflows; a passing run alone does
not identify the cause of a slow run. Evidence capture runs before profile cleanup,
and capture failures preserve the original error.

The shared startup observer has real subprocess coverage for timely startup, late
logging, exit, and stalls. Icon probes use asynchronous subprocesses bounded by
the remaining readiness budget; a hung probe cannot block the outer deadline.

Native signing tests require an elevated disposable Windows runner. The tests
compile a fresh unsigned executable, verify `NotSigned`, then exercise real
Authenticode signing, wrong-signer rejection, and tampering. System executables
can retain catalog signatures and are unsuitable unsigned fixtures. Disposable
certificates use `CurrentUser\My` and `LocalMachine\Root`; `CurrentUser\Root`
can show confirmation even in noninteractive PowerShell. Cleanup removes the
certificates and private keys. macOS/Linux passes do not cover Windows signing.

### Updates and isolation

After building signed release packages, run
`node tests/smoke/desktop-update-lifecycle.mjs` in a disposable session. Set
`BROWSER_RECALL_ISOLATED_MACOS_SESSION=1` or
`BROWSER_RECALL_ISOLATED_WINDOWS_SESSION=1` for the matching platform.

The scenario builds version 0.0.1 with a local update endpoint, installs the signed
package through **Update and restart**, and verifies a new process. Collection,
configuration, pairing, and accepted edits must survive; the connector must
reconnect and write after relaunch. Production builds retain the HTTPS endpoint.
A dedicated `BROWSER_RECALL_PORTS` value prevents personal extensions discovering
the test daemon.

Windows installer relaunch through `CreateProcessWithTokenW` rebuilds the child
environment from the user's registry. The test temporarily writes isolation values
there and restores their values and types during teardown. A failed restoration
retains the rollback file. Portable rollback-reader tests run on every platform
and require PowerShell; registry/token-launch tests require a Windows CI runner.
Portable PowerShell runs asynchronously with closed input and a 60-second deadline.

## Failure handling

Preserve the original error when diagnostics or cleanup fail. Attempt every cleanup,
report all failures, and save evidence before deleting profiles. Process ownership
must survive relaunch: stop the original child and rediscover the installed process.
Report launch errors directly instead of replacing launch errors with timeouts.

Bound process inspection, termination, and output-pipe closure within an overall
cleanup deadline. Firefox cleanup owns a process group, force-kills only a live
group, and waits for pipes. On macOS, denied signals are accepted only after native
inspection confirms every member is defunct (`Z`) or exiting (`E`); live or
uninspectable groups remain failures.

For executable-format errors, retain the executable file type, runner architecture,
and Rust toolchain. macOS validation writes these details to
`test-results/native-build/executables.txt`. A successful retry does not establish
cache corruption or prove that the underlying failure is fixed.

## Hosted CI

Regular CI has six jobs: coverage/lint, extension E2E, macOS visuals, Windows native
validation, macOS arm64 native validation, and Windows extension rendering. Release
also validates macOS x64. Website checks run in a separate workflow.

Native validation builds packages, verifies signatures and installation, and tests
real updates/relaunch. Regular CI uses disposable signing keys; Release uses
production credentials and publishes assets. Windows signing, cleanup, and artifact
reports all run before a combined packaging gate.

`scripts/select-platform-checks.mjs` selects expensive Windows rendering and macOS
documentation scenarios from full push ranges or pull-request merge-base diffs,
including deleted/renamed paths. Manual/release runs select both. Invalid events
fail; unavailable force-push predecessors explicitly select both. Lightweight
macOS registration tests always run.

Run small native launch/cleanup regressions before packaging. Reused artifacts
must match the source revision, target, features, and toolchain. Fingerprints should
include only inputs affecting the relevant platform. Measure performance on hosted
runners; moving steps does not itself establish a faster elapsed time. See the
[performance record](DESKTOP_RELEASE_VALIDATION_PERFORMANCE.md).

Local and hosted verification share `ci:*` scripts, but `npm run ci` covers the
local host. Report unavailable platform checks explicitly. A newer branch push
cancels older regular CI runs: batch evidence-based fixes and let the current
commit's full required matrix finish before declaring completion.
