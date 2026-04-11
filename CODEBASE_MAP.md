# Browser Recall — Codebase Map

> Reference document. Update when functionality is added, removed, or significantly changed.

## File Index

| File | Lines | Role |
|------|-------|------|
| `extension/manifest.json` | 77 | MV3 manifest: permissions (incl. scripting, webNavigation, contextMenus), commands (Alt+S, Alt+H, Alt+L, Alt+D), CSP for WASM, content-fontface.js (document_start, all_frames), web_accessible_resources for fontface-intercept |
| `extension/background.js` | ~2660 | Service worker: central authority — handles ALL actions, `addLog(entry)` (appends to logBuffer + replays via `effectOf` + `sessionLoad`/`sessionWrite`; throws when service is paused), port channel to offscreen, unified `hydrateCache()` (loads base entities from offscreen then replays logBuffer via `effectOf`, first-run default "Hubs" list creation when no user lists exist; when `syncEnabled`, also loads+replays remote device logs via `loadRemoteLogEntries`), `getDeviceId()` async lazy getter (loads from plaintext `CURRENT` file via offscreen when `localDeviceId` is null — handles pre-hydration messages and SW wakeup without re-hydration), `ensureDeviceId()` writes immutable `CURRENT` file + creates log dir on first install, `readCacheable(key)`/`readFs(key)` (session→filesystem fallback for all cacheable keys — awaits hydrationDone, batch-loads settings, applies tree traversal via `getAllListKeys()`), `GC_TOMBSTONE` sentinel in session cache for GC'd entities (prevents `readCacheable` from reloading from disk before drain), referrer tracking (webNavigation closure: `getReferrer(tabId)`), keyboard commands, `captureAndLog(tabId, slug, timestamp, url, title)`, `setEntityCacheWatermark` on offscreen persist, sync orchestration (`buildSyncManager`, `performSync`, `replayRemoteEntries`, `updateSyncAlarm`, badge via `updateBadgeForTab`), downtime state machine (`pauseService(code, message)` / `resumeService()` / `isServicePaused()` — sets downtime icon, writes `serviceError` to session, guards mutation paths) |
| `extension/savepage-bridge.js` | ~180 | Save Page WE integration: `initSavepageBridge()` (registers `type`-based onMessage listener), `captureSavePage(tabId)` (injects SPWE scripts, returns Promise\<html\>), `loadSavepageResource()` (internal, skips video resources unless `captureSnapshotVideo` setting is true) — only Chrome APIs |
| `extension/entity-cache.js` | ~50 | Entity LRU cache: `cacheGet(key)`, `cacheSet(key, entity)`, `cacheRemove(key)`, `cachePin(key)`/`cacheUnpin(key)` — wraps `chrome.storage.session` with 500-entry LRU; `setEntityCacheWatermark(ts)` gates eviction to only flush entities with `max(timestamps) <= persistWatermark`; `cacheSet` catches `QuotaExceededError` and calls `emergencyEvict()` (aggressively evicts flushed then unflushed unpinned keys, retries) |
| `extension/replay.js` | ~850 | Shared pure replay: `effectOf(entry, load, context)` — single-pass, **all branches must be idempotent** (see ARCHITECTURE.md "Replay Idempotency Requirement"): `context.deviceId` always provided, each action branch loads affected entities and applies immediately, handles cross-entity effects inline; `defaultEntity(key)` creates empty entities; `isPageEligible(entity)` — checks if page has list parents, note/snapshot children, user_title, or likes; `applyLogToSettings`; tree helpers: `removeFromTree(tree, listId)` promotes children, `appendToTree(tree, listId, parentId)` adds node; action branches: `visit_page`/`leave_page` (enrich existing entities only, never create; per-device `timestamps` map for attention idempotency), `rename_page`/`rate_page` (create via `ensurePageEntity` which sets `createdAt` on new entities; per-device `timestamps` map for likes), `create_snapshot`/`create_note` (link child to page; duplicate check on childIds), `delete_note`/`delete_snapshot` (unlink + orphan + GC parent page if ineligible; LWW via `deletedTs`), `restore_note`/`restore_snapshot` (LWW via `deletedTs`), `pin_to_list`/`unpin_from_list` (update list pins + page/note parentIds + GC page if ineligible after unpin; duplicate check on pins), `create_list` (skip if entity exists) /`update_list`/`update_list_tree`/`delete_list` (tree manifest + compound-key name-to-id `owner/name` + GC pages after list deletion; tree reconciliation on update)/`restore_list`; entity key namespaces: `page:<slug>`, `note:<slug>`, `snapshot:<slug>-<ts>`, `list:<id>`, `list:system/*`, `manifest:settings`, `manifest:orphaned`, `manifest:name-to-id`, `manifest:list-order` |
| `extension/rule-engine.js` | ~170 | Pure rule matching module (no Chrome APIs): `RULE_TYPES`, `generateRuleId(type, ts)`, `validateRuleConfig({type, config})`, `validateFnRuleSource(source)` (word-boundary ban on 16 globals), `matchKeywordRule(rule, pageData)` (substring/regex, caseSensitive, auto-includes `body` field), `matchRules(rules, pageData, {sandbox?, allResults?})` (iterates by type; function sandbox returns boolean; `allResults` includes non-matches), `buildPageDataFromEntry(entry)` (includes `bodyPreview` as `body`) |
| `extension/fn-rule-sandbox.html` | 7 | Sandbox page for function rule execution (declared in manifest.json `sandbox` key — gets unsafe-eval CSP) |
| `extension/fn-rule-sandbox.js` | ~15 | Sandbox script: listens for `postMessage({action:'execute', fnSource, pageData})`, runs `new Function('page', fnSource)(pageData)`, coerces result to boolean, posts back `{id, match}` |
| `extension/logger.js` | ~28 | Central logger: `logDebug(...args)` (session-gated via `chrome.storage.session['debugLogging']`, live-toggleable via `storage.onChanged`), `logError(...args)` (always fires); defensive chrome guards for unit test compatibility |
| `extension/entity-types.js` | ~10 | Pure: `entityTypeLabel(key)` — returns 'Snapshot'/'Note'/'List'/'Page'/'Unknown' based on key prefix |
| `extension/bookmark-parser.js` | ~130 | Pure: `parseBookmarkHtml(html)` — parses Netscape Bookmark Format HTML into folder tree with bookmarks, skipped URLs, recursive counts. Dynamic-imported by options.js bookmark import UI. |
| `extension/shared.css` | ~160 | Shared CSS: font-face declarations (Fraunces, Nunito), base `:root` variables (colors, radii, shadows, typography), scrollbar, focus-visible defaults. Imported by `options.html`, `popup.html` via `<link>`. |
| `extension/color-schemes.css` | ~200 | Color scheme overrides: `[data-color-scheme="mono"]` and `[data-color-scheme="rose"]` rulesets re-mapping all palette variables. Default (amber) uses base `:root` from `shared.css`. |
| `extension/color-scheme-map.js` | ~47 | Palette definitions (amber/mono/rose) with accent, bgBase, border, shadow, text, excerpt colors. `SCHEME_HEX` for badge color, `getSchemePalette(scheme)` for snapshot-viewer/content.js. Content script duplicates palettes inline (can't import ES modules). |
| `extension/dark-theme.css` | ~90 | Dark mode overrides via `html[data-theme="dark"]` — remaps all CSS variables. |
| `extension/theme.js` | ~30 | `applyTheme()`: reads `theme` + `colorScheme` from session storage, sets `data-theme` and `data-color-scheme` attributes on `<html>`, un-hides page (`opacity`). |
| `extension/port-contract.js` | ~200 | Port message contract: declares all 48 background↔offscreen actions with request/response field names, pattern (request-response vs fire-and-forget), and direction |
| `extension/offscreen.js` | ~600 | Offscreen doc: port-only FS I/O worker — `initDone` promise gates `handleRequest` to ensure directory handle is loaded before processing (prevents null `directoryHandle` race on startup); drains logBuffer via round-cache + sequential `effectOf(entry, load, { deviceName })` replay (load closure over roundCache + filesystem), flushes dirty entities to disk (pure save — all cross-entity effects handled by effectOf), appends to device log dir `data/logs/<device>/YYYY-MM-DD.jsonl`, per-file locks; routes `list:system/shallow-page` to `lists/system/shallow-page.json`; sync actions: `loadSyncManifest`, `collectSyncFiles`, `writeSyncFiles`, `loadRemoteLogEntries` |
| `extension/offscreen.html` | 10 | Minimal host for offscreen.js (module script) |
| `extension/filesystem-storage.js` | ~900 | `FileSystemStorage` class: `#permissionGranted` cache, `#dirCache`/`#fileCache` Maps (file cache evicts at 2000 entries), `resolveDir(path)`, `resolveFile(path, {create})`, `readJson(handle)`, `writeJson(handle, data)`, `clearCache()`, `removeFile(parentDir, name)` (permanent delete), `pageExists(slug)`, `loadPage(slug)`, `savePage(slug, data)`, `deletePage(slug)`, `loadAllPages()`, `loadNote(slug)`, `saveNote(slug, data)`, `deleteNote(slug)`, `captureSnapshot(slug, ts, md, html)`, `deleteSnapshot(slug, ts)`, `getDirectorySize()`, `loadListPinsEntity(id)`, `saveListMeta(id, meta, ts)`, `deleteListFile(id)`, `loadSettings()`, `saveSettings(data)`; all File System Access API operations; entity methods return wrapped `{timestamp, ...}` format |
| `extension/content.js` | ~950 | Content script: accumulated attention tracking (1h timer + page close), highlight system (save-on-close for notes), markdown extraction (HTML capture moved to Save Page WE) |
| `extension/savepage/content.js` | ~4300 | Adapted Save Page WE v33.9 — self-contained HTML capture with data URIs for all resources |
| `extension/savepage/content-frame.js` | 286 | SPWE frame handler (upstream, unchanged) |
| `extension/savepage/content-fontface.js` | 57 | SPWE font-face intercept loader (path updated for savepage/ subdir) |
| `extension/savepage/content-fontface-intercept.js` | 74 | SPWE font-face intercept script (upstream, unchanged) |
| `extension/savepage/shadowloader.js` | 69 | SPWE shadow DOM loader (upstream, unchanged) |
| `extension/popup.js` | ~804 | Popup: per-page dashboard (title, snapshots, notes, lists, workspace); pin operations use typed ids (`page:<slug>`, `shallow:<url>`) |
| `extension/popup.html` | ~630 | Popup HTML + all popup CSS (inline) |
| `extension/options.js` | ~5060 | Options page: sidebar nav, explore view (landing page, block-based queries with auto-blocks), lists, recycle bin, settings modal; Rust-side parallel WASM search (searchBatch), lazy list pins, page read cache, event delegation, focus panel (centered overlay with resultRowHtml cards), explore-pin + focus buttons on every row; date-boundary dedup rendering (historyAllEntries), `enrichFromEntityStorage(entries)` batch title enrichment via `loadPageBatch`, ensureCheckpoint on portal-open; `slugFromPinId(id)` for cache-key derivation, `resolvePageRef(refId, pageSnap, spi)` unified typed-ref resolution (page entity or shallow-page index metadata); `showRecycleBin()` renders orphaned entity cards with type badges + restore/empty buttons, `updateRecycleBinBadge()` sidebar count; page detail modal event timeline (`collectTimelineEvents`, `renderTimelineHtml`) — vertical dot timeline showing visits, notes, and snapshots chronologically; service error banner (`showServiceErrorBanner`, `ERROR_CODE_MESSAGES` per-code table, live update via `storage.onChanged` listener) |
| `extension/virtual-scroller.js` | ~295 | `VirtualScroller` class: viewport-only rendering, `appendData`/`removeItems`/`applyFilter`/`refreshVisible`, `onLoadMore` callback, saved-node restoration — DOM APIs only via constructor |
| `extension/github-oauth.js` | ~20 | GitHub API helper: `fetchGitHubUser(token)` — validates PAT and returns `{ login }` |
| `extension/sync-transport-github.js` | ~50 | GitHub REST API adapter: `parseRepoUrl(url)` → `{owner, repo}`, `GitHubTransport` class with `_request(method, path, body)` (retry with backoff for 5xx/network errors, no retry on 4xx), `listBranches()`, `getTree(sha)`, `getBlob(sha)`, `createBranch(name, sha)`, `pushTree(branch, files)` (blobs→tree→orphan commit→force-update ref) |
| `extension/sync-manager.js` | ~50 | Sync orchestration: `SyncManager` class with injected deps (transport + fs callbacks), `push(deviceId, {retentionDays})` (hash-based change detection via push state), `pull(deviceId)` (peer discovery, tree SHA cursor for skip, blob diff, log/note separation, returns `{remoteEntries}` for caller replay) |
| `extension/related-scoring.js` | ~90 | `findRelatedPages(seeds, candidates, poolLimit)` — pure: pool-based scoring with hostname/title/temporal/intent weights; internal: `STOP_WORDS`, `titleWords`, `jaccardSimilarity`, `scoreTemporalProximity`, `prepareSeed`, `scorePair` |
| `extension/attention-utils.js` | ~50 | Pure attention functions: `parseAttention(entry)`, `attentionStrength(att)`, `attentionColor(normalizedScore)`, `aggregateAttention(entries)` |
| `extension/time-chart.js` | ~210 | Chart rendering: `initCharts()`, `renderTimeChart(entries, estimatedByDay?)`, `renderTimeChartInto(chartEl, barsEl, entries, label, estimatedByDay?)` — optional `estimatedByDay` Map renders lighter dashed bars for dates with file-size-estimated counts; `bindChartBarClick(chartEl, resultsContainer)` (skips estimated bars), `syncChartHighlights()`, `applyDateFilter(chartEl, resultsContainer)`, tooltip shows `~N visits (estimated)` for estimated bars |
| `extension/highlight-helpers.js` | ~240 | Highlight/note utility functions: excerpt extraction, note rendering, highlight matching |
| `extension/qb-tree.js` | ~80 | Pure QB tree: `qbCreatePredicate`, `qbCreateOperator`, `qbCreatePlaceholder(defaultFields)`, `qbFindNode`, `qbCollapseTree`, `qbFlattenSameOp`, `qbToTree`, `qbFlatten` — module-scoped `qbNodeIdCounter` |
| `extension/options.html` | ~3380 | Options HTML + all options CSS (inline), focus overlay (centered), explore badge, explore block CSS, `#serviceErrorBanner` (fixed top bar, hidden by default — shown by options.js when `serviceError` is in session) |
| `extension/utils.js` | ~105 | `BODY_WORD_LIMIT` (canonical 200-word limit for bodyPreview, shared with content.js), `readCacheable(key)` (unified cache read: session→background `readCacheable` message fallback), `loadSettingsValue(key, default)` (thin wrapper: readCacheable + defaultValue), `saveSettingsValue(key, value)` (sends saveSettingsKey to background), `generateSlugFromUrl(url)` (compact: strips www/TLD) |
| `extension/search-helpers.js` | ~70 | `extractHistoryBuffer`, `mergeBufferIntoHistory`, `getBufferContentMap`, `buildHistoryForEngine` — pure helpers for flat log entries |
| `src/lib.rs` | ~480 | WASM: `HistoryEntry` struct (url, title, content), `HistoryData` (JSONL deser), `SearchResult`, `SearchEngine` with Content ranking + AND/quoted word matching, `searchBatch` async fn (reads JSONL directly), `searchNotes` async fn (reads note JSON files, matches excerpt+note), `searchSnapshots` async fn (reads snapshot .md files, extracts slug from filename) |
| `Cargo.toml` | 23 | Rust deps: wasm-bindgen, wasm-bindgen-futures, serde, js-sys, web-sys (console only) |
| `tests/utils.test.js` | ~280 | Vitest: slug generation, collectQbTrees, readCacheable behavioral tests (session hit/miss, sendMessage fallback), loadSettingsValue defaultValue delegation |
| `tests/rule-engine.test.js` | ~300 | Vitest: 57 tests for rule-engine.js — generateRuleId (format, uniqueness), validateRuleConfig (keyword/function valid/invalid), validateFnRuleSource (16 banned globals + 10KB limit + no false positives on substrings), matchKeywordRule (substring, regex, case, fields, missing data), matchRules (mock sandbox, boolean matching, mixed types, missing providers), buildPageDataFromEntry |
| `tests/replay.test.js` | ~1471 | Vitest: tests for replay.js — effectOf scope (which keys affected per action), effectOf apply (entity mutations per action), effectOf integration (drain simulations, round-cache, referrer wiring, absorption), per-entity appliers (settings, page parentIds/childIds/visitDates/capture/page_checkpoint/attention with typed refs, note parentIds wiring only, del_note unlinking + orphaned, pins with `{id, pinnedAt}` format and `entry.ids` + page parentIds updates, del_list with page parentIds/SPI cleanup + orphaned, shallowPage index tracking parents/lists/title); idempotency + sequence replay; entity storage title resolution (last-write-wins, buffer replay, user_title); page_checkpoint absorption with list pin upgrade (shallow:→page:) |
| `tests/log-buffer.test.js` | ~160 | Vitest: 10 tests for background.js log buffer — appendLog, appendVisit, watermark pruning, SW restart recovery, mixed entry types |
| `tests/search-helpers.test.js` | 144 | Vitest: merge + engine-builder tests (flat log entry format) |
| `tests/persistence.test.js` | ~350 | Vitest: settings round-trip, list pins (wrapped entity format) |
| `tests/referrer-focus.test.js` | ~55 | Vitest: static analysis — webNavigation permission, onCommitted listener, getReferrer closure, focus panel parent title delegation to makeCard |
| `tests/message-routing.test.js` | 49 | Vitest: static analysis — every action sent by options/popup has a case handler in background.js |
| `tests/read-cacheable.test.js` | ~330 | Vitest: structural + behavioral tests for readCacheable/readFs — utils.js `readCacheable` export + background `readCacheable` handler, session hit, FS fallback, settings read via `readCacheable('settings')`, list ordering, hydrationDone blocking, offscreen field mismatch, options.js `readCacheable`-based loading |
| `tests/mutation-refresh.test.js` | ~105 | Vitest: static analysis — mutation listener + visibilitychange handler refresh all view types, not just category |
| `tests/e2e/fixtures.js` | ~55 | Playwright: worker-scoped fixtures — `extContext` (persistent browser context with extension loaded), `extensionId`, `setupDir` (OPFS-backed test directory via `setTestDirectory` action) |
| `tests/github-oauth.test.js` | ~50 | Vitest: 2 tests for github-oauth.js — fetchGitHubUser (success, auth failure) |
| `tests/sync-transport-github.test.js` | ~280 | Vitest: 20 tests for sync-transport-github.js — parseRepoUrl, listBranches, getTree, getBlob, createBranch, pushTree (blob→tree→commit→ref sequence), branch-creation fallback on 422, error handling (401/404/rate limit/network), retry logic (5xx retry+succeed, network retry+succeed, no retry on 401/404, max retries exhausted) |
| `tests/sync-manager.test.js` | ~180 | Vitest: 10 tests for sync-manager.js — first push, no-change skip, changed files, empty files, peer filtering, cursor skip, blob diff, multi-peer pull, no-peer pull |
| `tests/logger.test.js` | ~103 | Vitest: 6 tests for logger.js — silent by default, logError always fires, live toggle on/off, ignores non-session area |
| `tests/downtime.test.js` | ~214 | Vitest: 9 tests for downtime state machine — pauseService/resumeService/isServicePaused state, session writes, addLog throws when paused, proceeds after resume |
| `tests/e2e/sync-hydration.spec.js` | ~100 | Playwright E2E (3 tests): remote device logs replayed on hydration, local logBuffer + remote logs combined, sync-disabled skips remote replay |
| `tests/e2e/badge.spec.js` | ~130 | Playwright E2E (4 tests): blue dot for notes, green for lists, purple for both, no badge for unknown page |
| `tests/e2e/helpers.js` | ~150 | Playwright: `resetAndSeed(extContext, extensionId, files)`, `getSlugForUrl(page, url)`, `waitForVisitRecorded(helper, page, url, referrer)` (polls for page entity then falls back to sending reportPage from helper page), `openOptionsPage`, `openHelperPage`, `waitForListView` — reset/seed/rehydrate + slug computation matching extension's generateSlugFromUrl |
| `tests/e2e/history.spec.js` | ~80 | Playwright E2E (4 tests): seeded history in explore, clean state isolation, content script auto-reports visit, multi-entry sort order |
| `tests/e2e/lists.spec.js` | ~210 | Playwright E2E (5 tests): seeded list in sidebar, seeded pin in list view, pin via toggleListPin, unpin via toggleListPin, create new list |
| `tests/e2e/settings.spec.js` | ~150 | Playwright E2E (6 tests): seeded settings display in modal, changed setting persists after reload, first-run default Hubs list, debug logging toggle writes/reflects session storage |
| `tests/e2e/interactions.spec.js` | ~140 | Playwright E2E (4 tests): seeded page with likes via getPageInfo, createNote round-trip, attention data in explore, likes on seeded entity (file uses "history" naming internally) |
| `tests/e2e/cross-context.spec.js` | ~85 | Playwright E2E (2 tests): pin mutation visible after flush+fresh page, live visit notification updates explore |
| `tests/e2e/recycle-bin.spec.js` | ~400 | Playwright E2E (8 tests): restoreNote re-links to parent, restoreList re-adds to tree manifest + page parentIds, permanentDelete note/list after drain, permanentDeleteAll, recycle bin UI shows type badges, restore button removes card, empty button clears all |
| `tests/e2e/snapshot-entities.spec.js` | ~195 | Playwright E2E (5 tests): listSnapshots from entity childIds, deleteSnapshot removes + orphans, restoreSnapshot re-adds + un-orphans, permanentDelete snap files, recycle bin Snapshot badge + restore |
| `tests/e2e/event-timeline.spec.js` | ~160 | Playwright E2E (3 tests): timeline with visits/notes/snapshots, show-more expands truncated timeline, empty timeline when no events |
| `tests/e2e/rules.spec.js` | ~580 | Playwright E2E (16 tests): addRule keyword rule, removeRule, rules survive flush+rehydrate, runRuleBatch keyword auto-pins, addRule rejects banned globals, addRule stores function rule, runRuleBatch function sandbox auto-pins, rules UI section visible with count badge, add keyword rule via UI form, remove rule via UI click, system lists hide rules section, type toggle switches form panels, preview keyword matches, preview function rule syntax error, preview pinned pages section |
| `tests/e2e/port-contract.spec.js` | ~280 | Playwright E2E (33 tests): contract tests verifying background↔offscreen port message response shapes — reads (getDirectoryInfo, listSnapshots, getSnapshotUrl/Html, loadPageNotes, listHistoryFiles, loadHistoryBatch), manifest entities via readCacheable, error shapes for missing data, write round-trips (flushLogBuffer, getDeviceId), exhaustive coverage of all proxied offscreen actions |
| `tests/e2e/downtime.spec.js` | ~212 | Playwright E2E (11 tests): error banner hidden when healthy, banner per error code (session_quota/local_quota/offscreen_crash/fs_permission) with correct message+action button, resumeService clears banner, addLog throw path via createNote, syncNow/permanentDelete blocked, live banner update via storage.onChanged |
| `playwright.config.js` | ~10 | Playwright config: `tests/e2e/`, single worker, chromium channel |
| `vitest.config.js` | 7 | Test config |
| `package.json` | ~27 | Build: `wasm-pack`, test: `vitest`, test:e2e: `playwright test` |

## Message Routing

### Architecture: Background-centric (single entry point)
All `chrome.runtime.sendMessage` from popup/options/content go to background.
Background handles ALL actions in its `onMessage` listener (line ~646).
Offscreen is port-only — responds via `chrome.runtime.connect({ name: 'bg-offscreen' })`.

### background.js handles ALL actions (line ~646):
**Tab-dependent:** `getPageInfo` (entity storage: session cache → filesystem + buffer replay; null for shallow pages), `captureCurrentPageFromPopup`, `hydrateCache`, `reportPage`, `getReportedUrl` (returns URL from content script's initial report for a tabId — used by popup to avoid slug mismatch when tab.url drifts via pushState)
**Pure reads (relay to offscreen via port):** `getDirectoryInfo`, `getSnapshotUrl`, `getSnapshotHtml`, `listHistoryFiles`, `loadHistoryBatch`
**Snapshot viewer:** `openSnapshot` opens `snapshot-viewer.html?slug=...&ts=...` extension page (content scripts don't run on blob: URLs)
**Entity-based reads:** `listSnapshots` (reads page entity `childIds` filtered for `snap:` prefix — no offscreen I/O)
**Composite reads (readCacheable-based):** `loadPageNotes` (reads page entity + each note via `readCacheable`)
**Cacheable reads (via `readCacheable` — session→filesystem fallback):** `readCacheable` (generic: any key — settings, list entities, SPI, auto lists, notes, pages, history). `getPageInfo` reads notes from page.childIds via `readCacheable('note:*')` and snapshots from page.childIds filtered for `snap:` prefix.
**Page relations:** `getPageRelations` (resolves `page:<slug>` refs via `readCacheable`, `shallow:<url>` extracted directly; parents from parentIds + SPI fallback + list membership; children from childIds + SPI inverse lookup)
**Writes (all via `addLog` — append + effectOf session replay):** `saveSettings`, `saveSettingsKey`, `createNote` (writes note file to disk first via offscreen `saveNote`, then logs lean `{ action: 'note', slug, parentIds }` — no content), `deleteNote` (loads note parentIds, logs `{ action: 'del_note', slug, parentIds }` — no physical file move), `restoreNote` (loads note parentIds, logs `{ action: 'restore_note', slug, parentIds }`), `deleteSnapshot` (logs `{ action: 'del_snap', slug, parentIds }` — no physical file move), `restoreSnapshot` (logs `{ action: 'restore_snap', slug, parentIds }`), `restoreList` (loads entity with includeDeleted, logs `{ action: 'restore_list', id, name, pins }`), `toggleListPin` (re-validates shallow IDs via `resolvePageId`), `addListPins` (re-validates via `resolveShallowIds`), `saveListMeta`, `deleteList`
**Physical deletion (drain + offscreen):** `permanentDelete` (flushes logBuffer, deletes file via offscreen for note/list/snap, updates orphaned list, clears session cache), `permanentDeleteAll` (same for all orphaned keys)
**Writes (immutable note edit via log):** `updateNote` (creates new note file via offscreen `saveNote`, logs `replace_note` — old note orphaned with `deletionReason: 'replaced'`, new note inherits parentIds and list pins)
**Pass-through (complex FS ops via port):** `saveListPins` (orphan cleanup), `initializeFilesystem`
**Rule operations:** `addRule` (validates config, logs `add_rule`), `removeRule` (logs `remove_rule`), `updateRule` (logs `update_rule`), `runRuleBatch` (iterates lists with rules × entries, calls `matchRules` with offscreen sandbox closure, auto-pins via `addLog(pin_to_list)`)
**Sync operations:** `syncNow` (manual trigger → `performSync()`), `getSyncStatus` (returns last sync result from `syncLastResult`), `updateSyncSettings` (saves settings + `updateSyncAlarm()`)
**Port-based operations:** `import-bookmarks` port (options.js → background.js): receives `{ action: 'importBookmarks', tree }`, creates timestamped parent list + nested child lists via `addLog(create_list)`, pins bookmark URLs via `addLog(pin_to_list)`, streams progress/done/error messages back via port. Aborts on list creation failure; tolerates up to 20 bookmark pin failures.
**Buffer management:** `clearWriteQueue`, `flushLogBuffer`
**Service lifecycle:** `resumeService` (clears serviceError, restores normal icon, re-hydrates)
**Test infrastructure:** `setTestDirectory` (relay → offscreen OPFS setup), `resetForTest` (clear logBuffer + caches + reset `localDeviceName` + `serviceError` + wipe directory + re-hydrate), `rehydrateForTest` (clear caches + reset `localDeviceName` + re-hydrate without wiping directory), `seedTestData` (relay → offscreen file writes), `simulatePreHydrationForTest` (sets `localDeviceName = null` to simulate the pre-hydration window where SW just started but hydrateCache hasn't run), `pauseServiceForTest` (calls `pauseService(code, message)` for testing downtime UI)

### offscreen.js handles via port (line ~68):
Same read actions as before + `saveListPins` + `loadListPinsById` + `loadAllListMetadata` + `saveNote` + `deleteNote` + `deleteListFile` + `loadOrphaned` + `pageExists` + `listListFiles` + `saveJson` (direct saves) + `loadShallowPageIndex` + `loadNote` (single note by slug) + `loadSyncManifest` (reads sync-cursors/sync-push-state from manifest/) + `collectSyncFiles` (scans device logs + notes for push) + `writeSyncFiles` (writes remote files to disk) + `loadRemoteLogEntries` (scans all device log dirs, excludes local, returns per-device entries) + log buffer drain via port `drainEntries` messages (appends to history JSONL + checkpoints entities via replay.js, handles list_meta/del_list, checkpoints shallow-page index + orphaned entities; deleted list entities skipped in flush — file stays on disk)
**Test infrastructure:** `setTestDirectory` (creates OPFS-backed directory handle for test use), `resetDirectory` (wipes all directory contents + resets drain state), `seedTestData` (writes JSON/JSONL files to directory)

### content.js handles (line ~875):
`extractMarkdown`, `highlightSelection`, `removeHighlightMark`, `showHighlightsPanel`, `isPdfPage`, `showCaptureNotification`, `showLikeNotification`

### Save Page WE messages (savepage-bridge.js, `type` field — separate from `action` field):
`scriptLoaded`, `setDelay`, `requestFrames`, `replyFrame`, `loadResource`, `stateChanged`, `savepageDone`, `saveExit`

### background.js commands (line ~602):
`capture-snapshot` (Alt+S), `highlight-selection` (Alt+H), `like-page` (Alt+L), `dislike-page` (Alt+D)

### Context menu (background.js):
`portal-highlight` — registered in `onInstalled`, `contextMenus.onClicked` uses `chrome.tabs.query({active:true, lastFocusedWindow:true})` to get real URL/tabId (workaround for PDF viewer reporting wrong tab info); delegates to `handleContextMenuHighlight(url, title, selectionText, tabId)` which creates a note and sends `showHighlightsPanel` to content script. Also exposed as `contextMenuHighlight` message handler for E2E tests.

## Feature → Code Map

### Page Visit Tracking (Event-Sourced)
- **Entry**: `content.js` — unified `report(delta)` sends `reportPage` to background; initial load (title, slug, referrer, `isInitialLoad`), periodic attention (title, scrollDepth, timeOnPage every 5s), title-only on mutation, `isLeaving` on visibility hidden / freeze / beforeunload. `timeOnPage` reports **foreground-only deltas** (not cumulative): `lastActiveTime` resets on `visibilitychange→visible` and `resume`; nulled after each leave report to prevent double-counting. Capped at 1h per delta.
- **Background handler**: `background.js` `reportPage` → `processPageReport(delta)` trims title, diffs all fields against cached entity, logs only changes; `isInitialLoad` triggers referrer tracking + checkpoints + workspace auto-pin/snapshot; `isLeaving` triggers `drainNow()`
- **Blacklist check**: skips URLs matching `urlBlacklist` prefixes (unless already in DB)
- **Title trimming**: applies `titleTrimRules` (remove_after_pipe, remove_brackets, remove_parens)
- **Log buffer**: background holds `logBuffer` array (lazy-loaded from `chrome.storage.local['logBuffer']` via `ensureLogBuffer()`); bounded at `LOG_BUFFER_MAX_SIZE` (2000) — when exceeded, drops drained entries (ts <= `logBufferWatermark`) first, then oldest; `chrome.storage.local.set` wrapped in try/catch (quota failure doesn't lose in-memory entries); all mutations via `addLog(entry)` which appends to buffer AND replays against session cache via `effectOf(entry, sessionLoad)` + `sessionWrite(effects)` — serialized via `withLock('logBuffer')`
- **Log entry format**: all entries have `action` field — `page` (visit + attention + capture: `{timestamp, action:'page', url, title?, referrerId?: 'page:<slug>', scrollDepth?, timeOnPage?, mdPath?, htmlPath?}`), `page_checkpoint` (ensures page entity exists), `set`, `note` (wires `childIds` on parent pages only — note content on disk, not in log: `{timestamp, action:'note', slug, parentIds}`), `del_note` (unlinks note from parent `childIds` + adds to orphaned list: `{timestamp, action:'del_note', slug, parentIds}`), `list` (op: add/del/clear, `ids: ['page:<slug>', 'shallow:<url>', ...]`), `list_meta`, `del_list`
- **Drain**: offscreen receives `drainEntries` (with `deviceName`) via port, replays sequentially via `effectOf(entry, load, { deviceName })` with round-cache over filesystem, flushes dirty entities to disk, appends to `data/logs/<device>/YYYY-MM-DD.jsonl`; `pendingDrainEntries` cleared only after successful JSONL write (preserved for retry on failure); per-entity flush wrapped in try/catch (one entity failure doesn't block others); sends `{ action: 'persisted', watermark }` back to background for pruning
- **Per-file locks**: background serializes all cache updates via `withLock('logBuffer')` inside `addLog`; offscreen keeps per-file locks for checkpoint writes and read operations; both `withLock` implementations have a 30s timeout (`LOCK_TIMEOUT_MS`) to prevent permanent deadlock
- **Port crash recovery**: `onDisconnect` handler resolves all pending `portCallbacks` with `{ success: false, error: 'Offscreen port disconnected' }` and clears the Map — prevents leaked promises when offscreen crashes
- **Note ops**: `createNote` in background — `ensureCheckpointIfMissing` ensures parent page exists, writes note file to disk first via offscreen `saveNote`, then logs lean `{ action: 'note', slug, parentIds }` (no content in log); `deleteNote` — loads note parentIds, logs `{ action: 'del_note', slug, parentIds }` (offscreen deletes note file); `updateNote` — writes directly to disk via offscreen, no log entry; notes are first-class entities with `note:{slug}` keys; log entries use `parentIds` with typed refs
- **Hydration replay**: `hydrateCache()` loads base entities from offscreen into session cache (populates `localDeviceName` from settings), then replays ALL pending `logBuffer` entries via `effectOf(entry, sessionLoadDuringHydration, { deviceName })` + `sessionWrite` — same replay path as `addLog`. All runtime read sites use `await getDeviceName()` (lazy getter that falls back to `readCacheable('manifest:settings')` when `localDeviceName` is null — handles messages arriving before hydration completes)

### Snapshot Capture
- **Keyboard shortcut**: Alt+S → background `captureSavePage(tabId)` (injects SPWE scripts → gets self-contained HTML) + content `extractMarkdown` (parallel)
- **Popup button**: popup → background `captureCurrentPageFromPopup` → same parallel flow
- **HTML capture**: Save Page WE engine — converts all resources (images, fonts, CSS) to data URIs → truly self-contained HTML; `savepage-bridge.js` injects `savepage/content-frame.js` (all frames) then `savepage/content.js` (main), content sends `savepageDone` with HTML, `captureSavePage` resolves Promise
- **Markdown extraction**: `content.js` `extractMarkdown()` (10KB cap) — lightweight DOM-to-markdown conversion
- **Background resource fetch**: `savepage-bridge.js` `loadSavepageResource()` (internal) — background fetches CORS resources for SPWE via `loadResource` message (10s timeout, 50MB size cap, video skipped by default via `captureSnapshotVideo` setting)
- **Filesystem write**: `filesystem-storage.js` `captureSnapshot(slug, ts, md, html)` → `data/snapshots/{slug}-{ts}.md|.html`. Embeds `<meta name="x-portal-slug" content="{slug}">` in HTML for slug identity.
- **Two-phase capture log**: after offscreen writes files, background calls `addLog({ action: 'page', url, mdPath, htmlPath })` — large content never in log buffer
- **PDF guard**: `captureAndLog` rejects PDFs — first checks `.pdf` URL extension, then asks content script `isPdfPage` (DOM-based `embed[type="application/pdf"]` check) as fallback for extensionless PDF URLs (e.g. arXiv)
- **Auto-snapshot**: workspace mode with `autoSnapshot` flag

### Highlight / Note System
- **Create note**: Alt+H with text selected → content.js → background `createNote` (ensureCheckpointIfMissing + addLog)
- **Cross-node support**: `getClosestBlock()` determines if selection is same-block (inline spans) vs cross-block (divs, lis); same-block uses `extractContents` via `wrapRangeWithMark()`; cross-block uses `splitSelectionByBlock()` to create per-block chunks
- **Data model**: note entity with `excerpt` (string | string[]) + `note` (annotation text); `excerpt` is single string for same-block, array of trimmed chunks for cross-block; `excerpt: null` for global page notes
- **Global page note**: Alt+H with no selection → `showGlobalNoteOverlay()`
- **Overlay UI**: Shadow DOM for style isolation; matches highlight by timestamp (primary), falls back to text
- **Visual marks**: wraps text in `<mark class="portal-highlight">`; grouped marks share `data-highlight-timestamp`; delete unwraps all marks in group
- **Reapply on load**: `getSlugForCurrentPage()` checks `<meta name="x-portal-slug">` first, then falls back to URL parsing; reads notes via `loadPageNotes`; normalizes excerpt to array, highlights each chunk via `findTextRange()` cross-node search
- **Snapshot viewer highlights**: `snapshot-viewer.html` + `snapshot-viewer.js` renders snapshot in srcdoc iframe; loads notes via `loadPageNotes` and applies highlights to iframe's DOM. Popup extracts slug from viewer URL params for `getPageInfo`.
- **Context menu highlight**: right-click "Highlight Selected" → background `handleContextMenuHighlight` (ensureCheckpointIfMissing + saveNote + addLog + sends `showHighlightsPanel` to content script); uses `chrome.tabs.query({active:true, lastFocusedWindow:true})` to get real URL (workaround for Chrome PDF viewer reporting internal extension URL)
- **Highlights panel**: `showHighlightsPanel(notes, pageSlug, {hint})` in content.js — Shadow DOM overlay listing all excerpt notes with inline edit textareas, delete buttons, draggable header; auto-shown on PDF pages (1500ms delay + MutationObserver re-creation guard, module-scoped `_panelDismissed` flag suppresses re-creation after user closes)
- **PDF page support**: content.js detects PDFs via `.pdf` URL extension OR `embed[type="application/pdf"]` DOM check (covers extensionless URLs like arXiv); auto-shows highlights panel with hint after 1500ms; DOM-based highlight marks not possible (PDFium plugin), but context menu `info.selectionText` works
- **Storage**: note entities in `notes/{slug}.json`; notes linked to parent pages via `page.childIds` containing `note:{slug}` keys

### Search & Ranking (WASM)
- **Engine**: `src/lib.rs` — `SearchEngine` with Content ranking; returns `SearchResult` with `score` field; AND/quoted word matching (consistent with JS `parseSearchWords`)
- **Content scoring**: title(2.0), content(1.0) — each field scored independently, all query words must match (AND semantics); quoted words use word-boundary matching
- **Progressive search**: `options.js` `runProgressiveSearch(allQueries)` — four concurrent phases, generation counter discards stale results:
  - **Phase 0**: instant in-memory fuzzy match on loaded `historyAllEntries` (title/url/user_title); `phase0Score` computes lightweight relevance (title=2.0, URL=0.5, fuzzy=0.3)
  - **Phase 1**: `runPhase1` — iterates `data/logs/{device}/` subdirs, streams WASM `searchBatch` calls (10 files/chunk, concurrency=3); dirty logBuffer searched in JS via `SearchEngine`
  - **Phase 2a**: `runPhase2a` — WASM `searchNotes` reads `data/notes/*.json`, matches query against excerpt+note text
  - **Phase 2b**: `runPhase2b` — lists `data/snapshots/*.md`, groups by slug (latest per slug only), streams WASM `searchSnapshots` calls (10 files/chunk, concurrency=2)
- **Result merging**: `mergeSearchResults` deduplicates by URL, takes max score, propagates earliest `createdAt`, tracks match sources (`title`/`history`/`note`/`snapshot`); `renderProgressiveResults` enriches (incl. `createdAt` from page entity) + filters + re-sorts + calls `vs.updateData`
- **searchBatch (WASM)**: `src/lib.rs` — async fn that takes `FileSystemDirectoryHandle` refs for device log dir and pages/, reads JSONL files, deduplicates by URL, builds SearchEngine and returns results. Content field is empty by design (pages/{slug}/ subdirs don't exist; snapshot content covered by Phase 2b)
- **searchNotes (WASM)**: `src/lib.rs` — reads all `.json` files in notes dir, parses excerpt (string or array) + note fields, returns `[{url, noteSlug}]` for matches
- **searchSnapshots (WASM)**: `src/lib.rs` — reads batched `.md` files by name, matches query, extracts slug from filename `{slug}-{timestamp13}.md`, returns `[{slug}]` for matches
- **Demand-loaded history**: `initHistoryFiles()` lists JSONL files; `loadHistoryBatch()` loads 10 files at a time into `historyByUrl` Map (capped at 100 files); `showCategory()` triggers first batch, VirtualScroller `onLoadMore` triggers subsequent batches on scroll
- **No global cachedData**: history view uses `historyByUrl` Map; explore search uses `runProgressiveSearch`; list search uses `runListPinFilter`
- **Sort**: column headers (Title, Last Visit, Att) replace old ranking/sort pills; click cycles none→desc→asc→none. **Search default**: relevance (desc) with `createdAt` tiebreaker (oldest first; falls back to `Math.min(timestamps)` for pages without entities). **Non-search default**: lastVisit (desc)
- **Extra columns**: "+" button popover toggles First Visit (all views) and Pin Time (pinned section only)
- **Match badges**: `resultRowHtml` renders `[matched in note]` / `[matched in snapshot]` badges when `matchSources` contains 'note' or 'snapshot'
- **Data prep**: `search-helpers.js` `buildHistoryForEngine()` — converts raw data to WASM HistoryEntry objects (no `id` field)
- **Buffer merge**: `search-helpers.js` `mergeBufferIntoHistory()` — dedup by URL, sort by timestamp; `getBufferContentMap()` extracts buffer content separately

### Lists (Pinned Searches) — formerly "Collections" / "Topics"
- **Storage**: Self-describing files `lists/{id}.json` — each file contains `{slug, timestamps, name, pins: [{id, pinnedAt}, ...]}`. Pin `id` is typed ref (`page:<slug>` or `shallow:<url>`). Tree structure stored separately in `manifest/list-order.json` (`{ timestamps, tree: [{ id, children?: [...] }] }`) — single source of truth for hierarchy and ordering. Session cache hydrated from files by background.
- **Display name**: `listDisplayName(list)` → `name || query`; `name` always present in self-describing files
- **Create/update**: `options.js` sends `saveListMeta` message to background (which updates session cache + appends `create_list`/`update_list` log entry); new lists appended to tree via `appendToTree` in `effectOf`
- **Delete**: `options.js` sends `deleteList` message to background (appends `delete_list` log entry; `effectOf` removes from tree via `removeFromTree` — promotes children to parent level, non-cascading)
- **Reparent**: `options.js` sends `updateListTree` message (which emits `update_list_tree` with full tree blob; LWW by per-device timestamp)
- **ID format**: `crypto.randomUUID()` for new lists (existing ones migrated from timestamp-based IDs)
- **Sidebar**: `options.js` `renderLists()` — recursive tree renderer with fold/unfold toggle, three-zone drag-drop (top 25% reorder above, middle 50% nest as child, bottom 25% reorder below), resizable sidebar width
- **Title editing**: `options.js` `enterTitleEditMode()` — inline edit with confirm/cancel; used for double-click rename
- **List view**: `options.js` `showList()` — pins-only view with search input to filter pins; renders all pins into `#relatedResults` via virtual scroller, time chart from pin data; double-click title to rename
- **Related pages scoring**: `related-scoring.js` `findRelatedPages(seeds, candidates, poolLimit)` — pool-based: processes seeds iteratively, fills shared pool up to configurable limit (default 50, settings `relatedPagesLimit`); weights: hostname 0.30, title 0.30, temporal 0.25, intent 0.15; imported by options.js (used by explore auto-blocks)
- **List pin filter**: `options.js` `renderListPinView()` — stores enriched pins in `listPinsData`, renders simplified search input, filters with `wordsMatchItem()`, renders via `renderFilteredPins()` into virtual scroller + time chart
- **List explore (explore only)**: `options.js` `renderListSearchFilters()` — renders search panel with saved searches, runs search/filter pipeline (explore view only)
- **Popup list chips**: `popup.js` `renderListChips()` — shows top 5 most-recently-active lists as chips, `+` button opens search/create picker dropdown (`openListPicker()`)
- **Popup list picker**: `popup.js` `openListPicker()` — dropdown with search input, filtered rows with checkmarks, create option for new names; `toggleListPin()`, `createListAndPin()` helpers

### Explore View — Searches + Filters
- **Explore button**: sidebar top, opens explore view (landing page — replaces History)
- **Landing page**: list layout with search panel; no queries = shows all history with demand-loading
- **Search model**: `savedSearches: string[]` session-only UI state (per-view in `chrome.storage.session` keyed `searchQueries:<viewKey>`), `currentSearchInput` for live draft; OR across queries, AND within each query (quoted exact match supported)
- **Pipeline**: `runSearchFilterPipeline()` — collects saved + draft queries, OR-matches across history, `processHistoryForDisplay()` → render results + time chart (explore only); enrichment is non-blocking: rows render immediately, `enrichFromEntityStorage()` runs in background then `vs.refreshVisible()` updates visible rows with entity tags
- **Pin filter**: `runListPinFilter()` — filters list pins by `wordsMatchItem()` with same OR/AND semantics, renders via virtual scroller + time chart (list view only)
- **Rendering**: `renderSearchPanel()` — saved search rows with edit/remove, draft input; shared between explore and list views
- **Events**: `bindSearchEvents()` — inline edit, remove, draft input (Enter to add query row), debounced pipeline
- **Persistence**: `saveSearchQueries()` / `loadSearchQueries()` — stores queries in `chrome.storage.session` per view key
- **State**: `savedSearches` (string[], session-only), `currentSearchInput` (draft), `exploreDebounceTimer`
- **Entry**: `options.js` `showExplore()` — loads search queries from session, renders search panel, runs pipeline
- **Explore only**: `renderListSearchFilters()` — renders search panel + runs `runSearchFilterPipeline()`

### Workspace / Private Mode
- **State**: `settings.json` key `workspace` `{mode: 'default'|'workspace'|'private', listIds, autoSnapshot}`; cached in session as part of `settings` object
- **Popup UI**: three-way toggle (Workspace / default / Private), list chips, auto-snapshot checkbox
- **Private mode guards**: content.js (init gate skips all tracking), background.js (reportPage handler, commands), popup.js (toggle-only view)
- **Auto-pin**: on page visit, auto-pins to workspace lists (mode=workspace only)
- **Auto-snapshot**: if workspace.autoSnapshot, captures snapshot on visit

### Options Page Views
- **Category filters**: `options.js` `filterByCategory()` — today, week, highlighted
- **Explore view**: `options.js` `showExplore()` — search/discovery only; shows list layout with search panel + filters + time chart; no pins displayed; shows entire history with demand-loading when no queries
- **List view**: `options.js` `showList()` — pins-only view; loads pins per-list (cached in `allListPins`), resolves + enriches via `enrichPinResult()`, renders into `#relatedResults` via virtual scroller; simplified search input filters pins with `wordsMatchItem()`; time chart from pin data; rules section (collapsible, type badges + inline add form + run button)
- **Pin refresh**: `options.js` `refreshPins()` — lightweight incremental re-render after pin toggle; for explore: runs search pipeline; for list: re-resolves pins and re-renders via `renderListPinView()`
- **Virtual scrolling**: `virtual-scroller.js` `VirtualScroller` class — viewport-only rendering (~50-80 DOM nodes at any time); `appendData(newItems)` for demand-loading (items pre-sorted before append), `refreshVisible()` re-renders visible rows after in-place data mutation (used by non-blocking enrichment), `onLoadMore` callback triggers near end of data; imported by options.js, instances for global results and list explore
- **Event delegation**: `bindResultDelegation(container)` — single container-level click/dblclick/dragstart handler, replaces per-row listeners; click and dblclick both traverse `.result-item` → `.result-row` (extras area is outside `.result-row` but inside `.result-item`); dragstart collects all `.selected` rows for multi-drag
- **Multi-drag drop**: list sidebar `drop` handler processes `{ items: [...] }` array, bulk-adds pins with single `saveAllListPins()` call
- **Result rows**: `options.js` `resultRowHtml()` — attention dot, expand detail, pin (unified, always shown), delete, focus (hideable via `noFocusButton`), extra column cells via context
- **Column headers**: `options.js` `columnHeaderHtml(context)` + `bindColumnHeaderClicks()` — delegated sort, "+" popover for extra columns
- **Inline detail**: lazy-loads notes, snapshots, lists on expand
- **Attention chart**: daily aggregated attention bar chart; selection highlights bars blue, click-to-filter turns bars amber; incremental: `onLoadMore` callback re-renders chart with all loaded history after each batch
  - `syncChartHighlights()` — syncs selected row dates → `.highlighted` on chart bars
  - `bindChartBarClick(chartEl, resultsContainer)` — click bar to toggle `.active`, filters results by date
  - `applyDateFilter(chartEl, resultsContainer)` — hides/shows `.result-item` based on active bar dates
  - Result rows carry `data-dates` attribute (comma-separated YYYY-MM-DD)

### Sidebar Layout (options.html)
```
[🔍 Explore]          ← prominent button, top of sidebar (landing page)
─────────────────────
Lists                 ← section label
  My List 1           ← pinned searches
  My List 2
  "Pin a search..."   ← empty state
```

### Deletion System
- **Orphaned list**: `manifest/orphaned.json` — `{ timestamps, entries: [{ key, url? }] }` — tracks deleted entity keys with optional parent URL for notes/snapshots
- **Note deletion**: `delete_note` log action unlinks note from parent page `childIds` (derived from `note.url`) and adds `{ key: 'note:<slug>', url }` to orphaned entries; offscreen `deleteNote` removes the note file
- **List deletion**: `delete_list` log action removes list from `manifest:list-order` tree (promotes children to parent level), removes `list:<id>` from page `parentIds` for pinned pages, adds `list:<id>` to orphaned manifest; non-cascading — only the target list is deleted
- **Selection**: click, shift-click range, ctrl-click toggle
- **Marquee select**: drag from results background (gutter is now full-width behind floating result items)

### Multi-Device Sync (GitHub)
- **Architecture**: `sync-transport-github.js` (HTTP adapter) → `sync-manager.js` (pure orchestration with injected deps) → `background.js` (wiring: alarms, message handlers, offscreen bridge)
- **Transport**: `GitHubTransport` class — `_request()` with retry (2 retries, 500ms/1000ms backoff, retries 5xx/network, not 4xx); `listBranches()`, `getTree(sha)`, `getBlob(sha)`, `createBranch(name, sha)`, `pushTree(branch, files)` (blobs→tree→orphan commit→force-update ref, fallback POST on 422). Uses custom `utf8ToBase64`/`base64ToUtf8` helpers instead of raw `btoa`/`atob` (native functions corrupt non-ASCII characters).
- **Push**: `SyncManager.push(deviceId, {retentionDays})` — `collectSyncFiles` via offscreen (device logs within retention + all notes) → djb2 hash change detection via `manifest/sync-push-state.json` → `transport.pushTree()` if changed
- **Pull**: `SyncManager.pull(deviceId)` — `transport.listBranches()` → filter own device → tree SHA cursor skip via `manifest/sync-cursors.json` → blob diff → download changed files → separate logs vs notes → `writeRemoteFiles` for notes → returns `{ remoteEntries }` for caller replay
- **Remote replay**: `replayRemoteEntries(entries, peerDeviceId)` in background.js — `effectOf` + `sessionWrite` loop (no logBuffer, no history key); `scheduleDrainNotify()` after
- **Hydration**: when `syncEnabled`, `loadRemoteLogEntries` via offscreen scans all device log dirs (excludes local), replays each peer's entries via `replayRemoteEntries`
- **Alarm**: `chrome.alarms` with `SYNC_ALARM_NAME` ('portal-sync'), interval from `syncIntervalMinutes` setting; `updateSyncAlarm()` creates/clears alarm based on `syncEnabled`
- **Token security**: `github-oauth.js` — `fetchGitHubUser(token)` validates PAT. Token stored in `chrome.storage.session` (key `__syncToken`), never on disk by default. "Remember on disk" opt-in writes to `syncToken` in settings.json. Background loads disk→session on startup via `loadSyncTokenFromDisk()`. Auth errors (401) clear session token and set `authExpired` flag.
- **Error handling**: `performSync()` classifies errors — auth (401/403) → clear token + disable alarm + `{ disabled: true, authExpired: true }`; not-found (404) → disable alarm; transient errors keep retrying via alarm
- **Auth UI**: two-state in settings modal — disconnected (PAT input + Connect button), connected (username + disconnect). `syncShowAuthState(state, detail)` switches visibility.
- **Settings UI**: options.html sync section in settings modal — toggle, method, repo URL, auth state, remember checkbox, interval, retention, save, sync-now, status display
- **Settings keys**: `syncEnabled`, `syncMethod`, `syncRepoUrl`, `syncIntervalMinutes`, `syncRetentionDays`, `syncAuthMethod`, `syncGitHubUser`, `syncRememberToken`, `syncToken` (disk-persisted only when remember is on)
- **Message actions** (token): `setSyncToken` (store in session + optionally disk), `clearSyncToken` (clear all), `getSyncAuthState` (returns hasToken/authMethod/githubUser/rememberToken), `toggleSyncRemember` (toggle disk persistence)
- **Offscreen actions**: `loadSyncManifest(key)`, `collectSyncFiles(deviceId, retentionDays)`, `writeSyncFiles(files)`, `loadRemoteLogEntries(localDeviceId)`
- **Filesystem**: `collectSyncFiles()` scans `data/logs/<deviceId>/` + `data/notes/` → `[{path, content}]`; `writeSyncFiles(files)` writes to disk; `loadRemoteLogEntries(localDeviceId)` scans all device dirs, excludes local, returns `[{deviceId, entries}]`

### Settings (Modal in Options)
- **Storage location**: select/change directory, migrate data
- **Statistics**: total, today, pending buffer
- **URL blacklist**: add/remove prefix rules
- **Title trimming**: url prefix + action rules
- **Clear all data**: deletes all files in storage directory

### Filesystem Storage
- **Directory handle**: IndexedDB `PortalFS.handles` key `directory`
- **Permission**: `verifyPermission()` — cached via `#permissionGranted` (near-free after first grant, reset on `selectDirectory()` and `removeFile()`)
- **Handle cache**: `resolveDir(path)` caches directory handles with segment-level sharing; `resolveFile(path, {create})` caches file handles, evicts on error; `clearCache()` resets both + permission
- **JSON helpers**: `readJson(handle)` / `writeJson(handle, data)` — reduce boilerplate for R-M-W patterns
- **Metadata**: JSONL files `<device>/YYYY-MM-DD.jsonl` — one JSON line per history entry, organized by device subdirectory
- **Content**: `pages/{slug}/{timestamp}.md|.html` (versioned snapshots)
- **Legacy**: `pages/{slug}.md` flat files coexist via fallback reads
- **Notes**: `notes/{slug}.json` — per-note entity `{ slug, excerpt, note, cssPath, url }` (no timestamps — immutable); `loadPageNotes(pageSlug)` returns all notes whose parent is the given page
- **List files**: `lists/{listId}.json` — self-describing entity `{ slug, timestamps, name, owner, pins: [{id, pinnedAt}, ...] }`; pin `id` is typed ref (`page:<slug>` or `shallow:<url>`); `loadListPinsById(id)` returns just pins, `loadListPinsEntity(id)` returns full entity; `saveListMeta(id, meta)` preserves pins (read-merge-write); `loadAllListMetadata()` scans all files; `deleteListFile(id)` removes file
- **Note deletion**: `deleteNote(slug)` — removes note file from `data/notes/`
- **Orphaned list**: `manifest/orphaned.json` — `{ timestamps, entries: [{ key, url? }] }` — tracks deleted entity keys with optional parent URL
- **Settings**: `settings.json` — derived checkpoint with per-device `timestamps` map
- **Pages**: `pages/{slug}.json` — per-page metadata (attention, notes, per-device `timestamps` map); `loadPage(slug)`, `savePage(slug, data)`, `loadPageBatch(slugs)` (batch load in offscreen); session `page:{slug}` cache managed by background via entity-cache.js; UI reads via `readCacheable('page:<slug>')`
- **History logs**: `data/logs/<device>/YYYY-MM-DD.jsonl` — event-sourced log files by device (source of truth); all visits and mutations appended here by offscreen drain
- **Dedup**: demand-loading `historyByUrl` Map keeps newest per URL (for lookups); `historyAllEntries` array keeps all entries (for date-boundary dedup rendering — one row per URL per calendar day)
- **Batch API**: `listHistoryFiles()` returns `.jsonl` filenames newest-first; `listHistoryFileSizes()` returns `{ filename: totalSize }` summed across devices (for chart estimation); `loadHistoryFiles(filenames)` reads and parses specific files
- **Offscreen actions**: `listHistoryFiles`, `loadHistoryBatch`, `loadPageBatch`, `pageExists`, `listListFiles`

### Settings Cache Architecture (Event-Sourced)
- **Source of truth**: log files (`data/logs/<device>/YYYY-MM-DD.jsonl`) — entity files are derived checkpoints
- **Hot cache**: `chrome.storage.session` — in-memory IPC, survives SW termination, cleared on browser restart; hydrated on every startup
- **Durable backup**: `chrome.storage.local['logBuffer']` — log buffer only; all other cache keys in session
- **Hydration**: `background.js` `hydrateCache()` — Phase 1: loads base entities from offscreen into session (including `list:system/root`); Phase 1.5: pre-loads page entities referenced by logBuffer from filesystem (so Phase 2 replay has them available); Phase 2: replays ALL `logBuffer` entries via `effectOf(entry, sessionLoad)` + `sessionWrite`
- **Unified read**: `utils.js` `readCacheable(key)` — session cache → `{ action: 'readCacheable', key }` background fallback. The `key` is an entity key (e.g., `'lists'`, `'list:system/orphaned'`, `'list:system/shallow-page'`, `'settings'`). Session cache stores entities under their entity keys and settings as a single `'settings'` object; background's `readFs` handles key→filesystem resolution. `loadSettingsValue(subKey, default)` reads `(await readCacheable('settings'))?.[subKey]` with a default value.
- **Write-through**: `utils.js` `saveSettingsValue(key, value)` sends `saveSettingsKey` to background, which calls `addLog` (append + `effectOf` session replay)
- **Hot-path reads**: background.js uses `readCacheable(key)` internally for `'settings'` (full object; sub-fields like workspace, urlBlacklist, titleTrimRules extracted by callers), `'lists'` (awaits hydrationDone, then session→readFs fallback); also exposed as `{ action: 'readCacheable', key }` message handler for UI pages. UI pages (popup.js, options.js) use `utils.js` `readCacheable(key)` — tries session locally, falls back to background message (access level: TRUSTED_AND_UNTRUSTED_CONTEXTS)
- **Entity LRU cache**: `entity-cache.js` caches entities in session as `page:{slug}` / `note:{slug}` keys (500 limit); `cacheGet`/`cacheSet`/`cacheRemove` with watermark-gated LRU eviction (only evicts entities with `max(timestamps) <= persistWatermark`); `setEntityCacheWatermark(ts)` called by background on offscreen persist; imported by background.js; checked on readCacheable, loadPageNotes, createNote/deleteNote
- **Log buffer**: background holds `logBuffer` array (lazy-loaded via `ensureLogBuffer()`), synced to `chrome.storage.local['logBuffer']`; offscreen drains via port `drainEntries`; all mutations via `addLog(entry)` — immutable, no dedup, serialized via `withLock('logBuffer')`
- **Unified replay path**: both `addLog` (runtime) and `hydrateCache` (startup) use `effectOf(entry, sessionLoad)` + `sessionWrite` — identical replay logic for all entity types

### Popup Blacklist Handling
- **Check**: if URL matches blacklist and no visit history, shows "Blacklisted" view
- **Capture once**: writes history entry + snapshot, then shows full dashboard

### Referrer Tracking (Parents & Children)
- **Capture**: `content.js` — includes `document.referrer` in visit message (all origins); `background.js` supplements via `webNavigation` API (`tabUrls`/`tabReferrers` Maps) for sites that strip `document.referrer` via Referrer-Policy
- **webNavigation fallback**: IIFE closure exposing `getReferrer(tabId)` — `onCommitted` (link transitions → record previous URL as referrer), `onCreatedNavigationTarget` (new-tab links → inherit source tab's URL); `tabs.onRemoved` cleans up
- **Pre-visit checkpoints**: background always ensures `page_checkpoint` for parent slug (referrer) BEFORE appending the page entry — deterministic log ordering; also checkpoints before capture
- **Log format**: visit entry stores `referrerId: 'page:<slug>'` (derived from referrer URL via `generateSlugFromUrl`); `entry.url` remains raw URL
- **Unified replay**: visit entry with `referrerId` affects both child page (`parentIds` accumulation with the referrerId) and parent page (`childIds` accumulation with `shallow:<entry.url>`) via `applyLogToPage` in `effectOf`; `addLog` in background replays against session cache, offscreen drain replays against filesystem
- **Page storage**: `page.parentIds` (typed ref array `['page:<slug>', ...]`, cap 50) — accumulated on visit entries with referrerId; `page.childIds` (typed ref array `['page:<slug>', 'note:<slug>', 'shallow:<url>', ...]`, cap 50) — accumulated when referrer slug matches parent page; `shallow:<url>` refs resolved to `page:<slug>` by replay.js `applyTo` post-loop when referenced page exists in scope
- **Shallow-page index**: `lists/system/shallow-page.json` — `{ timestamps, index: { url: { parents: ['page:<slug>'], lists: ['list:<id>'], title, user_title } } }` — tracks parents, list membership, and title for non-checkpointed pages; pruned when page becomes checkpointed (data absorbed into page entity)
- **Multi-day visits**: background detects multi-day visits (from cached page `visitDates` or logBuffer) and emits `page_checkpoint` before the visit
- **Focus panel / getPageRelations**: parents from `page.parentIds` (typed refs — `page:<slug>` resolved via `readCacheable`, `shallow:<url>` URL extracted directly), fallback to `shallowPageIndex.index[url]`; children from `page.childIds` (same resolution pattern)

### Explore View (Pure UI — No Backing Entity)
- **No entity**: Explore is a UI-only view with no `explore.json` or `list:system/explore` entity. No pins, no save.
- **Search**: multi-query search panel (same component as list view), queries stored in `chrome.storage.session` keyed `searchQueries:explore`
- **Pin button**: only visible in list views (`getActivePinListId()` returns `null` for explore)
- **Distinction**: Explore shows all history when no search queries active; lists show only pins

### Focus Panel (Centered Overlay)
- **DOM**: `options.html` — `#focusOverlay` with `#focusContent` (no visible frame)
- **CSS**: fixed fullscreen semi-transparent backdrop, flex center, max-width ~700px, hidden scrollbar; `.focus-section` with side-labels, `.focus-highlight` for focused page
- **Open**: `openFocusPanel(url, title)` — fetches `getPageRelations` from background, computes similar pages via `findRelatedPages`, renders waterfall using `resultRowHtml()` cards
- **Waterfall layout**: Parents → Focused Page (highlighted) → Children → Similar — each section has `.focus-section-label` on the left
- **Cards**: uses `resultRowHtml({ noFocusButton: true })` — same as page list, no custom markup
- **List focus**: `openListFocusPanel(listId, name)` — shows list as focused, pinned pages as children using `resultRowHtml()` cards
- **Delegation**: `bindFocusContentDelegation(content)` — binds result delegation + click-to-refocus on non-highlighted rows
- **Close**: backdrop click or Escape key

### Attention Tracking (content.js — Accumulated)
- **Scroll depth**: tracks max scroll percentage
- **Click count**: incremented on each click
- **Text selection**: records selected text > 10 chars
- **Intent extraction**: search params (q, query, s, etc.) + input fields
- **Time on page**: elapsed since script load
- **Accumulation**: all attention data tracked internally in content script; reported only on page leave (no periodic timer)
- **Initial visit**: `report(initialDelta)` on page load — sends page metadata (url, title, slug, referrer) without attention; ensures page appears in history immediately
- **Attention report**: `reportAttention()` on `visibilitychange` (hidden) / `freeze` / `beforeunload` — sends incremental attention with `isLeaving: true`, triggers `drainNow()` in background
- **Title changes**: tracked locally via MutationObserver; reported immediately via `report({ title })`

## Build & Test
- **Build WASM**: `npm run build` → `wasm-pack build --target web --out-dir extension/pkg`
- **Run tests**: `npm test` → `vitest run`
- **Test files**: `tests/utils.test.js`, `tests/search-helpers.test.js`, `tests/replay.test.js`, `tests/log-buffer.test.js`, `tests/persistence.test.js`, `tests/cache-staleness.test.js`, `tests/highlight-helpers.test.js`, `tests/virtual-scroller.test.js`, `tests/progressive-loading.test.js`, `tests/message-routing.test.js`, `tests/mutation-refresh.test.js`, `tests/referrer-focus.test.js`, `tests/attention-utils.test.js`, `tests/auto-blocks.test.js`, `tests/state-preservation.test.js`, `tests/read-cacheable.test.js`, `tests/sync-transport-github.test.js`, `tests/sync-manager.test.js`, `tests/logger.test.js`, `tests/downtime.test.js`, `tests/replay-properties.test.js` (property-based P1–P6)
- **Property test infrastructure**: `tests/arbitrary-events.mjs` — fast-check arbitraries generating random event sequences for all 22 action types; shared by Vitest and E2E property tests
- **E2E property tests**: `tests/e2e/property-invariants.spec.js` — generative E2E tests P7–P10 (sidebar list count, pin count, recycle bin, history ordering) using seeded PRNG scenarios
- **Replay verification**: `scripts/replay-verify.mjs` (`npm run replay:verify`) — replays full history from `data/logs/<device>/*.jsonl` subdirectories with per-device context, normalizes known data inconsistencies (pre-rename list names, null pin items, create_list ordering), writes replay output to `/tmp/portal-replay`, compares against disk checkpoints (pages, notes, lists, manifest entities), classifies diffs as schema-gap / timing-drift / data; `--verbose` shows all entities
- **Manual test browser**: `scripts/manual-test-browser.mjs` — launches Chromium with extension, seeds data, captures before/after state diff on close; `--seed` (3 pages), `--case <name>` (loads `seeds/<name>.mjs`); `tests/seed-builder.mjs` builds file arrays from event logs via replay
- **Seed cases**: `seeds/` (gitignored) — each `.mjs` file exports a default function returning `{ events, entities, deviceId, settings }`; run with `npm run manual:case <name>`

## Key Data Schemas

### History Entry (metadata in JSONL)
```json
{ "timestamp": 1234, "action": "page", "url": "https://...", "title": "...", "slug": "...", "referrerId": "page:parent-slug" }
```
Visit entries contain url/title/slug/referrerId (typed ref, always `page:<slug>`). Attention data (scrollDepth, timeOnPage) logged in separate page entries. Capture paths (mdPath, htmlPath) also in separate entries. Slugs use compact format: strip `www.` prefix and TLD from hostname.

### Note (in notes/{slug}.json — first-class entity)
```json
{ "slug": "note-slug", "excerpt": "selected text", "note": "user annotation", "cssPath": "body > ...", "url": "https://parent-page-url" }
{ "slug": "note-slug", "excerpt": ["chunk1", "chunk2"], "note": "", "cssPath": "body > ...", "url": "https://parent-page-url" }
```
`excerpt` is `string` (same-block selection), `string[]` (cross-block chunks), or `null` (global page note). `note` is the user annotation text. `url` is the parent page URL (replaces old `parentIds`/`childIds`). No `timestamps` — note files are immutable.

### List (in lists/{listId}.json — self-describing entity)
```json
{ "slug": "uuid", "timestamps": { "deviceId": 1234 }, "name": "Rust Lang", "owner": "deviceId", "pins": [{ "id": "page:slug", "pinnedAt": 1234 }] }
```
Pin `id` is a typed reference: `page:<slug>` for checkpointed pages.

### Orphaned list (in manifest/orphaned.json)
```json
{ "timestamps": { "deviceId": 1234 }, "entries": [{ "key": "note:slug", "url": "https://..." }] }
```

### Page (in pages/{slug}.json — selective checkpoint)
```json
{ "slug": "...", "timestamps": { "deviceId": 1234 }, "url": "...", "title": "...", "parentIds": ["page:parent-slug", ...], "childIds": ["note:child-slug", "page:child-slug", ...], "visitDates": [20240115, 20240116], "scrollDepth": 0.75, "timeOnPage": 45000 }
```
Only checkpointed for pages with: rich data (notes/snapshots/reports), multi-day visits (2+), or explicit `page_checkpoint`. `parentIds` and `childIds` are typed ref arrays (cap 50 each): `page:<slug>` for checkpointed pages, `note:<slug>` for notes, `shallow:<url>` for non-checkpointed pages. `shallow:<url>` refs are resolved to `page:<slug>` by replay.js when the referenced page becomes checkpointed.

### Log buffer entries (chrome.storage.local['logBuffer'])
```jsonl
// Page visit (referrerId is typed ref, always page:<slug>)
{"timestamp":1234,"action":"page","url":"...","title":"...","referrerId":"page:parent-slug"}
// Page attention report (on page close / 1h timer)
{"timestamp":1234,"action":"page","url":"...","scrollDepth":0.75,"timeOnPage":45000}
// Page capture (files written first, then logged)
{"timestamp":1234,"action":"page","url":"...","mdPath":"...","htmlPath":"..."}
// Page checkpoint (ensures page entity exists for selective checkpointing)
{"timestamp":1234,"action":"page_checkpoint","url":"...","title":"..."}
// Settings mutation
{"timestamp":1234,"action":"set","key":"workspace","value":{...}}
// Note create (lean — content on disk, only wires parent childIds)
{"timestamp":1234,"action":"note","slug":"note-slug","parentIds":["page:parent-slug"]}
// Note delete (unlinks from parent childIds + adds to orphaned)
{"timestamp":1234,"action":"del_note","slug":"note-slug","parentIds":["page:parent-slug"]}
// List pins (granular operations, ids are typed refs)
{"timestamp":1234,"action":"list","id":"uuid","op":"add","ids":["page:slug","shallow:https://..."]}
{"timestamp":1234,"action":"list","id":"uuid","op":"del","ids":["page:slug"]}
{"timestamp":1234,"action":"list","id":"uuid","op":"clear","ids":[]}
// List metadata
{"timestamp":1234,"action":"list_meta","id":"uuid","name":"..."}
// List delete
{"timestamp":1234,"action":"del_list","id":"uuid"}
```

### Settings (settings.json — derived checkpoint, config-only)
```json
{
  "timestamps": { "deviceId": 1234 },
  "workspace": { "mode": "default", "listIds": [], "autoSnapshot": false },
  "urlBlacklist": ["chrome://", "edge://"],
  "titleTrimRules": []
}
```
Dynamic key-value store: each `set` log entry adds/overwrites a key. Lists and orphaned tracking are in their own entity files.

### Import Bookmarks
- **Entry**: Settings modal section in `options.html` (file input + tri-state folder tree picker + import button)
- **Parser**: `bookmark-parser.js` `parseBookmarkHtml(html)` — parses Netscape Bookmark Format HTML (exported from Chrome/Firefox/Edge) into a folder tree with `bookmarks[]`, `skipped[]`, `children[]`, and recursive `bookmarkCount`. Strips `<p>` tags before DOMParser; filters to http(s) URLs only.
- **UI**: `options.js` — file change handler → dynamic import of parser → `renderBookmarkTree()` with collapsible rows (depth 0 expanded, deeper collapsed), tri-state native checkboxes (check parent → check all descendants; uncheck child → parent indeterminate), folder counts badge. "Import Selected" button disabled until selection.
- **Handler**: `background.js` `chrome.runtime.onConnect` listener for port name `import-bookmarks` — receives selected folder tree, creates timestamped parent list `"Imported Bookmarks (…)"`, recursively creates child lists via `addLog(create_list)` with `parentListId`, pins bookmark URLs via `addLog(pin_to_list)` with `titles` map. Streams progress via port messages (`type: 'progress'|'done'|'error'`). Aborts on list creation failure; tolerates up to 20 bookmark failures; reports skipped URLs in failure list.
- **Tests**: `tests/bookmark-parser.test.js` (13 unit tests — parser edge cases), `tests/e2e/import-bookmarks.spec.js` (6 E2E tests — tree rendering, tri-state, collapse, import flow, nested lists, failures).
