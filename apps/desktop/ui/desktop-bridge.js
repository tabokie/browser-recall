import { logDebug } from './logger.js';

async function invokeBridgeAction(request) {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke('bridge_action', { request });
  }
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke('bridge_action', { request });
  }
  throw new Error('Tauri invoke bridge unavailable');
}

export async function sendAction(msg) {
  const resp = await invokeBridgeAction(msg);
  if (resp?.success === false) {
    throw new Error(resp.error || `${msg.action} failed`);
  }
  return resp ?? {};
}

export async function readDesktopValue(key, includeDeleted = false) {
  const resp = await sendAction({
    action: 'readDesktopValue',
    key,
    includeDeleted,
  });
  return resp?.value;
}

let settingsCache = null;
let settingsCachePromise = null;

export async function loadSettings() {
  if (!settingsCachePromise) {
    settingsCachePromise = readDesktopValue('manifest:settings')
      .then((settings) => {
        settingsCache = settings || {};
        return settingsCache;
      })
      .catch((error) => {
        settingsCachePromise = null;
        throw error;
      });
  }
  return settingsCachePromise;
}

export async function loadSettingsValue(key, defaultValue) {
  const settings = await loadSettings();
  const value = settings?.[key];
  return value !== undefined ? value : defaultValue;
}

export function invalidateSettingsCache() {
  settingsCache = null;
  settingsCachePromise = null;
}

export async function saveSettingsValue(key, value) {
  try {
    await sendAction({ action: 'saveSettingsKey', key, value });
    settingsCache = { ...(settingsCache || {}), [key]: value };
    settingsCachePromise = Promise.resolve(settingsCache);
  } catch (error) {
    logDebug('saveSettingsValue failed:', error.message);
  }
}

export function reloadApp() {
  window.location.reload();
}
