# Multi-Device Sync Plan

## 1. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync scope | Everything (logs, notes, snapshots) | Full data availability across devices |
| Passive events | Sync all (visit_page, leave_page) | Cross-device page enrichment |
| Transport | GitHub REST API from extension | No scripts, no external tools. User pastes repo URL + token in settings. |
| Git topology | Shared repo, per-device branches | One repo to configure. Each device force-pushes its own branch. No conflicts. |
| Log file naming | `data/logs/YYYY-MM-DD-<deviceId>.jsonl` | Device-specific files. No conflicts on sync. |
| Storage retention | Force-push single commit with rolling window | Old data pruned from git but preserved on local disk. Repo size stays bounded. |
| List ID clash | Accept duplicates | Two devices creating same-name list get two lists. User merges manually. |
| Entry identity | deviceId:timestamp | Sufficient for dedup within a device |
| Delete/restore conflict | Restore wins | Losing a deletion is cheap; losing a restore may lose user intent |
| Peer config | Manual setup | User enters repo URL + token in extension settings |
| Replay order | Local logs first, then remote logs per peer | No cross-device timestamp comparison |
| Reparent format | `{ listId, toParentId, index }` — no `childNames` | Commutative (set-add with index hint) |
| List reference in events | Add `listId` field (resolved at emit time) | Survives renames. `parents`+`name` kept for readability. |
| Note immutability | **DONE.** Notes are immutable — edits create new entity via `replace_note` | No file conflicts on sync. Full change history preserved in logs. |

## 2. Architecture

### 2.1 Local changes: device-specific log files

Currently all events go to `data/logs/YYYY-MM-DD.jsonl`. Change to **device-specific files**:

```
data/logs/2026-03-16-a1b2c3d4.jsonl    ← device A's events
data/logs/2026-03-16-e5f6g7h8.jsonl    ← device B's events (after sync)
```

The extension writes only to its own device's log file. Remote devices' log files appear after sync (pulled from git). On replay, the extension processes all log files for a given date — own device first, then remotes.

Notes and snapshots are already unique by slug. No naming conflicts across devices.

### 2.2 Git repo: per-device branches

One shared repo. Each device owns a branch named after its device ID:

```
repo (e.g. github.com/user/portal-sync)
  branch: a1b2c3d4              ← device A pushes here
    data/logs/2026-03-15-a1b2c3d4.jsonl
    data/logs/2026-03-16-a1b2c3d4.jsonl
    data/notes/highlight-abc.json
    data/snapshots/page-123/index.html
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
Local ~/portal-data/data/                   Git branch a1b2c3d4:
  logs/2026-03-01-a1b2c3d4.jsonl (old)       (not pushed — outside window)
  logs/2026-03-10-a1b2c3d4.jsonl (old)       (not pushed — outside window)
  logs/2026-03-15-a1b2c3d4.jsonl          →  logs/2026-03-15-a1b2c3d4.jsonl
  logs/2026-03-16-a1b2c3d4.jsonl          →  logs/2026-03-16-a1b2c3d4.jsonl
  notes/highlight-abc.json                →  notes/highlight-abc.json
  snapshots/page-123/                     →  snapshots/page-123/
```

Since each push is a force-push with a single orphan commit, the repo never accumulates history. Git's server-side GC prunes unreachable objects from previous pushes. Repo size ≈ current sync window size.

