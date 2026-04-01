# 15 — Local Storage Quota Guard (LogBuffer)

## Context

Depends on plan 12 (downtime infrastructure). `logBuffer` is persisted to `chrome.storage.local` (10MB quota shared). If drain fails repeatedly, logBuffer grows unbounded toward the quota. On quota hit, `addLog` fails and mutations are lost.

Decision from grilling: pause with downtime icon on quota hit. No silent data loss — new events are lost only while paused, which is acceptable.

## Design

### Wrap `chrome.storage.local.set({ logBuffer })` calls

There are 7 call sites in background.js that write logBuffer to local storage (lines 87, 184, 232, 542, 1368, 1984, 2004, 2015). Each needs try/catch.

Rather than wrapping each call site individually, extract a helper:

```js
async function persistLogBuffer() {
  try {
    await chrome.storage.local.set({ logBuffer });
  } catch (e) {
    if (e.message?.includes('QUOTA_BYTES') || e.message?.includes('quota')) {
      pauseService('local_quota', `Local storage full — logBuffer has ${logBuffer.length} undrained entries. Drain may be stuck.`);
    }
    throw e;
  }
}
```

Replace all `chrome.storage.local.set({ logBuffer })` calls with `await persistLogBuffer()`.

Exception: the `handleOffscreenResponse` call at line 87 (`chrome.storage.local.set({ logBuffer })`) is fire-and-forget (no `await`). This one is safe — it's *shrinking* the logBuffer after drain, so it can't cause quota overflow. Leave it as-is or wrap it for consistency.

### Files to modify

| File | Action |
|------|--------|
| `extension/background.js` | Add `persistLogBuffer` helper, replace `chrome.storage.local.set({ logBuffer })` calls |

### Verification

1. Unit test: mock `chrome.storage.local.set` to throw quota error. Verify `pauseService` is called with `local_quota`.
2. Unit test: normal writes succeed without triggering pause.
3. Full test suite: `npm test && npx playwright test`.
