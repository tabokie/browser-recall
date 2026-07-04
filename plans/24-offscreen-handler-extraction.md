# 24 — Offscreen Handler Extraction

## Context

`handleRequest()` in `offscreen.js` (line 82) is a 380-line switch with 43 cases. Each case is a 3-10 line block calling `fsStorage` methods and returning `{ success: true, ... }`. The function also contains the `drainQueue()` function (lines 483-696) with duplicated entity key-prefix dispatch in `ensureLoaded()` (lines 520-564) and the flush loop (lines 625-669).

## Design

### Part A: Extract case bodies

Each case body becomes a named function above the switch. The switch becomes 43 one-liner dispatches:

```js
async function handleLoadPageBatch(request) {
  const pages = await fsStorage.loadPageBatch(request.slugs);
  return { success: true, pages };
}

// ... 43 handlers

async function handleRequest(request) {
  if (request.action !== 'initializeFilesystem' && request.action !== 'setTestDirectory') {
    await initDone;
  }
  try {
    switch (request.action) {
      case 'loadPageBatch': return await handleLoadPageBatch(request);
      // ... 43 one-liners
      default: return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (error) { ... }
}
```

Group handlers with section comments:
- Filesystem lifecycle (initializeFilesystem, hasDirectoryHandle, clearDirectoryHandleForTest)
- Entity reads (loadPageBatch, pageExists, loadNote, loadPageNotes, loadAllNotes, loadListPins, loadListPinsById, loadListEntity, listListFiles, loadAllListMetadata)
- Snapshot ops (listSnapshots, captureSnapshot, getSnapshotUrl, getSnapshotHtml, deleteSnapshot)
- History (listHistoryFiles, loadHistoryBatch, loadHistoryRange)
- Manifest/directory (getDirectoryInfo, loadOrphaned, loadCurrent, initDevice, deleteCurrent, loadSettings, loadNameMap, loadListOrder)
- Log drain (flushLogBuffer)
- JSON I/O (saveJson)
- Sync (loadSyncManifest, loadRemoteLogEntries, collectSyncFiles, writeSyncFiles, syncFs*)
- Test (setTestDirectory, resetDirectory, seedTestData)
- Sandbox (executeSandboxFn)

### Part B: Use entity-types.js constants in drainQueue

In `ensureLoaded()` (lines 520-564) and the flush loop (lines 625-669), replace `key.startsWith('page:')` with `key.startsWith(PAGE_PREFIX)` etc., using imports from plan 21.

## Files changed

1. **offscreen.js** — restructure in place (line count roughly same, much more scannable)

## Test strategy

- All existing tests pass (no behavioral change)
- E2E is the primary safety net

## Risk

Low — mechanical extraction, each case body is self-contained.
