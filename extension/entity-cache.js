// Unified session cache — manages chrome.storage.session with LRU eviction + pin/unpin.
//
// All session reads/writes in background.js go through this layer.
// Pinned keys are never evicted. Unpinned keys are evicted LRU-first
// when count exceeds EVICTION_LIMIT, but only if timestamp <= persistWatermark
// (i.e., already flushed to disk).

let lruKeys = []; // LRU order: oldest at index 0, newest at end
const keyTimestamps = new Map(); // key → timestamp for watermark guard
const pinnedKeys = new Set();
let persistWatermark = 0;
const EVICTION_LIMIT = 500; // max unpinned keys before eviction

// ─── Default Pin Policy ───────────────────────────────────────────────
// Returns true if key should be pinned by default (never evicted).

function defaultPinned(key) {
  if (key === 'settings') return true;
  if (key === 'workspace') return true;
  if (key.startsWith('list:')) return true; // user lists + system lists — small metadata
  // page:*, note:*, history:* → not pinned by default
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
  await chrome.storage.session.set({ [key]: value });
  // Update LRU position
  const idx = lruKeys.indexOf(key);
  if (idx >= 0) lruKeys.splice(idx, 1);
  lruKeys.push(key);
  // Track timestamp — auto-extract from object if not provided
  if (timestamp === undefined) {
    timestamp = (value && typeof value === 'object' && !Array.isArray(value))
      ? (value.timestamp || 0)
      : 0;
  }
  keyTimestamps.set(key, timestamp);
  // Apply default pin for new keys
  if (defaultPinned(key)) pinnedKeys.add(key);
  // Evict if needed
  await evict();
}

export async function cacheRemove(key) {
  await chrome.storage.session.remove([key]);
  const idx = lruKeys.indexOf(key);
  if (idx >= 0) lruKeys.splice(idx, 1);
  keyTimestamps.delete(key);
  pinnedKeys.delete(key);
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
    lruKeys = lruKeys.filter(k => !removeSet.has(k));
    for (const k of toRemove) keyTimestamps.delete(k);
  }
}

// ─── Backward Compatibility ───────────────────────────────────────────

export async function getCachedEntity(key) {
  return await cacheGet(key);
}

export async function setCachedEntity(key, entity) {
  await cacheSet(key, entity, { timestamp: entity?.timestamp || 0 });
}
