# 27 — Content & Popup Cleanup

## Context

### content.js (1194 lines)
- `showGlobalNoteOverlay()` (lines 221-319, 98 lines) and `showHighlightEditOverlay()` (lines 588-729, 142 lines): Parallel shadow-DOM overlay implementations sharing ~80% of code (CSS, textarea, auto-resize, close logic). Differ in: positioning strategy, delete button, save/close callbacks.
- Three notification bubbles (`showCaptureNotification` lines 824-855, `showLikeNotification` lines 858-889, `showErrorNotification` lines 892-920): ~65 lines of identical CSS + DOM + lifecycle code across 3 functions. Only message text, background color, and animation timing differ.
- `extractMarkdown()` (lines 28-167, 140 lines): Deep `processNode`/`processChildren` recursion with 13-case switch, hard to follow but not duplicated. Lower priority.

### popup.js (915 lines)
- `showDashboard()` (lines 694-806, 113 lines): 5 phases mixed together: re-attach content, set up metadata, fetch page data, render sections, 1s title re-check for SPAs.
- Main init IIFE (lines 809-905, 97 lines): Linear happy path with guard clauses, not deeply nested but could be clearer with named phases.

## Design

### Part A: Unify content.js overlays

Extract `createNoteOverlay(config)`:

```js
function createNoteOverlay({
  position,       // 'centered' | { nearElement, offsetY }
  existingNote,   // string or ''
  showDeleteBtn,  // boolean
  placeholder,    // string
  onSave,         // (noteText) => void
  onDelete,       // () => void | null
}) {
  // Shared: create host element, shadow DOM, CSS, textarea with auto-resize,
  // Escape-to-save, outside-click-to-close, blur-to-save
  // Positioning: centered (fixed, transform) or near element (absolute, calculated)
}
```

`showGlobalNoteOverlay()` becomes:
```js
function showGlobalNoteOverlay(existingNote, existingNoteSlug, pageSlug) {
  createNoteOverlay({
    position: 'centered',
    existingNote,
    showDeleteBtn: false,
    placeholder: 'Add a note about this page...',
    onSave: (text) => { /* sendMessage createNote/updateNote */ },
  });
}
```

`showHighlightEditOverlay()` becomes:
```js
function showHighlightEditOverlay(mark, text, noteSlug, existingNote, pageSlug) {
  createNoteOverlay({
    position: { nearElement: mark, offsetY: 8 },
    existingNote,
    showDeleteBtn: true,
    placeholder: 'Add a note...',
    onSave: (text) => { /* sendMessage updateNote */ },
    onDelete: () => { /* sendMessage deleteNote, unwrapHighlightMark */ },
  });
}
```

Note: content.js is a non-module script, so everything stays in the same file.

### Part B: Notification bubble factory

Extract `showNotificationBubble(config)`:

```js
function showNotificationBubble({ message, backgroundColor, iconHtml, duration }) {
  // Shared: create host, attachShadow, styles, animation, auto-remove after duration
}
```

Three existing functions become one-liners:
```js
function showCaptureNotification() {
  showNotificationBubble({ message: 'Page snapshot saved', backgroundColor: '#2563eb', iconHtml: '📸', duration: 1600 });
}
```

### Part C: Split popup.js showDashboard into phases

```js
async function showDashboard() {
  reattachDashboardContent();                    // Private mode exit: re-attach DOM
  const { slug, url, title } = resolvePageIdentity(currentTab);  // URL, slug, title
  const pageData = await fetchPageData(slug);    // getPageInfo RPC
  renderDashboardSections(pageData);             // List chips, workspace bar, notes, snapshots
  scheduleDelayedTitleCheck(url, title);         // 1s re-check for SPA title mutations
}
```

Each phase is a small named function (~15-25 lines). `resolvePageIdentity` is pure (no side effects), making it easy to test.

### Part D: Name popup.js init phases

The main IIFE (lines 809-905) becomes:

```js
async function initPopup() {
  applyTheme();
  const deviceId = await verifyDeviceIdentity();     // getDeviceId + error check
  const tab = await resolveActiveTab();               // chrome.tabs.query
  const effectiveUrl = await resolveEffectiveUrl(tab); // SPA mutation detection
  if (isPrivateMode()) return showPrivateModeUI();
  if (await isBlacklisted(effectiveUrl)) return showBlacklistUI(tab, effectiveUrl);
  await showDashboard();
}
```

## Files changed

1. **content.js** — restructure overlays + notification factory (net ~100 line reduction)
2. **popup.js** — extract showDashboard phases + name init phases

## Test strategy

- E2E tests are the safety net:
  - Highlights: `tests/e2e/highlight-note-edit.spec.js`, `tests/e2e/page-note-detail.spec.js`
  - Popup: `tests/e2e/popup-*.spec.js`
  - Notifications: covered by capture/highlight E2E tests
- No unit tests for content.js (non-module script)
- popup.js: add unit tests for `resolvePageIdentity` if it's pure

## Risk

Low. Both files have E2E coverage. The overlay unification is the highest-value change.
