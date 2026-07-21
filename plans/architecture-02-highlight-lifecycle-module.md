# Reunify the Highlight Lifecycle

Status: implemented on 2026-07-03.

## Objective

Replace the mirrored production and test implementations with one deep highlight lifecycle module used by live content scripts, the snapshot viewer where applicable, and tests.

## Why

`content.js` explicitly mirrors logic from `packages/core/highlight-helpers.js`. Production executes private copies while unit tests execute the shared helper. The implementations already differ in shadow-root and Browser Recall panel exclusion behavior.

The current helper fails the deletion test: deleting it removes tests and snapshot-viewer support but does not remove the primary shipped content-script behavior. One production module should own selection chunking, scoped matching, mark ownership, hydration retries, and route disposal.

## Invariants to preserve

- Same-block selections persist one aligned excerpt/path item.
- Cross-block selections persist aligned excerpt/path arrays.
- Empty paths intentionally search the document root.
- Browser Recall overlays and panels never become highlight targets.
- Reapplication is scoped by saved paths before any permitted fallback.
- Hydration retries are bounded.
- Same-document navigation disposes the previous watcher and marks.
- Grouped marks delete and unwrap together.
- PDF and snapshot-viewer behavior remains isolated from Browser Recall UI markup.
- Content-script packaging remains compatible with extension CSP and classic scripts.

## Files in scope

- `apps/extension/content.js`
- `packages/core/highlight-helpers.js`
- `apps/extension/highlight-helpers.js`
- `apps/extension/snapshot-viewer.js`
- `apps/extension/background.js`
- `scripts/stage-app-assets.mjs`
- `tests/unit/highlight-helpers.test.js`
- `tests/e2e/highlight-note-edit.spec.js`
- `tests/e2e/context-menu-highlight.spec.js`
- `tests/e2e/extension-navigation-regressions.spec.js`
- `tests/e2e/snapshot-slug-meta.spec.js`
- `docs/ARCHITECTURE.md`
- `docs/CODEBASE_MAP.md`

## Non-goals

- Moving note persistence into the content script.
- Replacing browser E2E with DOM-only tests.
- Adding fallback matching that hides invalid saved identity data.
- Changing the persisted excerpt/path schema.
- Solving arbitrary site-specific highlight failures without live/source DOM evidence.

## Implementation plan

### 1. Capture the existing drift with failing E2E coverage

- Add or strengthen a browser E2E scenario where the production copy and helper copy behave differently, using Browser Recall panel/shadow-root exclusion as the initial case.
- Exercise saved-note reapplication through the real connector/daemon path.
- Confirm failure against current production code before refactoring.
- Preserve stable, replayable test input and log any seed used.

### 2. Shape one production highlight module

- Consolidate DOM indexing, text normalization, range splitting, scoped matching, mark creation/removal, grouped mark handling, and retry/disposal state.
- Keep the external interface small and centered on user actions and lifecycle events rather than exposing every helper.
- Accept document/runtime dependencies needed by live-page and snapshot contexts instead of reading uncontrolled globals throughout the implementation.
- Keep internal seams private; tests should cross the same external seam as callers whenever feasible.

### 3. Resolve classic-script packaging

- Make the shared implementation available to the classic content-script runtime through the existing staging process or a generated local bridge.
- Keep all generated code local to the extension package and CSP compliant.
- Fail staging explicitly if the production highlight module cannot be generated or included.
- Do not retain a manually synchronized source copy.

### 4. Migrate live content-script behavior

- Replace private selection and matching copies in `content.js` incrementally.
- Move watcher ownership, bounded retry scheduling, route-change disposal, and mark cleanup into the lifecycle module.
- Preserve content-script message handling as an adapter from browser messages to the module.
- Run focused highlight E2E after each behavior family moves.

### 5. Migrate snapshot-viewer behavior

- Route snapshot highlight placement through the same module where document semantics are shared.
- Keep snapshot-only navigation or presentation behavior in the snapshot adapter.
- Verify live-page exclusions do not incorrectly exclude saved snapshot content.

### 6. Replace old tests rather than layering more tests

- Retain unit coverage only for narrow DOM invariants that are impractical to exercise through E2E.
- Delete tests whose only purpose was validating the non-production mirrored copy.
- Make browser E2E the primary interface test surface for selection, persistence, reapplication, hydration, navigation, PDF, and grouped deletion.
- Keep test LoC policy within the project’s architecture exception rules.

### 7. Remove compatibility code and document

- Delete mirrored helper blocks and comments from `content.js`.
- Remove re-export modules that no longer earn depth, unless required as the generated classic-script entry.
- Update `docs/ARCHITECTURE.md` and `docs/CODEBASE_MAP.md` with module ownership and adapter roles.
- Run extension build, focused E2E, formatting, and unused-export checks.

## Test surface after the change

- Browser E2E drives the highlight lifecycle through real user scenarios.
- Narrow DOM tests cover internal edge cases only where E2E cannot reliably construct the condition.
- Staging tests verify that the shipped content script receives the same implementation.

## Risks

- Packaging the module incorrectly could break every content-script page under CSP.
- Injected dependency handling could accidentally cross isolated/page-world semantics.
- A generalized document adapter could widen the interface until the module becomes shallow.
- Moving watcher state may alter timing-sensitive hydration behavior.

## Unresolved questions

- Should the classic-script artifact be generated from the core module or bundled as a staged script?
- How much lifecycle behavior is genuinely shared with the snapshot viewer?
- Which DOM helpers must remain internally accessible for narrow tests?
- Should page-world and isolated-world concerns be represented by separate adapters?
- Which existing unit tests should be deleted versus retained as architecture-invariant coverage?

## Implemented decisions

- The classic-script artifact is generated during staging from the exported lifecycle factory; there is no manually synchronized production copy.
- Live pages use the full lifecycle, including selection, reapply, bounded retries, grouped ownership, and disposal. The snapshot viewer shares matching and mark ownership while retaining snapshot navigation and overlay presentation in its adapter.
- The public seam is lifecycle-oriented. Narrow unit coverage crosses the same factory and retains only exclusion, strict scope, and aligned selection invariants.
- The public seam exposes lifecycle operations rather than low-level DOM helpers. Bounded hydration observation retains all saved notes so client-rendered replacement can be repaired, while retries skip notes whose owned marks remain intact.
- Page-world History interception remains a separate injected adapter. The lifecycle runs only in the isolated content-script world or the snapshot iframe document.
- The former mirrored helper unit suite and re-export modules were removed; browser E2E remains the primary behavior surface.
