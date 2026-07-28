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
- Each captured snapshot has a raw `.html` replay sidecar and, when the live page has extractable text, a structured `.md` search sidecar in the same shard. The extension generates Markdown from the live DOM through `packages/core/markdown-extractor.js`; staging produces a classic content-script bridge from that shared implementation. Extraction preserves headings, ordinary links, image descriptions, quotes, nested lists, code, and tables without a fixed-length cutoff, while omitting computed-style-hidden, script, navigation, and form-control content as well as non-searchable `data:` and `blob:` URL payloads.
- Page slugs are derived from the page URL the replay layer receives. The readable slug prefix uses domain and path; the hash input is the full received URL. Extension-originated browser observations are canonicalized before they are sent to desktop: query params whose names start with `_` are removed, while ordinary query params and fragments still distinguish pages. JS producers use `packages/core/page-identity.js` for canonicalization, slug generation, and same-document classification; the extension content script receives a generated classic-script bridge from that same module during staging. Rust replay hashes the canonical URL it receives with its native implementation, and a deterministic cross-language property test checks the JavaScript-to-Rust identity contract across generated URLs. Existing logs and objects were migrated to this canonical identity before the compatibility tooling was removed.
- Page relationship arrays retain every durable list, note, and snapshot reference. The replay layer caps only transient page-to-page referrer references, so high-traffic hub pages cannot lose the list membership that makes their selective page checkpoint durable.

`crates/daemon/src/runtime.rs` owns replay transactions. Local transactions serialize the semantic read/modify/write operation, evolve one replay overlay, reserve checkpoint-worker capacity, append canonical logs before changing the daemon projection cache, advance replay progress, and submit checkpoint work in accepted order. Connector auto-pin and rule policy can inspect the transaction's evolving effects, but cannot perform the durable commit sequence itself. Sync strictly parses every non-empty downloaded JSONL line and evaluates every typed replay effect before any downloaded file is installed. The runtime then flushes prior checkpoint work, writes the validated files once, and publishes the resulting projection/checkpoint work without re-appending remote entries.

Checkpoint files may lag briefly; current reads use the daemon projection cache and only fall through to disk on coordinated cache misses. Shutdown and destructive data clearing flush accepted checkpoint work before returning.

`views/manifest/replay-progress.json` records the latest replayed log timestamp per device that has reached durable checkpoint files. Startup replays log entries newer than each device progress marker before serving, so acknowledged writes that reached JSONL but not checkpoint files survive daemon crashes. Replay progress is persisted coarsely during normal checkpoint work and exactly on checkpoint flush.

Storage enumeration selects entries owned by each namespace and ignores unrelated filesystem entries: device directories under `logs/`, dated `.jsonl` files inside a device, JSON checkpoints, and snapshot sidecars. Once selected, owned entries remain strict: log filenames must be UTF-8 `YYYY-MM-DD.jsonl`, blank records are invalid, every line must be valid JSON and deserialize through the replay schema, and every entry must carry its integer timestamp. A malformed owned file fails the complete read. Required `logs/`, `objects/`, and `views/` directories disappearing after setup is an error, not an empty dataset. Checkpoint persistence likewise requires replay effect keys to use the expected entity prefix and to match the entity slug; it never substitutes the embedded slug for a malformed effect key.

## Event-Sourced Model

Every mutation is represented as an event and applied through replay.

- Production replay and replay verification live in `crates/replay/`.
- Shared desktop and connector mutations enter through `crates/daemon/src/command_authority.rs`, which delegates replay-backed work to `crates/daemon/src/commands.rs`.

Key consequences:

