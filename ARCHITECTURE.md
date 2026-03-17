# Portal Extension — Architecture

> Keep up-to-date after changes, like CODEBASE_MAP.md.

## Directory Structure

```
<root>/
  data/                              # PUBLIC. Immutable/append-only. Other apps can read.
    logs/<YYYY-MM-DD>.jsonl          #   Event history (source of truth)
    snapshots/<slug>-<ts>/           #   Snapshot files (index.html, index.md, assets)
    notes/<noteSlug>.json            #   Notes and highlights (same format)

  lists/                             # INTERNAL. List entity files.
    <listId>.json
    system/
      root.json                      #   Tree root (childLists)
      gateways.json                  #   Gateway domain registry

  pages/                             # INTERNAL. Per-page entity files. GC'd when ineligible.
    <slug>.json

  manifest/                          # INTERNAL. Irregular-shape manifests.
    list-name-to-id.json             #   list [parents, name] → internal ID
    settings.json                    #   User settings
    orphaned.json                    #   Tracks deleted entity keys (recycle bin)
```

**`data/` is public**: We surrender read permission to all potential apps outside our domain. Content inside it is generally immutable/append-only. Internal data (entities, system lists, manifests) that contain internal concepts live in separate folders (`lists/`, `pages/`, `manifest/`).

**Event fields** reference only things in `data/`: URLs for pages, relative paths (`snapshots/...`, `notes/...`) for files. Internal folders are never mentioned in events.

## Entity Storage Layer

Entity storage is the **single source of truth** for entity data. All consumers read entities through this layer, never from raw JSONL history.

### Two-Tier Cache

```
session cache (hot)  →  filesystem checkpoints (cold)
   chrome.storage.session        pages/<slug>.json, manifest/*.json
   via entity-cache.js           via offscreen loadPageBatch
```

- **Session cache**: in-memory IPC via `chrome.storage.session`, managed by `entity-cache.js` (500-entry LRU with watermark-gated eviction). Survives SW termination, cleared on browser restart.
- **Filesystem checkpoints**: `pages/<slug>.json` files on disk. Loaded via offscreen `loadPageBatch`.

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

