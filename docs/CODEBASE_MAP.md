# Browser Recall — Codebase Map

Use [Architecture](ARCHITECTURE.md) for behavior, [Development](../DEVELOPMENT.md)
for commands, and [Testing](TESTING.md) for coverage boundaries.

## Repository layout

| Path                      | Responsibility                                            |
| ------------------------- | --------------------------------------------------------- |
| `apps/desktop/ui/`        | Desktop interface                                         |
| `apps/desktop/src-tauri/` | Tauri shell and native integrations                       |
| `apps/extension/`         | Chromium/Firefox connector                                |
| `crates/daemon/`          | Commands, storage, pairing, rules, sync                   |
| `crates/replay/`          | Schemas, replay, checkpoints, verification                |
| `crates/search/`          | Native search                                             |
| `crates/native-tests/`    | Minimal AppKit tests importing production code            |
| `packages/core/`          | Shared JavaScript, CSS, localization, generated factories |
| `scripts/`                | Builds, migrations, coverage, capture                     |
| `tests/`                  | JavaScript, browser, and native scenarios                 |
| `icons/`, `docs/images/`  | Icon sources, screenshots, capture manifests              |
| `website/`                | Static product page and fictional demos                   |
| `plans/`                  | Historical proposals and implementation records           |

## Desktop

Paths below are relative to `apps/desktop/`.

