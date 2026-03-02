# Portal Extension — Architecture

> Keep up-to-date after changes, like CODEBASE_MAP.md.

## Entity Storage Layer

Entity storage is the **single source of truth** for entity data. All consumers read entities through this layer, never from raw JSONL history.

### Two-Tier Cache

```
session cache (hot)  →  filesystem checkpoints (cold)
   chrome.storage.session        pages/{slug}.json
   via entity-cache.js           via offscreen loadPageBatch
```

- **Session cache**: in-memory IPC via `chrome.storage.session`, managed by `entity-cache.js` (500-entry LRU with watermark-gated eviction). Survives SW termination, cleared on browser restart.
- **Filesystem checkpoints**: `pages/{slug}.json` files on disk. Loaded via offscreen `loadPageBatch`.

### Buffer Replay Bridge

Between the filesystem checkpoint watermark and the current state, there may be un-drained logBuffer entries. `replayBufferOver(page)` bridges this gap:

```
filesystem checkpoint (watermark T₁)  +  logBuffer entries (T₁..T₂)  →  current entity state
```

This is applied:
- In `loadPageBatch` handler — after loading from filesystem, before caching
- In `getPageInfo` handler — for filesystem fallback when not in session cache
- In `hydrateCache` Phase 1.5 — pre-loads pages referenced by logBuffer before Phase 2 replay

### Read Path

```
cacheGet(key)                 ← session cache hit (fast)
  ↓ miss
loadPageBatch([slug])         ← filesystem via offscreen
  ↓ loaded
replayBufferOver(page)        ← apply pending logBuffer entries
  ↓
cacheSet(key, page)           ← populate session cache for next read
```

### UI Read Path (Cacheable Keys)

UI pages read cached data via `utils.js` `readCacheable(key)`, where `key` is an entity key (e.g., `'lists'`, `'list:system/orphaned'`, `'list:system/shallow-page'`, `'settings'`). Session cache stores entities under their entity keys and settings as a single `'settings'` object. Background's `readFs` handles key→filesystem resolution:

```
chrome.storage.session.get([key])     ← local session cache hit (fast, no IPC to background)
  ↓ miss
sendMessage({ action: 'readCacheable', key })  ← background.js readCacheable()
  ↓
background: session cache → readFs()  ← filesystem via offscreen, caches into session
  ↓
{ success: true, value }              ← returned to UI page
```

`loadSettingsValue(subKey, default)` reads `(await readCacheable('settings'))?.[subKey]` and returns `defaultValue` when the sub-field is `undefined`.

### Write Path

All mutations go through `addLog(entry)`:

```
addLog(entry)
  → logBuffer.push(entry)              ← durable in chrome.storage.local
  → effectOf(entry, sessionLoad)       ← replay against session cache
  → sessionWrite(effects)              ← update session cache
  → scheduleDrainNotify()              ← offscreen drains to filesystem
```

### Hydration (Startup)

```
Phase 1:    Load base entities (settings, lists, shallow-page index) from filesystem
Phase 1.5:  Pre-load page entities referenced by logBuffer from filesystem
Phase 2:    Replay ALL logBuffer entries via effectOf (brings session cache up-to-date)
Phase 3:    Order lists by listOrder setting
```

## Shallow Pages vs Checkpointed Pages

### Definitions

- **Checkpointed page**: has a `pages/{slug}.json` file on disk. Created by `page_checkpoint` log action. Full entity with url, title, parentIds, childIds, visitDates, attention, etc. Referenced as `page:<slug>` in typed refs.
- **Shallow page**: appears in JSONL history but has **no checkpoint file**. Never becomes an entity object — entity storage returns `null` for it. Referenced as `shallow:<url>` in typed refs. Metadata (parents, list membership, title) tracked in `lists/system/shallow-page.json`.

### Checkpoint Creation

The **only gateway** from shallow → checkpointed is `ensureCheckpointIfMissing()`, triggered by:

