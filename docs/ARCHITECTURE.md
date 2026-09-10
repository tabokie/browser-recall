# Browser Recall — Architecture

> Keep this document aligned with the shipped desktop-first product.

## Status Note

The current product is desktop-first:

- `apps/desktop/ui/` is the main UI.
- `apps/desktop/src-tauri/` is the shell bridge and desktop runtime.
- `crates/daemon/` owns storage, replay-backed commands, pairing, search, and sync.
- `apps/extension/` is the browser connector for capture, popup actions, pairing, and short-lived buffering.

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
cache. One immutable desktop build plan normalizes host platform names and owns
the Tauri arguments, artifact platform, bundle set, and macOS finalization
policy consumed by build, collection, and finalization. The canonical plan emits
a macOS `app/` bundle and skips installer bundling on other platforms, where the
collected `bin/` executable is the canonical artifact. Collection builds a
complete sibling staging tree before replacing the canonical platform output.
Because WebView2 can lock the whole Windows platform directory, Windows retires
the prior executable within that stable directory, installs the staged
executable, and then promotes the staged remainder. Promotion is
failure-compensated: if a later step fails, the complete prior executable and
remainder tree are restored before the error is returned. A renamed prior
executable remains usable by its running process; failed post-install cleanup
is reported explicitly and retried by a later collection. The warning treats
successful installation and deferred old-file cleanup as separate outcomes,
and tells Windows users to quit the tray process because closing its window
only hides the application.

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

The desktop shell scrolls the main results pane and sidebar independently. Results containers keep a bottom gutter aligned to the sidebar bottom edge, and the virtual scroller preserves that gutter as part of its base padding. Fullscreen toggles capture both scroll containers before the native window transition and restore them through its resize sequence, preventing the webview's transient zero-height/clamped state from replacing either position.

The sidebar's primary Timeline and Book destinations form a calm one-column
navigation stack above Lists. Each destination is a 36 px, left-aligned pill
row with a compact line icon and sentence-case localized label; the selected
row receives the current scheme's accent surface without keycap chrome,
translation, or a font-weight jump. Clicking a destination activates its pill
and matching main title synchronously. The title retains the selected
destination's localization key, so a persisted-locale catalog that finishes
loading later re-translates the active title instead of resetting it to
Timeline. Content rendering starts only after the
finite pill and icon activation transitions have settled and a final painted
frame has been presented, so loading the main view cannot create a second
activation phase. The gate recognizes only the selected pill's background,
shadow, and color transitions plus its icon color transition; unrelated badge,
looping, and paused animations are not part of it. The pill and icon share one
transition-duration token, including the 1 ms
reduced-motion override, and the vertical layout remains stable while the
sidebar is resized. Root lists with children expose accessible, CSS-drawn
`−`/`+` folder toggles; leaf lists use a small hollow circle whose outline color
matches those toggles. The Settings icon is held to the sidebar's smaller 16 px
utility size.

