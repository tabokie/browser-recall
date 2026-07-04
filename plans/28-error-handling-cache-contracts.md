# 28 — Error Handling & Cache Contracts

## Context

The audit and deep exploration found correctness risks beyond structural complexity:
- Silent error swallowing hiding data loss
- Cache contract violations (tombstone lifetime, pin violation)
- Cache invalidation gaps after filesystem writes
- Specific race conditions with known fixes

These are bugs/correctness issues, not just complexity. This plan addresses the high-severity ones.

## Issue inventory

### HIGH severity — silent error swallowing

| File | Line | Function | Issue |
|------|------|----------|-------|
| entity-cache.js | 70-77 | `cacheSet` | Quota fail after emergency evict: silent return, caller doesn't know write failed |
| background.js | 741 | `hydrateCache` phase 3 | Remote entry replay errors: `catch (e) { /* skip individual entry errors */ }` — zero logging |
| background.js | 708 | `hydrateCache` phase 2 | Buffer entry replay errors: logged but per-entry effects silently dropped |

### HIGH severity — cache contract violations

| File | Line | Issue |
|------|------|-------|
| entity-cache.js | 123-139 | `emergencyEvict` removes pinned keys — violates pin contract, undocumented |
| entity-cache.js | 322, 327, 421 | GC_TOMBSTONE set on entity deletion, checked in readCacheable, **never cleared** — re-created entities permanently invisible until eviction |

### HIGH severity — cache invalidation

| File | Line | Issue |
|------|------|-------|
| filesystem-storage.js | 623, 640, 660 | `writeJson` calls don't invalidate `_fileCache` — stale reads after rapid write-read sequences |

### MEDIUM severity — race conditions with known fixes

| File | Line | Issue |
|------|------|-------|
| background.js | 2122-2123 | `saveListMeta` reads `nameToId` populated by `effectOf` that may not have completed |

## Design

### Fix 1: cacheSet returns success/failure

**entity-cache.js line 70-77**

Currently: if quota exhausted after emergency eviction, `cacheSet` silently returns. Caller (e.g., `sessionWrite` in background.js) doesn't know the write failed.

Fix: `cacheSet` returns a boolean:

```js
export async function cacheSet(key, value, { timestamp } = {}) {
  // ... existing retry logic ...
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (e) {
    if (e.message?.includes('QUOTA_BYTES') || e.message?.includes('quota')) {
      emergencyEvict();
      try {
        await chrome.storage.session.set({ [key]: value });
      } catch (retryErr) {
        logError('Session quota still exceeded after emergency eviction');
        onQuotaExhausted?.();
        return false;  // <-- was: silent return with no value
      }
    } else throw e;
  }
  // LRU tracking...
  return true;
}
```

Callers that need to know (like `sessionWrite` in background.js) can check the return value. Most callers can ignore it — the service pause via `onQuotaExhausted` is the real recovery path.

### Fix 2: Log remote entry replay errors

**background.js line 741**

Currently: `catch (e) { /* skip individual entry errors */ }` — zero logging.

Fix: Add `logDebug`:

```js
catch (e) {
  logDebug('[hydrateCache] Remote entry replay error:', e.message, 'entry:', entry.action);
}
```

Same pattern as line 708 (buffer replay) which already logs. This is a one-line fix.

### Fix 3: Document emergencyEvict pin violation

**entity-cache.js lines 123-139**

The emergency eviction removing pinned keys is intentional (last-resort recovery). The issue is it's not documented at the call site or in the module docstring. Fix:

1. Add JSDoc to `emergencyEvict()` explaining it violates the pin contract intentionally
2. Add comment to module docstring (lines 1-6) clarifying the hierarchy: quota recovery > pin contract
3. No behavior change needed — the current behavior is correct for quota emergencies

### Fix 4: GC_TOMBSTONE lifetime management

**entity-cache.js lines 322, 327, 421**

Currently: `GC_TOMBSTONE = { __gc: true }` is written when an entity is deleted. `readCacheable` checks `cached.__gc` and returns null. But the tombstone is never cleared — if the entity is re-created (e.g., restored from recycle bin), the cache returns null forever until the key happens to be evicted.

Fix: Clear tombstone on entity re-creation. In `sessionWrite` (background.js ~line 320):

```js
async function sessionWrite(key, entity) {
  if (entity === null) {
    await cacheSet(key, GC_TOMBSTONE);
  } else {
    await cacheSet(key, entity, { timestamp: ... });
  }
}
```

This already works — when `entity` is not null, `cacheSet` overwrites the tombstone with the real entity. **The actual bug is that `readCacheable` doesn't handle the case where `effectOf` writes a non-null entity into the cache that replaces a tombstone within the same `addLog` call.**

Trace the restore path:
1. `addLog()` calls `effectOf()` which sets `result[key] = restoredEntity`
2. `addLog()` then calls `sessionWrite(key, restoredEntity)` for each result
3. `sessionWrite` calls `cacheSet(key, restoredEntity)` — this overwrites the tombstone

This should work. Let me verify: is there a path where `readCacheable` is called *after* effectOf sets the result but *before* sessionWrite flushes it? Yes — if another concurrent operation calls `readCacheable(key)` between steps 1 and 2, it reads the stale tombstone.

