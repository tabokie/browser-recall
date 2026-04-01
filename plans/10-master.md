# 10 — Master Plan: Browser Recall v1.0 Release

## Context

Preparing the extension (currently "Portal - Knowledge Management") for public Chrome Web Store launch as "Browser Recall" v1.0. The core architecture is solid — event-sourced replay, entity storage, WASM search, sync, 697 tests. The gaps are in the product wrapper: error resilience, debug logging, dark mode, onboarding, and store materials.

All design decisions were resolved through a grilling session (Q1-Q22 in this conversation).

## Implementation Order

| # | Plan | Depends On | Summary |
|---|------|-----------|---------|
| 11 | [Debug Logger](11-debug-logger.md) | — | New `logger.js` module (debug/error), session toggle, replace all `console.*` calls |
| 12 | [Downtime Infrastructure](12-downtime-infrastructure.md) | 11 | `pauseService`/`resumeService`, downtime icons, settings error banner |
| 13 | [Offscreen Crash Recovery](13-offscreen-crash-recovery.md) | 12 | Reject pending promises on disconnect, crash-loop detection (3 in 60s) → pause |
| 14 | [Session Quota Handling](14-session-quota-handling.md) | 12 | try/catch in `cacheSet`, emergency eviction (watermark-safe), pause on failure |
| 15 | [Local Quota Guard](15-local-quota-guard.md) | 12 | `persistLogBuffer` helper, pause on `chrome.storage.local` quota hit |
| 16 | [FS Permission Drain Failure](16-fs-permission-drain-failure.md) | 12 | Drain failure counter, pause after 60s stuck, auto-resume on re-grant |
| 17 | [Dark Mode](17-dark-mode.md) | — | Three-way toggle (Light/Dark/System), CSS variable overrides, session-stored |
| 18 | [Onboarding](18-onboarding.md) | 11-17 | Single screen replacing options page on first run |
| 19 | [Store Assets](19-store-assets.md) | 18 | Manifest update (name→Browser Recall, version→1.0), privacy policy, store listing |

## Key Design Decisions

- **Logger**: 2 levels (debug/error), session-stored toggle checkbox in settings, non-persistent (resets on browser restart)
- **Downtime**: unified icon + settings error banner for ALL fatal conditions. Settings page shows specific error + suggested action per condition.
- **Quota handling**: aggressive eviction respecting watermark rule (dirty entries protected), then pause. No silent data loss — new events lost only while paused.
- **Offscreen crash**: resolve pending `portCallbacks` with `{ success: false }`, crash-loop = 3 disconnects in 60s → pause
- **Dark mode**: CSS variable overrides via `data-theme` attribute, three-way toggle, session-stored (defaults to System each session — acceptable because System follows OS)
- **Onboarding**: options page IS the onboarding when no directory handle exists. Single screen: directory picker (required), device name + sync (optional, skippable). No multi-step wizard. Cancelling the OS directory picker stays on the same screen.
- **No delete confirmations** — soft-delete + recycle bin is sufficient
- **Accessibility** — deferred, added to TODO.md
- **Data export** — directory IS the export, documented in store listing
- **No default path for directory** — always let user pick via `showDirectoryPicker()`

## Verification

After all plans implemented:
1. `npm test` — all unit tests pass
2. `npx playwright test` — all E2E tests pass
3. Manual smoke: fresh install → onboarding → browse → verify data → toggle dark mode → trigger error state → settings check
4. Load as unpacked extension, verify manifest and all pages
