# Browser Recall — Architecture

> Keep this document aligned with the shipped desktop-first product.

## Status Note

The current product is desktop-first:

- `apps/desktop/ui/` is the main UI.
- `apps/desktop/src-tauri/` is the shell bridge and desktop runtime.
- `crates/daemon/` owns storage, replay-backed commands, pairing, search, and sync.
- `apps/extension/` is the Chrome connector for capture, popup actions, pairing, and short-lived buffering.

This document intentionally describes the current architecture only. Historical extension-only internals are no longer authoritative.

## Product Topology

```text
desktop UI (apps/desktop/ui)
  ↓ invoke / event bridge
tauri shell (apps/desktop/src-tauri)
  ↓ direct Rust calls
daemon crate (crates/daemon)
  ↓ uses
replay + search crates (crates/replay, crates/search)
  ↓ reads/writes
data directory (logs, pages, lists, notes, snapshots, manifest)

chrome connector (apps/extension)
  ↓ websocket pairing / RPC
daemon websocket server
```

## Storage Layout

```text
<root>/
  data/
    logs/<device>/<YYYY-MM-DD>.jsonl
    notes/<noteSlug>.json
    snapshots/<slug>-<ts>/
  pages/
    <slug>.json
  lists/
    <listId>.json
  manifest/
    list-order.json
    list-name-to-id.json
    orphaned.json
    settings.json
```

- `data/logs/*` is the append-only event log and source of truth.
- `pages/`, `lists/`, and `manifest/` are replay-derived checkpoints.
- Notes and snapshots stay in `data/` because they are durable user artifacts referenced by replay state.

## Event-Sourced Model

Every mutation is represented as an event and applied through replay.

- Production replay lives in `crates/replay/`.
- The desktop shell and daemon use replay-backed command helpers from `crates/daemon/src/commands.rs`.

Key consequences:

- Log files are authoritative; checkpoints are rebuildable.
- Replay branches must stay idempotent.
- Desktop UI, extension popup, and sync ingestion all converge on the same replay model.

## Desktop App

### UI Runtime

`apps/desktop/ui/index.html` and `apps/desktop/ui/index.js` are the main product surface. The UI is a near-verbatim port of the old extension UI, but it now runs inside Tauri with `apps/desktop/ui/extension-api-shim.js` providing the `chrome.*` surfaces the port still expects.

The shim currently covers:

- `chrome.runtime.sendMessage` → Tauri invoke bridge
- `chrome.storage.session` / `chrome.storage.local`
- `chrome.storage.onChanged` cross-window propagation
- tab/open helpers needed by the ported UI

### Shell Bridge

`apps/desktop/src-tauri/src/main.rs` is responsible for:

- window lifecycle and deep links
- invoking daemon-backed commands
- broadcasting storage changes and replay-derived mutations to webviews
- pairing/session state needed by the desktop app

The Tauri layer is intentionally thin; storage/search/replay behavior lives in `crates/daemon/`.

### Daemon Commands

`crates/daemon/src/commands.rs` backs the desktop command surface, including:

- read-cache and entity/page payload reads
- bookmark import and history import
- note/list/snapshot/settings mutations
- rule preview and rule updates
- generic replay-backed event submission

The shell wraps these commands with desktop-specific concerns such as event emission and OS integration.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- `apps/extension/content.js` captures visit and attention signals.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture.
- `apps/extension/background.js` buffers connector events, serves popup requests, manages pairing, and forwards RPC/events to the daemon.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and event buffer.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

The connector keeps a short-lived local buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again.

For production use, persistence and replay belong to the daemon. The remaining local replay/persist path inside `background.js` is test-harness-only.

## Pairing and Change Broadcasts

The daemon owns the browser pairing state and websocket server.

- The connector pairs once, then sends capture and mutation events over the websocket channel.
- The popup requests page summaries and mutation helpers through the same daemon connection.
- The daemon broadcasts change notifications back to the desktop shell.
- The Tauri shell forwards those notifications into the desktop UI so connector-originated changes appear live.

This is the main cross-surface consistency path for desktop UI + popup parity.

## Search

Search is daemon-owned.

- `crates/search/` provides native full-text helpers.
- `crates/daemon/src/search.rs` wires those helpers into command/query paths.
- Desktop UI search requests go through Tauri commands.
- The connector popup only requests page-scoped summaries; it does not run local full-text search.

Shared query parsing and ranking helpers used by the UI live in `packages/core/`.

## Sync

Sync is daemon-owned.

- `crates/daemon/src/sync.rs` owns GitHub transport, token handling, sync state, pause persistence, and periodic sync orchestration.
- The desktop UI only edits sync settings and displays status.
- The extension does not ship sync transports or token management anymore.

The supported architecture is: local data directory on disk, with daemon-managed GitHub sync as the remote transport.

## Rules

Rules remain part of the main desktop UI product surface.

- Shared rule validation and matching helpers live in `packages/core/rule-engine.js`.
- Desktop mutations and previews go through daemon commands.
- Rule execution is no longer documented as an extension sandbox feature; the authoritative path is the desktop/daemon command surface.

## Shared Modules

`packages/core/` contains code shared by the desktop UI, connector UI, and tests:

- UI helpers such as `search-helpers.js`, `highlight-helpers.js`, `time-chart.js`, and `virtual-scroller.js`
- shared styling/theme modules
- logger, rule helpers, entity helpers, and search-runtime glue

`packages/protocol/` holds the protocol schema/message definitions shared across JS and Rust boundaries.

## Testing Model

Current automated coverage is split across three layers:

- `tests/unit/` for shared JS helpers and connector-side utility logic
- `tests/integration/` for daemon/connector RPC and event-flow coverage
- `tests/e2e/` for current shipped extension popup and connector behavior

The desktop smoke / GUI parity suite remains the notable intentionally-skipped gap.