- Log files are authoritative; checkpoints are rebuildable.
- Log records use the replay schema only. Command-only/transient fields such as rule-matching body previews are consumed before commit and are not written to JSONL.
- A `visit_page` event materializes the page entity during replay when needed; callers do not decide checkpoint creation through log fields. Page checkpoint persistence is decided centrally from the replayed page state: list parent, note/snapshot child, user title, or rating. Daemon persistence and replay verification call the same Rust policy.
- Full-log verification seeds only note objects that have no note event anywhere in the log. Logged notes replay from their events so idempotent tombstones cannot suppress related page, list, or orphan-manifest effects. An earlier `createdAt` recovered from non-durable visits is reported as checkpoint timing drift, not a data discrepancy.
- Replay log deserialization denies unknown fields so accidental command-only fields cannot persist silently. Schema members that are nullable still have to be present explicitly: for example `visit_page` requires `title` and `referrerUrl`, `leave_page` requires `title`, `scrollDepth`, and `timeOnPage`, and `pin_to_list` requires `titles` and `source`.
- Notes are highlights only. `create_note`, `replace_note`, and live persisted note objects require aligned non-empty `excerpt` and `cssPath` string arrays; the former null/empty page-note anchor has been migrated out of authoritative logs and checkpoints and is not a live-note compatibility shape. Deleted replay tombstones may omit both anchors so an out-of-order delete remains durable and reloadable without becoming a renderable note.
- `pin_to_list` and `unpin_from_list` use `urls`; `pin_to_list.titles`, when present, is an index-aligned array with the same length as `urls`.
- Extension-side URL identity for page slugs ignores underscore-prefixed query params, so analytics parameters such as `_spm_id` or `_i` do not split one page into multiple replay entities when data arrives through the extension connector. Rust replay hashes the URL it is given; non-extension producers must send canonical page URLs if they want the same identity behavior.
- Replay branches must stay idempotent.

Checkpoint JSON is also one strict current schema, not a family of historical shapes. Page, note, list, pin, tree, settings, name-map, list-order, and orphaned fields are all serialized explicitly, including empty collections, `false`, and `null`. Readers deny unknown fields and reject missing fields. Schema upgrades must migrate `~/browser-data` before the upgraded daemon starts.
- List `slug`, `name`, and `owner` fields are required non-empty strings. Replay rejects empty explicit list or parent IDs and never assigns a missing owner from the current device.
- Desktop UI, extension popup, and sync ingestion all converge on the same replay model.

## Desktop App

### UI Runtime

`apps/desktop/ui/index.html` and `apps/desktop/ui/index.js` are the main product surface. The UI runs inside Tauri with `apps/desktop/ui/desktop-bridge.js` handling product commands and `apps/desktop/ui/desktop-platform.js` exposing the small, explicit host contract used by shared UI code: session/local UI storage, runtime messages/reload, and external URL opening. The adapter requires the Tauri invoke and event bridges at startup; `withGlobalTauri` exposes that API and the main-window capability grants event subscriptions. The adapter never invents browser tabs or unsupported extension APIs, and exposes a readiness promise that the UI must await.

Shell, device-identity, directory, and connector reads are strict DTOs. Required booleans, nullable identities, counters, paired-browser fields, and connector states are validated before rendering; configured identity must agree across `setupComplete`, device ID, data folder, token, and port fields. The UI does not translate malformed or failed platform reads into “offline,” “unknown,” “default,” or checked preference state.

The desktop shell scrolls the main results pane and sidebar independently. The main pane reserves a stable scrollbar gutter before history hydration so its right edge does not move when loaded rows make the pane scrollable. List and Explore result wrappers grow to fill sparse panes but never flex-shrink below their content, so the outer main pane remains the sole vertical scroll authority and selection paint cannot redistribute chart-to-result spacing. Results containers keep a bottom gutter aligned to the sidebar bottom edge, and the virtual scroller preserves that gutter as part of its base padding.

The sidebar exposes a highlight-history view directly after Explore. It renders
each live highlight note as its own time-descending entry, including multiple
highlights from one page, and reuses the page-detail highlight presentation and
edit/delete controls. Highlight quote rules cover the card's left border, and
note editing uses a borderless contenteditable surface with an explicit
checkmark confirmation, matching the connector highlight editor. Successful
local edit/delete commands reconcile only their affected card; the matching
daemon note mutation is consumed as an acknowledgement so it cannot rebuild the
history view, replace unaffected cards, or reset the main-pane scroll position.
That acknowledgement suppression is scoped to highlight history; page-detail
note actions still refresh their underlying Explore, search, or list view.
Highlight cards render in bounded scroll-triggered batches rather than creating
the complete history DOM at once.
The UI reads one `getHighlightHistory` workflow
projection; it does not infer highlight chronology from page visits or scan
entity files directly.

Desktop UI localization is resolved in the web UI. The shell exposes the current operating-system locale to the UI, and the user can persist a desktop-only `localeOverride` setting in `views/manifest/settings.json`. Translation catalogs are shared from `packages/core/locales/` and ship English, Arabic, German, Spanish, French, Hindi, Indonesian, Italian, Japanese, Korean, Brazilian and European Portuguese, Russian, Simplified Chinese, and Traditional Chinese. `packages/core/i18n.js` is the single registry for locale codes, native display names, and system-locale aliases; the daemon stores only the override value and does not translate product strings. Explicit overrides must resolve to a registered code, and a selected catalog load failure is surfaced instead of silently substituting English.

