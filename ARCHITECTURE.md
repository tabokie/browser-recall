# Browser Recall — Architecture

> Keep up-to-date when functionality is added, removed, or significantly changed.

## Directory Structure

```
<root>/
  data/                              # PUBLIC. Immutable/append-only. Other apps can read.
    logs/<device>/<YYYY-MM-DD>.jsonl  #   Event history by device (source of truth)
    snapshots/<slug>-<ts>/           #   Snapshot files (index.html, index.md, assets)
    notes/<noteSlug>.json            #   Notes and highlights (same format)

  lists/                             # INTERNAL. List entity files.
    <listId>.json

  pages/                             # INTERNAL. Per-page entity files. GC'd when ineligible.
    <slug>.json

  manifest/                          # INTERNAL. Irregular-shape manifests.
    list-order.json                  #   Tree hierarchy + ordering ({ timestamps, tree: [{ id, children? }] })
    list-name-to-id.json             #   Compound key (owner/name) → internal ID
    settings.json                    #   User settings
    orphaned.json                    #   Tracks deleted entities as entries [{ key, url? }] (recycle bin)
```

`**data/` is public**: We surrender read permission to all potential apps outside our domain. Content inside it is generally immutable/append-only. Internal data (entities, system lists, manifests) that contain internal concepts live in separate folders (`lists/`, `pages/`, `manifest/`).

**Event fields** reference only things in `data/`: URLs for pages, relative paths (`snapshots/...`, `notes/...`) for files. Internal folders are never mentioned in events.

## Entity Storage Layer

Entity storage is the **single source of truth** for entity data. All consumers read entities through this layer, never from raw JSONL history.

### Two-Tier Cache

```
session cache (hot)  →  filesystem checkpoints (cold)
   chrome.storage.session        pages/<slug>.json, manifest/*.json
   via entity-cache.js           via offscreen loadPageBatch
```

- **Session cache**: in-memory IPC via `chrome.storage.session`, managed by `entity-cache.js` (500-entry LRU with watermark-gated eviction). On `QuotaExceededError`, `cacheSet` performs emergency eviction (flushed unpinned keys first, then unflushed as last resort) and retries. Survives SW termination, cleared on browser restart.
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

UI pages read cached data via `utils.js` `readCacheable(key)`, where `key` is an entity key (e.g., `'manifest:list-order'`, `'list:<id>'`, `'settings'`). Session cache stores entities under their entity keys and settings as a single `'settings'` object. Background's `readFs` handles key→filesystem resolution:

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

### History Rendering (Non-blocking Enrichment)

History rows render immediately from log data (title, URL, timestamps), before entity enrichment completes. Enrichment (`enrichFromEntityStorage`) runs in the background and mutates entries in place, then `vs.refreshVisible()` re-renders visible rows to show entity-derived tags (liked, note, snapshot, list badges).

```
displayHistoryRows(entries)
  processHistoryForDisplay()         ← sync: dedup, sort, build display entries
  vs.setData(sorted, renderFn)       ← immediate: rows visible with log-only data
  enrichFromEntityStorage(entries)    ← background: batch readCacheable('page:*')
    .then(() => vs.refreshVisible()) ← re-render visible rows with entity tags
```

Same pattern applies to `onLoadMore` (demand-loading on scroll): `vs.appendData()` first, then background enrichment. When non-default filters are active in explore view, enrichment must await (filters depend on enriched fields).

File reads in `filesystem-storage.js` `_loadFromDeviceFiles()` are parallelized via `Promise.all` (all files in a batch read concurrently).

### Write Path

All mutations go through `addLog(entry)`:

```
addLog(entry)
  → logBuffer.push(entry)              ← durable in chrome.storage.local
  → cap enforcement (LOG_BUFFER_MAX_SIZE=2000: drop drained, then oldest)
  → chrome.storage.local.set({ logBuffer })  ← try/catch (quota fail preserves in-memory)
  → effectOf(entry, sessionLoad, { deviceId: await getDeviceId() })  ← replay against session cache
  → sessionWrite(effects)              ← update session cache
  → scheduleDrainNotify()              ← offscreen drains to filesystem
```

`getDeviceId()` is an async lazy getter: returns cached `localDeviceId` if set, otherwise loads from the plaintext `CURRENT` file via offscreen. This handles messages arriving before `hydrateCache()` completes (pre-hydration window) and SW wakeup without re-hydration.

### Error Resilience

