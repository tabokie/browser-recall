# Remove the Unused WebSocket History-Search Path

Status: implemented on 2026-07-03.

## Objective

Remove the unused WebSocket full-history search protocol and session lifecycle. Keep Desktop Explore history search on the Tauri path and retain the daemon search algorithm implementation.

## Why

The shipped extension popup requests current-page summaries and does not expose full-history search. Nevertheless, the WebSocket protocol and server maintain search-start, cancellation, token-map, worker, chunk, completion, error, and disconnect-cleanup behavior parallel to the active Tauri search path.

One active caller does not justify a second adapter or a shared seam. If removal makes complexity disappear rather than moving it to another active caller, the WebSocket search path is unused capability.

## Decision

The implementation request resolves the product gate in favor of removal. No shipped or committed connector workflow consumes full-history search, and no new connector search experience is inferred from protocol code alone.

## Invariants to preserve

- Desktop Explore retains cancellable, parallel, streaming history search.
- Starting a newer desktop search cancels or supersedes stale work.
- Leaving search mode stops obsolete work.
- Note and snapshot search phases retain their current daemon-owned behavior.
- Connector current-page summary behavior is unchanged.
- Removing protocol variants does not affect pairing, normal command RPC, or daemon mutation broadcasts.
- Unsupported legacy search messages fail explicitly after removal rather than being silently ignored.

## Files in scope

- `crates/daemon/src/protocol.rs`
- `crates/daemon/src/ws_server.rs`
- `apps/extension/connector/ws-client.js`
- `apps/desktop/src-tauri/src/main.rs`
- `crates/daemon/src/search.rs`
- WebSocket search tests in daemon/integration suites
- Desktop search tests and `tests/e2e/desktop-visual.spec.js`
- `ARCHITECTURE.md`
- `CODEBASE_MAP.md`

## Non-goals

- Redesigning Desktop Explore search.
- Adding full-history search to the extension.
- Moving desktop search onto WebSocket.
- Removing shared search algorithms used by the daemon or desktop.
- Changing ranking, query parsing, chunk ordering, or note/snapshot phases.

## Implementation plan

### 1. Establish a desktop-search safety baseline

- Ensure existing desktop visual E2E covers search start, chunk rendering, replacement by a newer query, cancellation, completion, and stale-result suppression.
- Add missing browser-level coverage before deleting protocol code.
- Keep daemon search calculation coverage for ranking and parallel batch behavior.
- Confirm focused tests pass before removal begins.

### 2. Resolve the product decision gate

- Obtain an explicit decision on whether any current or committed connector workflow requires full-history search.
- If the answer is yes, stop this removal plan and design that workflow before selecting a seam.
- If the answer is no, treat WebSocket history search as unsupported and continue.

### 3. Remove WebSocket protocol messages

- Delete history-search start, cancellation, chunk, completion, and error variants that exist only for full-history WebSocket search.
- Remove corresponding serialization/deserialization and strict-protocol tests.
- Preserve unrelated request/response, mutation, pairing, and connector-status messages.

### 4. Remove WebSocket session implementation

- Delete per-socket search cancellation-token maps and lifecycle cleanup.
- Remove worker spawning, chunk forwarding, terminal delivery, and disconnect cleanup specific to history search.
- Remove command branches that accept the deleted messages.
- Ensure unknown former messages receive the normal explicit unsupported/protocol error.

### 5. Remove connector construction and callers

- Delete WebSocket client methods and state used only by full-history search.
- Remove tests that assert the deleted capability.
- Search staged assets and test fixtures for alternate casing and raw message strings.
- Do not add a compatibility reader or deprecated no-op response.

### 6. Retain and verify the Tauri path

- Keep Desktop Explore invocation, active search state, cancellation, chunk events, and completion behavior.
- Keep daemon parallel-search implementation used by Tauri.
- Run desktop visual tests after protocol removal to prove no accidental dependency existed.

### 7. Update architecture documentation

- Remove statements that the connector WebSocket protocol exposes full-history search.
- Document that full-history search is a Desktop Explore capability reached through Tauri.
- Update `CODEBASE_MAP.md` search routing.
- Run Rust/JS formatting, clippy, unused-code checks, daemon tests, integration tests, and focused desktop E2E.

## Test surface after the change

- Desktop visual E2E covers user-visible search lifecycle.
- Daemon search tests cover ranking and parallel search implementation.
- WebSocket tests assert the former messages are unsupported only if strict-protocol behavior requires that case.
- Connector E2E continues to cover current-page summaries and ordinary RPC without full-history search fixtures.

## Risks

- An undocumented caller may depend on WebSocket history search.
- Protocol removal may break version-skew behavior for an older extension build.
- Shared message handling may accidentally remove ordinary cancellation or mutation behavior.
- Desktop tests may have relied on WebSocket fixtures despite production using Tauri.

## Implemented decisions

- Full-history search remains a Desktop Explore capability reached through cancellable Tauri commands and `bridge-search-history` events.
- The daemon parallel history-search algorithm remains shared production code used by the Tauri adapter.
- WebSocket history-search request, cancellation, chunk, and completion variants were deleted together with per-connection cancellation state and worker forwarding.
- The connector WebSocket retains note/snapshot search and page-scoped reads; it has no full-history search construction or caller state.
- Former WebSocket history-search messages receive the standard explicit `invalid_message` response, with no compatibility no-op or fallback.
- Existing desktop visual E2E remains the lifecycle safety net for replacement, cancellation, completion, and stale-result suppression.

## Resolved questions

- No shipped, hidden, or committed connector surface in the repository uses full-history search.
- Backward compatibility is not retained; older message types fail immediately and leave the authenticated socket usable.
- No protocol version field exists to increment; strict tagged-message parsing makes the capability removal explicit.
- Integration tests were the only WebSocket history-search consumer and now cover retained note/snapshot RPCs plus explicit rejection of former history messages.
- Further deepening of the Tauri lifecycle is a separate design task and is not required by this removal.
