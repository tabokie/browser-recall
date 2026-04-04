// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl, generateNoteSlug, dateKeyFromTimestamp } from './utils.js';
import { effectOf } from './replay.js';
import { validateRuleConfig, validateSmartRuleFn, matchRules, matchKeywordRule, buildPageDataFromEntry } from './rule-engine.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { cacheGet, cacheSet, cacheRemove, cachePin, cacheUnpin, setEntityCacheWatermark, cacheClear, setQuotaExhaustedCallback } from './entity-cache.js';
import { GitHubTransport, parseRepoUrl } from './sync-transport-github.js';
import { FilesystemTransport } from './sync-transport-filesystem.js';
import { WebDAVTransport } from './sync-transport-webdav.js';
import { SyncManager } from './sync-manager.js';
import { logDebug, logError } from './logger.js';

logDebug('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — data is safe in chrome.storage.local until drained
const HISTORY_RECENT_DAYS = 7; // days of past history to cache for multi-day checks
const LOG_BUFFER_MAX_SIZE = 2000; // max entries before forced eviction

// In-memory Map of URL → visitDates (YYYYMMDD[]) from history:recent (past days).
// Populated during hydration, immutable until next browser restart.
let recentUrls = new Map();

// tabId → URL from the content script's initial reportPage.
// Used by popup to avoid slug mismatch when tab.url drifts (SPA pushState, etc.).
const tabReportedUrls = new Map();

// Device name for this instance — always set (generated on first run, stored in settings).
// Use getDeviceId() instead of reading directly — it lazy-loads from CURRENT file on cache miss.
let localDeviceId = null;

// Service error state: null = healthy, { code, message, timestamp } = paused.
// Error codes: 'session_quota', 'local_quota', 'offscreen_crash', 'fs_permission'.
let serviceError = null;

// Lazy getter: returns localDeviceId, loading from CURRENT file if null.
// Handles both startup race (message before hydrateCache) and SW wakeup (no hydrateCache).
async function getDeviceId() {
  if (localDeviceId) return localDeviceId;
  const resp = await requestOffscreen({ action: 'loadCurrent' });
  if (resp?.success && resp.deviceId) {
    localDeviceId = resp.deviceId;
  }
  return localDeviceId;
}

// ─── Service Downtime State ───────────────────────────────────────────

function pauseService(code, message) {
  serviceError = { code, message, timestamp: Date.now() };
  chrome.action.setIcon({ path: { 16: 'icons/icon16-down.png', 48: 'icons/icon48-down.png', 128: 'icons/icon128-down.png' } });
  chrome.storage.session.set({ serviceError }).catch(() => {});
  logError(`Service paused: [${code}] ${message}`);
}

function resumeService() {
  serviceError = null;
  chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
  chrome.storage.session.remove(['serviceError']).catch(() => {});
  logDebug('Service resumed');
}

function isServicePaused() {
  return serviceError !== null;
}

// Register quota exhausted callback — bridges entity-cache to downtime infrastructure.
setQuotaExhaustedCallback(() => {
  pauseService('session_quota', 'Session storage full — all cached entities are dirty (unflushed). This usually means drain is stuck.');
});

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
      justification: 'Manage filesystem operations for browsing history'
    });
    logDebug('Offscreen document created');
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

// Crash-loop detection: 3 disconnects within 60s → pause service
const offscreenDisconnects = [];
const CRASH_LOOP_THRESHOLD = 3;
const CRASH_LOOP_WINDOW_MS = 60_000;

function trackOffscreenDisconnect() {
  const now = Date.now();
  offscreenDisconnects.push(now);
  while (offscreenDisconnects.length && offscreenDisconnects[0] < now - CRASH_LOOP_WINDOW_MS) {
    offscreenDisconnects.shift();
  }
  if (offscreenDisconnects.length >= CRASH_LOOP_THRESHOLD) {
    pauseService('offscreen_crash', `Storage worker crashed ${CRASH_LOOP_THRESHOLD} times in ${CRASH_LOOP_WINDOW_MS / 1000}s`);
  }
}

function connectToOffscreen() {
  offscreenPort = chrome.runtime.connect({ name: 'bg-offscreen' });
  offscreenPort.onMessage.addListener(handleOffscreenResponse);
  offscreenPort.onDisconnect.addListener(() => {
    offscreenPort = null;
    logDebug('Offscreen port disconnected');
    // Resolve all pending callbacks with error — prevents leaked promises
    for (const [id, cb] of portCallbacks) {
      cb({ success: false, error: 'Offscreen port disconnected' });
    }
    portCallbacks.clear();
    trackOffscreenDisconnect();
  });
  // Kick drain for any entries buffered while offscreen was down
  scheduleDrainNotify();
}

async function handleOffscreenResponse(msg) {
  if (msg.action === 'persisted') {
    // Watermark from offscreen flush — prune entries at or before watermark timestamp
    await ensureLogBuffer();
    logBuffer = logBuffer.filter(e => e.timestamp > msg.watermark);
    logBufferWatermark = msg.watermark;
    await persistLogBuffer();
    setEntityCacheWatermark(msg.watermark);
    consecutiveDrainFailures = 0;
    if (isServicePaused() && serviceError?.code === 'fs_permission') {
      resumeService();
    }
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
const LOCK_TIMEOUT_MS = 30000;

function withLock(key, fn) {
  const prev = rwLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`withLock('${key}') timed out after ${LOCK_TIMEOUT_MS}ms`));
      }, LOCK_TIMEOUT_MS);
      fn().then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  });
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
// to data/logs/YYYY-MM-DD.jsonl and checkpoint entity files.
// Lazy-restored on first access so idle wake-ups don't lose unflushed entries.

let logBuffer = null; // null = not yet restored from storage.local
let logBufferWatermark = 0; // last drain watermark — entries ≤ this are safely on disk

async function ensureLogBuffer() {
  if (logBuffer !== null) return;
  const { logBuffer: stored = [] } = await chrome.storage.local.get(['logBuffer']);
  logBuffer = stored;
  if (logBuffer.length > 0) {
    logDebug(`Restored ${logBuffer.length} pending log entries from storage.local`);
  }
}

async function persistLogBuffer() {
  try {
    await chrome.storage.local.set({ logBuffer });
  } catch (e) {
    if (e.message?.includes('QUOTA_BYTES') || e.message?.includes('quota')) {
      pauseService('local_quota', `Local storage full — logBuffer has ${logBuffer.length} undrained entries. Drain may be stuck.`);
    }
    throw e;
  }
}

// ─── Drain Notify (background → offscreen via port) ─────────────────
// Offscreen documents don't receive chrome.storage.onChanged events
// (only chrome.runtime is available). Send entries via port instead.
let drainNotifyTimer = null;
let consecutiveDrainFailures = 0;
const DRAIN_FAILURE_THRESHOLD = 12; // 12 × 5s = 60s of stuck drain

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
      offscreenPort.postMessage({ action: 'drainEntries', entries: logBuffer, deviceId: await getDeviceId() });
      consecutiveDrainFailures++;
      if (consecutiveDrainFailures >= DRAIN_FAILURE_THRESHOLD) {
        pauseService('fs_permission', 'Storage drain has failed for 60+ seconds. File system permission may have been revoked.');
      }
    }
  } catch (e) {
    logDebug('drainNotify error:', e.message);
  }
}

