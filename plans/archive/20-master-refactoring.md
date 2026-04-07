# 20 — Master Plan: Codebase Refactoring

## Context

A line-by-line codebase audit identified 5 categories of issues across ~16,400 lines in 40 JS files. The extension is post-v1.0 launch — all features work, 649 unit tests + 320 E2E tests pass. The goal is to reduce complexity and fix correctness risks without changing any user-visible behavior.

## Audit Findings → Plan Mapping

### God functions (100-787 lines, mixed concerns)

| Finding | Lines | Plan |
|---------|-------|------|
| `replay.js` `effectOf()` — 787 lines, 22 branches, 8 closures | 186-972 | **22** |
| `background.js` message handler — 1290 lines, 63 cases | 1526-2817 | **25** |
| `background.js` `hydrateCache()` — 230 lines, 6 phases | 519-751 | **25** |
| `background.js` `reportPage` — 130 lines | 1601-1731 | **25** |
| `background.js` `performSync()` — 130 lines | 1096-1224 | **25** |
| `offscreen.js` `handleRequest()` — 380 lines, 43 cases | 82-462 | **24** |
| `offscreen.js` `drainQueue()` — 210 lines | 483-696 | **24** |
| `options.js` `createSidebarItem()` — 200+ lines | 3149-3354 | **26** |
| `options.js` `runPreview()` — 122 lines | 1994-2115 | **26** |
| `content.js` `extractMarkdown()` — 140 lines | 28-167 | deferred |
| `content.js` `showHighlightEditOverlay()` — 142 lines | 588-729 | **27** |
| `popup.js` `showDashboard()` — 113 lines | 694-806 | **27** |
| `filesystem-storage.js` — 1082-line god object, 36 methods | entire file | **23** |
| `virtual-scroller.js` `_render()` — 121 lines | 173-293 | deferred |

### Duplicated patterns

| Finding | Locations | Plan |
|---------|-----------|------|
| Entity key-prefix dispatch | 8 locations across 6 files | **21** |
| `content.js` overlay implementations (showGlobalNote + showHighlightEdit) | 221-319, 588-729 | **27** |
| `content.js` notification bubbles (3 functions, ~65 lines duplicated) | 823-920 | **27** |
| `options.js` view-container resolution (3 keyboard handlers) | 5377, 5407, 5447 | **26** |
| `options.js` blacklist/trim-rules render | 4313-4337, 4375-4400 | **26** |
| LWW timestamp guards in replay.js (5 instances) | 461, 494, 590, 869, 926 | **22** |

### Scattered mutable state

| Finding | Plan |
|---------|------|
| `options.js` 10+ search globals (searchGeneration, searchResults, etc.) | **26** |
| `options.js` 10+ history globals (historyFiles, historyByUrl, etc.) | **26** |
| `background.js` module-scope state (recentUrls, tabReportedUrls, localDeviceId) | **25** (documented, not restructured — all handlers stay in one file) |

### Silent error swallowing

| Finding | Severity | Plan |
|---------|----------|------|
| `entity-cache.js` `cacheSet` silent quota failure after emergency evict | HIGH | **28** |
| `background.js` remote entry replay errors — zero logging | HIGH | **28** |
| `entity-cache.js` `emergencyEvict` violates pin contract | MEDIUM | **28** |
| `filesystem-storage.js` `softDelete` doesn't clear `_fileCache` | MEDIUM | **28** |
| `entity-cache.js` GC_TOMBSTONE never cleared | HIGH | **28** |
| `background.js` hydrateCache phase errors silently swallowed | MEDIUM | documented in 28, not changed (intentional resilience) |
| `content.js` `.catch(() => {})` on note saves | LOW | deferred (content script resilience, acceptable) |
| `filesystem-storage.js` NotFoundError returns empty | LOW | deferred (correct behavior for "file doesn't exist") |

### Race conditions

| Finding | Plan |
|---------|------|
| `background.js` `saveListMeta` nameToId race | **28** (investigated: not a real race — `addLog` awaits `sessionWrite`) |
| `background.js` getReferrer 200ms race window | deferred (known limitation, documented in code) |
| `background.js` watermark race on offscreen crash | deferred (mitigated by crash recovery in plan 13) |
| `background.js` recentUrls stale after hydration | deferred (intentional — immutable cache rebuilt on restart) |

## Implementation Order

| # | Plan | Depends On | Summary | Primary Files | Estimated Scope |
|---|------|-----------|---------|---------------|----------------|
| 21 | [Entity Key Helpers](21-entity-key-helpers.md) | — | Shared prefix constants, key parsing, constructors | entity-types.js + 6 consumers | ~50 new lines, ~100 lines changed |
| 22 | [Replay effectOf Split](22-replay-effectof-split.md) | 21 | ReplayContext class + 22 handler functions + dispatch table | replay.js | ~998 lines restructured |
| 23 | [FileSystemStorage Split](23-filesystem-storage-split.md) | 21 | Extract sync methods to `filesystem-sync-storage.js` | filesystem-storage.js, offscreen.js | ~200 new, ~300 removed |
| 24 | [Offscreen Handler Extraction](24-offscreen-handler-extraction.md) | 21, 23 | 43 case bodies → named functions | offscreen.js | ~770 lines restructured |
| 25 | [Background Handler Extraction](25-background-handler-extraction.md) | 21, 22, 24 | 63 cases + hydrateCache phases + reportPage | background.js | ~2926 lines restructured |
| 26 | [Options.js Cleanup](26-options-cleanup.md) | — | 6 parts: dedup renders, split sidebar, group globals, etc. | options.js | ~5461 lines restructured |
| 27 | [Content & Popup Cleanup](27-content-popup-cleanup.md) | — | Overlay unification, notification factory, popup phases | content.js, popup.js | ~100 line net reduction |
| 28 | [Error Handling & Cache Contracts](28-error-handling-cache-contracts.md) | 21 | 5 targeted fixes for correctness risks | entity-cache.js, filesystem-storage.js, background.js | ~30 lines changed |

