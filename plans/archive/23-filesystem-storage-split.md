# 23 — FileSystemStorage Split

## Context

`filesystem-storage.js` is 1082 lines with 36+ methods. It manages two independent directory handles: `directoryHandle` (main data) and `syncDirectoryHandle` (sync folder). The sync handle has its own IndexedDB key (`'syncDirectory'` vs `'directory'`), its own permission flow, and its own set of 9 I/O methods. There is zero shared state between the two handles at runtime.

## Methods to extract

**Sync-handle methods** (own `syncDirectoryHandle`, completely independent):
- `selectSyncDirectory()` — line 934
- `_getSyncDir()` — line 955
- `syncFsListDeviceDirs()` — line 976
- `syncFsListFiles(deviceDir)` — line 985
- `_syncWalkDir(dirHandle, prefix, results)` — line 994 (private helper)
- `syncFsReadFile(path)` — line 1006
- `syncFsWriteFile(path, content)` — line 1018
- `syncFsEnsureDir(path)` — line 1031
- `syncFsRemoveFile(path)` — line 1039

**Main-handle sync methods** (use `directoryHandle` but only called during sync):
- `collectSyncFiles(deviceId, retentionDays)` — line 861
- `writeSyncFiles(files)` — line 897
- `loadRemoteLogEntries(localDeviceId)` — line 911

## Design

New file: `extension/filesystem-sync-storage.js` (~300 lines).

```js
export class FileSystemSyncStorage {
  constructor(mainStorage) {
    this.mainStorage = mainStorage; // for collectSyncFiles/writeSyncFiles/loadRemoteLogEntries
    this.syncDirectoryHandle = null;
    this.dbName = 'PortalFS';
    this.storeName = 'handles';
  }

  // 9 sync-handle methods (moved from FileSystemStorage)
  async selectSyncDirectory() { ... }
  async _getSyncDir() { ... }
  async syncFsListDeviceDirs() { ... }
  async syncFsListFiles(deviceDir) { ... }
  async syncFsReadFile(path) { ... }
  async syncFsWriteFile(path, content) { ... }
  async syncFsEnsureDir(path) { ... }
  async syncFsRemoveFile(path) { ... }

  // 3 main-handle sync methods (delegate to this.mainStorage)
  async collectSyncFiles(deviceId, retentionDays) {
    return this.mainStorage.collectSyncFiles(deviceId, retentionDays);
  }
  async writeSyncFiles(files) {
    return this.mainStorage.writeSyncFiles(files);
  }
  async loadRemoteLogEntries(localDeviceId) {
    return this.mainStorage.loadRemoteLogEntries(localDeviceId);
  }
}
```

Wait — for `collectSyncFiles`/`writeSyncFiles`/`loadRemoteLogEntries`, these use the main handle's `resolveDir`, `resolveFile`, `_scanLogFiles`, `_loadFromDeviceFiles`. Simplest approach: **keep them in `FileSystemStorage`** and have `FileSystemSyncStorage` delegate to `this.mainStorage` for those 3. This avoids duplicating internal helpers.

## Files changed

1. **filesystem-sync-storage.js** (new, ~200 lines) — sync-handle class with 9 methods + 3 delegating methods
2. **filesystem-storage.js** (1082 → ~880 lines) — remove 9 sync-handle methods; keep `collectSyncFiles`/`writeSyncFiles`/`loadRemoteLogEntries`
3. **offscreen.js** — `import { FileSystemSyncStorage } from './filesystem-sync-storage.js'`; instantiate `new FileSystemSyncStorage(fsStorage)`; route sync-related `handleRequest` cases to it
4. **options.js** — uses `FileSystemStorage` for directory picker and WASM search only; `selectSyncDirectory` call (line ~3783) moves to `FileSystemSyncStorage` import
5. **tests/filesystem-sync-storage.test.js** (new)

## Test strategy

- TDD: write tests for the new class's methods
- All existing unit tests pass (split is mechanical)
- All E2E sync tests pass (`tests/e2e/sync-*.spec.js` if they exist)

## Risk

Low-medium. The seam is clean — the two handles share no runtime state.
