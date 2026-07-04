# Deepen Daemon Read Projections

Status: completed on 2026-07-03.

## Objective

Replace UI knowledge of generic entity keys and storage topology with daemon-owned read projection modules for user-facing page, list, search-enrichment, and recycle-bin workflows.

## Why

`readDesktopValue(key, includeDeleted)` is a shallow interface. Callers must know `page:`, `note:`, `list:`, and `manifest:` prefixes, entity relationships, deleted visibility, selective page checkpoints, and how to join multiple reads. Desktop UI flows perform these joins and the visual test adapter reconstructs a storage-shaped entity store.

Deep projections keep schema and policy local to the daemon while giving desktop and connector callers leverage from payloads shaped for actual workflows.

## Invariants to preserve

- Daemon projection cache remains the primary read source.
- Coordinated cache misses fall through to disk.
- Logs remain authoritative and checkpoints remain rebuildable.
- Selective page-checkpoint policy remains replay-owned.
- Deleted visibility is explicit per workflow.
- Desktop UI mocks mirror production daemon interfaces.
- History log entities remain available only through history batch/search paths.
- No caller synthesizes missing product data through defaults.

## Files in scope

- `crates/daemon/src/commands.rs`
- `crates/daemon/src/storage.rs`
- Potential daemon projection modules organized by user workflow
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/ui/desktop-bridge.js`
- `apps/desktop/ui/index.js`
- `apps/extension/background.js`
- `crates/daemon/tests/commands.rs`
- `tests/e2e/desktop-visual.spec.js`
- Relevant popup/list/search/recycle E2E coverage
- `ARCHITECTURE.md`
- `CODEBASE_MAP.md`

## Non-goals

- Moving presentation HTML into Rust.
- Returning entire storage snapshots to avoid designing projections.
- Adding a generic fallback when a projection is unavailable.
- Exposing history JSONL through generic entity reads.
- Changing replay checkpoint policy.

## Candidate projection families

- Page summary and relations, including notes, snapshots, parents, and current durable page state.
- List display and pin context, including resolved page identity needed by desktop and popup surfaces.
- Search result enrichment for notes, snapshots, and page state.
- Recycle-bin entries with explicit restoration eligibility.
- Settings and manifest reads where a dedicated projection earns depth.

These are planning categories, not settled interfaces.

## Implementation plan

### 1. Add failing workflow coverage

- Strengthen daemon/WebSocket or Tauri-seam integration tests for one projection family at a time.
- Start with a workflow that currently performs N+1 entity reads, such as list pin resolution or search-note enrichment.
- Include non-empty notes, snapshots, deleted entities, and cache-miss-to-disk cases.
- Confirm existing visual mocks can drift from daemon behavior, then make the new test fail on that mismatch.

### 2. Define projection ownership

- Group reads by user workflow rather than by storage file type alone.
- Keep entity joins, visibility rules, and cache/disk coordination behind the projection interface.
- Return user-facing data without leaking checkpoint paths or entity-key construction.
- Avoid one oversized projection that returns unrelated state.

### 3. Implement the first deep projection

- Implement one bounded family end to end in the daemon.
- Reuse coordinated storage reads; do not bypass cache-miss coordination.
- Add daemon integration coverage through the new interface.
- Keep missing required data explicit and distinguish not-found from read failure.

### 4. Migrate desktop callers

- Add the corresponding Tauri adapter translation.
- Replace `index.js` joins and key construction with the projection result.
- Remove migrated `readDesktopValue` calls and local entity-topology knowledge.
- Update visual E2E support to return the same projection shape as production.

### 5. Migrate connector callers where the workflow is shared

- Use the same daemon projection through the WebSocket adapter for current-page popup/list workflows.
- Keep extension background code as a connector adapter, not a product entity cache.
- Avoid exposing projections that the connector does not need.

### 6. Repeat by projection family

- Move page relations, list/pin context, search enrichment, and recycle-bin behavior incrementally.
- Keep each migration independently testable and delete old joins immediately after the new path passes.
- Reassess whether generic entity reads still have a legitimate internal/debug role after each family moves.

### 7. Narrow or remove generic reads

- Restrict `readDesktopValue` to any proven remaining use rather than retaining it as compatibility infrastructure.
- Remove public key-prefix helpers from UI modules when no callers remain.
- Verify no desktop visual mock exposes production-inaccessible history entities.

### 8. Verify and document

- Run daemon command tests and focused desktop/popup/list/search/recycle E2E.
- Exercise cache hits and coordinated disk misses.
- Update `ARCHITECTURE.md` and `CODEBASE_MAP.md` as each significant projection lands.
- Run formatting and unused-export checks.

## Test surface after the change

- Daemon integration tests exercise projection behavior with real storage and cache coordination.
- Desktop visual tests consume projection payloads without rebuilding storage rules.
- Connector E2E verifies current-page projections through the real daemon/WebSocket path.

## Risks

- Projection payloads may become oversized and shallow if workflows are not separated carefully.
- Moving joins can change ordering, deleted visibility, or fallback behavior.
- Migrating only some callers could leave two competing sources of truth.
- A broad generic projection could recreate `readDesktopValue` under a different name.

## Implemented decisions

- List display and pin context is the first projection family because it removed repeated N+1 joins from four desktop workflows without creating an oversized read interface.
- `ReadProjections::list_display` owns list visibility and page/note pin resolution through coordinated cache reads with disk fallback.
- Missing pin targets are returned explicitly as `kind: "missing"`; deleted lists return not-found and deleted notes are not resolved.
- Tauri exposes `getListDisplay`; desktop list view, refresh, focus, and rule preview consume the same projection shape.
- The visual E2E adapter mirrors the production projection interfaces.
- The connector popup keeps its narrower existing list projection because resolving every pin would add data and I/O that popup workflows do not use.
- Page/search context, all-page filter context, page info/snapshots, visible list trees, recycle-bin restoration policy, popup list summaries, and settings live in the same daemon-owned module as separate workflow interfaces.
- Desktop product code has no `readDesktopValue` caller. The Tauri generic read action and unused shared-web generic-read exports were removed.
- Connector badge, highlight-panel, snapshot-delete, and snapshot-capture settings paths use page summary, page info, and settings projections. The generic connector relay remains only for diagnostic/E2E inspection.
- WebSocket page-info and popup-list joins delegate to `ReadProjections`; transport code only maps projection results into protocol payloads.
- Projection DTOs use semantic identities and relationships; raw replay topology (`childIds`, `parentIds`, prefixed pin IDs, and list-order keys) remains daemon-internal.
- Generic WebSocket entity reads require explicit test-control mode, and `readDesktopValue` exists only in the staged extension test adapter.

## Resolved questions

- List display was the first bounded migration; page/search, list-tree, recycle-bin, and settings followed as independent interfaces.
- Generic reads are retained only for daemon diagnostics and E2E state inspection, not product behavior.
- Desktop page context and popup page summary are related but intentionally different projections because popup needs a compact current-page payload while desktop search needs batching.
- Result enrichment stops at entity relationships, visibility, restoration eligibility, and snapshot availability; localized labels, date formatting, and HTML remain presentation concerns.
- History remains streamed/batched through its existing dedicated interfaces. Page enrichment batches requested slugs; no product projection returns an unrestricted storage snapshot.
