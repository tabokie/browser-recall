// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl, generateNoteSlug } from './utils.js';
import { effectOf } from './replay.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { getCachedEntity, setCachedEntity, setEntityCacheWatermark } from './entity-cache.js';

console.log('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — data is safe in chrome.storage.local until drained

// Session storage: in-memory IPC, survives SW termination, cleared on browser restart.
// hydrateCache() re-populates from filesystem on every startup.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Resolves when hydrateCache() completes (or immediately if no hydration needed).
let hydrationDone = Promise.resolve();

function dateKeyFromTimestamp(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

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
  // Kick drain for any entries buffered while offscreen was down
  scheduleDrainNotify();
}

async function handleOffscreenResponse(msg) {
  if (msg.action === 'persisted') {
    // Watermark from offscreen flush — prune entries at or before watermark timestamp
    await ensureLogBuffer();
    logBuffer = logBuffer.filter(e => e.timestamp > msg.watermark);
    chrome.storage.local.set({ logBuffer });
    setEntityCacheWatermark(msg.watermark);
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
// and 'pages/{slug}.json' match the buffer write paths for clarity but
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

// ─── Page Cache Helper ───────────────────────────────────────────────
// Ensure a page is in session cache; loads from offscreen if missing.
// Returns the page (or empty object if not found anywhere).

async function ensurePageCached(slug) {
  const key = 'page:' + slug;
  let page = await getCachedEntity(key);
  if (!page) {
    const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
    page = resp?.pages?.[slug] || {};
    await setCachedEntity(key, page);
  }
  return page;
}

// ─── Mutation Notifications ───────────────────────────────────────────
// Notify extension pages (options, popup) after data mutations so they can refresh.

function notifyMutation(type, detail) {
  chrome.runtime.sendMessage({ action: 'mutation', type, ...detail }).catch(() => {});
}

// ─── Log Buffer ──────────────────────────────────────────────────────
// Event-sourced log entries. Ground truth during SW lifetime.
// Backed up to storage.local['logBuffer'] for durability.
// Background notifies offscreen via port ('drainEntries') to drain entries
// to history/YYYY-MM-DD.jsonl and checkpoint entity files.
// Lazy-restored on first access so idle wake-ups don't lose unflushed entries.

let logBuffer = null; // null = not yet restored from storage.local

async function ensureLogBuffer() {
  if (logBuffer !== null) return;
  const { logBuffer: stored = [] } = await chrome.storage.local.get(['logBuffer']);
  logBuffer = stored;
  if (logBuffer.length > 0) {
    console.log(`Restored ${logBuffer.length} pending log entries from storage.local`);
  }
}

// ─── Drain Notify (background → offscreen via port) ─────────────────
// Offscreen documents don't receive chrome.storage.onChanged events
// (only chrome.runtime is available). Send entries via port instead.
let drainNotifyTimer = null;

function scheduleDrainNotify() {
  if (drainNotifyTimer) return;
  drainNotifyTimer = setTimeout(drainNow, DRAIN_INTERVAL_MS);
}

async function drainNow() {
  if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
  if (!offscreenPort) return; // Port not ready; connectToOffscreen will retry
  try {
    await ensureLogBuffer();
    if (logBuffer.length > 0) {
      offscreenPort.postMessage({ action: 'drainEntries', entries: logBuffer });
    }
  } catch (e) {
    console.warn('drainNotify error:', e.message);
  }
}

// Low-level: append to logBuffer + persist, no cache update.
async function appendLog(entry) {
  await withLock('logBuffer', async () => {
    await ensureLogBuffer();
    logBuffer.push(entry);
    await chrome.storage.local.set({ logBuffer });
  });
  ensureOffscreenPort().catch(() => {});
  scheduleDrainNotify();
}

// Read an entity from session cache by replay key.
// Returns entity or null (null = not cached / doesn't exist).
async function sessionLoad(key) {
  if (key.startsWith('page:') || key.startsWith('note:')) {
    return await getCachedEntity(key);
  }
  if (key === 'settings') {
    const data = await chrome.storage.session.get(SETTINGS_KEYS);
    // Assemble entity from individual session keys
    return { timestamp: 0, ...data };
  }
  if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
    const listId = key.slice('list:'.length);
    const { lists = [] } = await chrome.storage.session.get(['lists']);
    const list = lists.find(c => c.slug === listId);
    if (list) return { timestamp: 0, slug: listId, name: list.name || '', qbTrees: list.qbTrees || [], pins: list.pins || [] };
    return null;
  }
  if (key === 'list:system/recycle-bin') {
    const { recycleBin } = await chrome.storage.session.get(['recycleBin']);
    return recycleBin ? { timestamp: 0, items: recycleBin } : null;
  }
  if (key === 'list:system/permanent-deletes') {
    const { permanentDeletes } = await chrome.storage.session.get(['permanentDeletes']);
    return permanentDeletes ? { timestamp: 0, keys: permanentDeletes } : null;
  }
  if (key === 'list:index/parent') {
    const { parentIndex } = await chrome.storage.session.get(['parentIndex']);
    return parentIndex || null;
  }
  return null;
}

// Write effectOf results back to session cache.
async function sessionWrite(effects) {
  for (const [key, entity] of Object.entries(effects)) {
    if (entity === null) continue;
    if (key.startsWith('page:') || key.startsWith('note:')) {
      await setCachedEntity(key, entity);
    } else if (key === 'settings') {
      const cacheUpdate = {};
      for (const k of SETTINGS_KEYS) {
        if (entity[k] !== undefined) cacheUpdate[k] = entity[k];
      }
      if (Object.keys(cacheUpdate).length > 0) {
        await chrome.storage.session.set(cacheUpdate);
      }
    } else if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
      const { lists = [] } = await chrome.storage.session.get(['lists']);
      const listId = key.slice('list:'.length);
      if (entity.deleted) {
        await chrome.storage.session.set({ lists: lists.filter(c => c.slug !== listId) });
      } else {
        const idx = lists.findIndex(c => c.slug === listId);
        const meta = { slug: entity.slug, name: entity.name, qbTrees: entity.qbTrees, pins: entity.pins || [] };
        if (idx >= 0) lists[idx] = meta;
        else lists.push(meta);
        await chrome.storage.session.set({ lists });
      }
    } else if (key === 'list:system/recycle-bin') {
      await chrome.storage.session.set({ recycleBin: entity.items });
    } else if (key === 'list:system/permanent-deletes') {
      await chrome.storage.session.set({ permanentDeletes: entity.keys });
    } else if (key === 'list:index/parent') {
      await chrome.storage.session.set({ parentIndex: entity });
    }
  }
}

// High-level: append to logBuffer + replay against session cache via effectOf.
// Returns effectOf result { key: entity | null }.
// Serialized via logBuffer lock so concurrent calls see each other's cache writes.
async function addLog(entry) {
  let effects;
  await withLock('logBuffer', async () => {
    await ensureLogBuffer();
    logBuffer.push(entry);
    await chrome.storage.local.set({ logBuffer });
    effects = await effectOf(entry, sessionLoad);
    await sessionWrite(effects);
  });
  ensureOffscreenPort().catch(() => {});
  scheduleDrainNotify();
  return effects;
}

async function appendVisit(interaction) {
  const entry = {
    timestamp: interaction.timestamp,
    action: 'page',
    url: interaction.url,
    title: interaction.title,
  };
  if (interaction.referrer) entry.referrer = interaction.referrer;
  await addLog(entry);
}

// ─── Settings Keys ───────────────────────────────────────────────────
// Keys from settings.json that are mirrored in session cache.

const SETTINGS_KEYS = ['workspace', 'listOrder', 'urlBlacklist', 'titleTrimRules', 'settings'];

// ─── Session → Filesystem Fallback ───────────────────────────────────
// readCacheable(key): await hydration, then session cache → readFs fallback.
// readFs(key): load from filesystem via offscreen, cache into session.

async function readCacheable(key) {
  await hydrationDone;
  const cached = await chrome.storage.session.get([key]);
  if (key in cached) return cached[key];
  return readFs(key);
}

async function readFs(key) {
  if (SETTINGS_KEYS.includes(key)) {
    // Batch-load all settings keys from settings.json
    const resp = await requestOffscreen({ action: 'loadSettings' });
    const settings = resp?.settings || {};
    const toCache = {};
    for (const k of SETTINGS_KEYS) {
      if (settings[k] !== undefined) toCache[k] = settings[k];
    }
    if (Object.keys(toCache).length > 0) await chrome.storage.session.set(toCache);
    return settings[key];
  }
  let value;
  switch (key) {
    case 'lists': {
      const metaResp = await requestOffscreen({ action: 'loadAllListMetadata' });
      let allLists = metaResp?.lists || [];
      const listOrder = (await readCacheable('listOrder')) || [];
      if (listOrder.length > 0) {
        const ordered = [];
        for (const key of listOrder) {
          const slug = key.startsWith('list:') ? key.slice(5) : key;
          const c = allLists.find(x => x.slug === slug);
          if (c) ordered.push(c);
        }
        for (const c of allLists) { if (!listOrder.includes('list:' + c.slug)) ordered.push(c); }
        allLists = ordered;
      }
      value = allLists; break;
    }
    case 'recycleBin': {
      const r = await requestOffscreen({ action: 'loadRecycleBin' });
      value = r?.items || []; break;
    }
    case 'permanentDeletes': {
      const r = await requestOffscreen({ action: 'loadPermanentDeletes' });
      value = r?.keys || []; break;
    }
    case 'parentIndex': {
      const r = await requestOffscreen({ action: 'loadParentIndex' });
      value = r?.success ? { timestamp: r.timestamp || 0, index: r.index || {} } : { timestamp: 0, index: {} }; break;
    }
    case 'gatewayDomains': {
      const r = await requestOffscreen({ action: 'loadGateways' });
      value = r?.domains || {}; break;
    }
    default: return undefined;
  }
  await chrome.storage.session.set({ [key]: value });
  return value;
}

// ─── Cache Hydration ──────────────────────────────────────────────────

async function hydrateCache() {
  // Phase 1: Load base entities from offscreen into session cache
  try {
    const resp = await requestOffscreen({ action: 'loadSettings' });
    if (resp?.success && resp.settings) {
      const cacheUpdate = {};
      for (const key of SETTINGS_KEYS) {
        if (resp.settings[key] !== undefined) cacheUpdate[key] = resp.settings[key];
      }
      if (Object.keys(cacheUpdate).length > 0) {
        await chrome.storage.session.set(cacheUpdate);
      }
    }
  } catch (e) { console.warn('Settings load failed:', e.message); }

  try {
    const metaResp = await requestOffscreen({ action: 'loadAllListMetadata' });
    if (metaResp?.success && metaResp.lists) {
      await chrome.storage.session.set({ lists: metaResp.lists });
    }
  } catch (e) { console.warn('List metadata load failed:', e.message); }

  try {
    const rbResp = await requestOffscreen({ action: 'loadRecycleBin' });
    if (rbResp?.success) await chrome.storage.session.set({ recycleBin: rbResp.items || [] });
  } catch (e) { console.warn('Recycle bin load failed:', e.message); }

  try {
    const pdResp = await requestOffscreen({ action: 'loadPermanentDeletes' });
    if (pdResp?.success) await chrome.storage.session.set({ permanentDeletes: pdResp.keys || [] });
  } catch (e) { console.warn('Permanent deletes load failed:', e.message); }

  try {
    const piResp = await requestOffscreen({ action: 'loadParentIndex' });
    const parentIndex = piResp?.success
      ? { timestamp: piResp.timestamp || 0, index: piResp.index || {} }
      : { timestamp: 0, index: {} };
    await chrome.storage.session.set({ parentIndex });
  } catch (e) { console.warn('Parent-index load failed:', e.message); }

  // Phase 2: Replay pending logBuffer entries via effectOf
  await ensureLogBuffer();
  for (const entry of logBuffer) {
    try {
      const effects = await effectOf(entry, sessionLoad);
      await sessionWrite(effects);
    } catch (e) { console.warn('Hydration replay failed for entry:', e.message); }
  }

  // Phase 3: Order lists by listOrder
  const { lists = [], listOrder = [] } = await chrome.storage.session.get(['lists', 'listOrder']);
  const ordered = [];
  for (const key of listOrder) {
    const slug = key.startsWith('list:') ? key.slice(5) : key;
    const col = lists.find(c => c.slug === slug);
    if (col) ordered.push(col);
  }
  for (const col of lists) {
    if (!listOrder.includes('list:' + col.slug)) ordered.push(col);
  }
  await chrome.storage.session.set({ lists: ordered });

  // Phase 4: Gateways (incremental processing — separate from replay)
  await hydrateIncrementalIndex({
    loadAction: 'loadGateways', processAction: 'processGatewaysIncremental',
    sessionKey: 'gatewayDomains', savePath: 'lists/system/gateways.json', dataKey: 'domains',
    existingKey: 'existingDomains', label: 'Gateway domains'
  });

  console.log('Cache hydrated');
}

async function hydrateIncrementalIndex({ loadAction, processAction, sessionKey, savePath, dataKey, existingKey, label }) {
  try {
    const loaded = await requestOffscreen({ action: loadAction });
    let data = {};
    let watermark = 0;
    if (loaded?.success) {
      data = loaded[dataKey] || {};
      watermark = loaded.watermark || 0;
    }

    const incremental = await requestOffscreen({
      action: processAction, watermark, [existingKey]: data
    });

    if (incremental?.success) {
      data = incremental[dataKey];
      const newWatermark = incremental.newWatermark;
      await chrome.storage.session.set({ [sessionKey]: data });
      if (newWatermark > watermark) {
        await requestOffscreen({
          action: 'saveJson', path: savePath,
          data: { watermark: newWatermark, [dataKey]: data }
        });
      }
      console.log(`${label} loaded incrementally:`, Object.keys(data).length, 'entries');
    }
  } catch (error) {
    console.warn(`${label} hydration failed:`, error.message);
  }
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle || 'Untitled';
  const titleTrimRules = (await readCacheable('titleTrimRules')) || [];
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

// ─── Page Report Processing ──────────────────────────────────────────

/**
 * Process a page report delta against cached state.
 * Trims title, compares each field, returns only diffs.
 *
 * @param {Object} delta - { url, title?, slug?, referrer?, scrollDepth?, timeOnPage?, isInitialLoad?, isLeaving? }
 * @returns {{ entry: Object|null }}
 */
async function processPageReport(delta) {
  const url = delta.url;
  const slug = delta.slug || generateSlugFromUrl(url);
  const cached = await getCachedEntity('page:' + slug);

  const entry = {
    timestamp: Date.now(),
    action: 'page',
    url,
  };
  let hasChange = false;

  // Title: trim then compare
  if (delta.title != null) {
    const trimmed = await trimTitle(delta.title, url);
    if (!cached || cached.title !== trimmed) {
      entry.title = trimmed;
      hasChange = true;
    }
  }

  // Referrer: include if absent or changed
  if (delta.referrer != null) {
    if (!cached || cached.referrer !== delta.referrer) {
      entry.referrer = delta.referrer;
      hasChange = true;
    }
  }

  // scrollDepth: include if higher than cached
  if (delta.scrollDepth != null) {
    if (!cached || (cached.scrollDepth ?? -1) < delta.scrollDepth) {
      entry.scrollDepth = delta.scrollDepth;
      hasChange = true;
    }
  }

  // timeOnPage: always include when > 0 (incremental delta)
  if (delta.timeOnPage != null && delta.timeOnPage > 0) {
    entry.timeOnPage = delta.timeOnPage;
    hasChange = true;
  }

  // user_title: independent from auto-detected title
  if (delta.user_title != null) {
    if (!cached || cached.user_title !== delta.user_title) {
      entry.user_title = delta.user_title;
      hasChange = true;
    }
  }

  return { entry: hasChange ? entry : null };
}

// ─── Gateway Domain Registry ──────────────────────────────────────────

async function updateGatewayRegistry(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const isSearchQuery = parsed.searchParams.has('q') || parsed.searchParams.has('query') || parsed.searchParams.has('search');
    const isRoot = parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname === '/index.html' || parsed.pathname === '/index.htm';

    const gatewayDomains = (await readCacheable('gatewayDomains')) || {};
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
  const gatewayDomains = (await readCacheable('gatewayDomains')) || {};
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

    await appendVisit(interaction);

    // Update registry with rootUrl
    const updated = (await readCacheable('gatewayDomains')) || {};
    if (updated[origin]) {
      updated[origin].rootUrl = rootUrl;
      await chrome.storage.session.set({ gatewayDomains: updated });
    }

    console.log(`Gateway: created synthetic root for ${origin}`);
  } catch (e) {
    console.warn(`Gateway: failed to fetch root for ${origin}:`, e.message);
  }
}

// ─── Supplementary referrer detection ─────────────────────────────────
// Sites that suppress document.referrer via Referrer-Policy or rel="noreferrer"
// leave an empty string in content script. webNavigation sees the real navigation.
const getReferrer = (() => {
  const tabUrls = new Map();
  const tabReferrers = new Map();

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const previousUrl = tabUrls.get(details.tabId);
    if (details.transitionType === 'link' && previousUrl) {
      tabReferrers.set(details.tabId, previousUrl);
    }
    tabUrls.set(details.tabId, details.url);
  });

  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const sourceUrl = tabUrls.get(details.sourceTabId);
    if (sourceUrl) tabReferrers.set(details.tabId, sourceUrl);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId);
    tabReferrers.delete(tabId);
  });

  return (tabId) => {
    const ref = tabReferrers.get(tabId);
    tabReferrers.delete(tabId);
    return ref;
  };
})();