1. **Multi-day visit** — page has `visitDates` spanning multiple calendar days
2. **Referrer present** — cross-site navigation (parent page is also checkpointed)
3. **Note creation** — parent page must exist for note's `childIds` wiring on parent

Each creates a `page_checkpoint` log entry, which `effectOf()` in replay.js handles as the only action that can create a page entity from null.

### How Shallow Pages Appear

Shallow pages exist as:
- **Raw JSONL entries** in `history/YYYY-MM-DD.jsonl` files
- **Transient display objects** built by `processInteractionsForDisplay()` in options.js
- **Typed references** (`shallow:<url>`) in page `childIds`, list pin `id` fields, and log entry `ids` fields
- **Shallow-page index entries** in `lists/system/shallow-page.json` — `{ parents, lists, title, user_title }`

They do NOT exist in:
- Session cache (entity storage returns null)
- Filesystem (no `pages/{slug}.json`)

### Consumer Behavior at the Boundary

| Consumer | Checkpointed page | Shallow page |
|----------|-------------------|--------------|
| `getPageInfo` (popup) | Returns `interaction` with entity data | Returns `interaction: null`; popup uses `tab.title` fallback; background falls back to `shallowPageIndex` for title |
| `enrichFromEntityStorage` (options.js) | Overwrites display title with entity title | Skips — keeps JSONL title |
| `loadPageBatch` (background) | Returns entity from cache/filesystem | Absent from result |
| `effectOf` replay (page action) | Updates existing entity | Returns null (no-op); updates `shallowPageIndex` with parents/title |
| `effectOf` replay (note action) | Wires `note:<slug>` into parent page `childIds` only (note entity not created/updated by replay — content is on disk) | N/A |
| `effectOf` replay (del_note action) | Unlinks `note:<slug>` from parent page `childIds`, adds `note:<slug>` to `list:system/orphaned` | N/A |
| `effectOf` replay (del_list action) | Removes `list:<id>` from page `parentIds` (checkpointed pins), removes list from SPI `lists` (shallow pins), adds `list:<id>` to `list:system/orphaned` | N/A |
| `effectOf` replay (list pin/unpin) | Updates page `parentIds` with `list:<id>` | Updates SPI `lists` with `list:<id>` |
| `effectOf` replay (page_checkpoint) | Updates watermark; absorbs shallow-page index data (parents, lists) into page, upgrades `shallow:` list pins to `page:` | Creates entity from `defaultEntity()` |
| `getPageRelations` (background) | Reads `parentIds`/`childIds`, resolves typed refs | Falls back to `shallowPageIndex.index[url]` for parents |
| `buildExploreAutoBlocks` (options.js) | Resolves `page:<slug>` refs via `loadPageBatch` | Resolves `shallow:<url>` refs via `shallowPageIndex` for URL+title |
| Pin display (options.js) | `resolvePageRef` → page entity from session cache | `resolvePageRef` → metadata from `shallowPageIndex`, or null if unreferenced |

### Typed References

All inter-entity references use typed keys with a prefix indicating the entity kind:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `page:<slug>` | Checkpointed page (has `pages/{slug}.json`) | `page:github-facebook-rocksdb-s3z2s3` |
| `shallow:<url>` | Non-checkpointed page (no entity file) | `shallow:https://example.com/article` |
| `note:<slug>` | Note entity (has `notes/{slug}.json`) | `note:my-note-abc123` |
| `list:<id>` | List entity (has `lists/{id}.json`) | `list:rust-lang-ffnyqr` |

Used in: `page.parentIds` (includes `page:<slug>` from referrers and `list:<id>` from list membership), `page.childIds`, `note.parentIds`, `note.childIds`, list pin `id` fields, log entry `referrerId`/`ids`/`parentIds`/`childIds` fields.

