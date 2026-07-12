# 29 — Desktop Split (Master Plan)

## Why

The current MV3 architecture loses File System Access permission inside the offscreen document under realistic conditions, especially on Brave (`docs/fs-permission-repro.md`). The investigation ruled out cached-handle staleness, lost root-handle references, and stale UI state. The conclusion: extension-managed File System Access in MV3 is not reliable enough to ship a "remember everything" product.

The product also wants properties MV3 cannot provide: always-on capture (survives browser close), multi-browser support (Chrome + Firefox + Safari + Arc feeding one archive), and freedom from the 10MB `chrome.storage.local` ceiling, the offscreen lifecycle, and CSP gymnastics around WASM.

## Shape

Zotero-shaped split:

- **Desktop app (Tauri, mac + win)** — owns the data folder, runs sync, hosts the main UI in a system webview, runs always-on as a tray/login item.
- **Connector extension (MV3, Chromium for v1)** — captures page events, holds a popup for per-page actions, buffers events when the daemon is unreachable, forwards over a `127.0.0.1` WebSocket.

The extension is a **thin connector**. All entity logic, all filesystem I/O, all sync, all main UI moves to the daemon. The extension never reads or writes a user-visible file again — File System Access disappears entirely from the codebase, killing the original bug at the root.

## Decisions made

| # | Decision | Rationale |
|---|---|---|
| 1 | Thick desktop, popup stays in extension | Popup is the only surface that genuinely benefits from being browser-adjacent. Everything else moves. |
| 2 | Tauri (not Electron) | Smaller binary, lean identity, and Rust backbone matches the existing `src/lib.rs` search engine. |
| 3 | WebSocket on `127.0.0.1` + per-install token + strict `Origin` check | Native messaging kills always-on. WebSocket with token is the Zotero shape with a real auth layer. |
| 4 | Extension buffers in `chrome.storage.local` and degrades to refuse only when buffer is full | No data loss for normal disconnections; honest failure mode when storage is exhausted. |
| 5 | Daemon is a login item with tray presence | Always-on is the whole point; tray makes the running process visible (not silent background). |
| 6 | Click-to-approve pairing; port probing for discovery | Zero typing, one explicit consent per browser; native dialog shows extension ID for verification. |
| 7 | One device per machine; `source` field on events tags origin browser/profile | Sync stays clean (1 peer per machine); browser provenance becomes a UI filter, not a directory split. |
| 8 | Event-log streaming over the wire; RPC only for popup reads | Wire format mirrors disk format (JSONL); `effectOf` lives only on the daemon. |
| 9 | Port UI verbatim with a `chrome.*` shim layer | Existing UI is an asset, not a liability. Don't combine architecture port + UI rewrite. |
| 10 | Adopt-in-place migration of the existing `~/browser-data` folder | Schema is unchanged; daemon takes over the folder, keeps device ID, keeps sync state. (No published users — only dev folders to consider.) |
| 11 | Sync runs in daemon; keep GitHub; drop WebDAV; drop filesystem-sync transport (document Syncthing pattern instead) | Cuts maintenance surface; daemon's always-on enables push-on-flush + 5-min pull. No LAN P2P in v1. |
| 12 | Monorepo with `apps/`, `packages/`, `crates/` | Protocol changes ship in one PR; one issue tracker; one CI. |
| 13 | macOS + Windows signed builds; Tauri updater; direct download primary; no Mac App Store | Sandbox rules forbid required behaviors. Direct download + Homebrew Cask + Winget covers the audience. |
| 14 | Daemon-centric testing: Tier 3 (daemon-driven, no browser) is the workhorse; ~3-5 full-stack E2E only | Connector is thin; most behavior lives daemon-side; full E2E is for integration regressions only. |
| 15 | v1 = full feature parity, no new features, drop offscreen / CSP / FS-Access scaffolding | Don't combine port with feature work; ruthless about non-goals. |
| 16 | Five-phase shipping with each phase ending in a runnable, tested state | Avoid the "everything broken until the end" failure mode of large architecture moves. |
| 17 | `effectOf` ports to Rust, not embedded JS in the daemon | ~2 weeks of focused work bounded by existing 1471-line test suite; type safety is a real win; keeps Tauri viable. |

## Non-goals (v1)