// ─── Initialization ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('Portal extension installed');
  await ensureOffscreenPort();
  await ensureLogBuffer();
  console.log('Storage initialized');

  const response = await requestOffscreen({ action: 'getDirectoryInfo' });
  if (!response.info) {
    console.log('Filesystem not configured - user needs to select directory');
    chrome.runtime.openOptionsPage();
  } else {
    console.log('Filesystem configured:', response.info.name);
    hydrationDone = hydrateCache();
    await hydrationDone;
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenPort();
  await ensureLogBuffer();
  console.log('Extension started');

  try {
    const response = await requestOffscreen({ action: 'getDirectoryInfo' });
    if (response && response.info) {
      hydrationDone = hydrateCache();
      await hydrationDone;
    }
  } catch (error) {
    console.warn('Startup hydration failed:', error.message);
  }
});

// ─── Save Page WE Integration ─────────────────────────────────────────
initSavepageBridge();

// ─── Checkpoint Helper ────────────────────────────────────────────────
// Ensure a page checkpoint exists in cache or disk; creates one if missing.

async function ensureCheckpointIfMissing(checkSlug, checkUrl, checkTitle) {
  const key = 'page:' + checkSlug;
  const cached = await getCachedEntity(key);
  if (!cached) {
    const existsResp = await requestOffscreen({ action: 'pageExists', slug: checkSlug });
    if (!existsResp?.exists) {
      await addLog({
        timestamp: Date.now(),
        action: 'page_checkpoint',
        url: checkUrl,
        title: checkTitle
      });
    }
  }
}

