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
- Page slugs are derived from the page URL the replay layer receives. The readable slug prefix uses domain and path; the hash input is the full received URL. Extension-originated browser observations are canonicalized before they are sent to desktop: query params whose names start with `_` are removed, while ordinary query params and fragments still distinguish pages. JS producers use `packages/core/page-identity.js` for canonicalization, slug generation, and same-document classification; the extension content script receives a generated classic-script bridge from that same module during staging. Rust replay hashes the canonical URL it receives with its native implementation, and a deterministic cross-language property test checks the JavaScript-to-Rust identity contract across generated URLs. The browser-data migration applies the same canonicalization to existing logs and objects.

`crates/daemon/src/runtime.rs` owns replay transactions. Local transactions serialize the semantic read/modify/write operation, evolve one replay overlay, reserve checkpoint-worker capacity, append canonical logs before changing the daemon projection cache, advance replay progress, and submit checkpoint work in accepted order. Connector auto-pin and rule policy can inspect the transaction's evolving effects, but cannot perform the durable commit sequence itself. Sync strictly parses every non-empty downloaded JSONL line and evaluates every typed replay effect before any downloaded file is installed. The runtime then flushes prior checkpoint work, writes the validated files once, and publishes the resulting projection/checkpoint work without re-appending remote entries.

Checkpoint files may lag briefly; current reads use the daemon projection cache and only fall through to disk on coordinated cache misses. Shutdown and destructive data clearing flush accepted checkpoint work before returning.

`views/manifest/replay-progress.json` records the latest replayed log timestamp per device that has reached durable checkpoint files. Startup replays log entries newer than each device progress marker before serving, so acknowledged writes that reached JSONL but not checkpoint files survive daemon crashes. Replay progress is persisted coarsely during normal checkpoint work and exactly on checkpoint flush.

## Event-Sourced Model

Every mutation is represented as an event and applied through replay.

- Production replay and replay verification live in `crates/replay/`.
- Shared desktop and connector mutations enter through `crates/daemon/src/command_authority.rs`, which delegates replay-backed work to `crates/daemon/src/commands.rs`.

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

Desktop UI localization is resolved in the web UI. The shell exposes the current operating-system locale to the UI, and the user can persist a desktop-only `localeOverride` setting in `views/manifest/settings.json`. Translation catalogs are shared from `packages/core/locales/` and ship English, Arabic, German, Spanish, French, Hindi, Indonesian, Italian, Japanese, Korean, Brazilian and European Portuguese, Russian, Simplified Chinese, and Traditional Chinese. `packages/core/i18n.js` is the single registry for locale codes, native display names, and system-locale aliases; the daemon stores only the override value and does not translate product strings. Explicit overrides must resolve to a registered code, and a selected catalog load failure is surfaced instead of silently substituting English.

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

Closing the desktop window hides it instead of destroying its webview. Tray clicks, Dock reopen events, and deep links reuse that warm webview, preserve its frame, then unminimize, show, and focus it. macOS performs one delayed focus retry to handle native activation timing.

### Daemon Commands

`crates/daemon/src/command_authority.rs` is the transport-neutral semantic mutation seam shared by the Tauri and authenticated WebSocket adapters. Its `execute(action, request)` interface owns supported-action classification, required-field validation, response formation, and typed replay-derived mutation notifications, including every affected URL needed by connector consumers. Required command response fields are validated explicitly; missing or malformed fields fail the command instead of becoming null/default mutation payloads. Notifications are returned only after the delegated replay transaction commits. `main.rs` asks this module whether an action is shared instead of maintaining a second write-command allowlist; `ws_server.rs` retains authentication, encoding, socket lifecycle, browser observations, and notification broadcast. Extension command handlers do not synthesize mutation notifications or refresh product badges directly; badges and open popups consume the committed daemon notification stream.

`crates/daemon/src/commands.rs` supplies the authority and read paths with replay-backed implementation helpers, including:

- semantic mutations and specialized history/snapshot reads used behind projection interfaces
- bookmark import and history import
- note/list/snapshot/settings mutations
- rule preview and rule updates
- replay-backed log generation used by semantic mutations and browser observations

