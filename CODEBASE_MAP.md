# Portal Extension — Codebase Map

> Auto-generated reference. When functionality is added/changed, update this file.

## File Index

| File | Lines | Role |
|------|-------|------|
| `extension/manifest.json` | 72 | MV3 manifest: permissions (incl. scripting, webNavigation), commands (Alt+S, Alt+H, Alt+L), CSP for WASM, content-fontface.js (document_start, all_frames), web_accessible_resources for fontface-intercept |
| `extension/background.js` | ~1442 | Service worker: central authority — handles ALL actions, `addLog(entry)` (appends to logBuffer + replays via `effectOf` + `sessionLoad`/`sessionWrite`), port channel to offscreen, unified `hydrateCache()` (loads base entities from offscreen then replays logBuffer via `effectOf`), `readCacheable(key)`/`readFs(key)` (session→filesystem fallback for all cacheable keys — awaits hydrationDone, batch-loads settings, applies listOrder), gateway registry, referrer tracking (webNavigation closure: `getReferrer(tabId)`, always emits page_checkpoint for referrer pages, stores `referrerId: 'page:<slug>'` in log entries), multi-day checkpoint detection, page relations (parentIds/childIds from page entity + shallowPageIndex fallback, resolves typed refs `page:<slug>`/`shallow:<url>`), keyboard commands, `captureAndLog(tabId, slug, timestamp, url, title)` (checkpoints page before capture), `ensureCheckpointIfMissing(slug, url, title)` (module-level helper), `replayBufferOver(page)` (replays logBuffer over a filesystem page entity), `setEntityCacheWatermark` on offscreen persist |
| `extension/savepage-bridge.js` | ~170 | Save Page WE integration: `initSavepageBridge()` (registers `type`-based onMessage listener), `captureSavePage(tabId)` (injects SPWE scripts, returns Promise\<html\>), `loadSavepageResource()` (internal) — only Chrome APIs |
| `extension/entity-cache.js` | ~40 | Entity LRU cache: `getCachedEntity(key)`, `setCachedEntity(key, entity)` — wraps `chrome.storage.session` with 500-entry LRU; `setEntityCacheWatermark(ts)` gates eviction to only flush entities with `timestamp <= persistWatermark` |
| `extension/replay.js` | ~585 | Shared pure replay: unified interface `effectOf(entry, load)` → `scopeOf` + `applyTo`; `SHALLOW_PREFIX = 'shallow:'`; `defaultEntity(key)` creates empty entities; per-entity: `applyLogToPage` (action='page' with parentIds/childIds accumulation using typed refs `page:<slug>`/`shallow:<url>`, visitDates, attention, capture fields; action='page_checkpoint'), `applyLogToNote` (action='note' with excerpt/note/cssPath/parentIds/childIds), `applyLogToSettings`, `applyLogToPins` (list add/del/clear using `entry.ids` with typed refs, list_meta, del_list; pin format `{id, pinnedAt}`), `applyLogToRecycleBin`, `applyLogToDeletes`, `applyLogToShallowPage` (tracks parents/lists/title for non-checkpointed URLs); `applyTo` post-loop: wires note parentIds into page childIds, absorbs shallow-page index data into newly-checkpointed pages, resolves `shallow:<url>` refs to `page:<slug>` when referenced page exists in scope, prunes shallow-page entries for checkpointed pages; entity key namespaces: `page:{slug}`, `note:{slug}`, `settings`, `list:{id}`, `list:system/recycle-bin`, `list:system/permanent-deletes`, `list:system/shallow-page` |
| `extension/offscreen.js` | ~495 | Offscreen doc: port-only FS I/O worker — drains logBuffer via round-cache + sequential `effectOf(entry, load)` replay (load closure over roundCache + filesystem), flushes dirty entities to disk (pure save, no post-processing — resolution/pruning done in replay.js applyTo), appends to history JSONL, per-file locks; routes `list:system/shallow-page` to `lists/system/shallow-page.json` |
| `extension/offscreen.html` | 10 | Minimal host for offscreen.js (module script) |
| `extension/filesystem-storage.js` | ~1157 | `FileSystemStorage` class: `#permissionGranted` cache, `#dirCache`/`#fileCache` Maps, `resolveDir(path)`, `resolveFile(path, {create})`, `readJson(handle)`, `writeJson(handle, data)`, `clearCache()`, `pageExists(slug)`, `checkMultiDayVisits(slugs, days)` (scans JSONL for multi-day visitors), `loadShallowPageIndex()` (from `lists/system/shallow-page.json`); all File System Access API operations, settings.json, gateway persistence, per-list pin loading; entity methods return wrapped `{timestamp, ...}` format |
| `extension/content.js` | ~950 | Content script: accumulated attention tracking (1h timer + page close), highlight system (save-on-close for notes), markdown extraction (HTML capture moved to Save Page WE) |
| `extension/savepage/content.js` | ~4300 | Adapted Save Page WE v33.9 — self-contained HTML capture with data URIs for all resources |
| `extension/savepage/content-frame.js` | 286 | SPWE frame handler (upstream, unchanged) |
| `extension/savepage/content-fontface.js` | 57 | SPWE font-face intercept loader (path updated for savepage/ subdir) |
| `extension/savepage/content-fontface-intercept.js` | 74 | SPWE font-face intercept script (upstream, unchanged) |
| `extension/savepage/shadowloader.js` | 69 | SPWE shadow DOM loader (upstream, unchanged) |
| `extension/popup.js` | ~804 | Popup: per-page dashboard (title, snapshots, notes, lists, workspace); pin operations use typed ids (`page:<slug>`, `shallow:<url>`) |
| `extension/popup.html` | ~630 | Popup HTML + all popup CSS (inline) |
| `extension/options.js` | ~4325 | Options page: sidebar nav, explore view (landing page, block-based queries with auto-blocks), lists, settings modal; Rust-side parallel WASM search (searchBatch), lazy list pins, page read cache, event delegation, focus panel (centered overlay with resultRowHtml cards), explore-pin + focus buttons on every row; date-boundary dedup rendering (historyAllEntries), `enrichFromEntityStorage(entries)` batch title enrichment via `loadPageBatch`, ensureCheckpoint on portal-open; `slugFromPinId(id)` for cache-key derivation, `resolvePageRef(refId, pageSnap, spi)` unified typed-ref resolution (page entity or shallow-page index metadata) |
| `extension/virtual-scroller.js` | ~260 | `VirtualScroller` class: viewport-only rendering, `appendData`/`removeItems`/`applyFilter`, `onLoadMore` callback, saved-node restoration — DOM APIs only via constructor |
| `extension/related-scoring.js` | ~90 | `findRelatedPages(seeds, candidates, poolLimit)` — pure: pool-based scoring with hostname/title/temporal/intent weights; internal: `STOP_WORDS`, `titleWords`, `jaccardSimilarity`, `scoreTemporalProximity`, `prepareSeed`, `scorePair` |
| `extension/attention-utils.js` | ~50 | Pure attention functions: `parseAttention(interaction)`, `attentionStrength(att)`, `attentionColor(normalizedScore)`, `aggregateAttention(interactions)` |
| `extension/time-chart.js` | ~180 | Chart rendering + interaction: `initCharts()`, `renderAttentionChart(interactions)`, `renderAttentionChartInto(chartEl, barsEl, interactions, label)`, `bindChartBarClick(chartEl, resultsContainer)`, `syncChartHighlights()`, `applyDateFilter(chartEl, resultsContainer)` — imports attention-utils.js |
| `extension/highlight-helpers.js` | ~240 | Highlight/note utility functions: excerpt extraction, note rendering, highlight matching |
| `extension/qb-tree.js` | ~80 | Pure QB tree: `qbCreatePredicate`, `qbCreateOperator`, `qbCreatePlaceholder(defaultFields)`, `qbFindNode`, `qbCollapseTree`, `qbFlattenSameOp`, `qbToTree`, `qbFlatten` — module-scoped `qbNodeIdCounter` |
| `extension/options.html` | ~2300 | Options HTML + all options CSS (inline), focus overlay (centered), explore badge, explore block CSS |
| `extension/utils.js` | ~100 | `generateSlugFromUrl(url)` (compact: strips www/TLD), `loadSettingsValue(key, default)` (reads session cache), `saveSettingsValue(key, value)` (sends saveSettingsKey to background) |
| `extension/search-helpers.js` | ~70 | `extractInteractionBuffer`, `mergeBufferIntoInteractions`, `getBufferContentMap`, `buildInteractionsForEngine` — pure helpers for flat log entries |
| `src/lib.rs` | ~336 | WASM: `Interaction` struct, `InteractionData` (JSONL deser), `SearchResult`, `SearchEngine` with 5 ranking algorithms, `searchBatch` async fn (File System Access API bindings, reads JSONL + content directly, parallel search) |
| `Cargo.toml` | 23 | Rust deps: wasm-bindgen, wasm-bindgen-futures, serde, js-sys, web-sys (console only) |
| `tests/utils.test.js` | 42 | Vitest: slug generation tests |
| `tests/replay.test.js` | ~1377 | Vitest: 138 tests for replay.js — unified interface (effectOf, scopeOf, applyTo, defaultEntity), per-entity (settings, page parentIds/childIds/visitDates/capture/page_checkpoint/attention with typed refs, note creation/parentIds/childIds, pins with `{id, pinnedAt}` format and `entry.ids`, recycleBin, deletes, shallowPage index tracking parents/lists/title); idempotency + sequence replay; entity storage title resolution (last-write-wins, buffer replay, user_title); shallow→checkpointed absorption and pruning |
| `tests/log-buffer.test.js` | ~160 | Vitest: 10 tests for background.js log buffer — appendLog, appendVisit, watermark pruning, SW restart recovery, mixed entry types |
| `tests/search-helpers.test.js` | 144 | Vitest: merge + engine-builder tests (flat log entry format) |
| `tests/persistence.test.js` | ~410 | Vitest: settings round-trip, gateway incremental processing, list pins (wrapped entity format) |
| `tests/referrer-focus.test.js` | ~55 | Vitest: static analysis — webNavigation permission, onCommitted listener, getReferrer closure, focus panel parent title delegation to makeCard |
| `tests/message-routing.test.js` | 49 | Vitest: static analysis — every action sent by options/popup has a case handler in background.js |
| `tests/read-cacheable.test.js` | ~200 | Vitest: structural + behavioral tests for readCacheable/readFs — session hit, FS fallback, settings batch-load, list ordering, hydrationDone blocking, offscreen field mismatch, options.js gateway fallback |
| `tests/mutation-refresh.test.js` | ~105 | Vitest: static analysis — mutation listener + visibilitychange handler refresh all view types, not just category |
| `vitest.config.js` | 7 | Test config |
| `package.json` | 25 | Build: `wasm-pack`, test: `vitest` |

