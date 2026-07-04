# 00 — Import Browser Bookmarks

## Context

No ingestion path for existing browser bookmarks. Users switching to browser-recall must manually recreate their bookmark organization. This plan adds a one-time import: the user exports bookmarks from their browser as an HTML file, picks it in the settings modal, selects folders via a tree picker, and imports them as nested lists with pinned pages.

All design decisions resolved through grilling session (Q1-Q22).

## Design Decisions

- **File-based import** — user exports bookmarks HTML from browser, picks file in extension. No `chrome.bookmarks` permission needed. Cross-browser compatible (Chrome, Firefox, Edge all export Netscape Bookmark Format).
- **Settings modal section** — file input + folder tree + import button, all inline in a new settings section.
- **Wrapping parent list** — each import creates `"Imported Bookmarks (YYYY-MM-DD HH:MM)"` as the root list. Repeated imports don't collide.
- **Pin-only** — bookmark URLs become `pin_to_list` entries. No synthetic `visit_page` events. Page entities created via `ensurePageEntity` during pin replay.
- **Titles via pin_to_list** — bookmark titles passed in `titles` map. No `rename_page` overrides — real titles replace them when user visits the page.
- **Folder picker with tri-state checkboxes** — native `<input type="checkbox">` with `indeterminate` state. Folders only (no individual URLs). Each folder shows `(N bookmarks, M subfolders)` counts.
- **Collapsible tree** — toggle arrows to expand/collapse. Top-level folders expanded, deeper levels collapsed by default.
- **All unchecked by default** — user opts in to specific folders.
- **URL filtering** — only `http://` and `https://` URLs imported. Non-web URLs (`javascript:`, `chrome://`, `file://`, `data:`, empty) counted as failures and shown to user.
- **Error handling** — skip-and-continue for bookmark pin failures (abort after 20). Abort immediately on list creation failure. Show failure list with specific URLs at the end.
- **Port-based progress** — `chrome.runtime.connect()` port from options.js to background.js. Background sends text progress updates (`"Creating list 3/5..."`, `"Pinning bookmarks 20/47..."`). Displayed below import button.
- **Parse in options.js** — `DOMParser` parses the bookmark HTML client-side. Structured tree sent to background.js in one message via port.

## Files to Modify

| File | Change |
|------|--------|
| `extension/options.html` | New settings section: file input, tree container, import button, progress/failure text |
| `extension/options.js` | HTML parser, tree picker UI (render, tri-state logic, collapse), port-based import trigger |
| `extension/background.js` | New port handler: walk selected tree, create lists via `addLog(create_list)`, pin URLs via `addLog(pin_to_list)`, send progress |
| `tests/bookmark-parser.test.js` | Unit tests for HTML→tree parser (edge cases: nested, empty, malformed, non-web URLs) |
| `tests/e2e/import-bookmarks.spec.js` | E2E: load fixture file, interact with picker, import, verify lists in sidebar |
| `CODEBASE_MAP.md` | Document new import feature, message handler, parser |

## Implementation

### Step 1: Bookmark HTML parser (unit-tested first)

Pure function in `extension/bookmark-parser.js`:

```javascript
/**
 * Parse Netscape Bookmark Format HTML into a folder tree.
 * @param {string} html - Raw HTML string from exported bookmarks file.
 * @returns {{ title: string, children: FolderNode[] }}
 *
 * FolderNode = {
 *   title: string,
 *   bookmarks: { url: string, title: string }[],  // http(s) only
 *   skipped: { url: string, title: string, reason: string }[],  // non-web URLs
 *   children: FolderNode[],
 *   // Computed:
 *   bookmarkCount: number,   // recursive count of bookmarks in this subtree
 *   subfolderCount: number,  // direct child folder count
 * }
 */
export function parseBookmarkHtml(html) { ... }
```

