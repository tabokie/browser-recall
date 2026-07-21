# 33 — Desktop Split, Phase 3: UI Port

> Part of [29-desktop-split-master.md](./29-desktop-split-master.md). After [32-phase-2](./32-desktop-phase-2-replay-port.md).

## Goal

Move the main UI (`options.html`/`options.js` and dependencies) into the Tauri webview. Port the popup to use WebSocket RPC. Move sync into the daemon. Reach **full feature parity** with the current extension.

After this phase, the connector extension is genuinely thin: capture, popup, buffer. Everything else lives in the desktop app.

## The shim layer (build first)

`apps/desktop/ui/extension-api-shim.js` — the only new code that lets the verbatim port work. Re-implements the `chrome.*` surfaces that `options.js` and its dependencies use:

```js
// chrome.runtime.sendMessage({action, ...args})  →  invoke(action, args)
chrome.runtime.sendMessage = async (msg) => {
  if (typeof msg === 'object' && msg.action) {
    return window.__TAURI__.invoke(msg.action, msg);
  }
  // ... fallback for other shapes
};

// chrome.storage.session  →  in-memory Map + cross-window event emitter
chrome.storage.session = sessionStorageShim();

// chrome.storage.onChanged  →  Tauri event channel from daemon
chrome.storage.onChanged = onChangedShim();

// chrome.tabs.create({url})  →  shell.open
// chrome.contextMenus  →  no-op (replaced by app menu)
// chrome.commands  →  no-op (replaced by app keyboard shortcuts)
```

Loaded as the first script in `index.html`. Every UI module requires this to be in place before its own code runs.

## Files that move

```
apps/extension/options.html   →  apps/desktop/ui/index.html
apps/extension/options.js     →  apps/desktop/ui/index.js
apps/extension/virtual-scroller.js
apps/extension/time-chart.js
apps/extension/qb-tree.js
apps/extension/search-helpers.js  →  packages/core/search-helpers.js (used by both)
apps/extension/highlight-helpers.js
apps/extension/related-scoring.js
apps/extension/attention-utils.js  →  packages/core/attention-utils.js (used by both)
apps/extension/entity-types.js     →  packages/core/entity-types.js (used by both)
apps/extension/utils.js            →  split: slug helpers to packages/core, readCacheable rewritten
apps/extension/theme.js            →  apps/desktop/ui/theme.js (loses chrome.storage.session backing)
apps/extension/shared.css
apps/extension/color-schemes.css
apps/extension/dark-theme.css
apps/extension/color-scheme-map.js
apps/extension/fonts/
```

## Tauri commands (the daemon's RPC surface)

Every `action` the existing UI sends becomes a Tauri command. Most are read-side; mutations go through the same WebSocket event channel as the connector (mutations from the UI are events too — `pin_to_list`, `create_note`, etc.).

Approximate command set (~30 commands, mirroring current background.js handlers):

- `read_cacheable(key)` — returns entity or null.
- `load_page_batch(slugs)` — batch entity load.
- `load_all_pages()`, `load_all_list_metadata()`, `load_settings()`.
- `get_history_for_date(date)`, `get_history_range(start, end)`.
- `search_pages(query, limit)`, `search_notes(query)`, `search_snapshots(query)`.
- `submit_event(entry)` — emit any log entry from the UI (pin/unpin, rename, rate, create-list, etc.).
- `import_bookmarks(html)`, `import_history(entries)`.
- `get_directory_size()`, `clear_sync_directory()`.
- `pair_browser_revoke(browserId)`, `list_paired_browsers()` — settings UI for the Connected Browsers page.

Define these in `crates/daemon/src/commands.rs`; reuse `crates/replay/` for any submit-event path.

## Popup port

`apps/extension/popup.html` and `popup.js` stay in the extension but rewire their data path:

- Add a single command on the connector: `getPageSummary(url)` → WebSocket RPC to daemon → returns one payload with everything the popup needs.
  ```js
  {
    page: { slug, title, url, ... } | null,
    notes: [...],
    snapshots: [...],
    lists: [...],
    attention: { totalSeconds, lastVisit, ... }
  }
  ```
- Popup mutations (pin, unpin, rate, create note) go through the same event-streaming path: construct entry, hand to connector, connector forwards to daemon.
- Popup degrades cleanly when daemon is offline: shows "Browser Recall offline. Open the app to view your data." with a "Try to reconnect" button. Same as Q4's degradation rule.

## Sync port

Move `sync-manager.js` and `sync-transport-github.js` into the daemon (`crates/daemon/src/sync/`):

- Keep the existing logic — it's mostly fetch + JSON, no Chrome APIs.
- Drop `sync-transport-webdav.js`. Document removal in CHANGELOG.
- Drop `sync-transport-filesystem.js` as a transport. Document the "point your data folder at Syncthing" pattern in `DEVELOPMENT.md`.
- Sync runs continuously: push on logBuffer drain (cheap, piggybacks); pull on a 5-minute timer (configurable in settings).
- GitHub OAuth: move `github-oauth.js` into the daemon. PAT entry happens in the desktop UI's settings page.

## Settings UI updates

The settings page gains:

- **Connected Browsers** section: list of paired `{browser, profile, lastSeen}`, with a Revoke button per row. Revoke deletes the token from daemon config.
- **Login Item** toggle: read/write `app.setLoginItemSettings()` equivalent.

