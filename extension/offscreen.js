// Offscreen document — pure filesystem I/O worker.
//
// Responds to read requests from background via port channel.
// Background sends 'drainEntries' messages via port when logBuffer has new entries;
// offscreen drains them to the filesystem (JSONL append + entity checkpoint).
// chrome.storage is NOT available in offscreen — only chrome.runtime is.
//
// Why offscreen? MV3 service workers have no document context. The File System
// Access API requires a document to store FileSystemDirectoryHandle in IndexedDB
// and call its methods.
import { FileSystemStorage } from './filesystem-storage.js';
import { FileSystemSyncStorage } from './filesystem-sync-storage.js';
import { effectOf, defaultEntity } from './replay.js';
import { generateNoteSlug, dateKeyFromTimestamp } from './utils.js';
import { logDebug, logError } from './logger.js';
import {
  PAGE_PREFIX,
  NOTE_PREFIX,
  LIST_PREFIX,
  entitySlug,
  isSystemList,
  snapshotKey,
} from './entity-types.js';

logDebug('Offscreen document loaded');

const fsStorage = new FileSystemStorage();
const fsSyncStorage = new FileSystemSyncStorage(fsStorage);

// ─── Port Channel ─────────────────────────────────────────────────────

let bgPort = null;
let pendingWatermark = 0; // Stored when drain completes but port is disconnected

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bg-offscreen') return;
  bgPort = port;
  logDebug('Port connected to background');

  // Deliver any watermark that was pending while port was disconnected
  if (pendingWatermark > 0) {
    port.postMessage({ action: 'persisted', watermark: pendingWatermark });
    pendingWatermark = 0;
  }

  port.onMessage.addListener(async (msg) => {
    // Fire-and-forget drain trigger from background (no response needed)
    if (msg.action === 'drainEntries') {
      pendingDrainEntries = msg.entries;
      if (msg.deviceId) pendingDeviceId = msg.deviceId;
      scheduleDrain();
      return;
    }
    const result = await handleRequest(msg);
    port.postMessage({ id: msg.id, ...result });
  });

  port.onDisconnect.addListener(() => {
    bgPort = null;
    logDebug('Port disconnected from background');
  });
});

// ─── Per-File Lock ────────────────────────────────────────────────────

const fileLocks = new Map();

const LOCK_TIMEOUT_MS = 30000;

function withLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `withLock('${key}') timed out after ${LOCK_TIMEOUT_MS}ms`,
            ),
          );
        }, LOCK_TIMEOUT_MS);
        fn().then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    });
  fileLocks.set(key, next);
  next
    .catch(() => {})
    .then(() => {
      if (fileLocks.get(key) === next) fileLocks.delete(key);
    });
  return next;
}

// ─── Request Handlers: Filesystem Lifecycle ──────────────────────────

async function handleInitializeFilesystem() {
  await initialize();
  return { success: true };
}

function handleHasDirectoryHandle() {
  return { success: true, hasHandle: !!fsStorage.directoryHandle };
}

function handleClearDirectoryHandleForTest() {
  fsStorage.directoryHandle = null;
  return { success: true };
}

// ─── Request Handlers: Entity Reads ──────────────────────────────────

async function handleLoadPageBatch(request) {
  const t0 = performance.now();
  const pages = await fsStorage.loadPageBatch(request.slugs);
  logDebug(
    `[I/O] loadPageBatch: ${request.slugs.length} slugs in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, pages };
}

async function handlePageExists(request) {
  const exists = await fsStorage.pageExists(request.slug);
  return { success: true, exists };
}

async function handleLoadNote(request) {
  const note = await fsStorage.loadNote(request.noteSlug);
  return { success: true, note };
}

async function handleSaveNote(request) {
  await fsStorage.saveNote(request.slug, request.data);
  return { success: true };
}

async function handleDeleteNote(request) {
  await fsStorage.deleteNote(request.noteSlug);
  return { success: true };
}

async function handleDeleteListFile(request) {
  await fsStorage.deleteListFile(request.listId);
  return { success: true };
}

async function handleLoadPageNotes(request) {
  const t0 = performance.now();
  const notes = await fsStorage.loadPageNotes(request.slug);
  logDebug(
    `[I/O] loadPageNotes(${request.slug}): ${notes.length} notes in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, notes };
}

