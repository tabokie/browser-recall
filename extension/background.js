// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl, generateNoteSlug, dateKeyFromTimestamp } from './utils.js';
import { effectOf } from './replay.js';
import { validateRuleConfig, validateSmartRuleFn, matchRules, matchKeywordRule, buildPageDataFromEntry } from './rule-engine.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { cacheGet, cacheSet, cacheRemove, cachePin, cacheUnpin, setEntityCacheWatermark, cacheClear } from './entity-cache.js';

console.log('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — data is safe in chrome.storage.local until drained
const HISTORY_RECENT_DAYS = 7; // days of past history to cache for multi-day checks

// In-memory Map of URL → visitDates (YYYYMMDD[]) from history:recent (past days).
// Populated during hydration, immutable until next browser restart.
let recentUrls = new Map();

// Session storage: in-memory IPC, survives SW termination, cleared on browser restart.
// hydrateCache() re-populates from filesystem on every startup.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

// Resolves when hydrateCache() completes (or immediately if no hydration needed).
let hydrationDone = Promise.resolve();


// ─── Offscreen Document ───────────────────────────────────────────────

async function setupOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['LOCAL_STORAGE'],
      justification: 'Manage filesystem operations for interaction history'
    });
    console.log('Offscreen document created');
  } catch (e) {
    // TOCTOU: another caller created the document between getContexts and createDocument
    if (e.message?.includes('single offscreen')) return;
    throw e;
  }
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
async function sessionLoad(key, opts) {
  return await readCacheable(key, opts?.includeDeleted);
}

// Like sessionLoad but without the hydrationDone guard.
// Used during hydrateCache() where awaiting hydrationDone would deadlock.
async function sessionLoadDuringHydration(key, opts) {
  const cached = await cacheGet(key);
  if (cached !== null) {
    if (!opts?.includeDeleted && cached.deleted) return null;
    return cached;
  }
  const value = await readFs(key);
  if (!opts?.includeDeleted && value?.deleted) return null;
  return value;
}

// Write effectOf results back to session cache.
// Sentinel value for GC'd entities — distinct from cache miss (null).
// Prevents readCacheable from reloading a GC'd entity from disk before drain.
const GC_TOMBSTONE = { __gc: true };

async function sessionWrite(effects) {
  for (const [key, entity] of Object.entries(effects)) {
    if (entity === null) {
      await cacheSet(key, GC_TOMBSTONE);
      continue;
    }
    await cacheSet(key, entity);
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
  // Append to today's history date key in session (fire-and-forget).
  // Pin the key: today's session data includes unflushed entries from addLog that
  // are newer than the on-disk JSONL file, so evicting it would lose data.
  // Also covers date rollover (new date key created mid-session).
  const todayKey = 'log:' + dateKeyFromTimestamp(entry.timestamp);
  cacheGet(todayKey).then(async today => {
    if (today == null) {
      // Cache miss — load from disk. Should not happen after hydration.
      console.warn(`[addLog] history cache miss for ${todayKey}, loading from disk`);
      const dateStr = dateKeyFromTimestamp(entry.timestamp);
      const resp = await requestOffscreen({ action: 'loadHistoryRange', from: dateStr, to: dateStr });
      assertOffscreenSuccess(resp, todayKey);
      today = resp.entries || [];
    }
    today.push(entry);
    cacheSet(todayKey, today, { timestamp: entry.timestamp });
    cachePin(todayKey);
  }).catch(e => console.warn('[addLog] history cache update failed:', e.message));
  ensureOffscreenPort().catch(e => console.warn('[addLog] offscreen port failed:', e.message));
  scheduleDrainNotify();
  return effects;
}

// Build a visit_page log entry. Title omitted when absent (slow-loading pages).
function buildVisitPageEntry(url, title, referrerUrl) {
  const entry = { timestamp: Date.now(), action: 'visit_page', url };
  if (title) entry.title = title;
  if (referrerUrl) entry.referrerUrl = referrerUrl;
  return entry;
}

// Build a leave_page log entry with attention data.
function buildLeavePageEntry(url, title, scrollDepth, timeOnPage) {
  const entry = { timestamp: Date.now(), action: 'leave_page', url };
  if (title) entry.title = title;
  if (scrollDepth !== undefined && scrollDepth !== null) entry.scrollDepth = scrollDepth;
  if (timeOnPage !== undefined && timeOnPage > 0) entry.timeOnPage = timeOnPage;
  return entry;
}

// ─── Settings Keys ───────────────────────────────────────────────────

// ─── Session → Filesystem Fallback ───────────────────────────────────
// readCacheable(key): await hydration, then session cache → readFs fallback.
// readFs(key): load from filesystem via offscreen, cache into session.

async function readCacheable(key, includeDeleted = false) {
  await hydrationDone;
  const cached = await cacheGet(key);
  if (cached !== null) {
    if (cached.__gc) return null; // GC'd entity — tombstone prevents disk reload
    if (!includeDeleted && cached.deleted) return null;
    return cached;
  }
  const value = await readFs(key);
  if (!includeDeleted && value?.deleted) return null;
  return value;
}

// Traverse the list tree (BFS) and return all list keys.
async function getAllListKeys() {
  await hydrationDone;
  const root = await readCacheable('list:system/root');
  const result = [];
  const queue = [...(root?.childLists || [])];
  const visited = new Set();
  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    result.push(key);
    const entity = await readCacheable(key);
    if (entity?.childLists) queue.push(...entity.childLists);
  }
  return result;
}

function assertOffscreenSuccess(resp, key) {
  if (!resp || resp.success === false) {
    throw new Error(resp?.error || `Offscreen load failed for ${key}`);
  }
}

