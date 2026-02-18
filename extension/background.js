// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl } from './utils.js';

console.log('Background script loading...');

// Session storage: in-memory IPC, survives SW termination, cleared on browser restart.
// hydrateCache() re-populates from filesystem on every startup.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// ─── Offscreen Document ───────────────────────────────────────────────

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['LOCAL_STORAGE'],
    justification: 'Manage filesystem operations for interaction history'
  });
  console.log('Offscreen document created');
}

// ─── Port Channel to Offscreen ────────────────────────────────────────

let offscreenPort = null;
let portCallId = 0;
const portCallbacks = new Map();

function connectToOffscreen() {
  offscreenPort = chrome.runtime.connect({ name: 'bg-offscreen' });
  offscreenPort.onMessage.addListener(handleOffscreenResponse);
  offscreenPort.onDisconnect.addListener(() => {
    offscreenPort = null;
    console.warn('Offscreen port disconnected');
  });
}

async function handleOffscreenResponse(msg) {
  if (msg.action === 'persisted') {
    // Watermark from offscreen flush
    await ensureWriteBuffer();
    pendingWrites = pendingWrites.filter(e => e.id > msg.watermark);
    chrome.storage.local.set({ writeBuffer: pendingWrites });
    return;
  }
  const cb = portCallbacks.get(msg.id);
  if (cb) {
    portCallbacks.delete(msg.id);
    cb(msg);
  }
}

async function ensureOffscreenPort() {
  if (offscreenPort) return;
  await setupOffscreenDocument();
  connectToOffscreen();
}

async function requestOffscreen(params) {
  await ensureOffscreenPort();
  return new Promise((resolve) => {
    const id = ++portCallId;
    portCallbacks.set(id, resolve);
    offscreenPort.postMessage({ id, ...params });
  });
}

// ─── R-M-W Lock ──────────────────────────────────────────────────────
// Serializes read-modify-write on session cache. Keys like 'settings.json'
// and 'atoms/{slug}.json' match the buffer write paths for clarity but
// these are logical locks, not file locks — files live in offscreen only.

const rwLocks = new Map();

function withLock(key, fn) {
  const prev = rwLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  rwLocks.set(key, next);
  next.catch(() => {}).then(() => {
    if (rwLocks.get(key) === next) rwLocks.delete(key);
  });
  return next;
}

// ─── Mutation Notifications ───────────────────────────────────────────
// Notify extension pages (options, popup) after data mutations so they can refresh.

function notifyMutation(type, detail) {
  chrome.runtime.sendMessage({ action: 'mutation', type, ...detail }).catch(() => {});
}

// ─── Write Buffer ─────────────────────────────────────────────────────
// Ground truth during SW lifetime. Backed up to storage.local for durability.
// Offscreen monitors storage.local['writeBuffer'] via onChanged and drains to filesystem.
// Lazy-restored on first access so idle wake-ups don't lose unflushed entries.

let pendingWrites = null; // null = not yet restored from storage.local
let writeSeq = 0;

async function ensureWriteBuffer() {
  if (pendingWrites !== null) return;
  const { writeBuffer = [] } = await chrome.storage.local.get(['writeBuffer']);
  pendingWrites = writeBuffer;
  writeSeq = pendingWrites.reduce((max, e) => Math.max(max, e.id || 0), writeSeq);
  if (pendingWrites.length > 0) {
    console.log(`Restored ${pendingWrites.length} pending writes from storage.local`);
  }
}

async function bufferWrite(entry) {
  await ensureWriteBuffer();
  entry.id = ++writeSeq;
  // Dedup: for 'json' type, replace existing entry with same path
  if (entry.type === 'json') {
    const idx = pendingWrites.findIndex(e => e.type === 'json' && e.path === entry.path);
    if (idx !== -1) pendingWrites[idx] = entry;
    else pendingWrites.push(entry);
  } else {
    pendingWrites.push(entry);
  }
  await chrome.storage.local.set({ writeBuffer: pendingWrites });
}

// ─── Interaction Queue ────────────────────────────────────────────────
// Interactions are buffered as { type: 'interaction', entry: { interaction, markdown, html } }

async function enqueueInteraction(entry) {
  await ensureWriteBuffer();
  const url = entry.interaction.url;
  const idx = pendingWrites.findIndex(
    e => e.type === 'interaction' && e.entry?.interaction?.url === url
  );
  if (idx !== -1) {
    pendingWrites[idx] = { ...pendingWrites[idx], entry };
  } else {
    pendingWrites.push({ id: ++writeSeq, type: 'interaction', entry });
  }
  chrome.storage.local.set({ writeBuffer: pendingWrites });
}

