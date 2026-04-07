# 25 — Background Handler Extraction

## Context

`background.js` is 2926 lines. The `chrome.runtime.onMessage` handler (line ~1530) has 63 cases spanning 1290 lines. `hydrateCache()` (lines 519-751) has 6 phases in 230 lines. `reportPage` (line 1601) is 130 lines.

All handlers close over 15+ module-scope variables: `logBuffer`, `logBufferWatermark`, `localDeviceId`, `recentUrls`, `tabReportedUrls`, `serviceError`, `offscreenPort`, `portCallbacks`, `syncSessionToken`, `pausedDevices`, `lastSyncResult`, `rateLimitedUntil`, etc. — plus utility functions `addLog`, `readCacheable`, `requestOffscreen`, `drainNow`, `cacheGet`, `cacheSet`, `notifyMutation`, `sessionLoad`, `sessionWrite`, `withLock`. Moving handlers to separate files would require passing all of these. **All handlers stay in the same file.**

## Design

### Part A: Extract hydrateCache phases

The 6 phases become named functions:

```js
async function hydrateBaseEntities()        // lines 525-556: settings, lists, list-order, name-to-id
async function hydrateHistoryCache()        // lines 562-648: today + recent days + recentUrls map
async function hydrateBufferPages()         // lines 650-699: dedup logBuffer, pre-load page entities
async function replayBufferEntries()        // lines 701-709: replay logBuffer via effectOf
async function appendBufferToHistoryKeys()  // lines 711-745: append logBuffer entries to history date keys
// Remote log replay already a separate function: replayRemoteEntries()
```

The main `hydrateCache()` becomes a coordinator calling each phase in order.

### Part B: Extract reportPage

The `reportPage` case (line 1601, 130 lines) becomes:

```js
async function handleReportPage(request, sender) {
  // blacklist check, URL tracking, workspace auto-pin, smart-rule evaluation,
  // leave-page handling, title trimming, referrer resolution, badge updates
  // Returns the response object
}
```

### Part C: Extract all 63 case bodies

Each case becomes a named handler function. The switch becomes one-line dispatches:

```js
case 'reportPage': return handleReportPage(request, sender);
case 'getPageInfo': return handleGetPageInfo(request);
// ... 63 one-liners
```

Section comment grouping:

| Group | Cases | Count |
|-------|-------|-------|
| Tab/popup queries | getReportedUrl, getPageInfo, captureCurrentPageFromPopup, hydrateCache | 4 |
| Page lifecycle | reportPage | 1 |
| Cache/queue | clearWriteQueue, flushLogBuffer, getDeviceId, readCacheable | 4 |
| Entity reads (relay to offscreen) | loadPageNotes, listSnapshots, getSnapshotUrl, getSnapshotHtml, openSnapshot, getDirectoryInfo, listHistoryFiles, loadHistoryBatch | 8 |
| Page relations | getPageRelations | 1 |
| Context menu | contextMenuHighlight | 1 |
| Settings | saveSettingsKey | 1 |
| Note mutations | createNote, deleteNote, updateNote | 3 |
| List mutations | toggleListPin, addListPins, saveListMeta, deleteList, updateListTree | 5 |
| Recycle bin | restoreNote, restoreSnapshot, restoreList, permanentDelete, permanentDeleteAll | 5 |
| Filesystem | initializeFilesystem, hasDirectoryHandle, deleteSnapshot, setTestDirectory | 4 |
| Rules | addRule, removeRule, updateRule, runRuleBatch, previewRule | 5 |
| Sync | syncNow, getSyncStatus, syncListDevices, updateSyncSettings, setSyncToken, clearSyncToken, toggleSyncRemember, getSyncAuthState, getSyncDevices, toggleSyncDevicePaused, deleteSyncDevice | 11 |
| Test helpers | resetForTest, pauseServiceForTest, resumeService, clearDirectoryHandleForTest, killOffscreenForTest, setRateLimitForTest, setLogBufferForTest, rehydrateForTest, seedTestData, simulatePreHydrationForTest, clearDeviceIdForTest | 11 |

## Files changed

1. **background.js** — restructure in place (line count roughly same, much more scannable)

## Test strategy

- All existing unit tests pass (tests/report-page.test.js, tests/log-buffer.test.js, tests/history-cache.test.js, tests/message-routing.test.js, tests/downtime.test.js, etc.)
- All E2E tests pass
- Add unit tests for hydration phase functions if independently testable

## Risk

Medium — large file, many cross-references, but mechanical transformation. The key constraint is that all handlers stay in the same file due to shared module state.
