// Offscreen document for handling filesystem operations
// Runs persistently in the background to manage file I/O
// Single consumer for write queue (MPSC) + per-file locks for all writes
import { FileSystemStorage } from './filesystem-storage.js';

console.log('Offscreen document loaded');

const fsStorage = new FileSystemStorage();

// --- Write Queue (MPSC: multiple producers, single consumer) ---
let writeQueue = [];
let draining = false;
let drainTimer = null;

function enqueueInteraction(entry) {
  // Dedup by URL in queue
  const idx = writeQueue.findIndex(e => e.interaction.url === entry.interaction.url);
  if (idx !== -1) writeQueue[idx] = entry;
  else writeQueue.push(entry);
  persistQueue();
  scheduleDrain();
}

function updateQueuedInteraction(url, updates) {
  const idx = writeQueue.findIndex(e => e.interaction.url === url);
  if (idx !== -1) {
    const entry = writeQueue[idx];
    Object.assign(entry.interaction, updates.interaction || {});
    if (updates.markdown !== undefined) entry.markdown = updates.markdown;
    if (updates.html !== undefined) entry.html = updates.html;
    persistQueue();
    scheduleDrain();
  }
}

async function persistQueue() {
  await chrome.storage.local.set({ writeBuffer: [...writeQueue] });
}

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(() => { drainTimer = null; drainQueue(); }, 100);
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  let maxTimestamp = 0;
  while (writeQueue.length > 0) {
    const entry = writeQueue[0];
    const result = await fsStorage.writeInteraction(
      entry.interaction, entry.markdown || '', entry.html || ''
    );
    if (result.success) {
      if (entry.interaction.timestamp > maxTimestamp) maxTimestamp = entry.interaction.timestamp;
      writeQueue.shift();
      await persistQueue();
    } else {
      // Retry in 30s
      setTimeout(() => drainQueue(), 30000);
      break;
    }
  }
  // Piggyback gateway save on drain
  if (maxTimestamp > 0) {
    try {
      const { gatewayDomains } = await chrome.storage.local.get(['gatewayDomains']);
      if (gatewayDomains) {
        await fsStorage.saveGateways({ watermark: maxTimestamp, domains: gatewayDomains });
      }
    } catch {}
  }
  draining = false;
}

// --- Per-File Lock ---
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