async function updateQueuedInteraction(url, updates) {
  await ensureWriteBuffer();
  const idx = pendingWrites.findIndex(
    e => e.type === 'interaction' && e.entry?.interaction?.url === url
  );
  if (idx !== -1) {
    const qEntry = pendingWrites[idx].entry;
    Object.assign(qEntry.interaction, updates.interaction || {});
    if (updates.markdown !== undefined) qEntry.markdown = updates.markdown;
    if (updates.html !== undefined) qEntry.html = updates.html;
    chrome.storage.local.set({ writeBuffer: pendingWrites });
  }
}

// ─── Atom LRU Cache (Phase 4) ────────────────────────────────────────

let atomCacheKeys = []; // LRU order, most recent at end
const ATOM_CACHE_LIMIT = 500;

async function getCachedAtom(slug) {
  const key = 'atom:' + slug;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached) {
    // Move to end (most recently used)
    atomCacheKeys = atomCacheKeys.filter(k => k !== slug);
    atomCacheKeys.push(slug);
    return cached;
  }
  return null;
}

async function setCachedAtom(slug, atom) {
  const key = 'atom:' + slug;
  await chrome.storage.session.set({ [key]: atom });
  atomCacheKeys = atomCacheKeys.filter(k => k !== slug);
  atomCacheKeys.push(slug);
  // Evict if over limit
  while (atomCacheKeys.length > ATOM_CACHE_LIMIT) {
    const evict = atomCacheKeys.shift();
    await chrome.storage.session.remove('atom:' + evict);
  }
}

// ─── Settings Keys ───────────────────────────────────────────────────
// Keys from settings.json that are mirrored in session cache.

const SETTINGS_KEYS = ['workspace', 'collections', 'urlBlacklist', 'titleTrimRules', 'recycleBin', 'settings'];

// ─── Cache Hydration ──────────────────────────────────────────────────

async function hydrateCache() {
  try {
    const resp = await requestOffscreen({ action: 'loadSettings' });
    if (resp && resp.success && resp.settings) {
      const s = resp.settings;
      const cacheUpdate = {};
      for (const key of SETTINGS_KEYS) {
        if (s[key] !== undefined) cacheUpdate[key] = s[key];
      }
      if (Object.keys(cacheUpdate).length > 0) {
        await chrome.storage.session.set(cacheUpdate);
        console.log('Cache hydrated from settings.json:', Object.keys(cacheUpdate));
      }
    }
  } catch (error) {
    console.warn('Cache hydration failed:', error.message);
  }

  // Load permanent deletes
  try {
    const pdResp = await requestOffscreen({ action: 'loadPermanentDeletes' });
    if (pdResp?.success) await chrome.storage.session.set({ permanentDeletes: pdResp.urls });
  } catch (error) {
    console.warn('Permanent deletes hydration failed:', error.message);
  }

  // Load and incrementally process gateway domains
  try {
    const gwData = await requestOffscreen({ action: 'loadGateways' });
    let domains = {};
    let watermark = 0;
    if (gwData && gwData.success) {
      domains = gwData.domains || {};
      watermark = gwData.watermark || 0;
    }

    const incremental = await requestOffscreen({
      action: 'processGatewaysIncremental',
      watermark,
      existingDomains: domains
    });

    if (incremental && incremental.success) {
      domains = incremental.domains;
      const newWatermark = incremental.newWatermark;

      await chrome.storage.session.set({ gatewayDomains: domains });

      if (newWatermark > watermark) {
        await bufferWrite({
          type: 'json',
          path: 'lists/gateways.json',
          data: { watermark: newWatermark, domains }
        });
      }

      console.log('Gateway domains loaded incrementally:', Object.keys(domains).length, 'origins');
    }
  } catch (error) {
    console.warn('Gateway hydration failed:', error.message);
  }

  // Load and incrementally process referrer index
  try {
    const riData = await requestOffscreen({ action: 'loadReferrerIndex' });
    let index = {};
    let watermark = 0;
    if (riData && riData.success) {
      index = riData.index || {};
      watermark = riData.watermark || 0;
    }

    const incremental = await requestOffscreen({
      action: 'buildReferrerIndexIncremental',
      watermark,
      existingIndex: index
    });

    if (incremental && incremental.success) {
      index = incremental.index;
      const newWatermark = incremental.newWatermark;

      await chrome.storage.session.set({ referrerIndex: index });

      if (newWatermark > watermark) {
        await bufferWrite({
          type: 'json',
          path: 'lists/referrer-index.json',
          data: { watermark: newWatermark, index }
        });
      }

      console.log('Referrer index loaded incrementally:', Object.keys(index).length, 'parent URLs');
    }
  } catch (error) {
    console.warn('Referrer index hydration failed:', error.message);
  }
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle || 'Untitled';
  const { titleTrimRules = [] } = await chrome.storage.session.get(['titleTrimRules']);
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

// ─── Gateway Domain Registry ──────────────────────────────────────────

async function updateGatewayRegistry(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const isSearchQuery = parsed.searchParams.has('q') || parsed.searchParams.has('query') || parsed.searchParams.has('search');
    const isRoot = parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname === '/index.html' || parsed.pathname === '/index.htm';

    const { gatewayDomains = {} } = await chrome.storage.session.get(['gatewayDomains']);
    if (!gatewayDomains[origin]) {
      gatewayDomains[origin] = { rootUrl: null, childCount: 0, fetched: false };
    }
    const entry = gatewayDomains[origin];

    if (isSearchQuery) {
      entry.childCount++;
      if (isRoot && !entry.rootUrl && !entry.fetched) {
        await chrome.storage.session.set({ gatewayDomains });
        fetchAndCreateGatewayRoot(origin);
        return;
      }
    } else if (isRoot) {
      entry.rootUrl = url;
    } else {
      entry.childCount++;
    }

    await chrome.storage.session.set({ gatewayDomains });

    if (entry.childCount >= 2 && !entry.rootUrl && !entry.fetched) {
      fetchAndCreateGatewayRoot(origin);
    }
  } catch (e) {
    console.warn('Gateway registry update failed:', e.message);
  }
}

