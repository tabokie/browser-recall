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
import { effectOf, defaultEntity } from './replay.js';
import { generateNoteSlug, dateKeyFromTimestamp } from './utils.js';

console.log('Offscreen document loaded');

const fsStorage = new FileSystemStorage();

// ─── Port Channel ─────────────────────────────────────────────────────

let bgPort = null;
let pendingWatermark = 0; // Stored when drain completes but port is disconnected

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bg-offscreen') return;
  bgPort = port;
  console.log('Port connected to background');

  // Deliver any watermark that was pending while port was disconnected
  if (pendingWatermark > 0) {
    port.postMessage({ action: 'persisted', watermark: pendingWatermark });
    pendingWatermark = 0;
  }

  port.onMessage.addListener(async (msg) => {
    // Fire-and-forget drain trigger from background (no response needed)
    if (msg.action === 'drainEntries') {
      pendingDrainEntries = msg.entries;
      scheduleDrain();
      return;
    }
    const result = await handleRequest(msg);
    port.postMessage({ id: msg.id, ...result });
  });

  port.onDisconnect.addListener(() => {
    bgPort = null;
    console.warn('Port disconnected from background');
  });
});

// ─── Per-File Lock ────────────────────────────────────────────────────

const fileLocks = new Map();

function withLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  fileLocks.set(key, next);
  next.catch(() => {}).then(() => {
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  });
  return next;
}

// ─── Request Handler ──────────────────────────────────────────────────

