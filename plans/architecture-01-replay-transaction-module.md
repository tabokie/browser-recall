# Deepen the Replay Transaction Module

## Objective

Concentrate replay evaluation, durable ordering, projection updates, replay progress, and checkpoint submission behind one daemon-owned module. Command, connector-ingest, remote-replay, and sync callers should not need to reproduce the write protocol.

## Implementation status

Completed on 2026-07-03.

- `ReplayTransaction` now owns serialization, evolving replay effects, checkpoint-capacity reservation, canonical local log append, projection-cache publication, replay progress, and ordered checkpoint submission.
- Command mutations begin a transaction before semantic read/modify/write work, preserving atomic behavior without acquiring storage write guards themselves.
- Connector ingest, auto-pin synthesis, rule batches, and remote replay use the evolving transaction effects and no longer perform commit ordering in `ws_server.rs`.
- Sync parses all remote entries before mutation, then uses `install_remote_files` to flush prior checkpoint work, install downloaded files once, replay typed entries, and publish projection/checkpoint work without duplicate log append.
- Startup recovery and destructive flush-and-clear coordination are runtime-owned.
- Replay entity-load failures are explicit and abort before log append; they are no longer treated as missing entities.
- Remote log JSON and replay effects are validated before downloaded files are written, so a malformed or unreplayable download cannot partially install.
- Runtime integration tests cover local append, remote-file installation, and storage read failure. Daemon, replay, connector event-flow, formatting, and clippy verification pass.

Resolved design questions:

- Downloaded remote files are installed inside the runtime module after sync has fetched and strictly parsed their entries.
- Mutation derivation remains command/connector policy and consumes the per-entry effects returned by `ReplayTransaction::apply`.
- Auto-pin synthesis remains connector command policy and reads the transaction's evolving effects before adding synthetic entries to the same transaction.
- Local append and downloaded remote installation are explicit operations sharing the runtime implementation rather than one mode flag.
- Low-level checkpoint/cache methods remain public for focused storage integration tests, but `runtime.rs` is their only production caller.

## Why

Before this work, the `runtime.rs` interface was shallow. It centralized overlay evaluation, while callers still knew when to acquire the write guard, flush checkpoint work, reserve capacity, append logs or write downloaded files, update the projection cache, advance replay progress, and enqueue checkpoint persistence.

This is a data-integrity seam. Deepening it improves locality for crash-safety rules and gives every writer leverage from one tested implementation.

## Invariants to preserve

- Logs remain authoritative.
- Local writes reserve checkpoint-worker capacity before durable mutation.
- Canonical logs are durable before the in-memory projection changes.
- Checkpoint work is submitted in accepted write order.
- Acknowledged writes remain recoverable when checkpoints lag.
- Replay progress advances only for entries reflected in durable checkpoints.
- Every replay branch remains idempotent.
- Strict replay parsing rejects command-only fields.
- Coordinated cache misses reach disk; there are no silent fallbacks.
- Shutdown and destructive operations cannot race stale checkpoint work.
- Local append and already-downloaded remote-log ingestion remain distinct where durability semantics differ.

## Files in scope

- `crates/daemon/src/runtime.rs`
- `crates/daemon/src/commands.rs`
- `crates/daemon/src/ws_server.rs`
- `crates/daemon/src/sync.rs`
- `crates/daemon/src/storage.rs`
- `crates/replay/src/lib.rs`
- `crates/daemon/tests/commands.rs`
- `crates/daemon/tests/ingest.rs`
- `crates/daemon/tests/storage.rs`
- `crates/daemon/tests/sync_controller.rs`
- Relevant connector/sync E2E coverage
- `docs/ARCHITECTURE.md`
- `docs/CODEBASE_MAP.md`

## Non-goals

- Changing the replay log schema.
- Moving storage authority out of the daemon.
- Adding extension-side persistence or migration behavior.
- Combining local log append with remote file installation when their durability requirements differ.
- Redesigning sync transport.