async function fetchAndCreateGatewayRoot(origin) {
  const { gatewayDomains = {} } = await chrome.storage.session.get(['gatewayDomains']);
  if (!gatewayDomains[origin]) return;
  gatewayDomains[origin].fetched = true;
  await chrome.storage.session.set({ gatewayDomains });

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
      timestamp: Date.now(),
      url: rootUrl,
      title: title,
      intent: '',
      attention: '',
      slug: slug
    };

    await enqueueInteraction({ interaction, markdown: '', html: '' });

    // Update registry with rootUrl
    const updated = (await chrome.storage.session.get(['gatewayDomains'])).gatewayDomains || {};
    if (updated[origin]) {
      updated[origin].rootUrl = rootUrl;
      await chrome.storage.session.set({ gatewayDomains: updated });
    }

    console.log(`Gateway: created synthetic root for ${origin}`);
  } catch (e) {
    console.warn(`Gateway: failed to fetch root for ${origin}:`, e.message);
  }
}

// ─── Referrer Tracking ───────────────────────────────────────────────

const REFERRER_CAP = 50;

async function updateAtomReferrers(slug, referrer) {
  try {
    await withLock('atoms/' + slug + '.json', async () => {
      let atom = await getCachedAtom(slug);
      if (!atom) {
        const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: [slug] });
        atom = resp?.atoms?.[slug] || {};
      }
      const referrers = atom.referrers || [];
      if (!referrers.includes(referrer)) {
        referrers.push(referrer);
        if (referrers.length > REFERRER_CAP) referrers.shift();
      }
      atom.referrers = referrers;
      await setCachedAtom(slug, atom);
      await bufferWrite({ type: 'json', path: 'atoms/' + slug + '.json', data: atom });
    });
  } catch (e) {
    console.warn('updateAtomReferrers failed:', e.message);
  }
}

async function updateReferrerIndex(referrerUrl, childUrl) {
  try {
    const { referrerIndex = {} } = await chrome.storage.session.get(['referrerIndex']);
    if (!referrerIndex[referrerUrl]) referrerIndex[referrerUrl] = [];
    const children = referrerIndex[referrerUrl];
    if (!children.includes(childUrl)) {
      children.push(childUrl);
      if (children.length > REFERRER_CAP) children.shift();
    }
    await chrome.storage.session.set({ referrerIndex });
  } catch (e) {
    console.warn('updateReferrerIndex failed:', e.message);
  }
}

// ─── Initialization ───────────────────────────────────────────────────

async function startBackground() {
  await setupOffscreenDocument();
  connectToOffscreen();
  await ensureWriteBuffer();
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Portal extension installed');
  await startBackground();
  console.log('Storage initialized');

  const response = await requestOffscreen({ action: 'getDirectoryInfo' });
  if (!response.info) {
    console.log('Filesystem not configured - user needs to select directory');
    chrome.runtime.openOptionsPage();
  } else {
    console.log('Filesystem configured:', response.info.name);
    await hydrateCache();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await startBackground();
  console.log('Extension started');

  try {
    const response = await requestOffscreen({ action: 'getDirectoryInfo' });
    if (response && response.info) {
      await hydrateCache();
    }
  } catch (error) {
    console.warn('Startup hydration failed:', error.message);
  }
});