- **Session quota**: `cacheSet` catches `QuotaExceededError`, runs `emergencyEvict()` (flushed unpinned keys first, unflushed as last resort, never pinned), retries. Throws meaningful error if eviction exhausted.
- **logBuffer overflow**: Capped at `LOG_BUFFER_MAX_SIZE` (2000). Drops drained entries (ts <= watermark) first, then oldest. `chrome.storage.local.set` failure logged but does not lose in-memory entries.
- **Offscreen crash**: Port `onDisconnect` resolves all pending `portCallbacks` with `{ success: false }` and clears the Map. `connectToOffscreen` on reconnect calls `scheduleDrainNotify` to resume drain.
- **FS permission revocation**: `drainQueue` clears `pendingDrainEntries` only after successful JSONL writes (preserved for retry on failure). Per-entity checkpoint flush wrapped in individual try/catch — one entity failure does not block others.
- **Lock timeout**: Both background and offscreen `withLock` have `LOCK_TIMEOUT_MS` (30s) timeout to prevent permanent deadlock from hung operations.

### Service Downtime (Unified Error State)

When a fatal condition is detected (session quota exhausted, local quota exhausted, offscreen crash loop, FS permission revoked), the background enters a **paused** state:

```
pauseService(code, message)
  → serviceError = { code, message, timestamp }
  → chrome.action.setIcon(downtime icons)
  → chrome.storage.session.set({ serviceError })

resumeService()
  → serviceError = null
  → chrome.action.setIcon(normal icons)
  → chrome.storage.session.remove(['serviceError'])
  → re-run hydrateCache()
```

**Mutation guard:** `addLog(entry)` throws `Error('Service paused [code]')` when `isServicePaused()` is true. The outer `catch` in the message listener converts this to `{ success: false, error }`. Explicit `isServicePaused()` guards also exist on `reportPage`, `permanentDelete`, `permanentDeleteAll`, and `syncNow` to avoid unnecessary work before reaching `addLog`.

**Error codes:** `session_quota`, `local_quota`, `offscreen_crash`, `fs_permission`. Each maps to a specific message and action button in the options page error banner.

**Options page banner:** `#serviceErrorBanner` (fixed top bar) — read from `chrome.storage.session` on `initialize()`, live-updated via `chrome.storage.onChanged` listener. `fs_permission` shows "Re-grant Access" button (calls `fsStorage.selectDirectory()` + `resumeService`); all others show "Reload Extension" button (calls `chrome.runtime.reload()`).

### Device Identity (`CURRENT` file)

The device ID is stored as plaintext in a `CURRENT` file at the data root — separate from settings (which are shared across devices). The file is written once on first install by `ensureDeviceId()` and is **immutable** thereafter. Renaming would require updating all `timestamps` maps in entity checkpoints, so it is not supported.

`ensureDeviceId()` generates a random 8-char UUID prefix, writes the `CURRENT` file, and pre-creates the `data/logs/<device>/` directory via `initDevice()` in offscreen.

### Hydration (Startup)

```
Phase 1:    Load base entities (settings, lists, manifest:list-order, shallow-page index) from filesystem
Phase 1.5:  Pre-load page entities referenced by logBuffer from filesystem
Phase 2:    Replay ALL logBuffer entries via effectOf (brings session cache up-to-date)
```

### Replay Idempotency Requirement

**Every `effectOf` action branch MUST be idempotent** — applying the same log entry twice against a state that already reflects it must produce the same result as applying it once.

**Why this matters:** Entity files on disk are checkpoints, not the source of truth. The logBuffer (persisted in `chrome.storage.local`) is the authoritative record of undrained mutations. If a drain partially succeeds (writes some entities to disk) but crashes before clearing the logBuffer, the next hydration will replay the full logBuffer against disk state that already reflects some or all of those entries. Without idempotency, this produces corrupted state (double-counted attention, duplicate tree nodes, etc.).

**Idempotency strategies used per action type:**


| Strategy                                      | Actions                                                                          | How                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Per-device timestamp guard (`timestamps` map) | `leave_page`, `rate_page`                                                        | Additive fields (`timeOnPage +=`, `likes +=`) skip if `entry.timestamp <= timestamps[deviceId]` |
| LWW timestamp guard (`deletedTs`)             | `delete_note`, `delete_snapshot`, `delete_list`                                  | Skip if `deletedTs >= entry.timestamp`                                                          |
| Duplicate check before insert                 | `pin_to_list`, `create_snapshot`, `create_note`                                  | `!array.includes(key)` / `!array.some(p => p.id === id)` before push                            |
| Existence check (skip if exists)              | `create_list`                                                                    | Skip entire operation if list entity already exists                                             |
| Pure overwrite / LWW                          | `visit_page`, `rename_page`, `update_setting`, `update_list_tree`, `update_list` | Last write wins — re-applying is a no-op                                                        |


