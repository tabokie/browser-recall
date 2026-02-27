// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl, generateNoteSlug } from './utils.js';
import { effectOf, applyLogToPage } from './replay.js';
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

// ─── Log Buffer Replay Helper ─────────────────────────────────────────
// Replays pending logBuffer entries against a page entity to bring it up-to-date.
// Pure function: non-matching entries are no-ops (applyLogToPage handles slug matching).

function replayBufferOver(page) {
  let current = page;
  for (const entry of logBuffer) {
    current = applyLogToPage(current, entry);
  }
  return current;
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
    const { settings } = await chrome.storage.session.get(['settings']);
    return settings ? { timestamp: 0, ...settings } : null;
  }
  if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
    const listId = key.slice('list:'.length);
    const { lists = [] } = await chrome.storage.session.get(['lists']);
    const list = lists.find(c => c.slug === listId);
    if (list) return { timestamp: 0, slug: listId, name: list.name || '', qbTrees: list.qbTrees || [], pins: list.pins || [] };
    return null;
  }
  if (key === 'list:system/recycle-bin') {
    const data = await chrome.storage.session.get([key]);
    const val = data[key];
    return val ? { timestamp: 0, items: val } : null;
  }
  if (key === 'list:system/permanent-deletes') {
    const data = await chrome.storage.session.get([key]);
    const val = data[key];
    return val ? { timestamp: 0, keys: val } : null;
  }
  if (key === 'list:system/shallow-page') {
    const data = await chrome.storage.session.get([key]);
    return data[key] || null;
  }
  if (key === 'list:system/gateways') {
    const data = await chrome.storage.session.get([key]);
    const val = data[key];
    return val ? { timestamp: 0, origins: val } : null;
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
      const { settings: existing = {} } = await chrome.storage.session.get(['settings']);
      const merged = { ...existing };
      for (const k of SETTINGS_SUBKEYS) {
        if (entity[k] !== undefined) merged[k] = entity[k];
      }
      await chrome.storage.session.set({ settings: merged });
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
      await chrome.storage.session.set({ [key]: entity.items });
    } else if (key === 'list:system/permanent-deletes') {
      await chrome.storage.session.set({ [key]: entity.keys });
    } else if (key === 'list:system/shallow-page') {
      await chrome.storage.session.set({ [key]: entity });
    } else if (key === 'list:system/gateways') {
      await chrome.storage.session.set({ [key]: entity.origins });
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
  if (interaction.referrerId) entry.referrerId = interaction.referrerId;
  await addLog(entry);
}

// ─── Settings Keys ───────────────────────────────────────────────────
// Sub-keys within the settings entity (settings.json on disk).
// Used by saveSettings handler to enumerate loggable keys.