The sidebar exposes a highlight-history view directly after Explore. It renders
each live highlight note in time-descending order, including multiple highlights
from one page. Entries are grouped into local-calendar-day sections headed by a
larger bold-italic `yymmdd` date and presented together on one centered paper
surface. Within a day, every highlight for the same page is collected into one
page group even when another page's timestamp originally falls between them;
the shared page title/site/time line renders once, while every entry retains its
own slim quote rule. Sibling quotations use an 8 px gap, and the shared page
line has the same 8 px whitespace before and after it. Within-day groups use
compact whitespace instead of divider lines, and metadata shares the same right
text edge as the highlight/note columns. The paper, ink, rules, and action
states use an ivory paper surface with neutral grayscale content and controls.
Paper text uses the text-selection cursor; the page title is selectable,
keyboard-focusable link-role text that opens the page through the desktop
system-browser bridge on a single click or Enter, while a selection drag does
not navigate.
The compact sheet uses one regular Gentium size and line height for metadata,
excerpts, notes, and editing, with the date as the deliberate hierarchy
exception. Entries with note text use a 60/40 highlight/note split; highlights
without notes keep the full text measure and omit the empty note row entirely.
Hover and keyboard focus reveal controls in the surrounding
paper gutters: delete sits to the left of the quote rule and note/edit sits to
the right of the text measure. Both are centered within their responsive side
rim, remain visible while that rim is hovered at the block's height, and align
to the highlight block's first line. Starting a note from that control
immediately establishes the two-column layout and focuses the right-side editor.
Rendered note text and its contenteditable replacement share one fixed text
measure so edit mode cannot narrow the note column or text box.
The desktop bundle ships regular and italic Gentium Book Plus 6.200 webfonts
under the SIL Open Font License for deterministic offline typography.
Rendered excerpts and notes use the self-hosted Justif 0.6.5 browser runtime
for whole-paragraph line breaking, English hyphenation, hanging punctuation,
and width-aware reflow, with compact native CSS justification as its explicit
fallback. Multi-segment source newlines remain native `<br>` hard breaks inside
the managed paragraph, so Justif composes all segments and its clipboard
cleanup restores exact source newlines without layout-only characters. The
narrower note column skips Justif's non-hyphenating first pass so discretionary
hyphenation participates in its initial layout. Selectable content inside the
paper uses a visible neutral-grey selection fill while preserving its normal
ink color, including date and page-title labels, metadata, excerpts, notes,
editors, and Justif's generated inline segments. Light and dark themes provide
separate grayscale fill tokens with the same opacity. Justif's synthetic break
marker remains selection-transparent so it cannot produce an oversized WebKit
boundary highlight. Each excerpt's 1 px quote rule uses the same black ink as
the text. Entering the
contenteditable note editor tears down the managed
paragraph first and reapplies it only after rendered note content returns.
Page-detail edit/delete controls remain hidden until their highlight-and-note
block is hovered or receives keyboard focus. Note editing uses a borderless
contenteditable surface with an explicit checkmark confirmation, matching the
connector highlight editor. Successful local edit/delete commands reconcile
only their affected entry; the matching daemon note mutation is consumed as an
acknowledgement so it cannot rebuild the history view, replace unaffected
entries, or reset the main-pane scroll position.
That acknowledgement suppression is scoped to highlight history; page-detail
note actions still refresh their underlying Explore, search, or list view.
The Book paper and loading state paint before its first data read completes.
The UI then requests every `getHighlightHistoryPage` cursor page in sequence,
yielding a painted frame between pages instead of waiting for scrolling or
creating the complete history DOM at once. Each page binds controls and starts
Justif only for its newly appended entries, preserving the managed DOM and
active selection of every earlier page. The daemon cursor owns one immutable,
creation-ordered logical-highlight index for the complete load, then resolves
only the note and page entities needed by each requested page. Concurrent new
highlights cannot shift offsets or duplicate an earlier item, while an explicit
replacement chain resolves to the newest live note. Abandoned cursor indexes
are held only in a small bounded set; the daemon does not materialize or retain
the complete highlight projection before returning page one.
The UI does not infer highlight chronology from page visits or scan entity files
directly.

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

Fresh desktop configuration has an empty internal data-directory path, which the
Tauri shell serializes to the web UI as explicit `null`. Onboarding explicitly
transitions configuration through folder selection and setup completion before
the daemon can start; the installed app has no implicit data-directory default.
Standalone daemon and test adapters must provide their data directory explicitly,
and cannot repoint an already configured daemon through startup arguments.

Launch at login is desktop-platform state owned by the Tauri shell. macOS 13+
uses the native `SMAppService` main-app service, Linux uses the Tauri autostart
integration, and Windows uses a shell-owned `HKCU\...\Run` adapter so the
executable command is always quoted and an absent value is an idempotent
disabled state. A configured startup reconciles the persisted preference with
OS registration, including removing stale registration when the preference is
disabled. Setup and settings compensate the native change if configuration
persistence fails by restoring the adapter's exact prior registration snapshot,
including OS-disabled registrations, and report success only when the persisted
and native states agree. Startup reconciliation failures remain explicit in the
desktop shell next to the launch-at-login setting without preventing the daemon
or the rest of the app from starting; a partial startup change is compensated
from the same exact snapshot before that diagnostic is surfaced.
The autostart crate remains a host-independent Cargo dependency so Tauri's
tracked generated ACL schemas have the same plugin inputs on every build host;
only Linux initializes that plugin at runtime.

The Tauri layer is intentionally thin; storage/search/replay behavior lives in `crates/daemon/`.

Closing the desktop window hides it instead of destroying its webview. The
desktop shell registers Tauri's single-instance integration before every other
plugin, so a second executable or protocol activation exits after forwarding
its deep-link arguments to the existing process. Tray clicks, Dock reopen
events, and forwarded deep links reuse that process's warm webview, preserve
its frame, then unminimize, show, and focus it. A retained physical frame is
restored only while it still intersects a current display work area; otherwise
the window returns to its normal centered frame so display removal or topology
changes cannot strand it off-screen. macOS performs one delayed focus retry to
handle native activation timing.

Paired-browser shell payloads preserve the connector protocol's explicit
nullable `browserProfile`. The desktop validates a non-empty string or `null`;
when the browser cannot report a profile, settings render the browser identity
without inventing or displaying a profile label.

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

