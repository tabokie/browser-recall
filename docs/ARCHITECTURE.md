# Browser Recall — Architecture

Browser Recall stores browsing history, highlights, lists, and snapshots in a
user-selected local folder. The desktop app manages stored data and product settings.
The browser extension captures pages and provides current-page actions.

## Components

The daemon is the Rust service that reads and writes Browser Recall data. The daemon
runs inside the desktop app and accepts commands from the desktop interface and
browser extension.

```text
desktop UI → Tauri commands/events → daemon → replay/search → data folder
browser extension → authenticated local WebSocket → daemon
```

| Component | Responsibility |
| --- | --- |
| `apps/desktop/ui/` | Timeline, Book, lists, search, imports, settings, and recycle bin |
| `apps/desktop/src-tauri/` | Native windows, setup, deep links, launch at login, and calls to the daemon |
| `crates/daemon/` | Commands, data reads and writes, recording policy, rules, pairing, and sync |
| `crates/replay/` | Apply logged events, define data formats, decide which page files to save, and verify stored data |
| `crates/search/` | Native history, note, and snapshot-text search |
| `apps/extension/` | Capture, popup actions, pairing, and a size-limited queue of pending commands |
| `packages/core/` | Shared URL handling, highlights, Markdown extraction, translations, and UI utilities |

The Tauri desktop app starts one daemon in the same process. Desktop commands call
the daemon directly; the browser extension connects through a local WebSocket.
Storage, search, rules, title cleanup, blacklist policy, and automatic pinning stay
in the daemon.

## Storage

Setup requires the user to choose a data folder. Browser Recall does not choose a
default folder. Standalone daemons and tests must also specify a folder or load an
existing configuration.

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

Each JSONL log contains one recorded event per line. Replay means applying those
events in order to rebuild current data. Checkpoints are JSON files in `views/`
that save the results of replay so the daemon can read data without rebuilding
everything.

The daemon saves a page checkpoint only when the page belongs to a list, has a note
or snapshot, has a user-edited title, or has a rating. Browsing alone does not require
a page checkpoint. The daemon and replay verifier use the same Rust function to
decide which page checkpoints should exist.

Note JSON files contain highlights and annotations. Snapshot HTML files reopen
saved pages; optional Markdown files provide searchable snapshot text.

A slug is the identifier used in a page or note filename. Page and snapshot files
are divided into subdirectories called shards. A shard name is the first two
hexadecimal characters of the SHA-256 hash of the slug or snapshot filename stem.
Record identifiers do not include the shard name.

The daemon writes a data-format guide to the data folder's `AGENTS.md`. Startup
updates the generated section and local device ID while preserving user-written
text. The guide is not synced; update errors produce a warning.

### URLs and data formats

`packages/core/page-identity.js` normalizes URLs and generates page slugs. The
extension removes query parameters beginning with `_` before reporting visits.
Other query parameters and fragments distinguish pages. Rust replay hashes the URL
received from the caller. Other tools that write events must normalize URLs the
same way as the extension to refer to the same pages.

Log and checkpoint validation rejects unknown fields and invalid values. Required
log fields must be present even when the value is `null`. Preview text and command
hints are not saved in logs. Migrate stored data before running code that requires
a changed data format.

`pin_to_list` and `unpin_from_list` use `urls`. The nullable `pin_to_list.titles`
array, when populated, must align with `urls`; the nullable `source` field is also
required in the log. A saved pin without a recorded source leaves the source absent
rather than assigning `manual`. List `slug`, `name`, and `owner` must be non-empty
strings.

Notes that have not been deleted require non-empty `excerpt` and `cssPath` arrays
of equal length. Each text excerpt has a matching location on the page. Deleted
note records may omit those locations. Pages retain every list, note, and snapshot
reference; references to pages that led to a visit have a size limit.

### Writes and crash recovery

`crates/daemon/src/runtime.rs` processes writes one at a time:

1. Read current data. For a batch, apply each command to the results of earlier commands.
2. Reserve space in the background checkpoint writer's queue.
3. Append validated events to the logs.
4. Apply the events to the daemon's in-memory data.
5. Queue checkpoint writes in the same order as the accepted commands.