`crates/daemon/src/read_projections.rs` owns workflow-shaped daemon reads. Its interfaces cover list display and resolved pin context, page/search enrichment with notes and visible list memberships, page info with snapshot availability, visible list trees plus reorder state, recycle-bin restoration eligibility, popup list membership, and settings. The popup projection reduces each list to `{slug, name, containsPage, lastActivity}` inside the daemon so raw pin collections never cross the connector boundary. Other projection DTOs expose semantic fields such as `{kind, slug}`, `listSlugs`, and `hasSnapshots`; replay-only IDs, `childIds`, `parentIds`, and raw list-order keys remain inside the daemon. Every entity join uses coordinated projection-cache reads with disk fallback. Missing valid list-pin targets remain explicit as `kind: "missing"`; malformed pin IDs fail the read, and deleted lists and notes are not silently exposed.

The Tauri adapter exposes workflow actions (`getListDisplay`, `getPageContext`, `getAllPageContext`, `getListTree`, `getRecycleBin`, and `getSettings`) rather than a generic entity-key read. Desktop list, search, detail, tree, recycle-bin, and settings callers consume those projections. The WebSocket adapter uses the same module for page info/summary, popup lists, and settings. Its popup summary is a popup-ready projection: one request applies title and access policy and returns page, note, snapshot, list, and attention data. Generic WebSocket `get_entity`/`get_all_pages` requests are rejected by production sessions and enabled only by explicit daemon test control; the extension `readDesktopValue` relay is staged only in test builds.

Native window, folder, locale, external-open, and sync operations remain Tauri-only. Pairing, connector status, visit/leave observations, popup access policy, and socket cancellation remain WebSocket-only. Reads and streaming search retain their existing transport-specific response forms rather than widening the mutation interface.

Daemon writes are serialized by replay transactions in `crates/daemon/src/runtime.rs`. Command authority, websocket observation ingest, remote replay, rule batch, and sync paths use that module instead of assembling storage ordering themselves. The websocket connector and desktop command bridge use the same command authority and storage projection, so validation, responses, committed mutations, and immediate reads have identical semantics regardless of ingress even while checkpoint files are still catching up. Mutation payload defaults and constructors live in `crates/daemon/src/mutations.rs`; command authority and replay-derived notification paths do not maintain parallel payload schemas.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- `apps/extension/content.js` captures visit and attention signals. Because declarative content scripts are classic scripts, staged extension builds load a generated `browser-recall-page-identity.js` bridge before `content.js` so page slug generation still comes from the shared core implementation.
- `packages/core/highlight-lifecycle.js` owns the narrow shared highlight lifecycle used by live pages and snapshot documents. Its bounded hydration observer retains saved-note ownership long enough to repair marks removed by client rendering, while each retry skips notes whose owned marks are still intact.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture as one identified session per tab. The session owns settings, lifecycle timers, and resource warnings; overlapping captures are rejected, stale messages cannot settle newer captures, and unavailable resources are reported explicitly even when the usable snapshot is persisted.
- `apps/extension/background.js` buffers semantic connector commands, serves popup requests, manages pairing, and forwards RPC to the daemon. Toolbar clicks do not use a manifest `default_popup`: background resolves the current page identity, obtains the complete popup-ready daemon projection in one request, stores that data as a one-shot in-memory bootstrap token, then opens `popup.html?bootstrap=...` with `chrome.action.openPopup()`. Connector state is read locally after that request only to classify failures; it is not a separate RPC preflight. The token exists because extension action popups accept a URL but not an object payload; it is an in-memory handoff, not product persistence. Each token records the daemon-mutation revision observed before preparation; if a committed mutation arrives before consumption, background rebuilds the bootstrap from the daemon instead of handing stale metadata to the popup. Preparation is timeout-bounded so a slow daemon opens an explicit popup error instead of leaving the click dead. Engines without programmatic action popups fall back to opening the same prepared extension page in a tab. Test-only reset/seed/queue RPC handlers live in `apps/extension/background-test-control.js` and are staged only by the test fixture.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC; its list picker is a short-lived popup control, not extension persistence. The picker keeps one input node mounted from initial popup markup through capture and picker modes so startup typing and native IME composition are not interrupted by DOM reparenting or focus replacement. Tokenized toolbar-opened popups consume the prepared bootstrap before rendering, while direct popup loads use the same single popup-summary request as fallback. The picker opens from the already prepared per-open list projection instead of rereading lists. Existing membership toggles use one semantic mutation request; creating a list and adding the current page uses the combined `createListAndPin` semantic command, so both replay effects commit in one daemon transaction and one connector round trip. Both paths apply the committed response locally and let the committed mutation stream perform any later authoritative reconciliation. An open popup refreshes current-page list metadata when committed daemon pin/list mutations arrive, while other sections remain a per-open snapshot plus the popup's own user actions. Popup-originated mutations and live list refreshes run through one serialized UI lane: explicit command clicks are ignored while the lane is busy, and save-on-edit commits mark the lane busy before later actions can start. Busy state disables conflicting controls but never globally dims the popup.
- `apps/extension/icon-paths.js` and `apps/extension/badge-controller.js` switch packaged toolbar icons at runtime: the default icon is used for normal capture, the closed-eye icon for session-only recording pause, and state-colored backgrounds indicate special page-marker states.
- Icon PNGs are generated from root SVG sources by `scripts/generate-icons.mjs`: the full desktop app and extension toolbar icons keep an opaque background, while the desktop tray icon is transparent for macOS template rendering.
- `apps/extension/extension-surface.css`, `apps/extension/extension-surface.js`, and `apps/extension/extension-ui-tokens.js` keep connector pages, content overlays, and transient popouts on the shared light paper visual system. Floating connector surfaces use the same strong outer frame as the popup list picker.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and command buffer. Authentication and pairing requests and responses carry an explicit connector protocol version. Both peers reject missing or mismatched versions before authenticating, and the extension enters a visible terminal incompatible state. The websocket client establishes and verifies request readiness; cached connector state is presentation and diagnostic data, not an RPC preflight authority.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