`crates/daemon/src/read_projections.rs` owns workflow-shaped daemon reads. Its interfaces cover list display and resolved pin context, page/search enrichment with notes and visible list memberships, highlight history, page info with snapshot availability, visible list trees plus reorder state, recycle-bin restoration eligibility, popup list membership, and settings. Highlight history joins every live page-owned note directly to its original `create_note` timestamp, resolves `replace_note` chains independently of cross-device timestamp order, preserves concurrent live replacement branches from one predecessor, and fails when a live highlight has no authoritative creation event instead of substituting page recency. Its paginated interface retains a bounded immutable logical-highlight index behind an opaque session cursor and resolves only the requested page's current note/page projections; later note files are not read before their page is requested. Page info resolves `note:` and `snapshot:` children into its payload, recognizes `page:` children as navigation relationships owned by the separate relations view, and still rejects unknown child-reference kinds. The popup projection reduces each list to `{slug, name, containsPage, lastActivity}` inside the daemon so raw pin collections never cross the connector boundary. Other projection DTOs expose semantic fields such as `{kind, slug}`, `listSlugs`, and `hasSnapshots`; replay-only IDs, `childIds`, `parentIds`, and raw list-order keys remain inside the daemon. Every entity join reads the latest coordinated projection cache and falls through to disk only on a cache miss. Missing, deleted, malformed, or non-list tree references fail the complete projection read; projection construction never drops a node with `filter_map` semantics. Storage replay recovery, history listing/loading, highlight chronology, and sync collection all use the same internal log catalog, which selects device directories and dated JSONL files before applying strict filename and record validation. Parsed highlight chronology is cached independently of visit traffic and invalidated by note-log appends, synchronized storage replacement, destructive resets, and explicit cache resets.

The Tauri adapter exposes workflow actions (`getListDisplay`, `getPageContext`, `getAllPageContext`, `getHighlightHistoryPage`, `getListTree`, `getRecycleBin`, and `getSettings`) rather than a generic entity-key read. Desktop list, search, detail, highlight-history, tree, recycle-bin, and settings callers consume those projections. The WebSocket adapter uses the same module for page info/summary, popup lists, and settings. Its popup summary is a popup-ready projection: one request applies title and access policy and returns page, note, snapshot, list, and attention data. Generic WebSocket `get_entity`/`get_all_pages` requests are rejected by production sessions and enabled only by explicit daemon test control; the extension `readDesktopValue` relay is staged only in test builds.

Native window, folder, locale, external-open, and sync operations remain Tauri-only. Pairing, connector status, visit/leave observations, popup access policy, and socket cancellation remain WebSocket-only. Reads and streaming search retain their existing transport-specific response forms rather than widening the mutation interface.

Daemon writes are serialized by replay transactions in `crates/daemon/src/runtime.rs`. Command authority, websocket observation ingest, remote replay, rule batch, and sync paths use that module instead of assembling storage ordering themselves. The websocket connector and desktop command bridge use the same command authority and storage projection, so validation, responses, committed mutations, and immediate reads have identical semantics regardless of ingress even while checkpoint files are still catching up. Mutation payload defaults and constructors live in `crates/daemon/src/mutations.rs`; command authority and replay-derived notification paths do not maintain parallel payload schemas.

## Connector Extension

The extension is intentionally thin and no longer owns the main product UI.

### Responsibilities

