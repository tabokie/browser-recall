// Offscreen document for handling filesystem operations
// Runs persistently in the background to manage file I/O
import { FileSystemStorage } from './filesystem-storage.js';

console.log('Offscreen document loaded');

const fsStorage = new FileSystemStorage();
let flushInterval = null;

// Initialize filesystem on load
async function initialize() {
  try {
    await fsStorage.loadDirectoryHandle();
    const hasPermission = await fsStorage.verifyPermission();

    if (hasPermission) {
      console.log('Filesystem storage ready');
      startAutoFlush();
    } else {
      console.log('No filesystem permission yet');
    }
  } catch (error) {
    console.log('Filesystem not configured yet:', error.message);
  }
}

// Auto-flush buffer to filesystem every 30 seconds
function startAutoFlush() {
  if (flushInterval) return;

  flushInterval = setInterval(async () => {
    await flushBuffer();
  }, 30000); // 30 seconds

  console.log('Auto-flush started (every 30s)');
}

function stopAutoFlush() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
    console.log('Auto-flush stopped');
  }
}

// Flush write buffer to filesystem
async function flushBuffer() {
  try {
    const result = await chrome.storage.local.get(['writeBuffer']);
    const buffer = result.writeBuffer || [];

    if (buffer.length === 0) {
      return { success: true, count: 0 };
    }

    console.log(`Flushing ${buffer.length} interactions to filesystem...`);

    // Write each buffered entry (interaction + content)
    for (const entry of buffer) {
      const interaction = entry.interaction;
      const markdown = entry.markdown || '';
      const html = entry.html || '';

      const writeResult = await fsStorage.writeInteraction(interaction, markdown, html);
      if (!writeResult.success) {
        console.error('Failed to write interaction:', writeResult.error);
        return { success: false, error: writeResult.error };
      }
    }

    // Clear buffer after successful write
    await chrome.storage.local.set({ writeBuffer: [] });

    // Piggyback gateway save on flush
    try {
      const { gatewayDomains } = await chrome.storage.local.get(['gatewayDomains']);
      if (gatewayDomains) {
        // Find max timestamp from flushed entries
        let maxTimestamp = 0;
        for (const entry of buffer) {
          if (entry.interaction.timestamp > maxTimestamp) maxTimestamp = entry.interaction.timestamp;
        }
        await fsStorage.saveGateways({
          watermark: maxTimestamp,
          domains: gatewayDomains
        });
      }
    } catch (gwErr) {
      console.warn('Gateway save during flush failed:', gwErr.message);
    }

    console.log(`Flushed ${buffer.length} interactions`);

    return { success: true, count: buffer.length };
  } catch (error) {
    console.error('Error flushing buffer:', error);
    return { success: false, error: error.message };
  }
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only handle filesystem actions — return false for others so background's
  // response is not shadowed (both listeners returning true causes a race).
  const handledActions = [
    'initializeFilesystem', 'writeInteraction', 'flushBuffer',
    'loadInteractions', 'loadContent', 'loadAllContent',
    'getDirectoryInfo', 'changeDirectory', 'migrateData',
    'listSnapshots', 'captureSnapshot', 'deleteSnapshot',
    'loadHighlights', 'saveHighlights', 'loadAllHighlights', 'loadInteractionByUrl',
    'loadCollectionPins', 'saveCollectionPins',
    'loadSettings', 'saveSettings', 'saveSettingsKey',
    'loadContentBatch',
    'loadGateways', 'saveGateways', 'processGatewaysIncremental'
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

        case 'writeInteraction':
          // Write to filesystem immediately (interaction + content files)
          const writeResult = await fsStorage.writeInteraction(
            request.interaction,
            request.markdown || '',
            request.html || ''
          );
          sendResponse(writeResult);
          break;

        case 'flushBuffer':
          const flushResult = await flushBuffer();
          sendResponse(flushResult);
          break;

        case 'loadInteractions': {
          // Read from filesystem (source of truth) — metadata only
          const t0 = performance.now();
          const interactions = await fsStorage.loadAllInteractions();
          console.debug(`[I/O] loadInteractions: ${interactions.length} items in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, interactions });
          break;
        }

        case 'loadContent': {
          // Load markdown content for a single interaction by slug
          const t0 = performance.now();
          const content = await fsStorage.loadContentForInteraction(request.slug);
          console.debug(`[I/O] loadContent(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, content });
          break;
        }

        case 'loadAllContent': {
          // Load all markdown content from pages/ directory
          const t0 = performance.now();
          const contentMap = await fsStorage.loadAllContent();
          console.debug(`[I/O] loadAllContent: ${Object.keys(contentMap).length} pages in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, contentMap });
          break;
        }

        case 'loadContentBatch': {
          const t0 = performance.now();
          const contentMap2 = await fsStorage.loadContentBatch(request.slugs);
          console.debug(`[I/O] loadContentBatch: ${request.slugs.length} slugs in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, contentMap: contentMap2 });
          break;
        }

        case 'getDirectoryInfo':
          const info = await fsStorage.getDirectoryInfo();
          sendResponse({ success: true, info });
          break;

        case 'changeDirectory':
          // User wants to change storage location
          const selectResult = await fsStorage.selectDirectory();
          if (selectResult.success) {
            startAutoFlush();
          }
          sendResponse(selectResult);
          break;

        case 'migrateData':
          // Migrate data when changing directory (now with contentMap)
          const migrateResult = await fsStorage.writeAllInteractions(
            request.interactions,
            request.contentMap || {}
          );
          sendResponse(migrateResult);
          break;

        case 'listSnapshots': {
          const t0 = performance.now();
          const snapshots = await fsStorage.listSnapshots(request.slug);
          console.debug(`[I/O] listSnapshots(${request.slug}): ${snapshots.length} snapshots in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, snapshots });
          break;
        }

        case 'captureSnapshot': {
          await fsStorage.captureSnapshot(request.slug, request.timestamp, request.markdown || '', request.html || '');
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
          await fsStorage.saveHighlights(request.slug, request.highlights);
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

        case 'loadCollectionPins': {
          const t0 = performance.now();
          const allPins = await fsStorage.loadCollectionPins();
          console.debug(`[I/O] loadCollectionPins: ${Object.keys(allPins).length} collections in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, pins: allPins });
          break;
        }

        case 'saveCollectionPins': {
          await fsStorage.saveCollectionPins(request.pins);
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
          await fsStorage.saveSettings(request.settings);
          sendResponse({ success: true });
          break;
        }

        case 'saveSettingsKey': {
          const current = await fsStorage.loadSettings();
          current[request.key] = request.value;
          await fsStorage.saveSettings(current);
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
          await fsStorage.saveGateways(request.data);
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

// Flush buffer before unload
window.addEventListener('beforeunload', async () => {
  stopAutoFlush();
  await flushBuffer();
});
