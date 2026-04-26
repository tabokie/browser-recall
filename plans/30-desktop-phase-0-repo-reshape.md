# 30 — Desktop Split, Phase 0: Repo Reshape

> Part of [29-desktop-split-master.md](./29-desktop-split-master.md). No behavior change in this phase.

## Goal

Reorganize the existing repo into a workspace layout so subsequent phases have somewhere to put new code without ad-hoc directory choices. Tests continue to pass against the existing extension at the end of this phase. One reviewable PR.

## Target layout

```
/apps/
  extension/           # current extension/ (becomes the connector in Phase 2)
/packages/
  core/                # cross-process JS: entity-types, slug helpers, attention, search-helpers
  protocol/            # WebSocket message schema (added in Phase 1; folder created empty here)
/crates/
  search/              # current src/ (the WASM search engine)
  daemon/              # Tauri Rust side (added in Phase 1; folder created empty here)
  replay/              # Rust port of effectOf (added in Phase 2; folder created empty here)
/tests/
  unit/                # Vitest unit tests, follow code into packages over later phases
  integration/         # daemon-driven tests (added in Phase 2)
  e2e/                 # full-stack Playwright (kept minimal per Q14)
/docs/                 # unchanged
/demos/                # unchanged
```

## Steps

1. **`git mv` extension files.**
   - `extension/` → `apps/extension/`. Preserve git history.
   - Update every relative import that crosses package boundaries (none yet — all imports stay within `apps/extension/`).

2. **`git mv` Rust crate.**
   - `src/lib.rs` and friends → `crates/search/src/lib.rs`.
   - Move `Cargo.toml` to `crates/search/Cargo.toml`; create root `Cargo.toml` as a workspace.

3. **Create empty package + crate scaffolding for later phases.**
   - `packages/core/package.json`, `packages/protocol/package.json` with empty `index.js`.
   - `crates/daemon/Cargo.toml`, `crates/replay/Cargo.toml` with empty `lib.rs`.

4. **Set up npm workspaces.**
   - Root `package.json` gets `"workspaces": ["apps/*", "packages/*"]`.
   - Move shared devDependencies (vitest, playwright, prettier) to root.
   - Per-workspace `package.json` files declare their own runtime deps.

5. **Set up Cargo workspace.**
   - Root `Cargo.toml`:
     ```toml
     [workspace]
     members = ["crates/*"]
     resolver = "2"
     ```
   - `crates/search/Cargo.toml` becomes a workspace member.

6. **Update test paths.**
   - `vitest.config.js` finds tests anywhere under `apps/`, `packages/`, `tests/`.
   - `playwright.config.js` updates fixture paths.
   - `tests/*.test.js` move to `tests/unit/` (no rename, just folder).

7. **Update build scripts.**
   - `npm run build` builds the WASM crate and copies to `apps/extension/pkg/` as before.
   - `npm test`, `npm run fmt`, `npm run fmt:check` all work from root and discover workspaces.

8. **Update `CODEBASE_MAP.md` and `ARCHITECTURE.md`.**
   - Path references throughout. No semantic change — same code, new paths.

9. **Run the full test suite.** Everything passes. Load the extension into Chrome and smoke-test that capture still works.

## Out of scope for Phase 0

- No new code.
- No behavior change.
- No file deletions.
- No protocol work.

## End state

- Workspace tooling resolves correctly: `npm install` from root installs all workspaces; `cargo build --workspace` builds all crates.
- Existing extension still loads from `apps/extension/` and works.
- All existing tests still pass.
- New empty folders ready for Phase 1+.

## Risks

- **Hidden absolute path references.** Search the repo for hardcoded `extension/` and `src/` strings in scripts, CI, docs.
- **Build artifact paths.** `apps/extension/pkg/` is the WASM output target; CI must build the crate before tests run.
- **CI workspace-awareness.** GitHub Actions matrix may need updating to install dependencies at root.

## PR checklist

- [ ] `npm install` works from root.
- [ ] `npm test` runs all workspace test suites.
- [ ] `cargo build --workspace --target wasm32-unknown-unknown` succeeds.
- [ ] `cargo fmt --check` and `cargo clippy` pass.
- [ ] `npm run fmt:check` passes.
- [ ] `apps/extension/` loads as an unpacked extension in Chrome and captures a visit successfully.
- [ ] `CODEBASE_MAP.md` updated with new paths.