async function readFs(key) {
  let value;
  switch (key) {
    case 'manifest:settings': {
      const resp = await requestOffscreen({ action: 'loadSettings' });
      assertOffscreenSuccess(resp, key);
      value = resp.settings;
      break;
    }
    case 'manifest:name-to-id': {
      const r = await requestOffscreen({ action: 'loadNameMap' });
      assertOffscreenSuccess(r, key);
      value = r.entity || { timestamp: 0, paths: {} };
      break;
    }
    case 'manifest:orphaned': {
      const r = await requestOffscreen({ action: 'loadOrphaned' });
      assertOffscreenSuccess(r, key);
      value = r.entity;
      break;
    }
    default: {
      if (key.startsWith('log:')) {
        // Disk-only read (no logBuffer replay). Safe because:
        // - Today's key is pinned (never evicted, never reaches readFs post-hydration)
        // - Past keys with undrained logBuffer entries have timestamp > persistWatermark,
        //   so watermark-gated eviction won't evict them until drain completes
        // - Past keys fully drained: disk is complete, no replay needed
        const dateStr = key.slice('log:'.length);
        const r = await requestOffscreen({ action: 'loadHistoryRange', from: dateStr, to: dateStr });
        assertOffscreenSuccess(r, key);
        value = r.entries || [];
        break;
      }
      if (key.startsWith('page:')) {
        const slug = key.slice('page:'.length);
        const r = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
        assertOffscreenSuccess(r, key);
        value = r.pages?.[slug] ?? null;
        break;
      }
      if (key.startsWith('note:')) {
        const slug = key.slice('note:'.length);
        const r = await requestOffscreen({ action: 'loadNote', noteSlug: slug });
        assertOffscreenSuccess(r, key);
        value = r.note ?? null;
        break;
      }
      if (key.startsWith('list:')) {
        const listId = key.slice('list:'.length);
        const r = await requestOffscreen({ action: 'loadListEntity', listId });
        assertOffscreenSuccess(r, key);
        value = r.entity ?? null;
        break;
      }
      return undefined;
    }
  }
  await cacheSet(key, value);
  return value;
}

// ─── Cache Hydration ──────────────────────────────────────────────────

async function hydrateCache() {
  // Phase 1: Load base entities from offscreen into session cache
  try {
    const resp = await requestOffscreen({ action: 'loadSettings' });
    if (resp?.success && resp.settings) {
      await cacheSet('manifest:settings', resp.settings);
    }
  } catch (e) { console.warn('Settings load failed:', e.message); }

  try {
    const metaResp = await requestOffscreen({ action: 'loadAllListMetadata' });
    if (metaResp?.success && metaResp.lists) {
      for (const list of metaResp.lists) {
        await cacheSet('list:' + list.slug, list);
      }
    }
  } catch (e) { console.warn('List metadata load failed:', e.message); }

  try {
    const rootResp = await requestOffscreen({ action: 'loadListEntity', listId: 'system/root' });
    if (rootResp?.success && rootResp.entity) await cacheSet('list:system/root', rootResp.entity);
  } catch (e) { console.warn('Root entity load failed:', e.message); }

  try {
    const nmResp = await requestOffscreen({ action: 'loadNameMap' });
    if (nmResp?.success && nmResp.entity) {
      await cacheSet('manifest:name-to-id', nmResp.entity);
    }
  } catch (e) { console.warn('Name-map load failed:', e.message); }

  // Phase 1.1 (default list creation) runs AFTER hydrateCache returns —
  // it uses addLog() which calls readCacheable → await hydrationDone,
  // so it can't run inside hydrateCache itself (circular wait).

  // Phase 1.5: History cache — per-date keys history:YYYY-MM-DD
  try {
    const todayStr = dateKeyFromTimestamp(Date.now());

    // Load today's history — pinned because addLog appends entries here that are
    // newer than the on-disk JSONL file; evicting would lose unflushed data.
    const todayResp = await requestOffscreen({ action: 'loadHistoryRange', from: todayStr, to: todayStr });
    assertOffscreenSuccess(todayResp, 'log:' + todayStr);
    const todayEntries = todayResp.entries || [];
    const todayKey = 'log:' + todayStr;
    const todayMaxTs = todayEntries.length ? todayEntries[todayEntries.length - 1].timestamp : 0;
    await cacheSet(todayKey, todayEntries, { timestamp: todayMaxTs });
    cachePin(todayKey);

    // Load past HISTORY_RECENT_DAYS days — pinned because multi-day visit checks
    // (recentUrls) read these frequently; eviction would force repeated disk loads.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - HISTORY_RECENT_DAYS);
    const fromStr = dateKeyFromTimestamp(fromDate.getTime());
    const toStr = dateKeyFromTimestamp(yesterday.getTime());

    recentUrls = new Map();
    if (fromStr <= toStr) {
      // Load the full range, then split into per-date keys
      const recentResp = await requestOffscreen({ action: 'loadHistoryRange', from: fromStr, to: toStr });
      assertOffscreenSuccess(recentResp, `log:${fromStr}..${toStr}`);
      const recentEntries = recentResp.entries || [];
      const recentFiles = recentResp.files || [];

      // Group entries by date
      const byDate = new Map();
      for (const entry of recentEntries) {
        const d = dateKeyFromTimestamp(entry.timestamp);
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d).push(entry);
      }

      // Fill every date in range: existing files get their entries, gaps get empty arrays
      const cur = new Date(fromDate);
      const end = new Date(yesterday);
      while (cur <= end) {
        const d = dateKeyFromTimestamp(cur.getTime());
        const entries = byDate.get(d) || [];
        const hKey = 'log:' + d;
        const maxTs = entries.length ? entries[entries.length - 1].timestamp : 0;
        await cacheSet(hKey, entries, { timestamp: maxTs });
        cachePin(hKey);
        cur.setDate(cur.getDate() + 1);
      }

      // Build in-memory URL → visitDates map for O(1) multi-day lookups
      for (const entry of recentEntries) {
        if ((entry.action === 'visit_page' || !entry.action) && entry.url) {
          const d = new Date(entry.timestamp);
          const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
          const dates = recentUrls.get(entry.url);
          if (dates) {
            if (!dates.includes(yyyymmdd)) dates.push(yyyymmdd);
          } else {
            recentUrls.set(entry.url, [yyyymmdd]);
          }
        }
      }

      // Unpin any older history keys still in session from prior SW lifetime
      // (session survives SW termination; these are stale cache from before the 7-day window)
      const fromMs = fromDate.getTime();
      for (const file of (recentResp?.files || [])) {
        // files returned by loadHistoryRange are within range, skip
      }
      // We can't enumerate session keys, but we can check known old dates
      // by looking at files older than our range from listInteractionFiles
      const allFilesResp = await requestOffscreen({ action: 'listInteractionFiles' });
      const allFiles = allFilesResp?.files || []; // Missing files listing is non-fatal
      for (const f of allFiles) {
        const d = f.replace('.jsonl', '');
        if (d < fromStr) {
          const oldKey = 'log:' + d;
          cacheUnpin(oldKey); // evictable if still in session
        }
      }
    }

    console.log(`History cache: ${todayEntries.length} today, ${recentUrls.size} recent URLs`);
  } catch (e) { console.warn('History cache load failed:', e.message); }

  // Phase 1.6: Pre-load page entities referenced by logBuffer from filesystem
  await ensureLogBuffer();

  // Dedup logBuffer against today's history (entries already flushed to disk)
  {
    const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
    let todayForDedup = await cacheGet(todayKey);
    if (todayForDedup == null) {
      // Cache miss — load from disk. Should not happen after hydration.
      console.warn(`[dedup] history cache miss for ${todayKey}, loading from disk`);
      const dateStr = dateKeyFromTimestamp(Date.now());
      const resp = await requestOffscreen({ action: 'loadHistoryRange', from: dateStr, to: dateStr });
      assertOffscreenSuccess(resp, todayKey);
      todayForDedup = resp.entries || [];
    }
    if (todayForDedup.length > 0 && logBuffer.length > 0) {
      const flushedTimestamps = new Set(todayForDedup.map(e => e.timestamp));
      const before = logBuffer.length;
      logBuffer = logBuffer.filter(e => !flushedTimestamps.has(e.timestamp));
      if (logBuffer.length < before) {
        console.log(`logBuffer dedup: ${before} → ${logBuffer.length} (${before - logBuffer.length} already flushed)`);
        await chrome.storage.local.set({ logBuffer });
      }
    }
  }

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
      if (!(await cacheGet('page:' + slug))) slugsToLoad.push(slug);
    }
    if (slugsToLoad.length > 0) {
      try {
        const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: slugsToLoad });
        if (resp?.success && resp.pages) {
          for (const [slug, page] of Object.entries(resp.pages)) {
            await cacheSet('page:' + slug, page);
          }
        }
      } catch (e) { console.warn('Page pre-load failed:', e.message); }
    }
  }

  // Phase 2: Replay pending logBuffer entries via effectOf.
  // Uses sessionLoadDuringHydration (not sessionLoad) to avoid deadlock:
  // sessionLoad → readCacheable → await hydrationDone → waiting for us.
  for (const entry of logBuffer) {
    try {
      const effects = await effectOf(entry, sessionLoadDuringHydration);
      await sessionWrite(effects);
    } catch (e) { console.warn('Hydration replay failed for entry:', e.message); }
  }

  // Phase 2.5: Append logBuffer entries to their history:<date> keys.
  // effectOf (Phase 2) updates entities but not history date keys. addLog() does
  // this lazily at runtime, but we need it done before any readCacheable call.
  // After this phase, history keys have disk + undrained entries. Their timestamps
  // reflect undrained data, so watermark-gated eviction protects them until drain.
  // Today's key is also pinned (Phase 1.5 + addLog) as an extra safeguard.
  for (const entry of logBuffer) {
    const dk = dateKeyFromTimestamp(entry.timestamp);
    const hk = 'log:' + dk;
    let entries = await cacheGet(hk);
    if (entries == null) entries = [];
    entries.push(entry);
    await cacheSet(hk, entries, { timestamp: entry.timestamp });
  }

  console.log('Cache hydrated');
}

