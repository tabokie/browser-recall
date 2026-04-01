# 11 — Debug Logger + Console Cleanup

## Context

The extension has ~127 `console.*` calls across 12 files — a mix of `console.log` (status), `console.warn` (recoverable), and `console.error` (fatal). For a public Chrome Web Store release, debug spew in devtools is unprofessional and makes real errors hard to spot. We need a two-level logger (debug/error) with a session-stored toggle, exposed as a checkbox in the settings page.

This plan covers both creating the logger module AND the mechanical replacement of all `console.*` calls.

## Design

### Logger module: `extension/logger.js`

New ES module exporting two functions:

```js
export function logDebug(...args)  // gated by session flag, no-op when off
export function logError(...args)  // always logs via console.error
```

On module load, read `chrome.storage.session.get(['debugLogging'])` to initialize the gate. Listen to `chrome.storage.onChanged` for live toggle without page reload.

`logDebug` calls `console.log(...)` when enabled. `logError` calls `console.error(...)` always.

### Settings UI toggle

Add a "Debug Logging" checkbox to the settings modal in `options.html`. On change, write to `chrome.storage.session.set({ debugLogging: bool })`. Non-persistent — resets on browser restart.

### Console call replacement

Replace across all `extension/*.js` files:
- `console.log(...)` → `logDebug(...)`
- `console.warn(...)` → `logDebug(...)` (these are informational warnings, not errors)
- `console.error(...)` → `logError(...)`
- `console.debug(...)` → `logDebug(...)`

Exception: `content.js` is a non-module content script — it cannot import ES modules. Keep its 8 console calls as-is, or inline a minimal logger. Since content script logs are per-tab and less noisy, leaving them is acceptable for v1.

Similarly, `savepage/content.js` and `savepage/content-fontface-intercept.js` are non-module scripts — leave their console calls as-is.

### Files to modify

| File | Action |
|------|--------|
| `extension/logger.js` | **New** — logger module |
| `extension/background.js` | Import logger, replace ~53 console calls |
| `extension/options.js` | Import logger, replace ~8 console calls, add toggle handler |
| `extension/popup.js` | Import logger, replace ~20 console calls |
| `extension/offscreen.js` | Import logger, replace ~10 console calls |
| `extension/savepage-bridge.js` | Import logger, replace ~8 console calls |
| `extension/utils.js` | Import logger, replace ~2 console calls |
| `extension/filesystem-storage.js` | Import logger, replace ~2 console calls |
| `extension/snapshot-viewer.js` | Import logger, replace ~1 console call |
| `extension/options.html` | Add debug logging checkbox to settings modal |
| `extension/content.js` | Leave as-is (non-module) |
| `extension/savepage/content.js` | Leave as-is (non-module) |

### Verification

1. Unit tests: test that `logDebug` is silent when flag is off, logs when on.
2. E2E: enable debug logging in settings, verify console output appears. Disable, verify silence.
3. Run `npx knip --include exports` to confirm no dead console references remain.
4. Full test suite: `npm test && npx playwright test`.
