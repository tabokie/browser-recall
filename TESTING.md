# Testing the Extension in Chrome

## ✅ Setup Complete!

Your extension is now ready to load. Here's how to test it:

## Load Extension in Chrome

1. **Open Chrome Extensions Page**
   - Open Chrome browser
   - Go to `chrome://extensions/`
   - Or: Menu (⋮) → Extensions → Manage Extensions

2. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top right corner

3. **Load the Extension**
   - Click "Load unpacked" button
   - Navigate to and select this folder:
     ```
     /Users/xinye.tao/tabokie/extension-project/extension
     ```
   - Click "Select"

4. **Verify Installation**
   - You should see "Portal - Knowledge Management" in your extensions list
   - A blue icon should appear in your Chrome toolbar

## Test the Extension

### Basic Functionality Test

1. **Browse Some Websites**
   - Visit 3-5 different websites (news, documentation, blogs)
   - Spend a few seconds on each page
   - Try scrolling and highlighting some text
   - The extension will automatically capture these interactions

2. **Search Your History**
   - Click the Portal extension icon in your toolbar
   - You should see your recent visits listed
   - Type a search query (e.g., a word from a page title you visited)
   - Click "Search"
   - Try different ranking algorithms (Content, Context, etc.)
   - Click on a result to revisit that page

3. **Check Attention Tracking**
   - Open the extension options page:
     - Right-click the extension icon → "Options"
     - Or go to `chrome://extensions/` → Portal → "Extension options"
   - Check the statistics:
     - Total interactions count
     - Today's interactions
     - Storage used

4. **Test Search Algorithms**
   - Visit pages with specific keywords
   - Use the popup to search for those keywords
   - Try switching between different ranking algorithms to see different results

5. **Export Your Data**
   - In the options page, click "Export Data"
   - This will download a JSON file with all your interactions
   - Open it to see the captured data structure

### Advanced Testing

**Test Intent Capture:**
- Visit a search engine (Google, DuckDuckGo)
- Perform a search
- Visit one of the results
- Check the exported data - it should capture your search query as "intent"

**Test Attention Tracking:**
- Visit a long article
- Scroll to the bottom (watch scroll depth)
- Highlight some text
- Stay on the page for 30+ seconds
- Export data and check the "attention" field for that interaction

**Test Content Extraction:**
- Visit different types of pages (article, product page, docs)
- Export data and check how content is extracted

## Debugging

### View Console Logs

**Background Service Worker:**
- Go to `chrome://extensions/`
- Find "Portal - Knowledge Management"
- Click "Inspect views: service worker"
- Check console for WASM initialization and interaction logs

**Content Script:**
- Visit any webpage
- Open DevTools (F12 or Cmd+Opt+I)
- Check the Console tab
- You should see logs about interaction capture

**Popup:**
- Click the extension icon to open popup
- Right-click anywhere in the popup → "Inspect"
- Check console for search operations

### Common Issues

**Extension not appearing:**
- Make sure Developer mode is enabled
- Check for errors on the `chrome://extensions/` page
- Try clicking "Reload" button on the extension card

**No interactions captured:**
- Check the background service worker console for errors
- Make sure content script is injected (check webpage console)
- Verify permissions in manifest.json

**Search not working:**
- Check popup console for JavaScript errors
- Verify WASM module loaded (look for "WASM module initialized" in background worker)
- Make sure you have at least one interaction stored

## What to Look For

The extension should:
- ✅ Automatically capture page visits without any user action
- ✅ Extract page title, URL, and timestamp
- ✅ Capture search queries from URL parameters
- ✅ Track scroll depth, time on page, text highlights
- ✅ Store all data locally (check chrome://extensions → Storage)
- ✅ Allow searching through captured interactions
- ✅ Support different ranking algorithms
- ✅ Export data as JSON

## Next Steps

After testing the basics:
1. Browse normally for a day to collect real data
2. Try different search queries and ranking algorithms
3. Review the exported data to understand what's captured
4. Think about additional features from DESIGN.md to implement
5. Customize the Rust search algorithms in `src/lib.rs`

## Need Help?

- Check BUILD.md for build instructions
- Check README.md for architecture overview
- Check console logs for errors
- Look at the source code in `extension/` for how it works
