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

// Apply title trimming rules and whitespace trim
async function trimTitle(rawTitle, url) {
  let title = rawTitle || 'Untitled';
  const { titleTrimRules = [] } = await chrome.storage.local.get(['titleTrimRules']);
  for (const rule of titleTrimRules) {
    if (url.startsWith(rule.urlPrefix)) {
      if (rule.action === 'remove_after_pipe') {
        const pipeIdx = title.indexOf('|');
        if (pipeIdx > 0) title = title.substring(0, pipeIdx);
      } else if (rule.action === 'remove_brackets') {
        title = title.replace(/\s*\[[^\]]*\]\s*/g, ' ');
      } else if (rule.action === 'remove_parens') {
        title = title.replace(/\s*\([^)]*\)\s*/g, ' ');
      }
    }
  }
  return title.trim();
}

// --- Gateway domain registry ---
// Storage: chrome.storage.local['gatewayDomains'] = { [origin]: { rootUrl, childUrls, fetched } }

function isSearchQueryGateway(url) {
  try {
    const params = new URL(url).searchParams;
    return params.has('q') || params.has('query') || params.has('search');
  } catch { return false; }
}

async function updateGatewayRegistry(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const isSearchQuery = parsed.searchParams.has('q') || parsed.searchParams.has('query') || parsed.searchParams.has('search');
    const isRoot = parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname === '/index.html' || parsed.pathname === '/index.htm';

    const { gatewayDomains = {} } = await chrome.storage.local.get(['gatewayDomains']);
    if (!gatewayDomains[origin]) {
      gatewayDomains[origin] = { rootUrl: null, childUrls: [], fetched: false };
    }
    const entry = gatewayDomains[origin];

    if (isSearchQuery) {
      // Search query URLs are always children, never the root itself
      if (!entry.childUrls.includes(url)) {
        entry.childUrls.push(url);
      }
      // Root-path search (e.g. duckduckgo.com/?q=…) — use clean domain as root
      if (isRoot && !entry.rootUrl && !entry.fetched) {
        await chrome.storage.local.set({ gatewayDomains });
        fetchAndCreateGatewayRoot(origin);
        return;
      }
    } else if (isRoot) {
      entry.rootUrl = url;
    } else {
      if (!entry.childUrls.includes(url)) {
        entry.childUrls.push(url);
      }
    }

    await chrome.storage.local.set({ gatewayDomains });

    // Auto-promote: if 2+ children and no root visited yet, fetch it
    if (entry.childUrls.length >= 2 && !entry.rootUrl && !entry.fetched) {
      fetchAndCreateGatewayRoot(origin);
    }
  } catch (e) {
    console.warn('Gateway registry update failed:', e.message);
  }
}

async function fetchAndCreateGatewayRoot(origin) {
  // Mark fetched immediately to prevent concurrent attempts
  const { gatewayDomains = {} } = await chrome.storage.local.get(['gatewayDomains']);
  if (!gatewayDomains[origin]) return;
  gatewayDomains[origin].fetched = true;
  await chrome.storage.local.set({ gatewayDomains });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(origin + '/', { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resp.ok) return;

    const html = await resp.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const rootUrl = origin + '/';
    const rawTitle = titleMatch ? titleMatch[1].trim() : origin;
    const title = await trimTitle(rawTitle, rootUrl);
    const slug = generateSlugFromUrl(rootUrl);

    const interaction = {
      id: rootUrl,
      timestamp: Date.now(),
      url: rootUrl,
      title: title,
      intent: '',
      attention: '',
      slug: slug
    };

    await setupOffscreenDocument();
    await chrome.runtime.sendMessage({
      action: 'writeInteraction',
      interaction,
      markdown: '',
      html: ''
    });

    // Update registry with rootUrl
    const updated = (await chrome.storage.local.get(['gatewayDomains'])).gatewayDomains || {};
    if (updated[origin]) {
      updated[origin].rootUrl = rootUrl;
      await chrome.storage.local.set({ gatewayDomains: updated });
    }

    console.log(`Gateway: created synthetic root for ${origin}`);
  } catch (e) {
    console.warn(`Gateway: failed to fetch root for ${origin}:`, e.message);
  }
}