**When adding a new action type to `effectOf`:** identify which strategy applies, implement the guard, and add an E2E test that seeds the entity on disk then replays the same log entry via `setLogBufferForTest` + `rehydrateForTest({ keepLogBuffer: true })`.

## Page Entities

### Entity Creation

Page entities are created **only by explicit user actions** — never by passive visits. The following actions create a page entity in `pages/<slug>.json` if one doesn't exist:

- `create_snapshot` — user captures a snapshot
- `create_note` — user creates a note on a page
- `pin_to_list` — user pins a page to a list
- `rename_page` — user sets a custom title
- `rate_page` — user likes/unlikes a page

`visit_page` and `leave_page` **only enrich existing entities** (title, attention data, referrer links). Passive visits that don't match an existing entity leave no entity footprint — they exist only as JSONL history entries.

All entity creation goes through `ensurePageEntity(url, ts, title)`, which sets `createdAt` to the entry timestamp when creating a new entity. `createdAt` is immutable — subsequent visits/actions do not overwrite it. Used as a stable sort tiebreaker in search results (relevance score primary, `createdAt` secondary).

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


| Prefix             | Meaning                                                                            | File Location                 |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| `page:<slug>`      | Page entity                                                                        | `pages/<slug>.json`           |
| `note:<slug>`      | Note entity                                                                        | `data/notes/<noteSlug>.json`  |
| `snap:<slug>-<ts>` | Snapshot (no entity file — exists in page `childIds` and `manifest/orphaned.json`) | `data/snapshots/<slug>-<ts>/` |
| `list:<id>`        | List entity                                                                        | `lists/<id>.json`             |


Used internally in: `page.parentIds`, `page.childIds`, list pin `id` fields. Notes use `url` (raw page URL) instead of typed references.

**Events never use typed references.** Events reference pages by URL, notes/snapshots by relative path (`notes/...`, `snapshots/...`), and lists by `listOwner` + `name` (compound key). `effectOf` translates between event fields and internal typed references.

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


| Module                    | Responsibility                                                          | Allowed APIs                                                                        |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **background.js**         | Business logic, event-sourced log, cache coordination, message dispatch | `chrome.storage.session/local`, `chrome.runtime`, `chrome.tabs`, `chrome.offscreen` |
| **offscreen.js**          | Filesystem I/O only (File System Access API needs document context)     | `chrome.runtime` (port only)                                                        |
| **content.js**            | DOM interaction, scroll/time tracking, highlight rendering              | `chrome.runtime.sendMessage`, `chrome.storage.session` (read workspace)             |
| **popup.js**              | Current-page dashboard UI                                               | `chrome.runtime.sendMessage`, `chrome.tabs.query`                                   |
| **options.js**            | Full UI: search, explore, lists, settings                               | `chrome.runtime.sendMessage`, `chrome.storage.session` (transient UI state)         |
| **replay.js**             | Pure event replay functions (no chrome APIs)                            | None                                                                                |
| **rule-engine.js**        | Pure rule matching (keyword/smart), validation, ID generation           | None                                                                                |
| **smart-rule-sandbox.js** | Sandboxed JS execution for smart rules (manifest sandbox page)          | `new Function` (via unsafe-eval CSP)                                                |
| **utils.js**              | Shared utilities, `readCacheable`, `sendAction`                         | `chrome.runtime.sendMessage`, `chrome.storage.session` (cache read)                 |
| **entity-cache.js**       | Session cache with LRU eviction                                         | `chrome.storage.session`                                                            |
| **filesystem-storage.js** | File System Access API wrapper                                          | File System Access, IndexedDB                                                       |


### Message Response Convention

All background.js message handlers return `{ success: true, ...fields }` on success and `{ success: false, error }` on failure. The `sendAction()` helper in utils.js throws on `success === false`.

### History Date Keys

`history:<YYYY-MM-DD>` keys in session cache hold the complete list of entries for that date — both drained (on-disk JSONL) and undrained (still in logBuffer). `addLog()` appends every new entry to the appropriate date key and pins it. This makes `readCacheable('history:<today>')` the canonical way for UI pages to get today's entries.

