// Atom LRU cache — manages chrome.storage.session atom entries

let atomCacheKeys = []; // LRU order, most recent at end
const atomTimestamps = new Map(); // slug → timestamp for O(1) eviction check
let persistWatermark = 0;
const ATOM_CACHE_LIMIT = 500;

export function setAtomCacheWatermark(ts) {
  persistWatermark = ts;
}

export async function getCachedAtom(slug) {
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

export async function setCachedAtom(slug, atom) {
  const key = 'atom:' + slug;
  await chrome.storage.session.set({ [key]: atom });
  atomCacheKeys = atomCacheKeys.filter(k => k !== slug);
  atomCacheKeys.push(slug);
  atomTimestamps.set(slug, atom?.timestamp || 0);
  // Evict if over limit — only evict atoms already flushed to disk
  while (atomCacheKeys.length > ATOM_CACHE_LIMIT) {
    const candidate = atomCacheKeys[0];
    const ts = atomTimestamps.get(candidate) || 0;
    if (ts > persistWatermark) break; // all remaining above watermark, skip
    atomCacheKeys.shift();
    atomTimestamps.delete(candidate);
    await chrome.storage.session.remove('atom:' + candidate);
  }
}