// Track page visits and interactions
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Handle title changes — update existing record
  if (changeInfo.title && tab.url) {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
    const { workspace } = await chrome.storage.local.get(['workspace']);
    if (workspace && workspace.mode === 'private') return;

    const result = await chrome.storage.local.get(['writeBuffer']);
    const buffer = result.writeBuffer || [];
    const existingIndex = buffer.findIndex(entry => entry.interaction.url === tab.url);
    if (existingIndex !== -1) {
      const title = await trimTitle(changeInfo.title, tab.url);
      buffer[existingIndex].interaction.title = title;
      buffer[existingIndex].interaction.timestamp = Date.now();
      await chrome.storage.local.set({ writeBuffer: buffer });

      await setupOffscreenDocument();
      chrome.runtime.sendMessage({
        action: 'writeInteraction',
        interaction: buffer[existingIndex].interaction,
        markdown: buffer[existingIndex].markdown,
        html: buffer[existingIndex].html
      }).catch(err => {
        console.warn('Title update write failed:', err.message);
      });
      console.log(`Title updated for ${tab.url}: ${title}`);
    }
  }

  if (changeInfo.status === 'complete' && tab.url) {
    // Private mode: skip all tracking
    const { workspace } = await chrome.storage.local.get(['workspace']);
    if (workspace && workspace.mode === 'private') return;

    // Skip chrome:// URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    // Skip blacklisted URL prefixes, unless the page was previously captured
    const { urlBlacklist } = await chrome.storage.local.get(['urlBlacklist']);
    const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
    if (blacklist.some(prefix => tab.url.startsWith(prefix))) {
      const existing = await chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: tab.url });
      if (!existing || !existing.interaction) {
        console.log(`Skipping blacklisted URL (not in database): ${tab.url}`);
        return;
      }
      console.log(`Blacklisted URL but already in database, continuing: ${tab.url}`);
    }

    try {
      console.log(`Processing page: ${tab.url}`);

      const timestamp = Date.now();
      const slug = generateSlugFromUrl(tab.url);

      const title = await trimTitle(tab.title, tab.url);

      // Create interaction record (metadata only, no content)
      // URL is the identity — revisiting the same URL updates the entry
      const interaction = {
        id: tab.url,
        timestamp: timestamp,
        url: tab.url,
        title: title,
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

      // Update gateway domain registry (non-blocking)
      updateGatewayRegistry(tab.url);

      // If buffer is large, trigger flush
      if (buffer.length >= 10) {
        console.log('Buffer full, triggering flush...');
        chrome.runtime.sendMessage({ action: 'flushBuffer' })
          .catch(error => console.warn('Flush failed:', error.message));
      }

      // Workspace mode: auto-pin to workspace collections and optionally snapshot
      const { workspace } = await chrome.storage.local.get(['workspace']);
      const wsCollectionIds = workspace?.collectionIds || workspace?.topicIds || [];
      if (workspace && (workspace.mode === 'workspace' || workspace.enabled) && wsCollectionIds.length > 0) {
        try {
          const pinsResp = await chrome.runtime.sendMessage({ action: 'loadCollectionPins' });
          const allPins = (pinsResp && pinsResp.pins) ? pinsResp.pins : {};
          let changed = false;

          for (const collectionId of wsCollectionIds) {
            if (!allPins[collectionId]) allPins[collectionId] = [];
            const already = allPins[collectionId].some(p => p.url === tab.url);
            if (!already) {
              allPins[collectionId].push({ url: tab.url, title: tab.title || 'Untitled', pinnedAt: timestamp });
              changed = true;
            }
          }

          if (changed) {
            await chrome.runtime.sendMessage({ action: 'saveCollectionPins', pins: allPins });
            console.log(`Workspace: auto-pinned ${tab.url} to collections ${wsCollectionIds.join(', ')}`);
          }

          if (workspace.autoSnapshot) {
            chrome.tabs.sendMessage(tabId, { action: 'captureCurrentPage' }).then(async (response) => {
              if (response && response.success) {
                await setupOffscreenDocument();
                await chrome.runtime.sendMessage({
                  action: 'captureSnapshot',
                  slug,
                  timestamp,
                  markdown: response.markdown || '',
                  html: response.html || ''
                });
                console.log(`Workspace: auto-snapshot captured for ${tab.url}`);
              }
            }).catch(err => {
              console.warn('Workspace: auto-snapshot failed:', err.message);
            });
          }
        } catch (err) {
          console.warn('Workspace: auto-pin/snapshot error:', err.message);
        }
      }

    } catch (error) {
      console.error('Error processing page visit:', error);
    }
  }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  console.log(`[background] Command received: ${command}`);

  // Private mode: disable all commands
  const { workspace } = await chrome.storage.local.get(['workspace']);
  if (workspace && workspace.mode === 'private') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    console.log('[background] Command ignored: no suitable tab');
    return;
  }

  if (command === 'capture-snapshot') {
    // Ask content script to extract page content
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'captureCurrentPage' });
      if (response && response.success) {
        const slug = generateSlugFromUrl(tab.url);
        const timestamp = Date.now();
        await setupOffscreenDocument();
        await chrome.runtime.sendMessage({
          action: 'captureSnapshot',
          slug,
          timestamp,
          markdown: response.markdown || '',
          html: response.html || ''
        });
        console.log(`Snapshot captured for ${tab.url}`);
      }
    } catch (error) {
      console.warn('Could not capture snapshot:', error.message);
    }
  } else if (command === 'highlight-selection') {
    try {
      console.log(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
      console.log('[background] highlightSelection response:', resp);
    } catch (error) {
      console.warn('[background] Could not highlight selection:', error.message);
    }
  }
});