- Staging generates `browser-build-target.js` with an explicit `chromium` or `firefox` target and loads it before every adapter entry point. `apps/extension/browser-api.js` consumes that target instead of guessing from user-agent text. Its base contract is safe in content scripts, where Firefox intentionally omits privileged namespaces such as `action` and `contextMenus`; `browser-privileged-api.js` validates those namespaces only when background starts. The adapter also publishes the independent execution context (`background`, `extension-page`, or `content`) and one DOM capability for open/closed shadow-root lookup. Orion loads the Chrome artifact through its Chrome-extension compatibility surface and therefore uses the Chromium target, while pairing separately records its Orion product identity from the Kagi runtime marker.
- `apps/extension/content.js` captures visit and attention signals. Because declarative content scripts are classic scripts, staged extension builds load a generated `browser-recall-page-identity.js` bridge before `content.js` so page slug generation still comes from the shared core implementation. Its live-page note editor keeps annotation content and mutation controls in a closed shadow root, retains internal references for focus, and stops bubbling pointer events at the overlay boundary so ordinary page handlers cannot observe its controls.
- `packages/core/highlight-lifecycle.js` owns the shared highlight lifecycle used by live pages and snapshot documents. Its prepared-selection interface rejects ranges intersecting an existing Browser Recall mark before a caller can persist them, and emits aligned strict text-anchor strings in `cssPath`: a `browser-recall-text-anchor:v1:` value contains one stable light-DOM block selector, while `browser-recall-text-anchor:v2:` contains an outer-host-to-inner-block selector array for nested open shadow roots; both versions carry exact block-relative UTF-16 start and end offsets. Reapply traverses the complete composed selector path and verifies the saved excerpt at those exact offsets, so a versioned anchor never falls back to the first matching text. Pre-existing plain-selector `cssPath` entries remain an explicit legacy selector-anchor variant. The lifecycle retains exact ranges for marking only after the daemon accepts the note. Its bounded hydration observer retains saved-note ownership long enough to repair marks removed by client rendering, while each retry skips notes whose owned marks are still intact. Selecting snapshot text alone has no mutation side effect; the background targets the normal highlight shortcut or context-menu activation to the active snapshot viewer, which then uses this same lifecycle to persist and mark the selection.
- Browser Recall-owned page markup uses the `browser-recall-` prefix. Every saved snapshot contains both `x-browser-recall-slug` and `x-browser-recall-url`; readers accept only those current identity fields and do not derive identity from filenames or obsolete marker names. Existing snapshot files were upgraded in place from authoritative page checkpoints before this invariant became required.
- `apps/extension/savepage-bridge.js` orchestrates snapshot capture as one identified session per tab. The session owns settings, lifecycle timers, and typed resource diagnostics; overlapping captures are rejected, stale messages cannot settle newer captures, and intentional policy skips remain distinguishable from network, security, unsupported, and budget omissions. Save Page first fetches from the page context, then uses the extension's host-permission-backed HTTP(S) fetch path for resources that require a CORS bypass; the extension CSP explicitly permits that recovery path. Both paths use `packages/core/bounded-response.js` to enforce the 50 MB per-resource limit against streamed bytes rather than trusting `Content-Length`. Before capture starts, `packages/core/snapshot-capture-budget.js` derives the JSON-encoded HTML allowance from the daemon-advertised complete WebSocket message limit. After retained frames reply, the page performs a resource-free serializer pass so nested documents, shadow roots, and attribute escaping are part of the structural reservation; it then keeps mutation overhead, schedules at most six resource loads, provisionally divides the remaining encoded allowance among in-flight reads, and accounts for base64/percent expansion and repeated references before accepting content. Staging injects the generated build target and context-safe adapter into every retained frame before capture. The serializer calls the adapter's single shadow-root capability: Chromium and Orion use `chrome.dom.openOrClosedShadowRoot` when the host supplies it, while Firefox serializes open roots without touching unsupported privileged or closed-root properties. Content-script notification hosts are registered in an isolated-world `WeakSet`, and both the top-level and retained-frame serializers omit only those exact extension-owned subtrees before shadow traversal so capture progress and result bubbles cannot enter an archive or collide with page attributes. Before persistence, the pure `packages/core/snapshot-html.js` preparation boundary removes Browser Recall highlight markup and the inactive vendored shadow-loader script, replaces all snapshot identity metadata with exactly one authoritative slug-and-URL pair, deactivates stylesheet links Save Page could not embed, and enables declarative shadow roots without rewriting serialized markup inside `srcdoc` attributes. `scripts/migrate-snapshot-identity.mjs` validates snapshot shards and page checkpoints, verifies each page URL produces the checkpoint/file slug, replaces obsolete identity, adds missing identity, and atomically upgrades stored HTML before the current runtime is used. Snapshot reads strictly validate the one current identity shape before applying only the remaining idempotent replay preparation; reads never add or replace identity metadata. Completed `file:` snapshot tabs are inspected through the extension scripting boundary because a pre-upgrade raw file has no content-script receiver; the inspection requires exactly one current slug and URL. When Chrome file-URL access is disabled, the popup renders a localized terminal diagnostic with an action that opens the extension details page instead of attempting script injection and reporting generic page-data failure. The all-frame helper serializes live shadow trees before retained cross-origin frame HTML crosses the message boundary; the trusted viewer recursively prepares nested `srcdoc` documents, including frames inside serialized shadow trees, while archived scripts remain blocked. Replay therefore never blocks first paint on a resource that capture already declared unavailable; successfully embedded `<style>` content remains intact.
- `apps/extension/background.js` buffers semantic connector commands, serves popup requests, manages pairing, and forwards RPC to the daemon. It is the sole tab page-identity resolver: reported same-document URLs, content-script identity, embedded saved pages, and snapshot-viewer slugs are validated there against desktop data. Same-document navigation detection combines the injected page-world History API observer with the browser-level `webNavigation.onHistoryStateUpdated` event; the browser-level event enters the same idempotent content-script leave/visit, highlight-reset, and badge lifecycle, so sites that bypass or replace injected History method wrappers cannot retain the prior page identity. While an HTTP(S) tab is still loading before its `document_idle` content script is available, popup preparation inspects already-parsed embedded identity metadata and otherwise derives identity from the browser-reported tab URL instead of treating the absent receiver as an identity failure; completed tabs still require the validated content-script response. Popup preparation and snapshot-viewer badge-marker reads share that resolver, so both use the original page URL, title, notes/snapshots, and list memberships. Direct popup loads request that resolved identity from background instead of reproducing the rules. Toolbar clicks do not use a manifest `default_popup`: background immediately stores an ordinary bootstrap with connector state `starting` under a one-shot in-memory token and opens `popup.html?bootstrap=...` with `chrome.action.openPopup()`, while page-identity resolution and the complete popup-ready daemon projection continue behind that handoff. The popup document opens promptly but keeps its semantic surface unpainted until the completed handoff supplies authoritative page data or a terminal diagnostic; the initial browser-reported URL and title never become a rendered or semantic identity. Connector state is read locally after the projection request only to classify failures; it is not a separate RPC preflight. The token exists because extension action popups accept a URL but not an object payload; it is an in-memory handoff, not product persistence. Normal toolbar opens install only a per-tab action mapping, and the popup clears it as soon as its document connects or consumes the token; the runtime port then bounds only the pending bootstrap entry until disconnect. The tab identifier is also encoded in the popup URL so a restarted worker can clear a stale browser-owned mapping, while a missing token falls through to direct startup. Each token records the daemon-mutation revision observed before preparation; if a committed mutation arrives before final consumption, background rebuilds the bootstrap from the daemon instead of handing stale metadata to the popup. Preparation remains timeout-bounded; a timeout reveals the terminal data-unavailable diagnostic instead of an intermediate state. Engines without programmatic action popups, and engines that reject an attempted programmatic open, deterministically fall back to opening the same pending extension page in a tab. Test-only reset/seed/queue RPC handlers live in `apps/extension/background-test-control.js` and are staged only by the test fixture.
- `apps/extension/popup.js` is the current-page dashboard backed by daemon RPC; its list picker is a short-lived popup control, not extension persistence. The picker keeps one input node mounted from initial popup markup through capture and picker modes so startup typing and native IME composition are not interrupted by DOM reparenting or focus replacement. Tokenized toolbar-opened popups and direct popup loads remain opacity-hidden while their complete popup-summary projection is pending, then reveal exactly one complete dashboard or terminal diagnostic. Prepared toolbar payloads and directly fetched summaries both enter `renderDashboardSummary`, which owns the complete title, URL, attention, snapshots, notes, and list render. Static markup establishes the final dashboard width, minimum height, default theme, and diagnostic DOM but remains unpainted until a terminal renderer calls `revealPopup()`, so cold extension code cannot expose a false connector error or title/URL-only shell. Connector refreshes capture the current diagnostic owner and generation before awaiting storage-driven probes; both fulfillment and rejection may update the panel only while that same connector diagnostic still owns it, so a stale result cannot replace a newer page-specific diagnostic or dashboard. Private mode is resolved before entering the dashboard shell. Resuming recording keeps the paused surface visible while it resolves the background-owned page identity and commits the visit, then invokes the same summary-loading and rendering path as a direct load. A failed visit commit renders the standard page-data diagnostic instead of leaving the popup on an empty banner. Accepted connector observations return an explicit success acknowledgement, so a successfully queued visit cannot be interpreted as a failed popup mutation. One serialized mutation lane owns user actions, while one current-page generation owns asynchronous renders; pending handoff settlement retains completed success or failure outcomes until the mutation lane settles, then uses that generation to decide whether the handoff still owns the surface. A failed mutation therefore cannot discard a current handoff, and a rejected stale handoff cannot paint over a newer transition. The picker opens from the already prepared per-open list projection instead of rereading lists. Existing membership toggles use one semantic mutation request; creating a list and adding the current page uses the combined `createListAndPin` semantic command, so both replay effects commit in one daemon transaction and one connector round trip. Both paths apply the committed response locally and let the committed mutation stream perform any later authoritative reconciliation. An open popup refreshes current-page list metadata when committed daemon pin/list mutations arrive, while other sections remain a per-open snapshot plus the popup's own user actions. Popup-originated mutations and live list refreshes run through one serialized UI lane: explicit command clicks are ignored while the lane is busy, and explicit highlight-note confirmation marks the lane busy before later actions can start. Busy state disables conflicting controls but never globally dims the popup. `extension-surface.js` supplies one highlight-entry renderer, editor state machine, icon set, base CSS, and closed-shadow mark-overlay factory to the popup, scrollbar-free PDF panel, live page, and snapshot viewer. Live and archived pages therefore render the identical red quote rule, borderless contenteditable note field, X delete action, and checkmark confirmation from one implementation; each supplies only its document and mutation callbacks. Empty annotations remain unlabeled, and a failed edit or delete keeps the entry intact and retryable. The standalone Hide markup action is transient: a live content-script receiver or snapshot-viewer runtime adapter stops that document's current highlight hydration watcher and unwraps Browser Recall marks without changing desktop-owned notes; surfaces without either adapter still render notes but omit the unavailable action. Each document owns its transient state, so reopening the popup still shows the inverse-color Show markup action until the user shows markup or a later page load or route transition resets and reapplies it.
- The `Alt+R` extension command opens the popup through the same prepared action-popup path as a toolbar click, including the engine fallback that opens the pending popup page in a tab. Chrome permits only four suggested shortcuts, so Dislike page remains configurable from the extension shortcut manager but has no default binding.
- `apps/extension/icon-paths.js` and `apps/extension/badge-controller.js` switch packaged toolbar icons at runtime: the default icon is used for normal capture, the closed-eye icon for session-only recording pause, and state-colored backgrounds indicate special page-marker states. The badge controller awaits background's tab identity resolution before reading markers, including for extension-hosted snapshot viewers. When a viewer finishes loading, background probes the live connector state before refreshing its icon instead of allowing an earlier cached `starting` state to suppress the authoritative marker read.
- Icon PNGs, the Windows multi-size `.ico`, and the macOS `.icns` are generated from root SVG sources by `scripts/generate-icons.mjs`. Desktop slots render directly at their native target dimensions so browser SVG antialiasing is not softened by a second area-resampling pass; extension toolbar slots retain their separately tuned supersampling pipeline. The Windows ICO carries native representations for every standard Windows DPI step from 100% through 400%, plus 256 px for Explorer. On Windows, the desktop shell loads the DPI-matched small and large representations from that executable resource into the live HWND and refreshes them after monitor-scale changes; this avoids Tauri's default behavior of assigning only the first ICO entry as a small icon and leaving Windows to enlarge it for the taskbar. The cross-platform ICNS encoder carries the complete modern standard and Retina PNG slots through 1024 px, so Windows generation cannot leave a stale macOS asset. Tauri's build script watches all three desktop icon containers and regenerates its build context whenever one changes. The full desktop app and extension toolbar icons keep an opaque background, while the desktop tray icon is transparent for macOS template rendering. macOS app bundles are always signed as complete bundles: local builds default to Tauri's ad-hoc `-` identity and finalize it with an explicit bundle-identifier designated requirement so rebuilds do not become different CDHash-only identities; `APPLE_SIGNING_IDENTITY` overrides the ad-hoc path with an installed Apple identity for development or distribution builds. The build fails unless strict code-signature verification succeeds, the signed identifier equals `CFBundleIdentifier`, `Info.plist` is bound, resources are sealed, and the designated requirement is not pinned to one build's CDHash. Ad-hoc signing remains local-only and provides no publisher authentication; distribution still requires an Apple identity and notarization.
- `packages/core/shared.css`, `apps/desktop/ui/index.html`, `apps/extension/popup.html`, `apps/extension/extension-surface.css`, and `apps/extension/extension-surface.js` keep `system-ui` in each ordinary UI stack before its generic fallback family. Unsupported glyphs, including CJK characters absent from the preceding bundled or platform-specific Latin faces, therefore reach the host's UI-font fallback instead of the final generic serif or monospace face. A Chromium platform-font probe verifies the actual CJK font used by popup and shadow surfaces against an explicit `system-ui` control, including on Windows CI. Desktop form controls, storage paths, excluded-site entries, and title-cleanup rules use the body stack; monospace is reserved for genuine code and diagnostic-log surfaces. The extension surface files also keep connector pages, content overlays, and transient popouts on the shared light paper visual system. Floating connector surfaces use the same strong outer frame as the popup list picker.
- `apps/extension/connector/` contains the websocket client, pairing helpers, and command outbox. Its volatile connection machine has five phases: `offline`, `connecting`, `waiting_for_approval`, `synchronizing`, and `ready`. Only `ready` has daemon authority (`running` or `paused`) and per-session capabilities. Authentication is not readiness: the authenticated session must validate status and complete the initial FIFO outbox drain before it becomes ready. Interactive RPC preparation starts or joins the current connection even when a credential write is still in flight, and waits for an authenticated socket instead of sending a privileged message on an open but unauthenticated socket. Snapshot preparation additionally follows a replacement authenticated session through its status exchange before using the advertised message limit. Each socket belongs to one identified session, so callbacks and request responses from a replaced session cannot publish state or settle current work. Retry timers and alarms are two wakeup adapters for the one `offline.retryAt` transition. Connection waits subscribe to this machine directly; popup/badge strings (`starting`, `pair_pending`, `connected`, and failure labels) are a derived presentation projection and are never consulted for transition decisions. Every background connection or drain launch observes unexpected rejection and publishes a diagnostic transition. Authentication and pairing requests and responses carry an explicit connector protocol version. Both peers reject missing or mismatched versions before authenticating, and the extension enters a visible incompatible projection. Cached connector state is presentation and diagnostic data, not an RPC preflight authority; transient socket phases are never restored from storage.
- `apps/extension/options-stub.html` exists only to direct the user to the desktop app.

