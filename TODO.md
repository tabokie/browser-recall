# TODO

- [ ] **Re-inject content scripts on extension reload/re-enable.** Content script's `chrome.runtime` context is permanently invalidated after extension reload or disable→re-enable. Fix: call `chrome.scripting.executeScript` from `onInstalled` in background.js to re-inject into all existing tabs. Requires idempotency guard and stale Shadow DOM cleanup in content.js.
- [ ] **Enrich `page_checkpoint` context at runtime.** When `page_checkpoint` is appended, it often has empty title because the checkpoint fires before the page's real title is known. `page` entries that arrive later carry the title, but if the page entity was already created by `page_checkpoint` with empty title, the later `page` entries do update it — however if `page` entries arrive *before* `page_checkpoint` (e.g., navigation events before snapshot capture), they are dropped (entity is null). Investigate: (a) defer `page_checkpoint` until first `page` entry provides title/referrer context, or (b) carry forward pending `page` entry data into the subsequent `page_checkpoint`, or (c) allow `page` entries to create entities (would change replay semantics).

## Exploration / research

- [ ] **Snapshot viewer: treat blob: tab as original page (highlights + popup UI).** Snapshots open as `blob:` URLs. content.js injects successfully (blob: matches `<all_urls>`) but `getSlugForCurrentPage()` (`content.js:170`) fails to parse the blob: scheme, returns `'untitled'`, and `reapplyHighlights()` (`content.js:554`) bails immediately — no highlights are restored. No mechanism exists to tell content.js which page it is. Fix in two parts: (1) **Pass identity**: at snapshot-capture time, embed `<meta name="x-portal-slug" content="{slug}">` in the saved HTML so the slug travels with the file. (2) **Read identity**: in `getSlugForCurrentPage()`, before URL parsing, check `document.querySelector('meta[name="x-portal-slug"]')` and return its content if found. With the slug resolved correctly, `reapplyHighlights()`, new highlight creation, and popup UI all work without further changes. Old snapshots without the meta tag continue to degrade gracefully (`'untitled'` → silent no-op). Affects `filesystem-storage.js` (snapshot write path) and `content.js:170-190`.
- [ ] **Text extraction from Chrome PDF pages (no visual highlight).** PDFs opened in Chrome render via a plugin embed — `wrapRangeWithMark` and Shadow DOM overlays will both fail, so visual highlighting is not viable. However, content scripts DO inject on PDF URLs (e.g. `https://example.com/doc.pdf`) since they match `<all_urls>`. The open question is whether `window.getSelection().toString()` exposes the selected text from within the PDF plugin — Ctrl+C works at the OS level but that doesn't guarantee the selection is visible to JS. **Spike needed**: manually inject a one-liner into a PDF tab via the DevTools console and call `window.getSelection().toString()` after selecting text; if it returns the text, the feature is viable. If it works: add a PDF guard in `highlightSelection` handler (`content.js:894`) that skips `wrapRangeWithMark` and goes straight to `createNote` with only the `excerpt` field populated. No UI changes to the note overlay are needed — it already supports excerpt-only notes.

## Storage / quota

- [ ] **Large note/excerpt text overflows logBuffer quota.** `note` and `excerpt` fields on `action: 'note'` log entries are written verbatim into `chrome.storage.local['logBuffer']` (10 MB hard limit) with no size check. Risk: many large annotations accumulate before the 5 s drain and push the buffer past quota. Fix mirrors the page-snapshot pattern — when `note` or `excerpt` exceeds a threshold (e.g. 4 KB), write the text to a dedicated file (`pages/{slug}/note-{timestamp}.md`) via `requestOffscreen`, then store only the path reference in the log entry. Replay must detect the path reference and load the file on demand. Both `background.js:1262-1312` (createNote / updateNote handlers) and `replay.js:364-376` (applyLogToNote) need updating. Tests: add a failing test that creates an oversized note entry and asserts the log entry does not contain inline text.

## Silent fallback / evil default audit

Principle: no silent fallbacks. Always get the true information regardless of cost. If a cache misses, fall through to disk — never silently degrade to a less-correct default.

### HIGH — data corruption risk

- [ ] **background.js — Multi-day visit check is dead logic.** If cache hits, entity already has checkpoint (no-op). If cache misses, logBuffer scan covers ~5s (never finds previous day). Fix: (1) cache recent immutable history files (`history/YYYY-MM-DD.jsonl`) into a URL→seen set for efficient multi-day detection; (2) when user opens a link from Portal Search (options.js), proactively emit `page_checkpoint` before navigating (we know it's a revisit).

### MEDIUM — incorrect behavior

- [ ] **options.js:351-356 — `urlToPinId()` always returns `page:<slug>`.** Never checks if the page is actually checkpointed. `toggleResultPin` sends pre-computed `id` to background, bypassing `resolvePageId`. Toggle-off can fail for `shallow:` pins. Fix: remove `urlToPinId`, send only `url` to background, let `resolvePageId` decide.
- [ ] **background.js:1247-1256 — `getPageRelations` list membership is cache-only.** `listCache:*` only populated when user has viewed that list in options. Unviewed lists silently skipped in the relations view. Should fall through to loading list pins from disk.
- [ ] **popup.js:234-242 — `loadListPins()` session-only, no disk fallback.** Pre-hydration returns `{}` → all lists shown as unpinned. Should fall back to `chrome.runtime.sendMessage({ action: 'getLists' })`.
- [ ] **popup.js:747-754 — Recycle/deleted check structurally wrong.** Compares `item.url` when entities use `item.key` (`page:<slug>` format). Also session-only with `|| []` default. Fix both the key format and the fallback.
- [ ] **popup.js:432 — `listOrder` session-only read, destructive on miss.** Cache miss → defaults to `[]` → saves `[newList]` → **wipes all existing list ordering**. Use `loadSettingsValue('listOrder', [])` which has session→disk fallback.
- [ ] **options.js:2942 — Same `listOrder` session-only read in "save explore as list".** Identical destructive pattern. Use `loadSettingsValue('listOrder', [])`.
- [ ] **options.js:3747 — `shallowPageIndex` session-only in explore auto-blocks.** Cache miss → empty SPI → children/parents-of-pins blocks show nothing. Fall back to `chrome.runtime.sendMessage({ action: 'getShallowPageIndex' })`.

### LOW — timing / cosmetic

- [ ] **content.js:5-9 — Private mode check races with hydration.** Content script reads `workspace` from session before background has hydrated. May start tracking before confirming private mode. Should query background (which awaits `hydrationDone`).
- [ ] **popup.js:758 — URL blacklist hardcoded fallback.** Session miss → falls back to `['chrome://', 'edge://']` instead of user's customized blacklist. Should query background for authoritative value.