// Low-level: append to logBuffer + persist, no cache update.
async function appendLog(entry) {
  await withLock('logBuffer', async () => {
    await ensureLogBuffer();
    logBuffer.push(entry);

    // Cap enforcement: prevent unbounded growth when drain is stalled
    if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
      const before = logBuffer.length;
      // First pass: drop entries already persisted to disk
      logBuffer = logBuffer.filter(e => e.timestamp > logBufferWatermark);
      if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
        // Still over limit — drop oldest (bounded data loss)
        logBuffer = logBuffer.slice(logBuffer.length - LOG_BUFFER_MAX_SIZE);
      }
      logDebug(`logBuffer capped: ${before} → ${logBuffer.length}`);
    }

    try {
      await persistLogBuffer();
    } catch (e) {
      // In-memory buffer still has the entry — it will be drained to disk by offscreen
    }
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
  if (isServicePaused()) {
    throw new Error(`Service paused [${serviceError.code}]`);
  }
  let effects;
  await withLock('logBuffer', async () => {
    await ensureLogBuffer();
    logBuffer.push(entry);
    await persistLogBuffer();
    effects = await effectOf(entry, sessionLoad, { deviceId: await getDeviceId() });
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
      logDebug(`[addLog] history cache miss for ${todayKey}, loading from disk`);
      const dateStr = dateKeyFromTimestamp(entry.timestamp);
      const resp = await requestOffscreen({ action: 'loadHistoryRange', from: dateStr, to: dateStr });
      assertOffscreenSuccess(resp, todayKey);
      today = resp.entries || [];
    }
    today.push(entry);
    cacheSet(todayKey, today, { timestamp: entry.timestamp });
    cachePin(todayKey);
  }).catch(e => logDebug('[addLog] history cache update failed:', e.message));
  ensureOffscreenPort().catch(e => logDebug('[addLog] offscreen port failed:', e.message));
  scheduleDrainNotify();
  // Refresh badge for all tabs whose page entity was affected.
  const affectedPageKeys = Object.keys(effects).filter(k => k.startsWith('page:'));
  if (affectedPageKeys.length > 0) {
    // Collect URLs for affected pages (from effects or entry)
    const urls = new Set();
    for (const key of affectedPageKeys) {
      const entity = effects[key];
      if (entity?.url) urls.add(entity.url);
      else if (entry.url) urls.add(entry.url);
    }
    // Update all tabs matching affected URLs, plus active tab as fallback
    if (urls.size > 0) {
      chrome.tabs.query({ url: [...urls] }).then(tabs => {
        for (const tab of tabs) updateBadgeForTab(tab.id, tab.url);
      }).catch(e => logDebug('[addLog] badge query failed:', e.message));
    }
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab) updateBadgeForTab(tab.id, tab.url);
    }).catch(e => logDebug('[addLog] badge update failed:', e.message));
  }
  return effects;
}

// Build a visit_page log entry. Title omitted when absent (slow-loading pages).
// checkpoint: true forces page entity creation (used by explicit user capture of blacklisted URLs).
function buildVisitPageEntry(url, title, referrerUrl, { checkpoint } = {}) {
  const entry = { timestamp: Date.now(), action: 'visit_page', url };
  if (title) entry.title = title;
  if (referrerUrl) entry.referrerUrl = referrerUrl;
  if (checkpoint) entry.checkpoint = true;
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

// Collect all list keys from the tree manifest.
async function getAllListKeys() {
  await hydrationDone;
  const order = await readCacheable('manifest:list-order');
  const result = [];
  function walk(nodes) {
    for (const node of nodes) {
      result.push(node.id);
      if (node.children) walk(node.children);
    }
  }
  walk(order?.tree || []);
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
    case 'manifest:list-order': {
      const r = await requestOffscreen({ action: 'loadListOrder' });
      assertOffscreenSuccess(r, key);
      value = r.entity || { timestamp: 0, tree: [] };
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
  // Load CURRENT file first — immutable device identity, must be available for Phase 2 replay.
  // Errors here are fatal (filesystem corruption or permission loss) — let them propagate.
  const currentResp = await requestOffscreen({ action: 'loadCurrent' });
  if (currentResp?.success && currentResp.deviceId) {
    localDeviceId = currentResp.deviceId;
  }

  try {
    const resp = await requestOffscreen({ action: 'loadSettings' });
    if (resp?.success && resp.settings) {
      await cacheSet('manifest:settings', resp.settings);
    }
  } catch (e) { logDebug('Settings load failed:', e.message); }

  try {
    const metaResp = await requestOffscreen({ action: 'loadAllListMetadata' });
    if (metaResp?.success && metaResp.lists) {
      for (const list of metaResp.lists) {
        await cacheSet('list:' + list.slug, list);
      }
    }
  } catch (e) { logDebug('List metadata load failed:', e.message); }

  try {
    const orderResp = await requestOffscreen({ action: 'loadListOrder' });
    if (orderResp?.success && orderResp.entity) await cacheSet('manifest:list-order', orderResp.entity);
  } catch (e) { logDebug('List order load failed:', e.message); }

  try {
    const nmResp = await requestOffscreen({ action: 'loadNameMap' });
    if (nmResp?.success && nmResp.entity) {
      await cacheSet('manifest:name-to-id', nmResp.entity);
    }
  } catch (e) { logDebug('Name-map load failed:', e.message); }

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
      // by looking at files older than our range from listHistoryFiles
      const allFilesResp = await requestOffscreen({ action: 'listHistoryFiles' });
      const allFiles = allFilesResp?.files || []; // Missing files listing is non-fatal
      for (const f of allFiles) {
        const d = f.replace('.jsonl', '');
        if (d < fromStr) {
          const oldKey = 'log:' + d;
          cacheUnpin(oldKey); // evictable if still in session
        }
      }
    }

    logDebug(`History cache: ${todayEntries.length} today, ${recentUrls.size} recent URLs`);
  } catch (e) { logDebug('History cache load failed:', e.message); }

  // Phase 1.6: Pre-load page entities referenced by logBuffer from filesystem
  await ensureLogBuffer();

  // Dedup logBuffer against today's history (entries already flushed to disk)
  {
    const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
    let todayForDedup = await cacheGet(todayKey);
    if (todayForDedup == null) {
      // Cache miss — load from disk. Should not happen after hydration.
      logDebug(`[dedup] history cache miss for ${todayKey}, loading from disk`);
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
        logDebug(`logBuffer dedup: ${before} → ${logBuffer.length} (${before - logBuffer.length} already flushed)`);
        await persistLogBuffer();
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
      } catch (e) { logDebug('Page pre-load failed:', e.message); }
    }
  }

  // Phase 2: Replay pending logBuffer entries via effectOf.
  // Uses sessionLoadDuringHydration (not sessionLoad) to avoid deadlock:
  // sessionLoad → readCacheable → await hydrationDone → waiting for us.
  for (const entry of logBuffer) {
    try {
      const effects = await effectOf(entry, sessionLoadDuringHydration, { deviceId: localDeviceId });
      await sessionWrite(effects);
    } catch (e) { logDebug('Hydration replay failed for entry:', e.message); }
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

  // Phase 3: Replay remote device log files (multi-device sync).
  // Remote logs are pulled by sync and written to data/logs/<remoteDevice>/.
  // Replay is idempotent (per-device timestamp guards) so re-replaying
  // already-checkpointed entries is a safe no-op.
  try {
    const settings = await cacheGet('manifest:settings');
    if (settings?.syncEnabled && localDeviceId) {
      const resp = await requestOffscreen({ action: 'loadRemoteLogEntries', localDeviceId });
      if (resp?.success && resp.remotes?.length > 0) {
        let totalEntries = 0;
        for (const { deviceId: peerId, entries } of resp.remotes) {
          for (const entry of entries) {
            try {
              const effects = await effectOf(entry, sessionLoadDuringHydration, { deviceId: peerId });
              await sessionWrite(effects);
            } catch (e) { /* skip individual entry errors */ }
          }
          totalEntries += entries.length;
        }
        logDebug(`Remote log replay: ${resp.remotes.length} peers, ${totalEntries} entries`);
      }
    }
  } catch (e) { logDebug('Remote log replay failed:', e.message); }

  logDebug('Cache hydrated');
}

// Generate device name on first run — writes CURRENT file and creates log directory.
// Must run AFTER hydrateCache completes (needs offscreen port).
async function ensureDeviceId() {
  if (localDeviceId) return;
  localDeviceId = crypto.randomUUID().slice(0, 8);
  await requestOffscreen({ action: 'initDevice', deviceId: localDeviceId });
}