// ─── Save Page WE Integration ─────────────────────────────────────────

const savepageResolvers = new Map();

async function captureSavePage(tabId) {
  return new Promise((resolve, reject) => {
    savepageResolvers.set(tabId, { resolve, reject });
    console.log('[savepage] injecting scripts into tab', tabId);

    // Inject content-frame.js into all frames, then content.js into main frame
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['savepage/content-frame.js']
    }).then(() => {
      console.log('[savepage] content-frame.js injected, now injecting content.js');
      return chrome.scripting.executeScript({
        target: { tabId },
        files: ['savepage/content.js']
      });
    }).then(() => {
      console.log('[savepage] content.js injected, waiting for scriptLoaded message');
    }).catch(err => {
      console.warn('[savepage] injection error:', err.message);
      savepageResolvers.delete(tabId);
      reject(err);
    });

    // Timeout after 60s
    setTimeout(() => {
      if (savepageResolvers.has(tabId)) {
        savepageResolvers.delete(tabId);
        reject(new Error('Save Page WE capture timed out'));
      }
    }, 60000);
  });
}

// Save Page WE message handlers (use `type` field, distinct from our `action` field)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message.type) return false; // Not a Save Page WE message

  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'scriptLoaded':
      // Reply with performAction to kick off the save
      console.log('[savepage] scriptLoaded received from tab', tabId);
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: 'performAction',
          menuaction: 0,
          saveditems: 1,
          togglelazy: false,
          extractsrcurl: null,
          externalsave: false,
          swapdevices: false,
          multiplesaves: false,
          csprestriction: false
        });
      }
      break;

    case 'setDelay':
      setTimeout(() => { sendResponse({}); }, message.milliseconds);
      return true; // async response

    case 'requestFrames':
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'requestFrames' });
      }
      break;

    case 'replyFrame':
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, {
          type: 'replyFrame',
          key: message.key,
          url: message.url,
          html: message.html,
          fonts: message.fonts
        });
      }
      break;

    case 'loadResource':
      if (tabId != null) {
        loadSavepageResource(tabId, message.index, message.location, message.referrer, message.referrerPolicy);
      }
      break;

    case 'stateChanged':
      // Log progress
      if (debugSavepage) console.log(`[savepage] state: pageType=${message.pagetype} saveState=${message.savestate}`);
      break;

    case 'savepageDone': {
      console.log('[savepage] savepageDone from tab', tabId, 'html length:', message.html?.length);
      const resolver = savepageResolvers.get(tabId);
      if (resolver) {
        savepageResolvers.delete(tabId);
        resolver.resolve(message.html);
      } else {
        console.warn('[savepage] savepageDone but no resolver for tab', tabId);
      }
      break;
    }

    case 'saveExit': {
      console.warn('[savepage] saveExit from tab', tabId);
      const resolver = savepageResolvers.get(tabId);
      if (resolver) {
        savepageResolvers.delete(tabId);
        resolver.reject(new Error('Save Page WE exited without producing HTML'));
      }
      break;
    }

    default:
      return false; // Unknown type — don't hold the channel
  }
});

const debugSavepage = false;

