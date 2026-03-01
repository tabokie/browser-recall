// Background service worker for Portal extension
// Central authority for reads and mutations. Offscreen is a pure filesystem I/O worker.
import { generateSlugFromUrl, generateNoteSlug, dateKeyFromTimestamp } from './utils.js';
import { effectOf, applyLogToPage } from './replay.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { cacheGet, cacheSet, cacheRemove, cachePin, cacheUnpin, setEntityCacheWatermark, cacheClear } from './entity-cache.js';

console.log('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — data is safe in chrome.storage.local until drained
const HISTORY_RECENT_DAYS = 7; // days of past history to cache for multi-day checks

// In-memory Set of URLs from history:recent (past days) for O(1) multi-day lookups.
// Populated during hydration, immutable until next browser restart.
let recentUrls = new Set();

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
  return await readCacheable(key);
}

// Like sessionLoad but without the hydrationDone guard.
// Used during hydrateCache() where awaiting hydrationDone would deadlock.
async function sessionLoadDuringHydration(key) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  return readFs(key);
}

// Write effectOf results back to session cache.
async function sessionWrite(effects) {
  for (const [key, entity] of Object.entries(effects)) {
    if (entity === null) continue;
    if (key.startsWith('list:') && !key.startsWith('list:system/') && !key.startsWith('list:index/')) {
      if (entity.deleted) {
        await cacheRemove(key);
      } else {
        await cacheSet(key, entity);
      }
    } else {
      await cacheSet(key, entity);
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
  // Append to today's history date key in session (fire-and-forget).
  // Pin the key: today's session data includes unflushed entries from addLog that
  // are newer than the on-disk JSONL file, so evicting it would lose data.
  // Also covers date rollover (new date key created mid-session).
  const todayKey = 'history:' + dateKeyFromTimestamp(entry.timestamp);
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

// ─── Session → Filesystem Fallback ───────────────────────────────────
// readCacheable(key): await hydration, then session cache → readFs fallback.
// readFs(key): load from filesystem via offscreen, cache into session.

async function readCacheable(key) {
  await hydrationDone;
  const cached = await cacheGet(key);
  if (cached !== null) return cached;
  return readFs(key);
}

// Read listOrder from settings. Each entry is { id: 'list:<slug>', name }.
async function getListOrder() {
  await hydrationDone;
  const settings = await readCacheable('settings');
  return settings.listOrder || [];
}

function assertOffscreenSuccess(resp, key) {
  if (!resp || resp.success === false) {
    throw new Error(resp?.error || `Offscreen load failed for ${key}`);
  }
}

async function readFs(key) {
  let value;
  switch (key) {
    case 'settings': {
      const resp = await requestOffscreen({ action: 'loadSettings' });
      assertOffscreenSuccess(resp, key);
      value = resp.settings;
      break;
    }
    case 'list:system/recycle-bin': {
      const r = await requestOffscreen({ action: 'loadRecycleBin' });
      assertOffscreenSuccess(r, key);
      value = r.items;
      break;
    }
    case 'list:system/permanent-deletes': {
      const r = await requestOffscreen({ action: 'loadPermanentDeletes' });
      assertOffscreenSuccess(r, key);
      value = r.keys;
      break;
    }
    case 'list:system/shallow-page': {
      const r = await requestOffscreen({ action: 'loadShallowPageIndex' });
      assertOffscreenSuccess(r, key);
      value = { timestamp: r.timestamp, index: r.index };
      break;
    }
    case 'list:system/gateways': {
      const r = await requestOffscreen({ action: 'loadGateways' });
      assertOffscreenSuccess(r, key);
      value = r.origins;
      break;
    }
    default: {
      if (key.startsWith('history:')) {
        // Disk-only read (no logBuffer replay). Safe because:
        // - Today's key is pinned (never evicted, never reaches readFs post-hydration)
        // - Past keys with undrained logBuffer entries have timestamp > persistWatermark,
        //   so watermark-gated eviction won't evict them until drain completes
        // - Past keys fully drained: disk is complete, no replay needed
        const dateStr = key.slice('history:'.length);
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
      await cacheSet('settings', resp.settings);
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
    const rbResp = await requestOffscreen({ action: 'loadRecycleBin' });
    if (rbResp?.success) await cacheSet('list:system/recycle-bin', rbResp.items);
  } catch (e) { console.warn('Recycle bin load failed:', e.message); }

  try {
    const pdResp = await requestOffscreen({ action: 'loadPermanentDeletes' });
    if (pdResp?.success) await cacheSet('list:system/permanent-deletes', pdResp.keys);
  } catch (e) { console.warn('Permanent deletes load failed:', e.message); }

  try {
    const spResp = await requestOffscreen({ action: 'loadShallowPageIndex' });
    if (spResp?.success) {
      await cacheSet('list:system/shallow-page', { timestamp: spResp.timestamp, index: spResp.index });
    }
  } catch (e) { console.warn('Shallow page index load failed:', e.message); }

  // Phase 1.5: History cache — per-date keys history:YYYY-MM-DD
  try {
    const todayStr = dateKeyFromTimestamp(Date.now());

    // Load today's history — pinned because addLog appends entries here that are
    // newer than the on-disk JSONL file; evicting would lose unflushed data.
    const todayResp = await requestOffscreen({ action: 'loadHistoryRange', from: todayStr, to: todayStr });
    assertOffscreenSuccess(todayResp, 'history:' + todayStr);
    const todayEntries = todayResp.entries || [];
    const todayKey = 'history:' + todayStr;
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

    recentUrls = new Set();
    if (fromStr <= toStr) {
      // Load the full range, then split into per-date keys
      const recentResp = await requestOffscreen({ action: 'loadHistoryRange', from: fromStr, to: toStr });
      assertOffscreenSuccess(recentResp, `history:${fromStr}..${toStr}`);
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
        const hKey = 'history:' + d;
        const maxTs = entries.length ? entries[entries.length - 1].timestamp : 0;
        await cacheSet(hKey, entries, { timestamp: maxTs });
        cachePin(hKey);
        cur.setDate(cur.getDate() + 1);
      }

      // Build in-memory URL set for O(1) multi-day lookups
      for (const entry of recentEntries) {
        if ((entry.action === 'page' || !entry.action) && entry.url) {
          recentUrls.add(entry.url);
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
          const oldKey = 'history:' + d;
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
    const todayKey = 'history:' + dateKeyFromTimestamp(Date.now());
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
    const hk = 'history:' + dk;
    let entries = await cacheGet(hk);
    if (entries == null) entries = [];
    entries.push(entry);
    await cacheSet(hk, entries, { timestamp: entry.timestamp });
  }

  console.log('Cache hydrated');
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle || 'Untitled';
  const titleTrimRules = (await readCacheable('settings')).titleTrimRules || [];
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
  const key = 'page:' + slug;
  let cached = await cacheGet(key);
  if (!cached) {
    // Disk fallback: cache miss (SW restart, LRU eviction) → load from filesystem
    const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
    const diskPage = resp?.pages?.[slug];
    if (diskPage) {
      await cacheSet(key, diskPage);
      cached = diskPage;
    }
  }

  const entry = {
    timestamp: Date.now(),
    action: 'page',
    url,
  };
  let hasChange = !!delta.isInitialLoad; // initial visit is always meaningful

  // Title: trim then compare; always include on initial load
  if (delta.title != null) {
    const trimmed = await trimTitle(delta.title, url);
    if (delta.isInitialLoad) {
      entry.title = trimmed;
    } else if (!cached || cached.title !== trimmed) {
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

  // user_title: from delta if explicitly set, or from cached entity on initial load
  if (delta.user_title != null) {
    if (!cached || cached.user_title !== delta.user_title) {
      entry.user_title = delta.user_title;
      hasChange = true;
    }
  } else if (delta.isInitialLoad && cached?.user_title) {
    // Content script doesn't know user_title; pull from cached entity
    // (already loaded via cacheGet + disk fallback above)
    entry.user_title = cached.user_title;
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
    const gatewayOrigins = await readCacheable('list:system/gateways');
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
  if (await cacheGet(key)) return key;
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
// When the caller cannot provide title/parentIds, searches SPI and recent history.

async function ensureCheckpointIfMissing(url, title) {
  if (!url) return;
  const slug = generateSlugFromUrl(url);
  const key = 'page:' + slug;
  const cached = await cacheGet(key);
  if (!cached) {
    const existsResp = await requestOffscreen({ action: 'pageExists', slug });
    if (!existsResp?.exists) {
      const entry = {
        timestamp: Date.now(),
        action: 'page_checkpoint',
        url,
        title: title || null
      };
      if (!title) {
        const found = await searchPageContext(url);
        if (found.title) entry.title = found.title;
        if (found.user_title) entry.user_title = found.user_title;
        if (found.parentIds.length) entry.parentIds = found.parentIds;
      }
      await addLog(entry);
    }
  }
}

// Search SPI and recent history cache for page context.
// Called only when creating a new checkpoint without caller-provided context.
//
// SPI record fields (see applyLogToShallowPage in replay.js):
//   - title        (string|null)  — auto-detected page title
//   - user_title   (string|null)  — user-assigned custom title
//   - parentIds    (string[])     — referrer IDs in page:<slug> format
//   - lists        (string[])     — list IDs this page is pinned to (not used here)
//
// SPI completeness guarantee (documented in applyLogToShallowPage):
//   If a page has parentIds, belongs to a list, or has user_title, it MUST
//   have an SPI entry. Therefore user_title and parentIds are authoritative
//   from SPI alone — only title needs a history fallback (a page may have
//   been visited with a title but without any of the (a)–(c) criteria).
async function searchPageContext(url) {
  const result = { title: null, user_title: null, parentIds: [] };

  // 1. Shallow page index — authoritative for user_title and parentIds
  try {
    const spi = await readCacheable('list:system/shallow-page');
    const rec = spi?.index?.[url];
    if (rec) {
      if (rec.title) result.title = rec.title;
      if (rec.user_title) result.user_title = rec.user_title;
      if (rec.parentIds?.length) result.parentIds = [...rec.parentIds];
    }
  } catch (error) {
    // SPI not available; continue to next source
  }

  // 2. Recent history cache — only for title and parentIds not yet found.
  //    user_title is NOT searched here: per SPI completeness guarantee,
  //    if a page has user_title it is already in SPI.
  if (!result.title || !result.parentIds.length) {
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayEntries = await cacheGet('history:' + todayStr) || [];
      searchHistoryEntries(todayEntries, url, result);

      if (!result.title || !result.parentIds.length) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - HISTORY_RECENT_DAYS);
        const cur = new Date(fromDate);
        while (cur <= yesterday && (!result.title || !result.parentIds.length)) {
          const dateKey = 'history:' + dateKeyFromTimestamp(cur.getTime());
          const entries = await cacheGet(dateKey) || [];
          searchHistoryEntries(entries, url, result);
          cur.setDate(cur.getDate() + 1);
        }
      }
    } catch (error) {
      // History cache miss; continue
    }
  }

  if (!result.title) {
    console.warn(`[checkpoint] No title found in SPI or history for: ${url}`);
  }
  return result;
}

// Scan history entries for title and referrerId matching the given URL.
// user_title is NOT extracted here — it is authoritative from SPI only.
function searchHistoryEntries(entries, url, result) {
  for (const entry of entries) {
    if (entry.url !== url) continue;
    if (!result.title && entry.title) result.title = entry.title;
    if (entry.referrerId && !result.parentIds.includes(entry.referrerId)) {
      result.parentIds.push(entry.referrerId);
    }
  }
}

// ─── Snapshot Capture ─────────────────────────────────────────────────

async function captureAndLog(tabId, slug, timestamp, url, title) {
  // Ensure page exists before capture
  if (url) await ensureCheckpointIfMissing(url, title);
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
      await ensureCheckpointIfMissing(tab.url, tab.title);
      await addLog({ timestamp: Date.now(), action: 'page', url: tab.url, likes: delta });
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
          const slug = generateSlugFromUrl(request.url);
          const key = 'page:' + slug;

          // Entity storage: session cache → filesystem fallback
          let page = await cacheGet(key);
          if (!page) {
            const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
            if (resp?.pages?.[slug]) {
              await ensureLogBuffer();
              page = replayBufferOver(resp.pages[slug]);
              await cacheSet(key, page);
            }
          }

          const snapshotsResp = await requestOffscreen({ action: 'listSnapshots', slug });

          // Notes: read from page.childIds via readCacheable (session cache → disk).
          // This surfaces notes created via addLog that haven't drained to disk yet.
          const noteRefs = (page?.childIds || []).filter(c => c.startsWith('note:'));
          const notes = [];
          for (const ref of noteRefs) {
            const note = await readCacheable(ref);
            if (note) notes.push(note);
          }

          // page is null for shallow pages (no checkpoint) — popup uses tab.title as fallback
          sendResponse({
            success: true, slug,
            interaction: page ? { url: page.url, title: page.title, user_title: page.user_title,
              scrollDepth: page.scrollDepth, timeOnPage: page.timeOnPage, likes: page.likes,
              timestamp: page.timestamp, slug } : null,
            snapshots: snapshotsResp?.snapshots || [],
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

            const rpWorkspace = await cacheGet('workspace');
            if (rpWorkspace && rpWorkspace.mode === 'private') {
              sendResponse({ success: true });
              return;
            }

            // Check blacklist
            const rpSettings = await readCacheable('settings');
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
                // Multi-day visit checkpoint: check in-memory recentUrls set (built from history:recent)
                if (recentUrls.has(url)) {
                  await ensureCheckpointIfMissing(url, entry.title);
                }

                // Parent checkpoint for referrer
                if (entry.referrerId) {
                  await ensureCheckpointIfMissing(delta.referrer);
                }
              }

              await addLog(entry);

              // First-visit extras: gateway + workspace
              if (request.isInitialLoad) {
                const slug = delta.slug || generateSlugFromUrl(url);
                const title = entry.title || '';
                const timestamp = entry.timestamp;

                updateGatewayRegistry(url);

                const wsListIds = rpWorkspace?.listIds || [];
                if (rpWorkspace && rpWorkspace.mode === 'workspace' && wsListIds.length > 0) {
                  try {
                    for (const listKey of wsListIds) {
                      const listSlug = listKey.startsWith('list:') ? listKey.slice(5) : listKey;
                      const listEntry = await readCacheable('list:' + listSlug);
                      const listPins = listEntry?.pins || [];
                      const pinId = await resolvePageId(url);
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

                    if (rpWorkspace.autoSnapshot && sender.tab) {
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
          try {
            const spi = await readCacheable('list:system/shallow-page');
            sendResponse(spi);
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'loadPageBatch': {
          const t0 = performance.now();
          const result = {};
          const uncachedSlugs = [];

          // Check page cache for each slug
          for (const slug of request.slugs) {
            const key = 'page:' + slug;
            const cached = await cacheGet(key);
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
                await cacheSet('page:' + slug, upToDate);
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
          const entity = await readCacheable('list:' + request.listId);
          console.debug(`loadListPinsById(${request.listId}): ${(performance.now() - t0).toFixed(1)}ms`);
          sendResponse({ success: true, pins: entity?.pins || [] });
          break;
        }

        case 'readCacheable': {
          try {
            const value = await readCacheable(request.key);
            sendResponse({ success: true, value });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'loadPermanentDeletes': {
          try {
            const keys = await readCacheable('list:system/permanent-deletes');
            sendResponse({ success: true, keys });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'getGatewayDomains': {
          try {
            const origins = await readCacheable('list:system/gateways');
            sendResponse({ success: true, origins });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
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
            let page = await cacheGet(key);
            if (!page) {
              const resp = await requestOffscreen({ action: 'loadPageBatch', slugs: [slug] });
              page = resp?.pages?.[slug] || {}; // Empty page is valid (no checkpoint yet)
            }

            // Resolve typed refs: page:<slug> → URL via readCacheable, shallow:<url> → extract URL
            async function resolveRefs(refs) {
              const urls = [];
              for (const ref of refs) {
                if (ref.startsWith('shallow:')) { urls.push(ref.slice(8)); continue; }
                if (ref.startsWith('page:')) {
                  const p = await readCacheable(ref);
                  if (p && p.url) urls.push(p.url);
                }
              }
              return urls;
            }

            // Parents: from page.parentIds, fallback to shallowPageIndex for non-checkpointed pages
            let parentRefs = page.parentIds || [];
            if (parentRefs.length === 0) {
              const spIndex = await readCacheable('list:system/shallow-page');
              const shallowEntry = spIndex.index[url];
              if (shallowEntry) parentRefs = shallowEntry.parentIds || [];
            }
            const parentReferrers = await resolveRefs(parentRefs);

            // Parents: lists containing this URL
            const parentLists = [];
            const listOrder = await getListOrder();
            for (const entry of listOrder) {
              const listSlug = entry.id.startsWith('list:') ? entry.id.slice(5) : entry.id;
              const listEntity = await readCacheable('list:' + listSlug);
              if (listEntity?.pins) {
                const pageId = 'page:' + slug;
                const shallowId = 'shallow:' + url;
                const inPinned = listEntity.pins.some(p => p.id === pageId || p.id === shallowId);
                if (inPinned) parentLists.push({ slug: listSlug, name: entry.name, type: 'pin' });
              }
            }

            // Children: from page.childIds (filter out notes, keep only pages/shallow) + shallowPageIndex inverse lookup
            const childRefs = (page.childIds || []).filter(c => !c.startsWith('note:'));
            let children = await resolveRefs(childRefs);
            // Also check shallowPageIndex for non-checkpointed children
            const spForChildren = await readCacheable('list:system/shallow-page');
            for (const [childUrl, shallowEntry] of Object.entries(spForChildren.index)) {
              const parentKey = 'page:' + slug;
              if ((shallowEntry.parentIds || []).includes(parentKey) && !children.includes(childUrl)) {
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

        case 'ensurePageCheckpoint': {
          await ensureCheckpointIfMissing(request.url, request.title);
          sendResponse({ success: true });
          break;
        }

        case 'saveSettings': {
          const s = request.settings;
          const ts = Date.now();
          for (const k of Object.keys(s)) {
            await addLog({ timestamp: ts, action: 'set', key: k, value: s[k] });
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
          await ensureCheckpointIfMissing(sender?.tab?.url, sender?.tab?.title);
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
          try {
            const { listId, url, id: requestId } = request;
            let pinId = requestId || (url ? await resolvePageId(url) : null);
            // Re-check shallow IDs — see resolveShallowIds comment.
            if (pinId?.startsWith('shallow:')) {
              pinId = await resolvePageId(pinId.slice(8));
            }
            const list = await readCacheable('list:' + listId);
            const pins = list?.pins || [];
            // Check both page:<slug> and shallow:<url> forms — a pin may have been
            // stored as shallow:<url> before the page was checkpointed.
            const altId = pinId.startsWith('page:')
              ? (url ? 'shallow:' + url : null)
              : (pinId.startsWith('shallow:') ? 'page:' + generateSlugFromUrl(pinId.slice(8)) : null);
            const matchIdx = pins.findIndex(p => p.id === pinId || (altId && p.id === altId));
            const isPinned = matchIdx !== -1;
            // When removing, use the ID actually stored in the pin
            const logId = isPinned ? pins[matchIdx].id : pinId;
            await addLog({
              timestamp: Date.now(), action: 'list', id: listId,
              op: isPinned ? 'del' : 'add', ids: [logId]
            });
            sendResponse({ success: true, pinned: !isPinned });
            notifyMutation('pins', { listId });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
          break;
        }

        case 'addListPins': {
          const ids = await Promise.all(request.urls.map(u => resolvePageId(u)));
          if (ids.length > 0) {
            await addLog({
              timestamp: Date.now(), action: 'list',
              id: request.listId, op: 'add', ids
            });
          }
          sendResponse({ success: true });
          notifyMutation('pins', { listId: request.listId });
          break;
        }

        case 'copyListPins': {
          try {
            const source = await readCacheable('list:' + request.fromListId);
            const ids = (source?.pins || []).map(p => p.id);
            if (ids.length > 0) {
              await addLog({
                timestamp: Date.now(), action: 'list',
                id: request.toListId, op: 'add', ids
              });
            }
            sendResponse({ success: true });
            notifyMutation('pins', { listId: request.toListId });
          } catch (error) {
            sendResponse({ success: false, error: error.message });
          }
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

        case 'setTestDirectory': {
          const resp = await requestOffscreen({ action: 'setTestDirectory' });
          if (resp?.success) {
            // Re-hydrate from the fresh OPFS directory
            hydrationDone = hydrateCache();
            await hydrationDone;
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
          // 3. Reset in-memory state
          recentUrls = new Set();
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          // 4. Tell offscreen to wipe directory and reset drain state
          await requestOffscreen({ action: 'resetDirectory' });
          // 5. Re-hydrate from (now empty) filesystem
          hydrationDone = hydrateCache();
          await hydrationDone;
          sendResponse({ success: true });
          break;
        }

        case 'rehydrateForTest': {
          // Clear caches and re-hydrate without wiping the directory.
          // Used after seedTestData to pick up seeded files.
          logBuffer = [];
          await chrome.storage.local.set({ logBuffer });
          await cacheClear();
          recentUrls = new Set();
          if (drainNotifyTimer) { clearTimeout(drainNotifyTimer); drainNotifyTimer = null; }
          hydrationDone = hydrateCache();
          await hydrationDone;
          sendResponse({ success: true });
          break;
        }

        case 'seedTestData': {
          const resp = await requestOffscreen({ action: 'seedTestData', files: request.files });
          sendResponse(resp);
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