Reads use the latest in-memory data. If a record is not cached, the daemon reads
the record from disk through the storage layer. Checkpoint writes use a temporary
file followed by a rename, so readers cannot see a partially written JSON file.
Shutdown, deletion, and reset operations wait for or coordinate pending writes so
older writes cannot recreate deleted data.

`replay-progress.json` records how far each device's logs have been saved to
checkpoints. Startup applies newer log entries before serving reads. This recovers
commands that succeeded before a crash but whose checkpoint writes were unfinished.
Applying the same event twice must produce the same result as applying the event
once; this requirement is called idempotence.

Sync validates downloaded records and checks whether replay succeeds before
installing the records. The daemon finishes earlier checkpoint writes, installs
the downloaded files, and updates in-memory data. Downloaded events are not
appended again as local events.

Browser Recall validates log filenames, records, timestamps, checkpoint keys, and
record slugs. Files outside the Browser Recall data layout are ignored. Missing
required directories or invalid Browser Recall data cause explicit read errors.

### External writers

Stop Browser Recall and standalone daemons before appending to the current device's
logs. Preserve existing records and use timestamps later than both the newest log
entry and the saved replay progress.

A separate device ID used by an external tool can publish complete dated log files
while Browser Recall runs. Keep existing entries unchanged and write to a temporary
file in the same directory, then rename the file into place. Appending directly to
a file that Browser Recall can read risks exposing an incomplete log entry.

Writing files externally does not immediately update the desktop's in-memory data.
Restart Browser Recall to apply the new log entries. History reads may find new
entries on disk before the rest of the interface reflects the entries. Browser
Recall has no filesystem watcher or general API for external file changes. GitHub
sync uploads the current device's recent logs; logs written under another device
ID are not uploaded automatically.

## Commands and data reads

`crates/daemon/src/command_authority.rs` defines commands for both Tauri and
authenticated WebSocket callers. Commands describe actions such as pinning a page
or creating a note. Each request is parsed once into a supported command type.
Invalid, missing, or unknown fields cause an error before any data changes.
The daemon reports success and notifies clients after appending the events and
updating in-memory data.

`crates/daemon/src/read_projections.rs` builds responses for list display, page
context, highlight history, page info, list trees, recycle-bin entries, popup lists,
and settings. These responses are called projections: each response combines the
records needed for one view. Referenced records are read through the storage layer.
A missing or invalid reference causes an error for the whole response.

Responses expose fields such as `kind`, `slug`, `listSlugs`, and `hasSnapshots`.
Internal relationship IDs stay inside the daemon. Popup
lists contain `slug`, `name`, `containsPage`, and `lastActivity`, without raw pins.
The popup summary combines access policy, display title, page data, notes,
snapshots, lists, and attention in one request.

Highlight history follows original `create_note` events through replacement chains.
Concurrent replacements remain separate live highlights. Creation time comes from
the note's original event, never the page's latest visit. A cursor lets the client
request the next batch from a fixed, size-limited highlight index. Each batch reads
current note and page data only for the requested highlights.

Folder selection, window control, language changes, opening external URLs, and sync
are available through Tauri only. Pairing, extension connection status, visit reports,
and checks of whether a page may be recorded are available through WebSocket only.
Reading arbitrary records, submitting raw log events, resets, and other test
operations require `test_control` and explicitly enabled test access. Production
extension builds omit test request handlers.

Configuration changes use `ConfigStore::update`. A shared file lock prevents
concurrent writers from overwriting each other's changes; temporary-file replacement
prevents partial JSON reads. Each caller changes only the fields the caller manages.
WebSocket handlers do not keep a separate editable copy of configuration.

## Desktop app

Local, release, and disk-image builds share desktop build orchestration: stage UI
assets, compile with Tauri, sign, and verify staged artifacts before replacing
previous output. Release packaging consumes the verified artifacts. Explicit
unsigned builds use ad-hoc signing on macOS without an Apple certificate. Explicit
signed builds resolve an installed Apple signing identity or Windows code-signing
certificate before compilation and verify staged output against the selected
certificate. Windows signing uses Authenticode for executables and installers.
Both explicit local modes exclude notarization and update-package credentials;
release packaging manages those credentials separately.