## Message Routing

### Architecture: Background-centric (single entry point)
All `chrome.runtime.sendMessage` from popup/options/content go to background.
Background handles ALL actions in its `onMessage` listener (line ~646).
Offscreen is port-only — responds via `chrome.runtime.connect({ name: 'bg-offscreen' })`.

### background.js handles ALL actions (line ~646):
**Tab-dependent:** `getPageInfo` (entity storage: session cache → filesystem + buffer replay; null for shallow pages), `captureCurrentPageFromPopup`, `hydrateCache`, `reportPage`
**Pure reads (relay to offscreen via port, cache pages):** `loadSettings`, `loadInteractionByUrl`, `loadPageBatch`, `loadPageNotes`, `loadAllNotes`, `loadListPins`, `loadListPinsById`, `loadGateways`, `listSnapshots`, `getDirectoryInfo`, `getSnapshotUrl`, `listInteractionFiles`, `loadInteractionBatch`
**Cacheable reads (via `readCacheable` — session→filesystem fallback):** `getLists`, `getRecycleBin`, `loadPermanentDeletes`, `getGatewayDomains`
**Page relations:** `getPageRelations` (returns parents {referrers resolved from `page.parentIds` typed refs + shallowPageIndex fallback, lists} + children {resolved from `page.childIds` typed refs — `page:<slug>` via loadPageBatch, `shallow:<url>` extracted directly})
**Writes (all via `addLog` — append + effectOf session replay):** `saveSettings`, `saveSettingsKey`, `createNote`, `deleteNote`, `updateNote`, `saveListPinsById`, `saveListMeta`, `deleteList`, `saveRecycleBin`, `savePermanentDeletes`
**Pass-through (complex FS ops via port):** `saveListPins` (orphan cleanup), `deleteSnapshot`, `initializeFilesystem`
**Buffer management:** `clearWriteQueue`, `flushLogBuffer`

