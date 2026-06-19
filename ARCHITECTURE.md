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

Build artifacts are collected under `dist/`: loadable browser bundles live in
`dist/extension/chrome/` and `dist/extension/firefox/`, while desktop artifacts
live under `dist/desktop/`. `dist/desktop/ui/` contains platform-neutral staged
web assets; platform-specific release outputs use `dist/desktop/<platform>/`,
with `bin/` for copied release executables and bundle-type folders such as
`app/` or `dmg/`. Tauri and Cargo still use `target/` as their internal build
cache.

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
- Page slugs are derived from the page URL the replay layer receives. The readable slug prefix uses domain and path; the hash input is the full received URL. Extension-originated browser observations are canonicalized before they are sent to desktop: query params whose names start with `_` are removed, while ordinary query params and fragments still distinguish pages. The browser-data migration applies the same canonicalization to existing logs and objects.

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
- Extension-side URL identity for page slugs ignores underscore-prefixed query params, so analytics parameters such as `_spm_id` or `_i` do not split one page into multiple replay entities when data arrives through the extension connector. Rust replay hashes the URL it is given; non-extension producers must send canonical page URLs if they want the same identity behavior.
- Replay branches must stay idempotent.
- Desktop UI, extension popup, and sync ingestion all converge on the same replay model.

## Desktop App

### UI Runtime

`apps/desktop/ui/index.html` and `apps/desktop/ui/index.js` are the main product surface. The UI is a near-verbatim port of the old extension UI, but it now runs inside Tauri with `apps/desktop/ui/desktop-bridge.js` handling direct Tauri command calls and `apps/desktop/ui/extension-api-shim.js` providing the remaining `chrome.*` surfaces the port still expects.

The desktop shell scrolls the main results pane and sidebar independently. Results containers keep a bottom gutter aligned to the sidebar bottom edge, and the virtual scroller preserves that gutter as part of its base padding.

The shim currently covers:

- `chrome.storage.session` / `chrome.storage.local`
- `chrome.storage.onChanged` cross-window propagation
- tab/open helpers needed by the ported UI

Desktop product actions should use `desktop-bridge.js` directly. The `chrome.*` shim is compatibility scaffolding for storage and tab APIs that have not yet been removed from the ported UI.

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
- replay-backed log generation for browser observations such as visits/leaves

The shell wraps these commands with desktop-specific concerns such as event emission and OS integration.

Daemon writes are serialized through shared storage/runtime coordination. The websocket connector and desktop command bridge use the same storage projection, so an acknowledged write is immediately visible to reads from either surface even while checkpoint files are still catching up.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- `apps/extension/content.js` captures visit and attention signals.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture.
- `apps/extension/background.js` buffers semantic connector commands, serves popup requests, manages pairing, and forwards RPC to the daemon. Toolbar clicks do not use a manifest `default_popup`: background prepares the current tab, connector state, access state, and daemon page summary first, stores that data as a one-shot in-memory bootstrap token, then opens `popup.html?bootstrap=...` with `chrome.action.openPopup()`. The token exists because extension action popups accept a URL but not an object payload; it is an in-memory handoff, not product persistence. Preparation is timeout-bounded so a slow daemon opens an explicit popup error instead of leaving the click dead. Engines without programmatic action popups fall back to opening the same prepared extension page in a tab. Test-only reset/seed/queue RPC handlers live in `apps/extension/background-test-control.js` and are staged only by the test fixture.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC; its list picker is a short-lived popup control, not extension persistence. Tokenized toolbar-opened popups consume the prepared bootstrap before rendering, while direct popup loads use daemon RPC fallback. An open popup renders a per-open snapshot plus its own user actions; background mutation broadcasts do not mutate an already-open popup. Reopen the popup to request a fresh page summary. Popup-originated mutations run through one serialized UI lane: explicit command clicks are ignored while the lane is busy, and save-on-edit commits mark the lane busy before later actions can start.
- `apps/extension/icon-paths.js` and `apps/extension/badge-controller.js` switch packaged toolbar icons at runtime: the default icon is used for normal capture, the closed-eye icon for session-only recording pause, and state-colored backgrounds indicate special page-marker states.
- Icon PNGs are generated from root SVG sources by `scripts/generate-icons.mjs`: the full desktop app and extension toolbar icons keep an opaque background, while the desktop tray icon is transparent for macOS template rendering.
- `apps/extension/extension-surface.css`, `apps/extension/extension-surface.js`, and `apps/extension/extension-ui-tokens.js` keep connector pages, content overlays, and transient error popouts on the shared light paper visual system.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and command buffer.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

