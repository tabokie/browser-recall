# Browser Recall — Codebase Map

> Reference map for the current desktop-first product.

## Status Note

The codebase is organized around one main app plus one thin browser connector:

- `apps/desktop/` — desktop shell and main UI
- `apps/extension/` — Chrome connector and popup
- `crates/` — replay, search, and daemon back end
- `packages/` — shared JS/CSS modules

This map intentionally excludes removed extension-only storage/sync internals.

## Top-Level Layout

| Path | Role |
|------|------|
| `apps/desktop/ui/` | Main Browser Recall interface rendered in Tauri |
| `apps/desktop/src-tauri/` | Tauri shell, event bridge, OS integration |
| `apps/extension/` | Thin Chrome connector: capture, popup, pairing, buffering |
| `crates/daemon/` | Storage/search/sync/pairing command layer |
| `crates/replay/` | Authoritative replay engine and replay verifier |
| `crates/search/` | Native search helpers |
| `packages/core/` | Shared JS helpers, theme, CSS, runtime utilities |
| `icons/` | Root SVG sources for desktop and extension runtime icons |
| `tests/` | Unit, integration, and e2e coverage |
| `plans/` | Phase plans 29–34 for the desktop split |

## Core Runtime Files

| File | Role |
|------|------|
| `apps/desktop/ui/index.html` | Main desktop UI document |
| `apps/desktop/ui/index.js` | Ported main UI logic: history, lists, search, settings, recycle bin |
| `apps/desktop/ui/desktop-bridge.js` | Direct Tauri invoke helpers for desktop product actions and settings |
| `apps/desktop/ui/extension-api-shim.js` | Tauri-backed `chrome.*` compatibility layer for the ported UI |
| `apps/desktop/ui/bookmark-parser.js` | Desktop bookmark import parser |
| `apps/desktop/src-tauri/src/main.rs` | Tauri entry point, invoke bridge, daemon write routing, desktop events, window/deep-link handling |
| `apps/desktop/src-tauri/src/config.rs` | Desktop config loading/persistence helpers |
| `apps/desktop/src-tauri/src/login_item.rs` | Login-item integration for desktop startup behavior |
| `apps/desktop/src-tauri/src/search.rs` | Desktop-side search adapters/helpers |
| `apps/extension/background.js` | Thin connector runtime: prepared toolbar popup launch, popup RPC, buffering, pairing, snapshot/capture forwarding |
| `apps/extension/icon-paths.js` | Packaged default, stop-recording, and special-state toolbar icon paths |
| `apps/extension/background-test-control.js` | Test-only background RPC handlers staged by `tests/fixtures/test-extension.mjs` |
| `apps/extension/content.js` | Visit/attention capture, highlight selection helpers, and saved highlight reapply from pages |
| `apps/extension/popup.js` | Current-tab popup UI |
| `apps/extension/extension-surface.css` | Shared light paper styling for extension pages |
| `apps/extension/extension-surface.js` | Shared shadow-DOM styling and overlay placement helpers for extension content surfaces |
| `apps/extension/extension-ui-tokens.js` | Shared extension paper/error tokens and transient error popout styling |
| `apps/extension/savepage-bridge.js` | Save Page WE capture bridge |
| `apps/extension/connector/ws-client.js` | Connector websocket transport to daemon |
| `apps/extension/connector/pairing.js` | Pairing bootstrap and session helpers |
| `apps/extension/connector/command-buffer.js` | Outbound command buffering/flush helpers |
| `apps/extension/options-stub.html` | Stub page that points users to the desktop app |
| `crates/daemon/src/commands.rs` | Replay-backed command surface for desktop UI and shell |
| `crates/daemon/src/runtime.rs` | Shared replay overlay helpers used by daemon command/write paths |
| `crates/daemon/src/storage.rs` | Data-root storage, sharded object/view paths, coordinated cache reads, current projection cache, log append, and flushable ordered checkpoint worker |
| `crates/daemon/src/search.rs` | Daemon search queries over history/notes/snapshots |
| `crates/daemon/src/sync.rs` | GitHub sync controller, token handling, pause persistence |
| `crates/daemon/src/ws_server.rs` | Browser pairing, websocket RPC, change broadcasts |
| `crates/daemon/src/pairing.rs` | Pairing data/state helpers |
| `crates/replay/src/lib.rs` | Production replay engine |
| `crates/replay/src/bin/replay-verify.rs` | Full-log checkpoint verifier using the production replay and checkpoint policy |
| `crates/search/src/lib.rs` | Native search primitives |
| `scripts/stage-app-assets.mjs` | Stages loadable app assets under `dist/extension/{chrome,firefox}/` and `dist/desktop/ui/`, including filtered WebExtension locale files and the generated content-script page identity bridge |
| `scripts/collect-desktop-artifacts.mjs` | Collects Tauri release binaries and bundles into `dist/desktop/<platform>/` |
| `scripts/migrate-browser-data-schema.mjs` | Browser data migration utility for log/view/object schema changes, including URL identity canonicalization |
| `scripts/test-coverage-monitor.mjs` | Test investment and JS/Rust uncovered-line monitor; enforces no JS or inline Rust unit-test LoC growth |
| `scripts/generate-icons.mjs` | Renders root SVG icon sources into opaque desktop/extension icons, the transparent tray icon, and the macOS `.icns` pack |
| `packages/core/index.js` | Shared package exports |
| `packages/core/page-identity.js` | Shared page URL canonicalization and slug generation, plus generated classic-script bridge source for content scripts |
| `packages/core/utils.js` | Shared utility helpers that re-export page identity and provide connector request canonicalization |
| `packages/core/rule-engine.js` | Shared rule validation/matching helpers; keyword rules are title-only |
| `packages/core/search-helpers.js` | Shared query parsing/search helper logic |
| `packages/core/i18n.js` | Shared UI localization runtime for catalog lookup, document localization, and WebExtension i18n adaptation |
| `packages/core/locales/en/messages.json` | Canonical English message catalog, used by desktop UI assets and filtered into extension `/_locales` |
| `packages/core/locales/zh-CN/messages.json` | Simplified Chinese message catalog with the same keys and placeholders as English |
| `packages/core/time-chart.js` | Shared history chart rendering helpers |
| `packages/core/virtual-scroller.js` | Shared virtual scrolling helper |
| `packages/core/theme.js` | Shared theme/session helpers |

