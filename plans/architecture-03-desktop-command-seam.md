# Deepen the Desktop Command Seam

Status: implemented on 2026-07-03.

## Objective

Move semantic daemon command authority out of the WebSocket-named module and behind one daemon-owned interface used by both the Tauri and WebSocket adapters.

## Why

Browser Recall must accept overlapping mutations from two active product surfaces:

- Desktop UI through the local Tauri shell.
- Browser extension through the paired WebSocket connector.

Notes, page titles/ratings, list pins, snapshots, and resulting mutation notifications must have identical semantics regardless of ingress. Today raw action names, request fields, response fields, write classification, validation, and mutation construction are distributed among `desktop-bridge.js`, `main.rs`, and `ws_server.rs`.

The two active adapters justify a real seam. Native shell commands and browser-observation commands remain adapter-specific.

## Invariants to preserve

- Desktop remains the authority for persistent state and policy.
- Extension messages remain semantic commands, never raw replay records.
- Both adapters execute shared mutations with identical validation and results.
- Mutation notifications describe committed state only.
- Command-only fields never enter canonical JSONL.
- Tauri-only native operations do not leak into daemon command authority.
- Connector-only pairing and browser-observation transport remain WebSocket concerns.
- Errors remain explicit; unsupported commands never silently default.

## Files in scope

- `crates/daemon/src/ws_server.rs`
- `crates/daemon/src/commands.rs`
- `crates/daemon/src/protocol.rs`
- A new or renamed daemon command-authority module if warranted
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/ui/desktop-bridge.js`
- `apps/extension/connector/ws-client.js`
- `crates/daemon/tests/commands.rs`
- `crates/daemon/tests/ingest.rs`
- `tests/integration/popup-rpc.test.js`
- `tests/integration/event-flow.test.js`
- Relevant desktop and popup E2E coverage
- `ARCHITECTURE.md`
- `CODEBASE_MAP.md`

## Non-goals

- Sending desktop UI traffic over WebSocket.
- Allowing the extension to invoke Tauri.
- Moving window, filesystem-picker, system-locale, or external-open operations into the daemon command module.
- Moving pairing or socket lifecycle out of the WebSocket adapter.
- Creating separate semantic implementations for each transport.

## Implementation plan

### 1. Establish cross-adapter behavior coverage

- Select representative shared commands: note create/update/delete, page rename/rate, list pin toggle, and snapshot deletion.
- Add daemon-level tests that assert validation, response, committed state, and mutation notification together.
- Add or strengthen one Tauri-path and one WebSocket-path scenario proving both adapters reach the same semantics.
- Confirm tests expose any current mismatch before moving implementation.

### 2. Classify commands by ownership

- Shared daemon commands: state reads/mutations available to both surfaces where product behavior requires them.
- Tauri-only commands: window, folder, locale, open-path/open-URL, launch-at-login, and other native shell behavior.
- WebSocket-only commands: pairing, connector availability, visit/leave observations, and socket session behavior.
- Record unresolved ownership rather than leaving commands classified by ad hoc string lists.

### 3. Introduce the daemon command authority module

- Move raw command parsing, required-field validation, write/read classification, semantic execution, response formation, and post-commit mutation meaning into one daemon module.
- Keep the interface transport-neutral.
- Use typed internal command/result forms where they reduce caller knowledge; do not expose replay or storage implementation details.
- Coordinate with the replay transaction module plan so command authority delegates durability instead of reproducing it.

### 4. Reduce the WebSocket adapter

- Translate authenticated wire messages into daemon commands.
- Pass normalized results back over the wire.
- Retain pairing, connection state, cancellation tied to socket lifetime, and encoding in `ws_server.rs`.
- Remove semantic action matches and mutation construction that have moved behind the seam.

### 5. Reduce the Tauri adapter

- Route shared daemon commands directly to the command authority without a duplicated `is_daemon_write_command` policy list.
- Retain native shell command handling in `main.rs`.
- Preserve direct in-process invocation; do not add network/authentication failure modes to the desktop UI.
- Narrow `desktop-bridge.js` so UI callers learn user-facing command behavior rather than transport/request-bag details.

### 6. Align test adapters

- Update desktop visual test support to model user-facing command results instead of duplicating daemon command classification and storage semantics.
- Keep adapter tests focused on translation and transport failure.
- Delete old tests that assert implementation-specific dispatcher structure once equivalent interface tests pass.

### 7. Remove duplicated policy and document

- Delete obsolete action lists, match arms, response construction, and mutation helpers from transport modules.
- Search for command names across alternate casing, comments, tests, and docs.
- Update `ARCHITECTURE.md` and `CODEBASE_MAP.md` to show one command authority with Tauri and WebSocket adapters.
- Run daemon tests, integration tests, focused E2E, formatting, clippy, and unused-code checks.

## Test surface after the change

- Daemon command-authority tests cover semantic commands and mutation outcomes.
- Tauri adapter tests cover native translation and shell-only behavior.
- WebSocket adapter tests cover authentication, encoding, connection lifecycle, and connector-only messages.
- Product E2E confirms representative shared workflows from both surfaces.

## Risks

- Over-generalizing commands could expose desktop-only capabilities to the connector.
- Moving mutation construction before replay transaction work is stable could report uncommitted changes.
- A transport-neutral command enum could become a large shallow interface if every raw payload shape leaks through unchanged.
- Desktop visual mocks may temporarily diverge during migration.

## Unresolved questions

- Which current command names are genuinely exercised by both adapters?
- Should reads and writes share one command interface or separate daemon modules?
- Where should authorization differences between desktop and paired connector live?
- Should mutation notification derivation belong to command authority or the replay transaction result?
- How should streaming/cancellable operations relate to ordinary request/response commands?

## Implemented decisions

- Shared replay-backed mutations use `CommandAuthority::execute`; reads keep their existing daemon helpers and transport-specific result forms so the mutation interface does not become a shallow union of unrelated payloads.
- Tauri authorization is implicit in the trusted in-process adapter. WebSocket authentication and connector approval remain in `ws_server.rs` before the shared authority is called.
- Command authority derives mutation notifications from successful command results after replay transactions commit. The replay transaction module continues to own durability and projection publication.
- Mutation notifications are constructed as typed payloads, and required command response fields fail explicitly instead of being recovered as null/default values.
- Visit/leave observations, title cleanup requests, and popup access policy remain connector adapter concerns. Native window, filesystem, locale, opener, setup, and sync actions remain Tauri adapter concerns.
- Streaming history search and cancellation remain separate adapter-specific interfaces because their lifecycle differs from ordinary request/response mutations.
- `desktop-bridge.js` and `ws-client.js` retain their existing small transport interfaces; adding one wrapper per semantic action would create shallow pass-through modules without moving authority out of callers.
