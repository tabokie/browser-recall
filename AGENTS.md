# Browser Recall — Agent Guide

Repository: **browser-recall**. Product name: **Browser Recall**.

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how Browser Recall works,
[CODEBASE_MAP.md](docs/CODEBASE_MAP.md) for where features are implemented, and
[DEVELOPMENT.md](DEVELOPMENT.md) for commands.

## Responsibilities and validation

- The daemon is the Rust service inside the desktop app. The daemon handles storage,
  replay, search, sync, rules, title cleanup, blacklists, and automatic pinning.
  The extension captures pages, provides current-page actions, pairs with the
  desktop, and briefly queues commands while disconnected.
- Never silently substitute defaults or incomplete data. If a record is not cached,
  read the record from disk through the storage layer. Invalid Browser Recall data
  must produce an explicit error.
- Optional references may be omitted only for valid non-page URLs. Malformed
  HTTP(S) references remain validation errors.
- Product preferences live in `views/manifest/settings.json` and use daemon commands.
  Extension storage may hold connection details, pairing, and short-lived pending commands.
- Migrate stored data before changing the data format; then remove obsolete readers and
  writers. Do not add extension-side migrations or compatibility paths.
- Introduce each term by its exact name before using pronouns, shorthand, or
  substitute labels.

## Storage and replay

- Logs are the source of truth. Replay applies recorded log events to rebuild
  current data. Checkpoints are saved replay results in `views/` and can be rebuilt.
  Note and snapshot files live under `objects/`.
- Applying the same event twice must produce the same result as applying the event
  once. This requirement is called idempotence. Tests for changing identifiers must apply
  the same entry twice; rename handlers must recognize the destination through
  an unchanging record ID or replay timestamps.
- Save a page checkpoint only when the page belongs to a list, has a note or snapshot,
  has a user-edited title, or has a rating. Define that decision in the Rust replay
  crate and use the same function when saving and verifying checkpoints.
- JSONL must match the data format defined by Rust replay. Command-only previews, hints,
  legacy `items`, rule `fields`, and `case_sensitive` must not enter logs.
- `pin_to_list` and `unpin_from_list` records use `urls`. When present,
  `pin_to_list.titles` must have the same length and order as `urls`. Required log
  fields must be present even when the value is `null`.
- Write checkpoint JSON to a temporary file, then rename the file into place.
  Overwriting a file in place can expose empty or partial files to readers.
- Snapshot HTML belongs in files under `objects/snapshots/<shard>/`, never
  `chrome.storage.local`.
- Use the production Rust verifier with the selected data folder:
  `cargo run -q -p browser-recall-replay --bin replay-verify -- --data-dir "/absolute/path/to/chosen-data-folder" --write "/tmp/browser-recall-replay-check"`.
  The verifier deletes and recreates the output directory on every run. Use a
  disposable output directory, separate from the data folder.

## Daemon runtime

- Write through `crates/daemon/src/runtime.rs`: reserve space in the checkpoint
  writer's queue, append validated logs, update in-memory data, and queue checkpoint
  writes in order. Keep the logic for applying a batch and reading the results of
  earlier commands in that module.
- Return command validation failures as errors. Wrappers expecting a successful
  response must reject `{ success: false }`, not treat the response as success.
- Reads use current in-memory data and the storage layer's disk reads when a record
  is not cached. Tests of successful writes not yet saved to checkpoints must create
  that condition directly, without relying on scheduler timing.
- `views/manifest/replay-progress.json` tracks how far each device's logs have been
  saved to checkpoints. Startup must recover accepted events whose checkpoint
  writes were unfinished.
- Shutdown, deletion, and reset operations must wait for or coordinate checkpoint
  writes. Pending older writes must not recreate deleted data.
- Change notifications must retain every relevant detail, including whether a change
  is a visit or a metadata edit. Deduplication must compare notification contents as well
  as the record ID. Test batches that update the same record more than once.

## Connector

- Send commands such as `reportVisit`, `reportLeave`, and `createNote`, not raw log
  entries. The pending-command queue bridges brief daemon outages; the queue must
  not become a second permanent store.
- Save, delete, and closing an editor use one operation queue. When the popup closes,
  transfer unsaved commands before discarding in-memory drafts.
- Handle failures when connecting or sending queued commands and show the error in
  connection status. Validation errors must not leave the extension stuck in
  `starting` or `connecting`.
- Popup and badge refreshes read current daemon data. Do not cache product records
  or preferences in the extension.
- Content scripts use a separate JavaScript environment from the page. To intercept
  the page's History API, inject a script into the page's environment. Changing
  JavaScript properties from a content script does not change the page's properties.
- `blob:` URLs require an extension viewer. Extension CSP requires external local
  scripts and blocks inline scripts and remote imports.
