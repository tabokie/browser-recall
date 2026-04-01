# TODO

- [ ] **Re-inject content scripts on extension reload/re-enable.** Content script's `chrome.runtime` context is permanently invalidated after extension reload or disable→re-enable. Fix: call `chrome.scripting.executeScript` from `onInstalled` in background.js to re-inject into all existing tabs. Requires idempotency guard and stale Shadow DOM cleanup in content.js.
- [ ] Rename interaction to history across the codebase.
- [ ] **Fix TODO comments in shipped code.** `popup.js:338` — URL discrepancy between `tab.url` and content script URL. `options.js:1027` — Exact match should use word-boundary matching. Both indicate incomplete feature work.

## Test infrastructure

- [ ] **Extract testable modules from background.js.** `background.js` is a 1632-line monolith that can't be imported in Node (requires Chrome APIs). Tests for `processPageReport`, `addLog`, `resolvePageId`, etc. reimplement the logic inline — when the real code diverges, tests pass while the extension is broken. Bug 21: reimplemented `processPageReport` passed but real code deleted `isInitialLoad` before reaching the function. Bug 19b: reimplemented `addLog` had correct disk fallback but real code had `const arr = today || []`. Bug 8: offscreen returned `{ urls }` but background expected `{ keys }` — no test exercised the real IPC. Bug 17: `loadLists` changed data shape (dropped `qbTrees`), breaking `showList()`. Fix: move these functions into importable modules (like `replay.js` already is) so tests import the real code.
- [ ] **Add "degraded cache" test variants.** All tests mock `chrome.storage.session` as a reliable in-memory store. In reality, session cache can be empty after SW restart, extension disable/re-enable, or LRU eviction. Code that reads cache without disk fallback silently returns undefined. Bug 4: empty collections after disable/re-enable (neither `onInstalled` nor `onStartup` fires). Bug 13: pin resolution returned undefined because options.js assumed session was populated. Bug 18b: `getPageRelations` read stale `listCache:*` session keys instead of entity storage. Bug 18c: `readFs` had no case for user list keys, returning undefined on cache miss. Fix: for each integration test, add a variant where `chrome.storage.session.get()` returns `{}` for some keys, forcing fallback paths.
- [ ] **Add contract tests for IPC boundaries.** Background ↔ offscreen uses a port channel with JSON messages. No test verifies the response shape from one side matches what the other expects — a rename on one side silently breaks the other. Bug 8: offscreen `loadPermanentDeletes` returned `{ urls }`, background expected `{ keys }`. Bug 17: `loadLists` migration changed data shape (`listOrder` lacks `qbTrees`), breaking consumers. Fix: test that offscreen response shapes match background expectations, and background response shapes match options/popup expectations.
- [ ] **Error-path test coverage.** No tests for: session quota exceeded, offscreen crash recovery, FS permission revocation mid-session, logBuffer overflow, concurrent `reportPage` from multiple tabs.
- [ ] **Performance benchmarks.** No benchmarks for: startup with large datasets (1000+ pages), WASM search with 10K+ entries, drain with 1000+ logBuffer entries, session cache memory under load.

## Sync

- [ ] **Token security.** GitHub personal access token is stored in plain `manifest/settings.json`. Acceptable for v1. Future: use OS keychain via native messaging, or encrypt at rest in `chrome.storage.local`.
- [ ] **Conflict visibility UI.** No user notification when a remote LWW override silently wins (e.g., remote delete overrides local restore). Surface as transient notifications in the options page.

## Security

- [ ] **Document smart rule sandbox security model.** Smart rules execute in a manifest-sandboxed page with `unsafe-eval`. Validation bans 16 globals via word-boundary regex but new globals could be missed (e.g., `Proxy`, `Reflect`). Low risk (users write their own rules) but the security model should be documented.

## Resilience