// Initialize filesystem on load
async function initialize() {
  try {
    await fsStorage.loadDirectoryHandle();
    const hasPermission = await fsStorage.verifyPermission();

    if (hasPermission) {
      console.log('Filesystem storage ready');
      // Load persisted queue and schedule drain
      const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
      writeQueue = writeBuffer;
      if (writeQueue.length > 0) {
        console.log(`Loaded ${writeQueue.length} queued interactions, scheduling drain`);
        scheduleDrain();
      }
    } else {
      console.log('No filesystem permission yet');
    }
  } catch (error) {
    console.log('Filesystem not configured yet:', error.message);
  }
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only handle filesystem actions — return false for others so background's
  // response is not shadowed (both listeners returning true causes a race).
  const handledActions = [
    'initializeFilesystem',
    'enqueueInteraction', 'updateQueuedInteraction', 'updateInteraction', 'clearWriteQueue',
    'getDirectoryInfo',
    'listSnapshots', 'captureSnapshot', 'deleteSnapshot',
    'loadHighlights', 'saveHighlights', 'loadAllHighlights', 'loadInteractionByUrl',
    'saveHighlight', 'deleteHighlight',
    'loadAtomBatch', 'loadPageDetail',
    'loadCollectionPins', 'saveCollectionPins', 'saveCollectionPinsById',
    'loadPermanentDeletes', 'savePermanentDeletes',
    'loadSettings', 'saveSettings', 'saveSettingsKey',
    'loadGateways', 'saveGateways', 'processGatewaysIncremental',
    'listInteractionFiles', 'loadInteractionBatch'
  ];
  if (!handledActions.includes(request.action)) {
    return false;
  }

  (async () => {
    try {
      switch (request.action) {
        case 'initializeFilesystem':
          await initialize();
          sendResponse({ success: true });
          break;

        case 'enqueueInteraction':
          enqueueInteraction(request.entry);
          sendResponse({ success: true });
          break;

        case 'updateQueuedInteraction':
          updateQueuedInteraction(request.url, request.updates);
          sendResponse({ success: true });
          break;

        case 'updateInteraction': {
          // Routed from content.js (same action name for backward compat)
          const updates = { interaction: {} };
          if (request.intent) updates.interaction.intent = request.intent;
          if (request.attention) updates.interaction.attention = JSON.stringify(request.attention);
          if (request.markdown) updates.markdown = request.markdown;
          if (request.html) updates.html = request.html;
          updateQueuedInteraction(request.interactionId, updates);
          sendResponse({ success: true });
          break;
        }

        case 'clearWriteQueue':
          writeQueue = [];
          await persistQueue();
          sendResponse({ success: true });
          break;

        case 'saveHighlight': {
          const hlSlug = request.slug;
          const highlights = await withLock('atom:' + hlSlug, async () => {
            const hl = (await fsStorage.loadHighlights(hlSlug)) || [];
            if (request.highlight.isGlobalNote) {
              const idx = hl.findIndex(h => h.isGlobalNote);
              if (idx >= 0) hl[idx] = request.highlight;
              else hl.unshift(request.highlight);
            } else {
              hl.push(request.highlight);
            }
            await fsStorage.saveHighlights(hlSlug, hl);
            return hl;
          });
          sendResponse({ success: true, highlights });
          break;
        }

        case 'deleteHighlight': {
          const dhSlug = request.slug;
          const remaining = await withLock('atom:' + dhSlug, async () => {
            let hl = (await fsStorage.loadHighlights(dhSlug)) || [];
            const before = hl.length;
            if (request.timestamp) {
              hl = hl.filter(h => h.timestamp !== request.timestamp);
            }
            if (hl.length === before && request.text) {
              const idx = hl.findIndex(h => {
                if (Array.isArray(h.text) && Array.isArray(request.text)) {
                  return JSON.stringify(h.text) === JSON.stringify(request.text);
                }
                return h.text === request.text;
              });
              if (idx >= 0) hl.splice(idx, 1);
            }
            await fsStorage.saveHighlights(dhSlug, hl);
            return hl;
          });
          sendResponse({ success: true, highlights: remaining });
          break;
        }

        case 'getDirectoryInfo': {
          const info = await fsStorage.getDirectoryInfo();
          sendResponse({ success: true, info });
          break;
        }

        case 'listSnapshots': {
          const t0 = performance.now();
          const snapshots = await fsStorage.listSnapshots(request.slug);
          console.debug(`[I/O] listSnapshots(${request.slug}): ${snapshots.length} snapshots in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, snapshots });
          break;
        }

        case 'captureSnapshot': {
          await withLock('snapshot:' + request.slug, () =>
            fsStorage.captureSnapshot(request.slug, request.timestamp, request.markdown || '', request.html || '')
          );
          sendResponse({ success: true });
          break;
        }

        case 'deleteSnapshot': {
          await fsStorage.deleteSnapshot(request.slug, request.timestamp);
          sendResponse({ success: true });
          break;
        }

        case 'loadHighlights': {
          const t0 = performance.now();
          const highlights = await fsStorage.loadHighlights(request.slug);
          console.debug(`[I/O] loadHighlights(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, highlights });
          break;
        }

        case 'saveHighlights': {
          await withLock('atom:' + request.slug, () =>
            fsStorage.saveHighlights(request.slug, request.highlights)
          );
          sendResponse({ success: true });
          break;
        }

        case 'loadAllHighlights': {
          const t0 = performance.now();
          const highlightsMap = await fsStorage.loadAllHighlights();
          console.debug(`[I/O] loadAllHighlights: ${Object.keys(highlightsMap).length} pages in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, highlightsMap });
          break;
        }

        case 'loadInteractionByUrl': {
          const t0 = performance.now();
          const interaction = await fsStorage.loadInteractionByUrl(request.url);
          console.debug(`[I/O] loadInteractionByUrl: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, interaction });
          break;
        }

        case 'loadAtomBatch': {
          const t0 = performance.now();
          const atoms = await fsStorage.loadAtomBatch(request.slugs);
          console.debug(`[I/O] loadAtomBatch: ${request.slugs.length} slugs in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, atoms });
          break;
        }

        case 'loadPageDetail': {
          const t0 = performance.now();
          const detail = await fsStorage.loadPageDetail(request.slug, request.url);
          console.debug(`[I/O] loadPageDetail(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, ...detail });
          break;
        }

        case 'loadCollectionPins': {
          const t0 = performance.now();
          if (request.collectionId) {
            const pins = await fsStorage.loadCollectionPinsById(request.collectionId);
            console.debug(`[I/O] loadCollectionPins(${request.collectionId}): ${pins.length} pins in ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse({ success: true, pins });
          } else {
            const allPins = await fsStorage.loadCollectionPins();
            console.debug(`[I/O] loadCollectionPins: ${Object.keys(allPins).length} collections in ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse({ success: true, pins: allPins });
          }
          break;
        }

        case 'saveCollectionPins': {
          await withLock('collectionPins', () =>
            fsStorage.saveCollectionPins(request.pins)
          );
          sendResponse({ success: true });
          break;
        }

        case 'saveCollectionPinsById': {
          await withLock('collectionPin:' + request.collectionId, () =>
            fsStorage.saveCollectionPinsById(request.collectionId, request.pins)
          );
          sendResponse({ success: true });
          break;
        }

        case 'loadPermanentDeletes': {
          const t0 = performance.now();
          const urls = await fsStorage.loadPermanentDeletes();
          console.debug(`[I/O] loadPermanentDeletes: ${urls.length} urls in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, urls });
          break;
        }

        case 'savePermanentDeletes': {
          await withLock('permanentDeletes', () =>
            fsStorage.savePermanentDeletes(request.urls)
          );
          sendResponse({ success: true });
          break;
        }

        case 'loadSettings': {
          const t0 = performance.now();
          const settings = await fsStorage.loadSettings();
          console.debug(`[I/O] loadSettings: ${Object.keys(settings).length} keys in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, settings });
          break;
        }

        case 'saveSettings': {
          await withLock('settings', () =>
            fsStorage.saveSettings(request.settings)
          );
          sendResponse({ success: true });
          break;
        }

        case 'saveSettingsKey': {
          await withLock('settings', async () => {
            const current = await fsStorage.loadSettings();
            current[request.key] = request.value;
            await fsStorage.saveSettings(current);
          });
          sendResponse({ success: true });
          break;
        }

        case 'loadGateways': {
          const t0 = performance.now();
          const gatewayData = await fsStorage.loadGateways();
          console.debug(`[I/O] loadGateways: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, ...gatewayData });
          break;
        }

        case 'saveGateways': {
          await withLock('gateways', () =>
            fsStorage.saveGateways(request.data)
          );
          sendResponse({ success: true });
          break;
        }

        case 'processGatewaysIncremental': {
          const result = await fsStorage.processGatewaysAfterWatermark(
            request.watermark, request.existingDomains
          );
          sendResponse({ success: true, ...result });
          break;
        }

        case 'listInteractionFiles': {
          const files = await fsStorage.listInteractionFiles();
          sendResponse({ success: true, files });
          break;
        }

        case 'loadInteractionBatch': {
          const t0 = performance.now();
          const interactions = await fsStorage.loadInteractionFiles(request.files);
          console.debug(`[I/O] loadInteractionBatch: ${request.files.length} files, ${interactions.length} items in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, interactions });
          break;
        }

      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true; // Keep message channel open for async response
});

// Initialize on load
initialize();

// Persist queue before unload (queue is already persisted on each change,
// but this ensures the latest state is saved)
window.addEventListener('beforeunload', async () => {
  await persistQueue();
});
