// Atom LRU cache — manages chrome.storage.session atom entries

let atomCacheKeys = []; // LRU order, most recent at end
const ATOM_CACHE_LIMIT = 500;

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
  // Evict if over limit
  while (atomCacheKeys.length > ATOM_CACHE_LIMIT) {
    const evict = atomCacheKeys.shift();
    await chrome.storage.session.remove('atom:' + evict);
  }
}