UI pages read cached data via `utils.js` `readCacheable(key)`, where `key` is an entity key (e.g., `'lists'`, `'list:system/root'`, `'settings'`). Session cache stores entities under their entity keys and settings as a single `'settings'` object. Background's `readFs` handles key→filesystem resolution:

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
Phase 1:    Load base entities (settings, lists incl. list:system/root, shallow-page index) from filesystem
Phase 1.5:  Pre-load page entities referenced by logBuffer from filesystem
Phase 2:    Replay ALL logBuffer entries via effectOf (brings session cache up-to-date)
```

## Page Entities

### Entity Creation

Page entities are created **only by explicit user actions** — never by passive visits. The following actions create a page entity in `pages/<slug>.json` if one doesn't exist:

- `create_snapshot` — user captures a snapshot
- `create_note` — user creates a note on a page
- `pin_to_list` — user pins a page to a list
- `rename_page` — user sets a custom title
- `rate_page` — user likes/unlikes a page

`visit_page` and `leave_page` **only enrich existing entities** (title, attention data, referrer links). Passive visits that don't match an existing entity leave no entity footprint — they exist only as JSONL history entries.

### Page Eligibility GC

Page entities are garbage-collected when they become **ineligible**. A page is eligible if ANY of:
- `parentIds` contains at least one `list:` key (pinned to a user list)
- `childIds` contains at least one `note:` or `snapshot:` key
- `user_title` is set and truthy
- `likes` is set and non-zero

GC triggers during replay when an action removes the last eligible criterion:
- `unpin_from_list` — removes list parent; page GC'd if no other criteria
- `delete_note` — removes note child from page; page GC'd if no other criteria
- `delete_snapshot` — removes snapshot child from page; page GC'd if no other criteria
- `delete_list` — removes list parent from all pinned pages; pages GC'd if no other criteria

GC'd pages are set to `null` in replay results. `sessionWrite` stores a GC tombstone in session cache (prevents disk reload before drain). Offscreen drain deletes the `pages/<slug>.json` file via `fsStorage.deletePage()`.

### Typed References (Internal)

Internal entity references use typed keys with a prefix indicating the entity kind:

| Prefix | Meaning | File Location |
|--------|---------|---------------|
| `page:<slug>` | Page entity | `pages/<slug>.json` |
| `note:<slug>` | Note entity | `data/notes/<noteSlug>.json` |
| `snap:<slug>-<ts>` | Snapshot (no entity file — exists in page `childIds` and `manifest/orphaned.json`) | `data/snapshots/<slug>-<ts>/` |
| `list:<id>` | List entity | `lists/<id>.json` |

Used internally in: `page.parentIds`, `page.childIds`, `note.parentIds`, list pin `id` fields.

**Events never use typed references.** Events reference pages by URL, notes/snapshots by relative path (`notes/...`, `snapshots/...`), and lists by `parents` array + `name`. `effectOf` translates between event fields and internal typed references.

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
| **rule-engine.js** | Pure rule matching (keyword/semantic/smart), validation, ID generation | None |
| **semantic-engine.js** | MiniLM-L6-v2 embeddings via HuggingFace transformers (offscreen only) | CDN import |
| **smart-rule-sandbox.js** | Sandboxed JS execution for smart rules (manifest sandbox page) | `new Function` (via unsafe-eval CSP) |
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

### Entity Cache Guarantees

Two invariants ensure `readCacheable('page:*')` / `readCacheable('note:*')` / etc. always return up-to-date data without replaying the logBuffer on read:

1. **Dirty entities are pinned (not evictable).** Every `addLog()` call replays via `effectOf` and writes updated entities to session cache. The entity-cache LRU only evicts entries whose `timestamp <= persistWatermark`. Undrained entities have timestamps newer than the watermark, so they cannot be evicted until drain completes (at which point disk matches the session state).

2. **Hydration pre-fills cache with all entities modified by logBuffer.** Phase 1.5 pre-loads page entities referenced by logBuffer from filesystem into session cache. Phase 2 then replays every logBuffer entry via `effectOf`, bringing all affected entities (pages, notes, lists, SPI, settings) up-to-date. By the time `hydrationDone` resolves and `readCacheable` becomes callable, every entity that has undrained mutations is already in session cache with the correct state.

**Consequence:** `readFs` (the filesystem fallback in `readCacheable`) does NOT need to replay logBuffer entries. For any key with undrained mutations, the session cache will have the up-to-date entity. `readFs` only runs on a true cache miss — meaning no undrained mutations exist for that key, so the disk checkpoint is authoritative.

### Pending Buffer for WASM Search

`pipelinedSearch()` in options.js reads `chrome.storage.local.get(['logBuffer'])` directly to get the exact undrained delta. WASM searches JSONL files on disk, so only undrained entries need to be searched separately. The raw logBuffer (not `history:<today>`) avoids double-processing entries already in JSONL.

### Known Architectural Exceptions

**options.js direct FileSystemStorage access** — options.js instantiates its own `FileSystemStorage` for:
1. **WASM search pipeline** (`pipelinedSearch`): reads `history/` JSONL files directly via the WASM `searchBatch()` API for zero-copy performance. Routing through background→offscreen would require serializing file contents across IPC boundaries.
2. **Directory picker UI** (`selectDirectory`): the File System Access `showDirectoryPicker()` API requires user gesture in a document context — can't be proxied through background.
3. **Settings page diagnostics** (`getDirectoryInfo`, data purge): inspects/manages the storage directory.

These bypass the background→offscreen pipeline. The tradeoff is acceptable because (a) the WASM search is read-only and operates on immutable JSONL history files, (b) directory picker is a one-time setup action, (c) diagnostics are developer-facing.

## Rules (Materialized Search Rules)

### Design

Lists can have **rules** that automatically pin matching pages. Rules are event-sourced via `add_rule`, `remove_rule`, `update_rule` log actions. Three rule types:

| Type | Matching | Implementation |
|------|----------|---------------|
| **keyword** | Substring or `/regex/` match on title/url | Pure function in `rule-engine.js` |
| **semantic** | Cosine similarity of MiniLM-L6-v2 embeddings | Offscreen: `semantic-engine.js` (lazy model load, ~22.8MB cached via CDN) |
| **smart** | User-written JS function `(page) => score` | Offscreen → sandbox iframe (`smart-rule-sandbox.html`, manifest `sandbox` key for `unsafe-eval` CSP) |

### Data Model

List entity gains `rules: []` array. Each rule: `{ id, type, config, createdAt }`. Rule IDs: `rule-<type[0]>-<base36_ts>-<4char_hash>`.

### Page Body Text (`bodyPreview`)

content.js captures the first 200 words of `document.body.innerText` at visit time and sends it as `bodyPreview` in the `reportPage` message. background.js stores it in the `visit_page` JSONL entry. This enriches rule matching with page content beyond title/URL. The word limit is defined as `BODY_WORD_LIMIT` in `utils.js` (canonical) and duplicated in `content.js` (non-module, can't import).

For keyword rules, `matchKeywordRule` automatically checks `body` when present in `pageData`. For semantic rules, `matchRules` embeds `title + body` (falls back to `title + url` when body unavailable). For smart rules, `page.body` is accessible to user functions.

### Execution Flow

**Batch matching** (`runRuleBatch` handler in background.js):
1. Collect lists with non-empty `rules[]`
2. For each list × entry: build `pageData` (incl. `body` from `bodyPreview`) → call `matchRules()` with offscreen-routed embedder/sandbox closures
3. Auto-pin matching pages via `addLog({ action: 'pin_to_list' })`

**Preview** (`previewRule` handler in background.js):
- Dry-run matching without side effects. Uses `matchRules` with `allScores: true` to return raw scores for all entries (not just above-threshold matches).
- For semantic rules, page embeddings are cached in `chrome.storage.session` under `previewEmbeddingCache` (URL → Array). Each preview rebuilds the cache from current candidates (bounded size). Changing the query only recomputes the query embedding; cached page embeddings are reused.

**Semantic embedding**: background → offscreen port `generateEmbedding` → `semantic-engine.js` (lazy singleton pipeline). Embedding stored in rule config at creation time. Library vendored locally (`extension/vendor/transformers.min.js` + `ort-wasm-simd-threaded.jsep.mjs`); WASM binary fetched from CDN at runtime. `semantic-engine.js` sets `wasmPaths = './'` for local `.mjs` import and pre-fetches the `.wasm` via `fetch()` (not blocked by CSP) into `wasmBinary`.

**Smart sandbox**: background → offscreen port `executeSandboxFn` → sandbox iframe `postMessage` → `new Function('page', fnSource)(pageData)` → result clamped 0-1. 5s timeout.

### Security

Smart rule functions are validated by `validateSmartRuleFn()` before storage: word-boundary regex scan for 16 banned globals (fetch, chrome, window, document, navigator, globalThis, eval, Function, setTimeout, setInterval, WebSocket, Worker, localStorage, sessionStorage, indexedDB, importScripts). Max 10KB source. Execution is sandboxed in a manifest-declared sandbox page (separate origin, no extension API access).

### UI (Options Page)

Rules section is a collapsible glass panel inside `#listLayout`, between the header and `#listQueryBuilder`. Hidden for system lists (`system/*`). Shows rule count badge and Run button when rules exist.

