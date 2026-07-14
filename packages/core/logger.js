// Debug logger — two levels: debug (gated) and error (always).
// Toggle via chrome.storage.session debugLogging flag.

let debugEnabled = false;

// Initialize from session storage (guarded for test environments)
if (typeof chrome !== 'undefined' && chrome.storage?.session) {
  chrome.storage.session
    .get(['debugLogging'])
    .then(({ debugLogging }) => {
      debugEnabled = !!debugLogging;
    })
    .catch((error) => {
      console.error('[logger] Failed to read debug logging setting:', error);
    });
}

// Live toggle without page reload
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && 'debugLogging' in changes) {
      debugEnabled = !!changes.debugLogging.newValue;
    }
  });
}

export function logDebug(...args) {
  if (debugEnabled) console.log(...args);
}

export function logError(...args) {
  console.error(...args);
}