// First-run default list creation — must run AFTER hydrateCache completes
// because addLog → sessionLoad → readCacheable → await hydrationDone.
async function ensureDefaultLists() {
  await ensureDeviceId();
  try {
    const metaRespCheck = await requestOffscreen({ action: 'loadAllListMetadata' });
    const userLists = (metaRespCheck?.lists || []).filter(l => !l.slug.startsWith('system/'));
    if (userLists.length === 0) {
      await addLog({
        timestamp: Date.now(),
        action: 'create_list',
        listOwner: 'system',
        listId: 'hubs',
        name: 'Hubs',
      });
      await addLog({
        timestamp: Date.now(),
        action: 'add_rule',
        listOwner: 'system',
        name: 'Hubs',
        rule: {
          type: 'smart',
          config: {
            description: 'Hub and landing pages',
            fnSource: [
              "const u = new URL(page.url);",
              "const p = u.pathname.toLowerCase();",
              "const skip = ['s', 'search', 'query', 'q', 'target'];",
              "if (skip.some(k => u.searchParams.has(k))) return false;",
              "if (p === '/' || p === '') return u.search.length <= 100;",
              "const parts = p.split('/').filter(Boolean);",
              "if (parts.length === 1 && p.endsWith('/')) return true;",
              "const last = parts[parts.length - 1] || '';",
              "const hub = ['blog', 'wiki', 'home', 'landing', 'explore', 'discover', 'index'];",
              "if (hub.some(k => last.includes(k))) return !u.hash;",
              "return false;",
            ].join('\n'),
          },
        },
      });
    }
  } catch (e) { logDebug('First-run default list creation failed:', e.message); }
}

// ─── Smart-Rule Auto-Pin on Visit ────────────────────────────────────
// Evaluate all lists with rules against a visited page and auto-pin matches.

async function evaluateSmartRulesForVisit(url, title) {
  const listKeys = await getAllListKeys();
  const pageData = buildPageDataFromEntry({ url, title });
  const sandbox = async (fnSource, pd) => {
    const resp = await requestOffscreen({ action: 'executeSandboxFn', fnSource, pageData: pd });
    if (!resp?.success) throw new Error('Sandbox execution failed');
    return resp.score;
  };
  const pageKey = 'page:' + generateSlugFromUrl(url);

  for (const listKey of listKeys) {
    const listId = listKey.startsWith('list:') ? listKey.slice(5) : listKey;
    const listEntity = await readCacheable('list:' + listId);
    if (!listEntity?.rules?.length) continue;

    const matches = await matchRules(listEntity.rules, pageData, { sandbox });
    if (matches.length === 0) continue;

    const alreadyPinned = (listEntity.pins || []).some(p => p.id === pageKey);
    if (alreadyPinned) continue;

    const listInfo = await getListEventFields(listId);
    if (!listInfo) continue;

    const pinEntry = {
      timestamp: Date.now(),
      action: 'pin_to_list',
      name: listInfo.name,
      listOwner: listInfo.listOwner,
      items: [url],
      source: 'auto',
    };
    if (title) pinEntry.titles = { [url]: title };
    await addLog(pinEntry);
    logDebug(`Smart-rule: auto-pinned ${url} to ${listInfo.name}`);
  }
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle;
  const titleTrimRules = (await readCacheable('manifest:settings') || {}).titleTrimRules || [];
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

// ─── Badge indicator ─────────────────────────────────────────────────
// Show a colored dot on the extension icon when the current page has data.
// Blue = notes/snapshots, Green = in lists, Purple = both.

async function updateBadgeForTab(tabId, url) {
  try {
    if (!url || !url.startsWith('http')) {
      chrome.action.setBadgeText({ text: '', tabId });
      return;
    }
    const slug = generateSlugFromUrl(url);
    const page = await readCacheable('page:' + slug);
    if (!page) {
      chrome.action.setBadgeText({ text: '', tabId });
      return;
    }
    const hasNotes = page.childIds?.some(c => c.startsWith('note:') || c.startsWith('snapshot:'));
    const hasLists = page.parentIds?.some(id => id.startsWith('list:'));
    if (!hasNotes && !hasLists) {
      chrome.action.setBadgeText({ text: '', tabId });
      return;
    }
    const color = hasNotes && hasLists ? '#9C27B0' : hasNotes ? '#4A90D9' : '#4CAF50';
    chrome.action.setBadgeBackgroundColor({ color, tabId });
    chrome.action.setBadgeText({ text: ' ', tabId });
  } catch (e) {
    // Non-critical — don't break navigation for a badge update failure.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadgeForTab(tabId, tab.url);
  } catch (e) { /* tab may have been closed */ }
});

// ─── Supplementary referrer detection ─────────────────────────────────
// Sites that suppress document.referrer via Referrer-Policy or rel="noreferrer"
// leave an empty string in content script. webNavigation sees the real navigation.
const getReferrer = (() => {
  const tabUrls = new Map();
  // Stores the resolved referrer (or null) once onCommitted fires.
  const committed = new Map();
  // Pending getReferrer() calls waiting for onCommitted to fire.
  const waiters = new Map();

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const previousUrl = tabUrls.get(details.tabId);
    const referrer = (details.transitionType === 'link' && previousUrl) ? previousUrl : null;
    tabUrls.set(details.tabId, details.url);
    committed.set(details.tabId, referrer);
    updateBadgeForTab(details.tabId, details.url);
    // Wake up any pending getReferrer() call
    const waiter = waiters.get(details.tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(details.tabId);
      waiter.resolve(referrer);
    }
  });

  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const sourceUrl = tabUrls.get(details.sourceTabId);
    if (sourceUrl) committed.set(details.tabId, sourceUrl);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId);
    committed.delete(tabId);
    const waiter = waiters.get(tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(tabId);
      waiter.resolve(null);
    }
  });

  // Async: returns the referrer URL or null. If onCommitted hasn't fired yet
  // (race with content script), waits up to 200ms for it.
  return async (tabId) => {
    const ref = committed.get(tabId);
    if (ref !== undefined) {
      committed.delete(tabId);
      return ref;
    }
    // onCommitted hasn't fired yet — wait briefly
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        waiters.delete(tabId);
        resolve(null);
      }, 200);
      waiters.set(tabId, { resolve, timer });
    });
  };
})();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabReportedUrls.delete(tabId);
});

// ─── Sync ────────────────────────────────────────────────────────────

const SYNC_ALARM_NAME = 'portal-sync';
const SYNC_RATE_LIMIT_ALARM = 'portal-sync-rate-limit';
const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000; // 15 minutes
const SYNC_SESSION_TOKEN_KEY = '__syncToken';
const SYNC_DEVICES_KEY = '__syncRemoteDevices';
let syncInProgress = false;
let lastSyncResult = null; // { timestamp, pushed, pulled, error?, rateLimitedUntil? }
let rateLimitedUntil = 0; // epoch ms; 0 = not rate-limited

// Read the sync token from chrome.storage.session (never hits disk directly).
async function getSyncSessionToken() {
  try {
    const data = await chrome.storage.session.get([SYNC_SESSION_TOKEN_KEY]);
    return data[SYNC_SESSION_TOKEN_KEY] || null;
  } catch { return null; }
}

// Store the sync token in chrome.storage.session.
async function setSyncSessionToken(token) {
  if (token) {
    await chrome.storage.session.set({ [SYNC_SESSION_TOKEN_KEY]: token });
  } else {
    await chrome.storage.session.remove([SYNC_SESSION_TOKEN_KEY]);
  }
}

// Read the sync device list from chrome.storage.session.
async function _loadSyncDevices() {
  try {
    const data = await chrome.storage.session.get([SYNC_DEVICES_KEY]);
    return data[SYNC_DEVICES_KEY] || [];
  } catch { return []; }
}

// Paused devices — persisted in chrome.storage.local.
const PAUSED_DEVICES_KEY = 'syncPausedDevices';
async function _loadPausedDevices() {
  try {
    const data = await chrome.storage.local.get([PAUSED_DEVICES_KEY]);
    return data[PAUSED_DEVICES_KEY] || {};
  } catch { return {}; }
}
async function _savePausedDevices(paused) {
  await chrome.storage.local.set({ [PAUSED_DEVICES_KEY]: paused });
}