Removes:
- File System Access permission re-grant UI (no longer applies).
- Offscreen-related diagnostics.

Sync interval is hardcoded at 5 minutes for v1; not a settings element. Move-folder is not in v1.

## Connector extension manifest diff

Permissions and declarations that change from the current manifest:

| Key | Keep | Drop | Notes |
|---|:---:|:---:|---|
| `permissions: tabs` | ✓ | | Visit detection, active-tab lookups |
| `permissions: activeTab` | ✓ | | Popup actions |
| `permissions: webNavigation` | ✓ | | `onCommitted` for referrer + visit events |
| `permissions: storage` | ✓ | | Buffer + token + session UI state |
| `permissions: scripting` | ✓ | | Content script injection for Save Page WE |
| `permissions: commands` | ✓ | | Keyboard shortcuts (Alt+S, Alt+H, Alt+L, Alt+D) |
| `permissions: contextMenus` | ✓ | | Right-click actions |
| `permissions: bookmarks` | ✓ | | Bookmark import (triggered from desktop UI) |
| `permissions: history` | ✓ | | History import (triggered from desktop UI) |
| `permissions: unlimitedStorage` | | ✓ | No large local storage needed; 8MB buffer fits default quota |
| `permissions: offscreen` | | ✓ | No more offscreen document |
| `host_permissions: <all_urls>` | ✓ | | Content scripts on all pages |
| `content_security_policy.sandbox` | | ✓ | `fn-rule-sandbox.html` goes away |
| `background.service_worker` | ✓ | | Still SW-based; logic is slim |
| `web_accessible_resources` (fontface-intercept) | ✓ | | Save Page WE still needs it |

Update `docs/STORE_LISTING.md` permission justifications to match the new list.

## Connector extension options page (stub)

Replace the current `options.html`/`options.js` in the connector with a ~40-line stub:

```html
<!-- apps/extension/options-stub.html -->
<!doctype html>
<html>
  <body>
    <main>
      <h1>Browser Recall</h1>
      <p>
        The main Browser Recall interface runs in the desktop app.
      </p>
      <button id="openApp">Open Browser Recall</button>
      <p id="notRunning" hidden>
        Can't open the app? Launch it from your Applications folder, then try again.
      </p>
    </main>
    <script src="options-stub.js"></script>
  </body>
</html>
```

`options-stub.js`: `document.getElementById('openApp').addEventListener('click', () => window.open('browser-recall://open'))`. If the scheme is unregistered (app not installed), show the fallback message after a short timeout.

## Popup "Open in app" button

Popup gains a button in the header: "Open in app →". Click handler: `window.open('browser-recall://open?url=' + encodeURIComponent(currentTabUrl))`. Daemon's deep-link handler opens the main window focused on that page's detail view. Registered in Phase 1 (decision 23).

## What gets deleted from the connector extension

After this phase, `apps/extension/` contains only:

- `manifest.json` (much smaller permission list — no `unlimitedStorage`, no `offscreen`, fewer host permissions if any).
- `background.js` (slimmed: capture orchestration, content script messaging, popup messaging, connector lifecycle).
- `content.js` and `savepage/` (page capture; unchanged).
- `popup.html`/`popup.js` (rewired to RPC).
- `connector/` (ws-client, pairing, event-buffer).

Files removed entirely from the extension:
- `offscreen.html`, `offscreen.js`
- `port-contract.js`
- `filesystem-storage.js`, `filesystem-sync-storage.js`
- `entity-cache.js` (cache lives in daemon)
- `replay.js` (already moved to Rust in Phase 2)
- `sync-manager.js`, `sync-transport-*.js`
- `fn-rule-sandbox.html`, `fn-rule-sandbox.js` (function rules eval in daemon now)
- `vendor/` WASM artifacts (search runs in daemon as native code, not extension WASM)

## Tests

- **`crates/daemon/tests/commands.rs`** — every Tauri command exercised end-to-end.
- **WebDriver tests against the Tauri app** — render history list, run a search, pin a page, open recycle bin. Covers the UI port surface.
- **`tests/integration/popup-rpc.test.js`** — Node WebSocket client mimics popup; assert `getPageSummary` returns expected payload.
- Existing replay tests continue to pass (no changes to replay logic in this phase).

## End state

- Tauri main window renders history, search, lists, recycle bin, settings — all visually identical to current extension.
- Popup in real Chrome shows page summary by RPC; pin/unpin/note/rate work and are reflected in the desktop UI within ~100ms via change broadcast.
- Sync to GitHub works from the daemon, including push on flush + 5-minute pull.
- Connector extension has no FS-Access code paths.
- All command tests pass; WebDriver UI tests cover the main flows.

## Risks

- **WebKit/CSS surprises.** macOS WebKit may render some current CSS differently than Chromium. Audit early in this phase: scrollbars, sticky headers, font rendering, focus rings. Fix with vendor prefixes or alternative properties.
- **`chrome.storage.onChanged` semantics across windows.** The shim must broadcast change events to *all* open Tauri webviews. Tauri's event system handles this; verify with a multi-window manual test.
- **Bookmarks/history import** still requires the extension. Document the user flow: "Click Import in the desktop app → confirm in browser popup → done."
- **Settings UI bloat.** "Connected Browsers" and "Login Item" sections are net-new UI work. Keep them simple — don't over-design in this phase.