### offscreen.js handles via port (line ~68):
Same read actions as before + `saveListPins` + `loadListPinsById` + `loadAllListMetadata` + `loadRecycleBin` + `pageExists` + `listListFiles` + `saveJson` (direct saves) + `loadShallowPageIndex` + log buffer drain via port `drainEntries` messages (appends to history JSONL + checkpoints entities via replay.js, handles list_meta/del_list/recycle_replace, checkpoints shallow-page index, piggybacks gateway saves)

### content.js handles (line ~875):
`extractMarkdown`, `highlightSelection`, `removeHighlightMark`, `showCaptureNotification`, `showLikeNotification`

### Save Page WE messages (savepage-bridge.js, `type` field — separate from `action` field):
`scriptLoaded`, `setDelay`, `requestFrames`, `replyFrame`, `loadResource`, `stateChanged`, `savepageDone`, `saveExit`

### background.js commands (line ~602):
`capture-snapshot` (Alt+S), `highlight-selection` (Alt+H), `like-page` (Alt+L)

## Feature → Code Map

### Page Visit Tracking (Event-Sourced)
- **Entry**: `content.js` — unified `report(delta)` sends `reportPage` to background; initial load (title, slug, referrer, `isInitialLoad`), periodic attention (title, scrollDepth, timeOnPage every 5s), title-only on mutation, `isLeaving` on visibility hidden / freeze / beforeunload
- **Background handler**: `background.js` `reportPage` → `processPageReport(delta)` trims title, diffs all fields against cached entity, logs only changes; `isInitialLoad` triggers referrer tracking + checkpoints + gateway update + workspace auto-pin/snapshot; `isLeaving` triggers `drainNow()`
- **Blacklist check**: skips URLs matching `urlBlacklist` prefixes (unless already in DB)
- **Title trimming**: applies `titleTrimRules` (remove_after_pipe, remove_brackets, remove_parens)
- **Log buffer**: background holds `logBuffer` array (lazy-loaded from `chrome.storage.local['logBuffer']` via `ensureLogBuffer()`); all mutations via `addLog(entry)` which appends to buffer AND replays against session cache via `effectOf(entry, sessionLoad)` + `sessionWrite(effects)` — serialized via `withLock('logBuffer')`
- **Log entry format**: all entries have `action` field — `page` (visit + attention + capture: `{timestamp, action:'page', url, title?, referrerId?: 'page:<slug>', scrollDepth?, timeOnPage?, mdPath?, htmlPath?}`), `page_checkpoint` (ensures page entity exists), `set`, `note` (create/update note entity: `parentIds`, `childIds`), `list` (op: add/del/clear, `ids: ['page:<slug>', 'shallow:<url>', ...]`), `list_meta`, `del_list`
- **Drain**: offscreen receives `drainEntries` via port, replays sequentially via `effectOf(entry, load)` with round-cache over filesystem, flushes dirty entities to disk, appends to `history/YYYY-MM-DD.jsonl`; sends `{ action: 'persisted', watermark }` back to background for pruning
- **Per-file locks**: background serializes all cache updates via `withLock('logBuffer')` inside `addLog`; offscreen keeps per-file locks for checkpoint writes and read operations
- **Note ops**: `createNote`/`deleteNote`/`updateNote` in background — `ensureCheckpointIfMissing` ensures parent page exists, then `addLog` replays via `effectOf`; notes are first-class entities with `note:{slug}` keys; log entries use `parentIds`/`childIds` with typed refs
- **Hydration replay**: `hydrateCache()` loads base entities from offscreen into session cache, then replays ALL pending `logBuffer` entries via `effectOf(entry, sessionLoad)` + `sessionWrite` — same replay path as `addLog`