The connector keeps a short-lived command buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again. Buffered items are semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not replay log records.

For production use, persistence, blacklist/title policy, auto-pin synthesis, and replay log schema all belong to the daemon.

### Highlights

Highlight notes are persisted through daemon `createNote` commands like other notes. `packages/core/highlight-lifecycle.js` owns page-local selection chunking, scoped DOM matching, mark ownership, bounded hydration retries, and route disposal for both live pages and the snapshot viewer. `content.js` adapts browser messages and daemon note reads to that module; staged extension builds generate `browser-recall-highlight-lifecycle.js` from the same factory for the classic content-script runtime. Same-block selections, including multiline code inside one block, store one string inside the `excerpt` array and one string inside the `cssPath` array; selections spanning distinct block elements store `excerpt` and `cssPath` as aligned string arrays. Reapply uses saved `cssPath` anchors to scope text matching; intentionally empty `cssPath` entries search the document root. Browser Recall panel and overlay DOM is never indexed. After initial reapply, a bounded mutation watcher retains all highlightable notes so client-side DOM replacement can settle. Same-document route changes stop the previous watcher, unwrap old page marks, and then load highlights for the new page identity.

### Localization

The connector extension uses WebExtension native localization. Staged extension bundles include root `/_locales/<locale>/messages.json` files and a manifest `default_locale`; manifest metadata, command descriptions, and extension UI strings use the browser's current UI locale through `chrome.i18n` / `browser.i18n`. The staged extension catalogs are filtered to `extension*`, `command*`, and `common*` keys so desktop-only UI strings are not packaged into the browser connector.

Desktop language options and extension locale directories are generated from the shared locale registry. Asset staging fails when a registered catalog is missing, an unregistered catalog exists, or keys, substitution placeholders, HTML tags, code/keyboard literals, product names, or technical terms drift from the English catalog.

### Settings

Persistent product settings are stored only in `views/manifest/settings.json` through daemon `saveSettingsKey` writes. The accepted keys are `theme`, `colorScheme`, `localeOverride`, `historyFileBatch`, `captureSnapshotVideo`, `blacklistEnabled`, `urlBlacklist`, `titleCleanupEnabled`, `titleTrimRules`, `syncEnabled`, `syncMethod`, `syncRepoUrl`, and `syncRetentionDays`. Runtime-only UI state may still live in `chrome.storage.session`.