// ─── Snapshot Capture ─────────────────────────────────────────────────

async function captureAndLog(tabId, slug, timestamp, url, title) {
  // Ensure page exists before capture
  if (url) await ensureCheckpointIfMissing(slug, url, title || '');
  const mdResp = await chrome.tabs.sendMessage(tabId, { action: 'extractMarkdown' });
  const html = await captureSavePage(tabId);
  await requestOffscreen({
    action: 'captureSnapshot', slug, timestamp,
    markdown: mdResp?.markdown || '', html: html || ''
  });
  await addLog({
    timestamp, action: 'page', url,
    mdPath: `pages/${slug}/${timestamp}.md`,
    htmlPath: `pages/${slug}/${timestamp}.html`
  });
  notifyMutation('snapshot', { slug });
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  console.log(`[background] Command received: ${command}`);

  const workspace = await readCacheable('workspace');
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
      await captureAndLog(tab.id, slug, timestamp, tab.url, tab.title);
      chrome.tabs.sendMessage(tab.id, { action: 'showCaptureNotification' }).catch(() => {});
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
  } else if (command === 'like-page') {
    try {
      const slug = generateSlugFromUrl(tab.url);
      await ensureCheckpointIfMissing(slug, tab.url, tab.title || '');
      await addLog({ timestamp: Date.now(), action: 'page', url: tab.url, likes: 1 });
      notifyMutation('interaction', { url: tab.url });
      chrome.tabs.sendMessage(tab.id, { action: 'showLikeNotification' }).catch(() => {});
    } catch (error) {
      console.warn('[like-page] ERROR:', error.message, error);
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
          const [detailResp, snapshotsResp, notesResp] = await Promise.all([
            requestOffscreen({ action: 'loadPageDetail', slug, url: request.url }),
            requestOffscreen({ action: 'listSnapshots', slug }),
            requestOffscreen({ action: 'loadPageNotes', slug })
          ]);
          // Cache the page if loadPageDetail returned one
          if (detailResp?.page) {
            await setCachedEntity('page:' + slug, detailResp.page);
          }
          sendResponse({
            success: true,
            slug,
            interaction: detailResp?.interaction || null,
            snapshots: snapshotsResp?.snapshots || [],
            notes: notesResp?.notes || []
          });
          break;
        }

        case 'captureCurrentPageFromPopup': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { sendResponse({ success: false, error: 'No active tab' }); return; }

            const slug = generateSlugFromUrl(tab.url);
            const timestamp = Date.now();
            await captureAndLog(tab.id, slug, timestamp, tab.url, tab.title);
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

        case 'reportPage': {
          try {
            const url = request.url;

            const workspace = await readCacheable('workspace');
            if (workspace && workspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const urlBlacklist = await readCacheable('urlBlacklist');
            const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
            if (blacklist.some(prefix => url.startsWith(prefix))) {
              if (request.isInitialLoad) {
                const existing = await requestOffscreen({ action: 'loadInteractionByUrl', url });
                if (!existing || !existing.interaction) {
                  console.log(`Skipping blacklisted URL (not in database): ${url}`);
                  sendResponse({ success: true });
                  return;
                }
                console.log(`Blacklisted URL but already in database, continuing: ${url}`);
              } else {
                sendResponse({ success: true });
                return;
              }
            }

            // Augment referrer from webNavigation fallback
            const delta = { ...request };
            delete delta.action;
            delete delta.isInitialLoad;
            delete delta.isLeaving;
            if (!delta.referrer && request.isInitialLoad && sender.tab?.id != null) {
              const bgRef = getReferrer(sender.tab.id);
              if (bgRef) delta.referrer = bgRef;
            }

            // Diff against cached state — only log changed fields
            const { entry } = await processPageReport(delta);

            if (entry) {
              // First-visit extras: checkpoints before the visit entry
              if (request.isInitialLoad) {
                const slug = delta.slug || generateSlugFromUrl(url);
                const title = entry.title || '';
                await ensureLogBuffer();

                // Multi-day visit checkpoint
                const todayStr = new Date().toISOString().slice(0, 10);
                const key = 'page:' + slug;
                const cachedPage = await getCachedEntity(key);
                let isMultiDay = false;
                if (cachedPage && cachedPage.visitDates) {
                  const todayYMD = (() => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
                  isMultiDay = cachedPage.visitDates.some(ymd => ymd !== todayYMD);
                } else {
                  isMultiDay = logBuffer.some(e => e.action === 'page' && e.url === url && dateKeyFromTimestamp(e.timestamp) !== todayStr);
                }
                if (isMultiDay) {
                  await ensureCheckpointIfMissing(slug, url, title);
                }

                // Parent checkpoint for referrer
                if (entry.referrer) {
                  const refSlug = generateSlugFromUrl(entry.referrer);
                  await ensureCheckpointIfMissing(refSlug, entry.referrer, '');
                }
              }

              await addLog(entry);

              // First-visit extras: gateway + workspace
              if (request.isInitialLoad) {
                const slug = delta.slug || generateSlugFromUrl(url);
                const title = entry.title || '';
                const timestamp = entry.timestamp;

                updateGatewayRegistry(url);

                const wsListIds = workspace?.listIds || [];
                if (workspace && workspace.mode === 'workspace' && wsListIds.length > 0) {
                  try {
                    const { lists: cachedLists = [] } = await chrome.storage.session.get(['lists']);

                    for (const listKey of wsListIds) {
                      const listSlug = listKey.startsWith('list:') ? listKey.slice(5) : listKey;
                      const listEntry = cachedLists.find(c => c.slug === listSlug);
                      const listPins = listEntry?.pins || [];
                      const already = listPins.some(p => p.url === url);
                      if (!already) {
                        await addLog({
                          timestamp: Date.now(),
                          action: 'list',
                          id: listSlug,
                          op: 'add',
                          urls: [url]
                        });
                        console.log(`Workspace: auto-pinned ${url} to list ${listSlug}`);
                      }
                    }

                    if (workspace.autoSnapshot && sender.tab) {
                      captureAndLog(sender.tab.id, slug, timestamp, url, title).catch(err => {
                        console.warn('[auto-snapshot] ERROR:', err.message, err);
                      });
                    }
                  } catch (err) {
                    console.warn('Workspace: auto-pin/snapshot error:', err.message);
                  }
                }

                notifyMutation('interaction', { url });
              }
            }

            // Explicit drain on page leave
            if (request.isLeaving) drainNow();
            console.log(`Processed page report: ${url} (initial=${!!request.isInitialLoad}, leaving=${!!request.isLeaving})`);
            sendResponse({ success: true });
          } catch (error) {
            console.error('Error processing reportPage:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // ── Queue Operations ──

        case 'clearWriteQueue': {
          logBuffer = [];
          await chrome.storage.local.set({ logBuffer });
          sendResponse({ success: true });
          break;
        }

        case 'flushLogBuffer': {
          await ensureOffscreenPort();
          await drainNow();
          // Send entries via port (avoids chrome.storage.local in offscreen)
          await requestOffscreen({ action: 'flushLogBuffer', entries: logBuffer });
          // Drain sends watermark via port; give it time to arrive and prune logBuffer
          await new Promise(r => setTimeout(r, 100));
          sendResponse({ success: true, remaining: logBuffer.length });
          break;
        }

        // ── Pure Reads (relay to offscreen, cache pages) ──

        case 'loadSettings': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadSettings' });
          console.debug(`[I/O] loadSettings: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadPageNotes': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadPageNotes', slug: request.slug });
          console.debug(`[I/O] loadPageNotes(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadAllNotes': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadAllNotes' });
          console.debug(`[I/O] loadAllNotes: ${(performance.now() - t0).toFixed(1)}ms`);
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

        case 'loadPageBatch': {
          const t0 = performance.now();
          const result = {};
          const uncachedSlugs = [];

          // Check page cache for each slug
          for (const slug of request.slugs) {
            const key = 'page:' + slug;
            const cached = await getCachedEntity(key);
            if (cached) {
              result[slug] = cached;
            } else {
              uncachedSlugs.push(slug);
            }
          }

          // Fetch uncached from offscreen
          if (uncachedSlugs.length > 0) {
            const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: uncachedSlugs });
            if (resp?.success && resp.pages) {
              for (const [slug, page] of Object.entries(resp.pages)) {
                result[slug] = page;
                await setCachedEntity('page:' + slug, page);
              }
            }
          }

          console.debug(`[I/O] loadPageBatch: ${request.slugs.length} slugs (${request.slugs.length - uncachedSlugs.length} cached) in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, pages: result });
          break;
        }

        case 'loadPageDetail': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadPageDetail', slug: request.slug, url: request.url });
          if (resp?.page) {
            await setCachedEntity('page:' + request.slug, resp.page);
          }
          console.debug(`[I/O] loadPageDetail(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'loadListPins': {
          const t0 = performance.now();
          if (request.listId) {
            const resp = await requestOffscreen({ action: 'loadListPins', listId: request.listId });
            console.debug(`[I/O] loadListPins(${request.listId}): ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse(resp);
          } else {
            const resp = await requestOffscreen({ action: 'loadListPins' });
            console.debug(`[I/O] loadListPins: ${(performance.now() - t0).toFixed(1)}ms`);
            sendResponse(resp);
          }
          break;
        }

        case 'loadListPinsById': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadListPinsById', listId: request.listId });
          console.debug(`[I/O] loadListPinsById(${request.listId}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'getLists': {
          const lists = await readCacheable('lists') || [];
          sendResponse({ lists });
          break;
        }

        case 'getRecycleBin': {
          const items = await readCacheable('recycleBin') || [];
          sendResponse({ items });
          break;
        }

        case 'loadPermanentDeletes': {
          const keys = await readCacheable('permanentDeletes') || [];
          sendResponse({ success: true, keys });
          break;
        }

        case 'getGatewayDomains': {
          const domains = await readCacheable('gatewayDomains') || {};
          sendResponse({ success: true, domains });
          break;
        }

        case 'listSnapshots': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'listSnapshots', slug: request.slug });
          console.debug(`[I/O] listSnapshots(${request.slug}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'getSnapshotUrl': {
          const resp = await requestOffscreen({ action: 'getSnapshotUrl', slug: request.slug, timestamp: request.timestamp });
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

            // Load page
            const key = 'page:' + slug;
            let page = await getCachedEntity(key);
            if (!page) {
              const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
              page = resp?.pages?.[slug] || {};
            }

            // Resolve mixed-format refs: page:slug / bare slug → URL via loadPageBatch, URL/{url,title} → use directly
            async function resolveRefs(refs) {
              const urls = [];
              const slugsToLoad = [];
              for (const ref of refs) {
                if (typeof ref === 'object') { urls.push(ref.url); continue; }
                if (ref.startsWith('http')) { urls.push(ref); continue; }
                if (ref.startsWith('page:')) { slugsToLoad.push(ref.slice(5)); continue; }
                slugsToLoad.push(ref); // bare slug
              }
              if (slugsToLoad.length > 0) {
                const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: slugsToLoad });
                for (const s of slugsToLoad) {
                  const p = resp?.pages?.[s];
                  if (p && p.url) urls.push(p.url);
                }
              }
              return urls;
            }

            // Parents: from page.parents, fallback to parentIndex for non-checkpointed pages
            let parentRefs = page.parents || [];
            if (parentRefs.length === 0) {
              const parentIndex = (await readCacheable('parentIndex')) || { timestamp: 0, index: {} };
              parentRefs = (parentIndex.index[url] || []).map(ps => 'page:' + ps); // convert bare slugs to page: keys
            }
            const parentReferrers = await resolveRefs(parentRefs);

            // Parents: lists containing this URL
            const parentLists = [];
            const allLists = (await readCacheable('lists')) || [];
            for (const list of allLists) {
              const listCacheKey = 'listCache:' + list.slug;
              const cached = (await chrome.storage.session.get(listCacheKey))[listCacheKey];
              if (cached) {
                const inPinned = cached.fullPinned?.some(p => p.url === url);
                const inRelated = cached.related?.some(r => r.url === url);
                if (inPinned) parentLists.push({ slug: list.slug, name: list.name, type: 'pin' });
                else if (inRelated) parentLists.push({ slug: list.slug, name: list.name, type: 'appear' });
              }
            }

            // Children: from page.children (filter out notes, keep only pages) + parentIndex inverse lookup
            const childRefs = (page.children || []).filter(c => !c.startsWith('note:'));
            let children = await resolveRefs(childRefs);
            // Also check parentIndex for non-checkpointed children
            const piForChildren = (await readCacheable('parentIndex')) || { timestamp: 0, index: {} };
            for (const [childUrl, pSlugs] of Object.entries(piForChildren.index)) {
              if (pSlugs.includes(slug) && !children.includes(childUrl)) {
                children.push(childUrl);
              }
            }

            sendResponse({
              success: true,
              parents: { referrers: parentReferrers, lists: parentLists },
              children
            });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // ── Writes (session cache + log buffer) ──

        case 'saveSettings': {
          const s = request.settings;
          const ts = Date.now();
          for (const key of SETTINGS_KEYS) {
            if (s[key] !== undefined) {
              await addLog({ timestamp: ts, action: 'set', key, value: s[key] });
            }
          }
          sendResponse({ success: true });
          notifyMutation('settings');
          break;
        }

        case 'saveSettingsKey': {
          await addLog({ timestamp: Date.now(), action: 'set', key: request.key, value: request.value });
          sendResponse({ success: true });
          notifyMutation('settings', { key: request.key });
          break;
        }

        case 'createNote': {
          const pageSlug = request.pageSlug;
          const timestamp = Date.now();
          const noteSlug = generateNoteSlug(timestamp, request.excerpt);

          // Ensure parent page has a checkpoint so drain can update its children
          // (same pattern as referrer handling in the visit flow)
          await ensureCheckpointIfMissing(pageSlug, sender?.tab?.url || '', sender?.tab?.title || '');
          const effects = await addLog({
            timestamp,
            action: 'note',
            slug: noteSlug,
            excerpt: request.excerpt,
            note: request.note || '',
            cssPath: request.cssPath || null,
            parents: [`page:${pageSlug}`],
            children: []
          });
          const notes = await requestOffscreen({ action: 'loadPageNotes', slug: pageSlug });
          sendResponse({ success: true, notes: notes.notes || [], noteSlug });
          notifyMutation('note', { pageSlug, noteSlug });
          break;
        }

        case 'deleteNote': {
          const noteSlug = request.noteSlug;
          // Move to recycle bin via list operation
          await addLog({
            timestamp: Date.now(),
            action: 'list',
            id: 'system/recycle-bin',
            op: 'add',
            keys: [`note:${noteSlug}`]
          });
          sendResponse({ success: true });
          notifyMutation('note', { noteSlug });
          break;
        }

        case 'updateNote': {
          const noteSlug = request.noteSlug;
          const timestamp = Date.now();
          await addLog({
            timestamp,
            action: 'note',
            slug: noteSlug,
            note: request.note
          });
          sendResponse({ success: true });
          notifyMutation('note', { noteSlug });
          break;
        }

        case 'toggleListPin': {
          const { listId, url } = request;
          const { lists = [] } = await chrome.storage.session.get(['lists']);
          const list = lists.find(c => c.slug === listId);
          const isPinned = (list?.pins || []).some(p => p.url === url);
          await addLog({
            timestamp: Date.now(), action: 'list', id: listId,
            op: isPinned ? 'del' : 'add', urls: [url]
          });
          sendResponse({ success: true, pinned: !isPinned });
          notifyMutation('pins', { listId });
          break;
        }

        case 'saveListPinsById': {
          const ts = Date.now();
          await addLog({
            timestamp: ts, action: 'list',
            id: request.listId, op: 'clear', urls: []
          });
          if (request.pins && request.pins.length > 0) {
            await addLog({
              timestamp: ts + 1, action: 'list',
              id: request.listId, op: 'add',
              urls: request.pins.map(p => p.url)
            });
          }
          sendResponse({ success: true });
          notifyMutation('pins', { listId: request.listId });
          break;
        }

        case 'savePermanentDeletes': {
          const ts = Date.now();
          await addLog({
            timestamp: ts, action: 'list',
            id: 'system/permanent-deletes', op: 'clear', keys: []
          });
          if (request.keys && request.keys.length > 0) {
            await addLog({
              timestamp: ts + 1, action: 'list',
              id: 'system/permanent-deletes', op: 'add', keys: request.keys
            });
          }
          sendResponse({ success: true });
          notifyMutation('permanentDeletes');
          break;
        }

        case 'saveListMeta': {
          const metaEntry = { timestamp: Date.now(), action: 'list_meta', id: request.listId, name: request.name };
          if (request.qbTrees !== undefined) metaEntry.qbTrees = request.qbTrees;
          await addLog(metaEntry);
          sendResponse({ success: true });
          notifyMutation('lists');
          break;
        }

        case 'deleteList': {
          const order = (await readCacheable('listOrder')) || [];
          const newOrder = order.filter(key => key !== 'list:' + request.listId);
          await addLog({ timestamp: Date.now(), action: 'set', key: 'listOrder', value: newOrder });
          await addLog({ timestamp: Date.now(), action: 'del_list', id: request.listId });
          sendResponse({ success: true });
          notifyMutation('lists');
          break;
        }

        case 'saveRecycleBin': {
          const ts = Date.now();
          await addLog({
            timestamp: ts, action: 'list',
            id: 'system/recycle-bin', op: 'clear', keys: []
          });
          if (request.items && request.items.length > 0) {
            await addLog({
              timestamp: ts + 1, action: 'list',
              id: 'system/recycle-bin', op: 'add',
              keys: request.items.map(item => item.key)
            });
          }
          sendResponse({ success: true });
          notifyMutation('recycleBin');
          break;
        }

        // ── Pass-through (complex FS ops) ──

        case 'initializeFilesystem': {
          const resp = await requestOffscreen({ action: 'initializeFilesystem' });
          sendResponse(resp);
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
