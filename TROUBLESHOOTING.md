# Troubleshooting: No Page Views Being Recorded

I've added comprehensive logging to help diagnose the issue. Follow these steps:

## Step 1: Reload the Extension

1. Go to `chrome://extensions/`
2. Find "Portal - Knowledge Management"
3. Click the **Reload** button (circular arrow icon)
4. This loads the updated code with better logging

## Step 2: Check Service Worker Console

1. On `chrome://extensions/`, find the Portal extension
2. Click on **"Inspect views: service worker"** (blue link)
3. A DevTools window will open - this is the background script console

You should see:
```
Background script loading...
Portal extension installed
Initializing WASM module...
✓ WASM module initialized successfully
✓ Storage initialized
```

If you see errors here, that's the problem! Copy the error message.

## Step 3: Visit the Test Page

1. Open this file in Chrome: `/Users/xinye.tao/tabokie/extension-project/test-page.html`
   - Or drag and drop the file into Chrome
   - Or use: `file:///Users/xinye.tao/tabokie/extension-project/test-page.html`

2. Watch the **service worker console** (keep it open)

You should see logs like:
```
Tab 123 updated: loading file:///...
Tab 123 updated: complete file:///...
Processing page: file:///...
Created interaction: 1707512345-file:///...
✓ Message sent to content script
Interaction data: {...}
✓ Stored interaction #1: Portal Extension Test Page
```

## Step 4: Check Content Script

1. On the test page, open DevTools (F12)
2. Go to the Console tab

You should see:
```
Portal content script loaded on: file:///...
Content script received message: {action: "captureInteraction", ...}
Captured data - Intent: 0, Content length: 1234
✓ Sent data back to background
```

## Step 5: Verify Storage

In the **service worker console**, run this command:
```javascript
chrome.storage.local.get(['interactions'], (result) => {
  console.log('Total interactions:', result.interactions.length);
  console.log('Data:', result.interactions);
});
```

You should see at least 1 interaction.

## Step 6: Check the Popup

1. Click the Portal extension icon
2. Right-click in the popup → "Inspect"
3. Check the console for errors
4. You should see recent interactions listed

## Common Issues and Solutions

### Issue: No "service worker" link

**Symptom:** Can't find "Inspect views: service worker" on chrome://extensions

**Solution:** The service worker might be inactive. Visit a webpage to activate it, then check again.

### Issue: WASM initialization error

**Symptom:** `✗ Failed to initialize WASM: ...`

**Solution:** The WASM file path might be wrong. Check that `extension/pkg/portal_extension_bg.wasm` exists.

### Issue: No "content script loaded" message

**Symptom:** Content script console message doesn't appear on webpages

**Solution:**
- Check manifest.json permissions
- Try reloading the extension
- Check if content_scripts are properly configured

### Issue: Tab logs say "Skipping chrome internal URL"

**Symptom:** Visits to `chrome://` pages are skipped (this is normal)

**Solution:** Visit regular `http://` or `https://` pages, or use the test-page.html

### Issue: "Could not send message to content script"

**Symptom:** Warning about content script message

**Solution:** This can be normal if the page loads before content script is ready. The interaction should still be stored.

### Issue: Permissions error

**Symptom:** `Cannot access chrome:// URLs` or similar

**Solution:** This is expected. Visit normal web pages (http:// or https://) instead.

## Still Not Working?

If you've followed all steps and still see no interactions:

1. **Copy all console logs** from the service worker console
2. **Copy any error messages** from the test page console
3. **Check storage** with the command in Step 5
4. **Try a regular website** like https://example.com instead of the test page

Share the console output and I can help debug further!

## Quick Test Commands

Run these in the **service worker console**:

```javascript
// Check if WASM is loaded
console.log('WASM initialized:', wasmInitialized);

// Check storage
chrome.storage.local.get(null, (result) => {
  console.log('All storage:', result);
});

// Manually create a test interaction
(async () => {
  await initializeWasm();
  const test = new Interaction('https://test.com', 'Test Page');
  const data = await test.toJSON();
  console.log('Test interaction:', data);
})();
```
