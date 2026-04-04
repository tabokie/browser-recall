# TODO

- [ ] **Show downtime icon on stale content script tabs.** Content script's `chrome.runtime` context is permanently invalidated after extension reload or disable→re-enable. On `onInstalled`, set the extension icon to downtime for all existing tabs, prompting the user to refresh. No re-injection needed.
- [x] Rename interaction to history across the codebase.
- [x] **Fix TODO comments in shipped code.** `popup.js:338` — URL discrepancy between `tab.url` and content script URL. `options.js:1027` — Exact match should use word-boundary matching. Both indicate incomplete feature work.
- [x] **Unify offscreen message key schema + contract tests.** Standardize the naming conventions and response shapes for all background ↔ offscreen port messages. Define a single message contract (request/response types, error envelope) and enforce it at the port channel boundary. Then add contract tests that verify offscreen response shapes match background expectations, and vice versa. (Consolidates IPC schema and contract testing into one effort.)

## Test infrastructure

- [x] **Add "degraded cache" test variants.** All tests mock `chrome.storage.session` as a reliable in-memory store. In reality, session cache can be empty after SW restart, extension disable/re-enable, or LRU eviction. Code that reads cache without disk fallback silently returns undefined. Fix: use parameterized tests — for each integration test, add a variant where `chrome.storage.session.get()` returns `{}` for some keys, forcing fallback paths.
- [x] **Error-path test coverage.** No tests for: session quota exceeded, offscreen crash recovery, FS permission revocation mid-session, logBuffer overflow, concurrent `reportPage` from multiple tabs.
- [ ] **Performance benchmarks.** No benchmarks for: startup with large datasets (1000+ pages), WASM search with 10K+ entries, drain with 1000+ logBuffer entries, session cache memory under load.

## Sync

- [x] **Token security (P0).** Personal access token auth via `github-oauth.js`. Token stored in `chrome.storage.session` by default (session-only, cleared on browser restart). Optional "Remember on disk" persists to settings.json. Two-state auth UI (disconnected/connected). Auth errors (401) clear token and stop sync.
- [ ] **Conflict visibility UI.** No user notification when a remote LWW override silently wins (e.g., remote delete overrides local restore). Surface as transient notifications in the options page.

## Security

- [x] **Document smart rule sandbox security model.** Smart rules execute in a manifest-sandboxed page with `unsafe-eval`. Validation bans 16 globals via word-boundary regex but new globals could be missed (e.g., `Proxy`, `Reflect`). Low risk (users write their own rules) but the security model should be documented.

## Resilience

- [x] **Sync rate limit backoff.** GitHub API rate limit errors (403 + `X-RateLimit-Remaining: 0`) are classified as transient, so the sync alarm keeps firing every 5 minutes. Read `X-RateLimit-Reset` header and delay next sync until that time, or implement exponential backoff for transient errors.

## UX Polish

- [ ] **In-extension help / documentation.** No help page, FAQ, or feature guide. Keyboard shortcuts only shown as tiny text in popup footer. Workspace modes, rules, trim rules, and blacklist have no format guidance. Add a `?` icon that opens a help overlay, and inline help text for complex settings fields.
- [ ] **Snapshot capture progress feedback.** Capturing a page can take up to 60 seconds (Save Page WE timeout + per-resource fetches) with no visual indication. Show progress via extension icon (small circular progress badge) or as an overlay on the page. Surface timeouts clearly. *Requires icon design work.*
- [x] **Loading states.** Replace "Loading..." plain text with spinners or skeleton screens for WASM init, history batch loading, and sync operations.
- [ ] **Hidden interactions.** Several action buttons use `opacity: 0; pointer-events: none` revealed only on `:hover` — unreachable on touch/keyboard. Affected: card delete buttons (`.card-actions`, options.html:647), attention `···` button (`.att-ctrl-btn`, options.html:769), rule edit/remove buttons (`.rule-action-btn`, options.html:2589). Fix: always show these buttons (possibly dimmed), or use a long-press / context menu fallback for touch.
- [x] **Responsive design.** Options sidebar doesn't collapse on narrow windows. Add a media query to collapse the sidebar below a breakpoint.

## Bugs

- [x] **Time chart shows truncated range on first visit.** Fixed: `listHistoryFiles` returns file sizes when `includeSizes: true`; options.js computes estimated visit counts per date from file sizes, passes `estimatedByDay` Map to `renderTimeChart`; chart shows lighter dashed bars for estimated dates, refines as real data loads.