async function handleRequest(request) {
  try {
    switch (request.action) {
      case 'initializeFilesystem': {
        await initialize();
        return { success: true };
      }

      case 'getDirectoryInfo': {
        const info = await fsStorage.getDirectoryInfo();
        return { success: true, info };
      }

      case 'listSnapshots': {
        const t0 = performance.now();
        const snapshots = await fsStorage.listSnapshots(request.slug);
        console.debug(`[I/O] listSnapshots(${request.slug}): ${snapshots.length} snapshots in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, snapshots };
      }

      case 'captureSnapshot': {
        await withLock('snapshot:' + request.slug, () =>
          fsStorage.captureSnapshot(request.slug, request.timestamp, request.markdown || '', request.html || '')
        );
        return { success: true };
      }

      case 'getSnapshotUrl': {
        const url = await fsStorage.getSnapshotBlobUrl(request.slug, request.timestamp);
        return url ? { success: true, url } : { success: false, error: 'Not found' };
      }

      case 'deleteSnapshot': {
        await fsStorage.deleteSnapshot(request.slug, request.timestamp);
        return { success: true };
      }

      case 'loadNote': {
        const note = await fsStorage.loadNote(request.noteSlug);
        return { success: true, note };
      }

      case 'saveNote': {
        await fsStorage.saveNote(request.slug, request.data);
        return { success: true };
      }

      case 'deleteNote': {
        await fsStorage.deleteNote(request.noteSlug);
        return { success: true };
      }

      case 'deleteListFile': {
        await fsStorage.deleteListFile(request.listId);
        return { success: true };
      }

      case 'loadPageNotes': {
        const t0 = performance.now();
        const notes = await fsStorage.loadPageNotes(request.slug);
        console.debug(`[I/O] loadPageNotes(${request.slug}): ${notes.length} notes in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, notes };
      }

      case 'loadAllNotes': {
        const t0 = performance.now();
        const notesMap = await fsStorage.loadAllNotes();
        console.debug(`[I/O] loadAllNotes: ${Object.keys(notesMap).length} pages in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, notesMap };
      }

      case 'loadInteractionByUrl': {
        const t0 = performance.now();
        const interaction = await fsStorage.loadInteractionByUrl(request.url);
        console.debug(`[I/O] loadInteractionByUrl: ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, interaction };
      }

      case 'loadPageBatch': {
        const t0 = performance.now();
        const pages = await fsStorage.loadPageBatch(request.slugs);
        console.debug(`[I/O] loadPageBatch: ${request.slugs.length} slugs in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, pages };
      }

      case 'pageExists': {
        const exists = await fsStorage.pageExists(request.slug);
        return { success: true, exists };
      }

      case 'loadListPins': {
        const t0 = performance.now();
        if (request.listId) {
          const pins = await fsStorage.loadListPinsById(request.listId);
          console.debug(`[I/O] loadListPins(${request.listId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`);
          return { success: true, pins };
        } else {
          const allPins = await fsStorage.loadListPins();
          console.debug(`[I/O] loadListPins: ${Object.keys(allPins).length} lists in ${(performance.now() - t0).toFixed(1)}ms`);
          return { success: true, pins: allPins };
        }
      }

      case 'loadListPinsById': {
        const t0 = performance.now();
        const pins = await fsStorage.loadListPinsById(request.listId);
        console.debug(`[I/O] loadListPinsById(${request.listId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, pins };
      }

      case 'loadListEntity': {
        const t0 = performance.now();
        const entity = await fsStorage.loadListPinsEntity(request.listId);
        console.debug(`[I/O] loadListEntity(${request.listId}): ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, entity };
      }

      case 'loadOrphaned': {
        try {
          const fh = await fsStorage.resolveFile('lists/system/orphaned.json');
          const entity = await fsStorage.readJson(fh);
          return { success: true, entity };
        } catch {
          return { success: true, entity: { timestamp: 0, keys: [] } };
        }
      }

      case 'loadSettings': {
        const t0 = performance.now();
        const settings = await fsStorage.loadSettings();
        console.debug(`[I/O] loadSettings: ${Object.keys(settings).length} keys in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, settings };
      }

      case 'loadGateways': {
        const t0 = performance.now();
        const gatewayData = await fsStorage.loadGateways();
        console.debug(`[I/O] loadGateways: ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, origins: gatewayData.origins || [] };
      }

      case 'loadShallowPageIndex': {
        const t0 = performance.now();
        const data = await fsStorage.loadShallowPageIndex();
        console.debug(`[I/O] loadShallowPageIndex: ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, ...data };
      }

      case 'listInteractionFiles': {
        const files = await fsStorage.listInteractionFiles();
        return { success: true, files };
      }

      case 'loadInteractionBatch': {
        const t0 = performance.now();
        const interactions = await fsStorage.loadInteractionFiles(request.files);
        console.debug(`[I/O] loadInteractionBatch: ${request.files.length} files, ${interactions.length} items in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, interactions };
      }

      case 'loadHistoryRange': {
        const t0 = performance.now();
        const { entries, files } = await fsStorage.loadInteractionFileRange(request.from, request.to);
        console.debug(`[I/O] loadHistoryRange(${request.from}..${request.to}): ${files.length} files, ${entries.length} entries in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, entries, files };
      }

      // List list file IDs from lists/ (excluding system/)
      case 'listListFiles': {
        const files = [];
        try {
          const listsDir = await fsStorage.resolveDir('lists');
          for await (const entry of listsDir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
              const id = entry.name.replace('.json', '');
              // Skip system files
              if (!id.startsWith('system') && !id.startsWith('index')) {
                files.push(id);
              }
            }
          }
        } catch { /* lists/ may not exist */ }
        return { success: true, files };
      }

      case 'loadAllListMetadata': {
        const t0 = performance.now();
        const lists = await fsStorage.loadAllListMetadata();
        console.debug(`[I/O] loadAllListMetadata: ${lists.length} lists in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, lists };
      }

      // Force-flush the log buffer to disk
      case 'flushLogBuffer': {
        // Cancel any pending timer
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
        // Wait for in-progress drain
        while (draining) await new Promise(r => setTimeout(r, 50));
        // Use entries from background (avoids chrome.storage.local in offscreen)
        if (request.entries) pendingDrainEntries = request.entries;
        // Run drain (sends watermark to background via port for pruning)
        await drainQueue();
        return { success: true };
      }

      // Direct JSON save — for derived data (gateways, referrer-index, pages)
      case 'saveJson': {
        await withLock(request.path, async () => {
          const fh = await fsStorage.resolveFile(request.path, { create: true });
          await fsStorage.writeJson(fh, request.data);
        });
        return { success: true };
      }

      case 'setTestDirectory': {
        // Use OPFS (Origin Private File System) as a no-user-gesture directory handle.
        // Creates a subdirectory inside OPFS so each reset can wipe cleanly.
        const opfsRoot = await navigator.storage.getDirectory();
        // Remove previous test dir if it exists
        try { await opfsRoot.removeEntry('portal-test', { recursive: true }); } catch {}
        const testDir = await opfsRoot.getDirectoryHandle('portal-test', { create: true });
        fsStorage.directoryHandle = testDir;
        fsStorage.clearCache();
        // OPFS handles don't support queryPermission/requestPermission,
        // so grant permission unconditionally for drain to work.
        fsStorage.grantPermission();
        return { success: true };
      }

      case 'resetDirectory': {
        // Wipe all contents of current directory (no-op if no handle)
        if (!fsStorage.directoryHandle) return { success: true };
        // Cancel any pending drain timer
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
        // Wait for in-flight drain to finish before wiping — drainQueue is async
        // and can be mid-execution at an await point when this message arrives
        while (draining) await new Promise(r => setTimeout(r, 50));
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

      case 'seedTestData': {
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

      default:
        return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return { success: false, error: error.message };
  }
}

// ─── Log Buffer Drain ─────────────────────────────────────────────────
// Background sends 'drainEntries' messages via port (handled above in
// the port.onMessage listener). Entries flow:
//   1. Append log line to history/YYYY-MM-DD.jsonl
//   2. Checkpoint entity file via shared replay functions
//   3. Send watermark back to background for pruning

let drainTimer = null;
let draining = false;
let pendingDrainEntries = null; // Set by port 'drainEntries' message
let lastDrainedTimestamp = 0;   // Local watermark — skip entries already written to JSONL

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; drainQueue(); }, 100);
}


async function drainQueue() {
  if (draining) return;
  draining = true;

  try {
    if (!(await fsStorage.verifyPermission())) {
      console.warn('Drain: no filesystem permission, retrying in 30s');
      setTimeout(scheduleDrain, 30000);
      draining = false;
      return;
    }

    // Entries delivered via port from background
    if (pendingDrainEntries === null) {
      draining = false;
      return;
    }
    let logBuffer = pendingDrainEntries;
    pendingDrainEntries = null;
    // Skip entries already drained (prevents duplicates across drain cycles)
    logBuffer = logBuffer.filter(e => e.timestamp > lastDrainedTimestamp);
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
    const roundCache = new Map();   // key → entity | null
    const dirtyKeys = new Set();

    // Load an entity into roundCache if not already present
    const ensureLoaded = async (key) => {
      if (roundCache.has(key)) return;
      if (key.startsWith('page:')) {
        const slug = key.slice(5);
        const exists = await fsStorage.pageExists(slug);
        if (exists) {
          const page = (await fsStorage.loadPage(slug)) || defaultEntity(key);
          if (!page.slug) page.slug = slug;
          roundCache.set(key, page);
        } else {
          roundCache.set(key, null);
        }
      } else if (key === 'settings') {
        let s = await fsStorage.loadSettings();
        if (!s.timestamp) s.timestamp = 0;
        roundCache.set(key, s);
      } else if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
        const listId = key.slice('list:'.length);
        roundCache.set(key, await fsStorage.loadListPinsEntity(listId));
      } else if (key === 'list:system/gateways') {
        try {
          roundCache.set(key, await fsStorage.loadGateways());
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      } else if (key === 'list:system/orphaned') {
        try {
          const fh = await fsStorage.resolveFile('lists/system/orphaned.json');
          roundCache.set(key, await fsStorage.readJson(fh));
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      } else if (key === 'list:system/shallow-page') {
        try {
          roundCache.set(key, await fsStorage.loadShallowPageIndex());
        } catch {
          roundCache.set(key, defaultEntity(key));
        }
      }
    };

    // ── Sequential replay: process entries in log order ──
    // load closure: reads from round cache, populating lazily from filesystem
    const load = async (key) => {
      await ensureLoaded(key);
      return roundCache.get(key) ?? null;
    };

    for (const entry of logBuffer) {
      // Group by date for JSONL
      const dateKey = dateKeyFromTimestamp(entry.timestamp);
      if (!entriesByDate.has(dateKey)) entriesByDate.set(dateKey, []);
      entriesByDate.get(dateKey).push(entry);

      // Apply entry via unified effectOf
      const updated = await effectOf(entry, load);

      // Write updated entities back to round cache
      for (const [key, entity] of Object.entries(updated)) {
        const prev = roundCache.get(key);
        if (entity !== prev) {
          roundCache.set(key, entity);
          if (entity !== null) dirtyKeys.add(key);
        }
      }

      lastTimestamp = entry.timestamp;
    }

    // 1. Batch append to JSONL history files (proper append: keepExistingData + seek)
    const historyDir = await fsStorage.resolveDir('history');
    for (const [dateKey, entries] of entriesByDate) {
      try {
        const fh = await historyDir.getFileHandle(`${dateKey}.jsonl`, { create: true });
        const file = await fh.getFile();
        const writable = await fh.createWritable({ keepExistingData: true });
        await writable.seek(file.size);
        for (const entry of entries) {
          await writable.write(JSON.stringify(entry) + '\n');
        }
        await writable.close();
      } catch (e) {
        console.error('JSONL append failed:', e);
        setTimeout(scheduleDrain, 30000);
        draining = false;
        return;
      }
    }

    // 2. Flush dirty entities from round cache to disk (pure save, no post-processing)
    for (const key of dirtyKeys) {
      const entity = roundCache.get(key);
      if (entity === null) continue;

      if (key.startsWith('page:')) {
        const slug = key.slice(5);
        await withLock('pages/' + slug + '.json', () => fsStorage.savePage(slug, entity));
      } else if (key === 'settings') {
        await withLock('settings.json', () => fsStorage.saveSettings(entity));
      } else if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
        const listId = key.slice('list:'.length);
        await withLock('lists/' + listId + '.json', async () => {
          await fsStorage.saveListMeta(listId, entity, entity.timestamp);
        });
      } else if (key === 'list:system/gateways') {
        await withLock('lists/system/gateways.json', async () => {
          const fh = await fsStorage.resolveFile('lists/system/gateways.json', { create: true });
          await fsStorage.writeJson(fh, entity);
        });
      } else if (key === 'list:system/orphaned') {
        await withLock('lists/system/orphaned.json', async () => {
          const fh = await fsStorage.resolveFile('lists/system/orphaned.json', { create: true });
          await fsStorage.writeJson(fh, entity);
        });
      } else if (key === 'list:system/shallow-page') {
        await withLock('lists/system/shallow-page.json', async () => {
          const fh = await fsStorage.resolveFile('lists/system/shallow-page.json', { create: true });
          await fsStorage.writeJson(fh, entity);
        });
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
    console.error('drainQueue error:', e);
    setTimeout(scheduleDrain, 30000);
  }

  draining = false;
}

// ─── Initialization ───────────────────────────────────────────────────

async function initialize() {
  try {
    await fsStorage.loadDirectoryHandle();
    const hasPermission = await fsStorage.verifyPermission();

    if (hasPermission) {
      console.log('Filesystem storage ready');
      // Trigger initial drain in case there are pending log entries
      scheduleDrain();
    } else {
      console.log('No filesystem permission yet');
    }
  } catch (error) {
    console.log('Filesystem not configured yet:', error.message);
  }
}

initialize();