### Snapshot Capture
- **Keyboard shortcut**: Alt+S → background `captureSavePage(tabId)` (injects SPWE scripts → gets self-contained HTML) + content `extractMarkdown` (parallel)
- **Popup button**: popup → background `captureCurrentPageFromPopup` → same parallel flow
- **HTML capture**: Save Page WE engine — converts all resources (images, fonts, CSS) to data URIs → truly self-contained HTML; `savepage-bridge.js` injects `savepage/content-frame.js` (all frames) then `savepage/content.js` (main), content sends `savepageDone` with HTML, `captureSavePage` resolves Promise
- **Markdown extraction**: `content.js` `extractMarkdown()` (10KB cap) — lightweight DOM-to-markdown conversion
- **Background resource fetch**: `savepage-bridge.js` `loadSavepageResource()` (internal) — background fetches CORS resources for SPWE via `loadResource` message (10s timeout, 50MB size cap)
- **Filesystem write**: `filesystem-storage.js` `captureSnapshot(slug, ts, md, html)` → `pages/{slug}/{ts}.md|.html`
- **Two-phase capture log**: after offscreen writes files, background calls `addLog({ action: 'page', url, mdPath, htmlPath })` — large content never in log buffer
- **Auto-snapshot**: workspace mode with `autoSnapshot` flag

### Highlight / Note System
- **Create note**: Alt+H with text selected → content.js → background `createNote` (ensureCheckpointIfMissing + addLog)
- **Cross-node support**: `getClosestBlock()` determines if selection is same-block (inline spans) vs cross-block (divs, lis); same-block uses `extractContents` via `wrapRangeWithMark()`; cross-block uses `splitSelectionByBlock()` to create per-block chunks
- **Data model**: note entity with `excerpt` (string | string[]) + `note` (annotation text); `excerpt` is single string for same-block, array of trimmed chunks for cross-block; `excerpt: null` for global page notes
- **Global page note**: Alt+H with no selection → `showGlobalNoteOverlay()`
- **Overlay UI**: Shadow DOM for style isolation; matches highlight by timestamp (primary), falls back to text
- **Visual marks**: wraps text in `<mark class="portal-highlight">`; grouped marks share `data-highlight-timestamp`; delete unwraps all marks in group
- **Reapply on load**: reads notes via `loadPageNotes`; normalizes excerpt to array, highlights each chunk via `findTextRange()` cross-node search
- **Storage**: note entities in `notes/{slug}.json`; notes linked to parent pages via `page.childIds` containing `note:{slug}` keys

### Search & Ranking (WASM)
- **Engine**: `src/lib.rs` — `SearchEngine` with 5 algorithms; returns `SearchResult` with `score` field
- **Content scoring**: title(2.0), content(1.0), intent(1.5)
- **Pipelined search**: `options.js` `pipelinedSearch(query)` — Rust-side parallel: gets directoryHandle from fsStorage, fans out `searchBatch(historyDir, pagesDir, query, chunk)` calls via Promise.all (10 files per chunk); WASM reads JSONL + content files directly, returns scored results; write buffer searched inline via JS SearchEngine
- **searchBatch (WASM)**: `src/lib.rs` — async fn that takes `FileSystemDirectoryHandle` refs for history/ and pages/, reads JSONL files, deduplicates by URL, reads latest .md content per slug, builds SearchEngine and returns results
- **Demand-loaded history**: `initHistoryFiles()` lists JSONL files; `loadHistoryBatch()` loads 10 files at a time into `historyByUrl` Map (capped at 100 files); `showCategory()` triggers first batch, VirtualScroller `onLoadMore` triggers subsequent batches on scroll
- **No global cachedData**: history view uses `historyByUrl` Map; search uses self-loading `pipelinedSearch`; lists use pages + `pipelinedSearch`; explore uses `evaluateQueryStream`
- **Captures match cache**: `capturesMatchCache` pre-computed via `precomputeCapturesMatches()` before QB tree evaluation
- **Sort**: column headers (Title, Last Visit, Att) replace old ranking/sort pills; click cycles none→desc→asc→none
- **Extra columns**: "+" button popover toggles First Visit (all views) and Pin Time (pinned section only)
- **Data prep**: `search-helpers.js` `buildInteractionsForEngine()` — converts raw data to WASM Interaction objects (no `id` field)
- **Buffer merge**: `search-helpers.js` `mergeBufferIntoInteractions()` — dedup by URL, sort by timestamp; `getBufferContentMap()` extracts buffer content separately

### Lists (Pinned Searches) — formerly "Collections" / "Topics"
- **Storage**: Self-describing files `lists/{id}.json` — each file contains `{id, timestamp, name, qbTrees: [...], pins: [{id, pinnedAt}, ...]}`. Pin `id` is typed ref (`page:<slug>` or `shallow:<url>`). Ordering in `settings.json` key `listOrder` (array of UUIDs). Session cache `lists` array hydrated from files by background.
- **Display name**: `listDisplayName(list)` → `name || query`; `name` always present in self-describing files
- **Create/update**: `options.js` sends `saveListMeta` message to background (which updates session cache + appends `list_meta` log entry); ordering via `saveSettingsValue('listOrder', ...)`
- **Delete**: `options.js` sends `deleteList` message to background (which removes from session cache + listOrder + appends `del_list` log entry; offscreen drain deletes the file)
- **ID format**: `crypto.randomUUID()` for new lists (existing ones migrated from timestamp-based IDs)
- **Sidebar**: `options.js` `renderLists()` — sidebar items with drag-drop support (pin-drop for result rows + drag-to-reorder lists via `application/x-list-reorder` MIME type)
- **Pin search**: `options.js` `pinCurrentSearch()` — enters naming mode (editable title input), then creates list
- **Title editing**: `options.js` `enterTitleEditMode()` — inline edit with confirm/cancel; used for pin naming and double-click rename
- **List view**: `options.js` `showList()` — pinned section (no chart, no related), Explore section with interactive query builder; double-click title to rename
- **Related pages scoring**: `related-scoring.js` `findRelatedPages(seeds, candidates, poolLimit)` — pool-based: processes seeds iteratively, fills shared pool up to configurable limit (default 50, settings `relatedPagesLimit`); weights: hostname 0.30, title 0.30, temporal 0.25, intent 0.15; imported by options.js (used by explore auto-blocks)
- **List explore**: `options.js` `renderListExplore()` — builds auto-blocks from list pins (children/parents/similar) + saved qbTrees as manual blocks, uses same block-based UI as Explore
- **QB context-aware**: `renderQueryBuilder()`/`debouncedRunQuery()` detect explore/list views and redirect to `renderExploreBlocks()`/`runExploreBlockQuery()`; `saveExploreQbState()`/`restoreExploreQbState()` swap global qbRoot on view transitions
- **Popup list chips**: `popup.js` `renderListChips()` — shows top 5 most-recently-active lists as chips, `+` button opens search/create picker dropdown (`openListPicker()`)
- **Popup list picker**: `popup.js` `openListPicker()` — dropdown with search input, filtered rows with checkmarks, create option for new names; `toggleListPin()`, `createListAndPin()` helpers