// Handle messages from content scripts and offscreen document
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handledActions = ['updateInteraction', 'getPageInfo', 'captureCurrentPageFromPopup', 'saveHighlight', 'deleteHighlight'];
  if (!handledActions.includes(request.action)) {
    return false;
  }

  (async () => {
    if (request.action === 'updateInteraction') {
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

    } else if (request.action === 'getPageInfo') {
      // Popup requests bundled page info for a URL
      await setupOffscreenDocument();
      const slug = generateSlugFromUrl(request.url);

      const [interactionResp, snapshotsResp, highlightsResp] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'loadInteractionByUrl', url: request.url }),
        chrome.runtime.sendMessage({ action: 'listSnapshots', slug }),
        chrome.runtime.sendMessage({ action: 'loadHighlights', slug })
      ]);

      sendResponse({
        success: true,
        slug,
        interaction: interactionResp?.interaction || null,
        snapshots: snapshotsResp?.snapshots || [],
        highlights: highlightsResp?.highlights || []
      });

    } else if (request.action === 'captureCurrentPageFromPopup') {
      // Popup requests a snapshot capture of the active tab
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { sendResponse({ success: false, error: 'No active tab' }); return; }

        const response = await chrome.tabs.sendMessage(tab.id, { action: 'captureCurrentPage' });
        if (response && response.success) {
          const slug = generateSlugFromUrl(tab.url);
          const timestamp = Date.now();
          await setupOffscreenDocument();
          await chrome.runtime.sendMessage({
            action: 'captureSnapshot',
            slug,
            timestamp,
            markdown: response.markdown || '',
            html: response.html || ''
          });
          sendResponse({ success: true, timestamp });
        } else {
          sendResponse({ success: false, error: 'Content script capture failed' });
        }
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }

    } else if (request.action === 'saveHighlight') {
      // Content script or popup saves a highlight
      console.log(`[background] saveHighlight: slug=${request.slug}`);
      await setupOffscreenDocument();
      const slug = request.slug;

      // Load existing highlights, upsert global note or append highlight
      const loadResp = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
      console.log(`[background] Loaded ${loadResp?.highlights?.length || 0} existing highlights`);
      const highlights = loadResp?.highlights || [];

      if (request.highlight.isGlobalNote) {
        const idx = highlights.findIndex(h => h.isGlobalNote);
        if (idx >= 0) {
          highlights[idx] = request.highlight;
        } else {
          highlights.unshift(request.highlight);
        }
      } else {
        highlights.push(request.highlight);
      }

      await chrome.runtime.sendMessage({ action: 'saveHighlights', slug, highlights });
      console.log(`[background] Saved ${highlights.length} highlights for slug=${slug}`);
      sendResponse({ success: true, highlights });

    } else if (request.action === 'deleteHighlight') {
      const displayText = Array.isArray(request.text) ? request.text.join(' ') : request.text;
      console.log(`[background] deleteHighlight: slug=${request.slug}, text="${displayText?.substring(0, 50)}"`);
      await setupOffscreenDocument();
      const slug = request.slug;

      const loadResp = await chrome.runtime.sendMessage({ action: 'loadHighlights', slug });
      let highlights = loadResp?.highlights || [];

      // Remove by timestamp first (reliable for both single and grouped highlights)
      const before = highlights.length;
      if (request.timestamp) {
        highlights = highlights.filter(h => h.timestamp !== request.timestamp);
      }
      // Fallback: match by text if timestamp didn't match
      if (highlights.length === before && request.text) {
        const idx = highlights.findIndex(h => {
          if (Array.isArray(h.text) && Array.isArray(request.text)) {
            return JSON.stringify(h.text) === JSON.stringify(request.text);
          }
          return h.text === request.text;
        });
        if (idx >= 0) highlights.splice(idx, 1);
      }

      await chrome.runtime.sendMessage({ action: 'saveHighlights', slug, highlights });
      console.log(`[background] Deleted highlight, ${highlights.length} remaining`);
      sendResponse({ success: true, highlights });
    }
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
