// Entity LRU cache — manages chrome.storage.session entity entries
// Keys are full entity keys: 'page:slug', 'note:slug', etc.

let cacheKeys = []; // LRU order, most recent at end
const cacheTimestamps = new Map(); // key → timestamp for O(1) eviction check
let persistWatermark = 0;
const CACHE_LIMIT = 500;

export function setEntityCacheWatermark(ts) {
  persistWatermark = ts;
}

export async function getCachedEntity(key) {
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached) {
    // Move to end (most recently used)
    cacheKeys = cacheKeys.filter(k => k !== key);
    cacheKeys.push(key);
    return cached;
  }
  return null;
}

export async function setCachedEntity(key, entity) {
  await chrome.storage.session.set({ [key]: entity });
  cacheKeys = cacheKeys.filter(k => k !== key);
  cacheKeys.push(key);
  cacheTimestamps.set(key, entity?.timestamp || 0);
  // Evict if over limit — only evict entities already flushed to disk
  while (cacheKeys.length > CACHE_LIMIT) {
    const candidate = cacheKeys[0];
    const ts = cacheTimestamps.get(candidate) || 0;
    if (ts > persistWatermark) break; // all remaining above watermark, skip
    cacheKeys.shift();
    cacheTimestamps.delete(candidate);
    await chrome.storage.session.remove(candidate);
  }
}
