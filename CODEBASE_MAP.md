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
| `apps/extension/background.js` | Thin connector runtime: popup RPC, buffering, pairing, snapshot/capture forwarding |
| `apps/extension/background-test-control.js` | Test-only background RPC handlers staged by `tests/fixtures/test-extension.mjs` |
| `apps/extension/content.js` | Visit/attention capture from pages |
| `apps/extension/popup.js` | Current-tab popup UI |
| `apps/extension/extension-surface.css` | Shared dark ledger styling for extension pages |
| `apps/extension/extension-surface.js` | Shared shadow-DOM styling and overlay placement helpers for extension content surfaces |
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
| `scripts/test-coverage-monitor.mjs` | Test investment and JS/Rust uncovered-line monitor; enforces no JS or inline Rust unit-test LoC growth |
| `packages/core/index.js` | Shared package exports |
| `packages/core/rule-engine.js` | Shared rule validation/matching helpers; keyword rules are title-only |
| `packages/core/search-helpers.js` | Shared query parsing/search helper logic |
| `packages/core/time-chart.js` | Shared history chart rendering helpers |
| `packages/core/virtual-scroller.js` | Shared virtual scrolling helper |
| `packages/core/theme.js` | Shared theme/session helpers |

## Feature → Code Map

### Desktop UI

- `apps/desktop/ui/index.js` owns history rendering, lists, search, settings, recycle bin, imports, and mutation dispatch.
- `apps/desktop/ui/desktop-bridge.js` owns direct Tauri command dispatch for desktop product actions.
- `apps/desktop/ui/extension-api-shim.js` keeps only the remaining `chrome.*` compatibility surfaces needed by the ported UI.
- `apps/desktop/src-tauri/src/main.rs` forwards command results, change events, and storage updates into the webview.

### Connector Popup

- `apps/extension/popup.js` requests page summaries, submits popup mutations, refreshes the current page dashboard from background mutation broadcasts, and owns the transient list-picker/search keyboard UI.
- `apps/extension/background.js` resolves popup actions through the daemon connection. Test-only background RPCs are split into `apps/extension/background-test-control.js` and included only in staged test extensions.
- `apps/extension/options-stub.js` only opens the desktop app; it is not a settings surface.

### Capture Path

- `apps/extension/content.js` captures visit/attention signals.
- `apps/extension/savepage-bridge.js` performs snapshot capture.
- `apps/extension/background.js` buffers and forwards capture events to the daemon, and injects a page reload warning when shortcut/context-menu actions cannot reach a stale content script.
- `apps/extension/popup.js` surfaces popup-initiated capture failures through page notifications with popup-bubble fallback.

### Replay and Storage

- `crates/replay/` is the production replay engine and owns replay-derived checkpoint policy used by verification and daemon persistence.
- `crates/daemon/src/storage.rs` owns coordinated cache-miss reads, serialized write coordination, synchronous log append helpers, checkpoint-capacity reservation, ordered async checkpoint persistence, replay progress, and the current `logs/`, `objects/`, `views/` path layout.
- `crates/daemon/src/commands.rs` exposes replay-backed reads and mutations to the desktop shell, canonicalizes log entries before append, and keeps command-only fields out of JSONL.
- `crates/daemon/src/runtime.rs` provides shared replay overlay helpers used by command, websocket, and sync write paths.

### Search

- `crates/search/` and `crates/daemon/src/search.rs` implement history/note/snapshot search. History search also exposes a fixed-parallelism chunk callback for desktop streaming and cancellation.
- `apps/desktop/src-tauri/src/main.rs` exposes `search_history_stream` / `cancel_history_search` Tauri commands and emits `bridge-search-history` chunks to the UI.
- `crates/daemon/src/ws_server.rs` exposes equivalent websocket `search_history_stream` / `cancel_history_search` support and keeps legacy `search_history` on the same parallel helper.
- `apps/desktop/ui/index.js` merges streamed history chunks with note/snapshot result phases and cancels stale history searches when a newer search starts.
- `packages/core/search-helpers.js` and `packages/core/search-runtime.js` provide UI-facing helpers shared by the desktop UI and tests.

### Pairing and Live Updates

- `crates/daemon/src/ws_server.rs` owns paired-browser websocket sessions.
- `apps/extension/connector/pairing.js` and `apps/extension/connector/ws-client.js` manage the browser side.
- `apps/desktop/src-tauri/src/main.rs` rebroadcasts daemon change notifications to desktop webviews.
- Authenticated connector sockets also receive daemon change notifications for live popup/badge refresh.

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
| `tests/e2e/seeded-combination-workflows.spec.js` | Seeded randomized extension workflow combining visits, notes, list pins, and popup reads |
| `scripts/test-coverage-monitor.mjs` | Test-suite LoC mix and JS/Rust uncovered production line reporting |
| `crates/daemon/tests/commands.rs` | Desktop command-surface coverage |
| `crates/daemon/tests/sync_controller.rs` | Daemon sync-controller coverage |

## Remaining Intentional Gap

The full desktop smoke / GUI parity suite is still intentionally absent. Everything else in this map refers to code that is present and part of the active product path.
