# 14 — Session Storage Quota Handling

## Context

Depends on plan 12 (downtime infrastructure). `cacheSet` in `entity-cache.js:52` calls `chrome.storage.session.set()` with no try/catch. If the 10MB session storage quota is exceeded, the write throws and the whole `cacheSet` fails. If the failed entry is dirty (timestamp > persistWatermark), its data exists only in logBuffer — not on disk, not in cache.

Decision from grilling: on quota error, aggressively evict all clean entries (respect watermark rule). If still failing (all remaining entries are dirty), pause via `pauseService`.

## Design

### Modify `cacheSet` in entity-cache.js

Wrap the `chrome.storage.session.set` call in try/catch. On `QuotaExceededError`:

1. **Aggressive eviction**: call a new `emergencyEvict()` that evicts ALL unpinned keys with `timestamp <= persistWatermark` (ignores the 500 limit). Also evict pinned-but-clean keys (timestamp <= persistWatermark) — losing the "always cached" guarantee temporarily is acceptable.
2. **Retry the write** once after emergency eviction.
3. **If retry fails**: all remaining entries are dirty. Call a pause callback.

### Pause callback pattern

`entity-cache.js` shouldn't import `background.js` (circular). Instead, add a registration function:

```js
let onQuotaExhausted = null;

export function setQuotaExhaustedCallback(cb) {
  onQuotaExhausted = cb;
}
```

`background.js` registers the callback at startup:

```js
setQuotaExhaustedCallback(() => {
  pauseService('session_quota', 'Session storage full — all cached entities are dirty (unflushed). This usually means drain is stuck.');
});
```

### Modified `cacheSet`

```js
export async function cacheSet(key, value, { timestamp } = {}) {
  // ... timestamp extraction (unchanged) ...

  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (e) {
    if (e.message?.includes('QUOTA_BYTES') || e.message?.includes('quota')) {
      logError('Session quota exceeded, attempting emergency eviction');
      await emergencyEvict();
      try {
        await chrome.storage.session.set({ [key]: value });
      } catch (retryErr) {
        logError('Session quota still exceeded after emergency eviction');
        onQuotaExhausted?.();
        return; // Don't update LRU tracking for failed write
      }
    } else {
      throw e; // Re-throw non-quota errors
    }
  }

  // ... LRU tracking, pin, evict (unchanged) ...
}
```

### `emergencyEvict`

```js
async function emergencyEvict() {
  const toRemove = [];
  for (const key of lruKeys) {
    const ts = keyTimestamps.get(key) || 0;
    if (ts > persistWatermark) continue; // dirty — protect
    toRemove.push(key);
  }
  if (toRemove.length > 0) {
    await chrome.storage.session.remove(toRemove);
    const removeSet = new Set(toRemove);
    lruKeys = lruKeys.filter(k => !removeSet.has(k));
    for (const k of toRemove) {
      keyTimestamps.delete(k);
      pinnedKeys.delete(k);
    }
  }
}
```

Key difference from regular `evict()`: ignores pin status, ignores 500 limit. Only respects the watermark rule.

### Files to modify

| File | Action |
|------|--------|
| `extension/entity-cache.js` | Add try/catch in `cacheSet`, add `emergencyEvict`, add `setQuotaExhaustedCallback`, import logger |
| `extension/background.js` | Import and call `setQuotaExhaustedCallback` at startup |

### Verification

1. Unit test: mock `chrome.storage.session.set` to throw quota error on first call, succeed on second. Verify emergency eviction runs and write succeeds on retry.
2. Unit test: mock both calls failing. Verify `onQuotaExhausted` callback fires.
3. Unit test: verify `emergencyEvict` removes clean entries (including pinned) but protects dirty entries.
4. Full test suite: `npm test && npx playwright test`.