Notes and snapshots: push all (they're the actual data). Only logs have a rolling window. If snapshots become too large, add a size cap or skip large snapshots from sync (deferred optimization).

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

### 3.1 All events: add `deviceId`

Every log entry gets a `deviceId` field, populated at `addLog()` time:

```js
// background.js addLog()
entry.deviceId = localDeviceId;  // from settings
```

Existing events without `deviceId` are treated as local (backward compat).

### 3.2 List-referencing events: add `listId`

Events that reference a list by `parents`+`name` gain a `listId` field, resolved at emit time. The `parents` and `name` fields are kept for human readability and name-to-id path maintenance.

Affected actions and their call sites in `background.js`:

| Action | Call sites (line) | New field |
|--------|------------------|-----------|
| `pin_to_list` | 612, 1016, 1391, 1817 | `listId` |
| `unpin_from_list` | 1359 | `listId` |
| `create_list` | 1418 | `listId` (pre-generated, see 3.3) |
| `update_list` | 1432 | `listId` |
| `delete_list` | 1458 | `listId` |
| `reparent_list` | 1491 | `listId`, `toParentId` |
| `restore_list` | 1547 | `listId` |
| `add_rule` | 1737 | `listId` |
| `remove_rule` | 1754 | `listId` |
| `update_rule` | 1771 | `listId` |

At each call site, the list ID is already available (e.g., `request.listId` or from `getListParentsAndName`). Just add it to the entry.

### 3.3 `create_list`: pre-generate `listId`

Currently, `effectOf` generates the list ID from `hash(name + timestamp)`. For sync, the ID must be in the event so remote devices use the same ID. Change: generate the ID in the handler, pass as `entry.listId`, and have `effectOf` use it (it already does: `entry.listId || hash(...)`).

### 3.4 `reparent_list`: new format

Old:
```json
{
  "action": "reparent_list",
  "parents": ["root"], "name": "MyList",
  "toParents": ["root", "Projects"],
  "childNames": ["MyList", "OtherChild", "AnotherChild"]
}
```

New:
```json
{
  "action": "reparent_list",
  "parents": ["root"], "name": "MyList",
  "listId": "mylist-abc123",
  "toParents": ["root", "Projects"],
  "toParentId": "system/root",
  "index": 0
}
```

- `childNames` removed — no complete replacement
- `index` is a best-effort insertion hint (clamped to array bounds)
- `listId` and `toParentId` for reliable resolution
- `parents`, `name`, `toParents` kept for name-to-id path maintenance

### 3.5 Device-specific log file naming

Change `addLog()` → offscreen drain path to write to `data/logs/YYYY-MM-DD-<deviceId>.jsonl` instead of `data/logs/YYYY-MM-DD.jsonl`.

Hydration scans all `data/logs/*.jsonl` files, groups by device ID (parsed from filename), replays local device first then remotes.

## 4. Entity Schema Changes

### 4.1 Per-device timestamps: `remotes` map

Entities that use timestamp guards for additive fields gain a `remotes` map:

```json
{
  "slug": "example-com-abc123",
  "timestamp": 1710600000000,
  "remotes": {
    "device-B-id": 1710599000000,
    "device-C-id": 1710598000000
  },
  "likes": 3,
  "timeOnPage": 45000
}
```

- `timestamp`: max across all devices (used for display, sort, LRU eviction)
- `remotes[deviceId]`: last-replayed timestamp from that device (used for additive-field idempotency guard)

Only page entities need `remotes` (they have additive fields: `likes`, `timeOnPage`, `scrollDepth`). Other entities use set-based operations that are already idempotent.

### 4.2 Delete/restore tracking: `deleteVotes` map

Entities that support delete/restore gain a `deleteVotes` map for restore-wins conflict resolution:

```json
{
  "slug": "highlight-abc",
  "deleted": false,
  "deleteVotes": {
    "device-A-id": { "action": "delete", "ts": 1710600000 },
    "device-B-id": { "action": "restore", "ts": 1710601000 }
  }
}
```

**Resolution rule**: Entity is deleted iff ALL devices that have voted have voted `delete`. If ANY device's latest vote is `restore`, the entity is alive. Within a single device, later timestamp overwrites earlier vote.

```js
function isDeleted(entity) {
  const votes = entity.deleteVotes;
  if (!votes || Object.keys(votes).length === 0) return false;
  return Object.values(votes).every(v => v.action === 'delete');
}
```

This is commutative:
- A deletes, B restores → A.vote=delete, B.vote=restore → not all delete → alive
- B restores, A deletes → same votes → same result
- A deletes, A restores → A.vote=restore (later ts wins within same device) → alive

Affected entities: notes, snapshots, lists.

### 4.3 Sync cursor tracking

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

### 5.1 `resolveListKey`: prefer `listId`

```js
async function resolveListKey(parents, name, entry) {
  // Prefer stable ID from event (sync-safe)
  if (entry?.listId) {
    const id = entry.listId;
    return id.startsWith('list:') ? id
         : id.startsWith('system/') || id.startsWith('auto/') ? `list:${id}`
         : `list:${id}`;
  }
  // Fall back to parents+name resolution (legacy events without listId)
  // ... existing logic ...
}
```

Pass `entry` to `resolveListKey` in every action branch that calls it.

### 5.2 `rate_page` / `leave_page`: per-device timestamp guard

```js
// Before:
if (entry.timestamp > prevTimestamp) {
  updated.likes = (updated.likes || 0) + entry.likes;
}

// After:
const deviceTs = (page.remotes?.[entry.deviceId]) || 0;
if (entry.timestamp > deviceTs) {
  updated.likes = (updated.likes || 0) + entry.likes;
  const remotes = { ...(page.remotes || {}) };
  remotes[entry.deviceId] = entry.timestamp;
  updated.remotes = remotes;
}
updated.timestamp = Math.max(page.timestamp || 0, entry.timestamp);
```

Same pattern for `leave_page` (`timeOnPage`, `scrollDepth`).

Events without `deviceId` (legacy): use `entity.timestamp` as before (backward compat).

### 5.3 `reparent_list`: incremental with index hint

```js
if (entry.action === 'reparent_list') {
  const listKey = entry.listId ? `list:${entry.listId}` : await resolveListKey(...);
  if (!listKey) return result;

  const entity = await loadOrDefault(listKey, load);
  const fromKey = entity.parentList || 'list:system/root';

  // Resolve destination
  const toKey = entry.toParentId
    ? (entry.toParentId === 'system/root' ? 'list:system/root' : `list:${entry.toParentId}`)
    : /* legacy toParents resolution */;

  // Remove from old parent (set-remove, idempotent)
  const fromEntity = result[fromKey] || await loadOrDefault(fromKey, load);
  result[fromKey] = {
    ...fromEntity,
    timestamp: Math.max(fromEntity.timestamp || 0, entry.timestamp),
    childLists: (fromEntity.childLists || []).filter(k => k !== listKey),
  };

  // Add to new parent (set-add with index hint, idempotent)
  const toEntity = (toKey === fromKey)
    ? result[fromKey]
    : (result[toKey] || await loadOrDefault(toKey, load));
  let childLists = [...(toEntity.childLists || [])].filter(k => k !== listKey);
  const idx = (entry.index != null)
    ? Math.min(entry.index, childLists.length)
    : childLists.length;
  childLists.splice(idx, 0, listKey);
  result[toKey] = {
    ...toEntity,
    timestamp: Math.max(toEntity.timestamp || 0, entry.timestamp),
    childLists,
  };

  // Update entity's parentList
  result[listKey] = {
    ...entity,
    parentList: toKey,
    timestamp: Math.max(entity.timestamp || 0, entry.timestamp),
  };

  // Update name-to-id paths (derived from parents/name/toParents — kept in event)
  // ... existing path rename logic using parents+name fields ...

  return result;
}
```

Key properties:
- `filter(k => k !== listKey)` before splice ensures idempotency
- Two concurrent reparents to the same parent: both append, both present
- Index is best-effort: clamped if concurrent inserts shift positions

### 5.4 `delete_*` / `restore_*`: deleteVotes

```js
// delete_note example:
if (entry.action === 'delete_note') {
  const note = await loadOrDefault(noteKey, load, { includeDeleted: true });

  // Update deleteVotes
  const deleteVotes = { ...(note.deleteVotes || {}) };
  const deviceId = entry.deviceId || '_local';
  const existingVote = deleteVotes[deviceId];
  if (!existingVote || entry.timestamp > existingVote.ts) {
    deleteVotes[deviceId] = { action: 'delete', ts: entry.timestamp };
  }

  // Derive deleted state
  const allDelete = Object.keys(deleteVotes).length > 0 &&
    Object.values(deleteVotes).every(v => v.action === 'delete');

  if (!allDelete) return result;  // restore-wins: skip delete effects

  // All votes agree on delete — apply effects
  // ... existing unlink/orphan logic ...
  result[noteKey] = { ...note, deleted: true, deleteVotes, timestamp: entry.timestamp };
  await orphan(noteKey, entry.timestamp);
  return result;
}

// restore_note example:
if (entry.action === 'restore_note') {
  const note = await loadOrDefault(noteKey, load, { includeDeleted: true });

  // Update deleteVotes
  const deleteVotes = { ...(note.deleteVotes || {}) };
  const deviceId = entry.deviceId || '_local';
  const existingVote = deleteVotes[deviceId];
  if (!existingVote || entry.timestamp > existingVote.ts) {
    deleteVotes[deviceId] = { action: 'restore', ts: entry.timestamp };
  }

  // Restore always applies (restore-wins)
  // ... existing restore logic ...
  result[noteKey] = { ...note, deleted: false, deleteVotes, timestamp: entry.timestamp };
  await unorphan(noteKey, entry.timestamp);
  return result;
}
```

Same pattern for `delete_snapshot`/`restore_snapshot` and `delete_list`/`restore_list`.

### 5.5 `entity.timestamp` semantics

All `effectOf` branches that set `timestamp` use `Math.max`:

```js
// Before:
result[pageKey] = { ...page, timestamp: entry.timestamp };

// After:
result[pageKey] = { ...page, timestamp: Math.max(page.timestamp || 0, entry.timestamp) };
```

Ensures `entity.timestamp` is the latest modification across all devices, regardless of replay order. Used for display, sorting, and LRU eviction watermark.

### 5.6 Commutativity summary

| Operation | Mechanism | Commutative? |
|-----------|-----------|:---:|
| `visit_page` (set-add: visitDates, parentIds, childIds) | `!includes` guard | Yes |
| `visit_page` (capped arrays) | `shift()` on overflow | ~Yes (low-impact) |
| `leave_page` (timeOnPage, scrollDepth) | Per-device timestamp guard | Yes |
| `rate_page` (likes) | Per-device timestamp guard | Yes |
| `rename_page` (user_title) | Last-write-wins (`Math.max` timestamp) | Yes |
| `pin_to_list` / `unpin_from_list` | Set-add/remove with idempotency guard | Yes |
| `create_note` / `create_snapshot` | Set-add link | Yes |
| `delete_*` / `restore_*` | deleteVotes with restore-wins | Yes |
| `create_list` | ID in event, set-add to parent | Yes |
| `update_list` (rename) | `listId` for resolution, last-write-wins on name | Yes |
| `reparent_list` | `listId` + incremental + index hint | Yes |
| `add_rule` / `remove_rule` | ID-based set-add/remove | Yes |
| `update_setting` | Last-write-wins per key | Yes |

## 6. Sync Protocol

### 6.1 Device initialization

When user enables sync in settings:
1. Generate `deviceId` via `crypto.randomUUID()`, store in `manifest/settings.json`
2. User configures: GitHub repo URL + personal access token
3. Extension creates a branch named `<deviceId>` in the repo (if not exists)

### 6.2 Push cycle

Triggered by `chrome.alarms` (configurable interval, default 5 min) or manual button.

1. Collect local files to push:
   - `data/logs/YYYY-MM-DD-<myDeviceId>.jsonl` — only within retention window (default 7 days)
   - `data/notes/*.json` — all
   - `data/snapshots/*/` — all (or size-capped, deferred optimization)
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
   c. Download new log files, notes, snapshots via blob API
   d. Write to local `data/` directory (log files keep their device-specific names)
   e. Replay new log entries via `replayRemoteEntries()` (see 6.4)
   f. Update sync cursor

### 6.4 Remote log replay

Remote entries are replayed in background.js using the same `effectOf` + `sessionWrite` pipeline, but NOT through `addLog`:

```js
async function replayRemoteEntries(entries) {
  for (const entry of entries) {
    const effects = await effectOf(entry, sessionLoad);
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

Per the project's data migration policy: migrate `~/portal-data` on disk first, then upgrade extension code.

### 7.1 Entity migration

Script: `scripts/migrate-sync-schema.mjs`

- `pages/*.json`: add `remotes: {}`
- `lists/*.json`, `data/notes/*.json`: add `deleteVotes: {}`
- Create `manifest/sync-cursors.json`: `{ timestamp: 0, cursors: {} }`

### 7.2 Log file migration

Rename existing `data/logs/YYYY-MM-DD.jsonl` → `data/logs/YYYY-MM-DD-<deviceId>.jsonl`.

Requires device ID generation before migration. The script generates one and writes it to `manifest/settings.json` if not present.

### 7.3 Event migration

Existing JSONL entries don't have `deviceId` or `listId`. No migration needed — `effectOf` treats missing `deviceId` as local and falls back to `parents`+`name` when `listId` is absent.

### 7.4 Reparent format migration

Existing `reparent_list` entries have `childNames`. The updated `effectOf` handles both formats:

```js
if (entry.childNames) {
  // Legacy: complete replacement (existing logic)
} else {
  // New: incremental with index hint
}
```

## 8. Implementation Phases

### Phase 0: Replay commutativity (no sync yet)

Make `effectOf` order-independent. Prerequisite for sync, also improves single-device replay correctness.

1. Add `deviceId` to all entries in `addLog()` (background.js)
2. Add `listId` to all list-referencing entries at call sites (background.js)
3. Pre-generate `listId` for `create_list` (background.js handler)
4. Change `reparent_list` event format + handler (background.js + replay.js)
   - Keep backward compat for old `childNames` format
5. Per-device timestamp guards for `rate_page`, `leave_page` (replay.js)
6. `deleteVotes` + restore-wins for delete/restore branches (replay.js)
7. `resolveListKey` prefers `entry.listId` (replay.js)
8. `Math.max` for all `entity.timestamp` assignments (replay.js)
9. Device-specific log file naming (`YYYY-MM-DD-<deviceId>.jsonl`)
10. Entity schema migration script
11. Tests: replay same entries in different orders, assert identical final state

### Phase 1: Sync transport

1. `deviceId` generation + storage in settings
2. Settings UI: repo URL, personal access token, sync toggle, retention window
3. `SyncTransport` module — GitHub API adapter:
   - `listBranches()`, `getTree(branch)`, `getBlob(sha)`, `pushTree(branch, files)`
4. `host_permissions` in manifest.json for `https://api.github.com/*`

### Phase 2: Push & pull

1. Push cycle: collect local files → compare with push state → create orphan commit → force-push branch
2. Pull cycle: list branches → for each peer, compare tree → download new files → write to `data/`
3. Remote log replay: `replayRemoteEntries()` using `effectOf` + `sessionWrite`
4. Sync cursor tracking: `manifest/sync-cursors.json`
5. `chrome.alarms` for periodic sync
6. Manual sync button in settings UI

### Phase 3: Polish

1. Sync status indicator (last sync time, peer list, errors)
2. Hydration with multi-device log files (scan all `*.jsonl`, local first)
3. Retention enforcement (exclude old logs from push)
4. Error handling: network failures, auth errors, rate limits
5. Conflict visibility: notification when restore-wins overrides a local delete

## 9. Open Questions (deferred)

1. **Snapshot size**: Large snapshots may make pushes slow. Options: skip snapshots over N MB, compress before push, or use GitHub LFS.
2. **GitLab/Gitea support**: Add `SyncTransport` adapters when needed. API surface is small.
3. **Token security**: `chrome.storage.local` for tokens. Acceptable for v1; could use OS keychain via native messaging later.
4. **Offline gap**: Device offline > retention window misses peer logs. Accept as limitation; manual file copy is fallback.
5. **History view**: Should remote visits appear in the Explore timeline? Deferred — start with entity-only enrichment.