The desktop platform adapter covers exactly:

- `chrome.storage.session` / `chrome.storage.local`
- `chrome.storage.onChanged` cross-window propagation
- runtime message delivery and reload
- external URL opening through `chrome.tabs.create` without fabricating a browser tab result

Desktop product actions use `desktop-bridge.js` directly. `desktop-platform.js` is only a host adapter for UI state and shell operations; it is not a product-data or daemon-command fallback.

### Shell Bridge

`apps/desktop/src-tauri/src/main.rs` is responsible for:

- window lifecycle and deep links
- invoking daemon-backed commands
- broadcasting storage changes and replay-derived mutations to webviews
- pairing/session state needed by the desktop app

Fresh desktop configuration has an empty data-directory path. Onboarding explicitly transitions configuration through folder selection and setup completion before the daemon can start; the installed app has no implicit data-directory default. Standalone daemon and test adapters must provide their data directory explicitly, and cannot repoint an already configured daemon through startup arguments.

The Tauri layer is intentionally thin; storage/search/replay behavior lives in `crates/daemon/`.

Closing the desktop window hides it instead of destroying its webview. Tray clicks, Dock reopen events, and deep links reuse that warm webview, preserve its frame, then unminimize, show, and focus it. A retained physical frame is restored only while it still intersects a current display work area; otherwise the window returns to its normal centered frame so display removal or topology changes cannot strand it off-screen. macOS performs one delayed focus retry to handle native activation timing.

If a configured daemon cannot start because an owned data file is invalid or another explicit startup error occurs, the Tauri shell remains alive with a paused snapshot and visible `daemon_start_failed` diagnostic. After the cause is corrected, Resume starts the absent daemon without restarting the shell. Daemon startup is guarded across the complete asynchronous start operation, so concurrent Resume/setup requests converge on one server and one watcher set. While that server is absent, shell/setup diagnostics remain available but storage-backed reads and sync return `Browser Recall daemon is not running`; the Tauri layer never constructs a second `Storage` authority or checkpoint worker.

Production Rust targets deny `expect`, `unwrap`, `panic!`, and `unreachable!`. Storage, projection, sync, rule, serialization, and startup failures return through their existing error boundaries; shared synchronous state uses non-poisoning locks so one failed task cannot turn later reads into secondary panics.

### Daemon Commands

`crates/daemon/src/command_authority.rs` is the transport-neutral semantic mutation seam shared by the Tauri and authenticated WebSocket adapters. Its `execute(action, request)` interface deserializes each request once into a closed, internally tagged command enum. That enum is the single definition of allowed fields, required fields, and field types; note and list command implementations receive typed inputs rather than reparsing raw JSON. The authority returns one validated successful response together with replay-derived mutation notifications, including every affected URL needed by connector consumers. Missing, malformed, and unknown fields fail the command instead of becoming null/default mutation payloads. Notifications are returned only after the delegated replay transaction commits. `main.rs` asks this module whether an action is shared instead of maintaining a second write-command allowlist; `ws_server.rs` retains authentication, encoding, socket lifecycle, browser observations, and notification broadcast. Extension command handlers do not synthesize mutation notifications or refresh product badges directly; badges and open popups consume the committed daemon notification stream.

Production WebSocket messages cannot represent raw replay entries or destructive/test-control operations as production variants. Raw event/note ingest, reset/clear, remote replay, device replacement, generic entity reads, direct search/rule calls, and raw permanent deletion live under the nested `test_control` protocol namespace, and the daemon rejects that entire namespace unless explicit test control is enabled. `reportVisit` requests contain exactly `timestamp`, `url`, explicit-nullable `title`, `referrer`, and `bodyPreview`, plus boolean `bypassBlacklist`; `reportLeave` contains exactly `timestamp`, `url`, explicit-nullable `title`, `scrollDepth`, and `timeOnPage`. Timestamp aliases and server-generated observation times are not accepted. Optional referrers outside the HTTP(S) page-identity namespace are omitted before replay, and a passive leave for a visit intentionally skipped by capture policy is an idempotent no-op.

Rule preview and rule-batch entries are command DTOs with exactly `url`, `title`, and explicit-nullable `bodyPreview`. They do not accept the former `body` alias or carry replay fields such as `action` and `timestamp`. Automatic matching preserves the nullable observation title, may inspect transient `bodyPreview` data on an incoming visit command, and never persists command-only preview data in canonical replay records.

