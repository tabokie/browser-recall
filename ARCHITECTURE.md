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
getCachedEntity(key)          ← session cache hit (fast)
  ↓ miss
loadPageBatch([slug])         ← filesystem via offscreen
  ↓ loaded
replayBufferOver(page)        ← apply pending logBuffer entries
  ↓
setCachedEntity(key, page)    ← populate session cache for next read
```

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
Phase 1:    Load base entities (settings, lists, recycle bin, shallow-page index) from filesystem
Phase 1.5:  Pre-load page entities referenced by logBuffer from filesystem
Phase 2:    Replay ALL logBuffer entries via effectOf (brings session cache up-to-date)
Phase 3:    Order lists by listOrder setting
Phase 4:    Incremental gateway processing
```

## Shallow Pages vs Checkpointed Pages

### Definitions

- **Checkpointed page**: has a `pages/{slug}.json` file on disk. Created by `page_checkpoint` log action. Full entity with url, title, parentIds, childIds, visitDates, attention, etc. Referenced as `page:<slug>` in typed refs.
- **Shallow page**: appears in JSONL history but has **no checkpoint file**. Never becomes an entity object — entity storage returns `null` for it. Referenced as `shallow:<url>` in typed refs. Metadata (parents, list membership, title) tracked in `lists/system/shallow-page.json`.

### Checkpoint Creation

The **only gateway** from shallow → checkpointed is `ensureCheckpointIfMissing()`, triggered by:

1. **Multi-day visit** — page has `visitDates` spanning multiple calendar days
2. **Referrer present** — cross-site navigation (parent page is also checkpointed)
3. **Note creation** — parent page must exist for note's `parents` wiring

Each creates a `page_checkpoint` log entry, which `applyTo()` in replay.js handles as the only action that can create a page entity from null.

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
| `applyTo` replay (page action) | Updates existing entity | Returns null (no-op); updates `shallowPageIndex` with parents/title |
| `applyTo` replay (page_checkpoint) | Updates watermark; absorbs shallow-page index data (parents, lists) | Creates entity from `defaultEntity()` |
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

Used in: `page.parentIds`, `page.childIds`, `note.parentIds`, `note.childIds`, list pin `id` fields, log entry `referrerId`/`ids`/`parentIds`/`childIds` fields.

**Resolution**: `page:<slug>` refs are resolved to URLs via `loadPageBatch`. `shallow:<url>` refs have the URL embedded (extract via `ref.slice(8)`). When a shallow page becomes checkpointed, replay.js `applyTo` post-loop resolves `shallow:<url>` → `page:<slug>` in all entities within scope.

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

- **Populated by**: `applyLogToShallowPage` in replay.js — `page` entries (parents, title), `list` entries with `shallow:` ids (list membership)
- **Pruned**: when a shallow page becomes checkpointed, its entry is removed and data absorbed into the new page entity
- **Consumers**: `getPageRelations` (fallback for non-checkpointed children/parents), `buildExploreAutoBlocks` (resolve shallow refs to URLs+titles), `getPageInfo` (title fallback)

### Design Rationale

Most visited pages are one-time visits that don't need rich entity state. Selective checkpointing keeps the filesystem lean — only pages with meaningful relationships (referrers, notes, multi-day engagement) get checkpoint files. Shallow pages still appear in history views via JSONL data. The typed reference system (`page:<slug>` vs `shallow:<url>`) makes it explicit whether a referenced page is materialized, and the shallow-page index provides a lightweight way to track parent/list/title metadata for non-checkpointed pages without creating full entity files.