- No new browser support (Firefox/Safari connectors).
- No LAN/P2P sync.
- No new capture sources (PDFs, files, non-browser apps).
- No global hotkey, command palette, multi-window UX.
- No design refresh — port the existing look as-is.
- No telemetry/analytics added during the port.
- No Mac App Store, no Homebrew/Winget until after v1 ships on direct download.
- No backward-compatibility code for any pre-port extension installs (none exist).

## Phase overview

| Phase | Plan | Estimate | End state |
|---|---|---|---|
| 0 | [30-desktop-phase-0-repo-reshape.md](./30-desktop-phase-0-repo-reshape.md) | 1-2 days | Files moved into workspace layout; tests still pass against existing extension. |
| 1 | [31-desktop-phase-1-shell-protocol.md](./31-desktop-phase-1-shell-protocol.md) | ~1 week | Tauri shell + tray + login item; WebSocket pairing works; connector stub holds connection. |
| 2 | [32-desktop-phase-2-replay-port.md](./32-desktop-phase-2-replay-port.md) | ~3 weeks | `effectOf` ported to Rust; events flow extension → daemon → `~/browser-data`. No UI yet. |
| 3 | [33-desktop-phase-3-ui-port.md](./33-desktop-phase-3-ui-port.md) | ~3-4 weeks | Full feature parity. Main UI in Tauri webview; popup uses WebSocket RPC; sync moved. |
| 4 | [34-desktop-phase-4-distribution.md](./34-desktop-phase-4-distribution.md) | ~1-2 weeks | Signed builds for mac + win; auto-updater wired; CWS listing for connector; v1.0.0 ships. |

**Total: 8-10 weeks of focused work for one person.** Realistically 11-13 with normal interruptions.

## Discipline rule

Each phase ends in a runnable, testable state. No "we'll wire it up later" cliffs. If Phase 2 ends and you can't watch a real browser visit land in `~/browser-data` via the new path, Phase 2 isn't done.

## Additional decisions (resolved before phases begin)

| # | Decision | Where detailed |
|---|---|---|
| 18 | Function rules run in the daemon via embedded **rquickjs** (~600KB Rust binding to QuickJS) | Phase 2 |
| 19 | Snapshots travel over WebSocket as single JSON messages; max frame size 16MB; connector accounts size against 8MB `chrome.storage.local` budget | Phase 2 |
| 20 | `crates/search` drops its WASM target; becomes a plain native Rust library linked by the daemon | Phase 2 |
| 21 | `pauseService` equivalent in daemon: `ServiceState` enum (`Running` / `Paused{code, message}`); UI reads in-process; connector learns via send-rejection responses, not proactive push | Phase 2 |
| 22 | Connector extension has a stub options page (single "Open Browser Recall" button) | Phase 3 |
| 23 | Daemon registers `browser-recall://` URL scheme via Tauri `deep-link` plugin | Phase 1 |
| 24 | Explicit connector manifest permission diff (keep list vs drop list) | Phase 3 |
| 25 | CURRENT file gains `hostname` field; daemon prompts "Same machine / New machine (fork ID)" on mismatch to guard sync integrity on shared/synced folders | Phase 2 |
| 26 | Daemon logging via `tracing` + `tracing-appender`, daily rotation, 7-day retention | Phase 2 |
| 27 | Snapshot behavior during buffer pressure: inherit refuse mode from decision 4 (stop all capture when buffer near full, resume on drain). No separate deferred-snapshot tracking. | Phase 2 |
| 28 | PRIVACY.md and DEVELOPMENT.md updated in Phase 4 (privacy threat model; dev-time daemon workflow) | Phase 4 |
| 29 | Migration scope = dev folders + any pre-1.0 beta testers. No published-user population exists. | Phase 2 |

## Open sub-questions to resolve during implementation

- **Profile detection in Chrome.** We want `source: { browser, profile }` on every event. Chrome doesn't expose profile names cleanly to extensions; settle for an opaque per-profile install ID generated at first run.
- **Daemon UI window architecture.** Single window with sidebar (current options.html shape) is the default. Multi-window (separate windows for focus panel, settings) deferred unless the port surfaces a real need.
- **Token storage location on disk.** Plain file in the daemon's config dir is fine for v1 (same access boundary as the data folder). OS keychain integration deferred.
- **Popup RPC payload shape.** Define the `getPageSummary(url)` response in `packages/protocol/` before Phase 3. One round-trip, returns everything the popup needs to render: page entity summary, child notes/snapshots, list memberships, attention info.
