# 13 — Offscreen Crash Recovery

## Context

Depends on plan 12 (downtime infrastructure). When the offscreen document dies, all promises in `portCallbacks` hang forever. The lazy reconnect via `ensureOffscreenPort()` already re-creates the document and port on the next request, but pending promises are never resolved or rejected.

Decision from grilling: auto-restart + fail pending promises (option B). If crash-loops, trigger `pauseService('offscreen_crash', ...)`.

## Design

### Reject pending promises on disconnect

In `connectToOffscreen()` (background.js:71-80), expand the `onDisconnect` handler:

```js
offscreenPort.onDisconnect.addListener(() => {
  offscreenPort = null;
  // Reject all pending RPC promises
  for (const [id, resolve] of portCallbacks) {
    resolve({ success: false, error: 'Offscreen document disconnected' });
  }
  portCallbacks.clear();
  logDebug('Offscreen port disconnected, rejected pending callbacks');
  // Track crash frequency for crash-loop detection
  trackOffscreenDisconnect();
});
```

Note: we `resolve` with an error object rather than rejecting the promise, because callers already check `resp?.success`. This avoids adding try/catch to every `requestOffscreen` call site.

### Crash-loop detection

```js
const offscreenDisconnects = [];  // timestamps of recent disconnects
const CRASH_LOOP_THRESHOLD = 3;   // disconnects within window = crash loop
const CRASH_LOOP_WINDOW_MS = 60_000;  // 1 minute

function trackOffscreenDisconnect() {
  const now = Date.now();
  offscreenDisconnects.push(now);
  // Prune old entries
  while (offscreenDisconnects.length && offscreenDisconnects[0] < now - CRASH_LOOP_WINDOW_MS) {
    offscreenDisconnects.shift();
  }
  if (offscreenDisconnects.length >= CRASH_LOOP_THRESHOLD) {
    pauseService('offscreen_crash', `Storage worker crashed ${CRASH_LOOP_THRESHOLD} times in ${CRASH_LOOP_WINDOW_MS / 1000}s`);
  }
}
```

### Callers handle reconnect naturally

`requestOffscreen` already calls `ensureOffscreenPort()` which re-creates the document. After a single crash:
1. Pending promises resolve with `{ success: false }`
2. Next `requestOffscreen` call triggers reconnect
3. Offscreen document re-initializes from IndexedDB (`initDone`)
4. Background entity cache is unaffected (lives in service worker memory)
5. `scheduleDrainNotify()` fires on reconnect (already in `connectToOffscreen`)

### Files to modify

| File | Action |
|------|--------|
| `extension/background.js` | Expand `onDisconnect` handler, add crash-loop detection, add `trackOffscreenDisconnect` |

### Verification

1. Unit test: mock port disconnect, verify all pending callbacks receive `{ success: false }`.
2. Unit test: trigger 3 disconnects within 60s, verify `pauseService` is called with `offscreen_crash`.
3. Unit test: single disconnect does not trigger pause.
4. E2E test: verify extension recovers from a single offscreen restart (next action works).
5. Full test suite: `npm test && npx playwright test`.
