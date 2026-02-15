// Shared utility functions

// Load a single key from chrome.storage.local cache, falling back to settings.json via offscreen
export async function loadSettingsValue(key, defaultValue) {
  // Fast path: read from chrome.storage.local cache
  try {
    const cached = await chrome.storage.local.get(key);
    if (key in cached) {
      console.debug(`[I/O] loadSettingsValue('${key}'): cache hit`);
      return cached[key];
    }
  } catch {}
  // Slow path: read from settings.json via offscreen
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

// Save a single key to settings.json via offscreen, and update chrome.storage.local cache
export async function saveSettingsValue(key, value) {
  try {
    await chrome.runtime.sendMessage({ action: 'saveSettingsKey', key, value });
  } catch (error) {
    console.warn('saveSettingsValue file write failed:', error.message);
  }
  // Update cache
  await chrome.storage.local.set({ [key]: value });
}

// Generate slug from URL for content file naming
export function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const base = (domain + parsed.pathname)
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 30).replace(/-+$/, '');
    // Short hash of full URL for uniqueness (query params, fragments, etc.)
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
    }
    const hashStr = Math.abs(hash).toString(36);
    const slug = `${base}-${hashStr}`;
    return slug.substring(0, 80);
  } catch {
    return 'untitled';
  }
}
