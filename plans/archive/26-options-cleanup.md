# 26 — Options.js Cleanup

## Context

`options.js` is 5461 lines with multiple issues:
- `createSidebarItem()` (lines 3149-3354, 200+ lines): DOM creation with inline 3-zone drag-drop handlers and tree mutation
- `renderBlacklist()` (lines 4313-4337) and `renderTrimRules()` (lines 4375-4400): Nearly identical render+bind+delete patterns
- `runPreview()` (lines 1994-2115, 122 lines): Two clear phases mixed together
- View-container resolution duplicated 3x in keyboard handlers (Delete:5377-5380, Ctrl+C:5407-5422, Ctrl+A:5447-5460)
- Progressive search has 10+ coupled globals (lines 130-176, 305-308)
- History loading has 10+ coupled globals (lines 137-176)
- Mutation listener (lines 4425-4493) has complex bi-directional title merge logic

## Design

### Part A: Deduplicate blacklist / trim-rules

Extract generic settings list renderer:

```js
function renderSettingsList({ containerId, loadFn, saveFn, renderItemHtml, emptyMessage }) {
  // Shared: load items, map to HTML, set innerHTML, bind remove buttons, re-render on delete
}
```

`renderBlacklist()` and `renderTrimRules()` become thin wrappers providing their specific `renderItemHtml` and `loadFn`/`saveFn`.

### Part B: Break createSidebarItem into sub-functions

```js
function createSidebarItemDOM(node, depth)           // Pure DOM creation (~30 lines)
function bindSidebarItemDragDrop(item, node, depth)  // Drag event binding (~100 lines)
function handleSidebarDrop(event, targetNode, tree)   // Tree mutation on drop (~60 lines)
```

The 3-zone detection (`relY < 0.25` / `> 0.75` / middle) stays in `bindSidebarItemDragDrop` but the tree manipulation logic (extractNode, appendToTarget, insertNear) moves to `handleSidebarDrop`.

### Part C: Extract getActiveContainer()

Replace the 3 duplicated lookups in keyboard handlers:

```js
function getActiveContainer() {
  if (activeView.type === 'list' || activeView.type === 'explore')
    return document.getElementById('results');
  if (activeView.type === 'category')
    return document.getElementById('results');
  // etc.
  return null;
}
```

Delete, Ctrl+C, Ctrl+A handlers all call `getActiveContainer()` instead of inline mapping.

### Part D: Split runPreview

```js
async function runPreviewAgainstHistory(rule, listId)  // Lines 2028-2078: 30-day batch processing
async function runPreviewAgainstPins(rule, listId)     // Lines 2080-2106: pinned pages matching
```

`runPreview()` becomes coordinator: validate → clear state → call both → `rerenderPreview()`.

### Part E: Group coupled globals

Mechanical rename into state objects:

```js
// Before (scattered lines 130-176, 305-308):
let searchGeneration = 0;
let searchResults = [];
let searchPendingPhases = 0;
let historyFiles = [];
let historyLoadedCount = 0;
let historyByUrl = new Map();
let historyAllEntries = [];
let historyLoading = false;
// ... etc.

// After:
const searchState = {
  generation: 0,
  results: [],
  pendingPhases: 0,
};
const historyState = {
  files: [],
  loadedCount: 0,
  byUrl: new Map(),
  allEntries: [],
  loading: false,
  fileBatch: 7,
  avgEntrySize: 200,
};
```

All references updated via search-and-replace within the file. This makes it clear which variables are coupled, and makes `resetHistory()` a simple object reset.

### Part F: Extract mutation merge logic

The history-type mutation handler (lines 4346-4376) has complex bi-directional title merge logic. Extract:

```js
function mergeHistoryEntry(newEntry, existing) {
  // Back-fill title onto new entry from existing
  // Back-fill user_title onto new entry from existing
  // Patch existing if it lacked title but new has one
  // Returns merged entry
}
```

## Files changed

1. **options.js** — restructure in place

## Test strategy

- E2E tests are the primary safety net (`tests/e2e/lists.spec.js`, `tests/e2e/settings.spec.js`, `tests/e2e/search.spec.js`, `tests/e2e/rules.spec.js`, `tests/e2e/recycle-bin.spec.js`)
- Add unit tests for `renderSettingsList`, `getActiveContainer`, `mergeHistoryEntry` if feasible with jsdom

## Risk

Low-medium. All changes are within one file; E2E coverage is strong.
