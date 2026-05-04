# 35 - Log and Checkpoint Runtime

## Context

The previous draft was wrong in one important way: it treated log batches as something outer command code could generate and submit to a runtime queue.

That breaks the original architecture. Log generation depends on the latest consistent checkpoint/cache projection, so log generation must happen inside the central write authority. Otherwise two commands can both read the same checkpoint view, generate conflicting logs, and only later serialize those logs.

The correct model is:

- the central runtime owns log generation and cache mutation;
- logs are appended synchronously before cache is updated;
- cache and logs never have gaps;
- checkpoint/entity files are updated asynchronously from accepted effects;
- shutdown drains checkpoint persistence.

This plan refactors the daemon/Desktop write architecture around that model.

## Drift From Pre-Desktop Architecture

This refactor is specifically meant to correct architectural drift introduced during the desktop port.

The pre-desktop extension had these important properties:

- `addLog` was the central write authority;
- writes were serialized before log generation/effect application;
- the durable log buffer was persisted before cache mutation;
- cache was the current projection, including pending logs;
- checkpoint/entity files were derived materialized state and could lag;
- offscreen drain appended JSONL logs before flushing checkpoint files.

The desktop port kept replay/event names but changed several authority boundaries:

- `replay_entry` and websocket ingest apply effects/checkpoints before appending logs;
- `Storage::apply_effect` writes checkpoint files directly, making checkpoints part of the command success path;
- Tauri desktop commands and websocket connector commands do not yet share one write authority;
- `Storage` cache is a lazy filesystem memoizer that can cache missing/stale data instead of being only the replay projection;
- raw sync file writes can update disk without updating/invalidation of the cache projection;
- some replay/delete effects now physically remove checkpoint files where the old model preserved recoverable deleted state.

The implementation is not complete until these drifts are eliminated or deliberately documented as new product semantics.

## Core Workflow

Normal write command shape:

```rust
async fn write_cmd_x(runtime: &RuntimeHandle, args...) -> Result<Response> {
    // Optional pre-log external I/O that does not mutate replayable state.
    // Example: write snapshot HTML/Markdown and get actual paths.
    let precomputed = prepare_external_payload(args).await?;

    let outcome = runtime
        .write(|state| {
            // This closure runs under the runtime write critical section.
            // It sees the latest consistent cache/checkpoint projection.

            // Reserve checkpoint queue capacity before doing irreversible work.
            let checkpoint_slot = state.reserve_checkpoint_slot()?;

            let logs = generate_logs(&state.cache, precomputed)?;
            let effects = effect_of(logs, &state.cache)?;

            // Runtime appends logs synchronously before cache mutation.
            state.append_logs_sync(&logs)?;

            // Only after durable log append succeeds:
            state.apply_effects_to_cache(&effects);

            // Checkpoint file writes are async and can lag.
            state.enqueue_checkpoint_effects(checkpoint_slot, effects.clone());

            Ok(WriteOutcome { logs, effects })
        })
        .await?;

    // Response can be composed after cache update.
    let data = runtime.read(...).await?;
    Ok(build_response(outcome, data))
}
```

The essential invariant:

```text
if cache reflects a write, the corresponding log entry has already been appended
```

Checkpoint files may lag behind cache/logs. On restart, logs repair/reconstruct the checkpoint projection.

## Target Architecture

```text
Desktop UI / extension / sync / tests
        |
        v
typed read/write command API
        |
        v
RuntimeHandle
  - cache-first reads
  - central write critical section
        |
        v
write critical section
  - generate logs from latest cache/checkpoint view
  - append logs synchronously
  - apply effects to cache
  - emit UI mutations
  - enqueue checkpoint effects
        |
        v
checkpoint I/O worker
  - persist affected entity/checkpoint files from effects
```

There is no normal write command queue. The write lock/critical section is the serialization mechanism.

There is still an async checkpoint queue, but it carries effects/checkpoint work only. It does not carry log entries as the primary source of durability, because logs are already synchronously appended.

## Read Semantics

Reads are cache-first:

```text
read(key)
  -> if cache hit: return directly
  -> if cache miss:
       acquire runtime coordination
       double-check cache
       read disk checkpoint/log-derived file if still missing
       populate cache
       return value
```

Cache-hit reads do not need to enter the write critical section.

Cache-miss disk reads must coordinate with the runtime so they do not race with a writer that is generating logs or mutating cache. The implementation can use the same write mutex, an async runtime op, or a read/write gate, but the guarantee is:

```text
disk fallback reads cannot overwrite or observe around an in-progress cache mutation
```

## Key Decisions

### Log Generation Is Centralized

Outer command handlers must not generate replayable logs independently and later submit them.

Instead, each write command calls a runtime write method that runs command-specific logic under the runtime write critical section.