// On startup, load token from disk → session if "Remember on disk" is enabled.
async function loadSyncTokenFromDisk() {
  const settings = await readCacheable('manifest:settings') || {};
  if (settings.syncRememberToken && settings.syncToken) {
    const existing = await getSyncSessionToken();
    if (!existing) {
      await setSyncSessionToken(settings.syncToken);
    }
  }
}

// Replay remote log entries via effectOf + sessionWrite.
// Does NOT append to logBuffer or update history keys — remote entries are
// already persisted in their own device-specific log files on disk.
async function replayRemoteEntries(entries, peerDeviceId) {
  for (const entry of entries) {
    const effects = await effectOf(entry, sessionLoad, { deviceId: peerDeviceId });
    await sessionWrite(effects);
  }
  scheduleDrainNotify();
}

// Build a SyncManager wired to offscreen filesystem and the configured transport.
function buildSyncManager(settings, { githubToken } = {}) {
  const method = settings.syncMethod || 'github';
  let transport;
  switch (method) {
    case 'github': {
      const { owner, repo } = parseRepoUrl(settings.syncRepoUrl);
      transport = new GitHubTransport({ owner, repo, token: githubToken });
      break;
    }
    case 'filesystem': {
      transport = new FilesystemTransport({
        listDeviceDirs: () =>
          requestOffscreen({ action: 'syncFsListDeviceDirs' }).then(r => r.dirs),
        listFiles: (deviceDir) =>
          requestOffscreen({ action: 'syncFsListFiles', deviceDir }).then(r => r.files),
        readFile: (path) =>
          requestOffscreen({ action: 'syncFsReadFile', path }).then(r => r.content),
        writeFile: (path, content) =>
          requestOffscreen({ action: 'syncFsWriteFile', path, content }),
        ensureDir: (path) =>
          requestOffscreen({ action: 'syncFsEnsureDir', path }),
        removeFile: (path) =>
          requestOffscreen({ action: 'syncFsRemoveFile', path }),
      });
      break;
    }
    case 'webdav': {
      transport = new WebDAVTransport({
        url: settings.syncWebdavUrl,
        username: settings.syncWebdavUser,
        password: settings.syncWebdavPass,
      });
      break;
    }
    default:
      throw new Error(`Unknown sync method: ${method}`);
  }
  return new SyncManager({
    transport,
    collectLocalFiles: (deviceId, retentionDays) =>
      requestOffscreen({ action: 'collectSyncFiles', deviceId, retentionDays })
        .then(r => r.files),
    writeRemoteFiles: (files) =>
      requestOffscreen({ action: 'writeSyncFiles', files }),
    loadCursors: () =>
      requestOffscreen({ action: 'loadSyncManifest', key: 'sync-cursors' })
        .then(r => r.data || { cursors: {} }),
    saveCursors: (data) =>
      requestOffscreen({ action: 'saveJson', path: 'manifest/sync-cursors.json', data }),
    loadPushState: () =>
      requestOffscreen({ action: 'loadSyncManifest', key: 'sync-push-state' })
        .then(r => r.data || { files: {} }),
    savePushState: (data) =>
      requestOffscreen({ action: 'saveJson', path: 'manifest/sync-push-state.json', data }),
  });
}

async function performSync() {
  if (syncInProgress) return { skipped: true };
  if (rateLimitedUntil > Date.now()) {
    const retryTime = new Date(rateLimitedUntil).toLocaleTimeString();
    return { skipped: true, error: `Rate limited, will retry at ${retryTime}` };
  }
  syncInProgress = true;
  let method = 'github';
  try {
    await hydrationDone;
    const settings = await readCacheable('manifest:settings') || {};
    if (!settings.syncEnabled) return { skipped: true };
    method = settings.syncMethod || 'github';
    let githubToken = null;
    if (method === 'github') {
      githubToken = await getSyncSessionToken();
      if (!settings.syncRepoUrl || !githubToken)
        return { skipped: true, error: !githubToken ? 'GitHub not connected — authorize in Settings' : 'Missing repo URL' };
    }
    if (method === 'filesystem' && !settings.syncFolderName)
      return { skipped: true, error: 'No sync folder selected' };
    if (method === 'webdav' && !settings.syncWebdavUrl)
      return { skipped: true, error: 'Missing WebDAV URL' };

    let deviceId = await getDeviceId();
    const mgr = buildSyncManager(settings, { githubToken });
    const pausedDevices = await _loadPausedDevices();

    // Push local changes — skip if local device is paused
    let pushResult = { pushed: false, fileCount: 0 };
    if (!pausedDevices[deviceId]) {
      pushResult = await mgr.push(deviceId, { retentionDays: settings.syncRetentionDays || 7 });
      if (pushResult.collision) {
        localDeviceId = crypto.randomUUID().slice(0, 8);
        await requestOffscreen({ action: 'initDevice', deviceId: localDeviceId });
        deviceId = localDeviceId;
        logDebug(`[sync] device ID collision, regenerated: ${deviceId}`);
        pushResult = await mgr.push(deviceId, { retentionDays: settings.syncRetentionDays || 7 });
      }
      // Update local device push status immediately (before pull)
      if (pushResult.pushed) {
        const oldDevices = await _loadSyncDevices();
        const updated = oldDevices.map(d =>
          d.deviceId === deviceId ? { ...d, lastPushed: Date.now() } : d
        );
        if (!updated.some(d => d.deviceId === deviceId)) {
          updated.unshift({ deviceId, lastPushed: Date.now() });
        }
        await chrome.storage.session.set({ [SYNC_DEVICES_KEY]: updated });
      }
    }

    // Pull remote changes — skip replay for paused devices
    const pullResult = await mgr.pull(deviceId);
    let entriesReplayed = 0;
    for (const { deviceId: peerId, entries } of pullResult.remoteEntries) {
      if (pausedDevices[peerId]) continue;
      await replayRemoteEntries(entries, peerId);
      entriesReplayed += entries.length;
    }

    // Update full device list with pull timestamps
    if (pullResult.devices) {
      const now = Date.now();
      const oldDevices = await _loadSyncDevices();
      const oldMap = {};
      for (const d of oldDevices) oldMap[d.deviceId] = d;
      const changedSet = new Set(pullResult.changedPeers || []);
      const devices = pullResult.devices.map(b => {
        const old = oldMap[b.name];
        if (b.name === deviceId) {
          // Preserve lastPushed written above
          return { deviceId: b.name, lastPushed: old?.lastPushed || null };
        }
        return { deviceId: b.name, lastPulled: changedSet.has(b.name) ? now : (old?.lastPulled || null) };
      });
      if (!devices.some(d => d.deviceId === deviceId)) {
        const old = oldMap[deviceId];
        devices.unshift({ deviceId, lastPushed: old?.lastPushed || null });
      }
      await chrome.storage.session.set({ [SYNC_DEVICES_KEY]: devices });
    }

    // Successful sync — clear any lingering rate limit state
    rateLimitedUntil = 0;
    lastSyncResult = { timestamp: Date.now(), pushed: pushResult.pushed, pulled: entriesReplayed > 0, entriesReplayed };
    logDebug(`[sync] push=${pushResult.pushed} (${pushResult.fileCount} files), pull=${pullResult.remoteEntries.length} peers, ${entriesReplayed} entries`);
    return lastSyncResult;
  } catch (error) {
    const msg = error.message;
    lastSyncResult = { timestamp: Date.now(), pushed: false, pulled: false, error: msg };
    // GitHub-specific rate limit and auth error handling.
    if (method === 'github') {
      const isRateLimit = msg.includes('rate limit');
      const isAuthError = msg.includes('401') || (msg.includes('403') && !isRateLimit);
      const isNotFound = msg.includes('404');
      if (isAuthError) {
        await setSyncSessionToken(null);
        chrome.alarms.clear(SYNC_ALARM_NAME);
        lastSyncResult.disabled = true;
        lastSyncResult.authExpired = true;
        logDebug(`[sync] auth error, token cleared, alarm disabled: ${msg}`);
      } else if (isNotFound) {
        chrome.alarms.clear(SYNC_ALARM_NAME);
        lastSyncResult.disabled = true;
        logDebug(`[sync] permanent error, alarm disabled: ${msg}`);
      } else if (isRateLimit) {
        const resetEpochSec = error.rateLimitReset;
        const resetMs = resetEpochSec
          ? resetEpochSec * 1000 + 60_000
          : Date.now() + RATE_LIMIT_FALLBACK_MS;
        rateLimitedUntil = resetMs;
        chrome.alarms.clear(SYNC_ALARM_NAME);
        chrome.alarms.create(SYNC_RATE_LIMIT_ALARM, { when: resetMs });
        const retryTime = new Date(resetMs).toLocaleTimeString();
        lastSyncResult.error = `Rate limited, will retry at ${retryTime}`;
        lastSyncResult.rateLimitedUntil = resetMs;
        logDebug(`[sync] rate limited until ${retryTime}`);
      } else {
        logDebug(`[sync] transient error, will retry next cycle: ${msg}`);
      }
    } else {
      logDebug(`[sync] error (${method}): ${msg}`);
    }
    return lastSyncResult;
  } finally {
    syncInProgress = false;
  }
}

