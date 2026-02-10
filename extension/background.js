// Background service worker for Portal extension
// Uses filesystem as primary storage with IndexedDB as write buffer
import { generateSlugFromUrl } from './utils.js';

console.log('Background script loading...');

// Create offscreen document for filesystem operations
async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['LOCAL_STORAGE'],
    justification: 'Manage filesystem operations for interaction history'
  });

  console.log('Offscreen document created');
}

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Portal extension installed');

  // Create offscreen document
  await setupOffscreenDocument();

  // Initialize empty write buffer
  await chrome.storage.local.set({
    writeBuffer: [],
    settings: {
      captureContent: true,
      captureAttention: true,
      archiveQuality: 'medium'
    }
  });

  console.log('Storage initialized');

  // Check if filesystem is configured
  const response = await chrome.runtime.sendMessage({ action: 'getDirectoryInfo' });

  if (!response.info) {
    console.log('Filesystem not configured - user needs to select directory');
    chrome.runtime.openOptionsPage();
  } else {
    console.log('Filesystem configured:', response.info.name);
  }
});

// Ensure offscreen document on startup
chrome.runtime.onStartup.addListener(async () => {
  await setupOffscreenDocument();
  console.log('Extension started');
});

// Track page visits and interactions
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Skip chrome:// URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    try {
      console.log(`Processing page: ${tab.url}`);

      const timestamp = Date.now();
      const slug = generateSlugFromUrl(tab.url);

      // Create interaction record (metadata only, no content)
      // URL is the identity — revisiting the same URL updates the entry
      const interaction = {
        id: tab.url,
        timestamp: timestamp,
        url: tab.url,
        title: tab.title || 'Untitled',
        intent: '',
        attention: '',
        slug: slug
      };

      // Send message to content script to capture intent and attention
      chrome.tabs.sendMessage(tabId, {
        action: 'captureInteraction',
        interactionId: interaction.id
      }).catch((error) => {
        console.warn('Could not send message to content script:', error.message);
      });

      // Add to write buffer: metadata + content placeholders
      // Dedup by URL — on revisit, update existing buffer entry
      const result = await chrome.storage.local.get(['writeBuffer']);
      const buffer = result.writeBuffer || [];
      const existingIndex = buffer.findIndex(entry => entry.interaction.url === tab.url);
      if (existingIndex !== -1) {
        buffer[existingIndex].interaction = interaction;
      } else {
        buffer.push({
          interaction: interaction,
          markdown: '',
          html: ''
        });
      }
      await chrome.storage.local.set({ writeBuffer: buffer });

      console.log(`Added to buffer (${buffer.length} pending)`);

      // Trigger immediate write to filesystem
      await setupOffscreenDocument();
      chrome.runtime.sendMessage({
        action: 'writeInteraction',
        interaction: interaction,
        markdown: '',
        html: ''
      }).catch(error => {
        console.warn('Offscreen write failed, will retry on next flush:', error.message);
      });

      // If buffer is large, trigger flush
      if (buffer.length >= 10) {
        console.log('Buffer full, triggering flush...');
        chrome.runtime.sendMessage({ action: 'flushBuffer' })
          .catch(error => console.warn('Flush failed:', error.message));
      }

    } catch (error) {
      console.error('Error processing page visit:', error);
    }
  }
});

// Handle messages from content scripts and offscreen document
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only handle messages this script is responsible for.
  // Other messages (loadInteractions, loadAllContent, etc.) are handled by
  // the offscreen document — we must not respond to them here, or we'll
  // race with and shadow the offscreen document's response.
  if (request.action !== 'updateInteraction') {
    return false;
  }

  (async () => {
    // Update interaction in buffer with captured content
    const result = await chrome.storage.local.get(['writeBuffer']);
    const buffer = result.writeBuffer || [];
    const index = buffer.findIndex(entry => entry.interaction.id === request.interactionId);

    if (index !== -1) {
      const entry = buffer[index];
      if (request.intent) entry.interaction.intent = request.intent;
      if (request.attention) entry.interaction.attention = JSON.stringify(request.attention);
      if (request.markdown) entry.markdown = request.markdown;
      if (request.html) entry.html = request.html;

      await chrome.storage.local.set({ writeBuffer: buffer });

      // Write updated data to filesystem
      await setupOffscreenDocument();
      chrome.runtime.sendMessage({
        action: 'writeInteraction',
        interaction: entry.interaction,
        markdown: entry.markdown,
        html: entry.html
      }).catch(() => {});

      console.log('Updated interaction with captured data');
    }
    sendResponse({ success: true });
  })();

  return true;
});

// Periodic flush (every 60 seconds)
setInterval(async () => {
  try {
    await setupOffscreenDocument();
    const response = await chrome.runtime.sendMessage({ action: 'flushBuffer' });
    if (response && response.count > 0) {
      console.log(`Periodic flush: ${response.count} interactions written`);
    }
  } catch (error) {
    console.warn('Periodic flush failed:', error.message);
  }
}, 60000);
