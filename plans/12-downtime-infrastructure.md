# 12 — Downtime Icon + Error State Infrastructure

## Context

Multiple fatal conditions (session quota, local quota, offscreen crash loop, FS permission loss) need a unified response: pause the background service and show a downtime icon. The settings page should display the specific error and a suggested action. This plan builds the shared infrastructure that plans 13-16 plug into.

## Design

### Error state model in `background.js`

```js
// Possible error codes:
// 'session_quota'    — chrome.storage.session full, all entries dirty
// 'local_quota'      — chrome.storage.local full (logBuffer)
// 'offscreen_crash'  — offscreen document crash loop
// 'fs_permission'    — filesystem permission revoked (drain stuck)
let serviceError = null;  // null = healthy, { code, message, timestamp } = paused
```

When `serviceError` is set:
1. Set downtime icon via `chrome.action.setIcon({ path: { 16: 'icons/icon16-down.png', ... } })`
2. Stop processing new mutations (early return in `addLog`, `processPageReport`, message handlers)
3. Store error in `chrome.storage.session.set({ serviceError: { code, message, timestamp } })` so settings page can read it

When error is cleared (e.g., user re-grants permission):
1. Restore normal icon
2. Resume processing
3. Clear session storage error

### Functions

```js
function pauseService(code, message) {
  serviceError = { code, message, timestamp: Date.now() };
  chrome.action.setIcon({ path: { 16: 'icons/icon16-down.png', 48: 'icons/icon48-down.png', 128: 'icons/icon128-down.png' } });
  chrome.storage.session.set({ serviceError }).catch(() => {});
  logError(`Service paused: [${code}] ${message}`);
}

function resumeService() {
  serviceError = null;
  chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
  chrome.storage.session.remove(['serviceError']).catch(() => {});
  logDebug('Service resumed');
}

function isServicePaused() {
  return serviceError !== null;
}
```

### Downtime icons

Need 3 grayscale/red-tinted variants of the existing icons: `icon16-down.png`, `icon48-down.png`, `icon128-down.png`. Generate programmatically from existing icons (desaturate + red tint).

### Settings page error banner

In `options.html`, add a hidden error banner div at the top of the page (above sidebar). In `options.js`, on `initialize()`, read `chrome.storage.session.get(['serviceError'])` and show the banner if set. Each error code maps to a specific message and action:

| Code | Message | Action |
|------|---------|--------|
| `fs_permission` | "Storage access was revoked" | "Re-grant Access" button → `fsStorage.selectDirectory()` then `sendAction('resumeService')` |
| `session_quota` | "Session storage full" | "Reload Extension" button → `chrome.runtime.reload()` |
| `local_quota` | "Local storage full" | "Reload Extension" button |
| `offscreen_crash` | "Storage worker crashed" | "Reload Extension" button |

### Message handler in background.js

Add `resumeService` action handler that clears the error state and re-triggers hydration.

### Guard in mutation paths

At the top of `addLog()` and key message handlers, check `isServicePaused()` and return early with `{ success: false, error: 'Service paused', code: serviceError.code }`.

### Files to modify

| File | Action |
|------|--------|
| `extension/background.js` | Add `pauseService`/`resumeService`/`isServicePaused`, add guards to mutation paths, add `resumeService` message handler |
| `extension/options.html` | Add error banner HTML |
| `extension/options.js` | Read `serviceError` on init, show banner with action buttons |
| `extension/icons/icon16-down.png` | **New** — downtime icon |
| `extension/icons/icon48-down.png` | **New** — downtime icon |
| `extension/icons/icon128-down.png` | **New** — downtime icon |

### Verification

1. Unit test: `pauseService` sets icon and session state, `resumeService` clears both, `isServicePaused` returns correct value.
2. Unit test: `addLog` returns error when service is paused.
3. E2E test: trigger a paused state (e.g., mock quota error), verify downtime icon appears and settings page shows the error banner with correct message.
4. E2E test: click "Reload Extension" / "Re-grant Access" and verify recovery path.
5. Full test suite: `npm test && npx playwright test`.