// Start or stop the sync alarm based on settings.
async function updateSyncAlarm() {
  const settings = await readCacheable('manifest:settings') || {};
  const method = settings.syncMethod || 'github';
  const githubToken = method === 'github' ? await getSyncSessionToken() : null;
  const configured = method === 'github' ? (settings.syncRepoUrl && githubToken)
    : method === 'filesystem' ? settings.syncFolderName
    : method === 'webdav' ? settings.syncWebdavUrl
    : false;
  if (settings.syncEnabled && configured) {
    rateLimitedUntil = 0;
    chrome.alarms.clear(SYNC_RATE_LIMIT_ALARM);
    const intervalMinutes = Math.max(1, settings.syncIntervalMinutes || 5);
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: intervalMinutes });
    logDebug(`[sync] alarm set: every ${intervalMinutes} min`);
  } else {
    chrome.alarms.clear(SYNC_ALARM_NAME);
    chrome.alarms.clear(SYNC_RATE_LIMIT_ALARM);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM_NAME) {
    performSync();
  } else if (alarm.name === SYNC_RATE_LIMIT_ALARM) {
    // Rate limit window expired — attempt sync, restore periodic alarm on success.
    rateLimitedUntil = 0;
    const result = await performSync();
    if (!result.error || !result.rateLimitedUntil) {
      await updateSyncAlarm();
    }
  }
});

// ─── Initialization ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  logDebug('Browser Recall extension installed');

  chrome.contextMenus.create({
    id: 'portal-highlight',
    title: 'Highlight Selected',
    contexts: ['selection'],
  });

  await ensureOffscreenPort();
  await ensureLogBuffer();
  logDebug('Storage initialized');

  const response = await requestOffscreen({ action: 'getDirectoryInfo' });
  if (!response.info) {
    logDebug('Filesystem not configured - user needs to select directory');
    chrome.runtime.openOptionsPage();
  } else {
    logDebug('Filesystem configured:', response.info.name);
    hydrationDone = hydrateCache();
    await hydrationDone;
    await ensureDefaultLists();
    await loadSyncTokenFromDisk();
    updateSyncAlarm();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenPort();
  await ensureLogBuffer();
  logDebug('Extension started');

  try {
    const response = await requestOffscreen({ action: 'getDirectoryInfo' });
    if (response && response.info) {
      hydrationDone = hydrateCache();
      await hydrationDone;
      await ensureDefaultLists();
      await loadSyncTokenFromDisk();
      updateSyncAlarm();
    }
  } catch (error) {
    logDebug('Startup hydration failed:', error.message);
  }
});

// ─── Save Page WE Integration ─────────────────────────────────────────
initSavepageBridge();

// ─── List Event Fields ───────────────────────────────────────────────
// Resolve a list internal ID to { name, listOwner } for event emission.

async function getListEventFields(listId) {
  if (listId.startsWith('system/')) {
    return { name: listId, listOwner: await getDeviceId() };
  }
  const nameToId = await readCacheable('manifest:name-to-id');
  if (!nameToId?.paths) return null;
  // Reverse lookup: find compound key for this listId
  let listName = null;
  for (const [key, id] of Object.entries(nameToId.paths)) {
    if (id === listId) {
      const slashIdx = key.indexOf('/');
      listName = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
      break;
    }
  }
  if (!listName) {
    const entity = await readCacheable(`list:${listId}`);
    listName = entity?.name;
  }
  if (!listName) return null;
  const entity = await readCacheable(`list:${listId}`);
  const owner = entity?.owner || await getDeviceId();
  return { name: listName, listOwner: owner };
}

// ─── Snapshot Capture ─────────────────────────────────────────────────

// Spinner badge for snapshot capture — animated dot sequence on extension icon
let spinnerInterval = null;
function startSpinnerBadge(tabId) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  chrome.action.setBadgeBackgroundColor({ color: '#D07030', tabId });
  chrome.action.setBadgeText({ text: frames[0], tabId });
  spinnerInterval = setInterval(() => {
    i = (i + 1) % frames.length;
    chrome.action.setBadgeText({ text: frames[i], tabId }).catch(e => logDebug('[spinner] badge update failed:', e.message));
  }, 100);
}
async function stopSpinnerBadge(tabId) {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadgeForTab(tabId, tab.url);
  } catch {
    chrome.action.setBadgeText({ text: '', tabId }).catch(e => logDebug('[spinner] badge clear failed:', e.message));
  }
}