const SETTINGS_SUBKEYS = ['workspace', 'listOrder', 'urlBlacklist', 'titleTrimRules', 'settings'];

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
  if (key === 'settings') {
    // Batch-load all settings from settings.json into a single session key
    const resp = await requestOffscreen({ action: 'loadSettings' });
    const settings = resp?.settings || {};
    await chrome.storage.session.set({ settings });
    return settings;
  }
  let value;
  switch (key) {
    case 'lists': {
      const metaResp = await requestOffscreen({ action: 'loadAllListMetadata' });
      let allLists = metaResp?.lists || [];
      const settings = (await readCacheable('settings')) || {};
      const listOrder = settings.listOrder || [];
      if (listOrder.length > 0) {
        const ordered = [];
        for (const k of listOrder) {
          const slug = k.startsWith('list:') ? k.slice(5) : k;
          const c = allLists.find(x => x.slug === slug);
          if (c) ordered.push(c);
        }
        for (const c of allLists) { if (!listOrder.includes('list:' + c.slug)) ordered.push(c); }
        allLists = ordered;
      }
      value = allLists; break;
    }
    case 'list:system/recycle-bin': {
      const r = await requestOffscreen({ action: 'loadRecycleBin' });
      value = r?.items || []; break;
    }
    case 'list:system/permanent-deletes': {
      const r = await requestOffscreen({ action: 'loadPermanentDeletes' });
      value = r?.keys || []; break;
    }
    case 'list:system/shallow-page': {
      const r = await requestOffscreen({ action: 'loadShallowPageIndex' });
      value = r?.success ? { timestamp: r.timestamp || 0, index: r.index || {} } : { timestamp: 0, index: {} }; break;
    }
    case 'list:system/gateways': {
      const r = await requestOffscreen({ action: 'loadGateways' });
      value = r?.origins || []; break;
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
      await chrome.storage.session.set({ settings: resp.settings });
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
    if (rbResp?.success) await chrome.storage.session.set({ 'list:system/recycle-bin': rbResp.items || [] });
  } catch (e) { console.warn('Recycle bin load failed:', e.message); }

  try {
    const pdResp = await requestOffscreen({ action: 'loadPermanentDeletes' });
    if (pdResp?.success) await chrome.storage.session.set({ 'list:system/permanent-deletes': pdResp.keys || [] });
  } catch (e) { console.warn('Permanent deletes load failed:', e.message); }

  try {
    const spResp = await requestOffscreen({ action: 'loadShallowPageIndex' });
    const spiValue = spResp?.success
      ? { timestamp: spResp.timestamp || 0, index: spResp.index || {} }
      : { timestamp: 0, index: {} };
    await chrome.storage.session.set({ 'list:system/shallow-page': spiValue });
  } catch (e) { console.warn('Shallow page index load failed:', e.message); }

  // Phase 1.5: Pre-load page entities referenced by logBuffer from filesystem
  await ensureLogBuffer();
  const bufferPageSlugs = new Set();
  for (const entry of logBuffer) {
    if (entry.url) bufferPageSlugs.add(generateSlugFromUrl(entry.url));
    if (entry.referrerId) {
      const refSlug = entry.referrerId.startsWith('page:') ? entry.referrerId.slice(5) : entry.referrerId;
      bufferPageSlugs.add(refSlug);
    }
  }
  if (bufferPageSlugs.size > 0) {
    const slugsToLoad = [];
    for (const slug of bufferPageSlugs) {
      if (!(await getCachedEntity('page:' + slug))) slugsToLoad.push(slug);
    }
    if (slugsToLoad.length > 0) {
      try {
        const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: slugsToLoad });
        if (resp?.success && resp.pages) {
          for (const [slug, page] of Object.entries(resp.pages)) {
            await setCachedEntity('page:' + slug, page);
          }
        }
      } catch (e) { console.warn('Page pre-load failed:', e.message); }
    }
  }

  // Phase 2: Replay pending logBuffer entries via effectOf
  for (const entry of logBuffer) {
    try {
      const effects = await effectOf(entry, sessionLoad);
      await sessionWrite(effects);
    } catch (e) { console.warn('Hydration replay failed for entry:', e.message); }
  }

  // Phase 3: Order lists by listOrder
  const { lists = [], settings: settingsObj = {} } = await chrome.storage.session.get(['lists', 'settings']);
  const listOrder = settingsObj.listOrder || [];
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

  console.log('Cache hydrated');
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle || 'Untitled';
  const titleTrimRules = (await readCacheable('settings'))?.titleTrimRules || [];
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

  // Referrer: convert to referrerId (page:<slug> format), skip self-referential
  if (delta.referrer != null) {
    const refSlug = generateSlugFromUrl(delta.referrer);
    if (refSlug !== slug) {
      const referrerId = 'page:' + refSlug;
      if (!cached || cached.referrerId !== referrerId) {
        entry.referrerId = referrerId;
        hasChange = true;
      }
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
// Transient detection state: tracks child page counts per origin within the
// current service worker lifetime. Not persisted — only used to decide when
// an origin qualifies as a gateway (childCount >= 2).
const gatewayDetection = {}; // { [origin]: { childCount, promoted } }

async function updateGatewayRegistry(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const isSearchQuery = parsed.searchParams.has('q') || parsed.searchParams.has('query') || parsed.searchParams.has('search');
    const isRoot = parsed.pathname === '/' || parsed.pathname === '' || parsed.pathname === '/index.html' || parsed.pathname === '/index.htm';

    // Check if origin is already a gateway (persisted via log/replay)
    const gatewayOrigins = (await readCacheable('list:system/gateways')) || [];
    if (gatewayOrigins.includes(origin)) return;

    if (!gatewayDetection[origin]) {
      gatewayDetection[origin] = { childCount: 0, promoted: false };
    }
    const det = gatewayDetection[origin];
    if (det.promoted) return;

    if (isSearchQuery || !isRoot) {
      det.childCount++;
    }

    if (det.childCount >= 2) {
      det.promoted = true;
      await addLog({
        timestamp: Date.now(),
        action: 'list',
        id: 'system/gateways',
        op: 'add',
        origins: [origin]
      });
      console.log(`Gateway: promoted ${origin}`);
      // Create a synthetic page visit for the root so it appears in Explore history
      fetchAndCreateGatewayRoot(origin);
    }
  } catch (e) {
    console.warn('Gateway registry update failed:', e.message);
  }
}

async function fetchAndCreateGatewayRoot(origin) {
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

    await appendVisit({ timestamp: Date.now(), url: rootUrl, title });
    console.log(`Gateway: created synthetic root visit for ${origin}`);
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

// ─── Pin ID Resolution ───────────────────────────────────────────────
// Resolve a URL to its authoritative pin ID by checking cache then disk.
// Returns 'page:<slug>' if the page is checkpointed, 'shallow:<url>' otherwise.

async function resolvePageId(url) {
  const slug = generateSlugFromUrl(url);
  const key = 'page:' + slug;
  if (await getCachedEntity(key)) return key;
  const resp = await requestOffscreen({ action: 'pageExists', slug });
  return resp?.exists ? key : 'shallow:' + url;
}

// Ensure each ID in the array is authoritative. Shallow IDs are re-checked
// against cache and disk because a race between page capture (which creates
// the checkpoint) and the pin message (which references the URL) can cause
// callers to send 'shallow:<url>' for a page that was checkpointed in between.
async function resolveShallowIds(ids) {
  const resolved = [];
  for (const id of ids) {
    if (id.startsWith('shallow:')) {
      resolved.push(await resolvePageId(id.slice(8)));
    } else {
      resolved.push(id);
    }
  }
  return resolved;
}

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
  const markdown = mdResp?.markdown || '';
  if (!markdown && !html) {
    throw new Error('Capture failed: page returned no content');
  }
  await requestOffscreen({
    action: 'captureSnapshot', slug, timestamp,
    markdown, html: html || ''
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

  const workspace = (await readCacheable('settings'))?.workspace;
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
      chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: error.message }).catch(() => {});
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
          const key = 'page:' + slug;

          // Entity storage: session cache → filesystem fallback
          let page = await getCachedEntity(key);
          if (!page) {
            const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
            if (resp?.pages?.[slug]) {
              await ensureLogBuffer();
              page = replayBufferOver(resp.pages[slug]);
              await setCachedEntity(key, page);
            }
          }

          const [snapshotsResp, notesResp] = await Promise.all([
            requestOffscreen({ action: 'listSnapshots', slug }),
            requestOffscreen({ action: 'loadPageNotes', slug })
          ]);

          // page is null for shallow pages (no checkpoint) — popup uses tab.title as fallback
          sendResponse({
            success: true, slug,
            interaction: page ? { url: page.url, title: page.title, user_title: page.user_title,
              attention: page.attention || '', timestamp: page.timestamp, slug } : null,
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
            const [errTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
            if (errTab) chrome.tabs.sendMessage(errTab.id, { action: 'showErrorNotification', message: error.message }).catch(() => {});
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

            const rpSettings = (await readCacheable('settings')) || {};
            const workspace = rpSettings.workspace;
            if (workspace && workspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const urlBlacklist = rpSettings.urlBlacklist;
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
                if (entry.referrerId) {
                  const refSlug = entry.referrerId.startsWith('page:') ? entry.referrerId.slice(5) : entry.referrerId;
                  await ensureCheckpointIfMissing(refSlug, delta.referrer || '', '');
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
                      // Derive typed pin id: page:<slug> if checkpointed, shallow:<url> otherwise
                      const pinSlug = delta.slug || generateSlugFromUrl(url);
                      const cachedPage = await getCachedEntity('page:' + pinSlug);
                      const pinId = cachedPage ? 'page:' + pinSlug : 'shallow:' + url;
                      const already = listPins.some(p => p.id === pinId);
                      if (!already) {
                        await addLog({
                          timestamp: Date.now(),
                          action: 'list',
                          id: listSlug,
                          op: 'add',
                          ids: [pinId]
                        });
                        console.log(`Workspace: auto-pinned ${pinId} to list ${listSlug}`);
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

        case 'getShallowPageIndex': {
          const spi = await readCacheable('list:system/shallow-page');
          sendResponse(spi || { timestamp: 0, index: {} });
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

          // Fetch uncached from offscreen, replay logBuffer to bring up-to-date
          if (uncachedSlugs.length > 0) {
            await ensureLogBuffer();
            const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: uncachedSlugs });
            if (resp?.success && resp.pages) {
              for (const [slug, page] of Object.entries(resp.pages)) {
                const upToDate = replayBufferOver(page);
                result[slug] = upToDate;
                await setCachedEntity('page:' + slug, upToDate);
              }
            }
          }

          console.debug(`[I/O] loadPageBatch: ${request.slugs.length} slugs (${request.slugs.length - uncachedSlugs.length} cached) in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, pages: result });
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

        case 'readCacheable': {
          const value = await readCacheable(request.key);
          sendResponse({ value });
          break;
        }

        case 'getLists': {
          const lists = await readCacheable('lists') || [];
          sendResponse({ lists });
          break;
        }

        case 'getRecycleBin': {
          const items = await readCacheable('list:system/recycle-bin') || [];
          sendResponse({ items });
          break;
        }

        case 'loadPermanentDeletes': {
          const keys = await readCacheable('list:system/permanent-deletes') || [];
          sendResponse({ success: true, keys });
          break;
        }

        case 'getGatewayDomains': {
          const origins = await readCacheable('list:system/gateways') || [];
          sendResponse({ success: true, origins });
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

            // Resolve typed refs: page:<slug> → URL via loadPageBatch, shallow:<url> → extract URL
            async function resolveRefs(refs) {
              const urls = [];
              const slugsToLoad = [];
              for (const ref of refs) {
                if (ref.startsWith('shallow:')) { urls.push(ref.slice(8)); continue; }
                if (ref.startsWith('page:')) { slugsToLoad.push(ref.slice(5)); continue; }
                if (ref.startsWith('http')) { urls.push(ref); continue; }
                slugsToLoad.push(ref); // bare slug (legacy)
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

            // Parents: from page.parentIds, fallback to shallowPageIndex for non-checkpointed pages
            let parentRefs = page.parentIds || [];
            if (parentRefs.length === 0) {
              const spIndex = (await readCacheable('list:system/shallow-page')) || { timestamp: 0, index: {} };
              const shallowEntry = spIndex.index[url];
              if (shallowEntry) parentRefs = shallowEntry.parents || [];
            }
            const parentReferrers = await resolveRefs(parentRefs);

            // Parents: lists containing this URL
            const parentLists = [];
            const allLists = (await readCacheable('lists')) || [];
            for (const list of allLists) {
              const listCacheKey = 'listCache:' + list.slug;
              const cached = (await chrome.storage.session.get(listCacheKey))[listCacheKey];
              if (cached) {
                const pageId = 'page:' + slug;
                const shallowId = 'shallow:' + url;
                const inPinned = cached.fullPinned?.some(p => p.url === url || p.id === pageId || p.id === shallowId);
                const inRelated = cached.related?.some(r => r.url === url);
                if (inPinned) parentLists.push({ slug: list.slug, name: list.name, type: 'pin' });
                else if (inRelated) parentLists.push({ slug: list.slug, name: list.name, type: 'appear' });
              }
            }

            // Children: from page.childIds (filter out notes, keep only pages/shallow) + shallowPageIndex inverse lookup
            const childRefs = (page.childIds || []).filter(c => !c.startsWith('note:'));
            let children = await resolveRefs(childRefs);
            // Also check shallowPageIndex for non-checkpointed children
            const spForChildren = (await readCacheable('list:system/shallow-page')) || { timestamp: 0, index: {} };
            for (const [childUrl, shallowEntry] of Object.entries(spForChildren.index)) {
              const parentKey = 'page:' + slug;
              if ((shallowEntry.parents || []).includes(parentKey) && !children.includes(childUrl)) {
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
          for (const k of SETTINGS_SUBKEYS) {
            if (s[k] !== undefined) {
              await addLog({ timestamp: ts, action: 'set', key: k, value: s[k] });
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
            parentIds: [`page:${pageSlug}`],
            childIds: []
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
          const { listId, url, id: requestId } = request;
          let pinId = requestId || (url ? await resolvePageId(url) : null);
          // Re-check shallow IDs — see resolveShallowIds comment.
          if (pinId?.startsWith('shallow:')) {
            pinId = await resolvePageId(pinId.slice(8));
          }
          const { lists = [] } = await chrome.storage.session.get(['lists']);
          const list = lists.find(c => c.slug === listId);
          const isPinned = (list?.pins || []).some(p => p.id === pinId);
          await addLog({
            timestamp: Date.now(), action: 'list', id: listId,
            op: isPinned ? 'del' : 'add', ids: [pinId]
          });
          sendResponse({ success: true, pinned: !isPinned });
          notifyMutation('pins', { listId });
          break;
        }

        case 'addListPins': {
          if (request.ids && request.ids.length > 0) {
            const ids = await resolveShallowIds(request.ids);
            await addLog({
              timestamp: Date.now(), action: 'list',
              id: request.listId, op: 'add', ids
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
          notifyMutation('list:system/permanent-deletes');
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
          const order = (await readCacheable('settings'))?.listOrder || [];
          const newOrder = order.filter(k => k !== 'list:' + request.listId);
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
          notifyMutation('list:system/recycle-bin');
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
