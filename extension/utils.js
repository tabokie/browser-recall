// Shared utility functions

// Load a single key from settings.json via offscreen
export async function loadSettingsValue(key, defaultValue) {
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
    const base = (parsed.hostname + parsed.pathname)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
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
