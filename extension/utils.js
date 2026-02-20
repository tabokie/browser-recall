// Shared utility functions

// Load a single key from chrome.storage.session cache, falling back to settings.json via background
export async function loadSettingsValue(key, defaultValue) {
  // Fast path: read from chrome.storage.session cache
  try {
    const cached = await chrome.storage.session.get(key);
    if (key in cached) {
      console.debug(`[I/O] loadSettingsValue('${key}'): cache hit`);
      return cached[key];
    }
  } catch {}
  // Slow path: read from settings.json via background→offscreen
  console.debug(`[I/O] loadSettingsValue('${key}'): cache miss, reading from disk`);
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'loadSettings' });
    if (resp && resp.success && resp.settings && key in resp.settings) {
      return resp.settings[key];
    }
  } catch (error) {
    console.warn('loadSettingsValue failed, using default:', error.message);
  }
  return defaultValue;
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

// Generate slug from collection title for list file naming
export function generateSlugFromTitle(title) {
  // Hash title + timestamp for uniqueness
  const hashInput = title + Date.now();
  return generateSlug(title, hashInput);
}