- **Rendering**: `renderRulesSection(listId, rules)` shows/hides section + count badge; `renderRulesList()` renders entries with type badges (keyword=orange, semantic=blue, smart=green) + remove buttons following `blacklist-entry` pattern.
- **Inline add form**: type tri-toggle switches between keyword (pattern + field checkboxes), semantic (description + threshold slider), smart (description + function textarea). Saves via `sendAction('addRule', ...)` with `{ type, config: {...} }` shape.
- **Preview button**: two-pass check — (1) recent visits from history (progressive batched, up to 100 checked / 20 matches), (2) all pinned pages in the current list. Entries missing `bodyPreview` are fetched on-the-fly via `fetchPageBody()` in options.js. Shows all results with green (match) / red (miss) score coloring. Threshold slider re-renders scores client-side without re-running matching.
- **Run button**: reads today's `visit_page` history, fetches `bodyPreview` on-the-fly for entries missing it, calls `runRuleBatch`, shows match count.
- **Mutation handler**: `type === 'rules'` mutation refreshes rules panel for the affected list via `refreshRulesForActiveList()`.

## Deletion

### Design: Unlink + Orphan (No Physical File Moves)

Deletion is a **logical operation**, not a physical one. Deleting a note, list, or snapshot appends a log entry (`delete_note`, `delete_list`, or `delete_snapshot`) that unlinks the entity from its parents and adds its key to `manifest/orphaned.json`. The entity file on disk (`data/notes/<slug>.json`, `lists/<id>.json`) or snapshot files (`data/snapshots/<slug>-<ts>/`) are never touched.