`crates/daemon/src/commands.rs` supplies the authority and read paths with replay-backed implementation helpers, including:

- semantic mutations and specialized history/snapshot reads used behind projection interfaces
- bookmark import and history import
- note/list/snapshot/settings mutations
- rule preview and rule updates
- replay-backed log generation used by semantic mutations and browser observations

Desktop history import accepts one JSON array whose entries use only `url`, `title`, `lastVisitTime`, `visitTimes`, and `referrerUrl`. Timestamps are positive integer milliseconds; wrapper objects, alternate field names, string/date coercion, and unknown fields fail validation before the daemon command runs. A valid HTTP(S) visit remains importable when its optional referrer is outside the page-identity namespace; that relationship is omitted.

`crates/daemon/src/read_projections.rs` owns workflow-shaped daemon reads. Its interfaces cover list display and resolved pin context, page/search enrichment with notes and visible list memberships, highlight history, page info with snapshot availability, visible list trees plus reorder state, recycle-bin restoration eligibility, popup list membership, and settings. Highlight history joins every live page-owned note directly to its original `create_note` timestamp, resolves `replace_note` chains independently of cross-device timestamp order, and fails when a live highlight has no authoritative creation event instead of substituting page recency. Page info resolves `note:` and `snapshot:` children into its payload, recognizes `page:` children as navigation relationships owned by the separate relations view, and still rejects unknown child-reference kinds. The popup projection reduces each list to `{slug, name, containsPage, lastActivity}` inside the daemon so raw pin collections never cross the connector boundary. Other projection DTOs expose semantic fields such as `{kind, slug}`, `listSlugs`, and `hasSnapshots`; replay-only IDs, `childIds`, `parentIds`, and raw list-order keys remain inside the daemon. Every entity join reads the latest coordinated projection cache and falls through to disk only on a cache miss. Missing, deleted, malformed, or non-list tree references fail the complete projection read; projection construction never drops a node with `filter_map` semantics. Storage replay recovery, history listing/loading, highlight chronology, and sync collection all use the same internal log catalog, which selects device directories and dated JSONL files before applying strict filename and record validation. Parsed highlight chronology is cached independently of visit traffic and invalidated by note-log appends, synchronized storage replacement, destructive resets, and explicit cache resets.

The Tauri adapter exposes workflow actions (`getListDisplay`, `getPageContext`, `getAllPageContext`, `getHighlightHistory`, `getListTree`, `getRecycleBin`, and `getSettings`) rather than a generic entity-key read. Desktop list, search, detail, highlight-history, tree, recycle-bin, and settings callers consume those projections. The WebSocket adapter uses the same module for page info/summary, popup lists, and settings. Its popup summary is a popup-ready projection: one request applies title and access policy and returns page, note, snapshot, list, and attention data. Generic WebSocket `get_entity`/`get_all_pages` requests are rejected by production sessions and enabled only by explicit daemon test control; the extension `readDesktopValue` relay is staged only in test builds.

Native window, folder, locale, external-open, and sync operations remain Tauri-only. Pairing, connector status, visit/leave observations, popup access policy, and socket cancellation remain WebSocket-only. Reads and streaming search retain their existing transport-specific response forms rather than widening the mutation interface.