Dependency graph:
```
21 (entity key helpers)
  ├──→ 22 (replay.js effectOf split)
  ├──→ 23 (filesystem-storage split) ──→ 24 (offscreen extraction) ──→ 25 (background extraction)
  └──→ 28 (error handling & cache contracts)

26 (options.js cleanup)     — independent
27 (content & popup cleanup) — independent
```

### Why this order

- **21 first**: Every subsequent plan uses key constants/helpers from entity-types.js. Doing this first eliminates merge conflicts.
- **22 before 25**: background.js calls `effectOf` — understanding the new dispatch table helps when extracting background handlers.
- **23 before 24**: offscreen.js routes sync requests to FileSystemStorage — splitting the class first means offscreen extraction can reference the new class directly.
- **24 before 25**: background.js sends requests to offscreen — knowing the named handler layout helps align background handler names.
- **28 after 21**: Uses entity key constants. Otherwise independent — small targeted fixes.
- **26 and 27 independent**: No cross-file dependencies with the main chain.

### Parallelism

Plans 26 and 27 can run in parallel with the 21→22→23→24→25 chain. Plan 28 can run after 21 completes, in parallel with 22-25.

## Key Design Decisions

- **All handlers stay in the same file** (plans 24, 25, 26). Moving to separate files would require passing 15+ module-scope variables or restructuring into classes. Named functions in the same file gives 90% of the readability benefit at 10% of the risk.
- **ReplayContext is a class, not module-level functions** (plan 22). The 8 helper closures share mutable state (`result`, `entry`, `load`, `context`). A class makes the shared state explicit as `this` properties. The dispatch table makes adding new actions a one-line change.
- **FileSystemStorage splits on the sync seam** (plan 23). The two directory handles are completely independent at runtime. Other potential splits (notes vs pages vs lists) would require sharing internal helpers (resolveDir, resolveFile, caches).
- **options.js globals become state objects, not a class** (plan 26). The file is already 5400 lines — adding a class would increase indirection without reducing coupling. Plain objects with descriptive names (`searchState.generation` vs `searchGeneration`) are the minimal useful change.
- **cacheSet returns boolean, not throws** (plan 28). Callers that don't care can ignore the return value. The service pause via `onQuotaExhausted` callback is the real recovery path. Throwing would require try-catch at every call site.

## Deferred (with reasoning)

| Finding | Why deferred |
|---------|-------------|
| `virtual-scroller.js` `_render()` 121 lines | Well-tested, low change frequency, complex but coherent (viewport calculation is inherently branchy) |
| `content.js` `extractMarkdown()` 140 lines | Deep recursion is the natural shape for DOM→markdown conversion. Splitting processNode into sub-functions by tag group adds indirection without reducing cognitive load. |
| `sync-transport-*.js` retry/cache patterns | Each transport is <180 lines and independent. Shared retry logic would couple them. |
| Magic values (REFERRER_CAP, EVICTION_LIMIT, etc.) | Low-risk busywork. Extract constants per-file as those files are touched for other reasons. |
| `sync-transport-filesystem.js` size-based hashing | Changing to content-based hashing is a behavior change with performance implications, not a refactoring. |
| `sync-transport-github.js` force push race | Requires protocol-level conflict resolution design, not code restructuring. |
| `content.js` `.catch(() => {})` on note saves | Content scripts run in hostile environments (tabs can close mid-save). Silent catch is intentional resilience. |
| `filesystem-storage.js` NotFoundError → empty return | Correct behavior: "file doesn't exist" is a valid non-error state for optional entities. |
| `background.js` getReferrer 200ms race | Known limitation with intentional timeout. Documented in code. No clean fix without changing webNavigation API contract. |
| `background.js` recentUrls stale after hydration | Intentional: immutable cache rebuilt on each browser restart. Runtime staleness is cosmetic (affects "recent" badge only). |
| `background.js` watermark race on offscreen crash | Mitigated by crash recovery infrastructure (plan 13). Entries in logBuffer are replayed on next hydration. |
| `options.js` bookmark tri-state checkbox propagation | Isolated to import UI, correct enough for the use case, low change frequency. |
| `options.js` mutation listener merge logic | Complex but correct. Plan 26 Part F extracts it to a named function for readability. |

## Verification (After All Plans)

1. `npx vitest run` — all ~649 unit tests pass
2. `npx playwright test` — all ~320 E2E tests pass
3. `npx knip --include files,exports,duplicates` — no dead exports introduced
4. `manifest.json` unchanged (no new content_scripts or background scripts needed)
5. Manual spot-check: load extension, browse pages, create notes/highlights, sync, toggle dark mode, check recycle bin