## Feature → Code Map

### Desktop UI

- `apps/desktop/ui/index.js` owns history rendering, lists, search, settings, recycle bin, imports, and mutation dispatch.
- Desktop UI localization uses `packages/core/i18n.js`; system locale comes from the Tauri shell, while `localeOverride` persists in daemon settings. Supported catalogs are `en` and `zh-CN`.
- `apps/desktop/ui/desktop-bridge.js` owns direct Tauri command dispatch for desktop product actions.
- `apps/desktop/ui/extension-api-shim.js` keeps only the remaining `chrome.*` compatibility surfaces needed by the ported UI.
- `apps/desktop/src-tauri/src/main.rs` forwards command results, change events, and storage updates into the webview.

### Connector Popup

- `apps/extension/popup.js` consumes prepared bootstrap payloads when present, requests page summaries as the direct-load fallback, submits popup mutations through a serialized UI lane, renders an open-popup snapshot without background mutation refreshes, and owns the transient list-picker/search keyboard UI.
- Extension UI and manifest localization use browser-native WebExtension `i18n` files staged from `packages/core/locales/`; only `extension*`, `command*`, and `common*` keys are packaged. The extension follows the browser's UI locale and does not persist a product locale override.
- `apps/extension/background.js` resolves popup actions through the daemon connection. Toolbar clicks prepare current-tab and daemon popup data before opening `popup.html?bootstrap=...`, avoiding a manifest `default_popup` first frame. Prepared popup data is handed off by a one-shot in-memory token, has a bounded timeout, and falls back to an extension tab when an engine lacks programmatic action popups. Test-only background RPCs are split into `apps/extension/background-test-control.js` and included only in staged test extensions.
- `apps/extension/icon-paths.js` defines packaged toolbar icon sets for normal capture, paused recording, and special page-marker states; `apps/extension/badge-controller.js` applies those icons at runtime.
- `apps/extension/options-stub.js` only opens the desktop app; it is not a settings surface.

### Capture Path

- `apps/extension/content.js` captures visit/attention signals and owns page-local highlight range work, including structured selection text for context-menu highlights and reapplying saved highlight notes into the DOM. Staged builds load `browser-recall-page-identity.js` before `content.js`, generated from `packages/core/page-identity.js`, so classic content scripts share the same page slug implementation as module code.
- `apps/extension/savepage-bridge.js` performs snapshot capture.
- `apps/extension/background.js` buffers and forwards capture events to the daemon, and injects a page reload warning when shortcut/context-menu actions cannot reach a stale content script.
- `apps/extension/popup.js` surfaces popup-initiated capture failures through page notifications with popup-bubble fallback.

