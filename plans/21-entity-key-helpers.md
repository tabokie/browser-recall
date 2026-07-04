# 21 — Entity Key Helpers

## Context

Entity key-prefix dispatch (`key.startsWith('page:')`, `key.slice('page:'.length)`) appears in 8 locations with slightly different logic. `replay.js` defines unexported `PAGE_PREFIX`/`NOTE_PREFIX`/`SNAPSHOT_PREFIX` at lines 9-11. `entity-types.js` is only 10 lines. Centralizing the vocabulary first lets every subsequent plan import from a single source.

## Duplication inventory

| Location | File | Lines | Prefixes handled |
|----------|------|-------|-----------------|
| `readFs()` | background.js | 451-517 | manifest:settings/name-to-id/orphaned/list-order, log:, page:, note:, list: |
| `ensureLoaded()` | offscreen.js | 520-564 | page:, manifest:settings, list:, manifest:orphaned, note:, manifest:name-to-id, manifest:list-order |
| Flush loop | offscreen.js | 625-669 | page:, note:, manifest:settings, list:, manifest:orphaned/name-to-id/list-order |
| `defaultEntity()` | replay.js | 66-84 | page:, note:, manifest:settings/orphaned/list-order/name-to-id, list: |
| `entityTypeLabel()` | entity-types.js | 4-10 | snapshot:, note:, list:, page: |
| `defaultPinned()` | entity-cache.js | 27-33 | workspace, manifest:, list: |
| Restore/delete | options.js | 929-985 | snapshot:, note:, list:, page: |
| `permanentDelete` | background.js | 2241-2294 | note:, list:, snapshot: |

## Design

Expand `extension/entity-types.js` (~10 → ~50 lines):

```js
// --- Prefix constants ---
export const PAGE_PREFIX = 'page:';
export const NOTE_PREFIX = 'note:';
export const SNAPSHOT_PREFIX = 'snapshot:';
export const LIST_PREFIX = 'list:';
export const MANIFEST_PREFIX = 'manifest:';

// --- Key constructors ---
export const pageKey = (slug) => PAGE_PREFIX + slug;
export const noteKey = (slug) => NOTE_PREFIX + slug;
export const listKey = (id) => LIST_PREFIX + id;
export const snapshotKey = (stem) => SNAPSHOT_PREFIX + stem;

// --- Key parsing ---
export function entityPrefix(key) {
  // Returns 'page:', 'note:', etc. or null
  for (const p of [PAGE_PREFIX, NOTE_PREFIX, SNAPSHOT_PREFIX, LIST_PREFIX, MANIFEST_PREFIX])
    if (key.startsWith(p)) return p;
  return null;
}
export function entitySlug(key) {
  const p = entityPrefix(key);
  return p ? key.slice(p.length) : key;
}

// --- Helpers ---
export function isSystemList(key) {
  return key.startsWith(LIST_PREFIX + 'system/');
}

// --- Existing (unchanged) ---
export function entityTypeLabel(key) { ... }
```

No dispatch table — each consumer still has its own per-prefix logic. But the `startsWith` + `slice` boilerplate is eliminated everywhere.

## Files changed

1. **entity-types.js** — expand with constants, constructors, parsing
2. **replay.js** — `import { PAGE_PREFIX, NOTE_PREFIX, SNAPSHOT_PREFIX, pageKey, noteKey, snapshotKey, listKey } from './entity-types.js'`; remove local constants at lines 9-11; replace `'page:' + slug` → `pageKey(slug)`, `key.slice('page:'.length)` → `entitySlug(key)`, etc.
3. **entity-cache.js** — import `LIST_PREFIX`, `MANIFEST_PREFIX` for `defaultPinned()`
4. **background.js** — import for `readFs()` key parsing, `permanentDelete`/`permanentDeleteAll` prefix checks, badge logic
5. **offscreen.js** — import for `ensureLoaded()`, flush dispatch
6. **options.js** — import for recycle bin display/restore (~20 scattered checks)
7. **tests/entity-types.test.js** (new) — ~30 tests for new helpers

## Test strategy

- TDD: write unit tests for `entityPrefix`, `entitySlug`, `pageKey`, `noteKey`, `listKey`, `snapshotKey`, `isSystemList` first
- Run `npx vitest run` — all existing unit tests pass (pure mechanical replacement)
- Run `npx playwright test` — all E2E tests pass

## Risk

Low — no behavior change; purely mechanical replacement of string literals with imports.