## Performance

- [x] **Index-based page lookup instead of linear JSONL scan.** Replaced `loadHistoryByUrl` (O(files × entries) JSONL scan) with `readCacheable('page:' + slug)` — O(1) session cache hit or single file read. Added `checkpoint` flag on `visit_page` entries so blacklist-bypass captures create page entities. Removed dead `loadAllHistory` and `loadHistoryByUrl` from filesystem-storage.js/offscreen.js/background.js.

## List Management

- [x] **Bulk actions: search results + pin operations.** Multi-select (ctrl/shift+click) and drag-to-list already work, but there is no "select all" button or toolbar for batch operations. Add a select-all toggle, a toolbar with "Copy to list" / "Move to list" / "Delete" actions, and extend to filtered pin views. Implement search results and pin bulk actions together (shared selection UI pattern).

## Search

- [x] **Search within snapshots/notes.** Four-phase progressive search: Phase 0 (in-memory title/URL), Phase 1 (WASM JSONL streaming), Phase 2a (WASM note search), Phase 2b (WASM snapshot search). Generation counter cancellation, match source badges, per-type concurrency limits.

## Feature Ideas

- [ ] **Discovery features in Explore.** Explore is purely search-based. Could add: "Recently highlighted" filter, "Most visited" aggregation, tag/topic clustering, reading streak/activity summary.
- [ ] **Notification/reminder system.** Set reminders to revisit pages, get notifications about stale pages, reading statistics.
- [ ] **Richer page annotations.** Notes are limited to text excerpts. Could add: full-page comments, markdown formatting in annotations, links between notes.
- [x] **Alternative sync methods.** Sync is GitHub-only. Could add: file-based sync via cloud drives, WebDAV, simpler pairing mechanism.
- [x] **Import from browser bookmarks.** File-based import: user exports bookmarks HTML from browser, picks file in settings modal, selects folders via tri-state checkbox tree picker, imports as nested lists with pinned pages under a timestamped parent list. No `chrome.bookmarks` permission needed.
- [x] **Event dot timeline in page details.** The page detail modal shows notes, snapshots, and list memberships but no chronological view of all events. Add a visual timeline (dot/line) showing visits, captures, highlights, and pin changes over time for a single page.
- [x] **Distinguish auto-pinned pages.** Rule-triggered and workspace auto-pins include `source: 'auto'` on the `pin_to_list` log entry. The pin object stores this field, and the UI displays an "auto" tag on auto-pinned pages in list views.
- [ ] **Browser history integration.** Extension tracks its own history but doesn't import/cross-reference Chrome's built-in history.

## Accessibility

- [x] **Accessibility pass (minimal).** Single pass: replace `<div>` click targets with `<button>`/`<a>`, add `role`/`aria-label` to custom widgets and icon-only buttons, add visible focus indicators. Keep it simple — no over-engineering.

## Exploration / research

- [x] **Snapshot viewer: treat blob: tab as original page (highlights + popup UI).** Fixed: `captureSnapshot` embeds `<meta name="x-portal-slug" content="{slug}">` in HTML; `getSlugForCurrentPage()` checks the meta tag first. Old snapshots degrade gracefully.
- [x] **Text extraction from Chrome PDF pages.** Spike result: **NOT VIABLE via Selection API.** Chrome's PDF viewer uses PDFium native plugin inside `<embed type="application/x-google-chrome-pdf">` — content is not DOM, so `window.getSelection().toString()` returns empty in all 3 frames. An internal `pluginController_.getSelectedText()` exists in the viewer extension's frame but is inaccessible to other extensions (same-origin policy). **Viable alternative**: `fetch()` the PDF URL + parse with pdf.js client-side.
- [ ] **Raw binary file snapshots.** For non-HTML URLs (PDF, images, etc.), skip Save Page WE and `fetch()` the URL directly from the background SW, storing the raw binary as `pages/{slug}/{timestamp}.{ext}`. Requires: update `captureSnapshot` to handle binary files, extend `listSnapshots` regex beyond `md|html`, extend `getSnapshotBlobUrl` to try the original extension (MIME type preserved by `createObjectURL`), skip meta tag injection for non-HTML. Currently these URLs throw `'Cannot capture PDF pages'`. For `file://` URLs, extension needs explicit file access permission and the value is lower (file already on disk).