// First-run default list creation — must run AFTER hydrateCache completes
// because addLog → sessionLoad → readCacheable → await hydrationDone.
async function ensureDefaultLists() {
  try {
    const metaRespCheck = await requestOffscreen({ action: 'loadAllListMetadata' });
    const userLists = (metaRespCheck?.lists || []).filter(l => !l.slug.startsWith('system/'));
    if (userLists.length === 0) {
      await addLog({
        timestamp: Date.now(),
        action: 'create_list',
        parents: [],
        name: 'Hubs',
      });
      await addLog({
        timestamp: Date.now(),
        action: 'add_rule',
        parents: [],
        name: 'Hubs',
        rule: {
          type: 'smart',
          config: {
            description: 'Hub and landing pages',
            fnSource: "const p = new URL(page.url).pathname.toLowerCase(); if (p === '/' || p === '') return 1; if (p.includes('index')) return 1; const parts = p.split('/').filter(Boolean); if (parts.length === 1 && p.endsWith('/')) return 1; const last = parts[parts.length - 1] || ''; const hub = ['blog', 'wiki', 'home', 'landing', 'explore', 'discover']; if (hub.some(k => last.includes(k))) return 1; return 0;",
          },
        },
      });
    }
  } catch (e) { console.warn('First-run default list creation failed:', e.message); }
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle;
  const titleTrimRules = (await readCacheable('manifest:settings')).titleTrimRules || [];
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

  chrome.contextMenus.create({
    id: 'portal-highlight',
    title: 'Highlight Selected',
    contexts: ['selection'],
  });

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
    await ensureDefaultLists();
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
      await ensureDefaultLists();
    }
  } catch (error) {
    console.warn('Startup hydration failed:', error.message);
  }
});

// ─── Save Page WE Integration ─────────────────────────────────────────
initSavepageBridge();

// ─── List Name Path Resolution ───────────────────────────────────────
// Resolve a list internal ID to its name path using the name-map.

async function getListParentsAndName(listId) {
  // System lists: name IS the ID
  if (listId.startsWith('system/')) {
    return { parents: [], name: listId };
  }
  const nameToId = await readCacheable('manifest:name-to-id');
  if (!nameToId?.paths) return null;
  for (const [path, id] of Object.entries(nameToId.paths)) {
    if (id === listId) {
      const parts = path.split('/');
      const name = parts.pop();
      return { parents: parts, name };
    }
  }
  return null;
}

// ─── Snapshot Capture ─────────────────────────────────────────────────

