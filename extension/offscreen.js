// Offscreen document — pure filesystem I/O worker.
//
// Responds to read requests from background via port channel.
// Background sends 'drainEntries' messages via port when logBuffer has new entries;
// offscreen drains them to the filesystem (JSONL append + entity checkpoint).
// (chrome.storage.onChanged is NOT available in offscreen — only chrome.runtime is.)
//
// Why offscreen? MV3 service workers have no document context. The File System
// Access API requires a document to store FileSystemDirectoryHandle in IndexedDB
// and call its methods.
import { FileSystemStorage } from './filesystem-storage.js';
import { generateSlugFromUrl } from './utils.js';
import { applyLogToSettings, applyLogToAtom, applyLogToPins, applyLogToDeletes, applyLogToRecycleBin, applyLogToParentIndex } from './replay.js';

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

      case 'loadHighlights': {
        const t0 = performance.now();
        const highlights = await fsStorage.loadHighlights(request.slug);
        console.debug(`[I/O] loadHighlights(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, highlights };
      }

      case 'loadAllHighlights': {
        const t0 = performance.now();
        const highlightsMap = await fsStorage.loadAllHighlights();
        console.debug(`[I/O] loadAllHighlights: ${Object.keys(highlightsMap).length} pages in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, highlightsMap };
      }

      case 'loadInteractionByUrl': {
        const t0 = performance.now();
        const interaction = await fsStorage.loadInteractionByUrl(request.url);
        console.debug(`[I/O] loadInteractionByUrl: ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, interaction };
      }

      case 'loadAtomBatch': {
        const t0 = performance.now();
        const atoms = await fsStorage.loadAtomBatch(request.slugs);
        console.debug(`[I/O] loadAtomBatch: ${request.slugs.length} slugs in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, atoms };
      }

      case 'loadPageDetail': {
        const t0 = performance.now();
        const detail = await fsStorage.loadPageDetail(request.slug, request.url);
        console.debug(`[I/O] loadPageDetail(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, ...detail };
      }

      case 'loadCollectionPins': {
        const t0 = performance.now();
        if (request.collectionId) {
          const pins = await fsStorage.loadCollectionPinsById(request.collectionId);
          console.debug(`[I/O] loadCollectionPins(${request.collectionId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`);
          return { success: true, pins };
        } else {
          const allPins = await fsStorage.loadCollectionPins();
          console.debug(`[I/O] loadCollectionPins: ${Object.keys(allPins).length} collections in ${(performance.now() - t0).toFixed(1)}ms`);
          return { success: true, pins: allPins };
        }
      }

      case 'loadCollectionPinsById': {
        const t0 = performance.now();
        const pins = await fsStorage.loadCollectionPinsById(request.collectionId);
        console.debug(`[I/O] loadCollectionPinsById(${request.collectionId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, pins };
      }

      case 'saveCollectionPins': {
        await withLock('collectionPins', () =>
          fsStorage.saveCollectionPins(request.pins)
        );
        return { success: true };
      }

      case 'loadPermanentDeletes': {
        const t0 = performance.now();
        const urls = await fsStorage.loadPermanentDeletes();
        console.debug(`[I/O] loadPermanentDeletes: ${urls.length} urls in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, urls };
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
        return { success: true, ...gatewayData };
      }

      case 'processGatewaysIncremental': {
        const result = await fsStorage.processGatewaysAfterWatermark(
          request.watermark, request.existingDomains
        );
        return { success: true, ...result };
      }

      case 'loadParentIndex': {
        const t0 = performance.now();
        const data = await fsStorage.loadParentIndex();
        console.debug(`[I/O] loadParentIndex: ${(performance.now() - t0).toFixed(1)}ms`);
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

      // List collection file IDs from lists/user/
      case 'listCollectionFiles': {
        const files = [];
        try {
          const userDir = await fsStorage.resolveDir('lists/user');
          for await (const entry of userDir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
              files.push(entry.name.replace('.json', ''));
            }
          }
        } catch { /* lists/user/ may not exist */ }
        return { success: true, files };
      }

      case 'loadAllCollectionMetadata': {
        const t0 = performance.now();
        const collections = await fsStorage.loadAllCollectionMetadata();
        console.debug(`[I/O] loadAllCollectionMetadata: ${collections.length} collections in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, collections };
      }

      case 'loadRecycleBin': {
        const t0 = performance.now();
        const items = await fsStorage.loadRecycleBin();
        console.debug(`[I/O] loadRecycleBin: ${items.length} items in ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, items };
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

      // Direct JSON save — for derived data (gateways, referrer-index, atoms)
      case 'saveJson': {
        await withLock(request.path, async () => {
          const fh = await fsStorage.resolveFile(request.path, { create: true });
          await fsStorage.writeJson(fh, request.data);
        });
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

function dateKeyFromTimestamp(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
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

    // Use entries captured from onChanged if available, fall back to storage.local
    let logBuffer;
    if (pendingDrainEntries !== null) {
      logBuffer = pendingDrainEntries;
      pendingDrainEntries = null;
    } else {
      try {
        const result = await chrome.storage.local.get(['logBuffer']);
        logBuffer = result.logBuffer || [];
      } catch (e) {
        console.warn('Drain: chrome.storage.local unavailable:', e.message);
        draining = false;
        return;
      }
    }
    // Skip entries already drained (prevents duplicates across drain cycles)
    logBuffer = logBuffer.filter(e => e.timestamp > lastDrainedTimestamp);
    if (logBuffer.length === 0) {
      draining = false;
      return;
    }

    let lastTimestamp = 0;
    let maxInteractionTimestamp = 0;

    // Group entries by date for batch JSONL append
    const entriesByDate = new Map();

    // Group entries by entity key for efficient checkpointing
    const settingsEntries = [];
    const atomEntries = new Map(); // slug → [entries]
    const pinsEntries = new Map(); // collectionId → [entries] (pins_replace + collection_meta + collection_delete)
    const deletesEntries = [];
    const recycleBinEntries = [];

    for (const entry of logBuffer) {
      // Group by date for JSONL (skip internal signals: ensure_checkpoint, add_child)
      if (entry.action !== 'ensure_checkpoint' && entry.action !== 'add_child') {
        const dateKey = dateKeyFromTimestamp(entry.timestamp);
        if (!entriesByDate.has(dateKey)) entriesByDate.set(dateKey, []);
        entriesByDate.get(dateKey).push(entry);
      }

      // Categorize for entity checkpoint
      if (!entry.action) {
        // Visit entry
        if (entry.slug) {
          if (!atomEntries.has(entry.slug)) atomEntries.set(entry.slug, []);
          atomEntries.get(entry.slug).push(entry);
        }
        if (entry.timestamp > maxInteractionTimestamp) {
          maxInteractionTimestamp = entry.timestamp;
        }
      } else if (entry.action === 'set') {
        settingsEntries.push(entry);
      } else if (entry.action === 'highlight' || entry.action === 'unhighlight' || entry.action === 'highlights_replace') {
        if (entry.slug) {
          if (!atomEntries.has(entry.slug)) atomEntries.set(entry.slug, []);
          atomEntries.get(entry.slug).push(entry);
        }
      } else if (entry.action === 'capture') {
        if (entry.slug) {
          if (!atomEntries.has(entry.slug)) atomEntries.set(entry.slug, []);
          atomEntries.get(entry.slug).push(entry);
        }
      } else if (entry.action === 'ensure_checkpoint') {
        if (entry.slug) {
          if (!atomEntries.has(entry.slug)) atomEntries.set(entry.slug, []);
          atomEntries.get(entry.slug).push(entry);
        }
      } else if (entry.action === 'add_child') {
        if (entry.slug) {
          if (!atomEntries.has(entry.slug)) atomEntries.set(entry.slug, []);
          atomEntries.get(entry.slug).push(entry);
        }
      } else if (entry.action === 'pins_replace' || entry.action === 'collection_meta' || entry.action === 'collection_delete') {
        const cid = entry.collectionId;
        if (!pinsEntries.has(cid)) pinsEntries.set(cid, []);
        pinsEntries.get(cid).push(entry);
      } else if (entry.action === 'deletes_replace') {
        deletesEntries.push(entry);
      } else if (entry.action === 'recycle_replace') {
        recycleBinEntries.push(entry);
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

    // 2. Checkpoint entities (one read per entity)
    // Settings
    if (settingsEntries.length > 0) {
      await withLock('settings.json', async () => {
        let settings = await fsStorage.loadSettings();
        if (!settings.timestamp) settings.timestamp = 0;
        for (const entry of settingsEntries) {
          settings = applyLogToSettings(settings, entry);
        }
        await fsStorage.saveSettings(settings);
      });
    }

    // Atoms — selective checkpointing
    // Determine which slugs deserve a checkpoint (atom file on disk)
    const RICH_ACTIONS = new Set(['highlight', 'unhighlight', 'highlights_replace', 'capture', 'ensure_checkpoint', 'add_child']);
    const slugsToCheckpoint = new Set();

    for (const [slug, entries] of atomEntries) {
      // Always checkpoint if atom already exists on disk
      if (await fsStorage.atomExists(slug)) {
        slugsToCheckpoint.add(slug);
        continue;
      }
      // Rich data actions (includes add_child) → checkpoint
      if (entries.some(e => e.action && RICH_ACTIONS.has(e.action))) {
        slugsToCheckpoint.add(slug);
        continue;
      }
    }

    // Multi-day visit check for remaining unchecked slugs
    const uncheckedSlugs = [...atomEntries.keys()].filter(s => !slugsToCheckpoint.has(s));
    if (uncheckedSlugs.length > 0) {
      try {
        const multiDaySlugs = await fsStorage.checkMultiDayVisits(uncheckedSlugs, 30);
        for (const slug of multiDaySlugs) slugsToCheckpoint.add(slug);
      } catch (e) {
        console.warn('checkMultiDayVisits failed:', e.message);
      }
    }

    // Build URL→title map from all entries in this batch (for {url,title} resolution)
    const titleByUrl = new Map();
    for (const entry of logBuffer) {
      if (entry.url && entry.title) titleByUrl.set(entry.url, entry.title);
      if (entry.childUrl && entry.childTitle) titleByUrl.set(entry.childUrl, entry.childTitle);
    }

    // Checkpoint only selected slugs
    for (const [slug, entries] of atomEntries) {
      if (!slugsToCheckpoint.has(slug)) continue;
      await withLock('atoms/' + slug + '.json', async () => {
        let atom = (await fsStorage.loadAtom(slug)) || { slug, timestamp: 0, highlights: [], parents: [], children: [] };
        if (!atom.slug) atom.slug = slug;
        for (const entry of entries) {
          atom = applyLogToAtom(atom, entry);
        }
        // Resolve parents/children: URL → slug (checkpointed) or {url,title} (non-checkpointed)
        for (const field of ['parents', 'children']) {
          if (atom[field] && atom[field].length > 0) {
            const resolved = [];
            for (const ref of atom[field]) {
              if (typeof ref !== 'string') { resolved.push(ref); continue; } // already {url,title}
              if (!ref.startsWith('http')) { resolved.push(ref); continue; } // already a slug
              const refSlug = generateSlugFromUrl(ref);
              if (slugsToCheckpoint.has(refSlug) || await fsStorage.atomExists(refSlug)) {
                resolved.push(refSlug);
              } else {
                resolved.push({ url: ref, title: titleByUrl.get(ref) || '' });
              }
            }
            atom[field] = resolved;
          }
        }
        await fsStorage.saveAtom(slug, atom);
      });
    }

    // Checkpoint parent-index: accumulate referrer visits for non-checkpointed pages, prune checkpointed ones
    const visitEntriesWithReferrers = logBuffer.filter(e => !e.action && e.referrer && e.url);
    if (visitEntriesWithReferrers.length > 0) {
      await withLock('lists/index/parent-index.json', async () => {
        let parentIndex;
        try {
          parentIndex = await fsStorage.loadParentIndex();
        } catch {
          parentIndex = { timestamp: 0, index: {} };
        }
        for (const entry of visitEntriesWithReferrers) {
          parentIndex = applyLogToParentIndex(parentIndex, entry);
        }
        // Remove entries for URLs whose slugs were just checkpointed (their parents are now in atom.parents)
        for (const url of Object.keys(parentIndex.index)) {
          const urlSlug = generateSlugFromUrl(url);
          if (slugsToCheckpoint.has(urlSlug)) {
            delete parentIndex.index[url];
          }
        }
        const fh = await fsStorage.resolveFile('lists/index/parent-index.json', { create: true });
        await fsStorage.writeJson(fh, parentIndex);
      });
    }

    // Collection entities (pins_replace, collection_meta, collection_delete)
    for (const [collectionId, entries] of pinsEntries) {
      await withLock('lists/user/' + collectionId + '.json', async () => {
        let entity = await fsStorage.loadCollectionPinsEntity(collectionId);
        for (const entry of entries) {
          entity = applyLogToPins(entity, entry);
        }
        if (entity.deleted) {
          await fsStorage.deleteCollectionFile(collectionId);
        } else {
          await fsStorage.saveCollectionMeta(collectionId, entity, entity.timestamp);
        }
      });
    }

    // Recycle bin
    if (recycleBinEntries.length > 0) {
      await withLock('lists/recycle-bin.json', async () => {
        let entity = await fsStorage.loadRecycleBinEntity();
        for (const entry of recycleBinEntries) {
          entity = applyLogToRecycleBin(entity, entry);
        }
        await fsStorage.saveRecycleBin(entity.items, entity.timestamp);
      });
    }

    // Permanent deletes
    if (deletesEntries.length > 0) {
      await withLock('lists/permanent-deletes.json', async () => {
        let entity = await fsStorage.loadPermanentDeletesEntity();
        for (const entry of deletesEntries) {
          entity = applyLogToDeletes(entity, entry);
        }
        await fsStorage.savePermanentDeletes(entity.urls, entity.timestamp);
      });
    }

    // Piggyback gateway save on interaction drain
    if (maxInteractionTimestamp > 0) {
      try {
        const { gatewayDomains } = await chrome.storage.session.get(['gatewayDomains']);
        if (gatewayDomains) {
          const fh = await fsStorage.resolveFile('lists/gateways.json', { create: true });
          await fsStorage.writeJson(fh, { watermark: maxInteractionTimestamp, domains: gatewayDomains });
        }
      } catch {}
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
