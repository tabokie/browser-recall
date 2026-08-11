# Browser Recall — Agent Guide

Project name: **browser-recall** (display name "Browser Recall"). Version 1.0 targets Chrome Web Store public launch.

## Essential Reading

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — desktop-first topology, storage, replay, sync, deletion
- [CODEBASE_MAP.md](./docs/CODEBASE_MAP.md) — file index, message routing, feature-to-code map
- [DEVELOPMENT.md](./DEVELOPMENT.md) — building, testing, debugging

## Core Principles

**No silent fallbacks or defaults.** Always get the true information regardless of cost. If a daemon cache misses, fall through to disk through the coordinated storage path. Silent fallbacks hide bugs and cause data corruption.

Optional references may be omitted only when they are valid non-page URLs; malformed HTTP(S) references must remain explicit validation failures.

**Desktop is the authority.** Persistent storage, replay, search, sync, rule policy, title cleanup, blacklist policy, and auto-pin synthesis belong to the daemon/desktop side. The extension is a connector for capture, current-page popup actions, pairing, and short-lived command buffering.

**No extension-side migration or persistent preference storage.** On schema changes, migrate the persistent data at `~/browser-data` first, then upgrade code to handle only the new format. Extension persistence is limited to connector/pairing/short-lived queue state; product settings live in `views/manifest/settings.json` through daemon commands.

**Every replay branch must be idempotent.** Applying the same log entry twice against a state that already reflects it must produce the same result.

## Storage And Replay

