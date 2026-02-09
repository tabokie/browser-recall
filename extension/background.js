// Background service worker for Portal extension
// Note: WASM cannot be used in MV3 service workers due to CSP restrictions
// Search functionality is handled in popup.js instead
console.log('Background script loading...');

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('Portal extension installed');

  // Initialize storage
  chrome.storage.local.set({
    interactions: [],
    settings: {
      captureContent: true,
      captureAttention: true,
      archiveQuality: 'medium'
    }
  }, () => {
    console.log('✓ Storage initialized');
  });
});

// Track page visits and interactions
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  console.log(`Tab ${tabId} updated:`, changeInfo.status, tab.url);

  if (changeInfo.status === 'complete' && tab.url) {
    // Skip chrome:// URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      console.log('Skipping chrome internal URL:', tab.url);
      return;
    }

    try {
      console.log(`Processing page: ${tab.url}`);

      // Create interaction record (plain JS object, no WASM)
      const timestamp = Date.now();
      const interaction = {
        id: `${timestamp}-${tab.url}`,
        timestamp: timestamp,
        url: tab.url,
        title: tab.title || 'Untitled',
        intent: '',
        content: '',
        attention: ''
      };

      console.log('Created interaction:', interaction.id);

      // Send message to content script to capture intent and attention
      chrome.tabs.sendMessage(tabId, {
        action: 'captureInteraction',
        interactionId: interaction.id
      }).then(() => {
        console.log('✓ Message sent to content script');
      }).catch((error) => {
        console.warn('Could not send message to content script:', error.message);
        // Continue even if content script fails
      });

      // Store interaction
      console.log('Interaction data:', interaction);

      chrome.storage.local.get(['interactions'], (result) => {
        const interactions = result.interactions || [];
        interactions.push(interaction);

        chrome.storage.local.set({ interactions }, () => {
          console.log(`✓ Stored interaction #${interactions.length}:`, tab.title);
        });
      });
    } catch (error) {
      console.error('✗ Error processing page visit:', error);
    }
  }
});

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'updateInteraction':
      // Update interaction with intent/attention data
      console.log('Updating interaction:', request.interactionId);
      chrome.storage.local.get(['interactions'], (result) => {
        const interactions = result.interactions || [];
        const index = interactions.findIndex(i => i.id === request.interactionId);

        if (index !== -1) {
          if (request.intent) interactions[index].intent = request.intent;
          if (request.content) interactions[index].content = request.content;
          if (request.attention) interactions[index].attention = JSON.stringify(request.attention);

          chrome.storage.local.set({ interactions }, () => {
            console.log('✓ Updated interaction with captured data');
          });
        }
      });
      sendResponse({ success: true });
      break;

    default:
      sendResponse({ error: 'Unknown action' });
  }

  return true; // Keep message channel open for async response
});