- Generate non-module content scripts from shared JavaScript factories and check
  the build output. Never maintain duplicate production implementations.

## Rules, search, and anchors

- Keyword rules match titles only, case-insensitively, with exactly `{ pattern }`.
  Rule previews may inspect page data supplied with a command; saved rules and logs
  must contain only the supported fields.
- Search and result details use daemon APIs. Desktop test mocks must behave like
  the real APIs: serve history through history batch APIs, not generic record reads.
- Snapshot migrations must use the same URL normalization and slug generation as
  the running app, and reject any URL or slug the app would reject.
- Saved text anchors record a highlight's location. Anchors need exact text offsets
  and the sequence of host elements leading into shadow DOM. A document-only CSS
  selector cannot distinguish repeated text or reach content inside a shadow root.
- Concurrent note replacements from different devices remain valid and visible
  in Book after sync.

## Rendering and native UI

- Inspect focused Playwright screenshots before changing popup/menu/overlay CSS.
  Element dimensions alone cannot reveal every clipping, scrollbar, or paint problem.
- Preserve reading position during data refreshes. Avoid full `innerHTML`
  replacement from callbacks that modify DOM state; update rows or padding directly.
- Virtual scrolling renders only rows near the visible area. Calculate row positions
  and saved scroll anchors using the same viewport-relative `getBoundingClientRect()`
  differences. Preserve computed base padding; never mix raw `scrollTop` with
  positions measured from the container.
- Activate navigation state synchronously and wait only for named transitions.
  Regression coverage must retain real motion and unrelated finite/infinite animations.
- Keep macOS error controls below the titlebar drag region. Native click coordinates
  come from the Accessibility window frame; Quartz bounds are for screenshots.
- Inspect raster icons at target sizes, including 16 px toolbar and ICNS slots.
  Use CSS shapes for small controls instead of font glyphs.
- Match visual/container sizes, avoid unnecessary `flex: 1` chains, and keep static
  skeleton markup in HTML. `justify-content: flex-end` with overflow can hide content;
  set scroll position explicitly after rendering.
- Tauri plugins that generate permission schemas must remain unconditional Cargo
  dependencies, even if the plugins run on only some operating systems. Generated
  permission schemas must be identical across build hosts.

## Change workflow

- Bug fixes are test-first: reproduce with a failing test, confirm failure, fix,
  and confirm success. Explain why existing end-to-end (E2E) tests missed the bug.
- Prefer Playwright user scenarios with the extension connected to a real daemon.
  Combine features and use a fixed random seed when generating randomized inputs.
- Use Rust daemon integration tests when browser tests cannot directly verify daemon
  behavior. Exercise commands through the daemon or WebSocket API.
- Tests with simulated Tauri responses check UI command calls only. Use Rust tests
  and native app tests for operating-system behavior that browser tests cannot reach.
- Do not add unit tests by default. Use narrow architecture exceptions for replay
  idempotence or strict parsing; convert existing unit coverage to E2E when practical.
- Force the exact failing message path or disabled permission in end-to-end tests. Do not
  infer failure coverage from a final notification or permission-enabled setup.
- Use `npm run coverage` and `npm run coverage:monitor` to review meaningful gaps.
  Percentages are context; unit-test lines must not grow without an explicit exception.
- Generated manual test data starts with complete daemon settings, then applies
  setting events, then explicit overrides. Critical manual scripts need importable
  helpers and a noninteractive test using the real daemon and extension connection.
- Pin tools used by local CI in GitHub Actions and repository toolchains where possible.
  Document prerequisites. Keep local and hosted Rust toolchain versions identical.
- Run `npm run test:visual` for desktop visual behavior. If all tests fail before
  execution with launch errors, `SIGABRT`, or `kill EPERM`, request browser-launch
  permissions and rerun. Treat launch-only failure as sandbox failure.
- Browser-specific screenshot tests must run through `npm run test:visual` in CI.
- For site-specific highlight failures, inspect the live page, source DOM, and saved
  note and page IDs before blaming page-content replacement, CSS paths, or text matching.
- After renames, search old names, casing, strings, comments, tests, and docs.
  Data-format changes require finding every reader and testing each reader with
  non-empty data. Check multiline object construction separately.
- Verifiers must call production code rather than copy the rules into another
  language. Update both architecture and codebase map for significant changes.

## Commands

| Check | Command |
| --- | --- |
| JavaScript/JSON/Markdown formatting | `npm run fmt` / `npm run fmt:check` |
| Rust formatting | `cargo fmt` / `cargo fmt -- --check` |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Unused files, exports, and dependencies | `npm run lint:unused` |
| Duplicate extension blocks | `npm run lint:duplicates` |
| Desktop visuals | `npm run test:visual` |
| Complete local verification | `npm run ci` |