Examples:

- `saveSettingsKey` runs inside runtime and emits `UpdateSetting`;
- `saveListMeta` runs inside runtime and emits `CreateList` or `UpdateList`;
- `toggleListPin` runs inside runtime and emits `PinToList` or `UnpinFromList`;
- `ensureDefaultLists` runs inside runtime and emits `[CreateList, AddRule]`;
- remote replay runs inside runtime and replays supplied logs in order;
- import commands chunk work, but each chunk's log generation/replay happens inside runtime.

### Logs Are Synchronous

Runtime must append logs before applying effects to cache.

If log append fails:

- no cache update;
- no checkpoint effect enqueue;
- no mutation notification;
- write command returns an error.

This preserves the no-gap invariant between logs and cache.

### Checkpoint Queue Capacity Is Reserved First

The checkpoint I/O queue is bounded. A write command must reserve checkpoint queue capacity before doing irreversible work such as synchronous log append.

Recommended sequence inside the write critical section:

```text
reserve checkpoint queue slot
generate logs from latest cache view
compute effects
append logs synchronously
apply effects to cache
send checkpoint effects using reserved slot
emit mutation
ack command
```

If queue reservation fails:

- no log generation side effects;
- no log append;
- no cache update;
- no mutation notification;
- command returns an error.

Use `queue.reserve().await` or the equivalent bounded-channel permit API so capacity is guaranteed before log append begins.

### Checkpoints Are Asynchronous

Checkpoint/entity files are derived data. They can lag behind logs/cache.

After successful log append and cache apply, runtime sends checkpoint effects to an I/O worker:

```rust
pub struct CheckpointBatch {
    pub effects: EntityMap,
}
```

The checkpoint worker writes affected entity files/manifests. It does not decide command semantics.

### Effects Are Generated Once

The write critical section computes effects using the latest cache/checkpoint view.

Those effects are:

- applied to cache immediately;
- sent to the checkpoint worker;
- used to derive UI mutation notifications.

The checkpoint worker should not recompute effects from logs.

### Replay Semantics Must Match the Old Model

Port correctness is not only about ordering. The Rust replay engine must preserve the old entity semantics unless a product decision explicitly changes them.

Audit and test at least:

- note replacement: old note should remain recoverable/orphaned/replaced, not silently disappear unless permanent-delete semantics apply;
- list deletion/restoration: deleted lists remain recoverable and relationship cleanup matches replay output;
- page garbage collection effects: page checkpoint deletion is allowed only when the replay model says the page is ineligible and no recoverable data depends on it;
- snapshot deletion/restoration: sidecar file handling and replay state must agree on the actual snapshot path/stem;
- permanent delete: this is the path that may physically remove recoverable artifacts and references.

### Snapshot Files Are Pre-Log External I/O

Snapshot HTML/Markdown materialization is allowed before entering the runtime write critical section because it does not mutate replayable log/entity state.

Snapshot capture flow:

1. write snapshot HTML/Markdown files;
2. obtain actual persisted paths/stems;
3. enter runtime write critical section;
4. generate `LogEntry::CreateSnapshot` using the actual path payload;
5. synchronously append the snapshot log;
6. apply cache effects;
7. enqueue checkpoint effects;
8. return response including the actual snapshot paths.

If snapshot file materialization fails, no log is generated and cache remains unchanged.

### Maintenance Operations Are Separate

The following are not normal replayable user log writes:

- `clearAllData`;
- `testResetData`;
- `testSeedData`;
- raw sync file writes/resets;
- device-id/layout maintenance.

They still coordinate with runtime so they do not race with command writes or cache-miss disk loads.

Raw sync file writes are especially risky because they can mutate files behind the cache. After this refactor, sync ingestion must either:

- replay remote logs through the runtime authority, updating cache/effects/checkpoints in order; or
- run as a runtime maintenance operation that clears/rebuilds affected cache state before reads resume.

It must not leave cached misses or stale cached entities live after writing files.

### Imports Are Chunked

Large imports should chunk work, for example 250 or 500 entries at a time.

Each chunk runs through the central write critical section. This prevents long stalls while preserving ordering.

### Remote Replay Uses the Same Authority

Remote sync replay must go through the same runtime authority. It may supply already-existing logs, but runtime still owns applying them against the latest cache/checkpoint view, appending accepted logs if needed, applying effects, and enqueueing checkpoints.

There is one global write authority, not per-device queues.

### UI Mutations Are Derived

`MutationPayload` is UI invalidation metadata only. It is derived from logs/effects after cache apply.

It is not durable data and should not drive persistence.

## Runtime API Shape

The runtime should expose typed write methods or a small command-dispatch API. It should not expose `submit(Vec<LogEntry>)` as the main write primitive for normal local commands, because that would decentralize log generation.

