# Debugging Steps

## Step 1: Check Background Service Worker

1. Open Chrome and go to `chrome://extensions/`
2. Find "Portal - Knowledge Management"
3. Click on "Inspect views: service worker" (blue link)
4. Look for errors in the console
5. Check if you see "WASM module initialized" or any error messages

## Step 2: Check Content Script on a Webpage

1. Visit any website (e.g., https://example.com)
2. Open DevTools (F12 or Cmd+Opt+I)
3. Go to the Console tab
4. Look for any Portal extension messages or errors
5. Check if content.js is loaded in the Sources tab

## Step 3: Check Storage

In the service worker console (from Step 1), run:
```javascript
chrome.storage.local.get(['interactions', 'settings'], (result) => {
  console.log('Stored data:', result);
});
```

## Step 4: Manually Test WASM Loading

In the service worker console, check if WASM module exists:
```javascript
console.log('Location:', self.location.href);
```

## Common Issues

1. **WASM module path issue** - Service worker can't find the WASM file
2. **Content script not injecting** - Permissions or timing issue
3. **Message passing failing** - Chrome API context issue
4. **Storage permissions** - Missing permissions

Please run these checks and let me know what errors you see!