**Resolution**: `page:<slug>` refs are resolved to URLs via `loadPageBatch`. `shallow:<url>` refs have the URL embedded (extract via `ref.slice(8)`). When a shallow page becomes checkpointed, `effectOf`'s page_checkpoint branch resolves `shallow:<url>` → `page:<slug>` in parentIds/childIds and upgrades `shallow:` pin IDs to `page:` in affected list entities.

### Shallow-Page Index

`lists/system/shallow-page.json` — entity key `list:system/shallow-page`

Tracks metadata for non-checkpointed pages that are referenced by checkpointed entities:

```json
{
  "timestamp": 1234,
  "index": {
    "https://example.com/child": {
      "parents": ["page:parent-slug"],
      "lists": ["list:my-list"],
      "title": "Example Page",
      "user_title": null
    }
  }
}
```

- **Populated by**: `applyLogToShallowPage` in replay.js — `page` entries (parents, title), `list` entries with `shallow:` ids (list membership). `effectOf` post-processes list entries to enrich `title: null` SPI entries from today's/yesterday's history cache.
- **Pruned**: when a shallow page becomes checkpointed, its entry is removed, data (parents, lists) absorbed into the new page entity, and `shallow:` pin IDs in affected lists upgraded to `page:<slug>`
- **Consumers**: `getPageRelations` (fallback for non-checkpointed children/parents), `buildExploreAutoBlocks` (resolve shallow refs to URLs+titles), `getPageInfo` (title fallback)

### Pin ID Resolution

When a page is pinned to a list, the pin ID must be authoritative: `page:<slug>` if checkpointed, `shallow:<url>` if not. A race condition exists between page capture (which creates the checkpoint) and the pin operation (which references the URL) — the caller may compute `shallow:<url>` for a page that was checkpointed in between.

**Resolution chain** (background.js `resolvePageId(url)`):
```
cacheGet('page:' + slug)            ← session cache hit (fast)
  ↓ miss
requestOffscreen({ pageExists })    ← filesystem check (definitive)
  ↓ exists? → 'page:<slug>'
  ↓ not?   → 'shallow:<url>'
```

**Write-time re-validation** (`resolveShallowIds(ids)`): Every `shallow:<url>` ID in a list pin operation is re-checked against cache+disk before writing to the log. This ensures the log always contains the authoritative pin ID, regardless of what the caller computed.

Applied in: `toggleListPin` handler (re-checks any shallow ID), `addListPins` handler (re-checks all IDs via `resolveShallowIds`).

### Design Rationale

Most visited pages are one-time visits that don't need rich entity state. Selective checkpointing keeps the filesystem lean — only pages with meaningful relationships (referrers, notes, multi-day engagement) get checkpoint files. Shallow pages still appear in history views via JSONL data. The typed reference system (`page:<slug>` vs `shallow:<url>`) makes it explicit whether a referenced page is materialized, and the shallow-page index provides a lightweight way to track parent/list/title metadata for non-checkpointed pages without creating full entity files.

## Module Responsibilities

### Canonical Data Flow

```
┌─ content.js ─────────────────┐
│  DOM capture, user intent     │──sendMessage──┐
└───────────────────────────────┘               │
┌─ popup.js ───────────────────┐               │
│  Current-page dashboard       │──sendMessage──┤
└───────────────────────────────┘               │
┌─ options.js ─────────────────┐               │     ┌─ offscreen.js ──────┐
│  Bookmark-manager UI, search  │──sendMessage──┼────▶│  background.js      │──port──▶│  Filesystem I/O     │
└───────────────────────────────┘               │     │  Business logic hub  │◀─port──│  (File System Access │
                                                │     │  Event-sourced log   │        │   API, IndexedDB)    │
                                                │     └──────────────────────┘        └─────────────────────┘
```

