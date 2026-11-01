# 35 — Log and Checkpoint Runtime

Historical refactor plan. Use [Architecture](../docs/ARCHITECTURE.md#writes-and-recovery)
for the current contract and [Codebase Map](../docs/CODEBASE_MAP.md) for current APIs.

## Purpose

Restore one daemon write authority after the desktop port. Generating logs before
acquiring the write gate lets concurrent commands read stale state and generate
conflicting events. Log generation, replay, and publication must share the same
critical section.

The desktop port had also put checkpoint writes before log durability, divided
command ownership between Tauri and WebSocket, and allowed raw sync writes to
leave stale cache entries. The refactor separates accepted state from derived
checkpoint persistence.

## Write protocol

```text
Tauri / extension / imports / sync
                  ↓
        central runtime write gate
                  ↓
reserve checkpoint queue capacity
read current state and generate logs/effects
append logs synchronously
apply effects to memory
queue the same effects for checkpoint persistence
publish notifications and return success
```

If memory reflects a write, the corresponding log must already be durable.
Checkpoint files may lag; startup replay repairs that lag. The checkpoint queue
carries computed effects, not commands awaiting log generation. The worker never
recomputes command semantics.

Reservation must precede irreversible work. Failed reservation or log append leaves
memory, notifications, and checkpoint submission unchanged. Use a bounded-channel
permit so accepted logs cannot later fail merely because the checkpoint queue is full.

## Reads and maintenance

Cache hits return current state. Cache misses coordinate with runtime writes,
double-check memory, then load disk. A stale disk read must never overwrite a newer
in-memory value or preserve a cached miss after creation.

Reset, deletion, device/layout maintenance, test seeding, and raw sync installation
use the same coordination. Sync either replays remote events through runtime or
installs files while rebuilding affected memory. Remote logs are not appended
again as local events. There is one write authority, not one queue per device.

Snapshot HTML/Markdown may be materialized before the write gate because payload
files are external to replay state. Generate the event from the actual persisted
paths. Failed materialization creates no event; failed log append may leave an
unreferenced payload that can be cleaned later.

Imports use bounded chunks to avoid holding the write gate for an entire import.
Mutation notifications derive from accepted effects and never drive persistence.

## Module responsibilities

| Module                | Responsibility                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `runtime.rs`          | Write gate, current projection, log ordering, checkpoint submission, coordinated reads/maintenance, shutdown |
| `commands.rs`         | Command-specific validation and log generation inside runtime authority                                      |
| `storage.rs`          | Separate log append, memory publication, checkpoint persistence, and disk fallback                           |
| `ws_server.rs`        | Authentication, protocol encoding, sessions, command adaptation                                              |
| Desktop Tauri adapter | Native operations and calls to the shared authority                                                          |

Expose typed commands or methods. A public local-command API accepting prebuilt
`Vec<LogEntry>` would move log generation outside the authority again. Remove the
transitional WebSocket `WriteOp` actor and direct adapter mutations once callers
use runtime.

## Failure and shutdown

Checkpoint failure occurs after logs are durable. Surface unhealthy persistence,
keep current reads available, and bound backlog; resume/recovery policy must remain
visible to the user. Do not add a second pending-checkpoint journal.

Shutdown stops new writes, waits for the active command, and drains accepted
checkpoint work. Surface persistence failure rather than introducing a timeout
that silently discards accepted data. Destructive maintenance must prevent queued
older writes from recreating deleted files.

## Implementation sequence

1. Extract shared runtime ownership from WebSocket without changing behavior.
2. Move command-specific log generation under the write gate.
3. Separate log append, memory application, and checkpoint persistence.
4. Coordinate cache misses and maintenance.
5. Convert settings, pages, lists, notes, snapshots, rules, imports, and remote replay.
6. Add shutdown drain and persistence health reporting.
7. Remove transitional actors and direct storage mutation callers.

Preserve recoverable note replacement, list/note/snapshot deletion and restoration,
checkpoint eligibility, and explicit permanent-delete semantics. The log format
should remain unchanged; remove stale action callers rather than adding compatibility
paths.

## Validation

Exercise the production command/storage boundary with controlled failures:

- Log append fails before memory, checkpoint work, or notification changes.
- Reads see accepted writes before checkpoints finish; restart reconstructs lagging
  checkpoints from logs.
- Coordinated disk fallback cannot replace fresh state with stale files.
- Multi-event commands cannot interleave; local writes and remote replay serialize.
- Reset/deletion/sync cannot retain stale records or revive deleted files.
- Shutdown drains accepted work; checkpoint failures remain visible.
- Replay preserves replacement, restore, and permanent-delete relationships.
- Popup reads see desktop changes; offline commands drain in order; snapshots return
  actual persisted paths.

The main risks are splitting storage responsibilities, command-path log I/O,
checkpoint failure recovery, long imports, and orphaned snapshot payloads. Migrate
one command family at a time and retain failing regression evidence.