### Buffering Model

Same-document navigation forwarding retries transient content-script delivery
failures against the current top-frame URL. A newer navigation or a removed tab
cancels older pending work. After three quick attempts, unresolved delivery
remains worker-local pending state and retries every five seconds. The affected
tab displays an error badge and a popup diagnostic until delivery succeeds or
a newer navigation supersedes it; unrelated tabs and the daemon connection
remain usable. Browser API retries keep the worker alive while delivery is pending.
Content-script startup and popup identity reads also reconcile the live URL,
and delayed signals for a superseded URL cannot capture another page's DOM.
The cached leave title is bound to its active page URL, so a destination title
mutation cannot overwrite the source page while navigation delivery is pending.
The document-start navigation bridge observes YouTube's `yt-navigate-start`
and `yt-navigate-finish` events: the previous page's attention is reported at
start, and destination visits and highlight restoration wait for completion so
the destination receives its own title and content. Ordinary History API
transitions continue through the same idempotent content-script handler.

The connector keeps a short-lived command buffer so capture and popup actions can survive daemon disconnects briefly, then flush forward once the paired desktop is available again. Buffered items are semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not replay log records.

The command-buffer module is the only owner and persister of the queue, byte count, and pending count. Its storage operations are serialized and transactional with the in-memory queue: failed `chrome.storage.local` writes roll the mutation back. There is no persisted refuse-mode latch; an enqueue that would exceed the byte limit fails explicitly, while a later acceptable enqueue proves the outbox is accepting again. The websocket session owns the single drain task and removes an item only after a complete successful daemon command envelope. Queue depth and byte telemetry never cross the wire because the daemon neither controls nor consumes the extension outbox. An unknown or malformed queue item pauses the connector and remains at the head with an `invalid_buffer_item` diagnostic; it is never dropped to make later commands run. A failed post-ready drain remains visible until that same outbox drains successfully; a later running status cannot erase it. Snapshots bypass extension storage, require their slug, URL, HTML, and timestamp, and never synthesize missing values at send time. Authentication enters `synchronizing`; a paused status skips the impossible initial drain, while running authority requires the initial drain before ready. Malformed JSON, unknown message types, malformed mutations, and failed post-auth status checks close the current session with a diagnostic instead of continuing on a partially understood protocol.