**Parsing approach:**
- `new DOMParser().parseFromString(html, 'text/html')`
- Walk `<DL>` elements recursively. `<DT><H3>` = folder, `<DT><A href>` = bookmark.
- Filter URLs: only keep `http://` and `https://`. Others go to `skipped[]` with reason.
- Compute `bookmarkCount` recursively (own + children's).

**Unit tests** (`tests/bookmark-parser.test.js`):
- Basic tree with folders and bookmarks
- Nested folders (3+ levels)
- Empty folders (bookmarkCount = 0)
- Mixed URL schemes — `javascript:`, `chrome://`, `file://`, `data:`, empty href
- Missing `<A>` href attribute
- Bookmark titles with special characters
- Minimal valid file (single bookmark, no folders)
- Malformed HTML (unclosed tags — DOMParser handles gracefully)

### Step 2: Settings UI — file input + tree picker

**HTML** (new section in settings modal, before Data Management):

```html
<div class="modal-section">
  <h3>Import Bookmarks</h3>
  <p>Import bookmarks exported from any browser (HTML format).</p>
  <div class="import-file-row">
    <input type="file" id="bookmarkFileInput" accept=".html,.htm" />
  </div>
  <div id="bookmarkTreeContainer" class="bookmark-tree-container">
    <!-- placeholder text, then populated by JS after file load -->
  </div>
  <div class="modal-btn-group">
    <button id="importBookmarksBtn" class="btn btn-primary" disabled>Import Selected</button>
  </div>
  <div id="importProgress"></div>
  <div id="importFailures"></div>
</div>
```

**CSS:**
- `.bookmark-tree-container` — max-height ~300px, overflow-y auto, border, padding. Placeholder text when empty.
- `.bookmark-tree-item` — flex row: toggle arrow (12px) + checkbox + label + count badge. Indentation via `padding-left: depth * 16px`.
- `.bookmark-tree-item .toggle` — CSS arrow (border-based triangle), rotates 90deg when expanded. Hidden for leaf folders (no children).
- Tri-state checkbox: native checkbox, `.indeterminate` set via JS.

**Tree picker JS** (in options.js):

```
File input change → FileReader.readAsText → parseBookmarkHtml → renderTree
```

`renderTree(container, nodes, depth)`:
- For each folder node: create `.bookmark-tree-item` with checkbox, toggle, label, counts.
- Click toggle → expand/collapse children container.
- Checkbox change → propagate: check/uncheck all descendants, update ancestors to checked/unchecked/indeterminate.
- Enable "Import Selected" button when ≥1 folder is checked.

**Tri-state propagation logic:**
- Check a folder → check all descendants.
- Uncheck a folder → uncheck all descendants.
- After any change, walk up to root: if all children checked → parent checked. If none → parent unchecked. If mixed → parent indeterminate.

### Step 3: Background handler — port-based import

New port handler in background.js `onConnect` (or add to existing port listener):

```javascript
// Port name: 'import-bookmarks'
port.onMessage.addListener(async (msg) => {
  if (msg.action !== 'importBookmarks') return;
  const { tree } = msg;  // Selected folder tree from options.js
  const deviceId = await getDeviceId();
  const failures = [];
  let listCount = 0, bookmarkCount = 0, failCount = 0;
  const FAIL_LIMIT = 20;

  // Create wrapping parent list
  const parentName = `Imported Bookmarks (${new Date().toLocaleString()})`;
  const parentEntry = { timestamp: Date.now(), action: 'create_list', listOwner: deviceId, name: parentName };
  const parentEffects = await addLog(parentEntry);
  const parentListId = extractListId(parentEffects);  // find 'list:*' key in effects

  async function processFolder(node, parentId) {
    // Create list
    const createEntry = {
      timestamp: Date.now(), action: 'create_list',
      listOwner: deviceId, name: node.title || 'Untitled',
    };
    if (parentId) createEntry.parentListId = parentId;
    let effects;
    try {
      effects = await addLog(createEntry);
    } catch (e) {
      // List creation failure → abort
      port.postMessage({ type: 'error', message: 'Failed to create list: ' + node.title });
      return false;  // signal abort
    }
    listCount++;
    const listId = extractListId(effects);
    port.postMessage({ type: 'progress', text: `Creating list ${listCount}...` });

    // Pin bookmarks
    if (node.bookmarks.length > 0 && listId) {
      const pn = await getListEventFields(listId);
      if (pn) {
        const urls = [], titles = {};
        for (const bm of node.bookmarks) {
          urls.push(bm.url);
          if (bm.title) titles[bm.url] = bm.title;
        }
        try {
          const pinEntry = {
            timestamp: Date.now(), action: 'pin_to_list',
            name: pn.name, listOwner: pn.listOwner, items: urls,
          };
          if (Object.keys(titles).length > 0) pinEntry.titles = titles;
          await addLog(pinEntry);
          bookmarkCount += urls.length;
        } catch (e) {
          failures.push(...urls.map(u => ({ url: u, reason: e.message })));
          failCount += urls.length;
        }
      }
    }

    // Add skipped URLs to failures
    for (const s of node.skipped || []) {
      failures.push({ url: s.url, title: s.title, reason: s.reason });
      failCount++;
    }

    if (failCount >= FAIL_LIMIT) {
      port.postMessage({ type: 'error', message: `Too many failures (${failCount}), aborting.` });
      return false;
    }

    // Recurse children
    for (const child of node.children || []) {
      const ok = await processFolder(child, listId);
      if (ok === false) return false;
    }
    port.postMessage({ type: 'progress', text: `Pinning bookmarks ${bookmarkCount}...` });
    return true;
  }

  for (const folder of tree) {
    const ok = await processFolder(folder, parentListId);
    if (ok === false) break;
  }

  notifyMutation('lists');
  port.postMessage({ type: 'done', listCount, bookmarkCount, failures });
  port.disconnect();
});
```

**Helper:** `extractListId(effects)` — finds the first key matching `list:*` in the effects object, returns the ID portion.

### Step 4: E2E tests

**Fixture file:** `tests/fixtures/bookmarks.html` — small Netscape Bookmark Format file with:
- 2 top-level folders (Bookmarks Bar with 3 URLs + 1 subfolder, Other Bookmarks with 1 URL)
- 1 nested subfolder with 2 URLs
- 1 `javascript:` bookmark (should be in failures)
- 1 empty folder

**Test cases** (`tests/e2e/import-bookmarks.spec.js`):
1. **File load shows tree** — pick fixture file, verify folder names and counts render
2. **Tri-state checkboxes** — check parent, verify children checked. Uncheck one child, verify parent indeterminate.
3. **Collapse/expand** — click toggle, verify children hidden/shown
4. **Import selected folders** — check one folder, click import, verify list appears in sidebar with correct pins
5. **Import nested folders** — check parent with nested subfolder, verify nested lists created
6. **Progress and completion** — verify progress text appears, then completion summary
7. **Failures shown** — import fixture with `javascript:` bookmark, verify failure list displayed
8. **Empty selection** — no folders checked, import button disabled

### Step 5: Update docs

- **CODEBASE_MAP.md** — add `bookmark-parser.js` to file index, add import handler to message routing table, add feature→code mapping
- **ARCHITECTURE.md** — no changes needed (import uses existing event-sourced patterns)

## Verification

1. `npm test` — all existing + new parser unit tests pass
2. `npx playwright test` — all existing + new E2E tests pass
3. Manual test: export bookmarks from Chrome, import in extension, verify lists and pins in sidebar