Desktop and browser extension releases use a manual GitHub Actions workflow.
Browser Recall uses one product version across desktop and extension manifests,
desktop and extension npm packages, desktop Cargo metadata, and GitHub Release tags. Release preparation
validates every product version against root `package.json` before building.
`scripts/lib/product-version.mjs` supplies the same validation to local release
builds and update manifest generation, including both lockfiles.
Native Windows and macOS runners and a Linux extension runner build the dispatch
commit. Windows ships a current-user Nullsoft Scriptable Install System (NSIS) installer;
macOS ships Apple Silicon and Intel disk images containing Browser Recall.app.
The release includes signed update packages and a Tauri update manifest hosted
on GitHub Releases. Publishing waits for package, signature, and native
installation checks, attaches SHA-256 checksums, and never replaces a release.
Chrome and Firefox ship as separate ZIP archives with a manifest at the archive
root. The workflow compares extracted archives with the production build output
and requires both extension archives before publishing the combined release.

`apps/desktop/src-tauri/src/updates.rs` owns update state and serializes checking,
downloading, and installation through the Tauri updater. Release builds check
GitHub's latest stable release on startup and every twelve hours. Users explicitly
choose Update and restart. The updater verifies the package signature before
stopping the daemon. The native command/sync gate excludes concurrent operations;
daemon shutdown closes connector sessions, waits for accepted commands, and saves
checkpoints. The update coordinator holds its operation lock through daemon
recovery or restart, and publishes retryable failures only after recovery finishes.
App updates do not depend on GitHub sync configuration. Update errors and
progress appear in Settings; available updates also have a sidebar action.
Application updates preserve configuration and collection storage.
Release CI runs an older native app through a signed update and relaunch on both
operating systems, retaining an authenticated connector, accepted note edits,
settings, and the selected collection. The connector must reconnect and write
successfully after relaunch.
`ServerStartOptions::with_environment_ports` applies the same strict port override
to desktop and standalone daemon startup; isolated native tests use a dedicated
port instead of the browser-discoverable default ports.

Closing the desktop window keeps the process and webview running. Tray actions,
Dock actions, and deep links reopen and focus the same window. Single-instance
handling registers before other plugins so launching the app again reaches the
existing process. If a saved window position is off-screen after a display change,
the app centers the window on an available display.

On macOS, Control Center tracks menu bar ownership per login user. Temporary app
identifiers and data folders do not isolate those records. Native lifecycle tests,
update tests, and desktop development launches require an explicit disposable-account
acknowledgement. The acknowledgement is a provisioning contract rather than an
account-isolation detector. Documentation builds use the Cargo feature `no-tray` to
omit the menu bar item. The shared documentation launcher verifies the compiled
mode before initializing native application services. Browser-based visual tests
do not create Browser Recall menu bar items.

On macOS, `NSWindow` is the AppKit window that owns the webview. Closing saves the
complete `NSWindow` frame; reopening restores that frame on the main thread if
the frame changed while hidden. The webview's inner size can differ from the
window's content size, so restoring from the webview size can shrink the window.

A daemon startup failure leaves the window open with a visible error. Resume can
start the daemon after storage is repaired. Simultaneous start requests share one
startup attempt; reading storage never starts a second daemon. Rust errors are
returned to callers, and locks remain usable after a thread panics.

Launch at login uses macOS `SMAppService`, Linux autostart, or a quoted Windows Run
registration. If saving the setting fails, the app undoes the operating-system
change. Startup checks the saved setting against the operating-system registration.
Check failures appear beside the setting without blocking the rest of the app.

### Rendering and refreshes

Timeline and Book navigation activate the destination and title immediately, then
wait for the navigation animations before rendering content. Unrelated or repeating
animations cannot delay navigation. Loading a language updates the title of the
active view.

The main pane and sidebar scroll independently. `refreshCurrentView()` dispatches
data refreshes and shows read failures. Data refreshes preserve reading
position: list updates reload data from the daemon and restore the visible
row; Timeline and category updates retain the existing layout; Book refreshes keep
the latest offset, including scrolling while more highlights load. Destination
changes start at the top. Fullscreen transitions
preserve both scroll containers through resize and paint.

