# Multi-Device Sync Plan

## 1. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync scope | Logs and notes only | Snapshots excluded — too expensive. User can manually copy `data/snapshots/`. |
| Passive events | Sync all (visit_page, leave_page) | Cross-device page enrichment |
| Transport | GitHub REST API from extension | No scripts, no external tools. User pastes repo URL + token in settings. |
| Git topology | Shared repo, per-device branches | One repo to configure. Each device force-pushes its own branch. No conflicts. |
| Log file naming | `data/logs/YYYY-MM-DD-<deviceName>.jsonl` | Device-specific files. No conflicts on sync. Device name chosen by user at sync enable. |
| Storage retention | Force-push single commit with rolling window | Old data pruned from git but preserved on local disk. Repo size stays bounded. |
| List ID clash | Accept duplicates | Two devices creating same-name list get two lists (different `listOwner`). User merges manually. |
| Device identity in logs | Derived from log filename, NOT stored in entries | `YYYY-MM-DD.jsonl` = no sync; `YYYY-MM-DD-<device>.jsonl` = sync. Replay derives device from filename, passes as context. |
| Entry identity | filename-derived device + timestamp | Sufficient for dedup within a device |
| Delete/restore conflict | LWW by timestamp via `deletedTs` | Later action wins. Simpler than voting; user's most recent intent prevails. |
| Note edit conflict | Both survive as siblings | Two edits of same note → both new notes linked to page. User deletes unwanted one. |
| List tree structure | Nested JSON blob in `manifest/list-order.json`, LWW | Hierarchy restored without commutativity cost. Whole-tree LWW + reconcile. No per-node structural events. |
| Pin to deleted list | Still updates entity | Preserves data for potential restore. `pin_to_list` loads with `includeDeleted`. |
| Peer config | Manual setup | User enters repo URL + token in extension settings |
| Replay order | Local logs first, then remote logs per peer | No cross-device timestamp comparison |
| List reference in events | `name` + `listOwner` (compound key in manifest) | `listOwner` always present on list events (sync mode). `parents` dropped. `manifest:name-to-id` keys: `listOwner/name → id`. Self-descriptive in logs. |
| List name uniqueness | Device-level unique names | Each device enforces unique list names. `(listName, listOwner)` is the identity. |
| Note immutability | **DONE.** Notes are immutable — edits create new entity via `replace_note` | No file conflicts on sync. Full change history preserved in logs. |
| No backward compat | Migrate data, don't add fallback code | Extension is in development. Migrate `~/browser-data` to new formats directly. |

## 2. Architecture

### 2.1 Local changes: device-specific log files

Currently all events go to `data/logs/YYYY-MM-DD.jsonl`. Change to **device-specific files**:

```
data/logs/2026-03-16-a1b2c3d4.jsonl    ← device A's events
data/logs/2026-03-16-e5f6g7h8.jsonl    ← device B's events (after sync)
```

The extension writes only to its own device's log file. Remote devices' log files appear after sync (pulled from git). On replay, the extension processes all log files for a given date — own device first, then remotes.

Notes are already unique by slug. No naming conflicts across devices. Snapshots are excluded from sync (too large); user can manually copy `data/snapshots/` between devices.

### 2.2 Git repo: per-device branches

One shared repo. Each device owns a branch named after its device ID:

```
repo (e.g. github.com/user/browser-recall-sync)
  branch: a1b2c3d4              ← device A pushes here
    data/logs/2026-03-15-a1b2c3d4.jsonl
    data/logs/2026-03-16-a1b2c3d4.jsonl
    data/notes/highlight-abc.json
  branch: e5f6g7h8              ← device B pushes here
    data/logs/2026-03-15-e5f6g7h8.jsonl
    data/logs/2026-03-16-e5f6g7h8.jsonl
    data/notes/highlight-def.json
```

- Each device **force-pushes** to its own branch (single commit, no history)
- Each device **reads** all other branches to discover peers and pull data
- No merge conflicts — branches are independent

### 2.3 Storage retention

Each push creates a fresh orphan commit containing only files within the retention window (default: 7 days for logs). Force-push replaces the branch.

```
Local ~/browser-data/data/                   Git branch a1b2c3d4:
  logs/2026-03-01-a1b2c3d4.jsonl (old)       (not pushed — outside window)
  logs/2026-03-10-a1b2c3d4.jsonl (old)       (not pushed — outside window)
  logs/2026-03-15-a1b2c3d4.jsonl          →  logs/2026-03-15-a1b2c3d4.jsonl
  logs/2026-03-16-a1b2c3d4.jsonl          →  logs/2026-03-16-a1b2c3d4.jsonl
  notes/highlight-abc.json                →  notes/highlight-abc.json
  snapshots/page-123/                     →  snapshots/page-123/
```