This design exists because of the event-sourced architecture. The JSONL history is the source of truth, and entity files are derived checkpoints rebuilt by replaying history. If deletion moved or removed files, replaying history would attempt to reference files that no longer exist at their expected paths — breaking replay idempotency. By keeping deletion as a pure relation change in the log, replay can be run any number of times and always produce a consistent result.

### What Each Deletion Does

**`delete_note` (replay.js):**
1. Unlinks `note:<slug>` from each parent page's `childIds`
2. Adds `note:<slug>` to `manifest/orphaned.json`
3. File `data/notes/<slug>.json` stays on disk

**`delete_snapshot` (replay.js):**
1. Unlinks `snap:<slug>-<ts>` from each parent page's `childIds`
2. Adds `snap:<slug>-<ts>` to `manifest/orphaned.json`
3. Snapshot directory `data/snapshots/<slug>-<ts>/` stays on disk

**`delete_list` (replay.js):**
1. Removes the list from parent's `childLists` (sidebar disappears)
2. Removes `list:<id>` from `parentIds` of all pinned pages
3. Cascades delete to all descendant lists (computed from entity state by `effectOf`)
4. Adds `list:<id>` to `manifest/orphaned.json`
5. Removes list and descendants from `manifest/list-name-to-id.json`
6. File `lists/<id>.json` stays on disk

**`replace_note` (replay.js):**
1. Unlinks old `note:<old-slug>` from each parent page's `childIds`
2. Links new `note:<new-slug>` to the same parent pages' `childIds`
3. Transfers list pins: replaces old note ID with new note ID in each list's `pins` array
4. Sets new note's `parentIds` from old note (inherits page + list parents)
5. Marks old note: `{ deleted: true, deletionReason: 'replaced', replacedBy: 'note:<new-slug>' }`
6. Adds old `note:<old-slug>` to `manifest/orphaned.json`

Notes are immutable — editing creates a new entity via `replace_note` rather than mutating in place. This preserves the full change history of a page's notes in the JSONL log.

All handlers use `effectOf` in replay.js — all side-effects are computed in a single replay pass, not as separate log entries.

### The Orphaned Manifest

`manifest/orphaned.json` holds an array of entity keys (`note:<slug>`, `snap:<slug>-<ts>`, `list:<id>`) for deleted items. This serves as a "recycle bin" manifest: the keys are unlinked from the entity graph but the underlying files are intact and could be restored.

### File Persistence and Its Consequences

Because entity files survive deletion, a **second-order lookup** can still reach them. For example, if a page's `childIds` is `["note:abc"]` and `note:abc` was deleted, `loadPageNotes` will still find `notes/abc.json` on disk and return it — the note appears in the UI even though it was logically deleted. The `del_note` replay removes the key from the parent's `childIds`, so after replay completes, the reference is gone. But if the user *physically* deletes the file from the filesystem (e.g., via a future recycle-bin UI that offers permanent deletion), then the file is gone while stale references may still exist in older history entries. Replaying that history will hit a missing file.

Currently, `loadNote()` in filesystem-storage.js returns `null` for missing files (catches `NotFoundError`), and `loadPageNotes()` silently skips null results. This means missing files degrade silently — no crash, but no warning to the user either. A future improvement should surface these as warnings in the UI so users know data is missing rather than simply absent.

### Scope: What Can and Cannot Be Deleted

| Entity | Deletion supported | Log action | Notes |
|--------|-------------------|------------|-------|
| Note | Yes | `delete_note` | Unlinks from parent page `childIds` |
| Snapshot | Yes | `delete_snapshot` | Unlinks from parent page `childIds`; no entity file (key-only) |
| List | Yes | `delete_list` | Unlinks from all pinned pages, removes from sidebar, cascades to descendants |
| Page | Automatic (GC) | — | Pages are GC'd during replay when they become ineligible (see Page Eligibility GC) |

**options.js direct chrome.storage.local** — Three call sites remain:
1. **WASM search** (`pipelinedSearch`): reads undrained logBuffer entries to search separately from on-disk JSONL (see "Pending Buffer for WASM Search" above).
2. **Settings diagnostics** (`updateStatistics`, `updateCacheTable`): read logBuffer to display byte sizes and entry counts in the cache inspector UI.