### Explore View — Composable Query Builder
- **Explore button**: sidebar top, opens explore view (landing page — replaces History)
- **Landing page**: always shows list layout with block-based query UI (add-block button); when no blocks enabled, shows entire history with demand-loading
- **Query builder**: always tree mode (n-ary tree with AND/OR), no Normal/Pro toggle
- **N-ary operators**: `{ type:'operator', op:'OR'|'AND', children:[...] }` — supports any number of children
- **Alternating structure**: inserting different-op wraps with 2 levels (e.g. "*" inside OR → AND(OR(leaf, ph)))
- **Predicate types**: keyword (field + text), smartFilter (gateways), range (field + op + value)
- **Tree mode**: n-ary tree visualization, depth-based buttons: d0=both, d1-2=opposite, d3=same, d4+=none
- **Tree ops**: `qbInsertOnEdge` (same=sibling, diff=2-level wrap), `qbRemoveLeaf` (cascade collapse), `qbCollapseTree`, `qbFlattenSameOp`
- **Evaluation**: `evaluateNode(node, item)` recursively evaluates tree (children.some/every); `computeRelevance()` scores keyword matches
- **Enrichment**: `enrichSingle(item, notesMap)` enriches a single interaction for QB evaluation; `evaluateQueryStream(qbTree)` streams through all JSONL files batch-by-batch, enriching and evaluating each entry
- **Lazy notes**: `loadAllNotes` batch loads all notes on first keyword-notes query
- **List persistence**: `pinCurrentSearch()` deep-clones qbTrees; `showList()` evaluates saved qbTrees
- **Entry**: `options.js` `showExplore()` — lazy-loads explore pins if missing from cache, landing page (all history if no pins, block-based queries if pins exist)
- **State**: `qbRoot` (n-ary tree), `exploreBlocks` (array of query blocks), `exploreBlockIdCounter`, `activeBlockId`, `cachedAllNotes`

### Explore Block-Based Queries
- **Data model**: `exploreBlocks = [{ id, type: 'auto'|'manual', label, enabled, tree, urlSet }]`
- **Auto-blocks**: generated by `buildExploreAutoBlocks(pins)` from explore pins:
  - "Children of pins": from each pin's `page.childIds` typed refs — `page:<slug>` resolved via `loadPageBatch`, `shallow:<url>` resolved via `shallowPageIndex`
  - "Parents of pins": from each pin's `page.parentIds` typed refs — same resolution pattern
  - "Similar to pins": URLs from `findRelatedPages()` with pins as seeds