async function loadSavepageResource(tabId, index, location, referrer, referrerPolicy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 10 * 1000); // maxResourceTime

  try {
    const response = await fetch(location, {
      method: 'GET', mode: 'cors', cache: 'no-cache',
      referrer: referrer, referrerPolicy: referrerPolicy,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.status === 200) {
      const contentType = response.headers.get('Content-Type') || '';
      const contentLength = +(response.headers.get('Content-Length') || 0);

      if (contentLength > 50 * 1024 * 1024) { // maxResourceSize
        chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'maxsize*' });
        return;
      }

      const matches = contentType.match(/([^;]+)/i);
      const mimetype = matches ? matches[1].toLowerCase() : '';
      const charsetMatch = contentType.match(/;charset=([^;]+)/i);
      const charset = charsetMatch ? charsetMatch[1].toLowerCase() : '';

      if (mimetype !== 'text/css' && mimetype !== 'image/vnd.microsoft.icon' &&
          !mimetype.startsWith('image/') && !mimetype.startsWith('audio/') && !mimetype.startsWith('video/') &&
          !mimetype.startsWith('font/') && !mimetype.startsWith('application/font') &&
          mimetype !== 'application/octet-stream') {
        chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'blocked*' });
        return;
      }

      const buffer = await response.arrayBuffer();
      const byteArray = new Uint8Array(buffer);
      let binaryString = '';
      for (let i = 0; i < byteArray.byteLength; i++) binaryString += String.fromCharCode(byteArray[i]);

      chrome.tabs.sendMessage(tabId, { type: 'loadSuccess', index, reason: '*', content: binaryString, mimetype, charset });
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'load:' + response.status + '*' });
    }
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'maxtime*' });
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'fetcherr*' });
    }
  }
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  console.log(`[background] Command received: ${command}`);

  const { workspace } = await chrome.storage.session.get(['workspace']);
  if (workspace && workspace.mode === 'private') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    console.log('[background] Command ignored: no suitable tab');
    return;
  }

  if (command === 'capture-snapshot') {
    try {
      const slug = generateSlugFromUrl(tab.url);
      const timestamp = Date.now();
      console.log('[capture] step 1: starting for', tab.url);
      // extractMarkdown first (fast, synchronous) — must complete before
      // captureSavePage injects SPWE scripts, whose listeners interfere
      // with the sendMessage response channel.
      const mdResp = await chrome.tabs.sendMessage(tab.id, { action: 'extractMarkdown' });
      console.log('[capture] step 2: extractMarkdown done, length:', mdResp?.markdown?.length);
      const html = await captureSavePage(tab.id);
      console.log('[capture] step 3: captureSavePage done, length:', html?.length);
      await requestOffscreen({
        action: 'captureSnapshot',
        slug,
        timestamp,
        markdown: mdResp?.markdown || '',
        html: html || ''
      });
      console.log(`[capture] step 4: Snapshot captured for ${tab.url}`);
      notifyMutation('snapshot', { slug });
    } catch (error) {
      console.warn('[capture] ERROR:', error.message, error);
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

// ─── Message Handler (ALL actions) ────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Skip Save Page WE messages (they use `type` field, handled by separate listener)
  if (request.type && !request.action) return false;

  (async () => {
    try {
      switch (request.action) {

        // ── Tab-dependent (background-only) ──

        case 'getPageInfo': {
          const slug = generateSlugFromUrl(request.url);
          const [detailResp, snapshotsResp] = await Promise.all([
            requestOffscreen({ action: 'loadPageDetail', slug, url: request.url }),
            requestOffscreen({ action: 'listSnapshots', slug })
          ]);
          // Cache the atom if loadPageDetail returned one
          if (detailResp?.atom) {
            await setCachedAtom(slug, detailResp.atom);
          }
          sendResponse({
            success: true,
            slug,
            interaction: detailResp?.interaction || null,
            snapshots: snapshotsResp?.snapshots || [],
            highlights: detailResp?.atom?.highlights || []
          });
          break;
        }

        case 'captureCurrentPageFromPopup': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { sendResponse({ success: false, error: 'No active tab' }); return; }

            console.log('[capture-popup] step 1: starting for', tab.url);
            const slug = generateSlugFromUrl(tab.url);
            const timestamp = Date.now();
            const mdResp = await chrome.tabs.sendMessage(tab.id, { action: 'extractMarkdown' });
            console.log('[capture-popup] step 2: extractMarkdown done, length:', mdResp?.markdown?.length);
            const html = await captureSavePage(tab.id);
            console.log('[capture-popup] step 3: captureSavePage done, length:', html?.length);
            await requestOffscreen({
              action: 'captureSnapshot',
              slug,
              timestamp,
              markdown: mdResp?.markdown || '',
              html: html || ''
            });
            console.log('[capture-popup] step 4: snapshot written');
            notifyMutation('snapshot', { slug });
            sendResponse({ success: true, timestamp });
          } catch (error) {
            console.warn('[capture-popup] ERROR:', error.message, error);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'hydrateCache': {
          await setupOffscreenDocument();
          connectToOffscreen();
          await hydrateCache();
          sendResponse({ success: true });
          break;
        }

        case 'reportPageVisit': {
          try {
            const url = request.url;

            const { workspace } = await chrome.storage.session.get(['workspace']);
            if (workspace && workspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const { urlBlacklist } = await chrome.storage.session.get(['urlBlacklist']);
            const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
            if (blacklist.some(prefix => url.startsWith(prefix))) {
              const existing = await requestOffscreen({ action: 'loadInteractionByUrl', url });
              if (!existing || !existing.interaction) {
                console.log(`Skipping blacklisted URL (not in database): ${url}`);
                sendResponse({ success: true });
                return;
              }
              console.log(`Blacklisted URL but already in database, continuing: ${url}`);
            }

            const timestamp = Date.now();
            const title = await trimTitle(request.title, url);
            const slug = request.slug;

            const interaction = {
              timestamp,
              url,
              title,
              intent: request.intent || '',
              attention: typeof request.attention === 'string' ? request.attention : (request.attention ? JSON.stringify(request.attention) : ''),
              slug
            };
            if (request.referrer) interaction.referrer = request.referrer;

            await enqueueInteraction({ interaction, markdown: '', html: '' });

            // Update atom referrers (non-blocking)
            if (request.referrer) {
              updateAtomReferrers(slug, request.referrer);
              updateReferrerIndex(request.referrer, url);
            }

            // Update gateway domain registry (non-blocking)
            updateGatewayRegistry(url);

            // Workspace mode: auto-pin and optionally snapshot
            const wsCollectionIds = workspace?.collectionIds || [];
            if (workspace && workspace.mode === 'workspace' && wsCollectionIds.length > 0) {
              try {
                const pinsResp = await requestOffscreen({ action: 'loadCollectionPins' });
                const allPins = (pinsResp && pinsResp.pins) ? pinsResp.pins : {};
                let changed = false;

                for (const collectionId of wsCollectionIds) {
                  if (!allPins[collectionId]) allPins[collectionId] = [];
                  const already = allPins[collectionId].some(p => p.url === url);
                  if (!already) {
                    allPins[collectionId].push({ url, title: request.title || 'Untitled', pinnedAt: timestamp });
                    changed = true;
                  }
                }

                if (changed) {
                  await requestOffscreen({ action: 'saveCollectionPins', pins: allPins });
                  console.log(`Workspace: auto-pinned ${url} to collections ${wsCollectionIds.join(', ')}`);
                }

                if (workspace.autoSnapshot && sender.tab) {
                  console.log('[auto-snapshot] starting for', url);
                  chrome.tabs.sendMessage(sender.tab.id, { action: 'extractMarkdown' }).then(async (mdResp) => {
                    console.log('[auto-snapshot] extractMarkdown done, length:', mdResp?.markdown?.length);
                    const html = await captureSavePage(sender.tab.id);
                    console.log('[auto-snapshot] captureSavePage done, length:', html?.length);
                    await requestOffscreen({
                      action: 'captureSnapshot',
                      slug,
                      timestamp,
                      markdown: mdResp?.markdown || '',
                      html: html || ''
                    });
                    console.log(`[auto-snapshot] captured for ${url}`);
                    notifyMutation('snapshot', { slug });
                  }).catch(err => {
                    console.warn('[auto-snapshot] ERROR:', err.message, err);
                  });
                }
              } catch (err) {
                console.warn('Workspace: auto-pin/snapshot error:', err.message);
              }
            }

            console.log(`Processed page visit: ${url}`);
            sendResponse({ success: true });
            notifyMutation('interaction', { url });
          } catch (error) {
            console.error('Error processing reportPageVisit:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // ── Queue Operations ──

        case 'enqueueInteraction': {
          await enqueueInteraction(request.entry);
          sendResponse({ success: true });
          notifyMutation('interaction', { url: request.entry?.interaction?.url });
          break;
        }

        case 'updateInteraction': {
          const updates = { interaction: {} };
          if (request.intent) updates.interaction.intent = request.intent;
          if (request.attention) updates.interaction.attention = JSON.stringify(request.attention);
          if (request.markdown) updates.markdown = request.markdown;
          if (request.html) updates.html = request.html;
          await updateQueuedInteraction(request.interactionId, updates);
          sendResponse({ success: true });
          break;
        }

        case 'clearWriteQueue': {
          pendingWrites = [];
          await chrome.storage.local.set({ writeBuffer: pendingWrites });
          sendResponse({ success: true });
          break;
        }

        // ── Pure Reads (relay to offscreen, cache atoms) ──

        case 'loadSettings': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadSettings' });
          console.debug(`[I/O] loadSettings: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadHighlights': {
          const t0 = performance.now();
          // Check atom cache
          const cachedAtom = await getCachedAtom(request.slug);
          if (cachedAtom) {
            console.debug(`[I/O] loadHighlights(${request.slug}): cache hit`);
            sendResponse({ success: true, highlights: cachedAtom.highlights || [] });
            break;
          }
          const resp = await requestOffscreen({ action: 'loadHighlights', slug: request.slug });
          console.debug(`[I/O] loadHighlights(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadAllHighlights': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadAllHighlights' });
          console.debug(`[I/O] loadAllHighlights: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadInteractionByUrl': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadInteractionByUrl', url: request.url });
          console.debug(`[I/O] loadInteractionByUrl: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadAtomBatch': {
          const t0 = performance.now();
          const result = {};
          const uncachedSlugs = [];

          // Check atom cache for each slug
          for (const slug of request.slugs) {
            const cached = await getCachedAtom(slug);
            if (cached) {
              result[slug] = cached;
            } else {
              uncachedSlugs.push(slug);
            }
          }

          // Fetch uncached from offscreen
          if (uncachedSlugs.length > 0) {
            const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: uncachedSlugs });
            if (resp?.success && resp.atoms) {
              for (const [slug, atom] of Object.entries(resp.atoms)) {
                result[slug] = atom;
                await setCachedAtom(slug, atom);
              }
            }
          }

          console.debug(`[I/O] loadAtomBatch: ${request.slugs.length} slugs (${request.slugs.length - uncachedSlugs.length} cached) in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, atoms: result });
          break;
        }

        case 'loadPageDetail': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadPageDetail', slug: request.slug, url: request.url });
          if (resp?.atom) {
            await setCachedAtom(request.slug, resp.atom);
          }
          console.debug(`[I/O] loadPageDetail(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadCollectionPins': {
          const t0 = performance.now();
          if (request.collectionId) {
            const resp = await requestOffscreen({ action: 'loadCollectionPins', collectionId: request.collectionId });
            console.debug(`[I/O] loadCollectionPins(${request.collectionId}): ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse(resp);
          } else {
            const resp = await requestOffscreen({ action: 'loadCollectionPins' });
            console.debug(`[I/O] loadCollectionPins: ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse(resp);
          }
          break;
        }

        case 'listSnapshots': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'listSnapshots', slug: request.slug });
          console.debug(`[I/O] listSnapshots(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'getDirectoryInfo': {
          const resp = await requestOffscreen({ action: 'getDirectoryInfo' });
          sendResponse(resp);
          break;
        }

        case 'listInteractionFiles': {
          const resp = await requestOffscreen({ action: 'listInteractionFiles' });
          sendResponse(resp);
          break;
        }

        case 'loadInteractionBatch': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadInteractionBatch', files: request.files });
          console.debug(`[I/O] loadInteractionBatch: ${request.files.length} files in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        // ── Page Relations ──

        case 'getPageRelations': {
          try {
            const url = request.url;
            const slug = generateSlugFromUrl(url);

            // Parents: referrers from atom
            let atom = await getCachedAtom(slug);
            if (!atom) {
              const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: [slug] });
              atom = resp?.atoms?.[slug] || {};
            }
            const parentReferrers = atom.referrers || [];

            // Parents: collections containing this URL
            const parentCollections = [];
            const { collections: colSettings } = await chrome.storage.session.get(['collections']);
            const allCols = colSettings || [];
            // Check pinned membership
            for (const col of allCols) {
              const colCacheKey = 'colCache:' + col.id;
              const cached = (await chrome.storage.session.get(colCacheKey))[colCacheKey];
              if (cached) {
                const inPinned = cached.fullPinned?.some(p => p.url === url);
                const inRelated = cached.related?.some(r => r.url === url);
                if (inPinned) parentCollections.push({ id: col.id, name: col.name || col.query, type: 'pin' });
                else if (inRelated) parentCollections.push({ id: col.id, name: col.name || col.query, type: 'appear' });
              }
            }

            // Children: from referrer index
            const { referrerIndex = {} } = await chrome.storage.session.get(['referrerIndex']);
            const children = referrerIndex[url] || [];

            sendResponse({
              success: true,
              parents: { referrers: parentReferrers, collections: parentCollections },
              children
            });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // ── Writes (session cache + bufferWrite) ──

        case 'saveSettings': {
          const s = request.settings;
          const cacheUpdate = {};
          for (const key of SETTINGS_KEYS) {
            if (s[key] !== undefined) cacheUpdate[key] = s[key];
          }
          if (Object.keys(cacheUpdate).length > 0) {
            await chrome.storage.session.set(cacheUpdate);
          }
          await bufferWrite({ type: 'json', path: 'settings.json', data: s });
          sendResponse({ success: true });
          notifyMutation('settings');
          break;
        }

        case 'saveSettingsKey': {
          await withLock('settings.json', async () => {
            const sessionData = await chrome.storage.session.get(SETTINGS_KEYS);
            const current = {};
            for (const key of SETTINGS_KEYS) {
              if (sessionData[key] !== undefined) current[key] = sessionData[key];
            }

            // If session is empty (cold start), read from offscreen
            if (Object.keys(current).length === 0) {
              const resp = await requestOffscreen({ action: 'loadSettings' });
              if (resp?.success && resp.settings) {
                Object.assign(current, resp.settings);
              }
            }

            current[request.key] = request.value;

            await chrome.storage.session.set({ [request.key]: request.value });
            await bufferWrite({ type: 'json', path: 'settings.json', data: current });
          });
          sendResponse({ success: true });
          notifyMutation('settings', { key: request.key });
          break;
        }

        case 'saveHighlight': {
          const hlSlug = request.slug;
          const highlights = await withLock('atoms/' + hlSlug + '.json', async () => {
            // Read atom from cache or offscreen
            let atom = await getCachedAtom(hlSlug);
            if (!atom) {
              const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: [hlSlug] });
              atom = resp?.atoms?.[hlSlug] || {};
            }
            const hl = atom.highlights || [];
            if (request.highlight.isGlobalNote) {
              const idx = hl.findIndex(h => h.isGlobalNote);
              if (idx >= 0) hl[idx] = request.highlight;
              else hl.unshift(request.highlight);
            } else {
              hl.push(request.highlight);
            }
            atom.highlights = hl;
            await setCachedAtom(hlSlug, atom);
            await bufferWrite({ type: 'json', path: 'atoms/' + hlSlug + '.json', data: atom });
            return hl;
          });
          sendResponse({ success: true, highlights });
          notifyMutation('highlight', { slug: hlSlug });
          break;
        }

        case 'deleteHighlight': {
          const dhSlug = request.slug;
          const remaining = await withLock('atoms/' + dhSlug + '.json', async () => {
            let atom = await getCachedAtom(dhSlug);
            if (!atom) {
              const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: [dhSlug] });
              atom = resp?.atoms?.[dhSlug] || {};
            }
            let hl = atom.highlights || [];
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
            atom.highlights = hl;
            await setCachedAtom(dhSlug, atom);
            await bufferWrite({ type: 'json', path: 'atoms/' + dhSlug + '.json', data: atom });
            return hl;
          });
          sendResponse({ success: true, highlights: remaining });
          notifyMutation('highlight', { slug: dhSlug });
          break;
        }

        case 'saveHighlights': {
          const shSlug = request.slug;
          await withLock('atoms/' + shSlug + '.json', async () => {
            let atom = await getCachedAtom(shSlug);
            if (!atom) {
              const resp = await requestOffscreen({ action: 'loadAtomBatch', slugs: [shSlug] });
              atom = resp?.atoms?.[shSlug] || {};
            }
            atom.highlights = request.highlights;
            await setCachedAtom(shSlug, atom);
            await bufferWrite({ type: 'json', path: 'atoms/' + shSlug + '.json', data: atom });
          });
          sendResponse({ success: true });
          notifyMutation('highlight', { slug: shSlug });
          break;
        }

        case 'saveCollectionPins': {
          await requestOffscreen({ action: 'saveCollectionPins', pins: request.pins });
          sendResponse({ success: true });
          notifyMutation('pins');
          break;
        }

        case 'saveCollectionPinsById': {
          await bufferWrite({
            type: 'json',
            path: 'lists/user/' + request.collectionId + '.json',
            data: request.pins
          });
          sendResponse({ success: true });
          notifyMutation('pins', { collectionId: request.collectionId });
          break;
        }

        case 'savePermanentDeletes': {
          await chrome.storage.session.set({ permanentDeletes: request.urls });
          await bufferWrite({
            type: 'json',
            path: 'lists/permanent-deletes.json',
            data: request.urls
          });
          sendResponse({ success: true });
          notifyMutation('permanentDeletes');
          break;
        }

        // ── Pass-through (complex FS ops) ──

        case 'initializeFilesystem': {
          const resp = await requestOffscreen({ action: 'initializeFilesystem' });
          sendResponse(resp);
          break;
        }

        case 'captureSnapshot': {
          await requestOffscreen({
            action: 'captureSnapshot',
            slug: request.slug,
            timestamp: request.timestamp,
            markdown: request.markdown || '',
            html: request.html || ''
          });
          sendResponse({ success: true });
          notifyMutation('snapshot', { slug: request.slug });
          break;
        }

        case 'deleteSnapshot': {
          const resp = await requestOffscreen({
            action: 'deleteSnapshot',
            slug: request.slug,
            timestamp: request.timestamp
          });
          sendResponse(resp);
          notifyMutation('snapshot', { slug: request.slug });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${request.action}` });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});
