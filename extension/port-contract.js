// Port message contract: background ↔ offscreen via 'bg-offscreen' port channel.
//
// Each entry defines the action name, expected request fields (beyond `action`
// and `id`), and expected response fields (beyond `id` and `success`).
// Pattern: 'request-response' (default) or 'fire-and-forget'.
// Direction: 'bg→os' (default) or 'os→bg'.
//
// Used by contract tests to verify that offscreen responses match the declared
// shapes. Runtime validation is intentionally omitted — the contract is enforced
// by tests, not by production guards.

export const PORT_CONTRACT = {
  // ── Lifecycle ──
  initializeFilesystem: {
    request: [],
    response: [],
  },
  getDirectoryInfo: {
    request: [],
    response: ['info'],
  },
  getDirectorySize: {
    request: [],
    response: ['size'],
  },

  // ── Snapshots ──
  listSnapshots: {
    request: ['slug'],
    response: ['snapshots'],
  },
  captureSnapshot: {
    request: ['slug', 'timestamp'],
    optionalRequest: ['markdown', 'html'],
    response: [],
  },
  getSnapshotUrl: {
    request: ['slug', 'timestamp'],
    response: ['url'],  // absent on success:false
  },
  getSnapshotHtml: {
    request: ['slug', 'timestamp'],
    response: ['html'],  // absent on success:false
  },
  deleteSnapshot: {
    request: ['slug', 'timestamp'],
    response: [],
  },

  // ── Notes ──
  loadNote: {
    request: ['noteSlug'],
    response: ['note'],
  },
  saveNote: {
    request: ['slug', 'data'],
    response: [],
  },
  deleteNote: {
    request: ['noteSlug'],
    response: [],
  },
  loadPageNotes: {
    request: ['slug'],
    response: ['notes'],
  },
  loadAllNotes: {
    request: [],
    response: ['notesMap'],
  },

  // ── Pages ──
  loadPageBatch: {
    request: ['slugs'],
    response: ['pages'],
  },
  pageExists: {
    request: ['slug'],
    response: ['exists'],
  },

  // ── Lists ──
  loadListPins: {
    request: [],
    optionalRequest: ['listId'],
    response: ['pins'],
  },
  loadListPinsById: {
    request: ['listId'],
    response: ['pins'],
  },
  loadListEntity: {
    request: ['listId'],
    response: ['entity'],
  },
  deleteListFile: {
    request: ['listId'],
    response: [],
  },
  listListFiles: {
    request: [],
    response: ['files'],
  },
  loadAllListMetadata: {
    request: [],
    response: ['lists'],
  },

  // ── Manifest Entities ──
  loadOrphaned: {
    request: [],
    response: ['entity'],
  },
  loadCurrent: {
    request: [],
    response: ['deviceId'],
  },
  initDevice: {
    request: ['deviceId'],
    response: [],
  },
  deleteCurrent: {
    request: [],
    response: [],
  },
  loadSettings: {
    request: [],
    response: ['settings'],
  },
  loadNameMap: {
    request: [],
    response: ['entity'],
  },
  loadListOrder: {
    request: [],
    response: ['entity'],
  },

  // ── History ──
  listHistoryFiles: {
    request: [],
    optionalRequest: ['includeSizes'],
    response: ['files'],
    optionalResponse: ['sizes'],
  },
  loadHistoryBatch: {
    request: ['files'],
    response: ['entries'],
  },
  loadHistoryRange: {
    request: ['from', 'to'],
    response: ['entries', 'files'],
  },

  // ── Log Buffer ──
  flushLogBuffer: {
    request: [],
    optionalRequest: ['entries'],
    response: [],
  },
  drainEntries: {
    request: ['entries'],
    optionalRequest: ['deviceId'],
    pattern: 'fire-and-forget',
  },

  // ── Persisted watermark (offscreen → background) ──
  persisted: {
    request: ['watermark'],
    pattern: 'fire-and-forget',
    direction: 'os→bg',
  },

  // ── Direct I/O ──
  saveJson: {
    request: ['path', 'data'],
    response: [],
  },

  // ── Sync ──
  loadSyncManifest: {
    request: ['key'],
    response: ['data'],  // null when file not found
  },
  loadRemoteLogEntries: {
    request: ['localDeviceId'],
    response: ['remotes'],
  },
  collectSyncFiles: {
    request: ['deviceId', 'retentionDays'],
    response: ['files'],
  },
  writeSyncFiles: {
    request: ['files'],
    response: [],
  },

  // ── Filesystem Sync Transport ──
  syncFsListDeviceDirs: {
    request: [],
    response: ['dirs'],
  },
  syncFsListFiles: {
    request: ['deviceDir'],
    response: ['files'],
  },
  syncFsReadFile: {
    request: ['path'],
    response: ['content'],
  },
  syncFsWriteFile: {
    request: ['path', 'content'],
    response: [],
  },
  syncFsEnsureDir: {
    request: ['path'],
    response: [],
  },
  syncFsRemoveFile: {
    request: ['path'],
    response: [],
  },

  // ── Sandbox ──
  executeSandboxFn: {
    request: ['fnSource', 'pageData'],
    response: ['score'],
  },

  // ── Test Helpers ──
  setTestDirectory: {
    request: [],
    response: [],
  },
  resetDirectory: {
    request: [],
    response: [],
  },
  seedTestData: {
    request: ['files'],
    response: [],
  },
};