- [ ] **Sync rate limit backoff.** GitHub API rate limit errors (403 + `X-RateLimit-Remaining: 0`) are classified as transient, so the sync alarm keeps firing every 5 minutes. Read `X-RateLimit-Reset` header and delay next sync until that time, or implement exponential backoff for transient errors.

## UX Polish

- [ ] **In-extension help / documentation.** No help page, FAQ, or feature guide. Keyboard shortcuts only shown as tiny text in popup footer. Workspace modes, rules, trim rules, and blacklist have no format guidance. Add a `?` icon that opens a help overlay, and inline help text for complex settings fields.
- [ ] **Undo toast on delete.** Show "Deleted. [Undo]" toast at point of deletion instead of relying solely on recycle bin discoverability.
- [ ] **Loading states.** Replace "Loading..." plain text with spinners or skeleton screens for WASM init, history batch loading, and sync operations.
- [ ] **Hidden interactions.** Delete/action buttons only visible on hover (invisible on touch). No tooltips on icon-only buttons. Rules section collapsible with no visual hint.
- [ ] **Responsive design.** No CSS media queries. Popup hardcoded to 400px. Options sidebar doesn't collapse on narrow windows.

## Search

- [ ] **Search within snapshots/notes.** WASM search only covers JSONL history entries (titles, URLs, body previews). No full-text search over snapshot HTML/markdown content or note text/annotations.

## Feature Ideas

- [ ] **Discovery features in Explore.** Explore is purely search-based. Could add: "Recently highlighted" filter, "Most visited" aggregation, tag/topic clustering, reading streak/activity summary.
- [ ] **Notification/reminder system.** Set reminders to revisit pages, get notifications about stale pages, reading statistics.
- [ ] **Richer page annotations.** Notes are limited to text excerpts. Could add: full-page comments, markdown formatting in annotations, links between notes.
- [ ] **Alternative sync methods.** Sync is GitHub-only. Could add: file-based sync via cloud drives, WebDAV, simpler pairing mechanism.
- [ ] **Browser history integration.** Extension tracks its own history but doesn't import/cross-reference Chrome's built-in history.

## Accessibility

- [ ] **Semantic HTML + ARIA baseline.** Replace `<div>` click targets with `<button>`/`<a>`, add `role` attributes to custom widgets (virtual scroller, sidebar tree), add `aria-label` to icon-only buttons. Ensure tab order and keyboard navigation work throughout options page, popup, and content script UI.
- [ ] **Keyboard navigation.** Visible focus indicators, `tabindex` management for custom widgets (sidebar tree, virtual scroller, modals), focus trapping in dialogs, skip-to-content links.

## Exploration / research

- [x] **Snapshot viewer: treat blob: tab as original page (highlights + popup UI).** Fixed: `captureSnapshot` embeds `<meta name="x-portal-slug" content="{slug}">` in HTML; `getSlugForCurrentPage()` checks the meta tag first. Old snapshots degrade gracefully.
- [x] **Text extraction from Chrome PDF pages.** Spike result: **NOT VIABLE via Selection API.** Chrome's PDF viewer uses PDFium native plugin inside `<embed type="application/x-google-chrome-pdf">` — content is not DOM, so `window.getSelection().toString()` returns empty in all 3 frames. An internal `pluginController_.getSelectedText()` exists in the viewer extension's frame but is inaccessible to other extensions (same-origin policy). **Viable alternative**: `fetch()` the PDF URL + parse with pdf.js client-side.
- [ ] **Raw binary file snapshots.** For non-HTML URLs (PDF, images, etc.), skip Save Page WE and `fetch()` the URL directly from the background SW, storing the raw binary as `pages/{slug}/{timestamp}.{ext}`. Requires: update `captureSnapshot` to handle binary files, extend `listSnapshots` regex beyond `md|html`, extend `getSnapshotBlobUrl` to try the original extension (MIME type preserved by `createObjectURL`), skip meta tag injection for non-HTML. Currently these URLs throw `'Cannot capture PDF pages'`. For `file://` URLs, extension needs explicit file access permission and the value is lower (file already on disk).