For production use, persistence, blacklist/title policy, auto-pin synthesis, and replay log schema all belong to the daemon.

### Highlights

Live highlight creation carries the observed document title. When the daemon
has no page title in its current projection, `createNote` applies the same
daemon-owned title cleanup policy as visit capture before appending the note
event. A highlight therefore preserves a cleaned title even when selective
checkpoints have omitted the earlier transient page; title capture does not
change selective checkpoint policy or require replaying old visits.

PDF panel note edits use the shared highlight lifecycle's note replacement
method after daemon acknowledgement, keeping the panel row and any composed-tree
marks bound to the committed replacement slug before leaving edit mode.

Highlight notes are persisted through daemon `createNote` commands like other notes. `packages/core/highlight-lifecycle.js` owns page-local selection preparation, strict text-anchor serialization, exact-range application and reapply, mark ownership, bounded hydration retries, and route disposal for both live pages and the snapshot viewer. `content.js` and `snapshot-viewer.js` adapt persistence to that interface; staged extension builds generate `browser-recall-highlight-lifecycle.js` from the same factory for the classic content-script runtime. Same-block selections, including multiline code inside one block, store one string inside the `excerpt` array and one strict text-anchor string inside the aligned `cssPath` array. Light-DOM anchors use v1 with one stable block selector; anchors inside nested open shadow roots use v2 with an ordered selector array that resolves each outer host, enters its shadow root, and ends at the scoped block. Both encode exact block-relative UTF-16 start and end offsets. Selections spanning distinct block elements store one aligned anchor per excerpt chunk. Reapply resolves each composed scope and verifies the excerpt at its exact offsets, so a versioned anchor cannot silently move to the first matching text when a block contains duplicates or its content shifts. Pre-existing plain selectors, including an empty string that selects the document root, are parsed as an explicit legacy selector-anchor variant and retain scoped text matching. A selection intersecting `mark.browser-recall-highlight` is rejected before `createNote`, preventing nested marks and duplicate persisted notes. Browser Recall panel and overlay DOM is never indexed. After initial reapply, a bounded mutation watcher retains all highlightable notes so client-side DOM replacement can settle. Same-document route changes stop the previous watcher, unwrap old page marks, and then load highlights for the new page identity.

