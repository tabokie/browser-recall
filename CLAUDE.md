# Browser Recall — Agent Guide

Project name: **browser-recall** (display name "Browser Recall"). Version 1.0 targets Chrome Web Store public launch.

## Essential Reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — entity storage, caching, replay, sync, deletion
- [DESIGN.md](./DESIGN.md) — product philosophy and design rationale
- [CODEBASE_MAP.md](./CODEBASE_MAP.md) — file index, message routing, feature-to-code map
- [DEVELOPMENT.md](./DEVELOPMENT.md) — building, testing, debugging

## Core Principles

**No silent fallbacks or defaults.** Always get the "true" information regardless of cost. If a cache misses, fall through to disk — never silently degrade to a less-correct default. Silent fallbacks hide bugs and cause data corruption. Functions that search for missing data internally should accept raw values — don't require callers to coerce with `|| ''`.

**No backward-compatibility or migration code in the extension.** On schema changes, migrate the persistent data at `~/portal-data` to the new format first, then upgrade the extension code to only handle the new format. Existing in-extension migration/fallback code is legacy; do not extend it.

**Two-tier storage only.** `chrome.storage.session` for transient UI state (dark mode, sidebar width, search queries). Manifest entity storage for persistent user data (settings, lists, pages, notes, history). Never use `chrome.storage.local` for preferences or UI state.

**Every `effectOf` branch must be idempotent.** Applying the same log entry twice against a state that already reflects it must produce the same result. See ARCHITECTURE.md "Replay Idempotency Requirement" for the strategy table.

## Key Patterns

- `**processInteractionsForDisplay` must be paired with `enrichFromEntityStorage`.** Entity titles fill gaps left by the "omit unchanged fields" optimization. `enrichFromEntityStorage` also batch-loads note entities to set `hasHighlightNotes` for the badge.
- `**sendAction` helper** (utils.js): wraps `chrome.runtime.sendMessage`, throws on `{ success: false }`. Use for all data-reading message calls in options.js/popup.js. Content scripts (non-module) need inline `resp?.success === false` checks.
- **Session cache fallbacks**: UI pages must not assume session cache is populated — always fall back to background message handlers when session reads miss. Hydration races after disable/re-enable make this essential.
- **Purging references**: When deleting an entity, trace all reference paths (parentIds, childIds, list pins, JSONL history) and clean each one. Orphan references cause ghost entries in the UI.
- **Options page `initialize()`**: render cached UI (sidebar, settings) before heavy I/O. Load independent data sources via `Promise.all`.

## Cache & Storage Patterns

- **No in-memory cache guards on render paths.** Always fetch from entity storage on render; mutation handlers must invalidate all tiers.
- **GC_TOMBSTONE pattern**: Write `{ __gc: true }` instead of `cacheRemove` — prevents `readCacheable` from reloading deleted entities from disk. During hydration, tombstones fall through to disk (a later logBuffer entry may restore the entity). Post-hydration, tombstones block disk reads until drain completes.
- **UI pages read pending data via `readCacheable('history:<date>')`.** Not direct `chrome.storage.local`.
- `**readFs` is a hardcoded switch.** When adding cacheable entity types, add a case in `readFs` (background.js). Currently: `manifest:settings`, `manifest:name-to-id`, `manifest:orphaned`, `manifest:list-order`, `log:`*, `page:`*, `note:*`, `list:*`.

## Event-Sourced Replay

- Cross-entity effects belong in `effectOf` action branches. No separate scope/apply phases.
- Omit unchanged fields from log entries. Compare against cached entity — skip unchanged fields.
- Derived state belongs in `effectOf`, not as extra log entries. One log entry = one user action.
- Deletion = unlink + orphan, not physical file move. Files stay on disk for restore.
- When deleting via `delete_*`, clean up ALL relationship stores — not just the primary one.
- Every manifest entity must have an explicit drain case in offscreen.js AND a matching `ensureLoaded` case.
- Special-cased entity IDs must use the `list:system/` prefix convention.
- **Hydration deadlock**: Never call `addLog` inside `hydrateCache`. The chain `addLog` -> `readCacheable` -> `await hydrationDone` creates circular wait.

## Error Handling

All fatal conditions (session quota, local quota, offscreen crash, FS permission loss) use one shared infrastructure: `pauseService(code, message)` sets error state, swaps to downtime icon, writes to session storage. When adding new fatal error conditions, add a new error code and plug into `pauseService`. Add a matching case in the settings page error banner.

