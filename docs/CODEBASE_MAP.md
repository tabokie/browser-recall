# Browser Recall — Codebase Map

Use this map to find the files that implement a feature. See
[ARCHITECTURE.md](ARCHITECTURE.md) for behavior and
[DEVELOPMENT.md](../DEVELOPMENT.md) for build and verification commands.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/desktop/ui/` | Main desktop interface |
| `apps/desktop/src-tauri/` | Tauri shell and native integrations |
| `apps/extension/` | Chromium/Firefox browser connector |
| `crates/daemon/` | Commands, data reads and writes, pairing, rules, and sync |
| `crates/replay/` | Apply logged events, define data formats, select saved page files, and verify stored data |
| `crates/search/` | Native search implementation |
| `packages/core/` | Shared JavaScript, CSS, localization, and generated bridge factories |
| `scripts/` | Builds, migrations, manual workflows, coverage, and documentation capture |
| `tests/` | JavaScript unit/integration tests, Playwright scenarios, and native app tests |
| `icons/` | SVG sources for generated runtime icons |
| `docs/images/` | Documentation PNGs and capture manifests |
| `.github/workflows/ci.yml` | GitHub Actions checks using the same `ci:*` scripts as local CI |
| `package.json` | Build, test, formatting, and analysis commands |
| `rust-toolchain.toml` | Rust compiler and component pin |
| `.gitattributes` | LF checkout policy across platforms |

## Desktop

| File | Implements |
| --- | --- |
| `apps/desktop/ui/index.html` | Desktop markup, layout, and styles |
| `apps/desktop/ui/index.js` | Timeline, Book, lists, search, settings, imports, recycle bin, and mutation refreshes |
| `apps/desktop/ui/desktop-bridge.js` | Tauri product commands and strict response validation |
| `apps/desktop/ui/desktop-platform.js` | UI storage, messages, opening external URLs, and checks that the native app is available |
| `apps/desktop/ui/bookmark-parser.js` | Bookmark HTML parsing |
| `apps/desktop/ui/shared.css`, `apps/desktop/ui/fonts/` | Bundled fonts and shared desktop typography |
| `apps/desktop/src-tauri/src/main.rs` | Daemon lifecycle, Tauri commands/events, windows, tray, deep links, and single-instance handling |
| `apps/desktop/src-tauri/src/config.rs` | Desktop configuration and saved setup choices |
| `apps/desktop/src-tauri/src/shell_contract.rs` | Shell response types and route state |
| `apps/desktop/src-tauri/src/login_item.rs` | Check and change launch-at-login registration; undo changes if saving fails |
| `apps/desktop/src-tauri/src/windows_icon.rs` | Windows window and taskbar icons matched to display scale |
| `apps/desktop/src-tauri/src/search.rs` | Desktop search adapters |
| `apps/desktop/src-tauri/src/logging.rs` | Native log output and retention |
| `apps/desktop/src-tauri/capabilities/main.json` | Main webview permissions |

Desktop navigation and data refreshes have separate behavior in `index.js`.
`refreshCurrentView()` selects the refresh operation and reports read failures.
Navigation starts at the top; list, Timeline, category, and Book refreshes preserve
reading position, including scrolling during Book loading. Fullscreen handling
preserves main-pane and sidebar offsets.

Book groups highlights by local date and page, requests successive batches, and
updates edited entries in place. Justif lays out displayed text; opening the editor
restores the original text.

Desktop search starts on Enter. `index.js` combines page title and URL matches,
history, notes, and snapshot text. As results arrive, search preserves the selected
row. Data changes update affected rows without restarting the history search.

## Browser connector

| File | Implements |
| --- | --- |
| `apps/extension/manifest.json` | Permissions, entry points, and default shortcuts |
| `apps/extension/background.js` | Track page URLs per tab, prepare popups, deliver navigation messages, route commands, capture pages, and report errors |
| `apps/extension/content.js` | Visit, time-on-page, and scroll-depth capture; highlight integration with live pages |
| `apps/extension/spa-navigation-bridge.js` | Detect navigation in the page's JavaScript environment from document start |
| `apps/extension/browser-api.js` | Browser APIs available to the calling script and shadow-root lookup |
| `apps/extension/browser-privileged-api.js` | Background-only API validation |
| `apps/extension/browser-identity.js` | Detect the browser, including Orion |
| `apps/extension/browser-build-target.js` | Chromium/Firefox target generated during the build |
| `apps/extension/popup.js` | Current-page dashboard, list picker, and queue for edits |
| `apps/extension/popup-note-session.js` | In-memory note drafts and transfer of unsaved commands when the popup closes |
| `apps/extension/extension-surface.js` | Shared highlight entries, editors, icons, and overlays isolated by shadow DOM |
| `apps/extension/extension-surface.css`, `apps/extension/extension-ui-tokens.js` | Shared extension styles and error displays |
| `apps/extension/connector/ws-client.js` | WebSocket sessions, message validation, requests, and sending queued commands |
| `apps/extension/connector/state.js` | Read and validate saved connection status and errors |
| `apps/extension/connector/pairing.js` | Pairing and authentication helpers |
| `apps/extension/connector/command-buffer.js` | Size-limited pending-command queue and saved queue/byte counts |
| `apps/extension/savepage-bridge.js` | Snapshot capture sessions and resource diagnostics |
| `apps/extension/snapshot-resource-fetch.js` | Host-permission fetches, redirect/referrer policy, and temporary network rules |
| `apps/extension/savepage/content.js` | Save Page WE code that saves page content as snapshot HTML |
| `apps/extension/snapshot-viewer.js` | Saved-page preparation and highlight adapters |
| `apps/extension/options-stub.html` | Link to the desktop app |
| `apps/extension/background-test-control.js` | Test-only RPC handlers, omitted from production builds |

Opening from the toolbar determines the page URL and fetches the complete page
summary from the daemon. Toolbar opens and direct opens use the same display code.
The popup processes pin changes and list updates one at a time.

Live pages, snapshots, the PDF panel, and the popup use shared highlight/editor
implementations. Each page type supplies callbacks for saving data. Selection,
saved text locations, saving, and deletion use shared code.

## Daemon and replay

| File | Implements |
| --- | --- |
| `crates/daemon/src/lib.rs`, `crates/daemon/src/main.rs` | Daemon startup API and standalone CLI |
| `crates/daemon/src/command_authority.rs` | Parse and validate commands shared by Tauri and WebSocket; return write results |
| `crates/daemon/src/commands.rs` | Execute commands and construct valid log events |
| `crates/daemon/src/runtime.rs` | Apply command batches, order writes, install synced files, recover after crashes, and coordinate deletion/reset |
| `crates/daemon/src/storage.rs` | Cache current data, read disk, index logs, write checkpoints in the background, and select files for sync |
| `crates/daemon/src/read_projections.rs` | List/page/highlight/popup/tree/recycle-bin/settings reads |
| `crates/daemon/src/mutations.rs` | Build change notifications, including affected URLs |
| `crates/daemon/src/config.rs` | Save configuration with file locking and temporary-file replacement |
| `crates/daemon/src/capture_policy.rs` | Blacklist and title-cleanup policy |
| `crates/daemon/src/rules.rs` | Rule validation, previews, and automatic matching |
| `crates/daemon/src/search.rs` | History streaming and note/snapshot search adapters |
| `crates/daemon/src/protocol.rs` | Connector version 4 request/response types and test-control namespace |
| `crates/daemon/src/ws_server.rs` | Authenticated sockets, visit reports, command requests, and notifications to extensions |
| `crates/daemon/src/pairing.rs`, `crates/daemon/src/connectors.rs` | Pairing decisions and connector identities |
| `crates/daemon/src/sync.rs` | GitHub requests, credentials, device state, and sync scheduling |
| `crates/daemon/src/data_directory_docs.rs`, `crates/daemon/resources/data-AGENTS.md` | Generated data-folder guide and rules for external file writes |
| `crates/replay/src/lib.rs`, `crates/replay/src/handlers/` | Validate log records and apply events without duplicating changes when an event is repeated |
| `crates/replay/src/entities.rs` | Checkpoint schemas and relationships |
| `crates/replay/src/settings.rs` | Setting names, types, allowed values, and defaults |
| `crates/replay/src/bin/replay-tool.rs` | Command-line tool to replay logs and write rebuilt data |
| `crates/replay/src/bin/replay-verify.rs` | Production replay verification CLI |
| `crates/search/src/lib.rs` | Rank search matches and find searchable Browser Recall files |

Tauri and WebSocket writes share `command_authority.rs` and `runtime.rs`.
`read_projections.rs` combines records into responses for the UI, so callers do not
need to construct internal record keys. The log index in `storage.rs` is used for
crash recovery, history reads, ordering highlights by creation time, and sync.

## Shared modules

| File | Implements |
| --- | --- |
| `packages/core/page-identity.js` | Normalize URLs, generate file identifiers, and distinguish URL changes from full page loads |
| `packages/core/highlight-lifecycle.js` | Save selected text and locations, restore highlights, and repair marks after page content changes |
| `packages/core/markdown-extractor.js` | Live DOM-to-Markdown conversion for searchable snapshots |
| `packages/core/snapshot-html.js` | Validate saved URL/slug metadata, clean highlight markup, and prepare snapshots for reopening |
| `packages/core/bounded-response.js` | Streamed resource byte limits |
| `packages/core/snapshot-capture-budget.js` | Estimate snapshot message size, including embedded resources |
| `packages/core/search-runtime.js` | Parse queries and rank page title/URL matches |
| `packages/core/virtual-scroller.js` | Render rows near the visible area and preserve DOM state and reading position |
| `packages/core/time-chart.js` | Charts, date selection, and result filtering |
| `packages/core/attention-utils.js` | Attention scoring |
| `packages/core/i18n.js`, `packages/core/locales/` | Locale registry, complete catalogs, and localization runtime |
| `packages/core/utils.js`, `packages/core/entity-types.js` | Shared utilities and entity identifiers |

URL handling, highlights, and Markdown extraction use shared factories to generate
non-module content scripts. Change the shared code and check the build output;
do not maintain a second production copy.

## Builds and operational scripts

| Path | Purpose |
| --- | --- |
| `scripts/stage-app-assets.mjs` | Check translations and prepare extension/desktop assets |
| `scripts/desktop-build-plan.mjs` | Select platform-specific desktop artifacts and build steps |
| `scripts/build-tauri-app.mjs` | Run the standard desktop build |
| `scripts/collect-desktop-artifacts.mjs` | Replace build output, restore previous output on failure, and clean up locked Windows files |
| `scripts/finalize-desktop-build.mjs` | Desktop build finalization |
| `scripts/finalize-macos-app-bundle.mjs` | Sign local macOS builds with a stable app identifier |
| `scripts/verify-macos-app-bundle.mjs` | Bundle signature verification |
| `scripts/generate-icons.mjs` | Native-size desktop slots, toolbar icons, and tray assets |
| `scripts/manual-test-browser.mjs`, `scripts/lib/manual-seed.mjs` | Isolated manual browser/daemon workflow |
| `scripts/lib/seed-builder.mjs` | Generate test data by applying log events |
| `scripts/migrate-snapshot-identity.mjs` | Check and update snapshot URL/slug metadata through temporary-file replacement |
| `scripts/rust-coverage.mjs`, `scripts/test-coverage-monitor.mjs` | Coverage generation, uncovered-line reporting, and test-growth guard |
| `scripts/capture-documentation.mjs` | Native macOS desktop documentation capture |
| `scripts/capture-browser-documentation.mjs` | Native macOS browser documentation capture |
| `scripts/lib/documentation-seed.mjs` | Fictional reading collection |
| `scripts/lib/documentation-window.swift`, `scripts/lib/documentation-image-spec.mjs` | Operate native windows, capture screenshots, and define image dimensions |
| `scripts/lib/documentation-native-capture.mjs` | Shared native helper compilation, capture arguments, and pixel-stability checks |
| `scripts/assets/documentation-sonoma-light.png` | Fixed light Sonoma wallpaper, fingerprinted in documentation capture manifests |
| `scripts/compose-documentation-hero.mjs` | Combined Amber/Mono Timeline image |
| `scripts/lib/documentation-freshness.mjs`, `scripts/check-documentation-screenshots.mjs` | Check source-file hashes and saved documentation images |
| `scripts/export-chrome-web-store-screenshots.mjs`, `scripts/lib/store-screenshot.swift` | Export opaque 1280 × 800 Chrome Web Store screenshots, staging on the destination volume |
| `scripts/lib/store-screenshots.mjs` | Shared Chrome Web Store input fingerprints and PNG format validation for export and documentation checks |

## Verification map

| Behavior | Primary coverage |
| --- | --- |
| Shared JavaScript and build rules | `tests/unit/` |
| Pairing, command requests, events, and pending commands | `tests/integration/` |
| Matching page identifiers in JavaScript and Rust | `tests/integration/page-identity-parity.test.js` |
| Snapshot identity migration and CLI validation | `tests/integration/snapshot-identity-migration.test.js`, `tests/e2e/snapshot-slug-meta.spec.js` |
| Screenshot provenance, store format, and export failure handling | `tests/integration/documentation-freshness.test.js`, `tests/integration/store-screenshot-export.test.js` |
| Combined data reads and successful writes not yet saved to checkpoints | `crates/daemon/tests/read_projections.rs` |
| Commands, write ordering, and change notifications | `crates/daemon/tests/commands.rs`, `crates/daemon/tests/command_authority.rs`, `crates/daemon/tests/runtime.rs` |
| Replay schemas, idempotence, and verifier | `crates/replay/tests/` |
| Popup membership and prepared dashboard | `tests/e2e/popup-lists.spec.js` |
| Live navigation and correct URLs in visit records | `tests/e2e/extension-navigation-regressions.spec.js`, `tests/e2e/url-tracking.spec.js` |
| Highlight creation, editing, and PDF behavior | `tests/e2e/highlight-note-edit.spec.js` |
| Save when an editor or popup closes | `tests/e2e/note-dismiss-save.spec.js` |
| Snapshot URL/slug metadata, resources, frames, and shadow roots | `tests/e2e/snapshot-slug-meta.spec.js`, `tests/e2e/snapshot-resource-timeout.spec.js` |
| Seeded cross-feature workflows | `tests/e2e/seeded-combination-workflows.spec.js`, `tests/e2e/manual-seed-workflow.spec.js` |
| Desktop layout, navigation, search, and scroll retention | `tests/e2e/desktop-visual.spec.js` |
| Native WKWebView chart layout | `tests/smoke/macos-wkwebview-chart-layout.mjs` |
| macOS startup, tray, and window lifecycle | `tests/smoke/macos-desktop-window-lifecycle.mjs` |
| Windows icons, single instance, and teardown | `tests/smoke/windows-desktop-single-instance.mjs`, `tests/integration/windows-desktop-cleanup.test.js` |
| Saved desktop language and right-to-left layout | `tests/e2e/desktop-locale-setting.spec.js` |
| Native extension localization and system fonts | `tests/e2e/extension-localization.spec.js`, `tests/e2e/extension-font-fallback.spec.js` |
| Real Firefox and native popup shortcut | `tests/smoke/firefox-real-content.mjs`, `tests/smoke/native-extension-shortcut.mjs` |
| Documentation images match the recorded source files and capture results | `tests/integration/documentation-freshness.test.js` |
| Browser documentation capture | `tests/e2e/documentation-browser.spec.js` |

Desktop visual tests check layout and command calls with simulated Tauri responses.
Rust and native app tests check real daemon calls and operating-system behavior.
Native window tests cover selected scenarios; browser-rendered UI tests do not
exercise every native desktop interaction.

## User documents

- [README.md](../README.md): product introduction and demonstrations.
- [STORE_LISTING.md](STORE_LISTING.md): Chrome Web Store copy and shortcuts.
- [PRIVACY.md](PRIVACY.md): collected data, storage, permissions, and deletion.
- [AGENTS.md](../AGENTS.md): development rules and contribution workflow.