Since each push is a force-push with a single orphan commit, the repo never accumulates history. Git's server-side GC prunes unreachable objects from previous pushes. Repo size ≈ current sync window size.

Notes: push all (they're the actual data). Only logs have a rolling window. Snapshots are excluded from sync entirely.

A device offline for longer than the retention window misses old peer logs. Those logs still exist on the originating device's local disk — manual catch-up (file copy) is the fallback.

### 2.4 Transport: GitHub REST API

The extension makes `fetch()` calls directly from the background service worker. Chrome extensions bypass CORS via `host_permissions` in manifest.json.

**Push** (update own branch):
```
POST /repos/{owner}/{repo}/git/blobs          ← upload each new/changed file
POST /repos/{owner}/{repo}/git/trees          ← create tree from all blobs
POST /repos/{owner}/{repo}/git/commits        ← single orphan commit (no parent)
PATCH /repos/{owner}/{repo}/git/refs/heads/{deviceId}  ← force-update branch
```

**Pull** (read peer branches):
```
GET /repos/{owner}/{repo}/branches             ← list all branches (discover peers)
GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1  ← list files on a branch
GET /repos/{owner}/{repo}/git/blobs/{sha}      ← download file content
```

**Rate limits**: 5000 requests/hour with token. A sync cycle with 20 files = ~25 API calls. At 5-minute intervals = 300 calls/hour. Well within limits.

**Adapter pattern**: Wrap API calls in a `SyncTransport` interface (`listBranches`, `getTree`, `getBlob`, `pushTree`). If GitLab/Gitea support is needed later, add adapters for their APIs.

## 3. Event Schema Changes

### 3.1 Device identity: derived from log filename

Device name is NOT stored in log entries. It is derived from the log filename at replay time:
- `YYYY-MM-DD.jsonl` → no sync (deviceName = undefined)
- `YYYY-MM-DD-<deviceName>.jsonl` → sync mode (deviceName passed as context to `effectOf`)

`effectOf(entry, load, context = {})` receives `context.deviceId` from the caller. When truthy, sync-mode commutativity logic activates. When falsy, current single-device behavior.

### 3.2 List-referencing events: `name` + `listOwner`

Events that reference a list carry `name` (the list name) and `listOwner` (the device that owns the list). The `parents` field is dropped. `manifest:name-to-id` uses compound keys: `listOwner/name → id`.

Example event (sync mode):
```json
{ "action": "pin_to_list", "name": "Favorites", "listOwner": "my-laptop", "items": ["https://..."] }
```

Affected actions: `pin_to_list`, `unpin_from_list`, `create_list`, `update_list`, `delete_list`, `restore_list`, `add_rule`, `remove_rule`, `update_rule`.

In non-sync mode, events continue to use `parents` + `name` (current format). The code paths are cleanly separated — no fallback mixing.

`resolveListKey(entry)` reads `entry.listOwner` + `entry.name` in sync mode, `entry.name` in non-sync mode.

### 3.3 `update_list_tree`: tree structure event

List hierarchy and ordering are stored as a single nested JSON blob in `manifest/list-order.json`, synced via a dedicated event. The entire tree is written on every structural change (reorder, reparent, nest/unnest):

```json
{
  "action": "update_list_tree",
  "timestamp": 1710600000,
  "tree": [
    { "id": "list:a-id", "children": [
      { "id": "list:b-id" },
      { "id": "list:c-id" }
    ]},
    { "id": "list:d-id" }
  ]
}
```

Emitted whenever the user changes tree structure in the UI (reorder, reparent, nest, unnest). Also emitted on `create_list` (appends new node) and `delete_list` (removes node).

This replaces both `reparent_list` and flat ordering. All hierarchy complexity (cascade, orphan relocation, cycles) is eliminated: the tree is an opaque blob resolved by LWW + reconcile. No per-node structural events needed.

### 3.5 `reparent_list`: removed

Replaced by `update_list_tree`. No `reparent_list` action exists. Existing `reparent_list` events in JSONL history should be stripped by the migration script. List entities no longer have `parentList` or `childLists` fields — tree structure lives in `manifest/list-order.json` only.

### 3.6 Device-specific log file naming

When sync is enabled, the offscreen drain path writes to `data/logs/YYYY-MM-DD-<deviceName>.jsonl` instead of `data/logs/YYYY-MM-DD.jsonl`. The `deviceName` is passed from background to offscreen via the port channel.

`loadHistoryFileRange` extracts the date prefix (first 10 chars of basename) for filtering, which works for both naming conventions.

Hydration scans all `data/logs/*.jsonl` files, groups by device name (parsed from filename), replays local device first then remotes.

## 4. Entity Schema Changes

### 4.1 Per-device timestamps: `timestamps` map

Entities that use timestamp guards for additive fields gain a `timestamps` map:

```json
{
  "slug": "example-com-abc123",
  "timestamp": 1710600000000,
  "timestamps": {
    "device-B-id": 1710599000000,
    "device-C-id": 1710598000000
  },
  "likes": 3,
  "timeOnPage": 45000
}
```

- `timestamp`: max across all devices (used for display, sort, LRU eviction)
- `timestamps[deviceId]`: last-replayed timestamp from that device (used for additive-field idempotency guard)

Only page entities need `timestamps` (they have additive fields: `likes`, `timeOnPage`, `scrollDepth`). Other entities use set-based operations that are already idempotent.

### 4.2 Delete/restore tracking: `deletedTs` LWW

Entities that support delete/restore gain a `deletedTs` field for LWW conflict resolution:

```json
{
  "slug": "highlight-abc",
  "deleted": false,
  "deletedTs": 1710601000
}
```

**Resolution rule**: `deletedTs` records the timestamp of the last applied delete or restore. Incoming events compare their timestamp against `deletedTs` — newer wins, older is skipped.

```js
// delete handler:
if (entity.deletedTs && entity.deletedTs >= entry.timestamp) return; // skip stale
entity.deleted = true;
entity.deletedTs = entry.timestamp;

// restore handler:
if (entity.deletedTs && entity.deletedTs >= entry.timestamp) return; // skip stale
entity.deleted = false;
entity.deletedTs = entry.timestamp;
```

This is commutative: the entity always converges to the state of the event with the highest timestamp, regardless of replay order.

Affected entities: notes, lists. (Snapshots excluded from sync.)

### 4.3 List tree: `manifest/list-order.json`

```json
{
  "timestamp": 1710600000,
  "tree": [
    { "id": "list:a-id", "children": [
      { "id": "list:b-id" },
      { "id": "list:c-id" }
    ]},
    { "id": "list:d-id" }
  ]
}
```

- `timestamp`: when the tree was last changed (used for LWW on conflicts)
- `tree`: nested array representing list hierarchy and display order

**Reconcile after LWW**: After applying the winning tree, walk the tree and (1) append any list IDs that exist but aren't in the tree as top-level nodes (new lists from other device), and (2) remove any nodes for deleted lists. This is the same reconciliation as the flat case, just applied to a tree structure.

### 4.4 Sync cursor tracking

New manifest file: `manifest/sync-cursors.json`:

```json
{
  "timestamp": 1710600000000,
  "cursors": {
    "device-A-id": {
      "logDate": "2026-03-16",
      "logLine": 142
    }
  }
}
```

Each cursor tracks the last-replayed position in a peer's log (date file + line number within that file). On sync, replay from cursor position forward.

## 5. replay.js Commutativity Changes

### 5.1 `resolveListKey`: compound key via `(name, listOwner)`

Signature changes from `resolveListKey(parents, name)` to `resolveListKey(entry)`. Uses `context.deviceId` (from closure) to select lookup strategy:

```js
async function resolveListKey(entry) {
  const name = entry.name;
  if (!name) return null;
  if (name.startsWith('system/')) return `list:${name}`;
  const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
  if (context.deviceId) {
    // Sync: compound key listOwner/name
    const owner = entry.listOwner;
    if (!owner) return null;
    const id = nameToId.paths?.[owner + '/' + name];
    return id ? `list:${id}` : null;
  }
  // Non-sync: flat key
  const id = nameToId.paths?.[name];
  return id ? `list:${id}` : null;
}
```

All ~9 callers change from `resolveListKey(entry.parents, entry.name)` to `resolveListKey(entry)`.

### 5.2 `rate_page` / `leave_page`: per-device timestamp guard

In sync mode, uses `page.timestamps[context.deviceId]` as per-device watermark. In non-sync mode, uses current `entry.timestamp > prevTimestamp` guard.

```js
// Sync mode:
const deviceTs = (page.timestamps?.[context.deviceId]) || 0;
if (entry.timestamp > deviceTs) {
  updated.likes = (updated.likes || 0) + entry.likes;
  const timestamps = { ...(page.timestamps || {}) };
  timestamps[context.deviceId] = entry.timestamp;
  updated.timestamps = timestamps;
}
updated.timestamp = Math.max(page.timestamp || 0, entry.timestamp);

// Non-sync mode: current behavior unchanged
```

Same pattern for `leave_page` (`timeOnPage`, `scrollDepth`). Device name comes from `context.deviceId` (derived from log filename), NOT from entries.

### 5.3 `pin_to_list` / `unpin_from_list`: operate on deleted lists

`pin_to_list` and `unpin_from_list` load the list entity with `includeDeleted: true` and update pins regardless of the list's deleted state. This ensures that if the list is later restored, all pins are intact.

```js
// pin_to_list — always applies, even to deleted lists
const list = await loadOrDefault(listKey, load, { includeDeleted: true });
// ... add pin to list.pins ...
result[listKey] = { ...list, pins: updatedPins };
```

### 5.4 `delete_list` / `restore_list`: simple LWW

With flat lists (no hierarchy), `delete_list` is a single-entity operation — no cascade, no `fromParent` preconditions.

```js
// delete_list:
if (entry.action === 'delete_list') {
  const list = await loadOrDefault(listKey, load, { includeDeleted: true });
  if (list.deletedTs && list.deletedTs >= entry.timestamp) return result; // skip stale
  result[listKey] = { ...list, deleted: true, deletedTs: entry.timestamp };
  // ... unlink pins from pages, add to orphaned manifest ...
  return result;
}

// restore_list:
if (entry.action === 'restore_list') {
  const list = await loadOrDefault(listKey, load, { includeDeleted: true });
  if (list.deletedTs && list.deletedTs >= entry.timestamp) return result; // skip stale
  result[listKey] = { ...list, deleted: false, deletedTs: entry.timestamp };
  // ... re-link pins to pages, remove from orphaned manifest ...
  return result;
}
```

### 5.5 `update_list_tree`: LWW on whole tree + reconcile

```js
if (entry.action === 'update_list_tree') {
  const treeEntity = await loadOrDefault('manifest/list-order', load);
  if (treeEntity.timestamp && treeEntity.timestamp >= entry.timestamp) return result;

  // Start with the winning tree
  let tree = deepClone(entry.tree);

  // Reconcile: collect all IDs in the tree
  const idsInTree = collectIds(tree);

  // Append lists that exist but aren't in the tree (remote-created)
  const allLists = /* scan all list entities */;
  for (const listKey of allLists) {
    if (!idsInTree.has(listKey) && !isDeleted(listKey)) {
      tree.push({ id: listKey });
    }
  }

  // Remove deleted lists from tree
  tree = filterTree(tree, node => !isDeleted(node.id));

  result['manifest/list-order'] = { timestamp: entry.timestamp, tree };
  return result;
}
```

The tree is an opaque blob — LWW picks the winner, reconcile handles create/delete drift. Reordering, reparenting, and nesting are all just "tree changed." Same commutativity cost as a flat array.

### 5.6 `replace_note`: both survive

When two devices edit the same note, both new notes survive as siblings on the page:

```
Device A: replace_note(X → Y)
Device B: replace_note(X → Z)
```

The existing `effectOf` for `replace_note` already handles this naturally:
1. Each event orphans old note X (second orphan is a no-op — already orphaned)
2. Each event creates and links its new note (Y, Z) to the page's `childIds`
3. Each event transfers list pins from X to the new note

Result: Y and Z are both linked to the page. The user sees both and deletes the unwanted one.

**Pin transfer race**: The first-replayed event transfers pins from X to (say) Y. The second event's pin transfer finds X has no pins (already moved to Y) — so Z gets no pins. This is acceptable: the "winning" note inherits the pins, the other is a clean sibling.

### 5.7 `delete_note` / `restore_note`: LWW with `deletedTs`

```js
// delete_note:
if (entry.action === 'delete_note') {
  const note = await loadOrDefault(noteKey, load, { includeDeleted: true });
  if (note.deletedTs && note.deletedTs >= entry.timestamp) return result; // skip stale
  result[noteKey] = { ...note, deleted: true, deletedTs: entry.timestamp };
  // ... existing unlink/orphan logic ...
  return result;
}

// restore_note:
if (entry.action === 'restore_note') {
  const note = await loadOrDefault(noteKey, load, { includeDeleted: true });
  if (note.deletedTs && note.deletedTs >= entry.timestamp) return result; // skip stale
  result[noteKey] = { ...note, deleted: false, deletedTs: entry.timestamp };
  // ... existing restore/re-link logic ...
  return result;
}
```

**`delete_note` vs `replace_note`**: The replacement always survives. `replace_note` creates a new note entity (Y) and orphans old note (X). A concurrent `delete_note(X)` also orphans X — no conflict. Y exists regardless.

### 5.8 `entity.timestamp` semantics

All `effectOf` branches that set `timestamp` use `Math.max` **unconditionally** (both sync and non-sync modes):

```js
result[pageKey] = { ...page, timestamp: Math.max(page.timestamp || 0, entry.timestamp) };
```

Safe in single-device mode (timestamps monotonically increase, so `Math.max` is a no-op). Ensures `entity.timestamp` is the latest modification across all devices in sync mode, regardless of replay order. Used for display, sorting, and LRU eviction watermark.

### 5.9 Commutativity summary

| Operation | Mechanism | Commutative? |
|-----------|-----------|:---:|
| `visit_page` (set-add: visitDates, parentIds, childIds) | `!includes` guard | Yes |
| `visit_page` (capped arrays) | `shift()` on overflow | ~Yes (low-impact) |
| `leave_page` (timeOnPage, scrollDepth) | Per-device timestamp guard | Yes |
| `rate_page` (likes) | Per-device timestamp guard | Yes |
| `rename_page` (user_title) | Last-write-wins (`Math.max` timestamp) | Yes |
| `pin_to_list` / `unpin_from_list` | Set-add/remove with `includeDeleted` | Yes |
| `create_note` | Set-add link (unique slug) | Yes |
| `replace_note` | Both survive as siblings | Yes |
| `delete_note` / `restore_note` | LWW via `deletedTs` | Yes |
| `delete_note` vs `replace_note` | Edit wins (independent ops) | Yes |
| `create_list` | ID from hash(name+ts), idempotent | Yes |
| `update_list` (rename) | `(name, listOwner)` compound key, last-write-wins on name | Yes |
| `delete_list` / `restore_list` | LWW via `deletedTs` | Yes |
| `pin_to_list` vs `delete_list` | Pin applies to deleted entity; survives restore | Yes |
| `update_list_tree` | LWW on whole tree blob + reconcile | Yes |
| `add_rule` / `remove_rule` | ID-based set-add/remove | Yes |
| `update_rule` | Last-write-wins per rule ID | Yes |
| `update_setting` | Last-write-wins per key | Yes |

## 6. Sync Protocol

### 6.1 Device initialization

When user enables sync in settings:
1. User chooses a unique device name (human-readable, e.g., "my-laptop"), stored in `manifest/settings.json` as `deviceName`
2. Run migration script (`scripts/migrate-sync-enable.mjs`) to transform data
3. User configures: GitHub repo URL + personal access token
4. Extension creates a branch named `<deviceName>` in the repo (if not exists)

### 6.2 Push cycle

Triggered by `chrome.alarms` (configurable interval, default 5 min) or manual button.

1. Collect local files to push:
   - `data/logs/YYYY-MM-DD-<myDeviceId>.jsonl` — only within retention window (default 7 days)
   - `data/notes/*.json` — all
2. Compare against last-pushed state (hash manifest stored locally in `manifest/sync-push-state.json`)
3. For new/changed files, call GitHub API:
   - Create blobs for each file
   - Create tree with all current files
   - Create orphan commit (no parent)
   - Force-update branch ref
4. Update local push-state manifest

Since each push is a single orphan commit, the repo branch always contains exactly the current sync window. No history accumulation.

### 6.3 Pull cycle

Triggered after push, or on its own schedule.

1. `GET /repos/.../branches` — list all branches. Each branch = a device.
2. For each peer branch (not own):
   a. `GET /repos/.../git/trees/{sha}?recursive=1` — get file listing
   b. Compare against sync cursor (`manifest/sync-cursors.json[peerId]`)
   c. Download new log files and notes via blob API
   d. Write to local `data/` directory (log files keep their device-specific names)
   e. Replay new log entries via `replayRemoteEntries()` (see 6.4)
   f. Update sync cursor

### 6.4 Remote log replay

Remote entries are replayed in background.js using the same `effectOf` + `sessionWrite` pipeline, but NOT through `addLog`:

```js
async function replayRemoteEntries(entries, peerDeviceName) {
  for (const entry of entries) {
    const effects = await effectOf(entry, sessionLoad, { deviceName: peerDeviceName });
    await sessionWrite(effects);
  }
  // Trigger entity checkpoint drain
  scheduleDrainNotify();
}
```

Remote entries do NOT:
- Append to local logBuffer (they're persisted in their own device-specific log files)
- Drain to local JSONL files (that would duplicate them)
- Update `history:<date>` session keys (remote visits stay out of local history timeline)

Remote entries DO:
- Update entity state (pages, lists, notes, manifests) via session cache
- Get checkpointed to disk on next drain cycle (entity files only, not JSONL)

### 6.5 Hydration with multi-device logs

On startup, hydration scans all `data/logs/*.jsonl` files:

1. Parse device ID from each filename (`YYYY-MM-DD-<deviceId>.jsonl`)
2. Group by device ID
3. Replay local device's logs first (existing behavior)
4. Replay each remote device's logs (from cursor, or from beginning if no cursor)

This ensures local-first ordering even on cold start.

Legacy log files (`YYYY-MM-DD.jsonl` without device suffix) are treated as local device.

## 7. Data Migration

Migration runs when user enables sync, via `scripts/migrate-sync-enable.mjs`. Per the project's data migration policy: migrate `~/browser-data` on disk, no fallback code in extension.

### 7.1 Migration script (`scripts/migrate-sync-enable.mjs`)

Prompts for device name, then:

1. Store `deviceName` in `manifest/settings.json`
2. Rename `data/logs/YYYY-MM-DD.jsonl` → `data/logs/YYYY-MM-DD-<deviceName>.jsonl`
3. `pages/*.json`: add `timestamps: {}`
4. `lists/*.json`: add `owner: <deviceName>`, `deletedTs: 0`
5. `manifest/list-name-to-id.json`: transform keys from `name` to `deviceName/name`
6. All JSONL log entries with list references: add `listOwner: <deviceName>`, drop `parents`
7. Create `manifest/sync-cursors.json`: `{ timestamp: 0, cursors: {} }`

### 7.2 Hierarchy removal migration (already done)

- ~~Strip `reparent_list` entries from JSONL history~~
- ~~Remove `parentList`/`childLists` from entities, remove `list:system/root`~~
- ~~Generate `manifest/list-order.json` from existing hierarchy~~

## 8. Implementation Phases

### Phase 0: Replay commutativity (no sync yet) — COMPLETE

All `effectOf` branches are order-independent. Device-specific fields (`deletedTs`, `timestamps`, `listOwner`, `owner`) are always present (always-on device name, not gated by sync mode).

- ~~Remove `reparent_list` action, replace with `update_list_tree`~~ (e1635f5)
- ~~`replace_note` both-survive~~ (already works naturally)
- ~~`Math.max` for all `entity.timestamp` assignments~~ (via `touchTimestamp` helper in replay.js)
- ~~`effectOf(entry, load, context = {})` — context parameter with `context.deviceId`~~ (593ac8e)
- ~~`resolveListKey(name)` — compound key `listOwner/name` via `entry.listOwner`~~ (1c85e49)
- ~~LWW via `deletedTs` for delete/restore branches~~
- ~~`pin_to_list` / `unpin_from_list` / rules / `update_list` load with `includeDeleted: true`~~ (via `loadListForMutation` helper)
- ~~Per-device timestamp guards for `rate_page`, `leave_page` via `timestamps` map~~ (593ac8e)
- ~~Background/offscreen wiring: pass `context.deviceId` to all `effectOf` call sites~~
- ~~`getListEventFields` refactor: returns `{ name, listOwner }`~~
- ~~List-event emit sites: `listOwner` field on all list events~~
- ~~Device-specific log file naming: `data/logs/<deviceId>/YYYY-MM-DD.jsonl`~~ (subdirectory-based, 1c85e49)
- ~~Migration script (`scripts/migrate-always-device.mjs`)~~
- ~~Commutativity tests T1–T21: all permutation-based tests passing~~ (tests/replay.test.js)

### Phase 1: Sync transport — COMPLETE

- ~~Device name setup + storage in settings~~ (always-on device name via CURRENT file, 1c85e49)
- ~~`host_permissions` for GitHub API~~ (`<all_urls>` already covers it)
- ~~Settings UI: repo URL, personal access token, sync toggle, retention window~~ (options.html/options.js sync section)
- ~~`SyncTransport` module — GitHub API adapter~~ (`sync-transport-github.js`: `listBranches()`, `getTree()`, `getBlob()`, `pushTree()` with retry)

### Phase 2: Push & pull — COMPLETE

- ~~Push cycle: collect local files → compare with push state → create orphan commit → force-push branch~~ (`SyncManager.push()` + offscreen `collectSyncFiles`)
- ~~Pull cycle: list branches → for each peer, compare tree → download new files → write to `data/`~~ (`SyncManager.pull()` + offscreen `writeSyncFiles`)
- ~~Remote log replay: `replayRemoteEntries()` using `effectOf` + `sessionWrite`~~ (background.js `replayRemoteEntries`)
- ~~Sync cursor tracking: `manifest/sync-cursors.json`~~ (SyncManager cursor load/save via offscreen `loadSyncManifest`)
- ~~`chrome.alarms` for periodic sync~~ (background.js `updateSyncAlarm` + alarm listener)
- ~~Manual sync button in settings UI~~ (options.js `syncNowBtn` handler)

### Phase 3: Polish — COMPLETE

- ~~Sync status indicator (last sync time, peer list, errors)~~ (options.js green/red status display + timestamp)
- ~~Hydration with multi-device log files (scan all `*.jsonl`, local first)~~ (background.js hydration loads remote entries via `loadRemoteLogEntries` when syncEnabled)
- ~~Retention enforcement (exclude old logs from push)~~ (`collectSyncFiles` filters by `retentionDays`)
- ~~Error handling: network failures, auth errors, rate limits~~ (transport retry with backoff; `performSync` error classification: auth/404 → disable alarm; options UI disabled/retry messages)
- Conflict visibility: notification when restore-wins overrides a local delete (deferred — no UI yet)

## 9. Implementation Notes

These are correctness issues that must be addressed during implementation, not commutativity problems.

**~~9.1 GC_TOMBSTONE must not block remote events.~~** DONE — `readCacheable` returns `null` for `{ __gc: true }` sentinels (background.js:284).

**~~9.2 All list-modifying operations must use `includeDeleted: true`.~~** DONE — `loadListForMutation` helper loads with `{ includeDeleted: true }`, used by all list-mutating `effectOf` branches.

**~~9.3 `create_list` and `delete_list` must update the tree manifest.~~** DONE — `create_list` appends via `appendToTree`, `delete_list` removes via `removeFromTree` (replay.js).

## 10. Open Questions (deferred)

1. **GitLab/Gitea support**: Add `SyncTransport` adapters when needed. API surface is small.
2. **Token security**: `chrome.storage.local` for tokens. Acceptable for v1; could use OS keychain via native messaging later.
3. **Offline gap**: Device offline > retention window misses peer logs. Accept as limitation; manual file copy is fallback.
4. **History view**: Should remote visits appear in the Explore timeline? Deferred — start with entity-only enrichment.
5. **Cross-user sharing**: Separate feature from sync. Publish list checkpoint files to a public GitHub Pages repo. Subscribers fetch static JSON over HTTPS. No log replay needed — checkpoint files are the state. Design details deferred.

## 11. Commutativity Edge Cases (Test Scenarios)

Each test replays the same set of events in two different orders and asserts identical final state. Grouped by conflict type.

### 11.1 Note edit conflicts

**T1: Two devices edit the same note.**
Events: `replace_note(X → Y, ts=10)`, `replace_note(X → Z, ts=20)`.
Expected: X orphaned. Y and Z both linked to page as siblings. Pins transferred to Y only (first-replayed gets pins).
Verify both orders produce: page.childIds contains both `note:Y` and `note:Z`. X is orphaned.

**T2: One device edits, other deletes the same note.**
Events: `replace_note(X → Y, ts=10)`, `delete_note(X, ts=20)`.
Expected: X orphaned (by both ops independently). Y exists and is linked to page. Delete of X is effectively a no-op on a note that's already orphaned by the replace.
Verify: Y is alive and linked. X is orphaned.

**T3: One device edits, other deletes — edit is newer.**
Events: `delete_note(X, ts=10)`, `replace_note(X → Y, ts=20)`.
Expected: Same as T2. The replace creates Y regardless of X's delete state.

### 11.2 Note delete/restore conflicts

**T4: Delete and restore of same note, restore is newer.**
Events: `delete_note(X, ts=10)`, `restore_note(X, ts=20)`.
Expected: X is alive (deletedTs=20, deleted=false).

**T5: Delete and restore of same note, delete is newer.**
Events: `restore_note(X, ts=10)`, `delete_note(X, ts=20)`.
Expected: X is deleted (deletedTs=20, deleted=true).

### 11.3 List delete/restore conflicts

**T6: Delete and restore of same list, restore is newer.**
Events: `delete_list(L, ts=10)`, `restore_list(L, ts=20)`.
Expected: L alive (deletedTs=20, deleted=false). All pins intact.

**T7: Delete and restore of same list, delete is newer.**
Events: `restore_list(L, ts=10)`, `delete_list(L, ts=20)`.
Expected: L deleted (deletedTs=20, deleted=true).

### 11.4 Pin to deleted list

**T8: Pin a page to a list that was concurrently deleted.**
Events: `delete_list(L, ts=10)`, `pin_to_list(page P to L, ts=20)`.
Expected: L is deleted. L's pins array contains P. If L is later restored, P is pinned.
Key: `pin_to_list` must load with `includeDeleted: true` and update the entity regardless.

**T9: Pin, then delete, then restore — pin survives the round-trip.**
Events: `pin_to_list(P to L, ts=10)`, `delete_list(L, ts=20)`, `restore_list(L, ts=30)`.
Expected: L alive. P is pinned to L. The pin was preserved through delete+restore.
Key: All 6 orderings must produce the same state.

**T10: Unpin from a deleted list.**
Events: `delete_list(L, ts=10)`, `unpin_from_list(P from L, ts=20)`.
Expected: L is deleted. P is NOT in L's pins. If L is later restored, P is not pinned.

### 11.5 List tree structure conflicts

**T11: Two devices reorganize the tree simultaneously.**
Events: `update_list_tree(tree:[{A, children:[B]}, {C}], ts=10)`, `update_list_tree(tree:[{C, children:[A]}, {B}], ts=20)`.
Expected: Tree is [{C, children:[A]}, {B}] (newer wins via LWW).

**T12: One device reorganizes tree, other device creates a new list.**
Events: `update_list_tree(tree:[{A}, {B}], ts=10)`, `create_list(C, ts=20)`.
Expected: Tree is [{A}, {B}, {C}]. C is appended as top-level node because it exists but isn't in the winning tree.

**T13: One device reorganizes tree, other device deletes a list.**
Events: `update_list_tree(tree:[{A, children:[B]}, {C}], ts=10)`, `delete_list(B, ts=20)`.
Expected: Tree is [{A}, {C}]. B removed from tree during reconciliation (including from A's children).

### 11.6 Additive field conflicts

**T14: Two devices both rate the same page.**
Events: `rate_page(url, likes:+1, deviceId:A, ts=10)`, `rate_page(url, likes:+1, deviceId:B, ts=20)`.
Expected: page.likes = original + 2. Each device's contribution tracked in `timestamps` map. Both additions apply.

**T15: Same device's rate_page replayed twice (idempotency).**
Events: `rate_page(url, likes:+1, deviceId:A, ts=10)`, `rate_page(url, likes:+1, deviceId:A, ts=10)`.
Expected: page.likes = original + 1 (not +2). Per-device timestamp guard prevents double-count.

### 11.7 Mixed multi-operation scenarios

**T16: Edit note + delete note + restore note — three-way.**
Events: `replace_note(X → Y, ts=10)`, `delete_note(X, ts=20)`, `restore_note(X, ts=30)`.
Expected: X alive (restore ts=30 wins over delete ts=20). Y also linked to page (replace created Y independently). Both X and Y exist.
Key: all 6 orderings must produce the same state.

**T17: Delete list + pin to list + restore list — three-way.**
Events: `delete_list(L, ts=10)`, `pin_to_list(P to L, ts=20)`, `restore_list(L, ts=30)`.
Expected: L alive (restore ts=30 > delete ts=10). P is pinned to L (pin applied to deleted entity, preserved through restore).
Key: all 6 orderings must produce the same state.

**T18: Create list + reorganize tree + delete — tree reconciliation.**
Events: `create_list(C, ts=10)`, `update_list_tree(tree:[{A, children:[B]}], ts=20)`, `delete_list(A, ts=30)`.
Expected: Tree is [{B}, {C}]. Tree wins (LWW), then reconcile: C appended (missing), A removed (deleted), B promoted to top-level (parent removed).

### 11.8 Implementation correctness

**T19: Page GC_TOMBSTONE does not block remote events.**
Setup: Device A GC's page P (no pins, no notes). GC_TOMBSTONE in session cache.
Event from Device B: `visit_page(P, ts=20)`.
Expected: Page P is recreated as a fresh entity with visit data. GC_TOMBSTONE is treated as "not found" by sessionLoad, not as a valid entity.

**T20: Rules on deleted list are preserved for restore.**
Events: `delete_list(L, ts=10)`, `add_rule(rule R to L, ts=20)`, `restore_list(L, ts=30)`.
Expected: L alive. Rule R is present on L. `add_rule` must load with `includeDeleted: true`.

**T21: create_list updates the tree manifest.**
Events: `create_list(C, ts=10)`. No `update_list_tree` event.
Expected: C appears in `manifest/list-order.json` tree as a top-level node. `effectOf` for `create_list` must append to the tree if not present.