- **Manual blocks**: user-added, each with its own QB tree; edited via `renderQueryBuilder()` scoped per-block
- **Rendering**: `renderExploreBlocks()` — block list with toggle (blue=enabled, gray=disabled), label, count badge, remove button; manual blocks show QB tree
- **Events**: `bindExploreBlockEvents()` — toggle on/off, remove block, add new manual block, QB tree events scoped per-block (capture-phase listeners swap `qbRoot` to block's tree)
- **Evaluation**: `runExploreBlockQuery()` — works for both explore and list views; ORs all enabled blocks (auto-blocks use `urlSet`, manual blocks use `evaluateQueryStream`), deduplicates, displays merged results; auto-saves list qbTrees from saved query blocks
- **QB scoping**: when editing manual block QB, `qbRoot` is swapped to `block.tree`; on QB change, mutated tree is copied back; `debouncedRunQuery()` detects explore context and calls `runExploreBlockQuery()`

### Workspace / Private Mode
- **State**: `settings.json` key `workspace` `{mode: 'default'|'workspace'|'private', listIds, autoSnapshot}`; cached in chrome.storage.session
- **Popup UI**: three-way toggle (Workspace / default / Private), list chips, auto-snapshot checkbox (no ignore-gateways)
- **Private mode guards**: content.js (init gate skips all tracking), background.js (reportPage handler, commands), popup.js (toggle-only view)
- **Auto-pin**: on page visit, auto-pins to workspace lists (mode=workspace only)
- **Auto-snapshot**: if workspace.autoSnapshot, captures snapshot on visit

### Gateway Domain Registry
- **Persistence**: `gateways.json` at root — `{ watermark, domains: { [origin]: { rootUrl, childCount, fetched } } }`
- **Cache**: `chrome.storage.session['gatewayDomains']` — `{ [origin]: { rootUrl, childCount, fetched } }`
- **Incremental processing**: `filesystem-storage.js` `processGatewaysAfterWatermark(watermark, existingDomains)` — only scans JSONL entries after watermark
- **Hydration**: `background.js` `hydrateCache()` — loads `gateways.json`, incrementally processes new entries, saves updated watermark
- **Drain piggyback**: `offscreen.js` `drainQueue()` — after successful drain, saves current gatewayDomains to `gateways.json` with watermark = max drained timestamp
- **Registry update**: `background.js` `updateGatewayRegistry()` — increments `childCount` (no childUrls array); auto-promotes when `childCount >= 2`
- **Options cache**: `options.js` `gatewayDomainsCache` — loaded via `loadGatewayDomains()` on init (session cache → `getGatewayDomains` background fallback)
- **Gateway filter**: `options.js` `isGatewayUrl()` — root URL with `childCount >= 2`

### Options Page Views
- **Category filters**: `options.js` `filterByCategory()` — today, week, highlighted, gateways, recycleBin
- **Explore view**: `options.js` `showExplore()` — landing page; always shows list layout with block-based query UI and add-block button; if pins exist: pinned section + auto-blocks (children/parents/similar); when no blocks enabled: shows entire history with demand-loading; explore badge shows pin count
- **List view**: `options.js` `showList()` — lazy-loads pins per-list (cached in `allListPins`), renders from cached pin fields + session page cache (no blocking I/O), fire-and-forget `refreshListPages()` updates page cache + pin file in background; pinned section (no chart/related), column header sort
- **Virtual scrolling**: `virtual-scroller.js` `VirtualScroller` class — viewport-only rendering (~50-80 DOM nodes at any time); `appendData(newItems)` for demand-loading (items pre-sorted before append), `onLoadMore` callback triggers near end of data; imported by options.js, instances for global results and list explore
- **Event delegation**: `bindResultDelegation(container)` — single container-level click/dblclick/dragstart handler, replaces per-row listeners; dragstart collects all `.selected` rows for multi-drag
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
Recycle Bin (3)       ← data-category="recycleBin"
─────────────────────
Lists                 ← section label
  My List 1           ← pinned searches
  My List 2
  "Pin a search..."   ← empty state
```

### Recycle Bin
- **Storage**: `lists/system/recycle-bin.json` — `{timestamp, items: [{key, title, deletedAt}]}` (key = `page:slug` or `note:slug`). Session cache `recycleBin` hydrated from file by background.
- **Save**: `options.js` sends `saveRecycleBin` message to background (which updates session cache + appends `recycle_replace` log entry; offscreen drain writes the file)
- **Permanent delete**: adds key to `permanentDeletes` array
- **Delete available in**: all views (category, search, explore, list) except recycle bin view itself
- **Selection**: click, shift-click range, ctrl-click toggle
- **Marquee select**: drag from results background (gutter is now full-width behind floating result items)
- **Keyboard delete**: Del/Backspace on selected rows

### Settings (Modal in Options)
- **Storage location**: select/change directory, migrate data
- **Statistics**: total, today, pending buffer
- **URL blacklist**: add/remove prefix rules
- **Title trimming**: url prefix + action rules
- **Clear all data**: deletes all files in storage directory

### Filesystem Storage
- **Directory handle**: IndexedDB `PortalFS.handles` key `directory`
- **Permission**: `verifyPermission()` — cached via `#permissionGranted` (near-free after first grant, reset on `selectDirectory()` and `softDelete()`)
- **Handle cache**: `resolveDir(path)` caches directory handles with segment-level sharing; `resolveFile(path, {create})` caches file handles, evicts on error; `clearCache()` resets both + permission
- **JSON helpers**: `readJson(handle)` / `writeJson(handle, data)` — reduce boilerplate for R-M-W patterns
- **Metadata**: JSONL files `YYYY-MM-DD.jsonl` — one JSON line per interaction
- **Content**: `pages/{slug}/{timestamp}.md|.html` (versioned snapshots)
- **Legacy**: `pages/{slug}.md` flat files coexist via fallback reads
- **Notes**: `notes/{slug}.json` — per-note entity `{ slug, timestamp, excerpt, note, cssPath, parentIds, childIds }`; `loadPageNotes(pageSlug)` returns all notes whose parent is the given page
- **List files**: `lists/{listId}.json` — self-describing entity `{ id, timestamp, name, qbTrees: [...], pins: [{id, pinnedAt}, ...] }`; pin `id` is typed ref (`page:<slug>` or `shallow:<url>`); `loadListPinsById(id)` returns just pins, `loadListPinsEntity(id)` returns full entity; `saveListPinsById(id, pins, timestamp)` preserves metadata (read-merge-write); `saveListMeta(id, meta, timestamp)` preserves pins; `loadAllListMetadata()` scans all files; `deleteListFile(id)` removes file
- **Recycle bin**: `lists/system/recycle-bin.json` — `{ timestamp, items: [...] }`; `loadRecycleBin()` returns items, `loadRecycleBinEntity()` returns full entity, `saveRecycleBin(items, timestamp)` writes file
- **Permanent deletes**: `lists/system/permanent-deletes.json` — wrapped entity `{ timestamp, keys: [...] }`; `loadPermanentDeletes()` returns just keys, `loadPermanentDeletesEntity()` returns wrapped
- **Settings**: `settings.json` — derived checkpoint with `timestamp` watermark
- **Pages**: `pages/{slug}.json` — per-page metadata (attention, notes, `timestamp` watermark); `loadPage(slug)`, `savePage(slug, data)`, `loadPageBatch(slugs)` (batch load); session `page:{slug}` cache managed by background via entity-cache.js
- **History logs**: `history/YYYY-MM-DD.jsonl` — event-sourced log files (source of truth); all visits and mutations appended here by offscreen drain
- **Dedup**: `loadAllInteractions()` deduplicates by URL, last-write-wins; demand-loading `historyByUrl` Map keeps newest per URL (for lookups); `historyAllEntries` array keeps all entries (for date-boundary dedup rendering — one row per URL per calendar day)
- **Batch API**: `listInteractionFiles()` returns `.jsonl` filenames newest-first; `loadInteractionFiles(filenames)` reads and parses specific files
- **Offscreen actions**: `listInteractionFiles`, `loadInteractionBatch`, `loadPageBatch`, `pageExists`, `listListFiles`

### Settings Cache Architecture (Event-Sourced)
- **Source of truth**: log files (`history/YYYY-MM-DD.jsonl`) — entity files are derived checkpoints
- **Hot cache**: `chrome.storage.session` — in-memory IPC, survives SW termination, cleared on browser restart; hydrated on every startup
- **Durable backup**: `chrome.storage.local['logBuffer']` — log buffer only; all other cache keys in session
- **Hydration**: `background.js` `hydrateCache()` — Phase 1: loads base entities from offscreen into session; Phase 1.5: pre-loads page entities referenced by logBuffer from filesystem (so Phase 2 replay has them available); Phase 2: replays ALL `logBuffer` entries via `effectOf(entry, sessionLoad)` + `sessionWrite`; Phase 3: orders lists by `listOrder`; Phase 4: incremental gateway processing
- **Write-through**: `utils.js` `saveSettingsValue(key, value)` sends `saveSettingsKey` to background, which calls `addLog` (append + `effectOf` session replay)
- **Hot-path reads**: background.js uses `readCacheable(key)` for workspace, urlBlacklist, titleTrimRules, gatewayDomains, shallowPageIndex, lists, listOrder (awaits hydrationDone, then session→readFs fallback); popup.js/content.js/options.js read cached keys from session directly with sendMessage fallback (access level: TRUSTED_AND_UNTRUSTED_CONTEXTS)
- **Entity LRU cache**: `entity-cache.js` caches entities in session as `page:{slug}` / `note:{slug}` keys (500 limit); `getCachedEntity`/`setCachedEntity` with watermark-gated LRU eviction (only evicts entities with `timestamp <= persistWatermark`); `setEntityCacheWatermark(ts)` called by background on offscreen persist; imported by background.js; checked on loadPageBatch, loadPageNotes, createNote/deleteNote
- **Log buffer**: background holds `logBuffer` array (lazy-loaded via `ensureLogBuffer()`), synced to `chrome.storage.local['logBuffer']`; offscreen drains via port `drainEntries`; all mutations via `addLog(entry)` — immutable, no dedup, serialized via `withLock('logBuffer')`
- **Unified replay path**: both `addLog` (runtime) and `hydrateCache` (startup) use `effectOf(entry, sessionLoad)` + `sessionWrite` — identical replay logic for all entity types

### Popup Blacklist Handling
- **Check**: if URL matches blacklist and no visit history, shows "Blacklisted" view
- **Capture once**: writes interaction + snapshot, then shows full dashboard

### Referrer Tracking (Parents & Children)
- **Capture**: `content.js` — includes `document.referrer` in visit message (all origins); `background.js` supplements via `webNavigation` API (`tabUrls`/`tabReferrers` Maps) for sites that strip `document.referrer` via Referrer-Policy
- **webNavigation fallback**: IIFE closure exposing `getReferrer(tabId)` — `onCommitted` (link transitions → record previous URL as referrer), `onCreatedNavigationTarget` (new-tab links → inherit source tab's URL); `tabs.onRemoved` cleans up
- **Pre-visit checkpoints**: background always ensures `page_checkpoint` for parent slug (referrer) BEFORE appending the page entry — deterministic log ordering; also checkpoints before capture
- **Log format**: visit entry stores `referrerId: 'page:<slug>'` (derived from referrer URL via `generateSlugFromUrl`); `entry.url` remains raw URL
- **Unified replay**: visit entry with `referrerId` affects both child page (`parentIds` accumulation with the referrerId) and parent page (`childIds` accumulation with `shallow:<entry.url>`) via `applyLogToPage` in `effectOf`; `addLog` in background replays against session cache, offscreen drain replays against filesystem
- **Page storage**: `page.parentIds` (typed ref array `['page:<slug>', ...]`, cap 50) — accumulated on visit entries with referrerId; `page.childIds` (typed ref array `['page:<slug>', 'note:<slug>', 'shallow:<url>', ...]`, cap 50) — accumulated when referrer slug matches parent page; `shallow:<url>` refs resolved to `page:<slug>` by replay.js `applyTo` post-loop when referenced page exists in scope
- **Shallow-page index**: `lists/system/shallow-page.json` — `{ timestamp, index: { url: { parents: ['page:<slug>'], lists: ['list:<id>'], title, user_title } } }` — tracks parents, list membership, and title for non-checkpointed pages; pruned when page becomes checkpointed (data absorbed into page entity)
- **Multi-day visits**: background detects multi-day visits (from cached page `visitDates` or logBuffer) and emits `page_checkpoint` before the visit
- **Focus panel / getPageRelations**: parents from `page.parentIds` (typed refs — `page:<slug>` resolved via loadPageBatch, `shallow:<url>` URL extracted directly), fallback to `shallowPageIndex.index[url]`; children from `page.childIds` (same resolution pattern)

### Explore as Special List
- **List ID**: `EXPLORE_LIST_ID = 'explore'` — Explore is a regular list with a well-known ID
- **Storage**: `lists/user/explore.json` — same `[{id, pinnedAt}]` format as any list; uses `saveListPinsById`/`loadListPinsById`
- **Unified pin button**: one `.result-pin` button on all result rows; pins to active list (`getActivePinListId()` — Explore when in explore/other views, list ID when in list view)
- **Badge**: `updateExploreBadge()` reads `allListPins[EXPLORE_LIST_ID]`
- **Drag-to-explore**: drop result rows on Explore button to pin via `toggleResultPin(EXPLORE_LIST_ID, ...)`
- **Distinction**: Explore shows all history when no blocks enabled; lists show empty state instead

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
- **Test files**: `tests/utils.test.js`, `tests/search-helpers.test.js`, `tests/replay.test.js`, `tests/log-buffer.test.js`, `tests/persistence.test.js`, `tests/cache-staleness.test.js`, `tests/highlight-helpers.test.js`, `tests/virtual-scroller.test.js`, `tests/progressive-loading.test.js`, `tests/message-routing.test.js`, `tests/mutation-refresh.test.js`, `tests/referrer-focus.test.js`, `tests/attention-utils.test.js`, `tests/auto-blocks.test.js`, `tests/state-preservation.test.js`, `tests/read-cacheable.test.js`
- **Migration scripts**: `scripts/migrate-keys-and-notes.js` (atoms→pages, highlights→notes), `scripts/migrate-quote-to-excerpt.js` (quote→excerpt field rename), `scripts/migrate-shallow-refs.js` (parents→parentIds, children→childIds, referrer→referrerId, urls→ids, pins url→id, parent.json→shallow-page.json), `scripts/fix-raw-refs.js` (converts remaining raw URLs/{url,title} objects to typed refs, backfills shallow-page.json); utility: `scripts/check-gateways.js`, `scripts/check-gateway-filtering.js`

## Key Data Schemas

### Interaction (metadata in JSONL)
```json
{ "timestamp": 1234, "action": "page", "url": "https://...", "title": "...", "slug": "...", "referrerId": "page:parent-slug" }
```
Visit entries contain url/title/slug/referrerId (typed ref, always `page:<slug>`). Attention data (scrollDepth, timeOnPage) logged in separate page entries. Capture paths (mdPath, htmlPath) also in separate entries. Slugs use compact format: strip `www.` prefix and TLD from hostname.

### Note (in notes/{slug}.json — first-class entity)
```json
{ "slug": "note-slug", "timestamp": 1234, "excerpt": "selected text", "note": "user annotation", "cssPath": "body > ...", "parentIds": ["page:parent-slug"], "childIds": [] }
{ "slug": "note-slug", "timestamp": 1234, "excerpt": ["chunk1", "chunk2"], "note": "", "cssPath": "body > ...", "parentIds": ["page:parent-slug"], "childIds": [] }
```
`excerpt` is `string` (same-block selection), `string[]` (cross-block chunks), or `null` (global page note). `note` is the user annotation text.

### List (in lists/{listId}.json — self-describing entity)
```json
{ "id": "uuid", "timestamp": 0, "name": "Rust Lang", "qbTrees": [], "pins": [{ "id": "page:slug", "pinnedAt": 1234 }, { "id": "shallow:https://...", "pinnedAt": 1234 }] }
```
Pin `id` is a typed reference: `page:<slug>` for checkpointed pages, `shallow:<url>` for non-checkpointed pages.

### Recycle bin (in lists/system/recycle-bin.json)
```json
{ "timestamp": 0, "items": [{ "key": "page:slug", "title": "...", "deletedAt": 1234 }] }
```

### Permanent deletes (in lists/system/permanent-deletes.json — wrapped entity)
```json
{ "timestamp": 0, "keys": ["page:slug", "note:slug"] }
```

### Page (in pages/{slug}.json — selective checkpoint)
```json
{ "slug": "...", "timestamp": 1234, "url": "...", "title": "...", "parentIds": ["page:parent-slug", ...], "childIds": ["note:child-slug", "page:child-slug", "shallow:https://...", ...], "visitDates": [20240115, 20240116], "scrollDepth": 0.75, "timeOnPage": 45000, "mdPath": "...", "htmlPath": "..." }
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
// Note ops (first-class entities, typed refs)
{"timestamp":1234,"action":"note","slug":"note-slug","excerpt":"selected text","note":"annotation","cssPath":"body > ...","parentIds":["page:parent-slug"],"childIds":[]}
// List pins (granular operations, ids are typed refs)
{"timestamp":1234,"action":"list","id":"uuid","op":"add","ids":["page:slug","shallow:https://..."]}
{"timestamp":1234,"action":"list","id":"uuid","op":"del","ids":["page:slug"]}
{"timestamp":1234,"action":"list","id":"uuid","op":"clear","ids":[]}
// List metadata
{"timestamp":1234,"action":"list_meta","id":"uuid","name":"...","qbTrees":[]}
// List delete
{"timestamp":1234,"action":"del_list","id":"uuid"}
// Recycle bin (same list ops with id="system/recycle-bin")
{"timestamp":1234,"action":"list","id":"system/recycle-bin","op":"add","keys":["page:slug"]}
// Permanent deletes (same list ops with id="system/permanent-deletes")
{"timestamp":1234,"action":"list","id":"system/permanent-deletes","op":"add","keys":["page:slug"]}
```

### Settings (settings.json — derived checkpoint, config-only)
```json
{
  "timestamp": 0,
  "workspace": { "mode": "default", "listIds": [], "autoSnapshot": false },
  "listOrder": ["uuid1", "uuid2"],
  "urlBlacklist": ["chrome://", "edge://"],
  "titleTrimRules": []
}
```
Dynamic key-value store: each `set` log entry adds/overwrites a key. Lists, recycle bin, and permanent deletes are in their own entity files.

### Gateway domains (persisted in `gateways.json`, cached in chrome.storage.session)
```json
{
  "watermark": 1707345600000,
  "domains": {
    "https://example.com": { "rootUrl": "https://example.com/", "childCount": 15, "fetched": true }
  }
}
```