async function handleLoadAllNotes() {
  const t0 = performance.now();
  const notesMap = await fsStorage.loadAllNotes();
  logDebug(
    `[I/O] loadAllNotes: ${Object.keys(notesMap).length} pages in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, notesMap };
}

async function handleLoadAllPages() {
  const t0 = performance.now();
  const pages = await fsStorage.loadAllPages();
  logDebug(
    `[I/O] loadAllPages: ${Object.keys(pages).length} pages in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, pages };
}

async function handleLoadListPins(request) {
  const t0 = performance.now();
  if (request.listId) {
    const pins = await fsStorage.loadListPinsById(request.listId);
    logDebug(
      `[I/O] loadListPins(${request.listId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return { success: true, pins };
  } else {
    const allPins = await fsStorage.loadListPins();
    logDebug(
      `[I/O] loadListPins: ${Object.keys(allPins).length} lists in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return { success: true, pins: allPins };
  }
}

async function handleLoadListPinsById(request) {
  const t0 = performance.now();
  const pins = await fsStorage.loadListPinsById(request.listId);
  logDebug(
    `[I/O] loadListPinsById(${request.listId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, pins };
}

async function handleLoadListEntity(request) {
  const t0 = performance.now();
  const entity = await fsStorage.loadListPinsEntity(request.listId);
  logDebug(
    `[I/O] loadListEntity(${request.listId}): ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, entity };
}

// List file IDs from lists/ (excluding system/)
async function handleListListFiles() {
  const files = [];
  try {
    const listsDir = await fsStorage.resolveDir('lists');
    for await (const entry of listsDir.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.json')) {
        const id = entry.name.replace('.json', '');
        if (!id.startsWith('system') && !id.startsWith('index')) {
          files.push(id);
        }
      }
    }
  } catch {
    /* lists/ may not exist */
  }
  return { success: true, files };
}

async function handleLoadAllListMetadata() {
  const t0 = performance.now();
  const lists = await fsStorage.loadAllListMetadata();
  logDebug(
    `[I/O] loadAllListMetadata: ${lists.length} lists in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, lists };
}

// ─── Request Handlers: Snapshot Ops ──────────────────────────────────

async function handleListSnapshots(request) {
  const t0 = performance.now();
  const snapshots = await fsStorage.listSnapshots(request.slug);
  logDebug(
    `[I/O] listSnapshots(${request.slug}): ${snapshots.length} snapshots in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, snapshots };
}

async function handleCaptureSnapshot(request) {
  await withLock(snapshotKey(request.slug), () =>
    fsStorage.captureSnapshot(
      request.slug,
      request.timestamp,
      request.markdown || '',
      request.html || '',
    ),
  );
  return { success: true };
}

async function handleGetSnapshotUrl(request) {
  const url = await fsStorage.getSnapshotBlobUrl(
    request.slug,
    request.timestamp,
  );
  return url ? { success: true, url } : { success: false, error: 'Not found' };
}

async function handleGetSnapshotHtml(request) {
  const html = await fsStorage.getSnapshotHtml(request.slug, request.timestamp);
  return html
    ? { success: true, html }
    : { success: false, error: 'Not found' };
}

async function handleDeleteSnapshot(request) {
  await fsStorage.deleteSnapshot(request.slug, request.timestamp);
  return { success: true };
}

// ─── Request Handlers: History ───────────────────────────────────────

async function handleListHistoryFiles(request) {
  const files = await fsStorage.listHistoryFiles();
  const resp = { success: true, files };
  if (request.includeSizes) {
    resp.sizes = await fsStorage.listHistoryFileSizes();
  }
  return resp;
}

async function handleLoadHistoryBatch(request) {
  const t0 = performance.now();
  const entries = await fsStorage.loadHistoryFiles(request.files);
  logDebug(
    `[I/O] loadHistoryBatch: ${request.files.length} files, ${entries.length} items in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, entries };
}

async function handleLoadHistoryRange(request) {
  const t0 = performance.now();
  const { entries, files } = await fsStorage.loadHistoryFileRange(
    request.from,
    request.to,
  );
  logDebug(
    `[I/O] loadHistoryRange(${request.from}..${request.to}): ${files.length} files, ${entries.length} entries in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, entries, files };
}

// ─── Request Handlers: Manifest/Directory ────────────────────────────

async function handleGetDirectoryInfo() {
  const info = await fsStorage.getDirectoryInfo();
  return { success: true, info };
}

async function handleGetDirectorySize() {
  const size = await fsStorage.getDirectorySize();
  return { success: true, size };
}

async function handleLoadOrphaned() {
  try {
    const fh = await fsStorage.resolveFile('manifest/orphaned.json');
    const entity = await fsStorage.readJson(fh);
    return { success: true, entity };
  } catch {
    return { success: true, entity: { timestamp: 0, keys: [] } };
  }
}

