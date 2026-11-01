# Browser Recall — Architecture

Browser Recall stores browsing history, highlights, lists, and snapshots in a
user-selected folder. The desktop app manages data and settings; the browser
extension captures pages and provides current-page actions.

## Components

The daemon is the Rust service inside the Tauri desktop process. Desktop commands
call the daemon directly; extensions connect through authenticated local WebSockets.

```text
desktop UI → Tauri commands/events → daemon → replay/search → data folder
browser extension → authenticated local WebSocket → daemon
```

| Component                 | Responsibility                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| `apps/desktop/ui/`        | Timeline, Book, search, lists, settings, imports, recycle bin                  |
| `apps/desktop/src-tauri/` | Native windows, setup, deep links, login, reviews, updates, daemon integration |
| `crates/daemon/`          | Storage, commands, recording policy, rules, pairing, sync                      |
| `crates/replay/`          | Event schemas, replay, checkpoint selection, data verification                 |
| `crates/search/`          | History, note, and snapshot-text search                                        |
| `apps/extension/`         | Capture, popup, pairing, temporary command queue                               |
| `packages/core/`          | Shared identity, highlights, extraction, translations, UI helpers              |
| `website/`                | Static product page and fictional demos                                        |

The website shares presentation modules with the application but has no backend
or access to user data. Isolated iframe demos use production styles, Book markup,
Justif typesetting, and sample data. Demos keep a fixed 510 px height and leave
scrolling to the outer page. GoatCounter page views run only on the hosted HTTPS
page; see [Privacy](PRIVACY.md#website-analytics).

## Storage

Setup requires an explicit data-folder choice. Standalone daemons and tests must
also specify a folder or load an existing configuration.

```text
<data-folder>/
  AGENTS.md
  logs/<device>/<YYYY-MM-DD>.jsonl
  objects/notes/<noteSlug>.json
  objects/snapshots/<shard>/<pageSlug>-<timestamp>.html
  objects/snapshots/<shard>/<pageSlug>-<timestamp>.md
  views/pages/<shard>/<pageSlug>.json
  views/lists/<listId>.json
  views/manifest/
    list-order.json
    list-name-to-id.json
    orphaned.json
    settings.json
    replay-progress.json
```

Logs contain one event per JSONL line and are the source of truth. Replay applies
those events to rebuild current state. Checkpoints in `views/` save replay results.
A slug identifies a page or note; a shard is the first two hexadecimal characters
of the SHA-256 hash of the page slug or snapshot stem. Record IDs omit the shard.

Save a page checkpoint only for list membership, notes, snapshots, a user-edited
title, or a rating. The daemon and verifier share this decision in Rust replay.
Note JSON stores highlights and annotations. Snapshot HTML cannot be rebuilt from
logs; optional snapshot Markdown provides searchable text.

The daemon maintains a data-format guide in the data folder's AGENTS.md, preserving
user-written text outside the managed section. The guide is not synced. External
writers must follow [the data-folder contract](../crates/daemon/resources/data-AGENTS.md).
Browser Recall has no general filesystem watcher: restart to apply external logs.

### Identity and schemas

`packages/core/page-identity.js` defines URL normalization and slugs. The extension
removes query parameters beginning with `_`; other query parameters and fragments
distinguish pages. Rust replay hashes the supplied URL, so migrations and external
writers must use the same normalization.

Rust replay rejects unknown fields, invalid values, and missing required fields,
including nullable fields. Optional references may be absent for valid non-page
URLs; malformed HTTP(S) references remain errors. Command previews, hints, legacy
`items`, rule `fields`, and `case_sensitive` do not belong in logs.

`pin_to_list` and `unpin_from_list` use `urls`. Non-null `pin_to_list.titles` must
align with `urls`; nullable `source` is required and must not become `manual` when
absent. List `slug`, `name`, and `owner` must be nonempty. Live notes require
nonempty, aligned `excerpt` and `cssPath` arrays; deleted notes may omit anchors.

Migrate data before changing formats, then remove obsolete readers/writers.
Malformed Browser Recall files cause explicit errors; unrelated files are ignored.

### Writes and recovery

`crates/daemon/src/runtime.rs` serializes writes:

1. Read current state, including results of earlier commands in a batch.
2. Reserve space in the checkpoint writer's queue.
3. Append validated events to the logs.
4. Apply events to in-memory state.
5. Queue checkpoints in accepted-command order.

Reads use current memory and storage-layer disk reads for uncached records.
Checkpoints use temporary-file replacement. Shutdown, deletion, and reset coordinate
pending writes so older work cannot recreate deleted records.

`replay-progress.json` records each device's checkpoint watermark. Startup replays
newer accepted events before serving reads. Replay must be idempotent: applying an
event twice has the same result as applying the event once. Rename handlers must
recognize the destination through stable record identity or replay timestamps.

Sync validates downloaded records and replay before installation, finishes earlier
checkpoint work, then installs files and updates memory. Downloaded events are not
appended again as local events. Notifications retain affected record IDs and change
types, including visits versus metadata edits; deduplication compares contents too.

## Commands, reads, and configuration

`command_authority.rs` validates semantic commands for Tauri and authenticated
WebSocket callers. Commands describe actions such as pinning a page or creating a
note. Invalid requests fail before mutation. Success and notifications follow log
append and in-memory publication. Wrappers must reject `{ success: false }`.

`read_projections.rs` combines records for page context, lists, highlights, trees,
recycle bin, popup, and settings. Referenced records come through storage; invalid
references fail the response. Internal relationship IDs stay in the daemon.
Search and UI details use these APIs rather than reconstructing storage keys.

Highlight history follows original `create_note` events through replacement chains.
Concurrent replacements remain visible. Cursor batches use creation time and read
current note/page records for the requested highlights only.

Native window/folder operations, language changes, external URLs, and sync use
Tauri. Pairing, connection status, visits, and recording eligibility use WebSocket.
Raw events, arbitrary record access, resets, and seeding require explicitly enabled
`test_control`; production extensions omit test handlers.

### Local configuration

Desktop `config.json` lives directly in Tauri's application configuration directory,
separate from the collection. The file stores the data-folder path, device identity,
pairing credentials, sync metadata, and optional review history. Desktop test profiles
use `config.json` at the profile root; standalone daemons use `--config-dir`.

`ConfigStore::update` locks, re-reads, validates, and atomically replaces configuration.
Callers change only owned fields. Missing fields from older releases receive
canonical defaults; malformed supplied values and unknown fields remain errors.
Missing device identity is machine-derived; a missing data path returns to setup;
`setup_complete` is inferred from an existing path.

Nested metadata also has upgrade defaults, but connector identities and pairing
tokens remain required. Missing review attempts become an empty array. A missing
first-opening timestamp is recovered from the first request minus seven days, or
starts now when no requests exist. Recovery preserves request times/counts and
persists completed configuration under the writer lock.

## Desktop app

Closing the window hides the webview while the process stays running. Tray, Dock,
and deep-link actions reopen the same window. Single-instance handling registers
before other plugins. Off-screen saved positions are centered on an available
display. On macOS, preserve the complete `NSWindow` frame rather than deriving the
frame from webview size.

A daemon startup failure leaves a visible error with Resume after storage repair.
Concurrent starts share one attempt; reads never start another daemon. Errors
reach callers, and locks remain usable after a thread panic.

Launch at login uses macOS `SMAppService`, Linux autostart, or a quoted Windows Run
registration. Failed persistence rolls back the operating-system change. Startup
reconciles the registration and reports failures beside the setting.

Tauri plugins generating permission schemas remain unconditional Cargo dependencies,
even when runtime use is platform-specific. Generated schemas must match across hosts.

### Reviews and updates

The `mac-app-store` Cargo feature enables StoreKit and disables GitHub updating.
Only this channel initializes `review_requests` in `config.json`. The first attempt
requires seven days after first opening; the second requires thirty days after
the first attempt. At most two attempts are allowed, with no expiry windows.
Collection changes and app updates preserve history.

Successful edits, searches, navigation, and closing details create review
opportunities. Presentation requires three seconds without interaction, a focused
visible window, and no busy editor, dialog, error, import, search, or sync. Activity,
focus loss, new work, and webview reload cancel stale requests.

The Rust coordinator owns eligibility, reservation, cancellation, and rollback.
A blocking worker persists an attempt before StoreKit; suppression still consumes
the attempt. Failed persistence prevents presentation. Native activity epochs
reject delayed callbacks. The AppKit callback performs no configuration locking,
JSON processing, or file I/O. The Swift bridge uses `AppStore.requestReview(in:)`
on macOS 13+; test profiles never invoke StoreKit.

Regular builds use the GitHub updater and cannot request App Store reviews.
`updates.rs` serializes checking, download, and installation. Release builds check
the latest stable release after startup and every twelve hours; users choose
**Update and restart**. Signature verification precedes daemon shutdown. Installation
waits for commands/sync, closes connectors, and saves accepted writes. The operation
lock remains held through recovery/restart; errors become retryable afterward.
Updates preserve configuration and collection data and do not require GitHub sync.

### Rendering

Timeline and Book activate navigation state synchronously, then wait only for named
navigation transitions. Unrelated animations cannot delay content. Main/sidebar
scroll independently; refreshes retain reading position, including scrolling during
pagination. Destination changes start at the top.

Virtual scrolling renders nearby rows. Use consistent viewport-relative coordinates
for row positions and anchors, preserve computed padding, and avoid full `innerHTML`
replacement during DOM-changing callbacks. Read back clamped scroll positions.

Book loads successive highlight batches, groups by local date/page, and edits rows
in place. Matching notifications confirm local changes; external changes refresh
Book. Gentium Book Plus and Justif provide text layout while copying preserves the
original text. Snapshot actions open HTML or reveal/select HTML and optional
Markdown in the file manager; missing HTML is an explicit error.

## Browser connector

Separate Chromium/Firefox builds share capture and command code. Browser API
adapters distinguish background-only capabilities and identify Orion explicitly.
An injected page-world script detects History API changes; browser navigation events
cover other transitions. Duplicate reports do not repeat leave/visit actions.

### Recording and delivery

`recording-controller.js` serializes navigation, attention, pause changes, and
command admission. Commands accepted before a pause remain accepted; delivery does
not hold the recording queue open. Recording changes update icons without sending
messages to every tab.

Automatic recording eligibility is fixed at main-frame navigation start. Documents
opened while paused remain excluded after resume, including slow loads and
same-document navigation; an active-recording refresh creates an eligible document.
Document tokens bind reports to the tab/browser document. Explicit actions remain
available. Missing navigation history after a pause is an error.

A background attention clock excludes paused time. Recording state, pending
navigation, tokens, and attention starts live in `storage.session`, survive worker
suspension, and disappear when tabs close. The popup reads daemon data and never
synthesizes visits. Navigation retries are bounded to the current document; newer
navigation cancels older work. Leave reports retain the departing page's title.

The connection phases are `offline`, `connecting`, `waiting_for_approval`,
`synchronizing`, and `ready`. Authentication validates status and drains pending
commands before `ready`; paused sessions defer draining. Socket session IDs prevent
stale callbacks changing a newer session. Invalid messages close the connection.

The short-lived command queue persists commands and byte counts together, rolls
back failed storage writes, and removes commands only after daemon success. Invalid
commands block delivery with an explicit error. Direct commands and snapshots wait
for draining, including commands arriving during a drain. Snapshot HTML goes
directly to a ready daemon and is never persisted in extension storage.

Protocol version 4 requires matching pairing/authentication versions, browser name,
and `browserProfile` even when null. Status supplies device/state/message-size
limits. Wrapper extensions are allowed; changes to required fields or meaning need
a protocol version change.

### Popup and editors

Toolbar opens resolve the original page and fetch a complete daemon summary before
opening. A single-use token transfers the result; preparation exceeding 1.5 seconds
shows an error. Direct opens use the same renderer. Page changes and daemon updates
invalidate prepared summaries; failed opens never fall back to an extension tab.

The hidden document reserves startup size. Visible dashboard/error content sizes
the popup through normal layout flow. Fatal errors use a bounded scrollable message
and visible Reload button. Popup edits and list refreshes serialize; `createListAndPin`
creates and pins together. Keep the list input stable during typing/composition.

Save, delete, and editor closing share one queue. Failed edits can retry; unchanged
text creates no replacement. Before closing a popup, finish pending work and
transfer unsaved commands before releasing drafts. Shared controls use closed
shadow roots to isolate styles. Capture errors appear on the active page or popup;
a missing page script prompts reload. Hiding marks does not delete saved notes.

### Highlights and snapshots

`highlight-lifecycle.js` is shared by live pages and snapshots; the build generates
the non-module content script. Text anchors store block selectors, literal UTF-16
offsets, and shadow-host sequences. Restoration reserves saved anchors before
visible-text fallback, preserving reading order, whitespace equivalence, and block
boundaries. Explicit `<br>` elements become newlines. Retries track restored parts
to avoid duplicate marks. Selector-only older anchors remain supported.

Snapshot preparation reconstructs empty placeholders from Save Page WE removal
comments to retain selector positions; removed content stays absent. Native PDF
selections use the PDF document's MIME type and browser-supplied selection text
with an empty DOM path. A PDF embed cannot bypass HTML selection validation or
strip surrounding HTML anchors. Overlapping existing highlights are rejected.

`savepage-bridge.js` owns one capture per tab. Save Page WE retains frames, supported
shadow roots, and computed root/body font sizes. Host-permission retries use temporary
exact-URL referrer rules, removed at completion. Downloads have timeouts and a
50 MiB limit. The capture budget accounts for escaping, repeated resources, frames,
and the final UTF-8 WebSocket message.

`snapshot-html.js` removes Browser Recall markup, writes one valid URL/slug metadata
pair, and deactivates uncaptured stylesheets. The viewer blocks saved scripts and
prepares embedded documents. Missing/invalid identity requires the explicit snapshot
migration; runtime reads do not repair stored files. See the
[Save Page WE maintenance notes](../apps/extension/savepage/UPSTREAM.md) for capture policy.

Chrome file snapshots require **Allow access to file URLs**. Desktop actions open
HTML; extension actions use the viewer, including for `blob:` URLs. Saved snapshots
retain the original page identity and never generate file-URL visits.

Extension Content Security Policy (CSP) requires packaged external scripts and
blocks inline scripts and remote imports.

## Search, rules, settings, and sync

Desktop search combines page title/URL, history batches, note matches, and snapshot
Markdown. New searches cancel obsolete history requests. Results remain interactive
while streaming; notifications update affected rows without restarting search.
Note search includes accepted edits awaiting checkpoints. Only desktop can request
full history; popup reads stay page-scoped.

Filters use device directories and page properties. Multi-day membership comes
from `visitDates`. Keyword rules match titles case-insensitively with exactly
`{ pattern }`. Function-rule previews may inspect supplied page data, but previews
are never stored in logs.

Product settings live in `views/manifest/settings.json`; Rust replay defines names,
types, allowed values, and defaults. Startup/reset create complete settings and
lists. Partial/invalid existing settings require migration. Failed UI writes reload
authoritative settings. Shared locale catalogs generate desktop choices and
extension translations; builds validate keys, placeholders, HTML, and fixed names.

Experimental GitHub sync runs in the daemon. Sync uploads current-device recent
logs and note JSON; snapshot HTML/Markdown stay local. Downloaded events rebuild
checkpoints. Extension code cannot access sync credentials or files.

## Build and validation boundaries

Local, release, and disk-image builds share staging, signing, verification, and
atomic output replacement. One product version spans manifests, Cargo/npm metadata,
lockfiles, and release tags. Release publishes Windows NSIS, macOS arm64/x64 disk
images/updater archives, both extension ZIPs, signatures, update metadata, and
checksums only after required checks pass.

Native packaging and update checks run separately from browser simulations.
macOS tray automation requires a disposable account; verified no-tray documentation
builds do not. [Testing](TESTING.md) defines platform coverage and failure diagnostics;
[Development](../DEVELOPMENT.md) provides commands and distribution setup.