Book requests successive batches of highlights without waiting for scrolling. Highlights
are grouped by local date and page in one reading view. Notes use a two-column
layout when present. Edits and deletes made in Book update the affected entries in
place. Matching daemon notifications confirm those changes without reloading Book;
changes made elsewhere refresh Book. Gentium Book Plus fonts and Justif provide
text layout and hyphenation. Copying preserves the original text.

## Browser connector

The build scripts generate separate Chromium and Firefox extensions.
`browser-api.js` exposes browser APIs usable from the calling script and locates
shadow roots. `browser-privileged-api.js` checks APIs available only to background
scripts. Orion uses the Chromium extension, but pairing records the browser as Orion.

Content scripts capture visits, time on page, and scroll depth. An injected script
runs in the page's JavaScript environment from document start to detect History API
and YouTube navigation. Browser history events detect navigation that bypasses the
injected script. Both paths report leaving and visiting pages, reset highlights,
and update the badge. Duplicate navigation reports do not repeat those actions.

The background script owns session recording policy through `recording-controller.js`.
Navigation starts, navigation commits, attention changes, pause changes, and admission
of automatic commands share one operation queue. A pause can prevent a report that
is still being prepared from entering the connector queue. Commands admitted before
the pause remain accepted; connector delivery and daemon responses do not hold the
recording operation queue open. Toolbar icons update without contacting content
scripts, and recording changes do not broadcast messages to tabs.

The background fixes each document's automatic recording eligibility at the main
frame's navigation start, before the page response arrives. Documents opened while
paused stay excluded after resume, including slow loads, same-document navigation,
and popup opens. Refreshing while recording is active creates an eligible document.
The document token binds activity to the sending tab and browser document ID. Page
identity and explicit page actions initialize in both states. A document injected
before navigation listeners registered can be adopted only before the session's
first pause; missing navigation history after a pause produces an explicit error.

Attention time uses a background clock that advances only while recording is active.
Content scripts report foreground starts and leaves, rather than elapsed wall time;
attention spanning pause and resume therefore excludes every paused interval.
Recording policy, pending navigation starts, document tokens, and attention starts
live in `storage.session`, survive background worker suspension, and are removed
when their tab closes. Content scripts never read that storage directly. The popup
reads complete daemon data after resume and does not synthesize visits.
Shared page-availability classification excludes browser and extension pages,
with explicit exceptions for snapshot viewers.

Navigation messages retry when a page script is temporarily unavailable. A newer
navigation cancels pending work for an older navigation. Failed delivery produces
an error for the affected tab. Leave reports keep the title of the page being left;
a delayed title from the next page cannot overwrite that title.

### Connection and pending commands

The extension's connection state has five phases: `offline`, `connecting`,
`waiting_for_approval`, `synchronizing`, and `ready`. Only `ready` includes a confirmed
daemon status (`running` or `paused`) and the operations allowed for the session.
After authentication, the extension validates status and sends pending commands in
order before entering `ready`. A paused daemon skips sending pending commands.

Each socket has a session ID. Callbacks from an old socket cannot change the current
connection or complete current requests. Connection and pending-command failures
appear in connection diagnostics. Invalid WebSocket messages close the session.

`command-buffer.js` keeps a short-lived, size-limited queue of pending commands.
The queue and byte count are saved together in extension storage; failed storage
writes undo the queue change. Commands leave the queue only after the daemon reports
success. An invalid command blocks the queue and produces an error. Snapshot HTML
is sent directly to a ready daemon connection, with the page URL and slug, and is
never saved in extension storage.

Snapshot preparation and direct commands share a drain-wait operation. Commands
arriving during or immediately after a successful drain are flushed before the
operation proceeds. A failed drain returns an error without retrying invalid data.

Protocol version 4 is the only supported extension connection format. Pairing and
authentication require matching versions, the detected browser name, and a
`browserProfile` field even when the value is `null`. Status supplies the device ID, daemon state, and the
maximum message size. Pending-command counts stay in extension storage. New fields
in the message wrapper are allowed; changes to required fields or meaning require
a new protocol version.