- Data layout is `logs/`, `objects/`, and `views/`; see [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for exact paths.
- Logs are authoritative. Checkpoints in `views/` are replay-derived and rebuildable.
- Async checkpoint JSON writes must use atomic temp-file replacement; in-place rewrites can expose empty or partial files to concurrent projection reads.
- Replay tests for mutable identifiers must reapply the same entry after its first application; rename handlers must recognize the already-applied destination through immutable identity or replay timestamps.
- Page checkpoints are selective: persist only pages with durable user state, meaning list parent, note/snapshot child, user title, or rating.
- Replay-derived checkpoint policy must live in the Rust replay crate; daemon persistence and verification should call the same function instead of duplicating policy in JS or daemon code.
- Log records use the strict Rust replay schema. Command-only fields such as rule body previews, checkpoint hints, legacy `items`, rule `fields`, and `case_sensitive` must not reach JSONL.
- `pin_to_list` and `unpin_from_list` use `urls`; `pin_to_list.titles`, when present, is an index-aligned array with the same length as `urls`.
- Snapshot payload blobs are stored as sidecar files under `objects/snapshots/<shard>/`; large snapshot HTML must not pass through `chrome.storage.local`.
- Replay verification is Rust-owned: `cargo run -q -p browser-recall-replay --bin replay-verify --`.

## Daemon Runtime

- Writes are serialized in the daemon command/runtime layer: reserve checkpoint-worker capacity, append canonical logs, apply replay effects to the in-memory projection, then enqueue ordered checkpoint persistence.
- Mutation commands must return validation failures as errors; success-only authority wrappers must never reinterpret `{ success: false }` responses.
- Reads use the latest daemon projection cache and fall through to disk on coordinated cache misses.
- `views/manifest/replay-progress.json` records per-device durable replay progress so startup can replay acknowledged log entries that reached JSONL before async checkpoints flushed.
- On shutdown or destructive storage operations, flush or coordinate checkpoint work so stale async checkpoint writes cannot resurrect deleted data.
- Shared replay overlay logic belongs in `crates/daemon/src/runtime.rs`; avoid duplicating “apply a batch then read from the evolving projection” logic.

## Connector Extension

- The extension sends semantic daemon commands (`reportVisit`, `reportLeave`, `createNote`, etc.), not raw replay log records.
- The connector command buffer is a short-lived availability bridge, not a second durable write model. Keep it out of replay schema decisions.
- Fire-and-forget connector work must observe failures and publish an explicit diagnostic state transition; validation errors must never strand the connector in `starting` or `connecting`.
- Popup and badge reads should ask the daemon for current data when opened/refreshed; do not maintain product entity caches in the extension.
- Content scripts run in an isolated world. Page-world History API overrides require an injected page-world bridge; DOM events cross worlds but JS property overrides do not.
- Content scripts and `chrome.scripting.executeScript` do not work on `blob:` URLs. Use an extension viewer page instead.
- Extension page CSP blocks inline scripts and remote imports. Always use external local JS files.

## Rules And Search

- Keyword rules are title-only and always case-insensitive. Their config is exactly `{ pattern }`; they do not carry field selectors and never match URL or body preview text.
- Rule previews may inspect command-only page data, but persisted rules and logs must remain canonical.
- Search queries and result enrichment should read through daemon/desktop APIs, not direct extension-local persistence.
- Desktop UI test mocks should mirror real daemon API boundaries; do not let `readDesktopValue` expose history log entities that production only serves through history batch APIs.

## Refactoring Lessons

- Incremental mutation payloads must be lossless for every action they replace: distinguish observations from metadata, include semantic payloads in deduplication identity, and test batched same-entity updates.
- After bulk renames, grep for the old term, alternate casing, comments, string literals, tests, and docs.
- Format changes require non-empty test data for every consumer. When changing a structure's shape, grep for all readers and verify each has coverage with non-empty data.
- Multi-line objects evade single-line transforms; verify multi-line schema and payload construction separately.
- Avoid compatibility paths after an intentional schema migration. Migrate the data, then remove fallback readers/writers so drift is visible.
- When a verifier validates production behavior, keep the verifier on the production implementation rather than porting policy into another language.
- Generate classic-script bridges from the shared module factory and verify their staged output; never maintain mirrored production implementations.
- Keep schema-producing Tauri plugins as unconditional Cargo dependencies, even when runtime initialization is platform-gated, so generated ACL schemas remain identical across build hosts.
- Persisted DOM anchors must encode composed-tree host traversal and exact text offsets; document-only CSS selectors cannot distinguish repeated text or address content inside shadow roots.

## CSS Lessons

- In macOS full-size-content windows, keep interactive error banners below the
  titlebar drag region and derive native smoke-test click coordinates from the
  same titlebar spacing.
- Native macOS UI automation must derive physical click coordinates from the Accessibility window frame used for positioning; Quartz capture bounds are only for screenshots and may use a different coordinate space.
- Inspect generated raster assets at actual target sizes before judging SVG icon changes; 16px toolbar icons and macOS `.icns` slots can diverge from source previews.
- For popup, menu, and overlay CSS bugs, capture a focused Playwright screenshot of the rendered state and inspect the pixels before adding more CSS. Geometry and computed-style assertions can pass while browser scrollports, native scrollbar gutters, clipping, or paint order still leave visible artifacts; screenshots validate the actual raster.
- Use CSS pseudo-element shapes instead of text characters for small icons; text glyphs render inconsistently across fonts/colors.
- For animation-gated navigation, activate shell state synchronously and wait only for named UI transitions; regression tests must preserve real motion and include unrelated finite and infinite animations.
- Match container size to visual element size for seamless edges.
- Avoid unnecessary `flex: 1` chains when content should be content-sized.
- Put static skeleton HTML in markup rather than relying on JS. Module scripts are deferred.
- `justify-content: flex-end` plus horizontal overflow can make content unreachable; use explicit scroll positioning after render.

## Virtual Scroller

- `innerHTML` replacement destroys DOM state. Do not force full re-render from callbacks that modify DOM state; adjust padding or targeted rows.
- Use `getBoundingClientRect()` differences for offsets, not `offsetTop` relative to a positioned ancestor.
- Preserve CSS base padding by reading computed styles and adding virtual padding to it.
- Scroll anchors must use the same viewport-relative container offset as render range calculation; never mix raw `scrollTop` with container-relative row offsets.

## Workflow Preferences

- Bug fixes are test-first: write the failing test, confirm it fails, apply the fix, confirm it passes.
- Tests for reads acknowledged before asynchronous checkpoint persistence must deterministically construct the cache-only state; repeated scheduler-dependent runs do not prove the race is covered.
- Manual seed generation must use the daemon's complete current settings as replay base state; seeded setting events apply next, and explicit seed-case overrides apply last.
- Operational scripts that normally run manually should route critical logic through importable helpers and have a noninteractive CI smoke path at the real daemon/connector boundary.
- Any tool invoked by canonical local CI must be pinned in hosted CI, declared in the repository toolchain when possible, and documented as a local prerequisite.
- E2E is the primary product safety net. For desktop app and extension app behavior, reproduce bugs and cover new functionality in Playwright first, using the real daemon/connector path whenever feasible.
- When CI cannot inject native webview input, split coverage across Playwright for UI command wiring, Rust for the real host/daemon boundary, and native smoke tests for window/tray lifecycle; never treat a mocked bridge as host-boundary coverage.
- For site-specific highlight bugs, verify the live/source DOM and saved note/page identity data before attributing the failure to CSS path drift, hydration, or text matching.
- E2E tests for notification fallbacks should force the exact delivery channel to fail, not only assert the final visible notification.
- Desktop visual E2E uses `npm run test:visual`; in sandboxed agent runs, request browser-launch permissions for that command if Chromium aborts before test code runs. A launch-only failure where every visual test fails at `0ms` with `browserType.launch`, `SIGABRT`, or `kill EPERM` is a sandbox execution issue, not a product regression.
- Browser-specific visual snapshots must be exercised by the canonical visual CI path, including installation and invocation of that browser.
- Rust daemon integration tests are acceptable for daemon authority behavior that is impractical or too indirect to assert through browser E2E; keep those tests at the daemon/WebSocket boundary rather than adding inline unit tests.
- New E2E coverage should exercise user scenarios, feature combinations, and slightly randomized-but-reproducible input data, not only one fixed happy path. Randomized cases must log or derive from a stable seed so failures can be replayed.
- Do not add new unit tests by default. Convert existing unit coverage to E2E when practical, and use unit tests only when behavior cannot be exercised through E2E or when guarding a narrow architecture invariant such as replay idempotence or strict protocol parsing.
- When a bug escapes tests, first ask why current E2E coverage missed it, then add or strengthen the E2E scenario before fixing the product code.
- Use `npm run coverage` / `npm run coverage:monitor` to find uncovered production lines worth reviewing across JS and Rust; coverage percentages are context, not a target. Prefer closing meaningful gaps with E2E coverage. Unit-test LoC must not grow without an explicit architecture exception.
- When functionality is added, removed, or significantly changed, update both [CODEBASE_MAP.md](./docs/CODEBASE_MAP.md) and [ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Formatting And Lint Tools

- Pin the Rust toolchain locally and in GitHub CI to the same explicit version;
  guard the pin with a workflow test so Clippy changes cannot appear only in CI.
- JS/JSON formatting: `npm run fmt` or `npm run fmt:check`
- Rust formatting: `cargo fmt` or `cargo fmt -- --check`
- Rust lint: `cargo clippy --workspace --all-targets -- -D warnings`
- Unused files/exports/deps: `npx knip --include files,exports,duplicates`
- Duplicate JS blocks: `npx jscpd apps/extension/ --min-lines 5 --min-tokens 50`
