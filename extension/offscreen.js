// Offscreen document — pure filesystem I/O worker.
//
// Responds to read requests from background via port channel.
// Monitors storage.local['writeBuffer'] via chrome.storage.onChanged
// and drains pending writes to the filesystem.
//
// Why offscreen? MV3 service workers have no document context. The File System
// Access API requires a document to store FileSystemDirectoryHandle in IndexedDB
// and call its methods.
import { FileSystemStorage } from './filesystem-storage.js';

console.log('Offscreen document loaded');

const fsStorage = new FileSystemStorage();

// ─── Port Channel ─────────────────────────────────────────────────────

let bgPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bg-offscreen') return;
  bgPort = port;
  console.log('Port connected to background');

  port.onMessage.addListener(async (msg) => {
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

      case 'loadReferrerIndex': {
        const t0 = performance.now();
        const data = await fsStorage.loadReferrerIndex();
        console.debug(`[I/O] loadReferrerIndex: ${(performance.now() - t0).toFixed(1)}ms`);
        return { success: true, ...data };
      }

      case 'buildReferrerIndexIncremental': {
        const result = await fsStorage.buildReferrerIndexAfterWatermark(
          request.watermark, request.existingIndex
        );
        return { success: true, ...result };
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

      default:
        return { success: false, error: `Unknown action: ${request.action}` };
    }
  } catch (error) {
    console.error('Error handling request:', error);
    return { success: false, error: error.message };
  }
}

// ─── Write Buffer Drain ───────────────────────────────────────────────
// Monitors storage.local['writeBuffer'] and flushes entries to filesystem.

let drainTimer = null;
let draining = false;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.writeBuffer) return;
  scheduleDrain();
});

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; drainQueue(); }, 100);
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  try {
    if (!(await fsStorage.verifyPermission())) {
      draining = false;
      return;
    }

    const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
    if (writeBuffer.length === 0) {
      draining = false;
      return;
    }

    let lastFlushedId = 0;
    let maxInteractionTimestamp = 0;

    for (const entry of writeBuffer) {
      try {
        if (entry.type === 'json') {
          const fh = await fsStorage.resolveFile(entry.path, { create: true });
          await fsStorage.writeJson(fh, entry.data);
        } else if (entry.type === 'interaction') {
          const result = await fsStorage.writeInteraction(
            entry.entry.interaction, entry.entry.markdown || '', entry.entry.html || ''
          );
          if (!result.success) {
            console.error('Interaction write failed:', result.error);
            setTimeout(scheduleDrain, 30000);
            break;
          }
          if (entry.entry.interaction.timestamp > maxInteractionTimestamp) {
            maxInteractionTimestamp = entry.entry.interaction.timestamp;
          }
        } else if (entry.type === 'snapshot') {
          await fsStorage.captureSnapshot(entry.slug, entry.timestamp, entry.markdown, entry.html);
        }
        lastFlushedId = entry.id || 0;
      } catch (e) {
        console.error('Flush failed for entry:', entry.type, e);
        setTimeout(scheduleDrain, 30000);
        break;
      }
    }

    // Piggyback gateway + referrer index save on interaction drain
    if (maxInteractionTimestamp > 0) {
      try {
        const { gatewayDomains } = await chrome.storage.session.get(['gatewayDomains']);
        if (gatewayDomains) {
          const fh = await fsStorage.resolveFile('lists/gateways.json', { create: true });
          await fsStorage.writeJson(fh, { watermark: maxInteractionTimestamp, domains: gatewayDomains });
        }
      } catch {}
      try {
        const { referrerIndex } = await chrome.storage.session.get(['referrerIndex']);
        if (referrerIndex) {
          const fh = await fsStorage.resolveFile('lists/referrer-index.json', { create: true });
          await fsStorage.writeJson(fh, { watermark: maxInteractionTimestamp, index: referrerIndex });
        }
      } catch {}
    }

    if (lastFlushedId > 0 && bgPort) {
      bgPort.postMessage({ action: 'persisted', watermark: lastFlushedId });
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
      // Trigger initial drain in case there are pending writes
      scheduleDrain();
    } else {
      console.log('No filesystem permission yet');
    }
  } catch (error) {
    console.log('Filesystem not configured yet:', error.message);
  }
}

initialize();