async function captureAndLog(tabId, slug, timestamp, url, title) {
  // PDF pages render via a native plugin — no extractable content
  if (url && /\.pdf(\?|#|$)/i.test(new URL(url).pathname)) {
    throw new Error('Cannot capture PDF pages');
  }
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
  // Single create_snapshot event — entity creation + child linking handled by effectOf
  const snapEntry = {
    timestamp, action: 'create_snapshot', url,
    path: `snapshots/${slug}-${timestamp}`
  };
  if (title) snapEntry.title = title;
  await addLog(snapEntry);
  notifyMutation('snapshot', { slug });
}

// ─── Context Menu ─────────────────────────────────────────────────────

async function handleContextMenuHighlight(url, title, selectionText, tabId) {
  const slug = generateSlugFromUrl(url);

  const timestamp = Date.now();
  const noteSlug = generateNoteSlug(timestamp, selectionText);

  await requestOffscreen({
    action: 'saveNote',
    slug: noteSlug,
    data: {
      slug: noteSlug,
      excerpt: selectionText,
      note: '',
      cssPath: null,
      parentIds: [`page:${slug}`],
      childIds: [],
      timestamp
    }
  });

  // create_note — effectOf ensures page entity exists
  const noteEntry = {
    timestamp,
    action: 'create_note',
    url,
    path: `notes/${noteSlug}.json`
  };
  if (title) noteEntry.title = title;
  await addLog(noteEntry);

  notifyMutation('note', { pageSlug: slug, noteSlug });

  // Show highlights panel in the tab's content script
  if (tabId > 0) {
    const page = await readCacheable('page:' + slug);
    const noteRefs = (page?.childIds || []).filter(c => c.startsWith('note:'));
    const notes = [];
    for (const ref of noteRefs) {
      const note = await readCacheable(ref);
      if (note) notes.push(note);
    }
    chrome.tabs.sendMessage(tabId, {
      action: 'showHighlightsPanel',
      notes,
      pageSlug: slug,
    }).catch(() => {});
  }

  return { success: true, noteSlug };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'portal-highlight') return;
  if (!info.selectionText) return;

  // The callback's tab object has wrong URL/id for PDF viewer tabs.
  // Query the real active tab instead; guard with title match.
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab?.url) return;
  if (tab?.title && activeTab.title !== tab.title) {
    console.warn('[context-menu] Active tab title mismatch, skipping');
    return;
  }

  try {
    await handleContextMenuHighlight(activeTab.url, activeTab.title, info.selectionText.trim(), activeTab.id);
  } catch (error) {
    console.warn('[context-menu] Highlight error:', error.message);
    if (activeTab.id > 0) {
      chrome.tabs.sendMessage(activeTab.id, {
        action: 'showErrorNotification',
        message: error.message
      }).catch(() => {});
    }
  }
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  console.log(`[background] Command received: ${command}`);

  const workspace = await cacheGet('workspace');
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
  } else if (command === 'like-page' || command === 'dislike-page') {
    const delta = command === 'like-page' ? 1 : -1;
    try {
      const rateEntry = { timestamp: Date.now(), action: 'rate_page', url: tab.url, likes: delta };
      if (tab.title) rateEntry.title = tab.title;
      await addLog(rateEntry);
      notifyMutation('interaction', { url: tab.url });
      chrome.tabs.sendMessage(tab.id, { action: 'showLikeNotification', delta }).catch(() => {});
    } catch (error) {
      console.warn(`[${command}] ERROR:`, error.message, error);
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
          const slug = request.slug || generateSlugFromUrl(request.url);
          const key = 'page:' + slug;

          // Entity storage: session cache → filesystem fallback
          let page = await readCacheable(key);

          // Snapshots: read from page.childIds filtered for snapshot: prefix
          const snapRefs = (page?.childIds || []).filter(c => c.startsWith('snapshot:'));
          const snapshots = snapRefs.map(ref => {
            const ts = parseInt(ref.slice(ref.lastIndexOf('-') + 1), 10);
            return { timestamp: ts, hasMd: true, hasHtml: true };
          }).sort((a, b) => b.timestamp - a.timestamp);

          // Notes: read from page.childIds via readCacheable (session cache → disk).
          // This surfaces notes created via addLog that haven't drained to disk yet.
          const noteRefs = (page?.childIds || []).filter(c => c.startsWith('note:'));
          const notes = [];
          for (const ref of noteRefs) {
            const note = await readCacheable(ref);
            if (note) notes.push(note);
          }

          // page is null for pages without entities — popup uses tab.title as fallback
          sendResponse({
            success: true, slug,
            interaction: page ? { url: page.url, title: page.title, user_title: page.user_title,
              scrollDepth: page.scrollDepth, timeOnPage: page.timeOnPage, likes: page.likes,
              timestamp: page.timestamp, slug } : null,
            snapshots,
            notes
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

            const rpWorkspace = await cacheGet('workspace');
            if (rpWorkspace && rpWorkspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const rpSettings = await readCacheable('manifest:settings');
            const urlBlacklist = rpSettings.urlBlacklist;
            const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
            if (!request.bypassBlacklist && blacklist.some(prefix => url.startsWith(prefix))) {
              if (request.isInitialLoad) {
                const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
                const todayEntries = await readCacheable(todayKey) || [];
                const inSession = todayEntries.some(e => e.url === url);
                if (!inSession) {
                  const existing = await requestOffscreen({ action: 'loadInteractionByUrl', url });
                  if (!existing || !existing.interaction) {
                    console.log(`Skipping blacklisted URL (not in database): ${url}`);
                    sendResponse({ success: true });
                    return;
                  }
                }
                console.log(`Blacklisted URL but already in database, continuing: ${url}`);
              } else {
                sendResponse({ success: true });
                return;
              }
            }

            if (request.isInitialLoad) {
              // visit_page: always includes title, referrerUrl is raw URL
              let referrerUrl = request.referrer || null;
              if (!referrerUrl && sender.tab?.id != null) {
                const bgRef = getReferrer(sender.tab.id);
                if (bgRef) referrerUrl = bgRef;
              }
              // Skip self-referential
              if (referrerUrl) {
                const refSlug = generateSlugFromUrl(referrerUrl);
                const selfSlug = generateSlugFromUrl(url);
                if (refSlug === selfSlug) referrerUrl = null;
              }

              const title = request.title ? await trimTitle(request.title, url) : '';
              const entry = buildVisitPageEntry(url, title, referrerUrl);
              await addLog(entry);

              // First-visit extras: workspace
              const slug = request.slug || generateSlugFromUrl(url);

              const wsListIds = rpWorkspace?.listIds || [];
              if (rpWorkspace && rpWorkspace.mode === 'workspace' && wsListIds.length > 0) {
                try {
                  for (const listKey of wsListIds) {
                    const listSlug = listKey.startsWith('list:') ? listKey.slice(5) : listKey;
                    const listEntry = await readCacheable('list:' + listSlug);
                    const listPins = listEntry?.pins || [];
                    const pageKey = 'page:' + generateSlugFromUrl(url);
                    const already = listPins.some(p => p.id === pageKey);
                    if (!already) {
                      const pn = await getListParentsAndName(listSlug);
                      if (pn) {
                        const pinEntry = {
                          timestamp: Date.now(),
                          action: 'pin_to_list',
                          parents: pn.parents, name: pn.name,
                          items: [url]
                        };
                        if (title) pinEntry.titles = { [url]: title };
                        await addLog(pinEntry);
                        console.log(`Workspace: auto-pinned ${url} to ${pn.name}`);
                      }
                    }
                  }

                  if (rpWorkspace.autoSnapshot && sender.tab) {
                    captureAndLog(sender.tab.id, slug, entry.timestamp, url, title).catch(err => {
                      console.warn('[auto-snapshot] ERROR:', err.message, err);
                    });
                  }
                } catch (err) {
                  console.warn('Workspace: auto-pin/snapshot error:', err.message);
                }
              }

              notifyMutation('interaction', { url });
            } else if (request.isLeaving) {
              // leave_page: attention data + latest title
              const title = request.title ? await trimTitle(request.title, url) : null;
              const entry = buildLeavePageEntry(url, title, request.scrollDepth, request.timeOnPage);
              await addLog(entry);
              drainNow();
            } else if (request.user_title !== undefined) {
              // rename_page: user-initiated title change from popup
              await addLog({
                timestamp: Date.now(),
                action: 'rename_page',
                url,
                user_title: request.user_title
              });
            }

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

        case 'loadPageNotes': {
          const t0 = performance.now();
          // Read page entity from session cache (childIds already up-to-date — del_note removes refs)
          const page = await readCacheable('page:' + request.slug);
          const noteRefs = (page?.childIds || []).filter(c => c.startsWith('note:'));
          const notes = [];
          for (const ref of noteRefs) {
            const note = await readCacheable(ref);
            if (note) notes.push(note);
          }
          console.debug(`[I/O] loadPageNotes(${request.slug}): ${notes.length} notes in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, notes });
          break;
        }

        case 'loadInteractionByUrl': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadInteractionByUrl', url: request.url });
          console.debug(`[I/O] loadInteractionByUrl: ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse(resp);
          break;
        }

        case 'readCacheable': {
          try {
            const value = await readCacheable(request.key, request.includeDeleted);
            sendResponse({ success: true, value });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'listSnapshots': {
          const t0 = performance.now();
          const slug = request.slug;
          const page = await readCacheable('page:' + slug);
          const snapRefs = (page?.childIds || []).filter(c => c.startsWith('snapshot:'));
          const snapshots = snapRefs.map(ref => {
            const ts = parseInt(ref.slice(ref.lastIndexOf('-') + 1), 10);
            return { timestamp: ts, hasMd: true, hasHtml: true };
          }).sort((a, b) => b.timestamp - a.timestamp);
          console.debug(`[I/O] listSnapshots(${slug}): ${snapshots.length} from entity in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, snapshots });
          break;
        }

        case 'getSnapshotUrl': {
          const resp = await requestOffscreen({ action: 'getSnapshotUrl', slug: request.slug, timestamp: request.timestamp });
          sendResponse(resp);
          break;
        }

        case 'getSnapshotHtml': {
          const resp = await requestOffscreen({ action: 'getSnapshotHtml', slug: request.slug, timestamp: request.timestamp });
          sendResponse(resp);
          break;
        }

        case 'openSnapshot': {
          const viewerUrl = chrome.runtime.getURL(
            `snapshot-viewer.html?slug=${encodeURIComponent(request.slug)}&ts=${request.timestamp}`
          );
          const tab = await chrome.tabs.create({ url: viewerUrl });
          sendResponse({ success: true, tabId: tab.id });
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
            const page = await readCacheable('page:' + slug) || {};

            // Resolve typed refs: page:<slug> → URL
            async function resolveRefs(refs) {
              const urls = [];
              for (const ref of refs) {
                if (ref.startsWith('page:')) {
                  const p = await readCacheable(ref);
                  if (p && p.url) urls.push(p.url);
                }
              }
              return urls;
            }

            // Parents: referrer pages from parentIds (filter for page: refs)
            const pageParentRefs = (page.parentIds || []).filter(p => p.startsWith('page:'));
            const parentReferrers = await resolveRefs(pageParentRefs);

            // Parents: lists containing this page
            const parentLists = [];
            const listParentRefs = (page.parentIds || []).filter(p => p.startsWith('list:') && !p.startsWith('list:system/'));
            for (const listKey of listParentRefs) {
              const listEntity = await readCacheable(listKey);
              if (listEntity) {
                const listSlug = listKey.startsWith('list:') ? listKey.slice(5) : listKey;
                parentLists.push({ slug: listSlug, name: listEntity.name, type: 'pin' });
              }
            }

            // Children: from page.childIds (filter out notes and snaps, keep only pages)
            const childRefs = (page.childIds || []).filter(c => c.startsWith('page:'));
            const children = await resolveRefs(childRefs);

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

        case 'contextMenuHighlight': {
          try {
            const tabs = await chrome.tabs.query({ url: request.url });
            const tabId = tabs?.[0]?.id || null;
            const result = await handleContextMenuHighlight(
              request.url, request.title, request.selectionText, tabId
            );
            sendResponse(result);
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'saveSettingsKey': {
          const settings = await readCacheable('manifest:settings');
          if (!settings || JSON.stringify(settings[request.key]) !== JSON.stringify(request.value)) {
            await addLog({ timestamp: Date.now(), action: 'update_setting', key: request.key, value: request.value });
            notifyMutation('settings', { key: request.key });
          }
          sendResponse({ success: true });
          break;
        }

        case 'createNote': {
          const pageSlug = request.pageSlug;
          const timestamp = Date.now();
          const noteSlug = generateNoteSlug(timestamp, request.excerpt);

          // Resolve page URL: entity → explicit request.url → sender tab
          const cnPageEntity = await readCacheable('page:' + pageSlug);
          const pageUrl = cnPageEntity?.url || request.url || sender?.tab?.url;
          if (!pageUrl) {
            sendResponse({ success: false, error: 'Cannot determine page URL for note' });
            break;
          }

          // 1. Write note content to filesystem first (not inlined in log)
          await requestOffscreen({
            action: 'saveNote',
            slug: noteSlug,
            data: {
              slug: noteSlug,
              excerpt: request.excerpt,
              note: request.note || '',
              cssPath: request.cssPath || null,
              url: pageUrl,
              timestamp
            }
          });

          // 2. Log create_note — effectOf ensures page entity exists
          const cnNoteEntry = {
            timestamp,
            action: 'create_note',
            url: pageUrl,
            path: `notes/${noteSlug}.json`
          };
          const cnTitle = cnPageEntity?.title || sender?.tab?.title;
          if (cnTitle) cnNoteEntry.title = cnTitle;
          await addLog(cnNoteEntry);

          const notes = await requestOffscreen({ action: 'loadPageNotes', slug: pageSlug });
          sendResponse({ success: true, notes: notes.notes || [], noteSlug });
          notifyMutation('note', { pageSlug, noteSlug });
          break;
        }

        case 'deleteNote': {
          const noteSlug = request.noteSlug;

          // Load note to get parent page URL
          const noteEntity = await readCacheable('note:' + noteSlug, true);
          const dnPageUrl = noteEntity?.url || null;

          const dnEntry = { timestamp: Date.now(), action: 'delete_note', path: `notes/${noteSlug}.json` };
          if (dnPageUrl) dnEntry.url = dnPageUrl;
          await addLog(dnEntry);

          sendResponse({ success: true });
          notifyMutation('note', { noteSlug });
          break;
        }

        case 'updateNote': {
          const oldNoteSlug = request.noteSlug;
          const unTimestamp = Date.now();

          // Load current note to get content and url
          const unCurrentNote = await requestOffscreen({ action: 'loadNote', noteSlug: oldNoteSlug });
          const oldNoteData = unCurrentNote.note || {};

          // Generate new slug for the replacement note
          const newNoteSlug = generateNoteSlug(unTimestamp, oldNoteData.excerpt || '');

          // Build new note data, copying immutable fields from old
          const oldNoteEntity = await readCacheable('note:' + oldNoteSlug, true);
          const unNoteUrl = oldNoteEntity?.url || oldNoteData.url || null;
          const newNoteData = {
            slug: newNoteSlug,
            excerpt: oldNoteData.excerpt || null,
            note: request.note,
            cssPath: oldNoteData.cssPath || null,
            url: unNoteUrl,
            timestamp: unTimestamp,
          };

          // Save new note file to filesystem
          await requestOffscreen({ action: 'saveNote', slug: newNoteSlug, data: newNoteData });

          // Log replace_note event
          const replaceEntry = {
            timestamp: unTimestamp,
            action: 'replace_note',
            path: `notes/${newNoteSlug}.json`,
            oldPath: `notes/${oldNoteSlug}.json`,
          };
          if (unNoteUrl) replaceEntry.url = unNoteUrl;
          await addLog(replaceEntry);

          sendResponse({ success: true, noteSlug: newNoteSlug });
          notifyMutation('note', { noteSlug: newNoteSlug, oldNoteSlug });
          break;
        }

        case 'toggleListPin': {
          try {
            const { listId, url, id: requestId } = request;
            const pn = await getListParentsAndName(listId);
            if (!pn) { sendResponse({ success: false, error: 'List not found' }); break; }

            // Determine the item to pin/unpin: notes use path format, pages use URL
            let pinItem;
            if (requestId?.startsWith('note:')) {
              const noteSlug = requestId.slice('note:'.length);
              pinItem = `notes/${noteSlug}.json`;
            } else {
              pinItem = url;
            }

            // Check if already pinned
            const list = await readCacheable('list:' + listId);
            const pins = list?.pins || [];
            let pinKey;
            if (requestId?.startsWith('note:')) {
              pinKey = requestId;
            } else {
              pinKey = 'page:' + generateSlugFromUrl(pinItem);
            }
            const isPinned = pins.some(p => p.id === pinKey);

            const pinLogEntry = {
              timestamp: Date.now(),
              action: isPinned ? 'unpin_from_list' : 'pin_to_list',
              parents: pn.parents, name: pn.name,
              items: [pinItem]
            };
            // Attach title for new page pins so ensurePageEntity gets it
            if (!isPinned && !requestId?.startsWith('note:')) {
              const pageEntity = await readCacheable(pinKey);
              if (pageEntity?.title) pinLogEntry.titles = { [pinItem]: pageEntity.title };
            }
            await addLog(pinLogEntry);
            sendResponse({ success: true, pinned: !isPinned });
            notifyMutation('pins', { listId });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'addListPins': {
          const pn = await getListParentsAndName(request.listId);
          if (pn && request.urls.length > 0) {
            // Collect titles: from caller (request.titles) or page entities
            const titles = { ...(request.titles || {}) };
            for (const u of request.urls) {
              if (!titles[u]) {
                const slug = generateSlugFromUrl(u);
                const pe = await readCacheable('page:' + slug);
                if (pe?.title) titles[u] = pe.title;
              }
            }
            const pinEntry = {
              timestamp: Date.now(),
              action: 'pin_to_list',
              parents: pn.parents, name: pn.name,
              items: request.urls
            };
            if (Object.keys(titles).length > 0) pinEntry.titles = titles;
            await addLog(pinEntry);
          }
          sendResponse({ success: true });
          notifyMutation('pins', { listId: request.listId });
          break;
        }


        case 'saveListMeta': {
          const cached = request.listId ? await readCacheable('list:' + request.listId) : null;
          const pn = request.listId ? await getListParentsAndName(request.listId) : null;

          if (!cached) {
            // New list: create_list event
            // Derive parents from request.parentPath: 'root' → [], 'root/Foo' → ['root', 'Foo']
            let parents = [];
            if (request.parentPath && request.parentPath !== 'root') {
              parents = request.parentPath.split('/');
            }
            if (request.name) {
              await addLog({
                timestamp: Date.now(),
                action: 'create_list',
                name: request.name,
                parents,
              });
              // Look up the generated listId from name-to-id map
              const fullPath = parents.length === 0 ? `root/${request.name}` : `${parents.join('/')}/${request.name}`;
              const nameToId = await readCacheable('manifest:name-to-id');
              const generatedId = nameToId?.paths?.[fullPath];
              sendResponse({ success: true, listId: generatedId });
              notifyMutation('lists');
              break;
            }
          } else if (pn) {
            // Existing list: update_list event
            const entry = { timestamp: Date.now(), action: 'update_list', parents: pn.parents, name: pn.name };
            let hasChange = false;
            if (request.name !== undefined && cached.name !== request.name) {
              entry.newName = request.name;
              hasChange = true;
            }
            if (hasChange) {
              await addLog(entry);
              notifyMutation('lists');
            }
          }
          sendResponse({ success: true });
          break;
        }

        case 'deleteList': {
          const pnDel = await getListParentsAndName(request.listId);
          if (!pnDel) {
            sendResponse({ success: false, error: 'List not found in name-to-id' });
            break;
          }
          // Just parents+name — effectOf derives cascade from entity state
          await addLog({ timestamp: Date.now(), action: 'delete_list', parents: pnDel.parents, name: pnDel.name });
          sendResponse({ success: true });
          notifyMutation('lists');
          break;
        }

        case 'reparentList': {
          // request: { listId, fromParent, toParent, index }
          const pnRep = await getListParentsAndName(request.listId);
          let toParents;
          if (request.toParent === 'system/root') {
            toParents = [];
          } else {
            const toPn = await getListParentsAndName(request.toParent);
            if (!toPn) { sendResponse({ success: false, error: 'Target parent not found in name-to-id' }); break; }
            toParents = [...toPn.parents, toPn.name];
          }
          if (!pnRep) {
            sendResponse({ success: false, error: 'List not found in name-to-id' });
            break;
          }

          // Build childNames: full ordered child list of destination parent after move
          const toParentKey = 'list:' + request.toParent;
          const toParentEntity = await readCacheable(toParentKey);
          const existingChildren = [...(toParentEntity?.childLists || [])].filter(k => k !== 'list:' + request.listId);
          existingChildren.splice(request.index, 0, 'list:' + request.listId);
          const childNames = [];
          for (const ck of existingChildren) {
            const ce = await readCacheable(ck);
            if (ce?.name) childNames.push(ce.name);
          }

          await addLog({
            timestamp: Date.now(),
            action: 'reparent_list',
            parents: pnRep.parents, name: pnRep.name,
            toParents,
            childNames,
          });
          sendResponse({ success: true });
          notifyMutation('lists');
          break;
        }

        case 'restoreNote': {
          const noteSlug = request.noteSlug;
          // Get parent URL from orphaned entries or note entity
          const orphanedForRestore = await readCacheable('manifest:orphaned');
          const noteOrphanEntry = (orphanedForRestore?.entries || []).find(e => e.key === 'note:' + noteSlug);
          const rnNoteData = await readCacheable('note:' + noteSlug, true);
          const rnPageUrl = noteOrphanEntry?.url || rnNoteData?.url || null;
          const rnEntry = { timestamp: Date.now(), action: 'restore_note', path: `notes/${noteSlug}.json` };
          if (rnPageUrl) rnEntry.url = rnPageUrl;
          await addLog(rnEntry);
          sendResponse({ success: true });
          notifyMutation('orphaned');
          notifyMutation('note', { noteSlug });
          break;
        }

        case 'restoreSnapshot': {
          const snapStem = request.snapSlug; // e.g. 'page-slug-1234567890'
          // Get parent URL from orphaned entries or page entity
          const rsOrphaned = await readCacheable('manifest:orphaned');
          const snapOrphanEntry = (rsOrphaned?.entries || []).find(e => e.key === 'snapshot:' + snapStem);
          let rsPageUrl = snapOrphanEntry?.url || null;
          if (!rsPageUrl) {
            // Fallback: parse snapshot stem to derive page slug
            const lastDash = snapStem.lastIndexOf('-');
            const pageSlug = snapStem.slice(0, lastDash);
            const page = await readCacheable('page:' + pageSlug);
            rsPageUrl = page?.url || null;
          }
          if (!rsPageUrl) {
            sendResponse({ success: false, error: 'Cannot determine page URL for snapshot' });
            break;
          }
          await addLog({
            timestamp: Date.now(),
            action: 'restore_snapshot',
            url: rsPageUrl,
            path: `snapshots/${snapStem}`,
          });
          sendResponse({ success: true });
          notifyMutation('orphaned');
          notifyMutation('snapshot', { slug: pageSlug });
          break;
        }

        case 'restoreList': {
          const listId = request.listId;
          const entity = await readCacheable('list:' + listId, true);
          const name = entity?.name || listId;
          await addLog({
            timestamp: Date.now(),
            action: 'restore_list',
            parents: [], name,
          });
          sendResponse({ success: true });
          notifyMutation('orphaned');
          notifyMutation('lists');
          break;
        }

        case 'permanentDelete': {
          const key = request.key;
          // 1. Drain all pending log entries first
          await ensureOffscreenPort();
          await drainNow();
          await requestOffscreen({ action: 'flushLogBuffer', entries: logBuffer });
          await new Promise(r => setTimeout(r, 100));
          // 2. Delete the file via offscreen
          if (key.startsWith('note:')) {
            const slug = key.slice('note:'.length);
            await requestOffscreen({ action: 'deleteNote', noteSlug: slug });
          } else if (key.startsWith('list:')) {
            const id = key.slice('list:'.length);
            await requestOffscreen({ action: 'deleteListFile', listId: id });
          } else if (key.startsWith('snapshot:')) {
            // snapshot:<pageSlug>-<timestamp> — physically delete snapshot files
            const snapStem = key.slice('snapshot:'.length);
            const lastDash = snapStem.lastIndexOf('-');
            const pageSlug = snapStem.slice(0, lastDash);
            const timestamp = parseInt(snapStem.slice(lastDash + 1), 10);
            await requestOffscreen({ action: 'deleteSnapshot', slug: pageSlug, timestamp });
          }
          // 3. Update orphaned list: remove the key
          const orphaned = await readCacheable('manifest:orphaned') || { timestamp: 0, entries: [] };
          const updatedOrphaned = {
            ...orphaned,
            timestamp: Date.now(),
            entries: (orphaned.entries || []).filter(e => e.key !== key),
          };
          await requestOffscreen({ action: 'saveJson', path: 'manifest/orphaned.json', data: updatedOrphaned });
          await cacheSet('manifest:orphaned', updatedOrphaned);
          // 4. Clear session cache for the deleted entity
          await cacheRemove(key);
          sendResponse({ success: true });
          notifyMutation('orphaned');
          break;
        }

        case 'permanentDeleteAll': {
          // 1. Drain all pending log entries first
          await ensureOffscreenPort();
          await drainNow();
          await requestOffscreen({ action: 'flushLogBuffer', entries: logBuffer });
          await new Promise(r => setTimeout(r, 100));
          // 2. Load orphaned list
          const orphaned = await readCacheable('manifest:orphaned') || { timestamp: 0, entries: [] };
          // 3. Delete each file
          for (const { key } of (orphaned.entries || [])) {
            if (key.startsWith('note:')) {
              const slug = key.slice('note:'.length);
              await requestOffscreen({ action: 'deleteNote', noteSlug: slug });
            } else if (key.startsWith('list:')) {
              const id = key.slice('list:'.length);
              await requestOffscreen({ action: 'deleteListFile', listId: id });
            } else if (key.startsWith('snapshot:')) {
              const snapStem = key.slice('snapshot:'.length);
              const lastDash = snapStem.lastIndexOf('-');
              const pageSlug = snapStem.slice(0, lastDash);
              const timestamp = parseInt(snapStem.slice(lastDash + 1), 10);
              await requestOffscreen({ action: 'deleteSnapshot', slug: pageSlug, timestamp });
            }
            await cacheRemove(key);
          }
          // 4. Save empty orphaned list
          const emptyOrphaned = { timestamp: Date.now(), entries: [] };
          await requestOffscreen({ action: 'saveJson', path: 'manifest/orphaned.json', data: emptyOrphaned });
          await cacheSet('manifest:orphaned', emptyOrphaned);
          sendResponse({ success: true });
          notifyMutation('orphaned');
          break;
        }

        // ── Pass-through (complex FS ops) ──

        case 'initializeFilesystem': {
          const resp = await requestOffscreen({ action: 'initializeFilesystem' });
          sendResponse(resp);
          break;
        }

        case 'deleteSnapshot': {
          const slug = request.slug;
          const snapTimestamp = request.timestamp;
          const page = await readCacheable('page:' + slug);
          if (!page?.url) {
            sendResponse({ success: false, error: 'Page entity not found for snapshot' });
            break;
          }
          await addLog({
            timestamp: Date.now(),
            action: 'delete_snapshot',
            url: page.url,
            path: `snapshots/${slug}-${snapTimestamp}`,
          });
          sendResponse({ success: true });
          notifyMutation('snapshot', { slug });
          notifyMutation('orphaned');
          break;
        }

        case 'setTestDirectory': {
          const resp = await requestOffscreen({ action: 'setTestDirectory' });
          if (resp?.success) {
            // Re-hydrate from the fresh OPFS directory
            hydrationDone = hydrateCache();
            await hydrationDone;
            await ensureDefaultLists();
          }
          sendResponse(resp);
          break;
        }

        case 'resetForTest': {
          // 1. Clear logBuffer
          logBuffer = [];
          await chrome.storage.local.set({ logBuffer });
          // 2. Clear entity cache (session storage + in-memory LRU)
          await cacheClear();
          // 3. Reset ALL in-memory state (SW survives across tests)
          recentUrls = new Map();
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          // 4. Tell offscreen to wipe directory and reset drain state
          await requestOffscreen({ action: 'resetDirectory' });
          // 5. Re-hydrate from (now empty) filesystem
          hydrationDone = hydrateCache();
          await hydrationDone;
          await ensureDefaultLists();
          sendResponse({ success: true });
          break;
        }

        case 'rehydrateForTest': {
          // Clear caches and re-hydrate without wiping the directory.
          // Used after seedTestData to pick up seeded files.
          logBuffer = [];
          await chrome.storage.local.set({ logBuffer });
          await cacheClear();
          recentUrls = new Map();
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          hydrationDone = hydrateCache();
          await hydrationDone;
          await ensureDefaultLists();
          sendResponse({ success: true });
          break;
        }

        case 'seedTestData': {
          const resp = await requestOffscreen({ action: 'seedTestData', files: request.files });
          sendResponse(resp);
          break;
        }

        // ─── Rule Handlers ───────────────────────────────────────────

        case 'addRule': {
          const { listId, rule } = request;
          const listInfo = await getListParentsAndName(listId);
          if (!listInfo) { sendResponse({ success: false, error: 'List not found' }); break; }

          // Validate
          const validation = validateRuleConfig(rule);
          if (!validation.valid) {
            sendResponse({ success: false, error: validation.errors.join('; ') });
            break;
          }

          // For smart rules: validate function source
          if (rule.type === 'smart') {
            const fnValidation = validateSmartRuleFn(rule.config.fnSource);
            if (!fnValidation.valid) {
              sendResponse({ success: false, error: fnValidation.errors.join('; ') });
              break;
            }
          }

          await addLog({
            timestamp: Date.now(),
            action: 'add_rule',
            parents: listInfo.parents,
            name: listInfo.name,
            rule: { type: rule.type, config: rule.config },
          });
          sendResponse({ success: true });
          notifyMutation('rules', { listId });
          break;
        }

        case 'removeRule': {
          const { listId, ruleId } = request;
          const listInfo = await getListParentsAndName(listId);
          if (!listInfo) { sendResponse({ success: false, error: 'List not found' }); break; }

          await addLog({
            timestamp: Date.now(),
            action: 'remove_rule',
            parents: listInfo.parents,
            name: listInfo.name,
            ruleId,
          });
          sendResponse({ success: true });
          notifyMutation('rules', { listId });
          break;
        }

        case 'updateRule': {
          const { listId, ruleId, config } = request;
          const listInfo = await getListParentsAndName(listId);
          if (!listInfo) { sendResponse({ success: false, error: 'List not found' }); break; }

          await addLog({
            timestamp: Date.now(),
            action: 'update_rule',
            parents: listInfo.parents,
            name: listInfo.name,
            ruleId,
            config,
          });
          sendResponse({ success: true });
          notifyMutation('rules', { listId });
          break;
        }

        case 'runRuleBatch': {
          const { listIds: batchListIds, entries } = request;
          const results = [];

          for (const listId of batchListIds) {
            const listEntity = await readCacheable(`list:${listId}`);
            if (!listEntity?.rules?.length) continue;

            // Build sandbox closure that routes to offscreen
            const sandbox = async (fnSource, pageData) => {
              const resp = await requestOffscreen({ action: 'executeSandboxFn', fnSource, pageData });
              if (!resp?.success) throw new Error('Sandbox execution failed');
              return resp.score;
            };

            for (const entry of entries) {
              const pageData = buildPageDataFromEntry(entry);
              const matches = await matchRules(listEntity.rules, pageData, { sandbox });
              if (matches.length > 0) {
                // Auto-pin: use the same parents/name path as the list
                const listInfo = await getListParentsAndName(listId);
                if (listInfo) {
                  // Check if already pinned
                  const slug = generateSlugFromUrl(entry.url);
                  const alreadyPinned = (listEntity.pins || []).some(p => p.id === `page:${slug}`);
                  if (!alreadyPinned) {
                    const sfPinEntry = {
                      timestamp: Date.now(),
                      action: 'pin_to_list',
                      parents: listInfo.parents,
                      name: listInfo.name,
                      items: [entry.url],
                    };
                    if (entry.title) sfPinEntry.titles = { [entry.url]: entry.title };
                    await addLog(sfPinEntry);
                    results.push({ listId, url: entry.url, matches });
                  }
                }
              }
            }
          }

          sendResponse({ success: true, results });
          break;
        }

        case 'previewRule': {
          const { rule, entries } = request;
          // Validate
          const validation = validateRuleConfig(rule);
          if (!validation.valid) {
            sendResponse({ success: false, error: validation.errors.join('; ') });
            break;
          }
          if (rule.type === 'smart') {
            const fnValidation = validateSmartRuleFn(rule.config.fnSource);
            if (!fnValidation.valid) {
              sendResponse({ success: false, error: fnValidation.errors.join('; ') });
              break;
            }
          }
          const tempRule = { id: 'preview', type: rule.type, config: rule.config };

          const sandbox = async (fnSource, pageData) => {
            const resp = await requestOffscreen({ action: 'executeSandboxFn', fnSource, pageData });
            if (!resp?.success) throw new Error(resp?.error || 'Sandbox execution failed');
            return resp.score;
          };
          const results = [];
          let execError = null;
          for (const entry of entries) {
            const title = entry.title || '';
            const pageData = buildPageDataFromEntry({ ...entry, title });
            try {
              const scored = await matchRules([tempRule], pageData, { sandbox, allScores: true });
              const { score = 0, match = false } = scored[0] || {};
              results.push({ url: entry.url, title, score, match });
            } catch (err) {
              execError = err.message; break;
            }
          }
          if (execError) {
            sendResponse({ success: false, error: execError });
          } else {
            sendResponse({ success: true, results });
          }
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
