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
import { effectOf, defaultEntity } from './replay.js';

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

      case 'atomExists': {
        const exists = await fsStorage.atomExists(request.slug);
        return { success: true, exists };
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

    // ── Round cache: entity key → entity (or null for non-existent atoms) ──
    // Populated lazily from filesystem on first access per key.
    // After processing all entries, dirty keys are flushed back to disk.
    const roundCache = new Map();   // key → entity | null
    const dirtyKeys = new Set();

    // Filesystem existence cache for atoms (avoids repeated disk checks)
    const atomExistsCache = new Map();
    const atomExistsCached = async (slug) => {
      let v = atomExistsCache.get(slug);
      if (v === undefined) {
        v = await fsStorage.atomExists(slug);
        atomExistsCache.set(slug, v);
      }
      return v;
    };

    // Load an entity into roundCache if not already present
    const ensureLoaded = async (key) => {
      if (roundCache.has(key)) return;
      if (key.startsWith('atom:')) {
        const slug = key.slice(5);
        const exists = await atomExistsCached(slug);
        if (exists) {
          const atom = (await fsStorage.loadAtom(slug)) || defaultEntity(key);
          if (!atom.slug) atom.slug = slug;
          roundCache.set(key, atom);
        } else {
          roundCache.set(key, null);
        }
      } else if (key === 'settings') {
        let s = await fsStorage.loadSettings();
        if (!s.timestamp) s.timestamp = 0;
        roundCache.set(key, s);
      } else if (key.startsWith('list:user/')) {
        const cid = key.slice('list:user/'.length);
        roundCache.set(key, await fsStorage.loadCollectionPinsEntity(cid));
      } else if (key === 'list:recycle-bin') {
        roundCache.set(key, await fsStorage.loadRecycleBinEntity());
      } else if (key === 'list:permanent-deletes') {
        roundCache.set(key, await fsStorage.loadPermanentDeletesEntity());
      } else if (key === 'index:parent-index') {
        try {
          roundCache.set(key, await fsStorage.loadParentIndex());
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
          // Update atomExistsCache when atom transitions null → non-null
          if (key.startsWith('atom:') && prev === null && entity !== null) {
            atomExistsCache.set(key.slice(5), true);
          }
        }
      }

      if (!entry.action && entry.timestamp > maxInteractionTimestamp) {
        maxInteractionTimestamp = entry.timestamp;
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

    // 2. Flush dirty entities from round cache to disk
    // Build URL→title map for parent/children resolution
    const titleByUrl = new Map();
    for (const entry of logBuffer) {
      if (entry.url && entry.title) titleByUrl.set(entry.url, entry.title);
    }

    // Collect all checkpointed atom slugs for parent/children resolution
    const checkpointedSlugs = new Set();
    for (const key of dirtyKeys) {
      if (key.startsWith('atom:')) checkpointedSlugs.add(key.slice(5));
    }

    for (const key of dirtyKeys) {
      const entity = roundCache.get(key);
      if (entity === null) continue;

      if (key.startsWith('atom:')) {
        const slug = key.slice(5);
        await withLock('atoms/' + slug + '.json', async () => {
          const atom = entity;
          // Resolve parents/children: URL → slug (checkpointed) or {url,title}
          for (const field of ['parents', 'children']) {
            if (atom[field] && atom[field].length > 0) {
              const resolved = [];
              for (const ref of atom[field]) {
                if (typeof ref !== 'string') { resolved.push(ref); continue; }
                if (!ref.startsWith('http')) { resolved.push(ref); continue; }
                const refSlug = generateSlugFromUrl(ref);
                if (checkpointedSlugs.has(refSlug) || await fsStorage.atomExists(refSlug)) {
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
      } else if (key === 'settings') {
        await withLock('settings.json', async () => {
          await fsStorage.saveSettings(entity);
        });
      } else if (key.startsWith('list:user/')) {
        const cid = key.slice('list:user/'.length);
        await withLock('lists/user/' + cid + '.json', async () => {
          if (entity.deleted) {
            await fsStorage.deleteCollectionFile(cid);
          } else {
            await fsStorage.saveCollectionMeta(cid, entity, entity.timestamp);
          }
        });
      } else if (key === 'list:recycle-bin') {
        await withLock('lists/recycle-bin.json', async () => {
          await fsStorage.saveRecycleBin(entity.items, entity.timestamp);
        });
      } else if (key === 'list:permanent-deletes') {
        await withLock('lists/permanent-deletes.json', async () => {
          await fsStorage.savePermanentDeletes(entity.urls, entity.timestamp);
        });
      } else if (key === 'index:parent-index') {
        await withLock('lists/index/parent-index.json', async () => {
          // Prune entries for URLs whose atoms were just checkpointed
          const idx = { ...entity, index: { ...entity.index } };
          for (const url of Object.keys(idx.index)) {
            const urlSlug = generateSlugFromUrl(url);
            if (checkpointedSlugs.has(urlSlug)) {
              delete idx.index[url];
            }
          }
          const fh = await fsStorage.resolveFile('lists/index/parent-index.json', { create: true });
          await fsStorage.writeJson(fh, idx);
        });
      }
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