`readFs` handles `history:`* keys via offscreen `loadHistoryRange` (pure disk read, no replay — same as all other keys). During hydration, Phase 2.5 appends logBuffer entries to their `history:<date>` keys after Phase 2 entity replay. This ensures session cache has the complete view before any `readCacheable` call from UI pages.

**Post-hydration eviction safety**: `readFs` returns disk-only data without logBuffer replay. This is safe because keys with undrained logBuffer entries are protected from eviction:

- **Today's key**: pinned by hydration (Phase 1.5) and `addLog()` — never evicted.
- **Past date keys with undrained entries**: Phase 2.5 sets their timestamp from logBuffer entries. Since undrained timestamps > `persistWatermark`, watermark-gated eviction in `entity-cache.js` won't evict them until drain completes (at which point disk is complete).
- **Past date keys fully drained**: disk is the complete record — `readFs` returns correct data.

### Entity Cache Guarantees

Two invariants ensure `readCacheable('page:*')` / `readCacheable('note:*')` / etc. always return up-to-date data without replaying the logBuffer on read:

1. **Dirty entities are pinned (not evictable).** Every `addLog()` call replays via `effectOf` and writes updated entities to session cache. The entity-cache LRU only evicts entries whose `timestamp <= persistWatermark`. Undrained entities have timestamps newer than the watermark, so they cannot be evicted until drain completes (at which point disk matches the session state).
2. **Hydration pre-fills cache with all entities modified by logBuffer.** Phase 1.5 pre-loads page entities referenced by logBuffer from filesystem into session cache. Phase 2 then replays every logBuffer entry via `effectOf`, bringing all affected entities (pages, notes, lists, SPI, settings) up-to-date. By the time `hydrationDone` resolves and `readCacheable` becomes callable, every entity that has undrained mutations is already in session cache with the correct state.

**Consequence:** `readFs` (the filesystem fallback in `readCacheable`) does NOT need to replay logBuffer entries. For any key with undrained mutations, the session cache will have the up-to-date entity. `readFs` only runs on a true cache miss — meaning no undrained mutations exist for that key, so the disk checkpoint is authoritative.

### Progressive Search Architecture

Explore search uses four concurrent phases with a generation counter for cancellation:


| Phase | Source                                  | WASM fn                 | Concurrency |
| ----- | --------------------------------------- | ----------------------- | ----------- |
| 0     | In-memory `historyAllEntries`           | — (JS `wordsMatchItem`) | Instant     |
| 1     | `data/logs/{device}/*.jsonl`            | `searchBatch`           | 3 chunks    |
| 2a    | `data/notes/*.json`                     | `searchNotes`           | 1 call      |
| 2b    | `data/snapshots/*.md` (latest per slug) | `searchSnapshots`       | 2 chunks    |


All WASM functions read files directly from `FileSystemDirectoryHandle` refs — no JS↔WASM data copying. Phase 0 renders instantly; Phases 1/2a/2b fire concurrently and merge results incrementally via `mergeSearchResults` (dedup by URL, max score, track match sources). `renderProgressiveResults` enriches, filters, re-sorts, and calls `vs.updateData` after each merge.

**Dirty data**: Only `logBuffer` (undrained JSONL entries). Phase 1 reads it from `chrome.storage.local` and searches via JS `SearchEngine`. Notes and snapshots are flushed to disk before UI responds.

**Generation counter**: `searchGeneration` increments on each new search. Phase callbacks check their generation before merging — stale results from superseded queries are discarded silently.

**Query matching**: WASM `parse_query_words` splits on whitespace (quoted phrases stay together). All words must match (AND). Quoted words use word-boundary matching. Consistent with JS `parseSearchWords` / `wordsMatchItem`.

### Known Architectural Exceptions

**options.js direct FileSystemStorage access** — options.js instantiates its own `FileSystemStorage` for:

1. **Progressive WASM search** (`runPhase1`/`runPhase2a`/`runPhase2b`): passes `FileSystemDirectoryHandle` refs directly to WASM `searchBatch`/`searchNotes`/`searchSnapshots` for zero-copy file reads. Routing through background→offscreen would require serializing file contents across IPC boundaries.
2. **Directory picker UI** (`selectDirectory`): the File System Access `showDirectoryPicker()` API requires user gesture in a document context — can't be proxied through background.
3. **Settings page diagnostics** (`getDirectoryInfo`, data purge): inspects/manages the storage directory.

These bypass the background→offscreen pipeline. The tradeoff is acceptable because (a) the WASM search is read-only and operates on immutable files, (b) directory picker is a one-time setup action, (c) diagnostics are developer-facing.

