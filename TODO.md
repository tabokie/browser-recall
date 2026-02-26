# TODO

- [ ] **Re-inject content scripts on extension reload/re-enable.** Content script's `chrome.runtime` context is permanently invalidated after extension reload or disable→re-enable. Fix: call `chrome.scripting.executeScript` from `onInstalled` in background.js to re-inject into all existing tabs. Requires idempotency guard and stale Shadow DOM cleanup in content.js.
- [ ] **Enrich `page_checkpoint` context at runtime.** When `page_checkpoint` is appended, it often has empty title because the checkpoint fires before the page's real title is known. `page` entries that arrive later carry the title, but if the page entity was already created by `page_checkpoint` with empty title, the later `page` entries do update it — however if `page` entries arrive *before* `page_checkpoint` (e.g., navigation events before snapshot capture), they are dropped (entity is null). Investigate: (a) defer `page_checkpoint` until first `page` entry provides title/referrer context, or (b) carry forward pending `page` entry data into the subsequent `page_checkpoint`, or (c) allow `page` entries to create entities (would change replay semantics).

## Silent fallback / evil default audit

Principle: no silent fallbacks. Always get the true information regardless of cost. If a cache misses, fall through to disk — never silently degrade to a less-correct default.

### HIGH — data corruption risk

- [ ] **background.js:984-985 — Workspace auto-pin uses cache-only check.** `getCachedEntity` miss → defaults to `shallow:<url>` for a checkpointed page. Same bug class as the `toggleListPin` fix. Use `resolvePageId(url)`.
- [ ] **background.js:507-557 — `processPageReport()` diffs against cache-only entity.** `getCachedEntity` miss → treats every field as changed → logs redundant entries (bloats JSONL). Also re-adds referrer links that already exist. Should fall through to disk for the comparison baseline.
- [ ] **background.js:944-950 — Multi-day visit check uses cache-only entity, falls back to logBuffer scan.** Cache miss → logBuffer only has entries since last drain (5s) → misses yesterday's visit → `isMultiDay = false` → skips checkpoint creation for multi-day revisits. Should load page entity from disk.

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