Daemon writes are serialized by replay transactions in `crates/daemon/src/runtime.rs`. Command authority, websocket observation ingest, remote replay, rule batch, and sync paths use that module instead of assembling storage ordering themselves. The websocket connector and desktop command bridge use the same command authority and storage projection, so validation, responses, committed mutations, and immediate reads have identical semantics regardless of ingress even while checkpoint files are still catching up. Mutation payload defaults and constructors live in `crates/daemon/src/mutations.rs`; command authority and replay-derived notification paths do not maintain parallel payload schemas.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- `apps/extension/browser-api.js` selects Chromium or Firefox from the actual user agent and requires that engine's Manifest V3 runtime, action, and context-menu APIs. It does not probe MV2 aliases such as `browserAction` or `menus`, and it never selects an unrelated truthy `browser` global on Chromium.
- `apps/extension/content.js` captures visit and attention signals. Because declarative content scripts are classic scripts, staged extension builds load a generated `browser-recall-page-identity.js` bridge before `content.js` so page slug generation still comes from the shared core implementation.
- `packages/core/highlight-lifecycle.js` owns the narrow shared highlight lifecycle used by live pages and snapshot documents. Its bounded hydration observer retains saved-note ownership long enough to repair marks removed by client rendering, while each retry skips notes whose owned marks are still intact.
- Browser Recall-owned page markup uses the `browser-recall-` prefix. Saved snapshot identity is embedded only as `x-browser-recall-slug` and `x-browser-recall-url` metadata; readers do not accept obsolete marker names.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture as one identified session per tab. The session owns settings, lifecycle timers, and typed resource diagnostics; overlapping captures are rejected, stale messages cannot settle newer captures, and intentional policy skips remain distinguishable from network, security, unsupported, and budget omissions. Save Page first fetches from the page context, then uses the extension's host-permission-backed HTTP(S) fetch path for resources that require a CORS bypass; the extension CSP explicitly permits that recovery path. Both paths use `packages/core/bounded-response.js` to enforce the 50 MB per-resource limit against streamed bytes rather than trusting `Content-Length`. Before capture starts, `packages/core/snapshot-capture-budget.js` derives the JSON-encoded HTML allowance from the daemon-advertised complete WebSocket message limit. After retained frames reply, the page performs a resource-free serializer pass so nested documents, shadow roots, and attribute escaping are part of the structural reservation; it then keeps mutation overhead, schedules at most six resource loads, provisionally divides the remaining encoded allowance among in-flight reads, and accounts for base64/percent expansion and repeated references before accepting content. Staging generates and orders both required classic-script bridges, and capture fails explicitly if either is missing. Before persistence, the pure `packages/core/snapshot-html.js` preparation boundary removes Browser Recall highlight markup and the inactive vendored shadow-loader script, injects snapshot identity metadata, deactivates stylesheet links Save Page could not embed, and enables declarative shadow roots without rewriting serialized markup inside `srcdoc` attributes. The all-frame helper serializes live shadow trees before retained cross-origin frame HTML crosses the message boundary; the trusted viewer recursively prepares nested `srcdoc` documents, including frames inside serialized shadow trees, while archived scripts remain blocked. Snapshot reads reapply the same idempotent preparation boundary, repairing legacy stored HTML without extension-side persistent migration. Replay therefore never blocks first paint on a resource that capture already declared unavailable; successfully embedded `<style>` content remains intact.
- `apps/extension/background.js` buffers semantic connector commands, serves popup requests, manages pairing, and forwards RPC to the daemon. It is the sole tab page-identity resolver: reported same-document URLs, content-script identity, embedded saved pages, and snapshot-viewer slugs are validated there against desktop data. While an HTTP(S) tab is still loading before its `document_idle` content script is available, popup preparation inspects already-parsed embedded identity metadata and otherwise derives identity from the browser-reported tab URL instead of treating the absent receiver as an identity failure; completed tabs still require the validated content-script response. Popup preparation and snapshot-viewer badge-marker reads share that resolver, so both use the original page URL, title, notes/snapshots, and list memberships. Direct popup loads request that resolved identity from background instead of reproducing the rules. Toolbar clicks do not use a manifest `default_popup`: background resolves the current page identity, obtains the complete popup-ready daemon projection in one request, stores that data as a one-shot in-memory bootstrap token, then opens `popup.html?bootstrap=...` with `chrome.action.openPopup()`. Connector state is read locally after that request only to classify failures; it is not a separate RPC preflight. The token exists because extension action popups accept a URL but not an object payload; it is an in-memory handoff, not product persistence. Each token records the daemon-mutation revision observed before preparation; if a committed mutation arrives before consumption, background rebuilds the bootstrap from the daemon instead of handing stale metadata to the popup. Preparation is timeout-bounded so a slow daemon opens an explicit popup error instead of leaving the click dead. Engines without programmatic action popups fall back to opening the same prepared extension page in a tab. Test-only reset/seed/queue RPC handlers live in `apps/extension/background-test-control.js` and are staged only by the test fixture.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC; its list picker is a short-lived popup control, not extension persistence. The picker keeps one input node mounted from initial popup markup through capture and picker modes so startup typing and native IME composition are not interrupted by DOM reparenting or focus replacement. Tokenized toolbar-opened popups consume the prepared bootstrap before rendering; direct popup loads request the same complete popup-summary projection. Private mode is resolved before entering the dashboard shell, and the dashboard surface means authoritative page data finished rendering. The picker opens from the already prepared per-open list projection instead of rereading lists. Existing membership toggles use one semantic mutation request; creating a list and adding the current page uses the combined `createListAndPin` semantic command, so both replay effects commit in one daemon transaction and one connector round trip. Both paths apply the committed response locally and let the committed mutation stream perform any later authoritative reconciliation. An open popup refreshes current-page list metadata when committed daemon pin/list mutations arrive, while other sections remain a per-open snapshot plus the popup's own user actions. Popup-originated mutations and live list refreshes run through one serialized UI lane: explicit command clicks are ignored while the lane is busy, and explicit highlight-note confirmation marks the lane busy before later actions can start. Busy state disables conflicting controls but never globally dims the popup. `extension-surface.js` supplies one highlight-entry renderer, editor state machine, icon set, and base CSS to both the popup and the scrollbar-free PDF panel. Empty annotations remain unlabeled, and a failed edit or delete keeps the entry intact and retryable. The standalone Hide markup action is transient: when the source tab has a content-script receiver, it stops that page's current highlight hydration watcher and unwraps Browser Recall marks without changing the desktop-owned notes; receiver-less surfaces still render notes but omit that unavailable action. The content script owns the transient state, so reopening the popup still shows the inverse-color Show markup action until the user shows markup or a later page load or route transition resets and reapplies it.
- `apps/extension/icon-paths.js` and `apps/extension/badge-controller.js` switch packaged toolbar icons at runtime: the default icon is used for normal capture, the closed-eye icon for session-only recording pause, and state-colored backgrounds indicate special page-marker states. The badge controller awaits background's tab identity resolution before reading markers, including for extension-hosted snapshot viewers. When a viewer finishes loading, background probes the live connector state before refreshing its icon instead of allowing an earlier cached `starting` state to suppress the authoritative marker read.
- Icon PNGs are generated from root SVG sources by `scripts/generate-icons.mjs`: the full desktop app and extension toolbar icons keep an opaque background, while the desktop tray icon is transparent for macOS template rendering. macOS app bundles are always signed as complete bundles: local builds default to Tauri's ad-hoc `-` identity and finalize it with an explicit bundle-identifier designated requirement so rebuilds do not become different CDHash-only identities; `APPLE_SIGNING_IDENTITY` overrides the ad-hoc path with an installed Apple identity for development or distribution builds. The build fails unless strict code-signature verification succeeds, the signed identifier equals `CFBundleIdentifier`, `Info.plist` is bound, resources are sealed, and the designated requirement is not pinned to one build's CDHash. Ad-hoc signing remains local-only and provides no publisher authentication; distribution still requires an Apple identity and notarization.
- `apps/extension/extension-surface.css`, `apps/extension/extension-surface.js`, and `apps/extension/extension-ui-tokens.js` keep connector pages, content overlays, and transient popouts on the shared light paper visual system. Floating connector surfaces use the same strong outer frame as the popup list picker.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and command buffer. Authentication and pairing requests and responses carry an explicit connector protocol version. Both peers reject missing or mismatched versions before authenticating, and the extension enters a visible terminal incompatible state. The websocket client establishes and verifies request readiness; cached connector state is presentation and diagnostic data, not an RPC preflight authority.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

