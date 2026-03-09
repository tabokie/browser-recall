// Shared utility functions

// Unified cache read: session cache → background readCacheable fallback.
// Keys use entity key format: 'settings', 'list:system/recycle-bin', etc.
export async function readCacheable(key, includeDeleted = false) {
  try {
    const cached = await chrome.storage.session.get([key]);
    if (key in cached) {
      if (!includeDeleted && cached[key]?.deleted) return null;
      return cached[key];
    }
  } catch (e) { console.warn('[readCacheable] session cache error:', e.message); }
  const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted });
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
function generateSlug(text, hashInput) {
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

// Compare two savedSearches arrays for equality (deep comparison).
// Returns true if they differ and a save is needed.
export function savedSearchesChanged(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

// Check if a URL's origin root is pinned in an auto-gateways pin list.
// pins: [{ id: 'page:<slug>' | 'shallow:<url>', pinnedAt }]
export function isGatewayOriginFromPins(url, pins) {
  try {
    const origin = new URL(url).origin;
    const rootUrl = origin + '/';
    const rootSlug = generateSlugFromUrl(rootUrl);
    return pins.some(p => p.id === `shallow:${rootUrl}` || p.id === `page:${rootSlug}`);
  } catch {
    return false;
  }
}

// Format timestamp to YYYY-MM-DD date key
export function dateKeyFromTimestamp(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Escape HTML entities for safe insertion into innerHTML
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Generate deterministic slug for a note entity
export function generateNoteSlug(timestamp, excerpt) {
  const d = new Date(timestamp);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const text = (Array.isArray(excerpt) ? excerpt.join(' ') : excerpt) || 'note';
  const hashInput = text + String(timestamp);
  return `${yy}${mm}${dd}-${generateSlug(text, hashInput)}`;
}