## Pairing and Change Broadcasts

The daemon owns the browser pairing state and websocket server.

- The connector pairs once, then sends capture observations and mutation commands over the websocket channel.
- The popup requests page summaries and mutation helpers through the same daemon connection.
- Popup user-action failures that need user attention notify the active page when possible and fall back to the shared paper-colored popup bubble when the page cannot receive extension messages.
- Background shortcut/context-menu actions that hit a stale content-script runtime inject the same reload warning directly into the page so capture/highlight failures are not silent.
- The daemon broadcasts change notifications back to the desktop shell and authenticated connector sockets.
- The Tauri shell forwards daemon notifications into the desktop UI so connector-originated changes appear live; connector sockets receive daemon-originated mutations for connector surfaces such as tab badges and open-popup list membership.

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
- Full-history streaming and cancellation are desktop-only Tauri capabilities. The connector websocket does not expose full-history search; former history-search message types are rejected as invalid protocol messages.
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

- `crates/daemon/src/rules.rs` owns rule validation and matching. Desktop previews send both keyword and function rules through daemon commands so preview and automatic pinning execute the same implementation and regex engine.
- Desktop mutations and previews go through daemon commands.
- Keyword rules are title-only and always case-insensitive. Their config is exactly `{ pattern }`; they do not carry field selectors and never match URL or body preview text.
- Rule execution is no longer documented as an extension sandbox feature; the authoritative path is the desktop/daemon command surface.

## Shared Modules

`packages/core/` contains code shared by the desktop UI, connector UI, and tests:

- UI helpers such as `search-helpers.js`, `time-chart.js`, and `virtual-scroller.js`
- the shared highlight lifecycle in `highlight-lifecycle.js`, including its generated classic-script bridge source
- localization helpers and WebExtension-compatible locale catalogs in `i18n.js` and `locales/`
- page identity helpers in `page-identity.js`, including canonical URL handling, page slug generation, and the generated classic-script bridge source for content scripts
- shared styling/theme modules
- logger, rule helpers, entity helpers, and search-runtime glue

The connector websocket protocol is represented by the Rust message enums in `crates/daemon/src/protocol.rs`. Pairing and authentication requests and responses include the required protocol version: the daemon validates the request before approving or authenticating, and the JS connector validates the response before storing credentials or reporting connected state. Version 2 requires the popup-ready page summary fields used to avoid multiple preparation round trips. The JS connector constructs the subset it sends in `apps/extension/connector/ws-client.js`; daemon-side parsing and authority stay Rust-owned.

## Testing Model

GitHub jobs and local verification share the `ci:*` package-script entrypoints.
The composed `npm run ci` command runs every hosted test and lint group before
a change is committed.

Current automated coverage is split across three layers:

- `tests/unit/` for shared JS helpers and connector-side utility logic
- `tests/integration/` for daemon/connector RPC and event-flow coverage
- `tests/e2e/` for current shipped extension popup and connector behavior

Desktop locale registration and persistence are covered by a daemon-backed
Playwright workflow that drives every registered locale through the production
desktop settings UI and connector command path, verifies each real settings
checkpoint, reloads the UI, and checks Arabic RTL direction. A separate
browser E2E verifies that the packaged extension resolves messages through its
real WebExtension locale catalog. Only Tauri shell-only surfaces are shimmed.

E2E is the preferred product safety net for desktop and extension behavior. New coverage should favor real user workflows, cross-feature combinations, and seeded randomized inputs over expanding unit-test LoC. Rust daemon integration tests are the preferred fallback for daemon authority behavior that is impractical to assert through browser E2E. `scripts/test-coverage-monitor.mjs` surfaces JS and Rust uncovered production line ranges for triage, tracks the suite mix, and fails on JS or inline Rust unit-test LoC growth unless an explicit exception is made.

The desktop smoke / GUI parity suite remains the notable intentionally-skipped gap.