The connector keeps a short-lived command buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again. Buffered items are semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not replay log records.

For production use, persistence, blacklist/title policy, auto-pin synthesis, and replay log schema all belong to the daemon.

### Highlights

Highlight notes are persisted through daemon `createNote` commands like other notes. The connector content script owns only page-local selection and DOM range work. Same-block selections, including multiline code inside one block, store one string inside the `excerpt` array and one string inside the `cssPath` array; selections spanning distinct block elements store `excerpt` and `cssPath` as aligned string arrays. Reapply uses saved `cssPath` anchors to scope text matching; intentionally empty `cssPath` entries search the document root.

### Settings

Persistent product settings are stored only in `views/manifest/settings.json` through daemon `saveSettingsKey` writes. The accepted keys are `theme`, `colorScheme`, `historyFileBatch`, `captureSnapshotVideo`, `blacklistEnabled`, `urlBlacklist`, `titleCleanupEnabled`, `titleTrimRules`, `syncEnabled`, `syncMethod`, `syncRepoUrl`, and `syncRetentionDays`. Runtime-only UI state may still live in `chrome.storage.session`.

## Pairing and Change Broadcasts

The daemon owns the browser pairing state and websocket server.

- The connector pairs once, then sends capture observations and mutation commands over the websocket channel.
- The popup requests page summaries and mutation helpers through the same daemon connection.
- Popup user-action failures that need user attention notify the active page when possible and fall back to the shared paper-colored popup bubble when the page cannot receive extension messages.
- Background shortcut/context-menu actions that hit a stale content-script runtime inject the same reload warning directly into the page so capture/highlight failures are not silent.
- The daemon broadcasts change notifications back to the desktop shell and authenticated connector sockets.
- The Tauri shell forwards daemon notifications into the desktop UI so connector-originated changes appear live; connector sockets receive daemon-originated mutations for connector surfaces such as tab badges. Open popups do not subscribe to background mutation refreshes; they refresh page data by closing and reopening.

This is the main cross-surface consistency path for desktop UI + popup parity.

## Search

Search is daemon-owned.

- `crates/search/` provides native full-text helpers.
- `crates/daemon/src/search.rs` wires those helpers into command/query paths.
- History search matches page identity fields (`title`, `user_title`, `url`). Note and snapshot body text are searched by their dedicated daemon phases and return their own match scores and timestamps.
- Desktop search/filter input keeps typed text as a local draft and starts the daemon search or list filter only when Enter commits the query.
- Committed desktop search results are rendered directly from the in-memory merged result set; the virtual scroller remains for all-history Explore rendering where demand loading can grow the result set.
- Desktop UI history search goes through cancellable Tauri streaming commands. The daemon search adapter splits history JSONL work across a fixed worker pool, emits result chunks as workers finish, and cooperatively stops when the UI starts a newer search or leaves search mode.
- Explore device filter choices come from the authoritative `logs/<device>/` directories returned by the daemon history-file listing, not from whichever history rows the UI has demand-loaded.
- The connector websocket protocol exposes daemon history search streaming and cancellation messages (`search_history_stream`, `cancel_history_search`, `history_search_chunk`, `history_search_done`).
- Desktop UI note and snapshot search still use daemon-owned request/response commands.
- The connector popup only requests page-scoped summaries; it does not run local full-text search.

Shared query parsing and identity ranking helpers used by the UI phase-0 preview live in `packages/core/`.

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

The connector websocket protocol is represented by the Rust message enums in `crates/daemon/src/protocol.rs`. The JS connector constructs the subset it sends in `apps/extension/connector/ws-client.js`; daemon-side parsing and authority stay Rust-owned.

## Testing Model

Current automated coverage is split across three layers:

- `tests/unit/` for shared JS helpers and connector-side utility logic
- `tests/integration/` for daemon/connector RPC and event-flow coverage
- `tests/e2e/` for current shipped extension popup and connector behavior

E2E is the preferred product safety net for desktop and extension behavior. New coverage should favor real user workflows, cross-feature combinations, and seeded randomized inputs over expanding unit-test LoC. Rust daemon integration tests are the preferred fallback for daemon authority behavior that is impractical to assert through browser E2E. `scripts/test-coverage-monitor.mjs` surfaces JS and Rust uncovered production line ranges for triage, tracks the suite mix, and fails on JS or inline Rust unit-test LoC growth unless an explicit exception is made.

The desktop smoke / GUI parity suite remains the notable intentionally-skipped gap.