The connector keeps a short-lived command buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again. Buffered items are semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not replay log records.

The command-buffer module is the only owner and persister of the queue, byte count, pending count, and refuse mode. The websocket layer publishes the exact snapshot returned by that module; it does not merge a second stats cache or persist the same facts again. Buffer persistence is transactional with the in-memory queue: failed `chrome.storage.local` writes roll the mutation back, and listeners are notified only after storage commits. Flush removes an item only after a complete successful daemon command envelope. Every buffered connector write carries explicit `bufferDepth` and `bufferBytes`; the daemon never interprets absent queue metadata as zero. An unknown/malformed queue item pauses the connector and remains at the head of the queue with an `invalid_buffer_item` diagnostic; it is never dropped to make later commands run. Snapshot buffer payloads require their persisted slug, URL, HTML, and timestamp and never synthesize missing values at drain time. Authentication becomes connected only after a strict status response succeeds; malformed JSON, unknown message types, malformed mutations, and failed post-auth status checks close the socket with a diagnostic instead of continuing on a partially understood protocol.

For production use, persistence, blacklist/title policy, auto-pin synthesis, and replay log schema all belong to the daemon.

### Highlights

Highlight notes are persisted through daemon `createNote` commands like other notes. `packages/core/highlight-lifecycle.js` owns page-local selection chunking, scoped DOM matching, mark ownership, bounded hydration retries, and route disposal for both live pages and the snapshot viewer. `content.js` adapts browser messages and daemon note reads to that module; staged extension builds generate `browser-recall-highlight-lifecycle.js` from the same factory for the classic content-script runtime. Same-block selections, including multiline code inside one block, store one string inside the `excerpt` array and one string inside the `cssPath` array; selections spanning distinct block elements store `excerpt` and `cssPath` as aligned string arrays. Reapply uses saved `cssPath` anchors to scope text matching; intentionally empty `cssPath` entries search the document root. Browser Recall panel and overlay DOM is never indexed. After initial reapply, a bounded mutation watcher retains all highlightable notes so client-side DOM replacement can settle. Same-document route changes stop the previous watcher, unwrap old page marks, and then load highlights for the new page identity.