async function captureAndLog(tabId, slug, timestamp, url, title) {
  startSpinnerBadge(tabId);
  try {
  // PDF pages render via a native plugin — no extractable content
  if (url && /\.pdf(\?|#|$)/i.test(new URL(url).pathname)) {
    throw new Error('Cannot capture PDF pages');
  }
  // Fallback: ask content script to check for Chrome's PDF viewer embed
  try {
    const pdfCheck = await chrome.tabs.sendMessage(tabId, { action: 'isPdfPage' });
    if (pdfCheck?.isPdf) throw new Error('Cannot capture PDF pages');
  } catch (e) {
    if (e.message === 'Cannot capture PDF pages') throw e;
    // Content script might not be loaded — proceed with capture
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
  } finally {
    stopSpinnerBadge(tabId);
  }
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
      url,
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
    logDebug('[context-menu] Active tab title mismatch, skipping');
    return;
  }

  try {
    await handleContextMenuHighlight(activeTab.url, activeTab.title, info.selectionText.trim(), activeTab.id);
  } catch (error) {
    logDebug('[context-menu] Highlight error:', error.message);
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
  logDebug(`[background] Command received: ${command}`);

  const workspace = await cacheGet('workspace');
  if (workspace && workspace.mode === 'private') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    logDebug('[background] Command ignored: no suitable tab');
    return;
  }

  if (command === 'capture-snapshot') {
    try {
      const slug = generateSlugFromUrl(tab.url);
      const timestamp = Date.now();
      await captureAndLog(tab.id, slug, timestamp, tab.url, tab.title);
      chrome.tabs.sendMessage(tab.id, { action: 'showCaptureNotification' }).catch(() => {});
    } catch (error) {
      logDebug('[capture] ERROR:', error.message, error);
      chrome.tabs.sendMessage(tab.id, { action: 'showErrorNotification', message: error.message }).catch(() => {});
    }
  } else if (command === 'highlight-selection') {
    try {
      logDebug(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
      logDebug('[background] highlightSelection response:', resp);
    } catch (error) {
      logDebug('[background] Could not highlight selection:', error.message);
    }
  } else if (command === 'like-page' || command === 'dislike-page') {
    const delta = command === 'like-page' ? 1 : -1;
    try {
      const rateEntry = { timestamp: Date.now(), action: 'rate_page', url: tab.url, likes: delta };
      if (tab.title) rateEntry.title = tab.title;
      await addLog(rateEntry);
      notifyMutation('history', { url: tab.url });
      chrome.tabs.sendMessage(tab.id, { action: 'showLikeNotification', delta }).catch(() => {});
    } catch (error) {
      logDebug(`[${command}] ERROR:`, error.message, error);
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

        case 'getReportedUrl': {
          const reportedUrl = tabReportedUrls.get(request.tabId) || null;
          sendResponse({ success: true, url: reportedUrl });
          break;
        }

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
            entry: page ? { url: page.url, title: page.title, user_title: page.user_title,
              scrollDepth: page.scrollDepth, timeOnPage: page.timeOnPage, likes: page.likes,
              timestamps: page.timestamps, slug } : null,
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
            logDebug('[capture-popup] ERROR:', error.message, error);
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
            if (isServicePaused()) {
              sendResponse({ success: false, error: 'Service paused', code: serviceError.code });
              break;
            }
            const url = request.url;

            const rpWorkspace = await cacheGet('workspace');
            if (rpWorkspace && rpWorkspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const rpSettings = await readCacheable('manifest:settings') || {};
            const urlBlacklist = rpSettings.urlBlacklist;
            const blacklist = urlBlacklist ?? ['chrome://', 'edge://'];
            if (!request.bypassBlacklist && blacklist.some(prefix => url.startsWith(prefix))) {
              if (request.isInitialLoad) {
                const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
                const todayEntries = await readCacheable(todayKey) || [];
                const inSession = todayEntries.some(e => e.url === url);
                if (!inSession) {
                  const pageSlug = generateSlugFromUrl(url);
                  const existing = await readCacheable('page:' + pageSlug);
                  if (!existing) {
                    logDebug(`Skipping blacklisted URL (not in database): ${url}`);
                    sendResponse({ success: true });
                    return;
                  }
                }
                logDebug(`Blacklisted URL but already in database, continuing: ${url}`);
              } else {
                sendResponse({ success: true });
                return;
              }
            }

            if (request.isInitialLoad) {
              // Track the URL the content script reported for this tab.
              // Popup uses this to avoid slug mismatch when tab.url drifts (SPA pushState).
              if (sender.tab?.id != null) {
                tabReportedUrls.set(sender.tab.id, url);
              }
              // visit_page: always includes title, referrerUrl is raw URL
              let referrerUrl = request.referrer || null;
              if (!referrerUrl && sender.tab?.id != null) {
                const bgRef = await getReferrer(sender.tab.id);
                if (bgRef) referrerUrl = bgRef;
              }
              // Skip self-referential
              if (referrerUrl) {
                const refSlug = generateSlugFromUrl(referrerUrl);
                const selfSlug = generateSlugFromUrl(url);
                if (refSlug === selfSlug) referrerUrl = null;
              }

              const title = request.title ? await trimTitle(request.title, url) : '';
              const entry = buildVisitPageEntry(url, title, referrerUrl, { checkpoint: request.bypassBlacklist });
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
                      const pn = await getListEventFields(listSlug);
                      if (pn) {
                        const pinEntry = {
                          timestamp: Date.now(),
                          action: 'pin_to_list',
                          name: pn.name, listOwner: pn.listOwner,
                          items: [url],
                          source: 'auto',
                        };
                        if (title) pinEntry.titles = { [url]: title };
                        await addLog(pinEntry);
                        logDebug(`Workspace: auto-pinned ${url} to ${pn.name}`);
                      }
                    }
                  }

                  if (rpWorkspace.autoSnapshot && sender.tab) {
                    captureAndLog(sender.tab.id, slug, entry.timestamp, url, title).catch(err => {
                      logDebug('[auto-snapshot] ERROR:', err.message, err);
                    });
                  }
                } catch (err) {
                  logDebug('Workspace: auto-pin/snapshot error:', err.message);
                }
              }

              // Smart-rule auto-pin: evaluate all lists with rules
              evaluateSmartRulesForVisit(url, title).catch(err => {
                logDebug('Smart-rule auto-pin error:', err.message);
              });

              notifyMutation('history', { url });
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

            logDebug(`Processed page report: ${url} (initial=${!!request.isInitialLoad}, leaving=${!!request.isLeaving})`);
            sendResponse({ success: true });
          } catch (error) {
            logError('Error processing reportPage:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        // ── Queue Operations ──

        case 'clearWriteQueue': {
          logBuffer = [];
          await persistLogBuffer();
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
          logDebug(`[I/O] loadPageNotes(${request.slug}): ${notes.length} notes in ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, notes });
          break;
        }

        case 'getDeviceId': {
          sendResponse({ success: true, deviceId: await getDeviceId() });
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
          logDebug(`[I/O] listSnapshots(${slug}): ${snapshots.length} from entity in ${(performance.now() - t0).toFixed(1)}ms`);
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

        case 'listHistoryFiles': {
          const resp = await requestOffscreen({ action: 'listHistoryFiles', includeSizes: request.includeSizes });
          sendResponse(resp);
          break;
        }

        case 'loadHistoryBatch': {
          const t0 = performance.now();
          const resp = await requestOffscreen({ action: 'loadHistoryBatch', files: request.files });
          logDebug(`[I/O] loadHistoryBatch: ${request.files.length} files in ${(performance.now() - t0).toFixed(1)}ms`);
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

          // Skip if note text is unchanged
          if (request.note === (oldNoteData.note ?? '')) {
            sendResponse({ success: true, noteSlug: oldNoteSlug });
            break;
          }

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
            const pn = await getListEventFields(listId);
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
              name: pn.name, listOwner: pn.listOwner,
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
          const pn = await getListEventFields(request.listId);
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
              name: pn.name, listOwner: pn.listOwner,
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
          const pn = request.listId ? await getListEventFields(request.listId) : null;

          if (!cached) {
            // New list: create_list event
            // Resolve parent for tree placement
            let parentListId;
            if (request.parentPath && request.parentPath !== 'root') {
              // parentPath like 'root/list:some-id' — last segment is the parent
              const parts = request.parentPath.split('/');
              const lastPart = parts[parts.length - 1];
              if (lastPart.startsWith('list:')) parentListId = lastPart.slice('list:'.length);
            }
            if (request.name) {
              const deviceId = await getDeviceId();
              const createEntry = {
                timestamp: Date.now(),
                action: 'create_list',
                listOwner: deviceId,
                name: request.name,
              };
              if (parentListId) createEntry.parentListId = parentListId;
              await addLog(createEntry);
              // Look up the generated listId from compound name-to-id map
              const nameToId = await readCacheable('manifest:name-to-id');
              const generatedId = nameToId?.paths?.[deviceId + '/' + request.name];
              sendResponse({ success: true, listId: generatedId });
              notifyMutation('lists');
              break;
            }
          } else if (pn) {
            // Existing list: update_list event
            const entry = { timestamp: Date.now(), action: 'update_list', name: pn.name, listOwner: pn.listOwner };
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
          const pnDel = await getListEventFields(request.listId);
          if (!pnDel) {
            sendResponse({ success: false, error: 'List not found in name-to-id' });
            break;
          }
          // Just parents+name — effectOf derives cascade from entity state
          await addLog({ timestamp: Date.now(), action: 'delete_list', name: pnDel.name, listOwner: pnDel.listOwner });
          sendResponse({ success: true });
          notifyMutation('lists');
          break;
        }

        case 'updateListTree': {
          // request: { tree } — full tree blob from UI
          await addLog({
            timestamp: Date.now(),
            action: 'update_list_tree',
            tree: request.tree,
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
          const owner = entity?.owner || await getDeviceId();
          await addLog({
            timestamp: Date.now(),
            action: 'restore_list',
            name, listOwner: owner,
          });
          sendResponse({ success: true });
          notifyMutation('orphaned');
          notifyMutation('lists');
          break;
        }

        case 'permanentDelete': {
          if (isServicePaused()) { sendResponse({ success: false, error: 'Service paused', code: serviceError.code }); break; }
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
          if (isServicePaused()) { sendResponse({ success: false, error: 'Service paused', code: serviceError.code }); break; }
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
          if (!resp?.success) { sendResponse(resp); break; }
          // Write custom device name if provided (before hydration reads CURRENT)
          if (request.deviceName) {
            localDeviceId = request.deviceName;
            await requestOffscreen({ action: 'initDevice', deviceId: request.deviceName });
          }
          // Re-hydrate now that filesystem is available
          hydrationDone = hydrateCache();
          await hydrationDone;
          await ensureDefaultLists();
          sendResponse({ success: true });
          break;
        }

        case 'hasDirectoryHandle': {
          const resp = await requestOffscreen({ action: 'hasDirectoryHandle' });
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
          await persistLogBuffer();
          // 2. Clear entity cache (session storage + in-memory LRU)
          await cacheClear();
          // 3. Reset ALL in-memory state (SW survives across tests)
          localDeviceId = null;
          recentUrls = new Map();
          tabReportedUrls.clear();
          rateLimitedUntil = 0;
          lastSyncResult = null;
          syncInProgress = false;
          serviceError = null;
          consecutiveDrainFailures = 0;
          chrome.alarms.clear(SYNC_RATE_LIMIT_ALARM);
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          // 4. Re-establish test directory (offscreen may have restarted after
          //    killOffscreenForTest, losing its OPFS handle) then wipe it
          await requestOffscreen({ action: 'setTestDirectory' });
          await requestOffscreen({ action: 'resetDirectory' });
          // 5. Re-hydrate from (now empty) filesystem
          hydrationDone = hydrateCache();
          await hydrationDone;
          await ensureDefaultLists();
          sendResponse({ success: true });
          break;
        }

        case 'pauseServiceForTest': {
          // Simulate a service pause for testing the downtime UI.
          pauseService(request.code || 'session_quota', request.message || 'Test pause');
          sendResponse({ success: true });
          break;
        }

        case 'resumeService': {
          resumeService();
          consecutiveDrainFailures = 0;
          // Re-run hydration so service is fully operational again.
          hydrationDone = hydrateCache();
          await hydrationDone;
          scheduleDrainNotify();
          sendResponse({ success: true });
          break;
        }

        case 'clearDirectoryHandleForTest': {
          const resp = await requestOffscreen({ action: 'clearDirectoryHandleForTest' });
          localDeviceId = null;
          sendResponse(resp);
          break;
        }

        case 'killOffscreenForTest': {
          // Close the offscreen document to simulate a crash.
          // This triggers onDisconnect → reject pending callbacks + crash-loop tracking.
          try { await chrome.offscreen.closeDocument(); } catch (_) { /* already closed */ }
          sendResponse({ success: true });
          break;
        }

        case 'setRateLimitForTest': {
          // Simulate rate-limited state for testing backoff behavior.
          rateLimitedUntil = request.until || 0;
          lastSyncResult = request.until
            ? { timestamp: Date.now(), pushed: false, pulled: false,
                error: `Rate limited, will retry at ${new Date(request.until).toLocaleTimeString()}`,
                rateLimitedUntil: request.until }
            : null;
          sendResponse({ success: true });
          break;
        }

        case 'setLogBufferForTest': {
          // Inject entries into logBuffer for testing hydration replay paths.
          logBuffer = request.entries || [];
          await persistLogBuffer();
          sendResponse({ success: true });
          break;
        }

        case 'rehydrateForTest': {
          // Clear caches and re-hydrate without wiping the directory.
          // Used after seedTestData to pick up seeded files.
          // Pass keepLogBuffer:true to preserve injected logBuffer entries for replay.
          if (!request.keepLogBuffer) {
            logBuffer = [];
            await persistLogBuffer();
          }
          await cacheClear();
          localDeviceId = null;
          recentUrls = new Map();
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          hydrationDone = hydrateCache();
          await hydrationDone;
          await ensureDefaultLists();
          await loadSyncTokenFromDisk();
          sendResponse({ success: true });
          break;
        }

        case 'seedTestData': {
          const resp = await requestOffscreen({ action: 'seedTestData', files: request.files });
          sendResponse(resp);
          break;
        }

        // Simulate the pre-hydration window: localDeviceId is null (module just loaded)
        // but hydrationDone is resolved (initial Promise.resolve()). This is the state
        // between SW start and hydrateCache() being called from onInstalled/onStartup.
        case 'simulatePreHydrationForTest': {
          localDeviceId = null;
          // hydrationDone stays resolved — simulating the initial Promise.resolve()
          sendResponse({ success: true });
          break;
        }

        // Simulate missing CURRENT file: clears in-memory device ID and deletes CURRENT from disk.
        // After this, getDeviceId() returns null — UI should show fatal error.
        case 'clearDeviceIdForTest': {
          localDeviceId = null;
          try { await requestOffscreen({ action: 'deleteCurrent' }); } catch {}
          sendResponse({ success: true });
          break;
        }

        // ─── Rule Handlers ───────────────────────────────────────────

        case 'addRule': {
          const { listId, rule } = request;
          const listInfo = await getListEventFields(listId);
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
            // Compile-check via sandbox (CSP blocks new Function in background)
            const compileResp = await requestOffscreen({ action: 'executeSandboxFn', fnSource: rule.config.fnSource, pageData: { title: '', url: '', body: '' } });
            if (!compileResp?.success) {
              sendResponse({ success: false, error: `Function failed to compile: ${compileResp?.error || 'unknown error'}` });
              break;
            }
          }

          await addLog({
            timestamp: Date.now(),
            action: 'add_rule',
            name: listInfo.name,
            listOwner: listInfo.listOwner,
            rule: { type: rule.type, config: rule.config },
          });
          sendResponse({ success: true });
          notifyMutation('rules', { listId });
          break;
        }

        case 'removeRule': {
          const { listId, ruleId } = request;
          const listInfo = await getListEventFields(listId);
          if (!listInfo) { sendResponse({ success: false, error: 'List not found' }); break; }

          await addLog({
            timestamp: Date.now(),
            action: 'remove_rule',
            name: listInfo.name,
            listOwner: listInfo.listOwner,
            ruleId,
          });
          sendResponse({ success: true });
          notifyMutation('rules', { listId });
          break;
        }

        case 'updateRule': {
          const { listId, ruleId, config } = request;
          const listInfo = await getListEventFields(listId);
          if (!listInfo) { sendResponse({ success: false, error: 'List not found' }); break; }

          await addLog({
            timestamp: Date.now(),
            action: 'update_rule',
            name: listInfo.name,
            listOwner: listInfo.listOwner,
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
                const listInfo = await getListEventFields(listId);
                if (listInfo) {
                  // Check if already pinned
                  const slug = generateSlugFromUrl(entry.url);
                  const alreadyPinned = (listEntity.pins || []).some(p => p.id === `page:${slug}`);
                  if (!alreadyPinned) {
                    const sfPinEntry = {
                      timestamp: Date.now(),
                      action: 'pin_to_list',
                      name: listInfo.name,
                      listOwner: listInfo.listOwner,
                      items: [entry.url],
                      source: 'auto',
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

        // ── Sync ──

        case 'syncNow': {
          if (isServicePaused()) { sendResponse({ success: false, error: 'Service paused', code: serviceError.code }); break; }
          const result = await performSync();
          sendResponse({ success: true, ...result });
          break;
        }

        case 'getSyncStatus': {
          sendResponse({ success: true, syncInProgress, lastSyncResult });
          break;
        }

        case 'syncListDevices': {
          // Quick: just list remote branches to populate device list UI.
          try {
            await hydrationDone;
            const settings = await readCacheable('manifest:settings') || {};
            if (!settings.syncEnabled) { sendResponse({ success: true, devices: [] }); break; }
            let githubToken = null;
            if ((settings.syncMethod || 'github') === 'github') {
              githubToken = await getSyncSessionToken();
              if (!settings.syncRepoUrl || !githubToken) { sendResponse({ success: true, devices: [] }); break; }
            }
            const mgr = buildSyncManager(settings, { githubToken });
            const branches = await mgr.transport.listBranches();
            const ownId = await getDeviceId();
            const oldDevices = await _loadSyncDevices();
            const oldMap = {};
            for (const d of oldDevices) oldMap[d.deviceId] = d;
            const devices = branches.map(b => ({
              deviceId: b.name,
              lastPushed: oldMap[b.name]?.lastPushed || null,
              lastPulled: oldMap[b.name]?.lastPulled || null,
            }));
            if (ownId && !devices.some(d => d.deviceId === ownId)) {
              devices.unshift({ deviceId: ownId, lastPushed: null });
            }
            await chrome.storage.session.set({ [SYNC_DEVICES_KEY]: devices });
            const paused = await _loadPausedDevices();
            for (const d of devices) d.paused = !!paused[d.deviceId];
            sendResponse({ success: true, devices, localDeviceId: ownId });
          } catch (e) {
            sendResponse({ success: true, devices: [] });
          }
          break;
        }

        case 'updateSyncSettings': {
          // Save sync settings and update alarm. Called after user changes sync config.
          await updateSyncAlarm();
          sendResponse({ success: true });
          break;
        }

        case 'setSyncToken': {
          // Store token in session. Optionally persist to disk if remember is on.
          await setSyncSessionToken(request.token);
          const stEntries = [];
          if (request.remember) {
            stEntries.push({ key: 'syncToken', value: request.token });
            stEntries.push({ key: 'syncRememberToken', value: true });
          } else {
            stEntries.push({ key: 'syncToken', value: null });
            stEntries.push({ key: 'syncRememberToken', value: false });
          }
          if (request.authMethod) stEntries.push({ key: 'syncAuthMethod', value: request.authMethod });
          if (request.githubUser) stEntries.push({ key: 'syncGitHubUser', value: request.githubUser });
          for (const { key, value } of stEntries) {
            await addLog({ timestamp: Date.now(), action: 'update_setting', key, value });
          }
          await updateSyncAlarm();
          sendResponse({ success: true });
          break;
        }

        case 'clearSyncToken': {
          await setSyncSessionToken(null);
          for (const key of ['syncToken', 'syncRememberToken', 'syncAuthMethod', 'syncGitHubUser']) {
            await addLog({ timestamp: Date.now(), action: 'update_setting', key, value: null });
          }
          await updateSyncAlarm();
          sendResponse({ success: true });
          break;
        }

        case 'toggleSyncRemember': {
          const token = await getSyncSessionToken();
          if (request.remember && token) {
            await addLog({ timestamp: Date.now(), action: 'update_setting', key: 'syncToken', value: token });
          } else if (!request.remember) {
            await addLog({ timestamp: Date.now(), action: 'update_setting', key: 'syncToken', value: null });
          }
          await addLog({ timestamp: Date.now(), action: 'update_setting', key: 'syncRememberToken', value: !!request.remember });
          sendResponse({ success: true });
          break;
        }

        case 'getSyncAuthState': {
          const token = await getSyncSessionToken();
          const settings = await readCacheable('manifest:settings') || {};
          sendResponse({
            success: true,
            hasToken: !!token,
            authMethod: settings.syncAuthMethod || null,
            githubUser: settings.syncGitHubUser || null,
            rememberToken: !!settings.syncRememberToken,
          });
          break;
        }

        case 'getSyncDevices': {
          const devices = await _loadSyncDevices();
          const ownId = await getDeviceId();
          // Ensure local device is always present even before first sync
          if (ownId && !devices.some(d => d.deviceId === ownId)) {
            devices.unshift({ deviceId: ownId, lastPushed: null });
          }
          const paused = await _loadPausedDevices();
          for (const d of devices) d.paused = !!paused[d.deviceId];
          sendResponse({ success: true, devices, localDeviceId: ownId });
          break;
        }

        case 'toggleSyncDevicePaused': {
          const paused = await _loadPausedDevices();
          if (paused[request.deviceId]) {
            delete paused[request.deviceId];
          } else {
            paused[request.deviceId] = true;
          }
          await _savePausedDevices(paused);
          sendResponse({ success: true, paused: !!paused[request.deviceId] });
          break;
        }

        case 'deleteSyncDevice': {
          if (isServicePaused()) { sendResponse({ success: false, error: 'Service paused', code: serviceError.code }); break; }
          const settings = await readCacheable('manifest:settings') || {};
          let githubToken = null;
          if ((settings.syncMethod || 'github') === 'github') {
            githubToken = await getSyncSessionToken();
          }
          const mgr = buildSyncManager(settings, { githubToken });
          await mgr.deleteDevice(request.deviceId);
          // Remove from session device list
          const currentDevices = await _loadSyncDevices();
          const filtered = currentDevices.filter(d => d.deviceId !== request.deviceId);
          await chrome.storage.session.set({ [SYNC_DEVICES_KEY]: filtered });
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${request.action}` });
      }
    } catch (error) {
      logError('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

// ─── Import Bookmarks (port-based for progress streaming) ────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'import-bookmarks') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action !== 'importBookmarks') return;
    const { tree } = msg;
    const deviceId = await getDeviceId();
    const failures = [];
    let listCount = 0;
    let bookmarkCount = 0;
    const FAIL_LIMIT = 20;
    let aborted = false;

    function extractListId(effects) {
      const key = Object.keys(effects).find(k => k.startsWith('list:') && k !== 'manifest:list-order' && k !== 'manifest:name-to-id');
      return key ? key.slice(5) : null;
    }

    // Create wrapping parent list
    const parentName = `Imported Bookmarks (${new Date().toLocaleString()})`;
    let parentEffects;
    try {
      parentEffects = await addLog({
        timestamp: Date.now(), action: 'create_list',
        listOwner: deviceId, name: parentName,
      });
    } catch (e) {
      port.postMessage({ type: 'error', message: 'Failed to create parent list: ' + e.message });
      return;
    }
    const parentListId = extractListId(parentEffects);

    async function processFolder(node, parentId) {
      if (aborted) return;

      // Create list for this folder
      let effects;
      try {
        effects = await addLog({
          timestamp: Date.now(), action: 'create_list',
          listOwner: deviceId, name: node.title || 'Untitled',
          ...(parentId ? { parentListId: parentId } : {}),
        });
      } catch (e) {
        port.postMessage({ type: 'error', message: 'Failed to create list "' + node.title + '": ' + e.message });
        aborted = true;
        return;
      }
      listCount++;
      const listId = extractListId(effects);
      port.postMessage({ type: 'progress', text: `Creating list ${listCount}...` });

      // Pin bookmarks
      if (node.bookmarks && node.bookmarks.length > 0 && listId) {
        const pn = await getListEventFields(listId);
        if (pn) {
          const urls = [];
          const titles = {};
          for (const bm of node.bookmarks) {
            urls.push(bm.url);
            if (bm.title) titles[bm.url] = bm.title;
          }
          try {
            const pinEntry = {
              timestamp: Date.now(), action: 'pin_to_list',
              name: pn.name, listOwner: pn.listOwner, items: urls,
            };
            if (Object.keys(titles).length > 0) pinEntry.titles = titles;
            await addLog(pinEntry);
            bookmarkCount += urls.length;
          } catch (e) {
            for (const u of urls) failures.push({ url: u, reason: e.message });
          }
        }
      }

      // Record skipped URLs as failures
      for (const s of (node.skipped || [])) {
        failures.push({ url: s.url, title: s.title, reason: s.reason });
      }

      if (failures.length >= FAIL_LIMIT) {
        port.postMessage({ type: 'error', message: `Too many failures (${failures.length}), aborting.` });
        aborted = true;
        return;
      }

      port.postMessage({ type: 'progress', text: `Pinning bookmarks ${bookmarkCount}...` });

      // Recurse into children
      for (const child of (node.children || [])) {
        await processFolder(child, listId);
        if (aborted) return;
      }
    }

    for (const folder of tree) {
      await processFolder(folder, parentListId);
      if (aborted) break;
    }

    if (!aborted) {
      notifyMutation('lists');
      port.postMessage({ type: 'done', listCount, bookmarkCount, failures });
    }
  });
});