### Localization

The connector extension uses WebExtension native localization. Staged extension bundles include root `/_locales/<locale>/messages.json` files and a manifest `default_locale`; manifest metadata, command descriptions, and extension UI strings use the browser's current UI locale through `chrome.i18n` / `browser.i18n`. The staged extension catalogs are filtered to `extension*`, `command*`, and `common*` keys so desktop-only UI strings are not packaged into the browser connector.

Desktop language options and extension locale directories are generated from the shared locale registry. Source discovery and copying exclude `.DS_Store` entries and exclude `._*` files only after verifying the AppleDouble binary magic header; an ordinary source file whose name starts with `._` remains included. Localization validation receives ordinary sources and has no filename-based bypass. Asset staging fails when a registered catalog is missing, an unregistered catalog exists, or keys, substitution placeholders, HTML tags, code/keyboard literals, product names, or technical terms drift from the English catalog.

### Settings

Persistent product settings are stored only in `views/manifest/settings.json` through daemon `saveSettingsKey` writes. `crates/replay/src/settings.rs` owns the complete schema, initial values, enum domains, collection shapes, and numeric bounds for `theme`, `colorScheme`, `localeOverride`, `historyFileBatch`, `captureSnapshotVideo`, `blacklistEnabled`, `urlBlacklist`, `titleCleanupEnabled`, `titleTrimRules`, `syncEnabled`, `syncMethod`, `syncRepoUrl`, and `syncRetentionDays`; the daemon re-exports and consumes that replay-owned contract. Fresh and reset settings use the explicit `light` theme by default; an empty desktop session also paints light before daemon settings hydrate, while persisted `system` and `dark` remain valid user choices. `colorScheme` supports only `amber` and `mono`; persistent data was migrated from the retired `rose` value before its compatibility path was removed. Replay rejects unknown keys and invalid values, so local commands, remote logs, sync, projections, capture policy, and startup cannot disagree about accepted settings. The daemon creates this complete entity on first startup and recreates it after a destructive clear. The daemon startup/reset workflow is also the only owner of default-list bootstrap; no connector command or extension retry creates those lists. Existing partial, unknown, or mistyped settings are migration errors: reads, capture policy, sync, and startup do not fill missing keys. Desktop settings writes propagate failures and then reload the daemon projection so optimistic controls cannot remain as false state. Runtime-only UI state may still live in `chrome.storage.session`.

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

