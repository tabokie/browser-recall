# Browser Recall — Agent Guide

Repository: **browser-recall**. Product: **Browser Recall**.

Read [Architecture](docs/ARCHITECTURE.md) for system contracts,
[Codebase Map](docs/CODEBASE_MAP.md) for implementation locations, and
[Development](DEVELOPMENT.md) for commands. For testing work, also read
[Testing](docs/TESTING.md) and [tests/AGENTS.md](tests/AGENTS.md).

## Ownership and data

- The daemon is the Rust service inside the desktop app. The daemon owns storage,
  replay, search, sync, settings, and recording rules. The extension captures pages,
  provides current-page actions, and briefly queues commands while disconnected.
- Logs are the source of truth. Replay rebuilds checkpoints in `views/`; notes and
  snapshots live in `objects/`. Use production replay code in verifiers.
- Write through `crates/daemon/src/runtime.rs`: reserve checkpoint capacity, append
  validated logs, update memory, then queue checkpoint writes in order. Coordinate
  shutdown, deletion, and reset with pending writes.
- Reads use current memory and storage-layer disk reads for uncached records.
  Missing or invalid Browser Recall data must produce explicit errors. Never
  substitute incomplete records or silently treat `{ success: false }` as success.
- Replay must be idempotent: applying an event twice has the same result as applying
  the event once. Test identifier changes by applying the same event twice.
- Migrate stored data before changing formats; remove obsolete readers and writers.
  Do not add extension-side migrations. Keep logs within Rust replay schemas and
  replace checkpoints through temporary files. Configuration upgrades may default
  absent fields; invalid supplied values remain errors.
- Product settings use daemon commands and `views/manifest/settings.json`.
  Extension storage holds connection details and temporary command state, never
  product records, preferences, or snapshot HTML.
- Send commands such as `reportVisit` and `createNote`, never raw events. Serialize
  editor saves, deletion, and closing; transfer unsaved commands before discarding
  drafts. Show connection and queue failures in connection status.
- Generate non-module content scripts from shared factories. Intercept the page's
  History API in the page's JavaScript environment, not the content-script environment.

## Changes and verification

- Bug fixes are test-first: reproduce the failure, fix the cause, and confirm the
  same scenario passes. Explain why previous coverage missed the bug.
- Prefer Playwright user scenarios connected to a real daemon. Use Rust integration
  tests for daemon contracts and native tests for operating-system behavior.
  Simulated Tauri responses verify UI calls only.
- Do not add unit tests by default. Narrow replay-idempotence or strict-parsing
  exceptions require a clear reason. Use coverage to find valuable missing scenarios.
- Reproduce platform failures on the affected operating system. Control fixture
  dates and asynchronous responses; do not hide failures with sleeps, retries,
  weaker assertions, or longer deadlines. Distinguish proven causes from hypotheses.
- Preserve primary failures through diagnostics and teardown. Attempt every cleanup,
  bound subprocess operations, and retain evidence before removing test resources.
- Inspect focused screenshots before changing layout CSS. Preserve reading position
  during refreshes and use consistent coordinates for virtual scrolling.
- Run relevant checks from [Development](DEVELOPMENT.md). Continuous integration
  (CI) is complete only when all required checks pass for the current commit.
  Local `npm run ci` does not replace the hosted platform matrix. Report gaps;
  avoid repeatedly canceling expensive native runs with speculative pushes.
- After renames or format changes, find every reader, writer, string, test, and
  document. Test readers with non-empty data. Update Architecture and Codebase Map
  when system responsibilities or interfaces change.

## Native macOS safety

Browser Recall tray automation requires a disposable macOS account or CI runner.
Never set `BROWSER_RECALL_ISOLATED_MACOS_SESSION=1` in a personal login session:
temporary data folders and bundle identifiers do not isolate Control Center's
menu bar ownership records. Use Finder for personal launches. Verified `no-tray`
documentation builds are exempt; see [Native checks](docs/TESTING.md#native-checks).

## Documentation quality

- Before committing Markdown, read every changed document in full, not just the
  diff. Vibe check the structure, accuracy, flow, and usefulness to a new reader.
  Formatting checks do not replace this editorial review.
- Use succinct language and short, focused paragraphs. Remove filler, repetition,
  stale instructions, and fix-by-fix history. Introduce each term by its exact name
  before shorthand. Keep README.md under the user's control; edit only on request.
- Keep AGENTS.md limited to important rules. Put procedures in the relevant reference
  document and implementation rationale beside the code. Merge new lessons into
  existing guidance instead of appending another overlapping checklist.