Suggested shape:

```rust
#[derive(Clone)]
pub struct RuntimeHandle {
    // shared cache/checkpoint state, write gate, checkpoint worker sender
}

impl RuntimeHandle {
    pub async fn read(&self, key: &str) -> Result<Option<Entity>, RuntimeError>;

    pub async fn write_command(
        &self,
        command: RuntimeWriteCommand,
    ) -> Result<RuntimeWriteResponse, RuntimeError>;

    pub async fn maintenance(
        &self,
        op: MaintenanceOp,
    ) -> Result<MaintenanceResult, RuntimeError>;

    pub async fn shutdown_and_flush(&self) -> Result<(), RuntimeError>;
}
```

`RuntimeWriteCommand` can be typed enum variants, or this can be represented as typed methods:

```rust
runtime.save_list_meta(request).await?;
runtime.toggle_list_pin(request).await?;
runtime.create_note(request).await?;
```

The important rule is not the exact API style. The rule is that command-specific log generation runs inside the runtime write critical section.

## Module Responsibilities

### `runtime`

New module, likely `crates/daemon/src/runtime.rs`.

Responsibilities:

- owns cache/checkpoint projection;
- owns the write critical section;
- owns synchronous log append path;
- owns checkpoint effect queue;
- exposes cache-first reads;
- coordinates cache-miss disk loads;
- emits mutation notifications;
- tracks checkpoint backlog and failure state;
- handles graceful shutdown.

### `commands`

Keep command-specific logic close to command functions, but make sure write command logic executes inside runtime authority.

Possible approach:

- `commands.rs` contains helper functions that assume they are called with a `RuntimeWriteState`;
- those helpers can read cache and generate logs/effects;
- they cannot directly append logs, mutate cache, or write checkpoints.

Avoid planner/finisher abstractions unless they become necessary.

### `storage`

Split the current mixed cache+disk behavior:

- log append helpers: synchronous/awaited durable log writes;
- checkpoint file helpers: async derived entity/manifests writes;
- disk fallback read helpers for cache misses.

Command code should stop using direct mutation helpers like `apply_effect` or `append_log_entry`.

### `ws_server`

Reduce to transport/protocol:

- pairing/auth;
- websocket decode/encode;
- connected connector status;
- map connector messages to runtime read/write methods;
- no ownership of write semantics.

The current `WriteOp` actor in `ws_server.rs` is transitional and should be removed, not evolved.

### `desktop main.rs`

Desktop should hold a `RuntimeHandle` directly. It should not treat `ServerControlHandle` or websocket server as the write owner.

For embedded Desktop, Tauri and websocket server should be peers using the same runtime.

Tauri command handlers must stop calling mutation helpers such as `submit_event`, `save_list_meta`, `add_list_pins`, note/list/snapshot delete/restore, and rule mutation helpers directly against `Storage`. Those calls should become thin runtime method calls.

## Failure Semantics

### Log Append Failure

Hard failure for the write:

- do not apply cache;
- do not enqueue checkpoint effects;
- do not emit mutation;
- return error.

### Checkpoint Persistence Failure

Logs are already durable and cache may be ahead of checkpoint files.

Recommended behavior:

- pause or mark checkpoint persistence unhealthy;
- surface error in Desktop status;
- keep reads available from cache;
- avoid unbounded checkpoint backlog;
- require restart/resume or explicit recovery before continuing normal writes.

This policy can be refined during implementation, but the user-visible status must be clear.

### Shutdown

Shutdown waits indefinitely by default:

1. stop accepting new writes;
2. wait for active write critical section to finish;
3. drain checkpoint effect queue;
4. quit only after accepted checkpoint effects are persisted or a persistence error is surfaced.

No timeout-based data loss path should be introduced.

### No Pending-Checkpoint Journal in This Refactor

Do not add a separate pending-checkpoint journal. Logs are the durable recovery source. Checkpoint lag is repaired by replay.

## Implementation Phases

### Phase 1: Extract Runtime Shell

- Add `crates/daemon/src/runtime.rs`.
- Move shared cache/storage ownership out of `ws_server.rs`.
- Add `RuntimeHandle`.
- Keep existing behavior as much as possible.
- Preserve current tests.

End state: websocket server no longer owns storage/runtime state conceptually.

### Phase 2: Central Write Critical Section

- Add runtime write gate.
- Move local command write execution under the runtime gate.
- Ensure log append happens before cache apply.
- Ensure cache apply happens before response.
- Ensure checkpoint effects are enqueued after cache apply.

End state: no local write can generate logs outside central authority.

### Phase 3: Split Logs From Checkpoints

- Split current `Storage` write methods into:
  - log append;
  - cache apply;
  - checkpoint file persistence.