## Rules (Materialized Search Rules)

### Design

Lists can have **rules** that automatically pin matching pages. Rules are event-sourced via `add_rule`, `remove_rule`, `update_rule` log actions. Two rule types:


| Type        | Matching                                   | Implementation                                                                                       |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **keyword** | Substring or `/regex/` match on title/url  | Pure function in `rule-engine.js`                                                                    |
| **smart**   | User-written JS function `(page) => score` | Offscreen → sandbox iframe (`smart-rule-sandbox.html`, manifest `sandbox` key for `unsafe-eval` CSP) |


### Data Model

List entity gains `rules: []` array. Each rule: `{ id, type, config, createdAt }`. Rule IDs: `rule-<type[0]>-<base36_ts>-<4char_hash>`.

### Page Body Text (`bodyPreview`)

content.js captures the first 200 words of `document.body.innerText` at visit time and sends it as `bodyPreview` in the `reportPage` message. background.js stores it in the `visit_page` JSONL entry. This enriches rule matching with page content beyond title/URL. The word limit is defined as `BODY_WORD_LIMIT` in `utils.js` (canonical) and duplicated in `content.js` (non-module, can't import).

For keyword rules, `matchKeywordRule` automatically checks `body` when present in `pageData`. For smart rules, `page.body` is accessible to user functions.

### Execution Flow

**Batch matching** (`runRuleBatch` handler in background.js):

1. Collect lists with non-empty `rules[]`
2. For each list × entry: build `pageData` (incl. `body` from `bodyPreview`) → call `matchRules()` with offscreen-routed sandbox closure
3. Auto-pin matching pages via `addLog({ action: 'pin_to_list' })`

**Preview** (`previewRule` handler in background.js):

- Dry-run matching without side effects. Uses `matchRules` with `allScores: true` to return raw scores for all entries (not just above-threshold matches).

**Smart sandbox**: background → offscreen port `executeSandboxFn` → sandbox iframe `postMessage` → `new Function('page', fnSource)(pageData)` → result clamped 0-1. 5s timeout.

### Security

**Threat model.** Users write their own smart rule functions — there is no untrusted third-party code execution. The primary risk is accidental misuse (infinite loops, unintended network calls) rather than adversarial attack. The sandbox exists as defense-in-depth, not as a trust boundary against a malicious author.

**Defense layers (defense-in-depth):**


| Layer                 | Mechanism                                                                                                                                                                                                                                                                                                                        | What it prevents                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Static validation** | `validateSmartRuleFn()` in `rule-engine.js` scans source with `\b<name>\b` word-boundary regex for 16 banned globals: `fetch`, `chrome`, `window`, `document`, `navigator`, `globalThis`, `eval`, `Function`, `setTimeout`, `setInterval`, `WebSocket`, `Worker`, `localStorage`, `sessionStorage`, `indexedDB`, `importScripts` | Network access, DOM manipulation, extension API access, dynamic code generation, timer abuse |
| **Size limit**        | Max 10KB source (`MAX_FN_SOURCE_BYTES`)                                                                                                                                                                                                                                                                                          | Resource exhaustion via oversized payloads                                                   |
| **Manifest sandbox**  | `smart-rule-sandbox.html` declared in manifest `"sandbox"` key — runs in a unique origin with no extension API access                                                                                                                                                                                                            | Even if validation is bypassed, `chrome.`* APIs are unavailable                              |
| **Iframe isolation**  | Sandbox loaded as hidden `<iframe>` inside offscreen document, communicates only via `postMessage`                                                                                                                                                                                                                               | No direct access to offscreen or background globals                                          |
| **Execution timeout** | 5-second timeout in `executeSandbox()` (`offscreen.js`)                                                                                                                                                                                                                                                                          | Infinite loops, long-running computations                                                    |
| **Output clamping**   | Return value coerced to number in 0–1 range                                                                                                                                                                                                                                                                                      | No data exfiltration via return value                                                        |


**Known gaps in static validation.** The word-boundary regex approach has inherent limitations:

- **Unbanned globals**: `Proxy`, `Reflect`, `Symbol`, `WeakRef`, `FinalizationRegistry`, `SharedArrayBuffer`, `Atomics`, `structuredClone` are not banned. These are low-risk in the sandbox context (no I/O, no DOM) but could be used for metaprogramming or object introspection.
- **String construction bypass**: `this.constructor.constructor('return fetch')()` or bracket notation (`this['constru' + 'ctor']`) can evade word-boundary regex. The manifest sandbox is the real enforcement layer here — even successfully constructing `fetch` would execute in a sandboxed origin with no cookies or extension permissions.
- **Property access**: `event.source` is available inside the `message` handler in `smart-rule-sandbox.js`, but user code runs inside `new Function('page', fnSource)` which does not close over `event`.

**Accepted risk.** Since users author their own rules, the static validation is a convenience guardrail (catch mistakes early with clear error messages), not a security boundary. The manifest sandbox provides the actual isolation guarantee.

### UI (Options Page)

Rules section is a collapsible glass panel inside `#listLayout`, between the header and `#listQueryBuilder`. Hidden for system lists (`system/`*). Shows rule count badge and Run button when rules exist.

- **Rendering**: `renderRulesSection(listId, rules)` shows/hides section + count badge; `renderRulesList()` renders entries with type badges (keyword=orange, smart=green) + remove buttons following `blacklist-entry` pattern.
- **Inline add form**: type toggle switches between keyword (pattern + field checkboxes) and smart (description + function textarea). Saves via `sendAction('addRule', ...)` with `{ type, config: {...} }` shape.
- **Preview button**: two-pass check — (1) recent visits from history (progressive batched, up to 100 checked / 20 matches), (2) all pinned pages in the current list. Entries missing `bodyPreview` are fetched on-the-fly via `fetchPageBody()` in options.js. Shows all results with green (match) / red (miss) score coloring.
- **Run button**: reads today's `visit_page` history, fetches `bodyPreview` on-the-fly for entries missing it, calls `runRuleBatch`, shows match count.
- **Mutation handler**: `type === 'rules'` mutation refreshes rules panel for the affected list via `refreshRulesForActiveList()`.

## Deletion

### Design: Unlink + Orphan (No Physical File Moves)

Deletion is a **logical operation**, not a physical one. Deleting a note, list, or snapshot appends a log entry (`delete_note`, `delete_list`, or `delete_snapshot`) that unlinks the entity from its parents and adds its key to `manifest/orphaned.json`. The entity file on disk (`data/notes/<slug>.json`, `lists/<id>.json`) or snapshot files (`data/snapshots/<slug>-<ts>/`) are never touched.

This design exists because of the event-sourced architecture. The JSONL history is the source of truth, and entity files are derived checkpoints rebuilt by replaying history. If deletion moved or removed files, replaying history would attempt to reference files that no longer exist at their expected paths — breaking replay idempotency. By keeping deletion as a pure relation change in the log, replay can be run any number of times and always produce a consistent result.

### What Each Deletion Does

`**delete_note` (replay.js):**

1. Unlinks `note:<slug>` from each parent page's `childIds`
2. Adds `note:<slug>` to `manifest/orphaned.json`
3. File `data/notes/<slug>.json` stays on disk

`**delete_snapshot` (replay.js):**

1. Unlinks `snap:<slug>-<ts>` from each parent page's `childIds`
2. Adds `snap:<slug>-<ts>` to `manifest/orphaned.json`
3. Snapshot directory `data/snapshots/<slug>-<ts>/` stays on disk

`**delete_list` (replay.js):**

1. Removes list from `manifest:list-order` tree via `removeFromTree` (promotes children to parent level)
2. Removes `list:<id>` from `parentIds` of all pinned pages
3. Adds `list:<id>` to `manifest/orphaned.json`
4. Removes list from `manifest/list-name-to-id.json`
5. File `lists/<id>.json` stays on disk
6. Non-cascading — only the target list is deleted; children stay in tree

`**replace_note` (replay.js):**

1. Derives parent page from old note's `url` field, unlinks old `note:<old-slug>` from page's `childIds`
2. Links new `note:<new-slug>` to the same page's `childIds`
3. Transfers list pins: finds lists via `findListsWithPin`, replaces old note ID with new note ID in each list's `pins` array
4. Copies `url` from old note to new note
5. Marks old note: `{ deleted: true, deletionReason: 'replaced', replacedBy: 'note:<new-slug>' }`
6. Adds old `note:<old-slug>` to `manifest/orphaned.json` entries (with parent URL)

Notes are immutable — editing creates a new entity via `replace_note` rather than mutating in place. This preserves the full change history of a page's notes in the JSONL log.

All handlers use `effectOf` in replay.js — all side-effects are computed in a single replay pass, not as separate log entries.

### The Orphaned Manifest

`manifest/orphaned.json` holds an array of entry objects `[{ key, url? }]` for deleted items. Each entry has a `key` (entity key like `note:<slug>`, `snapshot:<slug>-<ts>`, `list:<id>`) and an optional `url` (parent page URL for notes/snapshots). This serves as a "recycle bin" manifest: the keys are unlinked from the entity graph but the underlying files are intact and could be restored. The `url` field enables reliable restore without having to traverse entity relationships.

### File Persistence and Its Consequences

Because entity files survive deletion, a **second-order lookup** can still reach them. For example, if a page's `childIds` is `["note:abc"]` and `note:abc` was deleted, `loadPageNotes` will still find `notes/abc.json` on disk and return it — the note appears in the UI even though it was logically deleted. The `del_note` replay removes the key from the parent's `childIds`, so after replay completes, the reference is gone. But if the user *physically* deletes the file from the filesystem (e.g., via a future recycle-bin UI that offers permanent deletion), then the file is gone while stale references may still exist in older history entries. Replaying that history will hit a missing file.

Currently, `loadNote()` in filesystem-storage.js returns `null` for missing files (catches `NotFoundError`), and `loadPageNotes()` silently skips null results. This means missing files degrade silently — no crash, but no warning to the user either. A future improvement should surface these as warnings in the UI so users know data is missing rather than simply absent.

### Scope: What Can and Cannot Be Deleted


| Entity   | Deletion supported | Log action        | Notes                                                                              |
| -------- | ------------------ | ----------------- | ---------------------------------------------------------------------------------- |
| Note     | Yes                | `delete_note`     | Unlinks from parent page `childIds`                                                |
| Snapshot | Yes                | `delete_snapshot` | Unlinks from parent page `childIds`; no entity file (key-only)                     |
| List     | Yes                | `delete_list`     | Unlinks from all pinned pages, removes from sidebar, cascades to descendants       |
| Page     | Automatic (GC)     | —                 | Pages are GC'd during replay when they become ineligible (see Page Eligibility GC) |


**options.js direct chrome.storage.local** — Two call sites remain:

1. **Progressive search Phase 1** (`runPhase1`): reads undrained logBuffer entries to search separately from on-disk JSONL (see "Progressive Search Architecture" above).
2. **Settings diagnostics** (`updateStatistics`, `updateCacheTable`): read logBuffer to display byte sizes and entry counts in the cache inspector UI.

## Multi-Device Sync

### Design

Sync uses GitHub as a transport layer. Each device owns a branch in a shared repo, force-pushing a single orphan commit containing its current data. No merge conflicts — branches are independent.

```
Device A (branch: a1b2c3d4)           GitHub Repo              Device B (branch: e5f6g7h8)
  data/logs/a1b2c3d4/...     ──push──▶  branch per device  ◀──push──  data/logs/e5f6g7h8/...
  data/notes/...              ◀──pull──  read other branches ──pull──▶  data/notes/...
```

Scope: logs (within retention window) and notes. Snapshots excluded (too large).

### Module Architecture

```
sync-manager.js (pure logic, injected deps — fully unit-testable)
    ↓ uses
sync-transport-github.js (HTTP calls with retry)

background.js (wiring: alarms, message handlers, offscreen bridge)
    ↓ delegates filesystem to
offscreen.js (actions: collectSyncFiles, writeSyncFiles, loadSyncManifest, loadRemoteLogEntries)
    ↓ uses
filesystem-storage.js (File System Access API)
```

`SyncManager` receives all dependencies via constructor injection: `transport`, `collectLocalFiles`, `writeRemoteFiles`, `loadCursors`, `saveCursors`, `loadPushState`, `savePushState`. This makes it fully testable with mocked deps (no Chrome APIs).

### Push Cycle

1. `collectSyncFiles(deviceId, retentionDays)` via offscreen — scans `data/logs/<deviceId>/` (within retention) + all `data/notes/` → `[{path, content}]`
2. Hash each file content (djb2 → base36), compare against `manifest/sync-push-state.json`
3. If changes detected: `transport.pushTree(deviceId, changedFiles)` — creates blobs, tree, orphan commit, force-updates branch ref
4. Save updated hashes to push state manifest

### Pull Cycle

1. `transport.listBranches()` — discover peers, filter out own device
2. Load cursors from `manifest/sync-cursors.json`
3. For each peer: skip if `treeSha` unchanged (cursor hit) → `transport.getTree(sha)` → diff file SHAs against cursor → download changed blobs
4. Separate into logs (parse JSONL entries) vs notes (write to disk via `writeRemoteFiles`)
5. Return `{ remoteEntries: [{ deviceId, entries }] }` for caller to replay
6. Save updated cursors

### Remote Entry Replay

Remote entries use `effectOf` + `sessionWrite` — same replay pipeline as local entries — but do NOT:

- Append to local logBuffer (persisted in their own device-specific files)
- Drain to local JSONL (would duplicate)
- Update `history:<date>` session keys (remote visits stay out of local timeline)

Remote entries DO update entity state (pages, lists, notes, manifests) via session cache, checkpointed on next drain.

**Replay is idempotent** thanks to per-device `timestamps` map guards (see "Replay Idempotency Requirement" above). Full log files are re-replayed on pull — no line-offset tracking needed.

### Hydration with Multi-Device Logs

On startup, when `syncEnabled`:

1. Normal hydration (Phase 1 → 2) runs first (local entities + logBuffer)
2. `loadRemoteLogEntries(localDeviceId)` via offscreen scans all `data/logs/*/` directories, excludes local device
3. Each peer's entries replayed via `replayRemoteEntries(entries, peerDeviceId)`

### Sync Manifests

**Push state** (`manifest/sync-push-state.json`):

```json
{ "files": { "data/logs/dev1/2026-03-20.jsonl": "hash", ... } }
```

**Cursors** (`manifest/sync-cursors.json`):

```json
{ "cursors": { "peer-id": { "treeSha": "abc", "files": { "path": "blobSha" } } } }
```

### Error Handling

`performSync()` classifies errors:

- **Auth errors** (401/403) and **not-found** (404): permanent — disables alarm, sets `{ disabled: true }` in sync status. Options UI shows red "disabled" message.
- **Transient errors** (5xx, network): keeps retrying via alarm. Options UI shows red "will retry" message.

Transport layer (`_request`) retries transient errors with exponential backoff (500ms, 1000ms; max 2 retries). Rate-limit errors (403 + `X-RateLimit-Remaining: 0`) throw immediately without retry.

### Settings

Sync settings stored in `manifest/settings.json` alongside other extension settings:

- `syncEnabled` (boolean): master toggle
- `syncRepoUrl` (string): GitHub repo URL (parsed via `parseRepoUrl`)
- `syncToken` (string): GitHub personal access token
- `syncIntervalMinutes` (number, default 5): alarm interval
- `syncRetentionDays` (number, default 7): log files older than this excluded from push

## Verified Invariants (Property-Based Tests)

Property-based tests (`tests/replay-properties.test.js`) generate random event sequences via `fast-check` and verify that the replay engine preserves these structural invariants regardless of event content or ordering:

| ID | Invariant | Layer |
|----|-----------|-------|
| P1 | **Idempotency** — replaying any log entry twice against the same state produces no additive change (per-device timestamp guards prevent double-counting) | Vitest |
| P2 | **Referential integrity** — page `childIds` point to entities that exist or are orphaned; page `parentIds` pointing to `list:*` correspond to lists with matching pins; `name-to-id` paths all resolve to non-deleted lists; orphaned entries have `deleted: true` | Vitest |
| P3 | **Checkpoint equivalence** — splitting an event sequence at any point K, replaying [0..K) to produce checkpoints, then replaying [K..N) on top, produces the same final state as replaying all N events from scratch | Vitest |
| P4 | **Multi-device convergence** — all permutations of a cross-device event sequence produce the same final state for LWW-governed fields (`deleted`, `deletedTs`, `timestamps`) and manifest consistency (`name-to-id`, `list-order` tree) | Vitest |
| P5 | **Monotonic timestamps** — `entity.timestamps[device]` never decreases across sequential replay | Vitest |
| P6 | **Three-way consistency** — every non-deleted list entity appears in both `manifest:name-to-id` and `manifest:list-order` tree; every `name-to-id` entry points to a non-deleted list; every non-system tree node points to a non-deleted list | Vitest |
| P7 | **Sidebar list count** — sidebar item count equals the number of non-deleted, non-system list entities | E2E |
| P8 | **List pin count** — clicking a list shows exactly as many pinned rows as the entity's `pins` array | E2E |
| P9 | **Recycle bin consistency** — `manifest:orphaned` entry count matches the background-reported orphan count, and each orphaned entity is marked `deleted: true` | E2E |
| P10 | **History ordering** — explore view displays history entries sorted newest-first by timestamp | E2E |

When adding new `effectOf` action branches or modifying entity relationships, run `npm test -- tests/replay-properties.test.js` to verify these invariants still hold under randomized input.

