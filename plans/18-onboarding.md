# 18 — Onboarding Screen

## Context

Depends on plans 11-17 being done (logger, dark mode available). When a user installs the extension and opens the options page for the first time, there's no directory configured. Currently, `initialize()` in options.js calls `getDeviceId` which fails, triggering `showFatalError` — a white screen with "Device identity unavailable."

Decision from grilling: single screen that IS the options page when no directory handle exists. Shows explanation + directory picker (required) + device name (optional) + sync setup (optional, collapsed). Once directory is granted, transitions to normal home screen.

## Design

### Detection

The options page already checks device identity at startup (options.js:3978). Before that check, query whether a directory handle exists:

```js
async function initialize() {
  // Check if first run (no directory configured)
  const hasDir = await sendAction('hasDirectoryHandle');
  if (!hasDir) {
    showOnboarding();
    return;  // Don't proceed with normal init
  }
  // ... existing init code ...
}
```

Add `hasDirectoryHandle` action in background.js that asks offscreen if a handle is stored in IndexedDB.

### Onboarding UI

Replace the page content (hide sidebar + main) with a centered onboarding card:

```html
<div id="onboarding" style="display:none;">
  <div class="onboarding-card">
    <h1>browser-recall</h1>
    <p class="onboarding-desc">
      browser-recall saves your browsing history, notes, and highlights to a local folder you control.
      Your data never leaves your device unless you choose to sync it.
    </p>
    
    <div class="onboarding-section onboarding-required">
      <h3>Choose a storage directory</h3>
      <p>All your data will be saved as readable files in this folder.</p>
      <button id="onboardingDirBtn">Choose Directory</button>
      <span id="onboardingDirStatus"></span>
    </div>
    
    <div class="onboarding-section onboarding-optional" style="display:none;">
      <h3>Optional settings</h3>
      
      <label>Device name (for multi-device sync)</label>
      <input id="onboardingDeviceName" placeholder="Auto-generated if empty" />
      
      <details>
        <summary>GitHub Sync</summary>
        <label>Repository URL</label>
        <input id="onboardingSyncRepo" placeholder="https://github.com/user/repo" />
        <label>Personal Access Token</label>
        <input id="onboardingSyncToken" type="password" />
      </details>
    </div>
    
    <button id="onboardingStartBtn" disabled>Get Started</button>
  </div>
</div>
```

### Flow

1. Page loads → `initialize()` → `hasDirectoryHandle` returns false → `showOnboarding()`
2. Hide `.sidebar`, `.main-content`. Show `#onboarding`.
3. User clicks "Choose Directory" → `showDirectoryPicker()` via `fsStorage.selectDirectory()`
4. On success: show directory name, reveal optional settings section, enable "Get Started" button
5. On cancel: stay on same screen, button still available
6. User clicks "Get Started":
   - If device name provided, save it via `sendAction('setDeviceName', ...)`
   - If sync configured, save settings
   - Send `initializeFilesystem` to background
   - Hide onboarding, run normal `initialize()` flow

### Styling

Use the same CSS variables and design language as the rest of the options page — frosted glass card, warm palette, `--font-display` for headings. The onboarding card should be centered vertically and horizontally with a max-width of ~520px.

### Files to modify

| File | Action |
|------|--------|
| `extension/options.html` | Add `#onboarding` HTML structure |
| `extension/options.js` | Add `showOnboarding()`, modify `initialize()` to check for directory, add onboarding event handlers |
| `extension/background.js` | Add `hasDirectoryHandle` message handler |
| `extension/offscreen.js` | Add `hasDirectoryHandle` handler (checks IndexedDB for stored handle) |

### Verification

1. E2E test: fresh install (no directory handle), verify onboarding screen appears.
2. E2E test: pick directory on onboarding, verify "Get Started" enables, click it, verify normal options page loads.
3. E2E test: dismiss directory picker, verify onboarding stays visible with button available.
4. E2E test: set optional device name during onboarding, verify it persists.
5. E2E test: existing install (directory configured), verify onboarding does NOT appear.
6. Full test suite: `npm test && npx playwright test`.