### Popup and notifications

The background script determines the original page URL for live pages, saved files,
and the snapshot viewer. Opening from the toolbar fetches the complete page summary
from the daemon before opening the popup. A single-use token lets the popup retrieve
that summary. If preparation exceeds 1.5 seconds, the popup shows an error. Direct
popup opens display the summary through the same code.

The popup shows either the complete page dashboard or an error. Changing the target
page cancels pending opens for the previous page. Daemon changes invalidate prepared
summaries. Browsers that cannot open a popup programmatically open the prepared
extension page in a tab.

The popup processes edits and list refreshes one at a time. Toggling membership in
an existing list sends one command; `createListAndPin` creates the list and pins
the page together. The list picker uses data fetched for the current popup and
keeps the same input element while typing, including input-method composition.
Pin and list notifications update the memberships shown in an open popup.

Capture failures show a notification on the active page when possible; otherwise,
the popup shows the error. If a page script is no longer available, the warning
asks the user to reload. Hiding highlight marks affects only the current page
display. Notes remain saved, and loading or navigating the page reapplies the marks.

### Highlights

`packages/core/highlight-lifecycle.js` saves selected text and the text's location,
adds and removes highlight marks, restores highlights, and repairs highlights when
the page replaces content. Live pages and snapshots use the same implementation.
The build generates a non-module content script from that shared code.

A text anchor records where a highlight belongs. The current anchor format stores
a block selector and exact UTF-16 text offsets. Anchors inside shadow DOM also
record the sequence of host elements needed to reach the text. Restoring a highlight
checks the excerpt at the saved offsets; the code never silently moves the highlight
to another matching passage.

Native PDF viewers do not expose the selected PDF text as a DOM range.
One `captureContextMenuSelection` request returns the selection source and
structured text locations together. A PDF document MIME type identifies native
PDF selections, which use the browser's context-menu text. An empty CSS path
records the absence of a DOM anchor; PDF highlights remain available in the
highlights panel. HTML selections require matching structured DOM text and retain
their anchors even when the HTML page contains a PDF embed.

Anchor offsets count literal text-node characters. Excerpts preserve explicit
`<br>` elements as newlines, including consecutive breaks; restoration checks the
range's literal text or its text with those explicit breaks.

Older anchors containing only a CSS selector remain explicitly supported.
Selections overlapping an existing Browser Recall highlight are rejected before
the note is saved.

`extension-surface.js` provides highlight entries, editors, and controls. Page
overlays use a closed shadow root to isolate styling. Save, delete, and closing the
editor use the same operation queue. Failed edits can be retried; unchanged text
does not create a replacement note. When the popup closes, pending operations
finish and unsaved commands move to the extension's pending-command queue before
in-memory drafts are released.

### Snapshots

`savepage-bridge.js` manages one snapshot capture per tab. Save Page WE saves frames
and supported shadow roots in the snapshot HTML. Capture preserves each document's
computed root and body font sizes so inherited text and relative sizes remain
unchanged by browser font defaults or the extension viewer's injected body style.
Failed page resource requests can retry using the extension's host permissions. Temporary rules for exact URLs allow
appropriate referrer headers during capture and are removed when capture ends.
Redirects can further restrict which referrer information is sent.

Resource downloads have a 50 MiB limit and timeouts. Capture estimates the final
message size against the daemon's WebSocket limit, accounting for JSON escaping,
embedded data, frames, and repeated resources. The extension measures the completed
UTF-8 message before sending the snapshot.

`snapshot-html.js` removes Browser Recall markup, writes exactly one pair of
`x-browser-recall-slug` and `x-browser-recall-url` metadata fields, and disables
unavailable external stylesheets. Opening a snapshot requires valid URL and slug
metadata. The snapshot viewer prepares embedded documents and blocks saved scripts.

`scripts/migrate-snapshot-identity.mjs` repairs older embedded metadata using the
shared page identity and snapshot HTML functions. The migration reads authoritative
page checkpoints, validates URL/slug agreement and snapshot paths, and replaces
affected files through temporary files. Runtime readers continue to reject invalid
snapshot identity rather than repairing stored data during reads.