### Localization

The connector extension uses WebExtension native localization. Staged extension bundles include root `/_locales/<locale>/messages.json` files and a manifest `default_locale`; manifest metadata, command descriptions, and extension UI strings use the browser's current UI locale through `chrome.i18n` / `browser.i18n`. The staged extension catalogs are filtered to `extension*`, `command*`, and `common*` keys so desktop-only UI strings are not packaged into the browser connector.

Desktop language options and extension locale directories are generated from the shared locale registry. Asset staging fails when a registered catalog is missing, an unregistered catalog exists, or keys, substitution placeholders, HTML tags, code/keyboard literals, product names, or technical terms drift from the English catalog.

### Settings

Persistent product settings are stored only in `views/manifest/settings.json` through daemon `saveSettingsKey` writes. `crates/replay/src/settings.rs` owns the complete schema, initial values, enum domains, collection shapes, and numeric bounds for `theme`, `colorScheme`, `localeOverride`, `historyFileBatch`, `captureSnapshotVideo`, `blacklistEnabled`, `urlBlacklist`, `titleCleanupEnabled`, `titleTrimRules`, `syncEnabled`, `syncMethod`, `syncRepoUrl`, and `syncRetentionDays`; the daemon re-exports and consumes that replay-owned contract. `colorScheme` supports only `amber` and `mono`; persistent data was migrated from the retired `rose` value before its compatibility path was removed. Replay rejects unknown keys and invalid values, so local commands, remote logs, sync, projections, capture policy, and startup cannot disagree about accepted settings. The daemon creates this complete entity on first startup and recreates it after a destructive clear. The daemon startup/reset workflow is also the only owner of default-list bootstrap; no connector command or extension retry creates those lists. Existing partial, unknown, or mistyped settings are migration errors: reads, capture policy, sync, and startup do not fill missing keys. Desktop settings writes propagate failures and then reload the daemon projection so optimistic controls cannot remain as false state. Runtime-only UI state may still live in `chrome.storage.session`.

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

- `crates/search/` provides native full-text helpers. Snapshot text search enumerates only canonical `objects/snapshots/<two-hex-shard>/*.md` sidecars; raw HTML remains available for saved-page replay and is never loaded or scored by search.
- `crates/daemon/src/search.rs` wires those helpers into command/query paths.
- History search matches page identity fields (`title`, `user_title`, `url`) while preserving a canonical missing title as `null`. Note search strictly reads the owned checkpoint namespace, overlays the latest daemon projection cache, and only then scores note text, so acknowledged mutations are searchable before asynchronous checkpoints flush. Snapshot body text is searched only from Markdown sidecars; note and snapshot phases return their own match scores and timestamps.
- Desktop search/filter input keeps typed text as a local draft and starts the daemon search or filters the current list only when Enter commits the query.
- Committed desktop search results are rendered directly from the in-memory merged result set; the virtual scroller remains for all-history Explore rendering where demand loading can grow the result set.
- While a committed search is loading, the desktop renders the already-loaded matches (or the first non-empty daemon batch) once, accumulates later history/note/snapshot matches in memory, and refreshes the visible result set after all phases finish. This keeps the time chart and result rows operable instead of replacing their DOM for every streamed chunk. Time-chart dates support click toggles and marquee drag selection through the shared chart boundary; a completed drag commits one date-set update and filters either virtualized or direct result rows through the same path. Search activity is shown by one SVG stroke segment tracing the search field's measured pill perimeter instead of a detached results-area spinner. Its perimeter is calculated from the rendered control dimensions rather than a same-frame SVG path-length read, and the measured dash offset runs through the Web Animations API so Chromium and the macOS WebKit desktop surface share the same motion. Colored schemes add a faint accent bloom, mono keeps a crisp structural line, and reduced-motion mode uses a steady outline.
- Desktop UI history search goes through cancellable Tauri streaming commands. The daemon search adapter splits history JSONL work across a fixed worker pool, emits result chunks as workers finish, and cooperatively stops when the UI starts a newer search or leaves search mode.
- History mutation notifications for individual replay entries carry the committed action, timestamp, URL, title/user title, device, leave attention fields, and rating delta. Exact entries participate in mutation identity, so a same-URL visit/leave sequence is never collapsed during batched replay. The desktop merges visit observations into recency, handles rename/rating actions as metadata-only invalidations, and re-reads the affected authoritative page projection through coordinated batch reads; metadata actions never become chart visits or `Last Visit` timestamps. Coarse sync/import notifications without an entry still use the coordinated history refresh path. New browser visits therefore update matching rows, filters, selection, attention, and recency without rereading the current-day JSONL file, restarting the full history/note/snapshot searches, or returning the UI to a loading state.
- Explore device filter choices come from the authoritative `logs/<device>/` directories returned by the daemon history-file listing, not from whichever history rows the UI has demand-loaded.
- The desktop filter panel supports authoritative device membership and page properties (highlights, snapshots, likes, and visits on multiple days). Multi-day membership comes from the replay-derived page `visitDates` projection in every search mode rather than counting whichever raw visit/leave records the UI has loaded. List membership and first/last-seen time ranges are not filter dimensions.
- Full-history streaming and cancellation are desktop-only Tauri capabilities. The connector websocket does not expose full-history search; former history-search message types are rejected as invalid protocol messages.
- Desktop UI note and snapshot search still use daemon-owned request/response commands.
- The connector popup only requests page-scoped summaries; it does not run local full-text search.