## Gotchas

- `chrome.runtime.sendMessage` from popup/options goes to BOTH background and offscreen; background must return `false` for unhandled actions.
- `chrome.storage.local` has a 10MB quota — never route multi-megabyte blobs through `appendLog`/`chrome.storage.local`. Use port channel for large payloads.
- Offscreen documents only have `chrome.runtime` — `chrome.storage`, `chrome.tabs` NOT available. Use port messages from background.
- Content scripts and `chrome.scripting.executeScript` do NOT work on `blob:` URLs. Use a viewer extension page instead.
- Extension page CSP blocks inline scripts. Always use external `.js` files.
- Extension CSP (`script-src 'self'`) blocks all remote `import()` — `fetch()` and `WebAssembly.compile()` are NOT blocked. Vendor JS modules locally.
- Background CSP blocks `new Function()`. Only the manifest sandbox page has `unsafe-eval`. Use `requestOffscreen({ action: 'executeSandboxFn' })` for JS compilation.
- `contextMenus.onClicked` reports wrong URL/tabId for PDF tabs. Use `chrome.tabs.query({active:true, lastFocusedWindow:true})` for real URL.
- `DOMException(message, name)` — first arg is message, second is error name.

## Refactoring Lessons

- After bulk renames, always grep for the old term — catches stragglers in comments, string literals, and alternate casings.
- When using `replace_all` on CSS classes vs JS IDs, do separate passes — `.topic-layout` (kebab) and `topicLayout` (camelCase) are distinct.
- `**replace_all` TDZ trap**: Never `replace_all` on patterns like `x = null;` that also match `let x = null;` declarations — causes Temporal Dead Zone error.
- Multi-line object pitfall in bulk transforms: fields split across lines evade single-line pattern matching. Verify multi-line constructs separately after transforms.
- Format changes require non-empty test data for every consumer. When changing a data structure's shape, grep for all readers and verify each has test coverage with non-empty data.
- After removing a write path, clean up its dead entries in event logs.
- When stripping events from history, inject replacement events so full replay matches checkpoints.

## CSS Lessons

- Use CSS pseudo-element shapes instead of text characters for small icons — text glyphs render at inconsistent widths across fonts/colors.
- Match container size to visual element size for seamless edges.
- **Flex stretch gap**: A `flex: 1` chain stretches containers to fill viewport even when content is short. Remove unnecessary `flex: 1` to let containers be content-sized.
- **Skeleton rendering**: Put static HTML in markup rather than relying on JS. Module scripts (`type="module"`) are deferred.
- **Flex-end + overflow trap**: `justify-content: flex-end` + `overflow-x: auto` makes content unreachable — items pushed past scroll origin can't be scrolled to. Use JS `scrollLeft = scrollWidth` after render instead.

## Virtual Scroller

- `innerHTML` replacement destroys all DOM state. Never force re-render from callbacks that modify DOM state — just adjust padding.
- **Offset calculation**: Use `getBoundingClientRect()` difference, not `offsetTop` (relative to positioned ancestor, not scroll container).
- **Preserve CSS base padding**: Read base padding via `getComputedStyle` at construction and add it to computed values.

## Entity Loader Gotchas

- `loadAllListMetadata` drops unlisted fields — update `parseListEntry` in filesystem-storage.js when adding list fields, or the field silently disappears from session cache after hydration.

## Workflow Preferences

- **Bug fixes: test-first — NO EXCEPTIONS.** (1) write failing test, (2) confirm it fails, (3) apply fix, (4) confirm it passes. Skip only for purely structural issues that can't be isolated without a real browser.
- **Use case coverage over implementation coverage.** Write E2E tests for each user-facing use case, not unit tests on implementation.
- **E2E tests over unit tests.** Only use unit tests when a feature cannot be tested in E2E.
- When any functionality is added, removed, or significantly changed, update both `CODEBASE_MAP.md` and `ARCHITECTURE.md` to reflect the latest code.

## Formatting & Lint Tools

- **prettier** — JS/JSON formatting: `npm run fmt` (write), `npm run fmt:check` (CI)
- **rustfmt** — Rust formatting: `cargo fmt`, `cargo fmt -- --check` (CI)
- **clippy** — Rust lints: `cargo clippy --target wasm32-unknown-unknown -- -D warnings`
- **knip** — unused files/exports/deps: `npx knip --include files,exports,duplicates`
- **jscpd** — duplicated code blocks: `npx jscpd extension/ --min-lines 5 --min-tokens 50`