Fix: In `addLog()`, flush `sessionWrite` calls synchronously within the lock before any other operations read the cache. Currently `addLog` already does this (lines 351-355):

```js
for (const [key, entity] of Object.entries(effects)) {
  await sessionWrite(key, entity);
}
```

So the fix is: ensure `readCacheable` used in the message handler for restore actions reads *after* `addLog` completes. Check the restore handlers — they call `addLog` first, then read. This is already correct.

**Remaining issue:** The tombstone persists across browser sessions if the entity is deleted and the extension is restarted before the entity is restored. During `hydrateCache`, the tombstone is gone (session storage cleared on restart), so this is actually fine.

**Real remaining issue:** If `addLog` fails to write the session cache (quota exhausted), the tombstone persists. Fix: in `sessionWrite`, when entity is non-null, explicitly call `cacheRemove` before `cacheSet` to clear any tombstone if `cacheSet` fails:

```js
async function sessionWrite(key, entity) {
  if (entity === null) {
    await cacheSet(key, GC_TOMBSTONE);
  } else {
    const ok = await cacheSet(key, entity, { timestamp: ... });
    // If cacheSet failed (quota), at least clear any stale tombstone
    // so readCacheable falls through to disk
    if (!ok) cacheRemove(key);
  }
}
```

### Fix 5: Invalidate _fileCache after writes

**filesystem-storage.js**

Currently `writeJson` (line 180) and other write methods don't clear `_fileCache` entries. A subsequent `readJson` via the cached handle is fine (the handle is still valid), but the concern is about stale *directory handles* when files are created or deleted.

After re-reading the code: `_fileCache` caches `FileSystemFileHandle` objects, not file content. The handle remains valid after the file content changes — reading via the handle always gets the latest content. So `writeJson` followed by `readJson` via the same cached handle is correct.

**The actual issue** is when a file is *deleted* and the cached handle becomes stale. `deletePage` (line 515-518) and `deleteListFile` (line 758) already delete from `_fileCache`. `softDelete` (line 196-231) does not.

Fix: In `softDelete()`, after moving/deleting the file, also evict from `_fileCache`:

```js
async softDelete(parentDir, name, opts = {}) {
  // ... existing move/delete logic ...
  this.#fileCache.delete(parentDir + '/' + name);  // <-- add this
}
```

Also audit all write paths for missing cache invalidation:
- `writeHistoryEntry` — writes to JSONL files, not cached by `_fileCache` (JSONL files are read via `resolveFile` which returns a fresh handle each time for new files)
- `saveNote`, `savePage`, `saveListMeta`, `saveSettings` — all call `writeJson` which resolves the file handle first, so the handle is already in cache and valid
- `captureSnapshot` — creates new files, no stale cache concern

Conclusion: only `softDelete` needs the fix.

### Fix 6: saveListMeta nameToId race

**background.js lines 2122-2123**

The `saveListMeta` handler for new lists:
1. Calls `addLog({ action: 'create_list', name })` — this runs `effectOf` which creates the list and populates `nameToId`
2. Then reads `nameToId` via `readCacheable('manifest:name-to-id')` to find the generated ID

Since `addLog` is `await`ed and `sessionWrite` is called within `addLog`, step 2 should always see the updated `nameToId`. Let me verify `addLog` doesn't return before `sessionWrite` completes...

Reading `addLog` (lines 334-390):
- Line 342: `await withLock(...)` — serialized
- Line 349: `const effects = await effectOf(entry, ...)` — awaited
- Lines 351-355: `for (const [key, entity] of Object.entries(effects)) { await sessionWrite(key, entity); }` — awaited sequentially
- Line 364: `scheduleDrainNotify()` — fire-and-forget (OK)

So `addLog` fully awaits all `sessionWrite` calls before returning. The `readCacheable` at line 2122 runs after `addLog` returns. **This is not actually a race.** The nameToId should be in cache.

The real risk: if `cacheSet` fails silently (quota), the nameToId isn't in cache, and `readCacheable` falls through to disk, which may not have the data yet (drain is async). Fix 1 (cacheSet returns boolean) + Fix 4 (clear tombstone on failure) together address this: if cacheSet fails, the key is removed from cache, and readCacheable falls through to disk read via requestOffscreen, which reads the pre-effectOf state and may not have the new list. This is an edge case during quota pressure — acceptable.

**No code change needed for this issue.** Document it as a known limitation during quota pressure.

## Files changed

1. **entity-cache.js** — cacheSet returns boolean (Fix 1), emergencyEvict documentation (Fix 3)
2. **background.js** — log remote entry replay errors (Fix 2), sessionWrite tombstone cleanup on cacheSet failure (Fix 4)
3. **filesystem-storage.js** — softDelete clears _fileCache entry (Fix 5)

## Test strategy

- TDD: write tests for cacheSet return value behavior (true on success, false on quota failure)
- TDD: write test for sessionWrite clearing tombstone when cacheSet fails
- TDD: write test for softDelete cache invalidation
- Verify: inject quota error in E2E, confirm service pauses correctly
- All existing unit + E2E tests pass

## Risk

Low-medium. Fixes are small and targeted. The cacheSet return value change is the largest — callers that ignore the return value are unaffected.
