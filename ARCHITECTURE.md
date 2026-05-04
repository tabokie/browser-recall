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
data directory (logs, objects, views)

chrome connector (apps/extension)
  ↓ websocket pairing / RPC
daemon websocket server
```

## Storage Layout

```text
<root>/
  logs/
    <device>/<YYYY-MM-DD>.jsonl
  objects/
    notes/<noteSlug>.json
    snapshots/<shard>/<pageSlug>-<timestamp>.html
    snapshots/<shard>/<pageSlug>-<timestamp>.md
  views/
    pages/<shard>/<pageSlug>.json
    lists/<listId>.json
    manifest/
      list-order.json
      list-name-to-id.json
      orphaned.json
      settings.json
      replay-progress.json
```

- `logs/*` is the append-only event log and source of truth.
- `views/lists` and `views/manifest` are replay-derived checkpoints. `views/pages` is a selective replay-derived checkpoint set: only pages with durable user state are persisted there.
- `objects/notes` and `objects/snapshots` are durable user artifacts referenced by replay state.
- Page and snapshot files are sharded by the first two hex characters of the SHA-256 hash of the logical slug/stem. Logical entity IDs do not include the shard.

Mutation commands reserve checkpoint-worker capacity before durable changes, append logs before changing the daemon cache, then apply replay effects to the in-memory projection cache. The reserved checkpoint work is submitted while the write is still serialized, so checkpoint files persist in accepted write order. Checkpoint files may lag briefly; current reads use the daemon cache and only fall through to disk on coordinated cache misses. Shutdown flushes accepted checkpoint work before returning.

`views/manifest/replay-progress.json` records the latest replayed log timestamp per device that has reached durable checkpoint files. Startup replays log entries newer than each device progress marker before serving, so acknowledged writes that reached JSONL but not checkpoint files survive daemon crashes. Replay progress is persisted coarsely during normal checkpoint work and exactly on checkpoint flush.

## Event-Sourced Model

Every mutation is represented as an event and applied through replay.

- Production replay and replay verification live in `crates/replay/`.
- The desktop shell and daemon use replay-backed command helpers from `crates/daemon/src/commands.rs`.

Key consequences:

- Log files are authoritative; checkpoints are rebuildable.
- Log records use the replay schema only. Command-only/transient fields such as rule-matching body previews are consumed before commit and are not written to JSONL.
- A `visit_page` event materializes the page entity during replay when needed; callers do not decide checkpoint creation through log fields. Page checkpoint persistence is decided centrally from the replayed page state: list parent, note/snapshot child, user title, or rating. Daemon persistence and replay verification call the same Rust policy.
- Replay log deserialization denies unknown fields so accidental command-only fields cannot persist silently.
- `pin_to_list` and `unpin_from_list` use `urls`; `pin_to_list.titles`, when present, is an index-aligned array with the same length as `urls`.
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

- entity/page payload reads from the daemon projection cache with disk fallback
- bookmark import and history import
- note/list/snapshot/settings mutations
- rule preview and rule updates
- canonical log generation for browser observations such as visits/leaves

The shell wraps these commands with desktop-specific concerns such as event emission and OS integration.

Daemon writes are serialized through shared storage/runtime coordination. The websocket connector and desktop command bridge use the same storage projection, so an acknowledged write is immediately visible to reads from either surface even while checkpoint files are still catching up.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- `apps/extension/content.js` captures visit and attention signals.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture.
- `apps/extension/background.js` buffers semantic connector commands, serves popup requests, manages pairing, and forwards RPC to the daemon.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and command buffer.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

The connector keeps a short-lived command buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again. Buffered items are semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not replay log records.

For production use, persistence, blacklist/title policy, auto-pin synthesis, and replay log schema all belong to the daemon.

### Settings

Persistent product settings are stored only in `views/manifest/settings.json` through daemon `saveSettingsKey` writes. The accepted keys are `theme`, `colorScheme`, `historyFileBatch`, `captureSnapshotVideo`, `blacklistEnabled`, `urlBlacklist`, `titleCleanupEnabled`, `titleTrimRules`, `syncEnabled`, `syncMethod`, `syncRepoUrl`, and `syncRetentionDays`. Runtime-only UI state may still live in `chrome.storage.session`.

## Pairing and Change Broadcasts

The daemon owns the browser pairing state and websocket server.

- The connector pairs once, then sends capture observations and mutation commands over the websocket channel.
- The popup requests page summaries and mutation helpers through the same daemon connection.
- The daemon broadcasts change notifications back to the desktop shell and authenticated connector sockets.
- The Tauri shell forwards daemon notifications into the desktop UI so connector-originated changes appear live; connector sockets receive daemon-originated mutations so open popups and tab badges can refresh.

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
- The websocket connector does not expose sync file/manifest RPCs; sync file I/O stays inside the daemon sync controller.

The supported architecture is: local data directory on disk, with daemon-managed GitHub sync as the remote transport.

## Rules

Rules remain part of the main desktop UI product surface.

- Shared rule validation and matching helpers live in `packages/core/rule-engine.js`.
- Desktop mutations and previews go through daemon commands.
- Keyword rules are title-only and always case-insensitive. Their config is exactly `{ pattern }`; they do not carry field selectors and never match URL or body preview text.
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
