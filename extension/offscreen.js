// Offscreen document for handling filesystem operations
// Runs persistently in the background to manage file I/O

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
      // Support both new format {interaction, markdown, html} and old format (plain interaction)
      const interaction = entry.interaction || entry;
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
    console.log(`Flushed ${buffer.length} interactions`);

    return { success: true, count: buffer.length };
  } catch (error) {
    console.error('Error flushing buffer:', error);
    return { success: false, error: error.message };
  }
}

// Handle messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

        case 'loadInteractions':
          // Read from filesystem (source of truth) — metadata only
          const interactions = await fsStorage.loadAllInteractions();
          sendResponse({ success: true, interactions });
          break;

        case 'loadContent':
          // Load markdown content for a single interaction by slug
          const content = await fsStorage.loadContentForInteraction(request.slug);
          sendResponse({ success: true, content });
          break;

        case 'loadAllContent':
          // Load all markdown content from pages/ directory
          const contentMap = await fsStorage.loadAllContent();
          sendResponse({ success: true, contentMap });
          break;

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

        default:
          sendResponse({ success: false, error: 'Unknown action' });
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
