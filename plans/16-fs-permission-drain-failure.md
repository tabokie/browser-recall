# 16 — FS Permission → Drain Failure Path

## Context

Depends on plan 12 (downtime infrastructure). When filesystem permission is revoked mid-session, drain silently fails and retries every 30s (offscreen.js:444). It never surfaces to the user. 

Decision from grilling: fold into drain failure path. After N consecutive drain failures, trigger `pauseService`. No separate FS permission detection — it's just one cause of "drain stuck." The settings page shows the specific error with a suggested action.

## Design

### Track consecutive drain failures in background.js

The drain flow: background sends `drainEntries` to offscreen, offscreen writes to disk, offscreen sends back `persisted` watermark. If drain fails, no watermark comes back.

Add a drain failure counter:

```js
let consecutiveDrainFailures = 0;
const DRAIN_FAILURE_THRESHOLD = 12;  // 12 × 5s = 60s of stuck drain
```

### Where to detect drain failure

The `drainNow()` function (background.js ~166-177) sends entries to offscreen. It's fire-and-forget — no response expected. The success signal is the `persisted` watermark message in `handleOffscreenResponse`.

Approach: on each `scheduleDrainNotify` cycle, if `logBuffer.length > 0` and no watermark has been received since the last drain attempt, increment the failure counter. On successful watermark receipt, reset to 0.

```js
// In handleOffscreenResponse, on 'persisted':
consecutiveDrainFailures = 0;
if (isServicePaused() && serviceError?.code === 'fs_permission') {
  resumeService();
}

// In drainNow or scheduleDrainNotify cycle:
// After sending drain, schedule a check
if (logBuffer.length > 0) {
  consecutiveDrainFailures++;
  if (consecutiveDrainFailures >= DRAIN_FAILURE_THRESHOLD) {
    pauseService('fs_permission', 'Storage drain has failed for 60+ seconds. File system permission may have been revoked.');
  }
}
```

Subtlety: the counter should only increment when there ARE entries to drain. If logBuffer is empty, drain "failing" is irrelevant.

### Auto-resume on permission re-grant

When the settings page `resumeService` action fires (user clicked "Re-grant Access" and re-selected directory), the background:
1. Calls `resumeService()` to clear error state
2. Re-triggers `setupOffscreenDocument()` + `connectToOffscreen()`
3. Resets `consecutiveDrainFailures = 0`
4. Calls `scheduleDrainNotify()` to flush buffered entries

### Files to modify

| File | Action |
|------|--------|
| `extension/background.js` | Add drain failure tracking, integrate with `handleOffscreenResponse` and `drainNow`, add auto-resume logic |

### Verification

1. Unit test: simulate 12 drain cycles with no watermark response. Verify `pauseService('fs_permission')` fires.
2. Unit test: watermark received resets counter to 0.
3. Unit test: `resumeService` after permission re-grant clears error and resets counter.
4. E2E test: revoke FS permission (if testable), verify downtime icon appears after ~60s.
5. Full test suite: `npm test && npx playwright test`.