### Replay and Storage

- `crates/replay/` is the production replay engine and owns replay-derived checkpoint policy used by verification and daemon persistence.
- `packages/core/page-identity.js` canonicalizes extension-originated page URLs before they are sent to desktop, removing underscore-prefixed query params while keeping ordinary query params and fragments. `packages/core/utils.js`, migration scripts, integration tests, and the generated content-script bridge all use that shared implementation. `crates/replay/src/lib.rs` hashes the URL it receives; non-extension producers must send canonical URLs to get the same identity behavior.
- `crates/daemon/src/storage.rs` owns coordinated cache-miss reads, serialized write coordination, synchronous log append helpers, history file/device-directory listing, checkpoint-capacity reservation, ordered async checkpoint persistence, replay progress, and the current `logs/`, `objects/`, `views/` path layout.
- `crates/daemon/src/commands.rs` exposes replay-backed reads and mutations to the desktop shell and keeps command-only fields out of JSONL.
- `crates/daemon/src/runtime.rs` provides shared replay overlay helpers used by command, websocket, and sync write paths.

### Search

- `crates/search/` and `crates/daemon/src/search.rs` implement history identity search plus dedicated note/snapshot text search. History search also exposes a fixed-parallelism chunk callback for desktop streaming and cancellation.
- `apps/desktop/src-tauri/src/main.rs` exposes `search_history_stream` / `cancel_history_search` Tauri commands and emits `bridge-search-history` chunks to the UI.
- `crates/daemon/src/ws_server.rs` exposes equivalent websocket `search_history_stream` / `cancel_history_search` support.
- `apps/desktop/ui/index.js` keeps typed search text as a draft until Enter commits it, then merges streamed history chunks with note/snapshot result phases, renders committed search results directly from the in-memory result set, renders Explore device filters from daemon-reported `logs/<device>/` directories, and cancels stale history searches when a newer search starts.
- `packages/core/search-helpers.js` and `packages/core/search-runtime.js` provide UI-facing helpers and the shared phase-0 identity scorer used by the desktop UI and tests.

### Pairing and Live Updates

- `crates/daemon/src/ws_server.rs` owns paired-browser websocket sessions.
- `apps/extension/connector/pairing.js` and `apps/extension/connector/ws-client.js` manage the browser side.
- `apps/desktop/src-tauri/src/main.rs` rebroadcasts daemon change notifications to desktop webviews.
- Authenticated connector sockets also receive daemon change notifications for live connector surfaces such as tab badges. Open popups intentionally do not refresh from background mutation broadcasts; they read fresh page data on the next open.

### Sync

- `crates/daemon/src/sync.rs` owns GitHub sync orchestration, auth/token handling, and persisted sync pause state.
- `apps/desktop/ui/index.js` edits sync settings and renders sync status.
- Connector websocket RPCs do not expose sync file or manifest operations.

## Current Test Coverage

| Path | Coverage |
|------|----------|
| `tests/unit/` | Shared JS helpers, rule helpers, charts, scrollers, and connector-side utilities |
| `tests/integration/popup-rpc.test.js` | Popup ↔ daemon RPC integration |
| `tests/integration/pairing.test.js` | Browser pairing flow |
| `tests/integration/event-flow.test.js` | Connector event flow into the daemon |
| `tests/e2e/popup-lists.spec.js` | Popup list interactions in the shipped connector |
| `tests/e2e/badge.spec.js` | Popup/badge behavior in the shipped connector |
| `tests/e2e/extension-error-popouts.spec.js` | Browser-level extension popup and snapshot error popout styling |
| `tests/e2e/seeded-combination-workflows.spec.js` | Seeded randomized extension workflow combining visits, notes, list pins, and popup reads |
| `scripts/test-coverage-monitor.mjs` | Test-suite LoC mix and JS/Rust uncovered production line reporting |
| `crates/daemon/tests/commands.rs` | Desktop command-surface coverage |
| `crates/daemon/tests/sync_controller.rs` | Daemon sync-controller coverage |

## Remaining Intentional Gap

The full desktop smoke / GUI parity suite is still intentionally absent. Everything else in this map refers to code that is present and part of the active product path.