async function handleLoadCurrent() {
  const deviceId = await fsStorage.loadCurrent();
  return { success: true, deviceId };
}

async function handleInitDevice(request) {
  await fsStorage.initDevice(request.deviceId);
  return { success: true };
}

async function handleDeleteCurrent() {
  const root = fsStorage.directoryHandle;
  try {
    await root.removeEntry('CURRENT');
  } catch {}
  return { success: true };
}

async function handleLoadSettings() {
  const t0 = performance.now();
  const settings = await fsStorage.loadSettings();
  logDebug(
    `[I/O] loadSettings: ${Object.keys(settings).length} keys in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, settings };
}

async function handleLoadNameMap() {
  const t0 = performance.now();
  try {
    const fh = await fsStorage.resolveFile('manifest/list-name-to-id.json');
    const entity = await fsStorage.readJson(fh);
    logDebug(`[I/O] loadNameMap: ${(performance.now() - t0).toFixed(1)}ms`);
    return { success: true, entity };
  } catch {
    return { success: true, entity: { timestamp: 0, paths: {} } };
  }
}

async function handleLoadListOrder() {
  try {
    const fh = await fsStorage.resolveFile('manifest/list-order.json');
    const entity = await fsStorage.readJson(fh);
    return { success: true, entity };
  } catch {
    return { success: true, entity: { timestamp: 0, tree: [] } };
  }
}

// ─── Request Handlers: Log Drain ─────────────────────────────────────

async function handleFlushLogBuffer(request) {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  while (draining) await new Promise((r) => setTimeout(r, 50));
  if (request.entries) pendingDrainEntries = request.entries;
  await drainQueue();
  return { success: true };
}

// ─── Request Handlers: JSON I/O ──────────────────────────────────────

async function handleSaveJson(request) {
  await withLock(request.path, async () => {
    const fh = await fsStorage.resolveFile(request.path, { create: true });
    await fsStorage.writeJson(fh, request.data);
  });
  return { success: true };
}

// ─── Request Handlers: Sync ──────────────────────────────────────────

async function handleLoadSyncManifest(request) {
  try {
    const fh = await fsStorage.resolveFile(`manifest/${request.key}.json`);
    const data = await fsStorage.readJson(fh);
    return { success: true, data };
  } catch (e) {
    if (e.name === 'NotFoundError') return { success: true, data: null };
    throw e;
  }
}

async function handleLoadRemoteLogEntries(request) {
  const remotes = await fsSyncStorage.loadRemoteLogEntries(
    request.localDeviceId,
  );
  return { success: true, remotes };
}

async function handleCollectSyncFiles(request) {
  const files = await fsSyncStorage.collectSyncFiles(
    request.deviceId,
    request.retentionDays,
  );
  return { success: true, files };
}

async function handleWriteSyncFiles(request) {
  await fsSyncStorage.writeSyncFiles(request.files);
  return { success: true };
}

async function handleSyncFsListDeviceDirs() {
  const dirs = await fsSyncStorage.syncFsListDeviceDirs();
  return { success: true, dirs };
}

async function handleSyncFsListFiles(request) {
  const files = await fsSyncStorage.syncFsListFiles(request.deviceDir);
  return { success: true, files };
}

async function handleSyncFsReadFile(request) {
  const content = await fsSyncStorage.syncFsReadFile(request.path);
  return { success: true, content };
}

async function handleSyncFsWriteFile(request) {
  await fsSyncStorage.syncFsWriteFile(request.path, request.content);
  return { success: true };
}

async function handleSyncFsEnsureDir(request) {
  await fsSyncStorage.syncFsEnsureDir(request.path);
  return { success: true };
}

async function handleSyncFsRemoveFile(request) {
  await fsSyncStorage.syncFsRemoveFile(request.path);
  return { success: true };
}

async function handleClearSyncDirectory() {
  fsSyncStorage.syncDirectoryHandle = null;
  const db = await fsSyncStorage.mainStorage.initDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([fsSyncStorage.storeName], 'readwrite');
    const store = tx.objectStore(fsSyncStorage.storeName);
    const req = store.delete('syncDirectory');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  return { success: true };
}

// ─── Request Handlers: Import from Directory ────────────────────────

async function handleImportFromDirectory(request) {
  const { localDeviceId } = request;

  // Load import directory handle from IndexedDB
  const db = await fsStorage.initDB();
  const importHandle = await new Promise((resolve, reject) => {
    const tx = db.transaction([fsStorage.storeName], 'readonly');
    const store = tx.objectStore(fsStorage.storeName);
    const req = store.get('importDirectory');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (!importHandle) {
    throw new Error('No import directory handle found');
  }

  // OPFS handles (used in tests) don't support queryPermission.
  // Real handles from showDirectoryPicker always have 'granted' status.
  if (importHandle.queryPermission) {
    const perm = await importHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      throw new Error('Import directory permission denied');
    }
  }

  const stats = { logFiles: 0, noteFiles: 0, snapshotFiles: 0 };
  const entriesByDevice = [];

  let dataDir;
  try {
    dataDir = await importHandle.getDirectoryHandle('data');
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
    // No data directory at all — nothing to import
    return { success: true, entriesByDevice, stats };
  }

  // Helper: copy all files from a subdirectory to local data dir
  async function copySubdir(subdir, ext, statKey) {
    try {
      const srcDir = await dataDir.getDirectoryHandle(subdir);
      for await (const entry of srcDir.values()) {
        if (entry.kind !== 'file' || (ext && !entry.name.endsWith(ext)))
          continue;
        const file = await entry.getFile();
        const content = await file.text();
        const fh = await fsStorage.resolveFile(`data/${subdir}/${entry.name}`, {
          create: true,
        });
        const writable = await fh.createWritable();
        await writable.write(content);
        await writable.close();
        stats[statKey]++;
      }
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }

  // 1. Copy log files and parse entries
  try {
    const logsDir = await dataDir.getDirectoryHandle('logs');
    for await (const deviceEntry of logsDir.values()) {
      if (deviceEntry.kind !== 'directory') continue;
      if (deviceEntry.name === localDeviceId) continue;
      const deviceDir = await logsDir.getDirectoryHandle(deviceEntry.name);
      const deviceEntries = [];
      for await (const fileEntry of deviceDir.values()) {
        if (fileEntry.kind !== 'file' || !fileEntry.name.endsWith('.jsonl'))
          continue;
        const file = await fileEntry.getFile();
        const content = await file.text();
        // Write to local data directory
        const path = `data/logs/${deviceEntry.name}/${fileEntry.name}`;
        const fh = await fsStorage.resolveFile(path, { create: true });
        const writable = await fh.createWritable();
        await writable.write(content);
        await writable.close();
        stats.logFiles++;
        // Parse JSONL entries
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            deviceEntries.push(JSON.parse(line));
          } catch {
            /* skip malformed lines */
          }
        }
      }
      if (deviceEntries.length > 0) {
        entriesByDevice.push({
          deviceId: deviceEntry.name,
          entries: deviceEntries,
        });
      }
    }
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }

  // 2. Copy notes and snapshots
  await copySubdir('notes', '.json', 'noteFiles');
  await copySubdir('snapshots', null, 'snapshotFiles');

  // 3. Clean up import handle from IndexedDB
  await new Promise((resolve, reject) => {
    const tx = db.transaction([fsStorage.storeName], 'readwrite');
    const store = tx.objectStore(fsStorage.storeName);
    const req = store.delete('importDirectory');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  return { success: true, entriesByDevice, stats };
}

// ─── Request Handlers: Test ──────────────────────────────────────────

async function handleSetTestDirectory() {
  // Use OPFS (Origin Private File System) as a no-user-gesture directory handle.
  // Creates a subdirectory inside OPFS so each reset can wipe cleanly.
  const opfsRoot = await navigator.storage.getDirectory();
  try {
    await opfsRoot.removeEntry('portal-test', { recursive: true });
  } catch {}
  const testDir = await opfsRoot.getDirectoryHandle('portal-test', {
    create: true,
  });
  fsStorage.directoryHandle = testDir;
  fsStorage.clearCache();
  // OPFS handles don't support queryPermission/requestPermission,
  // so grant permission unconditionally for drain to work.
  fsStorage.grantPermission();
  return { success: true };
}

async function handleResetDirectory() {
  if (!fsStorage.directoryHandle) return { success: true };
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  // Wait for in-flight drain to finish before wiping
  while (draining) await new Promise((r) => setTimeout(r, 50));
  pendingDrainEntries = null;
  lastDrainedTimestamp = 0;
  pendingWatermark = 0;
  for await (const name of fsStorage.directoryHandle.keys()) {
    await fsStorage.directoryHandle.removeEntry(name, { recursive: true });
  }
  fsStorage.clearCache();
  // Re-grant for OPFS handles (clearCache resets #permissionGranted)
  fsStorage.grantPermission();
  return { success: true };
}

async function handleSeedTestData(request) {
  // request.files = [{ path, data } or { path, lines } or { path, content }]
  for (const file of request.files) {
    if (file.lines) {
      const fh = await fsStorage.resolveFile(file.path, { create: true });
      const writable = await fh.createWritable();
      for (const line of file.lines) {
        await writable.write(JSON.stringify(line) + '\n');
      }
      await writable.close();
    } else if (file.content !== undefined) {
      // Raw text content (e.g. .md, .html snapshot files)
      const fh = await fsStorage.resolveFile(file.path, { create: true });
      const writable = await fh.createWritable();
      await writable.write(file.content);
      await writable.close();
    } else {
      const fh = await fsStorage.resolveFile(file.path, { create: true });
      await fsStorage.writeJson(fh, file.data);
    }
  }
  fsStorage.clearCache();
  return { success: true };
}

async function handleSeedImportDirectory(request) {
  // Create an OPFS directory to simulate an external portal-data directory.
  // Seeds it with test files and stores the handle as 'importDirectory' in IndexedDB.
  const opfsRoot = await navigator.storage.getDirectory();
  try {
    await opfsRoot.removeEntry('portal-import-test', { recursive: true });
  } catch {}
  const importDir = await opfsRoot.getDirectoryHandle('portal-import-test', {
    create: true,
  });

  // Resolve directory segments and write files (same format as seedTestData)
  for (const file of request.files) {
    const segments = file.path.split('/');
    let current = importDir;
    for (let i = 0; i < segments.length - 1; i++) {
      current = await current.getDirectoryHandle(segments[i], { create: true });
    }
    const fh = await current.getFileHandle(segments[segments.length - 1], {
      create: true,
    });
    const writable = await fh.createWritable();
    if (file.lines) {
      for (const line of file.lines) {
        await writable.write(JSON.stringify(line) + '\n');
      }
    } else if (file.data) {
      await writable.write(JSON.stringify(file.data));
    } else {
      await writable.write(file.content || '');
    }
    await writable.close();
  }

  // Store handle in IndexedDB for importFromDirectory to find
  const db = await fsStorage.initDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([fsStorage.storeName], 'readwrite');
    const store = tx.objectStore(fsStorage.storeName);
    const req = store.put(importDir, 'importDirectory');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  return { success: true };
}

// ─── Request Handlers: Sandbox ───────────────────────────────────────

async function handleExecuteSandboxFn(request) {
  const match = await executeSandbox(request.fnSource, request.pageData);
  return { success: true, match };
}

// ─── Request Dispatch ────────────────────────────────────────────────

async function handleRequest(request) {
  if (
    request.action !== 'initializeFilesystem' &&
    request.action !== 'setTestDirectory'
  ) {
    await initDone;
  }
  try {
    switch (request.action) {
      // Filesystem lifecycle
      case 'initializeFilesystem':
        return await handleInitializeFilesystem();
      case 'hasDirectoryHandle':
        return handleHasDirectoryHandle();
      case 'clearDirectoryHandleForTest':
        return handleClearDirectoryHandleForTest();
      // Entity reads
      case 'loadPageBatch':
        return await handleLoadPageBatch(request);
      case 'pageExists':
        return await handlePageExists(request);
      case 'loadNote':
        return await handleLoadNote(request);
      case 'saveNote':
        return await handleSaveNote(request);
      case 'deleteNote':
        return await handleDeleteNote(request);
      case 'deleteListFile':
        return await handleDeleteListFile(request);
      case 'loadPageNotes':
        return await handleLoadPageNotes(request);
      case 'loadAllNotes':
        return await handleLoadAllNotes();
      case 'loadAllPages':
        return await handleLoadAllPages();
      case 'loadListPins':
        return await handleLoadListPins(request);
      case 'loadListPinsById':
        return await handleLoadListPinsById(request);
      case 'loadListEntity':
        return await handleLoadListEntity(request);
      case 'listListFiles':
        return await handleListListFiles();
      case 'loadAllListMetadata':
        return await handleLoadAllListMetadata();
      // Snapshot ops
      case 'listSnapshots':
        return await handleListSnapshots(request);
      case 'captureSnapshot':
        return await handleCaptureSnapshot(request);
      case 'getSnapshotUrl':
        return await handleGetSnapshotUrl(request);
      case 'getSnapshotHtml':
        return await handleGetSnapshotHtml(request);
      case 'deleteSnapshot':
        return await handleDeleteSnapshot(request);
      // History
      case 'listHistoryFiles':
        return await handleListHistoryFiles(request);
      case 'loadHistoryBatch':
        return await handleLoadHistoryBatch(request);
      case 'loadHistoryRange':
        return await handleLoadHistoryRange(request);
      // Manifest/directory
      case 'getDirectoryInfo':
        return await handleGetDirectoryInfo();
      case 'getDirectorySize':
        return await handleGetDirectorySize();
      case 'loadOrphaned':
        return await handleLoadOrphaned();
      case 'loadCurrent':
        return await handleLoadCurrent();
      case 'initDevice':
        return await handleInitDevice(request);
      case 'deleteCurrent':
        return await handleDeleteCurrent();
      case 'loadSettings':
        return await handleLoadSettings();
      case 'loadNameMap':
        return await handleLoadNameMap();
      case 'loadListOrder':
        return await handleLoadListOrder();
      // Log drain
      case 'flushLogBuffer':
        return await handleFlushLogBuffer(request);
      // JSON I/O
      case 'saveJson':
        return await handleSaveJson(request);
      // Sync
      case 'loadSyncManifest':
        return await handleLoadSyncManifest(request);
      case 'loadRemoteLogEntries':
        return await handleLoadRemoteLogEntries(request);
      case 'collectSyncFiles':
        return await handleCollectSyncFiles(request);
      case 'writeSyncFiles':
        return await handleWriteSyncFiles(request);
      case 'syncFsListDeviceDirs':
        return await handleSyncFsListDeviceDirs();
      case 'syncFsListFiles':
        return await handleSyncFsListFiles(request);
      case 'syncFsReadFile':
        return await handleSyncFsReadFile(request);
      case 'syncFsWriteFile':
        return await handleSyncFsWriteFile(request);
      case 'syncFsEnsureDir':
        return await handleSyncFsEnsureDir(request);
      case 'syncFsRemoveFile':
        return await handleSyncFsRemoveFile(request);
      case 'clearSyncDirectory':
        return await handleClearSyncDirectory();
      // Import
      case 'importFromDirectory':
        return await handleImportFromDirectory(request);
      // Test
      case 'setTestDirectory':
        return await handleSetTestDirectory();
      case 'resetDirectory':
        return await handleResetDirectory();
      case 'seedTestData':
        return await handleSeedTestData(request);
      case 'seedImportDirectory':
        return await handleSeedImportDirectory(request);
      // Sandbox
      case 'executeSandboxFn':
        return await handleExecuteSandboxFn(request);
      default:
        return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (error) {
    logError('Error handling request:', error);
    return { success: false, error: error.message };
  }
}

// ─── Log Buffer Drain ─────────────────────────────────────────────────
// Background sends 'drainEntries' messages via port (handled above in
// the port.onMessage listener). Entries flow:
//   1. Append log line to data/logs/YYYY-MM-DD.jsonl
//   2. Checkpoint entity file via shared replay functions
//   3. Send watermark back to background for pruning

let drainTimer = null;
let drainRetryTimer = null;
let draining = false;
let pendingDrainEntries = null; // Set by port 'drainEntries' message
let pendingDeviceId = null; // Device name from drain message
let lastDrainedTimestamp = 0; // Local watermark — skip entries already written to JSONL

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue();
  }, 100);
}

function scheduleDrainRetry() {
  if (drainRetryTimer) return;
  drainRetryTimer = setTimeout(() => {
    drainRetryTimer = null;
    scheduleDrain();
  }, 30000);
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  try {
    if (!(await fsStorage.verifyPermission())) {
      logDebug('Drain: no filesystem permission, retrying in 30s');
      scheduleDrainRetry();
      draining = false;
      return;
    }

    // Entries delivered via port from background
    if (pendingDrainEntries === null) {
      draining = false;
      return;
    }
    let logBuffer = pendingDrainEntries;
    // Don't clear pendingDrainEntries yet — clear only after successful JSONL write
    // Skip entries already drained (prevents duplicates across drain cycles)
    logBuffer = logBuffer.filter((e) => e.timestamp > lastDrainedTimestamp);
    if (logBuffer.length === 0) {
      draining = false;
      return;
    }

    let lastTimestamp = 0;
    // Group entries by date for batch JSONL append
    const entriesByDate = new Map();

    // ── Round cache: entity key → entity (or null for non-existent pages/notes) ──
    // Populated lazily from filesystem on first access per key.
    // After processing all entries, dirty keys are flushed back to disk.
    const roundCache = new Map(); // key → entity | null
    const dirtyKeys = new Set();

    // Load an entity into roundCache if not already present
    const ensureLoaded = async (key) => {
      if (roundCache.has(key)) return;
      if (key.startsWith(PAGE_PREFIX)) {
        const slug = entitySlug(key);
        const exists = await fsStorage.pageExists(slug);
        if (exists) {
          const page = (await fsStorage.loadPage(slug)) || defaultEntity(key);
          if (!page.slug) page.slug = slug;
          roundCache.set(key, page);
        } else {
          roundCache.set(key, null);
        }
      } else if (key === 'manifest:settings') {
        let s = await fsStorage.loadSettings();
        roundCache.set(key, s);
      } else if (
        key.startsWith(LIST_PREFIX) &&
        !key.startsWith('list:index/')
      ) {
        const listId = entitySlug(key);
        roundCache.set(key, await fsStorage.loadListPinsEntity(listId));
      } else if (key === 'manifest:orphaned') {
        try {
          const fh = await fsStorage.resolveFile('manifest/orphaned.json');
          roundCache.set(key, await fsStorage.readJson(fh));
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      } else if (key.startsWith(NOTE_PREFIX)) {
        const slug = entitySlug(key);
        const note = await fsStorage.loadNote(slug);
        roundCache.set(key, note || null);
      } else if (key === 'manifest:name-to-id') {
        try {
          const fh = await fsStorage.resolveFile(
            'manifest/list-name-to-id.json',
          );
          roundCache.set(key, await fsStorage.readJson(fh));
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      } else if (key === 'manifest:list-order') {
        try {
          const fh = await fsStorage.resolveFile('manifest/list-order.json');
          roundCache.set(key, await fsStorage.readJson(fh));
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      }
    };

    // ── Sequential replay: process entries in log order ──
    // load closure: reads from round cache, populating lazily from filesystem.
    // Mirrors background's sessionLoad contract: filters deleted entities unless
    // opts.includeDeleted is set.
    const load = async (key, opts) => {
      await ensureLoaded(key);
      const entity = roundCache.get(key) ?? null;
      if (!opts?.includeDeleted && entity?.deleted) return null;
      return entity;
    };

    for (const entry of logBuffer) {
      // Group by date for JSONL
      const dateKey = dateKeyFromTimestamp(entry.timestamp);
      if (!entriesByDate.has(dateKey)) entriesByDate.set(dateKey, []);
      entriesByDate.get(dateKey).push(entry);

      // Apply entry via unified effectOf
      const updated = await effectOf(entry, load, {
        deviceId: pendingDeviceId,
      });

      // Write updated entities back to round cache
      for (const [key, entity] of Object.entries(updated)) {
        const prev = roundCache.get(key);
        if (entity !== prev) {
          roundCache.set(key, entity);
          dirtyKeys.add(key);
        }
      }

      lastTimestamp = entry.timestamp;
    }

    // 1. Batch append to JSONL history files in device subdirectory
    const logsDir = await fsStorage.resolveDir('data/logs');
    // Ensure device subdirectory exists
    const historyDir = await logsDir.getDirectoryHandle(pendingDeviceId, {
      create: true,
    });
    for (const [dateKey, entries] of entriesByDate) {
      try {
        const fh = await historyDir.getFileHandle(`${dateKey}.jsonl`, {
          create: true,
        });
        const file = await fh.getFile();
        const writable = await fh.createWritable({ keepExistingData: true });
        await writable.seek(file.size);
        for (const entry of entries) {
          await writable.write(JSON.stringify(entry) + '\n');
        }
        await writable.close();
      } catch (e) {
        logError('JSONL append failed:', e);
        scheduleDrainRetry();
        draining = false;
        return;
      }
    }

    // JSONL writes succeeded — safe to clear pending entries
    pendingDrainEntries = null;

    // 2. Flush dirty entities from round cache to disk (per-entity try/catch
    //    so one failure doesn't prevent others from saving)
    for (const key of dirtyKeys) {
      try {
        const entity = roundCache.get(key);
        if (entity === null || entity === undefined) {
          // GC'd page entity — delete its checkpoint file
          if (key.startsWith(PAGE_PREFIX)) {
            const slug = entitySlug(key);
            await withLock('pages/' + slug + '.json', () =>
              fsStorage.deletePage(slug),
            );
          }
          continue;
        }

        if (key.startsWith(PAGE_PREFIX)) {
          const slug = entitySlug(key);
          await withLock('pages/' + slug + '.json', () =>
            fsStorage.savePage(slug, entity),
          );
        } else if (key.startsWith(NOTE_PREFIX)) {
          const slug = entitySlug(key);
          // Strip entity-only fields — note files are immutable primary data.
          // Mutable state (deleted, replacedBy, etc.) lives in session cache only.
          const { slug: s, excerpt, note, cssPath, url } = entity;
          const fileData = { slug: s, excerpt, note, cssPath, url };
          await withLock('data/notes/' + slug + '.json', () =>
            fsStorage.saveNote(slug, fileData),
          );
        } else if (key === 'manifest:settings') {
          await withLock('manifest/settings.json', () =>
            fsStorage.saveSettings(entity),
          );
        } else if (
          key.startsWith(LIST_PREFIX) &&
          !isSystemList(key) &&
          !key.startsWith('list:index/')
        ) {
          const listId = entitySlug(key);
          await withLock('lists/' + listId + '.json', async () => {
            await fsStorage.saveListMeta(listId, entity);
          });
        } else if (key === 'manifest:orphaned') {
          await withLock('manifest/orphaned.json', async () => {
            const fh = await fsStorage.resolveFile('manifest/orphaned.json', {
              create: true,
            });
            await fsStorage.writeJson(fh, entity);
          });
        } else if (key === 'manifest:name-to-id') {
          await withLock('manifest/list-name-to-id.json', async () => {
            const fh = await fsStorage.resolveFile(
              'manifest/list-name-to-id.json',
              { create: true },
            );
            await fsStorage.writeJson(fh, entity);
          });
        } else if (key === 'manifest:list-order') {
          await withLock('manifest/list-order.json', async () => {
            const fh = await fsStorage.resolveFile('manifest/list-order.json', {
              create: true,
            });
            await fsStorage.writeJson(fh, entity);
          });
        }
      } catch (e) {
        logError(`Entity flush failed for ${key}:`, e);
      }
    }

    // Advance local watermark so next drain skips these entries
    if (lastTimestamp > 0) {
      lastDrainedTimestamp = lastTimestamp;
    }

    // Send watermark back to background for pruning
    if (lastTimestamp > 0) {
      if (bgPort) {
        bgPort.postMessage({ action: 'persisted', watermark: lastTimestamp });
      } else {
        // Port disconnected (SW terminated) — store for delivery on reconnect
        pendingWatermark = Math.max(pendingWatermark, lastTimestamp);
      }
    }
  } catch (e) {
    logError('drainQueue error:', e);
    scheduleDrainRetry();
  }

  draining = false;
}

// ─── Initialization ───────────────────────────────────────────────────

async function initialize() {
  try {
    await fsStorage.loadDirectoryHandle();
    const hasPermission = await fsStorage.verifyPermission();

    if (hasPermission) {
      logDebug('Filesystem storage ready');
      // Trigger initial drain in case there are pending log entries
      scheduleDrain();
    } else {
      logDebug('No filesystem permission yet');
    }
  } catch (error) {
    logDebug('Filesystem not configured yet:', error.message);
  }
}

const initDone = initialize();

// ─── Smart Rule Sandbox Bridge ───────────────────────────────────────

let sandboxFrame = null;
let sandboxReady = null;
const sandboxCallbacks = new Map();
let sandboxIdCounter = 0;

function ensureSandboxFrame() {
  if (sandboxReady) return sandboxReady;
  sandboxReady = new Promise((resolve) => {
    sandboxFrame = document.createElement('iframe');
    sandboxFrame.src = 'fn-rule-sandbox.html';
    sandboxFrame.style.display = 'none';
    sandboxFrame.onload = () => resolve();
    document.body.appendChild(sandboxFrame);
  });

  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.id) return;
    const cb = sandboxCallbacks.get(event.data.id);
    if (!cb) return;
    sandboxCallbacks.delete(event.data.id);
    if (event.data.error) {
      cb.reject(new Error(event.data.error));
    } else {
      cb.resolve(event.data.match);
    }
  });

  return sandboxReady;
}

async function executeSandbox(fnSource, pageData) {
  await ensureSandboxFrame();
  const id = ++sandboxIdCounter;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sandboxCallbacks.delete(id);
      reject(new Error('Sandbox execution timed out (5s)'));
    }, 5000);

    sandboxCallbacks.set(id, {
      resolve: (match) => {
        clearTimeout(timeout);
        resolve(match);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    sandboxFrame.contentWindow.postMessage(
      { id, action: 'execute', fnSource, pageData },
      '*',
    );
  });
}