| Module | Responsibility | Allowed APIs |
|--------|---------------|-------------|
| **background.js** | Business logic, event-sourced log, cache coordination, message dispatch | `chrome.storage.session/local`, `chrome.runtime`, `chrome.tabs`, `chrome.offscreen` |
| **offscreen.js** | Filesystem I/O only (File System Access API needs document context) | `chrome.runtime` (port only) |
| **content.js** | DOM interaction, scroll/time tracking, highlight rendering | `chrome.runtime.sendMessage`, `chrome.storage.session` (read workspace) |
| **popup.js** | Current-page dashboard UI | `chrome.runtime.sendMessage`, `chrome.tabs.query` |
| **options.js** | Full UI: search, explore, lists, settings | `chrome.runtime.sendMessage`, `chrome.storage.session` (transient UI state) |
| **replay.js** | Pure event replay functions (no chrome APIs) | None |
| **utils.js** | Shared utilities, `readCacheable`, `sendAction` | `chrome.runtime.sendMessage`, `chrome.storage.session` (cache read) |
| **entity-cache.js** | Session cache with LRU eviction | `chrome.storage.session` |
| **filesystem-storage.js** | File System Access API wrapper | File System Access, IndexedDB |

### Message Response Convention

All background.js message handlers return `{ success: true, ...fields }` on success and `{ success: false, error }` on failure. The `sendAction()` helper in utils.js throws on `success === false`.

### History Date Keys

`history:<YYYY-MM-DD>` keys in session cache hold the complete list of entries for that date — both drained (on-disk JSONL) and undrained (still in logBuffer). `addLog()` appends every new entry to the appropriate date key and pins it. This makes `readCacheable('history:<today>')` the canonical way for UI pages to get today's entries.

`readFs` handles `history:*` keys via offscreen `loadHistoryRange` (pure disk read, no replay — same as all other keys). During hydration, Phase 2.5 appends logBuffer entries to their `history:<date>` keys after Phase 2 entity replay. This ensures session cache has the complete view before any `readCacheable` call from UI pages.

**Post-hydration eviction safety**: `readFs` returns disk-only data without logBuffer replay. This is safe because keys with undrained logBuffer entries are protected from eviction:
- **Today's key**: pinned by hydration (Phase 1.5) and `addLog()` — never evicted.
- **Past date keys with undrained entries**: Phase 2.5 sets their timestamp from logBuffer entries. Since undrained timestamps > `persistWatermark`, watermark-gated eviction in `entity-cache.js` won't evict them until drain completes (at which point disk is complete).
- **Past date keys fully drained**: disk is the complete record — `readFs` returns correct data.

### Pending Buffer for WASM Search

`pipelinedSearch()` in options.js reads `chrome.storage.local.get(['logBuffer'])` directly to get the exact undrained delta. WASM searches JSONL files on disk, so only undrained entries need to be searched separately. The raw logBuffer (not `history:<today>`) avoids double-processing entries already in JSONL.

### Known Architectural Exceptions

**options.js direct FileSystemStorage access** — options.js instantiates its own `FileSystemStorage` for:
1. **WASM search pipeline** (`pipelinedSearch`): reads `history/` JSONL files directly via the WASM `searchBatch()` API for zero-copy performance. Routing through background→offscreen would require serializing file contents across IPC boundaries.
2. **Directory picker UI** (`selectDirectory`): the File System Access `showDirectoryPicker()` API requires user gesture in a document context — can't be proxied through background.
3. **Settings page diagnostics** (`getDirectoryInfo`, data purge): inspects/manages the storage directory.

These bypass the background→offscreen pipeline. The tradeoff is acceptable because (a) the WASM search is read-only and operates on immutable JSONL history files, (b) directory picker is a one-time setup action, (c) diagnostics are developer-facing.

**options.js direct chrome.storage.local** — Three call sites remain:
1. **WASM search** (`pipelinedSearch`): reads undrained logBuffer entries to search separately from on-disk JSONL (see "Pending Buffer for WASM Search" above).
2. **Settings diagnostics** (`updateStatistics`, `updateCacheTable`): read logBuffer to display byte sizes and entry counts in the cache inspector UI.