## Implementation plan

### 1. Establish failing regression coverage

- Add daemon integration coverage at the current writer seams before moving code.
- Cover local command batches, connector entries with synthesized auto-pins, remote replay batches, and sync-delivered entries.
- Exercise duplicate application, invalid replay records, checkpoint lag, progress recovery, and destructive-operation flushing.
- Add a test that demonstrates the currently duplicated sync ingestion sequence can diverge from the command sequence.
- Confirm the new or strengthened tests fail for the intended architectural gap, not for fixture setup.

### 2. Define the replay transaction seam

- Place the authoritative transaction interface in the daemon runtime area.
- Represent the caller’s intent explicitly enough to distinguish locally appended entries from already-downloaded remote logs.
- Keep lock ownership, overlay evolution, checkpoint capacity, durable ordering, cache application, replay progress, and checkpoint submission inside the module.
- Return accepted effects and metadata needed for mutation notification without exposing storage sequencing.
- Keep auto-pin policy either behind this seam or as an explicit pre-commit policy step; do not let it recreate transaction ordering in `ws_server.rs`.

### 3. Migrate local command writes

- Replace `commands.rs` ownership of `replay_entries_locked` and `commit_effects_locked` with the deepened runtime module.
- Keep semantic command validation and log construction in the command module.
- Remove direct checkpoint-capacity, cache-application, and replay-progress knowledge from command callers.
- Run focused daemon command tests after each mutation family moves.

### 4. Migrate connector ingest and remote replay

- Route normal connector ingestion through the same transaction interface.
- Preserve synthesized auto-pin ordering in the accepted batch.
- Route remote replay through the same overlay and commit implementation.
- Derive mutation notifications from the accepted entries/effects rather than independently reconstructing replay state.
- Remove duplicated write-guard and commit sequencing from `ws_server.rs`.

### 5. Migrate sync ingestion

- Preserve the distinction between installing downloaded files and appending a new local log.
- Move shared overlay, projection, progress, and checkpoint behavior behind the runtime module.
- Keep remote-file validation and transport concerns in the sync implementation.
- Ensure invalid remote entries fail explicitly rather than being skipped or defaulted.

### 6. Narrow storage implementation exposure

- Make checkpoint permits, direct cache mutation, and checkpoint-work submission internal to the replay transaction implementation where practical.
- Retain public storage operations required by reads, snapshots, sync file transport, and destructive operations.
- Apply the deletion test: transaction sequencing should not remain reconstructible from a broad set of public storage methods.

### 7. Verify and document

- Run focused daemon integration tests, sync tests, connector event-flow tests, and replay verification.
- Run Rust formatting and clippy.
- Update `docs/ARCHITECTURE.md` and `docs/CODEBASE_MAP.md` to name the replay transaction module and its callers.
- Remove obsolete comments and helpers after all callers migrate; do not retain compatibility paths.

## Test surface after the change

- The replay transaction interface is the primary integration-test surface.
- Command tests verify semantic event construction and observable state.
- Connector and sync tests verify their adapter-specific preparation and resulting mutations.
- Storage tests retain filesystem/checkpoint implementation coverage without duplicating the full transaction protocol.

## Risks

- Collapsing local and remote durability semantics could append duplicate logs or advance progress too early.
- Moving auto-pin synthesis could change event order or mutation payloads.
- A lock-ownership mistake could deadlock checkpoint flush or allow concurrent writes.
- Returning too much transaction detail would produce a new shallow interface.

## Unresolved questions

- Should downloaded remote log files be installed inside the transaction module or prepared by sync before transaction application?
- Should mutation derivation live inside the transaction module or consume a normalized transaction result in the command authority module?
- Should auto-pin synthesis be transaction policy or command policy?
- Which storage methods can become private without obstructing replay verification and recovery?
- Does replay progress need one abstraction for local and remote device entries, or two explicit modes?
