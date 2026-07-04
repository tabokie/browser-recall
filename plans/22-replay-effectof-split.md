# 22 — Replay effectOf Split

## Context

`effectOf()` in `replay.js` (line 186, 787 lines) contains 22 action branches plus 8 helper closures (`linkChild`, `unlinkChild`, `orphan`, `unorphan`, `resolveListKey`, `ensurePageEntity`, `findListsWithPin`, `loadListForMutation`) all closing over `result`, `entry`, `load`, `context`. Additionally, 5 LWW (last-write-wins) guards are duplicated with no shared helper.

## Action inventory

| Action | Lines | Helpers used | Group |
|--------|-------|-------------|-------|
| update_setting | 297-301 | none | Settings |
| visit_page | 306-358 | ensurePageEntity (conditional) | Page lifecycle |
| leave_page | 362-388 | none | Page lifecycle |
| rename_page | 392-397 | ensurePageEntity | Page lifecycle |
| rate_page | 401-414 | ensurePageEntity | Page lifecycle |
| create_snapshot | 420-433 | ensurePageEntity, linkChild | Snapshot ops |
| delete_snapshot | 514-525 | unlinkChild, orphan | Snapshot ops |
| restore_snapshot | 529-537 | linkChild, unorphan | Snapshot ops |
| create_note | 438-452 | ensurePageEntity, linkChild | Note ops |
| delete_note | 455-484 | findListsWithPin, unlinkChild, orphan | Note ops |
| restore_note | 487-510 | linkChild, unorphan | Note ops |
| replace_note | 542-600 | findListsWithPin, unlinkChild, ensurePageEntity, linkChild, orphan | Note ops |
| pin_to_list | 604-645 | resolveListKey, loadListForMutation, ensurePageEntity | List ops |
| unpin_from_list | 649-684 | resolveListKey, loadListForMutation | List ops |
| add_rule | 688-709 | resolveListKey, loadListForMutation | List ops |
| remove_rule | 713-722 | resolveListKey, loadListForMutation | List ops |
| update_rule | 726-738 | resolveListKey, loadListForMutation | List ops |
| create_list | 743-776 | none (manifest only) | Tree ops |
| update_list | 781-810 | resolveListKey, loadListForMutation | Tree ops |
| update_list_tree | 816-857 | none (local tree funcs) | Tree ops |
| delete_list | 861-901 | resolveListKey, orphan | Tree ops |
| restore_list | 905-969 | resolveListKey, unorphan | Tree ops |

LWW guard duplicates: delete_note:461, restore_note:494, replace_note:590, delete_list:869, restore_list:926.

## Design

Everything stays in `replay.js`. No new files.

### Step 1: ReplayContext class

```js
class ReplayContext {
  constructor(entry, load, context) {
    this.entry = entry;
    this.load = load;
    this.context = context;
    this.result = {};
  }

  // Consolidated LWW guard (replaces 5 inline checks)
  isStaleByLWW(entity, field = 'deletedTs') {
    const ts = entity?.[field] || 0;
    return ts >= this.entry.timestamp;
  }

  // All 8 former closures become methods:
  async linkChild(childKey, parentIds) { /* uses this.result, this.load */ }
  async unlinkChild(childKey, parentIds) { ... }
  async orphan(childKey, ts, parentUrl) { ... }
  async unorphan(childKey, ts) { ... }
  async resolveListKey(name) { ... }
  async ensurePageEntity(url, ts, title) { ... }
  async findListsWithPin(pinId) { ... }
  async loadListForMutation(listKey) { ... }
  async loadOrDefault(key, opts) { ... }
}
```

### Step 2: 22 named handler functions

Each receives a `ReplayContext` and operates on it:

```js
async function handleVisitPage(ctx) { ... }
async function handleDeleteNote(ctx) { ... }
// ... 22 total
```

### Step 3: Dispatch table

```js
const ACTION_HANDLERS = {
  update_setting: handleUpdateSetting,
  visit_page: handleVisitPage,
  leave_page: handleLeavePage,
  // ... all 22
};

export async function effectOf(entry, load, context = {}) {
  const ctx = new ReplayContext(entry, load, context);
  const handler = ACTION_HANDLERS[entry.action];
  if (handler) await handler(ctx);
  return ctx.result;
}
```

Tree helpers (`removeFromTree`, `appendToTree`, `appendToTreeRecursive`, `deepCloneTree`) stay as module-level functions — they don't close over effectOf state.

## Files changed

1. **replay.js** — restructure in place. Same file, ~998 lines, better organized.

## Test strategy

- TDD: write tests for `ReplayContext.isStaleByLWW()` and verify it matches existing behavior
- All 2113 lines of existing `tests/replay.test.js` must pass with zero changes (behavioral equivalence)
- All E2E tests pass

## Risk

Medium — this is the critical event-sourced replay engine. Strong existing test coverage (2113 lines of unit tests) is the safety net. The transformation is structural, not behavioral.
