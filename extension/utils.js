// Shared utility functions

// Unified cache read: session cache → background readCacheable fallback.
// Keys use entity key format: 'settings', 'list:system/recycle-bin', etc.
export async function readCacheable(key) {
  try {
    const cached = await chrome.storage.session.get([key]);
    if (key in cached) return cached[key];
  } catch (e) { console.warn('[readCacheable] session cache error:', e.message); }
  const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key });
  if (resp?.success === false) {
    throw new Error(resp.error || `Failed to load ${key}`);
  }
  return resp?.value;
}

// Read a settings sub-key from the unified settings entity.
export async function loadSettingsValue(key, defaultValue) {
  const settings = await readCacheable('settings');
  const v = settings?.[key];
  return v !== undefined ? v : defaultValue;
}

// Send a message to background and throw on error response.
// Use for all data-reading messages where silent defaults are unacceptable.
export async function sendAction(msg) {
  const resp = await chrome.runtime.sendMessage(msg);
  if (resp?.success === false) throw new Error(resp.error || `${msg.action} failed`);
  return resp ?? {};
}

// Save a single key to settings.json via background, which updates session cache + buffers write
export async function saveSettingsValue(key, value) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveSettingsKey', key, value });
  } catch (error) {
    console.warn('saveSettingsValue file write failed:', error.message);
  }
}

// Generic slug generation: normalize text + hash for uniqueness
export function generateSlug(text, hashInput) {
  if (!text || text.trim() === '') {
    text = 'untitled';
  }
  // Normalize: lowercase, replace non-alphanumeric with hyphens, trim to 30 chars
  const base = text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');

  // Short hash for uniqueness
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36);
  const slug = `${base}-${hashStr}`;
  return slug.substring(0, 80);
}

// Generate slug from URL for content file naming
export function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const text = domain + parsed.pathname;
    // Hash the full URL for uniqueness (includes query params, fragments, etc.)
    return generateSlug(text, url);
  } catch {
    return 'untitled';
  }
}

// Generate slug from list title for list file naming
export function generateSlugFromTitle(title) {
  // Hash title + timestamp for uniqueness
  const hashInput = title + Date.now();
  return generateSlug(title, hashInput);
}

// Collect qbTrees from explore blocks for saving to list metadata.
// Returns deep copies of all manual block trees.
export function collectQbTrees(blocks) {
  return blocks
    .filter(b => b.type === 'manual' && b.tree)
    .map(b => JSON.parse(JSON.stringify(b.tree)));
}

// Compare two qbTrees arrays for equality (deep comparison).
// Returns true if they differ and a save is needed.
export function qbTreesChanged(oldTrees, newTrees) {
  return JSON.stringify(oldTrees) !== JSON.stringify(newTrees);
}

// Generate deterministic slug for a note entity
// Check if a URL is the root page of a gateway origin
export function isGatewayRoot(url, origins) {
  try {
    const urlObj = new URL(url);
    return origins.includes(urlObj.origin) && (urlObj.pathname === '/' || urlObj.pathname === '') && urlObj.search === '';
  } catch {
    return false;
  }
}

export function generateNoteSlug(timestamp, excerpt) {
  const d = new Date(timestamp);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const text = (Array.isArray(excerpt) ? excerpt.join(' ') : excerpt) || 'note';
  const hashInput = text + String(timestamp);
  return `${yy}${mm}${dd}-${generateSlug(text, hashInput)}`;
}
