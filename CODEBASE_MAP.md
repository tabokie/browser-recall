# Browser Recall — Codebase Map

> Reference map for the current desktop-first product.

## Status Note

The codebase is organized around one main app plus one thin browser connector:

- `apps/desktop/` — desktop shell and main UI
- `apps/extension/` — Chrome connector and popup
- `crates/` — replay, search, and daemon back end
- `packages/` — shared JS/CSS/protocol modules

This map intentionally excludes removed extension-only storage/sync internals.

## Top-Level Layout

| Path | Role |
|------|------|
| `apps/desktop/ui/` | Main Browser Recall interface rendered in Tauri |
| `apps/desktop/src-tauri/` | Tauri shell, event bridge, OS integration |
| `apps/extension/` | Thin Chrome connector: capture, popup, pairing, buffering |
| `crates/daemon/` | Storage/search/sync/pairing command layer |
| `crates/replay/` | Authoritative replay engine for production |
| `crates/search/` | Native search helpers |
| `packages/core/` | Shared JS helpers, theme, CSS, runtime utilities |
| `packages/protocol/` | Shared protocol schema/message definitions |
| `tests/` | Unit, integration, and e2e coverage |
| `plans/` | Phase plans 29–34 for the desktop split |

## Core Runtime Files

| File | Role |
|------|------|
| `apps/desktop/ui/index.html` | Main desktop UI document |
| `apps/desktop/ui/index.js` | Ported main UI logic: history, lists, search, settings, recycle bin |
| `apps/desktop/ui/extension-api-shim.js` | Tauri-backed `chrome.*` compatibility layer for the ported UI |
| `apps/desktop/ui/bookmark-parser.js` | Desktop bookmark import parser |
| `apps/desktop/src-tauri/src/main.rs` | Tauri entry point, invoke bridge, desktop events, window/deep-link handling |
| `apps/desktop/src-tauri/src/config.rs` | Desktop config loading/persistence helpers |
| `apps/desktop/src-tauri/src/login_item.rs` | Login-item integration for desktop startup behavior |
| `apps/desktop/src-tauri/src/search.rs` | Desktop-side search adapters/helpers |
| `apps/extension/background.js` | Thin connector runtime: popup RPC, buffering, pairing, snapshot/capture forwarding |
| `apps/extension/content.js` | Visit/attention capture from pages |
| `apps/extension/popup.js` | Current-tab popup UI |
| `apps/extension/savepage-bridge.js` | Save Page WE capture bridge |
| `apps/extension/connector/ws-client.js` | Connector websocket transport to daemon |
| `apps/extension/connector/pairing.js` | Pairing bootstrap and session helpers |
| `apps/extension/connector/event-buffer.js` | Outbound event buffering/flush helpers |
| `apps/extension/options-stub.html` | Stub page that points users to the desktop app |
| `crates/daemon/src/commands.rs` | Replay-backed command surface for desktop UI and shell |
| `crates/daemon/src/storage.rs` | Filesystem/data-root storage implementation |
| `crates/daemon/src/search.rs` | Daemon search queries over history/notes/snapshots |
| `crates/daemon/src/sync.rs` | GitHub sync controller, token handling, pause persistence |
| `crates/daemon/src/ws_server.rs` | Browser pairing, websocket RPC, change broadcasts |
| `crates/daemon/src/pairing.rs` | Pairing data/state helpers |
| `crates/replay/src/lib.rs` | Production replay engine |
| `crates/search/src/lib.rs` | Native search primitives |
| `packages/core/index.js` | Shared package exports |
| `packages/core/rule-engine.js` | Shared rule validation/matching helpers |
| `packages/core/search-helpers.js` | Shared query parsing/search helper logic |
| `packages/core/time-chart.js` | Shared history chart rendering helpers |
| `packages/core/virtual-scroller.js` | Shared virtual scrolling helper |
| `packages/core/theme.js` | Shared theme/session helpers |
| `packages/protocol/src/messages.js` | Protocol message definitions shared across boundaries |

## Feature → Code Map

### Desktop UI

- `apps/desktop/ui/index.js` owns history rendering, lists, search, settings, recycle bin, imports, and mutation dispatch.
- `apps/desktop/ui/extension-api-shim.js` makes the ported UI work without rewriting every `chrome.*` call site.
- `apps/desktop/src-tauri/src/main.rs` forwards command results, change events, and storage updates into the webview.

### Connector Popup

- `apps/extension/popup.js` requests page summaries and submits popup mutations.
- `apps/extension/background.js` resolves popup actions through the daemon connection.
- `apps/extension/options-stub.js` only opens the desktop app; it is not a settings surface.

### Capture Path

- `apps/extension/content.js` captures visit/attention signals.
- `apps/extension/savepage-bridge.js` performs snapshot capture.
- `apps/extension/background.js` buffers and forwards capture events to the daemon.

### Replay and Storage

- `crates/replay/` is the production replay engine.
- `crates/daemon/src/storage.rs` reads/writes the data root and derived checkpoint files.
- `crates/daemon/src/commands.rs` exposes replay-backed reads and mutations to the desktop shell.

### Search

- `crates/search/` and `crates/daemon/src/search.rs` implement history/note/snapshot search.
- `packages/core/search-helpers.js` and `packages/core/search-runtime.js` provide UI-facing helpers shared by the desktop UI and tests.

### Pairing and Live Updates

- `crates/daemon/src/ws_server.rs` owns paired-browser websocket sessions.
- `apps/extension/connector/pairing.js` and `apps/extension/connector/ws-client.js` manage the browser side.
- `apps/desktop/src-tauri/src/main.rs` rebroadcasts daemon change notifications to desktop webviews.

### Sync

- `crates/daemon/src/sync.rs` owns GitHub sync orchestration, auth/token handling, and persisted sync pause state.
- `apps/desktop/ui/index.js` edits sync settings and renders sync status.

## Current Test Coverage

| Path | Coverage |
|------|----------|
| `tests/unit/` | Shared JS helpers, rule helpers, charts, scrollers, and connector-side utilities |
| `tests/integration/popup-rpc.test.js` | Popup ↔ daemon RPC integration |
| `tests/integration/pairing.test.js` | Browser pairing flow |
| `tests/integration/event-flow.test.js` | Connector event flow into the daemon |
| `tests/e2e/popup-lists.spec.js` | Popup list interactions in the shipped connector |
| `tests/e2e/badge.spec.js` | Popup/badge behavior in the shipped connector |
| `crates/daemon/tests/commands.rs` | Desktop command-surface coverage |
| `crates/daemon/tests/sync_controller.rs` | Daemon sync-controller coverage |

## Remaining Intentional Gap

The full desktop smoke / GUI parity suite is still intentionally absent. Everything else in this map refers to code that is present and part of the active product path.