Shared query parsing and identity ranking helpers used by the UI phase-0 preview live in `packages/core/`.

## Sync

Sync is daemon-owned.

- `crates/daemon/src/sync.rs` owns GitHub transport, token handling, sync state, pause persistence, and periodic sync orchestration. GitHub branch and tree responses deserialize into typed DTOs with required fields; malformed arrays, missing trees, and incomplete blob entries fail the sync instead of becoming an empty remote state.
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

- UI helpers such as `time-chart.js` and `virtual-scroller.js`
- the shared highlight lifecycle in `highlight-lifecycle.js`, including its generated classic-script bridge source
- localization helpers and WebExtension-compatible locale catalogs in `i18n.js` and `locales/`
- page identity helpers in `page-identity.js`, including canonical URL handling, page slug generation, and the generated classic-script bridge source for content scripts
- idempotent snapshot cleanup and identity metadata injection in `snapshot-html.js`
- shared styling/theme modules
- logger, rule helpers, entity helpers, and search-runtime glue

The connector websocket protocol is represented by the Rust message enums in `crates/daemon/src/protocol.rs`. There is one supported format, protocol version 2. Pairing and authentication requests and responses include that required version: the daemon validates the request before approving or authenticating, and the JS connector validates the response before storing credentials or reporting connected state. Missing or different versions are rejected; there are no version-specific parsing branches. Browser install identity and detected browser family are required; `browserProfile` is always present and is explicitly `null` when the platform cannot report a real profile, so the connector never invents “Default profile.” Other nullable request members, including popup title, rule-preview context, search limit, snapshot title/Markdown, and action-specific history mutation members, are likewise present explicitly. This makes a misspelled nullable semantic field a missing-field error instead of silently dropping data. Successful summary and page-info responses always serialize their required arrays and explicit nulls; failed summaries omit access/display projections instead of returning fabricated `false`, zero, empty, or unknown values. Status responses advertise the daemon's exact maximum WebSocket message size; the connector measures the UTF-8 snapshot envelope and rejects an oversized capture before sending it. The JS connector validates and forwards the complete canonical mutation, including a precise history entry when present. Required fields and their types are validated, while unknown websocket envelope and response fields are ignored so an additive transport field remains compatible with version 2. A change to required fields, field meaning, or semantic command inputs is breaking and requires replacing the single supported protocol version rather than adding compatibility parsing. The JS connector constructs the subset it sends in `apps/extension/connector/ws-client.js`; daemon-side parsing and authority stay Rust-owned.

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

The CI cold-script job runs the complete JS/Rust coverage workflow and a daemon-backed Playwright check that manual seed generation preserves the daemon's current settings checkpoint and uses the same connector flush boundary as automated seeding. This keeps operational scripts from drifting after their primary workflows change.

The desktop smoke / GUI parity suite remains the notable intentionally-skipped gap.