| File                                                                | Responsibility                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ui/index.html`, `ui/index.js`                                      | Layout, navigation, data views, refreshes                             |
| `ui/desktop-bridge.js`, `ui/desktop-platform.js`                    | Validated Tauri commands and platform APIs                            |
| `ui/book-elements.js`, `ui/book-typesetting.js`                     | Shared Book markup and Justif layout                                  |
| `ui/timeline-elements.js`                                           | Timeline rows shared with website demos                               |
| `ui/sidebar-elements.js`                                            | List controls shared with website demos                               |
| `ui/bookmark-parser.js`                                             | Bookmark HTML parsing                                                 |
| `ui/shared.css`, `ui/fonts/`                                        | Typography and bundled fonts                                          |
| `ui/desktop-reviews.js`, `ui/desktop-updates.js`                    | Review opportunities/cancellation and update controls                 |
| `src-tauri/src/main.rs`                                             | Daemon lifecycle, commands, events, tray, deep links, single instance |
| `src-tauri/src/config.rs`, `src-tauri/src/shell_contract.rs`        | Local setup and shell response types                                  |
| `src-tauri/src/snapshot_open.rs`                                    | Open snapshots or select files in the file manager                    |
| `src-tauri/src/distribution.rs`                                     | Distribution channel and test-profile restrictions                    |
| `src-tauri/src/reviews.rs`, `src-tauri/src/reviews_native.rs`       | Review scheduling, persistence, AppKit dispatch                       |
| `src-tauri/src/reviews.swift`, `src-tauri/storekit_build.rs`        | StoreKit bridge and build integration                                 |
| `src-tauri/src/updates.rs`                                          | Authenticated update lifecycle                                        |
| `src-tauri/src/login_item.rs`                                       | Launch-at-login registration and rollback                             |
| `src-tauri/src/windows_icon.rs`, `src-tauri/src/windows_startup.rs` | Windows icons and early test-profile diagnostics                      |
| `src-tauri/src/macos_window_frame.rs`                               | Exact AppKit frame preservation                                       |
| `src-tauri/src/search.rs`, `src-tauri/src/logging.rs`               | Search adapter and native logs                                        |
| `src-tauri/capabilities/main.json`                                  | Webview permissions                                                   |

## Browser connector

Paths below are relative to `apps/extension/`.

| File                                                                      | Responsibility                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `manifest.json`                                                           | Permissions, entry points, shortcuts                                                       |
| `background.js`                                                           | Navigation, page identity inspection, popup preparation, command routing, capture          |
| `recording-controller.js`                                                 | Recording eligibility, pause-aware attention, command admission                            |
| `content.js`, `spa-navigation-bridge.js`                                  | Capture and page-world navigation detection                                                |
| `browser-api.js`, `browser-privileged-api.js`                             | Browser APIs and background-only validation                                                |
| `browser-capabilities.js`                                                 | Browser response capabilities and scripting error classification                           |
| `browser-identity.js`, `browser-build-target.js`                          | Browser identity and generated build target                                                |
| `popup.js`, `popup.html`, `popup-note-session.js`                         | Dashboard, sizing, list edits, note drafts                                                 |
| `popup-list-elements.js`                                                  | List markup shared with website demos                                                      |
| `extension-surface.js`, `extension-surface.css`, `extension-ui-tokens.js` | Isolated editors, highlights, overlays, shared persistent error renderer                   |
| `connector/ws-client.js`                                                  | Sessions, validation, requests, queue draining                                             |
| `connector/state.js`, `connector/pairing.js`                              | Connection diagnostics and authentication                                                  |
| `connector/command-buffer.js`                                             | Bounded temporary command storage                                                          |
| `savepage-bridge.js`, `snapshot-resource-fetch.js`                        | Capture sessions, resource policy, diagnostics                                             |
| `savepage/`                                                               | Maintained Save Page WE fork; see [Upstream notes](../apps/extension/savepage/UPSTREAM.md) |
| `snapshot-viewer.js`                                                      | Snapshot preparation and highlight adapters                                                |
| `options-stub.html`, `options-stub.js`                                    | Desktop link and shortcut display                                                          |
| `background-test-control.js`                                              | Test-only handlers omitted from production                                                 |

## Daemon and replay

Paths below are relative to `crates/`.

| File                                                                   | Responsibility                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `daemon/src/lib.rs`, `daemon/src/main.rs`                              | Startup API and standalone CLI                                |
| `daemon/src/command_authority.rs`, `daemon/src/commands.rs`            | Shared command validation and execution                       |
| `daemon/src/runtime.rs`                                                | Transactions, write order, recovery, sync installation, reset |
| `daemon/src/storage.rs`                                                | Cache, disk reads, log index, checkpoint writer               |
| `daemon/src/read_projections.rs`, `daemon/src/mutations.rs`            | View responses and change notifications                       |
| `daemon/src/config.rs`                                                 | Locked configuration upgrades and atomic persistence          |
| `daemon/src/capture_policy.rs`, `daemon/src/rules.rs`                  | Recording policy, rule previews/matching                      |
| `daemon/src/search.rs`                                                 | Search adapters                                               |
| `daemon/src/protocol.rs`, `daemon/src/ws_server.rs`                    | Connector protocol and authenticated server                   |
| `daemon/src/pairing.rs`, `daemon/src/connectors.rs`                    | Pairing and connector identities                              |
| `daemon/src/sync.rs`                                                   | GitHub transport, credentials, scheduling                     |
| `daemon/src/data_directory_docs.rs`, `daemon/resources/data-AGENTS.md` | Managed data-folder guide                                     |
| `replay/src/lib.rs`, `replay/src/handlers/`                            | Strict parsing and idempotent replay                          |
| `replay/src/entities.rs`, `replay/src/settings.rs`                     | Checkpoint/settings schemas                                   |
| `replay/src/bin/replay-tool.rs`, `replay/src/bin/replay-verify.rs`     | Replay and production verification CLIs                       |
| `search/src/lib.rs`                                                    | Search ranking and file discovery                             |

## Shared modules

Paths below are relative to `packages/core/`.

| File                                                | Responsibility                                              |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `page-identity.js`                                  | URL normalization, slugs, availability, navigation identity |
| `highlight-lifecycle.js`                            | Selection, anchors, restoration, repair, mark ownership     |
| `markdown-extractor.js`, `snapshot-html.js`         | Snapshot text and HTML preparation                          |
| `bounded-response.js`, `snapshot-capture-budget.js` | Resource and transport byte limits                          |
| `search-runtime.js`, `attention-utils.js`           | Search and attention calculations                           |
| `virtual-scroller.js`, `time-chart.js`              | Virtual rows, scroll retention, time filtering              |
| `i18n.js`, `locales/`                               | Locale registry, catalogs, runtime                          |
| `utils.js`, `entity-types.js`                       | Shared utilities and entity identifiers                     |

## Builds and scripts

Paths below are relative to `scripts/` unless stated otherwise.

| File                                                                                              | Responsibility                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `stage-app-assets.mjs`, `desktop-build-plan.mjs`                                                  | Asset staging and platform selection                      |
| `build-desktop.mjs`, `build-tauri-app.mjs`, `build-release-desktop.mjs`                           | Local/release build orchestration                         |
| `collect-desktop-artifacts.mjs`, `finalize-desktop-build.mjs`                                     | Verified output replacement and recovery                  |
| `lib/desktop-signing.mjs`, `windows-code-signing.ps1`                                             | Certificate selection and signing                         |
| `finalize-macos-app-bundle.mjs`, `verify-macos-app-bundle.mjs`                                    | macOS signing and verification                            |
| `lib/desktop-disk-image.mjs`, `create-update-manifest.mjs`                                        | Disk images and updater metadata                          |
| `prepare-ci-release.mjs`, `verify-windows-installed-executable.mjs`                               | Disposable signing setup and installer payload comparison |
| `lib/product-version.mjs`, `lib/build-timing.mjs`                                                 | Version validation and phase timing                       |
| `dev-desktop.mjs`, `lib/macos-native-session.mjs`                                                 | Guarded native launches                                   |
| `manual-test-browser.mjs`, `lib/manual-seed.mjs`, `lib/seed-builder.mjs`                          | Manual fixtures and daemon-backed seeding                 |
| `migrate-snapshot-identity.mjs`                                                                   | Snapshot metadata migration                               |
| `rust-coverage.mjs`, `test-coverage-monitor.mjs`                                                  | Coverage and test-growth guard                            |
| `generate-icons.mjs`                                                                              | Native icon slots, extension/tray assets                  |
| `capture-documentation.mjs`, `capture-browser-documentation.mjs`                                  | Desktop/browser captures                                  |
| `lib/documentation-details.mjs`                                                                   | Native bookmark import and clipboard scenarios            |
| `lib/documentation-detail-media.mjs`, `lib/documentation-detail-media.swift`                      | Cropped GIFs, still images, and capture provenance        |
| `lib/documentation-detail-check.mjs`                                                              | GIF structure, looping, and provenance checks             |
| `documentation-tauri.conf.json`, `documentation-info.plist`, `verify-macos-documentation-app.mjs` | No-tray/no-URL-scheme capture bundles                     |
| `lib/documentation-seed.mjs`, `lib/documentation-window.swift`                                    | Capture data and native window control                    |
| `lib/documentation-native-capture.mjs`, `lib/documentation-image-spec.mjs`                        | Compilation, geometry, pixel stability                    |
| `lib/documentation-freshness.mjs`, `check-documentation-screenshots.mjs`                          | Capture fingerprints and image checks                     |
| `compose-documentation-hero.mjs`, `export-chrome-web-store-screenshots.mjs`                       | Hero composition and store exports                        |
| `lib/store-screenshots.mjs`, `lib/store-screenshot.swift`                                         | Store provenance and RGB conversion                       |
| `select-platform-checks.mjs`                                                                      | Relevant-change selection for expensive checks            |
| `build-website.mjs`, `serve-website.mjs`                                                          | Static build and project-path preview                     |

Website presentation lives in `website/demos/`; HTTPS page-view counting lives in
`website/analytics.js`. `website/downloads.js` resolves the latest Windows installer.
`playwright.website.config.js` and `tests/website/` cover website behavior.

| Workflow/configuration                                  | Responsibility                                               |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `.github/workflows/ci.yml`                              | Regular verification matrix                                  |
| `.github/workflows/desktop-release-validation.yml`      | Native packages, installation, updates, platform regressions |
| `.github/workflows/release.yml`                         | Manual verified release publication                          |
| `.github/workflows/website.yml`                         | Website checks and GitHub Pages deployment                   |
| `package.json`, `rust-toolchain.toml`, `.gitattributes` | Commands, Rust pin, checkout line endings                    |

## Verification

Entry points in `apps/` and `crates/` are repository-relative; other paths are
relative to `tests/`. Search neighboring scenarios before adding coverage.

`crates/daemon/tests/windows_device_identity.rs` verifies that Windows device
identity matches `MachineGuid` when registry subprocesses are unavailable. The
Windows native job runs this check before packaging.

| Behavior                                        | Entry point                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daemon commands, writes, projections, shutdown  | `crates/daemon/tests/`                                                                                                                                                               |
| Replay, strict schemas, verifier                | `crates/replay/tests/`                                                                                                                                                               |
| Config upgrades                                 | `crates/daemon/tests/config_upgrade.rs`                                                                                                                                              |
| Cross-language page identity                    | `integration/page-identity-parity.test.js`                                                                                                                                           |
| Recording and navigation                        | `e2e/recording-lifecycle.spec.js`, `e2e/extension-navigation-regressions.spec.js`                                                                                                    |
| Popup membership, native sizing, startup errors | `e2e/popup-lists.spec.js`, `fixtures/popup-startup-failure.mjs`                                                                                                                      |
| Highlights and editor closing                   | `e2e/highlight-note-edit.spec.js`, `e2e/note-dismiss-save.spec.js`                                                                                                                   |
| Snapshots and migration                         | `e2e/snapshot-slug-meta.spec.js`, `e2e/snapshot-resource-timeout.spec.js`, `integration/snapshot-identity-migration.test.js`                                                         |
| Combined workflows and manual seeds             | `e2e/seeded-combination-workflows.spec.js`, `e2e/manual-seed-workflow.spec.js`                                                                                                       |
| Desktop layout, search, navigation, scroll      | `e2e/desktop-visual.spec.js`                                                                                                                                                         |
| Review timing and native presentation           | `apps/desktop/src-tauri/tests/reviews.rs`, `smoke/macos-review-presentation.mjs`                                                                                                     |
| Update signatures and real relaunch             | `apps/desktop/src-tauri/tests/desktop_updates.rs`, `smoke/desktop-update-lifecycle.mjs`                                                                                              |
| macOS chart, tray, frame, URL routing           | `smoke/macos-wkwebview-chart-layout.mjs`, `smoke/macos-desktop-window-lifecycle.mjs`, `crates/native-tests/tests/macos_window_frame.rs`, `smoke/macos-documentation-url-routing.mjs` |
| Native session guards and cleanup               | `integration/macos-native-session.test.js`, `integration/macos-desktop-cleanup.test.js`, `integration/windows-desktop-cleanup.test.js`                                               |
| Windows icons, visibility, single instance      | `smoke/windows-desktop-single-instance.mjs`, `integration/windows-desktop-cleanup.test.js`                                                                                           |
| Windows signing and update isolation            | `integration/windows-code-signing.test.js`, `integration/windows-update-environment.test.js`                                                                                         |
| PowerShell prerequisites and validation gates   | `integration/powershell-prerequisites.test.js`, `integration/ci-release-validation.test.js`                                                                                          |
| Diagnostic/cleanup error preservation           | `integration/extension-test-cleanup.test.js`, `integration/smoke-process-readiness.test.js`                                                                                          |
| Startup deadlines and bounded native probes     | `smoke/desktop-process-readiness.mjs`, `integration/desktop-process-readiness.test.js`                                                                                               |
| Localization and fonts                          | `e2e/desktop-locale-setting.spec.js`, `e2e/extension-localization.spec.js`, `e2e/extension-font-fallback.spec.js`                                                                    |
| Real Firefox and native shortcuts               | `smoke/firefox-real-content.mjs`, `smoke/native-extension-shortcut.mjs`                                                                                                              |
| Capture provenance and store export             | `integration/documentation-freshness.test.js`, `integration/store-screenshot-export.test.js`                                                                                         |

## Reference documents

- [Development](../DEVELOPMENT.md): setup, builds, releases, data maintenance.
- [Testing](TESTING.md): fixture rules, platform boundaries, CI diagnosis.
- [Documentation](DOCUMENTATION.md): editorial review and screenshot maintenance.
- [Release validation performance](DESKTOP_RELEASE_VALIDATION_PERFORMANCE.md): measurements and decisions.
- [Store listing](STORE_LISTING.md) and [Privacy](PRIVACY.md): publication copy.