The connector websocket protocol is represented by the Rust message enums in `crates/daemon/src/protocol.rs`. There is one supported format, protocol version 3. Pairing and authentication requests and responses include that required version: the daemon validates the request before approving or authenticating, and the JS connector validates the response before storing credentials or reporting readiness. Missing or different versions are rejected; there are no version-specific parsing branches. Browser install identity and detected browser family are required; `browserProfile` is always present and is explicitly `null` when the platform cannot report a real profile, so the connector never invents “Default profile.” Other nullable request members, including popup title, rule-preview context, search limit, and snapshot title/Markdown, are likewise present explicitly. This makes a misspelled nullable semantic field a missing-field error instead of silently dropping data. Successful summary and page-info responses always serialize their required arrays and explicit nulls; failed summaries omit access/display projections instead of returning fabricated `false`, zero, empty, or unknown values. Status contains only the device identity, exact maximum WebSocket message size, and authoritative daemon state. Snapshot capture and upload wait for that authenticated per-session status round trip before reading the limit, then the connector measures the UTF-8 snapshot envelope and rejects an oversized capture before sending it. Command and snapshot messages do not report connector queue telemetry; acknowledgements mean durable acceptance and carry no unused timestamps or depths. Pairing-pending and pairing-approved responses omit daemon-internal request identity and device identity respectively; the mandatory status exchange is the single device-identity source. Connector mutation notifications contain only `type`, `url`, and `urls`, the fields extension consumers use. Directory inspection and ping/pong are not connector operations; native directory workflows remain Tauri-owned and status is the liveness probe. Required fields and their types are validated, while unknown websocket envelope and response fields are ignored so an additive transport field remains compatible with version 3. A change to required fields, field meaning, or semantic command inputs is breaking and requires replacing the single supported protocol version rather than adding compatibility parsing. The JS connector constructs the subset it sends in `apps/extension/connector/ws-client.js`; daemon-side parsing and authority stay Rust-owned.

## Testing Model

GitHub jobs and local verification share the `ci:*` package-script entrypoints.
The composed `npm run ci` command runs every hosted test and lint group before
a change is committed.

Current automated coverage is split across three layers:

- `tests/unit/` for shared JS helpers and connector-side utility logic
- `tests/integration/` for daemon/connector RPC and event-flow coverage
- `tests/e2e/` for current shipped extension popup and connector behavior

The canonical desktop visual run also compiles a small native macOS WKWebView
probe against the staged production UI. It guards webview-only layout behavior
that Playwright WebKit does not reproduce, including stable chart-to-list
spacing when the first page selection highlights a chart bar.

Desktop locale registration and persistence are covered by a daemon-backed
Playwright workflow that drives every registered locale through the production
desktop settings UI and connector command path, verifies each real settings
checkpoint, reloads the UI, and checks Arabic RTL direction. A separate
browser E2E verifies that the packaged extension resolves messages through its
real WebExtension locale catalog. Only Tauri shell-only surfaces are shimmed.

E2E is the preferred product safety net for desktop and extension behavior. New coverage should favor real user workflows, cross-feature combinations, and seeded randomized inputs over expanding unit-test LoC. Rust daemon integration tests are the preferred fallback for daemon authority behavior that is impractical to assert through browser E2E. `scripts/test-coverage-monitor.mjs` surfaces JS and Rust uncovered production line ranges for triage, tracks the suite mix, and fails on JS or inline Rust unit-test LoC growth unless an explicit exception is made.

The CI cold-script job runs the complete JS/Rust coverage workflow and a daemon-backed Playwright check that manual seed generation preserves the daemon's current settings checkpoint and uses the same connector flush boundary as automated seeding. This keeps operational scripts from drifting after their primary workflows change.

The desktop smoke / GUI parity suite remains the notable intentionally-skipped gap.