- Remove command-path direct calls to `apply_effect` and `append_log_entry`.
- Make `Storage::apply_effect` stop writing checkpoint files directly, or replace it with separate `apply_effect_to_cache` and `persist_checkpoint_effect`.
- Add checkpoint I/O worker that consumes effects.

End state: logs are sync, checkpoints async.

### Phase 4: Cache-First Reads With Coordinated Misses

- Add runtime read methods.
- Cache-hit reads bypass coordination.
- Cache-miss reads coordinate with runtime, double-check cache, then load disk.

End state: reads remain cheap without disk-read/write races.

### Phase 5: Convert Command Groups

Convert command groups one at a time:

- settings/page commands;
- list create/rename/delete/tree/pin commands;
- note commands;
- snapshot command with pre-log file materialization;
- rule commands;
- imports with chunking;
- remote replay.

End state: all normal entity-changing commands use runtime authority.

During conversion, grep for direct desktop/connector mutation paths and remove or rewrite every caller:

- direct `commands::*` mutation calls from `apps/desktop/src-tauri/src/main.rs`;
- direct `Storage::apply_effect` calls outside runtime/checkpoint tests;
- direct `Storage::append_log_entry` calls outside runtime log append helpers;
- websocket-owned command/write semantics in `ws_server.rs`.

### Phase 6: Maintenance Ops

- Move `clearAllData`, test reset/seed, raw sync file writes, and device-id/layout maintenance into runtime-coordinated maintenance operations.
- Define cache reset/rebuild behavior for raw sync file writes.

End state: maintenance operations do not race with writes or cache-miss disk loads.

### Phase 7: Shutdown Drain

- Add runtime states: accepting, draining, stopped, paused.
- Make daemon shutdown call runtime drain.
- Make Desktop quit flow wait for runtime drain.
- Add status fields for active write, checkpoint backlog, and checkpoint error.

End state: normal shutdown persists accepted checkpoint work before exit.

### Phase 8: Delete Transitional Actor

- Remove protocol-shaped `WriteOp` variants from `ws_server.rs`.
- Remove websocket-owned writer loop.
- Keep websocket as transport only.

End state: architecture is central runtime authority plus async checkpoint worker.

## Testing Plan

### Unit Tests

- write command appends log before cache apply;
- log append failure leaves cache unchanged;
- checkpoint effects are enqueued after cache apply;
- checkpoint persistence failure surfaces runtime unhealthy state;
- cache-hit read bypasses coordination;
- cache-miss read double-checks cache under coordination;
- snapshot command does not log if snapshot file materialization fails;
- multi-log command cannot interleave with another write;
- shutdown drains checkpoint queue.

### Integration Tests

- Desktop creates list, popup opened later sees it;
- Desktop write then immediate read sees updated cache after await;
- cache-miss read racing with write does not overwrite fresh cache with stale disk;
- cached missing entity becomes visible after a runtime write creates it;
- raw sync ingestion cannot leave stale cached misses or stale cached entities;
- extension offline queue flushes events in order through runtime authority;
- remote replay and local write ordering is deterministic;
- delayed checkpoint persistence still allows cache reads after log append;
- restart after checkpoint lag reconstructs from logs.

### Replay Parity Tests

- replace note preserves old-note recoverability/replaced metadata according to the old replay model;
- delete/restore note, list, and snapshot preserve recycle-bin/orphan semantics;
- permanent delete physically removes only the intended artifacts and references;
- full replay from logs matches checkpoint projection after checkpoint files are deleted/rebuilt.

### E2E Tests

Retain and expand:

- popup opened after Desktop-created list sees latest list;
- popup add-list flow pins current page;
- same-tab navigation records visit/leave correctly;
- badge state follows current cache after page load;
- snapshot capture returns actual persisted snapshot paths.

## Migration and Compatibility

No user data migration should be needed. The log format remains the source of truth.

Compatibility paths should be avoided. If an old action name is still present only for tests or stale UI code, update the caller and remove it.

## Risks

- Splitting current `Storage` behavior into log append, cache apply, and checkpoint persistence is the highest-risk part.
- Holding the write critical section while appending logs means log I/O latency is on the command path. This is intentional for correctness.
- Checkpoint persistence failure policy needs careful UX because logs/cache may be correct while checkpoint files lag.
- Imports need chunking to avoid holding the write section too long.
- Snapshot pre-log file materialization can leave orphan files if later log append fails; cleanup is useful but not correctness-critical because no replayable state points to them.

## First Implementation Cut

The first safe cut should be:

1. create `runtime.rs`;
2. move shared storage/cache ownership out of `ws_server.rs`;
3. expose `RuntimeHandle` to both Tauri and websocket server;
4. keep existing behavior and tests passing;
5. only then split log append/cache apply/checkpoint persistence.