Chrome file snapshots require **Allow access to file URLs**. If permission is
missing, the popup explains how to enable permission. `blob:` content uses the
extension viewer because Chrome cannot inject content scripts into `blob:` URLs.

## Search and rules

Desktop search starts when the user presses Enter. Results combine cached page
title and URL matches, history batches from Tauri, note matches, and snapshot
Markdown matches. A new search can cancel the history request. Search renders
result rows directly. Timeline without a search loads history as needed and renders
only rows near the visible area.

Initial results remain interactive as more results arrive. Visit and leave
notifications update page recency. Renames and ratings update page details without
creating visits. Notifications update affected search results without restarting
the history search. Note search includes accepted edits still waiting to be saved
to disk.

Filters use daemon device directories and page properties: highlights, snapshots,
likes, and visits on multiple days. Multi-day membership comes from page `visitDates`.
Only the desktop can request the full history; the popup requests data for the
current page.

`crates/daemon/src/rules.rs` owns validation, previews, and automatic matching.
Keyword rules are title-only, case-insensitive, and configured as `{ pattern }`.
Function rules may inspect page preview data supplied with a command; the preview
data is never saved in logs.

## Settings, localization, and sync

Product settings live in `views/manifest/settings.json`. The replay settings module
defines every setting's name, type, allowed values, and default. Startup and reset create complete settings
and default lists; partial or invalid existing settings require migration.
Themes support `light`, `dark`, and `system`; color schemes support `amber` and `mono`.
If a desktop settings write fails, the desktop reloads settings from the daemon.

The shared language list generates desktop language choices and extension translation
directories. Desktop language uses the system language or a saved override; the
extension uses the browser's translation APIs. Builds check translation keys,
placeholders, HTML, and text that must remain unchanged before packaging.

GitHub sync is experimental and runs in the daemon. Sync manages tokens, scheduled
runs, paused devices, and validation of downloaded data. Sync uploads recent logs
from the current device and note JSON files. Snapshot HTML and Markdown files stay
local. Downloaded events rebuild checkpoints. The extension cannot read or change
sync files or credentials.

## Verification

Playwright tests desktop and extension user scenarios. Desktop visual tests use
Chromium and selected WebKit cases with simulated Tauri responses. A native macOS
WKWebView test also checks chart layout. Rust integration tests check real daemon
commands and desktop integration.

Native tests separately check macOS tray and window behavior and Windows handling
of a second app instance. Browser-rendered UI tests do not provide complete coverage
of the native desktop interface.

Regular CI and Release use one reusable native release-validation workflow on
Windows x64 and macOS arm64. Release also builds and validates macOS x64 packages;
regular CI omits the Intel Mac runner. The workflow builds signed packages,
verifies installation, and exercises updates, relaunch, collection retention, and
connector reconnection. Regular CI uses temporary signing keys in disposable
runner checkouts; only Release uses production signing keys and publishes assets.
Linux tests, lint, and coverage share one job. Each JavaScript and Rust suite runs
once with coverage, and Rust coverage reports reuse the same execution.

Local and hosted verification share `ci:*` scripts. Documentation captures are
manual macOS workflows. Native window pixels are composited over a fixed light
Sonoma wallpaper; capture manifests fingerprint the wallpaper asset and crop.
The documentation app has a separate bundle identifier and declares no URL
schemes in either the retained build or the temporary capture copy. A native
check verifies that registering the retained bundle preserves the existing
Browser Recall URL handler and that opening the app URL reopens a hidden window
in the same isolated process. The process-reuse check targets the temporary app
explicitly, so the user's default URL handler is unchanged.
Desktop freshness also covers native shell source and Cargo dependencies; desktop
and browser workflows share native compilation and pixel-stability checks.
Chrome Web Store screenshots derive from verified browser captures. The exporter
records source-image, conversion-source, and output hashes in an export manifest.
The same documentation checker verifies the export manifest, dimensions, and
opaque RGB format. Export staging stays on the destination filesystem.
CI checks committed images. See [DEVELOPMENT.md](../DEVELOPMENT.md)
for commands, platform prerequisites, visual baselines, and capture instructions.
