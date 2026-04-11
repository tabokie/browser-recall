// Unified session cache — manages chrome.storage.session with LRU eviction + pin/unpin.
//
// All session reads/writes in background.js go through this layer.
// Pinned keys are never evicted under normal conditions. Unpinned keys are
// evicted LRU-first when count exceeds EVICTION_LIMIT, but only if
// timestamp <= persistWatermark (i.e., already flushed to disk).
//
// Exception: emergencyEvict() (quota recovery) removes ALL keys with
// timestamp <= persistWatermark, including pinned keys. This intentionally
// violates the pin contract as a last-resort measure to recover from
// quota exhaustion. Only dirty/unflushed entries are protected.

import { logError } from './logger.js';
import { LIST_PREFIX, MANIFEST_PREFIX } from './entity-types.js';

let lruKeys = []; // LRU order: oldest at index 0, newest at end
const keyTimestamps = new Map(); // key → timestamp for watermark guard
const pinnedKeys = new Set();
let persistWatermark = 0;
const EVICTION_LIMIT = 500; // max unpinned keys before eviction

// ─── Quota Exhausted Callback ────────────────────────────────────────
// Registered by background.js to call pauseService without circular imports.
let onQuotaExhausted = null;

export function setQuotaExhaustedCallback(cb) {
  onQuotaExhausted = cb;
}

// ─── Default Pin Policy ───────────────────────────────────────────────
// Returns true if key should be pinned by default (never evicted).

function defaultPinned(key) {
  if (key === 'workspace') return true;
  if (key.startsWith(MANIFEST_PREFIX)) return true; // settings, orphaned, name-to-id — small metadata, always needed
  if (key.startsWith(LIST_PREFIX)) return true; // user lists + system lists — small metadata
  // page:*, note:*, log:* → not pinned by default
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────

export function setEntityCacheWatermark(ts) {
  persistWatermark = ts;
}

export function cachePin(key) {
  pinnedKeys.add(key);
}

export function cacheUnpin(key) {
  pinnedKeys.delete(key);
}

export async function cacheGet(key) {
  const data = await chrome.storage.session.get([key]);
  if (key in data) {
    // Touch: move to end of LRU
    const idx = lruKeys.indexOf(key);
    if (idx >= 0) lruKeys.splice(idx, 1);
    lruKeys.push(key);
    return data[key];
  }
  return null;
}

export async function cacheSet(key, value, { timestamp } = {}) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      logError('Session quota exceeded, attempting emergency eviction');
      await emergencyEvict();
      try {
        await chrome.storage.session.set({ [key]: value });
      } catch (retryErr) {
        if (retryErr.name === 'QuotaExceededError') {
          logError('Session quota still exceeded after emergency eviction');
          onQuotaExhausted?.();
          return false;
        }
        throw retryErr;
      }
    } else {
      throw e;
    }
  }
  // Update LRU position
  const idx = lruKeys.indexOf(key);
  if (idx >= 0) lruKeys.splice(idx, 1);
  lruKeys.push(key);
  // Track timestamp — auto-extract max from timestamps map if not provided
  if (timestamp === undefined) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.timestamps
    ) {
      const vals = Object.values(value.timestamps);
      timestamp = vals.length ? Math.max(...vals) : 0;
    } else {
      timestamp = 0;
    }
  }
  keyTimestamps.set(key, timestamp);
  // Apply default pin for new keys
  if (defaultPinned(key)) pinnedKeys.add(key);
  // Evict if needed
  await evict();
  return true;
}

export async function cacheClear() {
  await chrome.storage.session.clear();
  lruKeys = [];
  keyTimestamps.clear();
  pinnedKeys.clear();
  persistWatermark = 0;
}

export async function cacheRemove(key) {
  await chrome.storage.session.remove([key]);
  const idx = lruKeys.indexOf(key);
  if (idx >= 0) lruKeys.splice(idx, 1);
  keyTimestamps.delete(key);
  pinnedKeys.delete(key);
}

// ─── Emergency Eviction (quota exceeded) ─────────────────────────────
// Aggressively evicts ALL keys with timestamp <= persistWatermark,
// including pinned keys. Only dirty entries (above watermark) are protected.
// Ignores pin status and EVICTION_LIMIT — this is a last-resort measure.

async function emergencyEvict() {
  const toRemove = [];
  for (const key of lruKeys) {
    const ts = keyTimestamps.get(key) || 0;
    if (ts > persistWatermark) continue; // dirty — protect
    toRemove.push(key);
  }
  if (toRemove.length > 0) {
    await chrome.storage.session.remove(toRemove);
    const removeSet = new Set(toRemove);
    lruKeys = lruKeys.filter((k) => !removeSet.has(k));
    for (const k of toRemove) {
      keyTimestamps.delete(k);
      pinnedKeys.delete(k);
    }
  }
}

// ─── Eviction ─────────────────────────────────────────────────────────

async function evict() {
  let unpinnedCount = 0;
  for (const k of lruKeys) {
    if (!pinnedKeys.has(k)) unpinnedCount++;
  }
  if (unpinnedCount <= EVICTION_LIMIT) return;

  const toRemove = [];
  for (const key of lruKeys) {
    if (unpinnedCount <= EVICTION_LIMIT) break;
    if (pinnedKeys.has(key)) continue;
    const ts = keyTimestamps.get(key) || 0;
    if (ts > persistWatermark) continue; // unflushed — protect
    toRemove.push(key);
    unpinnedCount--;
  }

  if (toRemove.length > 0) {
    await chrome.storage.session.remove(toRemove);
    const removeSet = new Set(toRemove);
    lruKeys = lruKeys.filter((k) => !removeSet.has(k));
    for (const k of toRemove) keyTimestamps.delete(k);
  }
}
