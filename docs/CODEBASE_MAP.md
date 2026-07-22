# Browser Recall — Codebase Map

> Reference map for the current desktop-first product.

## Status Note

The codebase is organized around one main app plus one thin browser connector:

- `apps/desktop/` — desktop shell and main UI
- `apps/extension/` — Chrome connector and popup
- `crates/` — replay, search, and daemon back end
- `packages/` — shared JS/CSS modules

This map intentionally excludes removed extension-only storage/sync internals.

## Top-Level Layout

| Path | Role |
|------|------|
| `apps/desktop/ui/` | Main Browser Recall interface rendered in Tauri |
| `apps/desktop/src-tauri/` | Tauri shell, event bridge, OS integration |
| `apps/extension/` | Thin Chrome connector: capture, popup, pairing, buffering |
| `crates/daemon/` | Storage/search/sync/pairing command layer |
| `crates/replay/` | Authoritative replay engine and replay verifier |
| `crates/search/` | Native search helpers |
| `packages/core/` | Shared JS helpers, theme, CSS, runtime utilities |
| `icons/` | Root SVG sources for desktop and extension runtime icons |
| `tests/` | Unit, integration, and e2e coverage |
| `plans/` | Phase plans 29–34 for the desktop split |

## Core Runtime Files

| File | Role |
|------|------|
| `apps/desktop/ui/index.html` | Main desktop UI document |
| `apps/desktop/ui/index.js` | Ported main UI logic: history, lists, search, settings, recycle bin |
| `apps/desktop/ui/desktop-bridge.js` | Direct Tauri invoke helpers plus strict shell, device, directory, connector, and product-response DTO validation |
| `apps/desktop/ui/desktop-platform.js` | Strict Tauri host adapter for UI storage, runtime messages/reload, external URL opens, and platform readiness |
| `apps/desktop/ui/bookmark-parser.js` | Desktop bookmark import parser |
| `apps/desktop/src-tauri/src/main.rs` | Tauri entry point, invoke bridge, daemon write routing, serialized daemon-start diagnostics/retry, storage-authority enforcement, desktop events, window/deep-link handling |
| `apps/desktop/src-tauri/src/config.rs` | Desktop config loading/persistence helpers; fresh setup keeps the data directory empty until onboarding selects one |
| `apps/desktop/src-tauri/src/login_item.rs` | Login-item integration for desktop startup behavior |
| `apps/desktop/src-tauri/capabilities/main.json` | Main webview permission for runtime and storage event subscriptions |
| `apps/desktop/src-tauri/src/search.rs` | Desktop-side search adapters/helpers |
| `apps/extension/background.js` | Thin connector runtime: prepared toolbar popup launch, popup RPC, buffering, pairing, snapshot/capture forwarding |
| `apps/extension/browser-api.js` | Strict engine-selected Manifest V3 adapter for Chromium and Firefox; requires canonical runtime/action/context-menu APIs and rejects unsupported platform shapes |
| `apps/extension/icon-paths.js` | Packaged default, stop-recording, and special-state toolbar icon paths |
| `apps/extension/background-test-control.js` | Test-only background RPC handlers staged by `tests/fixtures/test-extension.mjs` |
| `apps/extension/content.js` | Visit/attention capture and browser-message adapter for shared highlight and Markdown extraction modules |
| `packages/core/highlight-lifecycle.js` | Narrow shared selection, scoped matching, `browser-recall-` mark ownership, missing-mark hydration repair, and disposal module for live pages and snapshots |
| `packages/core/markdown-extractor.js` | Shared complete DOM-to-Markdown conversion plus the generated classic content-script bridge used for searchable snapshot sidecars |
| `packages/core/snapshot-html.js` | Pure idempotent snapshot preparation: Browser Recall highlight cleanup, snapshot identity metadata injection, and unavailable external stylesheet deactivation |
| `apps/extension/popup.js` | Current-tab popup UI |
| `apps/extension/extension-surface.css` | Shared light paper styling for extension pages |
| `apps/extension/extension-surface.js` | Shared shadow-DOM styling and overlay placement helpers for extension content surfaces |
| `apps/extension/extension-ui-tokens.js` | Shared extension paper/error tokens and transient error popout styling |
| `apps/extension/savepage-bridge.js` | Save Page WE capture bridge |
| `apps/extension/connector/ws-client.js` | Connector websocket transport, request readiness, reconnect handling, and canonical daemon-mutation validation/forwarding |
| `apps/extension/connector/pairing.js` | Pairing bootstrap and session helpers |
| `apps/extension/connector/command-buffer.js` | Sole owner of the short-lived outbound queue and its persisted count/byte/refuse snapshot |
| `apps/extension/options-stub.html` | Stub page that points users to the desktop app |
| `crates/daemon/src/command_authority.rs` | Shared Tauri/WebSocket semantic mutation classification, strict response validation, typed execution results, and committed mutation meaning |
| `crates/daemon/src/commands.rs` | Replay-backed command and read implementations used behind daemon interfaces |
| `crates/replay/src/settings.rs` | Replay-owned persistent settings keys, defaults, enum domains (including amber and mono color schemes), collection shapes, and numeric bounds shared by every log/command/sync ingress |
| `crates/daemon/src/settings.rs` | Thin re-export of the replay-owned settings contract for daemon commands, reads, capture policy, startup, and sync |
| `crates/daemon/src/config.rs` | Daemon configuration persistence and explicit unconfigured → folder-selected → setup-complete transitions; no default data path |
| `crates/daemon/src/read_projections.rs` | Workflow-shaped semantic page, list, search-enrichment, recycle-bin, popup, and settings DTOs with coordinated joins, child-reference classification, and visibility policy |
| `crates/daemon/src/runtime.rs` | Authoritative replay transactions: serialized overlay evolution, canonical local log append, projection publication, replay progress, ordered checkpoint submission, downloaded sync-file installation, recovery, and destructive flush coordination |
| `crates/daemon/src/storage.rs` | Data-root storage, sharded object/view paths, coordinated cache reads and namespace enumeration overlays, current projection cache, log append, and flushable ordered checkpoint worker |
| `crates/daemon/src/search.rs` | Daemon search queries over history/notes and canonical sharded Markdown snapshot sidecars |
| `crates/daemon/src/sync.rs` | GitHub sync controller, token handling, pause persistence |
| `crates/daemon/src/ws_server.rs` | Browser pairing, authenticated websocket adapter, strict rule command DTOs, browser observations, streaming, and change broadcasts |
| `crates/daemon/src/pairing.rs` | Pairing data/state helpers |
| `crates/replay/src/lib.rs` | Production replay engine |
| `crates/replay/examples/page-identity.rs` | Test-only batch adapter exposing native replay URL slug generation to cross-language identity parity coverage |
| `crates/replay/src/bin/replay-verify.rs` | Full-log checkpoint verifier using the production replay and checkpoint policy |
| `crates/search/src/lib.rs` | Native search primitives |
| `scripts/stage-app-assets.mjs` | Stages loadable app assets under `dist/extension/{chrome,firefox}/` and `dist/desktop/ui/`, validates registered locale catalog parity, and generates filtered WebExtension locale files plus shared classic content-script bridges |
| `scripts/collect-desktop-artifacts.mjs` | Collects Tauri release binaries and bundles into `dist/desktop/<platform>/` |
| `scripts/manual-test-browser.mjs` and `scripts/lib/manual-seed.mjs` | Isolated manual Chrome/daemon workflow and its replay-consistent, daemon-default-preserving seed/flush helper |
| `scripts/test-coverage-monitor.mjs` | Test investment and JS/Rust uncovered-line monitor; enforces no JS or inline Rust unit-test LoC growth |
| `scripts/generate-icons.mjs` | Renders root SVG icon sources into opaque desktop/extension icons, the transparent tray icon, and the macOS `.icns` pack |
| `scripts/finalize-macos-app-bundle.mjs` | Gives local ad-hoc macOS bundles a stable explicit bundle-identifier designated requirement; real Apple identities bypass this local-only step |
| `scripts/verify-macos-app-bundle.mjs` | Post-build macOS signature verifier for strict bundle validity, identifier binding, bound `Info.plist`, and sealed resources |
| `packages/core/index.js` | Shared package exports |
| `packages/core/page-identity.js` | Shared page URL canonicalization, slug generation, and same-document classification, plus generated classic-script bridge source for content scripts |
| `packages/core/utils.js` | Shared utility helpers that re-export page identity and provide connector request canonicalization |
| `packages/core/i18n.js` | Shared locale registry and UI localization runtime for catalog lookup, desktop language options, document localization, and WebExtension i18n adaptation |
| `packages/core/locales/en/messages.json` | Canonical English message catalog, used by desktop UI assets and filtered into extension `/_locales` |
| `packages/core/locales/<locale>/messages.json` | Complete catalogs for `en`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `pt-BR`, `pt-PT`, `ru`, `zh-CN`, and `zh-TW`; all must match English keys, placeholders, HTML structure, protected literals, and product terms |
| `packages/core/time-chart.js` | Shared history chart rendering helpers |
| `packages/core/virtual-scroller.js` | Shared virtual scrolling helper |
| `packages/core/theme.js` | Shared theme/session helpers |

## Feature → Code Map

### Desktop UI

- `apps/desktop/ui/index.js` owns history rendering, lists, search, settings, recycle bin, imports, and mutation dispatch.
- Desktop UI localization uses the registry in `packages/core/i18n.js`; system locale comes from the Tauri shell, while `localeOverride` persists in daemon settings. The settings selector is generated from the registry rather than maintained separately in HTML.
- `apps/desktop/ui/desktop-bridge.js` owns direct Tauri command dispatch for desktop product actions.
- `apps/desktop/ui/desktop-platform.js` exposes only the host surfaces current desktop UI code uses and fails startup if Tauri invoke/event bridges are unavailable.
- `apps/desktop/src-tauri/src/main.rs` forwards command results, change events, and storage updates into the webview. Its window lifecycle keeps the webview warm while closed and restores visibility/focus when the tray, Dock, or a deep link reopens it, discarding retained frames that no longer intersect a current display. One asynchronous start gate serializes daemon creation; an absent daemon exposes shell recovery actions but no fabricated storage authority, and its real startup path is tested against repair-and-retry recovery.

### Connector Popup

- `apps/extension/popup.js` consumes prepared bootstrap payloads when present, requests the same complete page summary on direct loads, resolves private mode before entering the dashboard shell, submits popup mutations through a serialized non-dimming UI lane, refreshes current-page list metadata from committed daemon pin/list mutations through that same lane, and owns the transient list-picker/search keyboard UI. The picker opens from the per-open popup projection without another list read. Existing membership toggles rely on their command response plus mutation-stream reconciliation instead of an explicit summary reread, while new-list membership uses one `createListAndPin` command rather than two dependent round trips. Its capture and picker modes share one statically mounted input node so popup startup and native IME composition never cross a reparent or replacement boundary.
- Extension UI and manifest localization use browser-native WebExtension `i18n` files staged from `packages/core/locales/`; only `extension*`, `command*`, and `common*` keys are packaged. The extension follows the browser's UI locale and does not persist a product locale override.
- `apps/extension/background.js` resolves popup actions through the daemon connection and is the sole owner of tab page-identity rules. Direct popup loads and snapshot-viewer badge refreshes use the same validated reported/content/embedded/snapshot identity. Toolbar clicks request one popup-ready daemon projection containing access policy, display title, page data, notes, snapshots, lists, and attention before opening `popup.html?bootstrap=...`, avoiding a manifest `default_popup` first frame without serial status/title/access reads. Prepared popup data is handed off by a one-shot in-memory token, has a bounded timeout, and is rebuilt when a committed daemon mutation invalidates it before consumption. Engines without programmatic action popups fall back to an extension tab. Pairing/authentication negotiate the sole connector protocol version 1 in both directions, rejecting missing or different versions before connected state. Test-only background RPCs are split into `apps/extension/background-test-control.js` and included only in staged test extensions.
- `apps/extension/icon-paths.js` defines packaged toolbar icon sets for normal capture, paused recording, and special page-marker states; `apps/extension/badge-controller.js` applies those icons after awaiting the background-owned tab identity resolver, and completed snapshot viewers refresh against a live connector probe.
- `apps/extension/options-stub.js` only opens the desktop app; it is not a settings surface.

### Capture Path

- `apps/extension/content.js` captures visit/attention signals and adapts browser messages and daemon note reads to `packages/core/highlight-lifecycle.js`. The shared module owns structured selection, scoped reapply, mark groups, hydration retries, and route disposal for live pages and the snapshot viewer. Snapshot identity uses only `x-browser-recall-slug` and `x-browser-recall-url` metadata. Staged builds generate and load both `browser-recall-page-identity.js` and `browser-recall-highlight-lifecycle.js` before classic `content.js`, so module and content-script callers execute the same implementations.
- `apps/extension/savepage-bridge.js` performs snapshot capture through one identified per-tab session that owns capture settings, lifecycle timers, and explicit resource-failure warnings. `apps/extension/background.js` passes the stored result through the pure `packages/core/snapshot-html.js` boundary, which removes Browser Recall-owned highlight markup, injects identity metadata, and deactivates stylesheet links that remained external after capture. This keeps capture and repair tooling on one idempotent implementation while preventing known-unavailable CSS from blocking replay and retaining the URL as diagnostic metadata.
- `apps/extension/background.js` buffers and forwards capture events to the daemon, and injects a page reload warning when shortcut/context-menu actions cannot reach a stale content script.
- `apps/extension/popup.js` surfaces popup-initiated capture failures through page notifications with popup-bubble fallback.

### Replay and Storage

- `crates/replay/` is the production replay engine and owns replay-derived checkpoint policy used by verification and daemon persistence.
- `packages/core/page-identity.js` canonicalizes extension-originated page URLs before they are sent to desktop, removes underscore-prefixed query params while keeping ordinary query params and fragments, and classifies same-document navigation for both background and content-script callers. Optional non-page referrers are omitted at the connector boundary. `packages/core/utils.js` and the generated content-script bridge use that shared implementation. `packages/core/markdown-extractor.js` similarly owns live-DOM Markdown conversion and its generated classic bridge, so capture and tests exercise one implementation. `crates/replay/src/lib.rs` hashes the URL it receives with a native Rust implementation; non-extension producers must send canonical URLs, and `tests/integration/page-identity-parity.test.js` differentially checks both implementations over a deterministic generated corpus.
- `crates/daemon/src/storage.rs` owns coordinated cache-miss reads, filesystem primitives, the current projection cache, synchronous log append, history file/device-directory listing, the ordered async checkpoint worker, replay-progress files, and the current `logs/`, `objects/`, `views/` path layout.
- `crates/daemon/src/command_authority.rs` is the shared semantic mutation interface used by the in-process Tauri adapter and authenticated WebSocket adapter. It owns the supported action set, validation, response formation, and post-commit mutation meaning, including affected URL sets used by connector surfaces; note-pin commands derive that URL from the authoritative note when the request has no page URL. Mutation payload construction is shared with replay notification paths through `crates/daemon/src/mutations.rs`. Native shell actions and connector observations remain adapter-specific. Extension command handlers consume this notification stream instead of reclassifying mutations or directly refreshing product badges.
- `crates/daemon/src/commands.rs` implements replay-backed reads and mutations behind daemon interfaces, constructs strict replay entries, and keeps command-only fields out of JSONL.
- `crates/replay/src/settings.rs` is the only product-settings schema. Replay validates every `update_setting` key/value, while startup, destructive reset, command writes, projections, capture policy, and sync consume the same contract and reject unknown, partial, or mistyped settings instead of supplying consumer-local defaults.
- `crates/replay/src/entities.rs` defines the one checkpoint schema. List `slug`, `name`, and `owner` are required non-empty strings; an ownerless or blank-identity list is invalid data rather than a request to infer ownership from the current device.
- `crates/daemon/src/rules.rs` is the sole rule validation, preview, and automatic-matching implementation; desktop keyword and function previews both call this native module through daemon commands, and automatic matching preserves an observation's explicit-nullable title.
- `crates/daemon/src/read_projections.rs` owns workflow joins and visibility policy for deep read interfaces. It supplies list display, page/search context, all-page filter context, page info/snapshots, list trees, recycle-bin entries, compact popup list membership (`containsPage` plus `lastActivity`), and settings through coordinated cache/disk reads. Tauri and WebSocket adapters translate these results without leaking entity-key construction or raw popup pin collections into product callers.
- `crates/daemon/src/command_authority.rs` deserializes shared mutations once through a closed tagged enum and returns the committed response with mutation notifications. Typed note/list inputs flow into `commands.rs`; those implementations do not inspect the transport JSON again.
- `crates/daemon/src/storage.rs` uses one internal log catalog for replay recovery, history enumeration/loading, and sync collection. The catalog selects owned device directories and dated JSONL files, ignores entries outside that namespace, and strictly validates selected filenames and records.
- Generic WebSocket reads, raw replay event/note ingest, reset/clear, remote replay, device replacement, direct search/rule calls, and raw permanent deletion exist only as nested `test_control` requests and are rejected unless daemon test control is explicitly enabled. The extension `readDesktopValue` relay is staged only in test builds; the Tauri generic read and shared-web generic-read exports were removed, so production code has no generic entity-read caller.
- `crates/daemon/src/runtime.rs` owns the replay transaction interface used by commands, websocket ingest, remote replay, rule batches, sync ingestion, startup recovery, and destructive clearing. It is the only production caller of checkpoint-capacity reservation, direct projection-cache effects, and reserved checkpoint submission.
- Production Rust crate and binary roots deny panic-style `expect`, `unwrap`, `panic!`, and `unreachable!` calls outside tests; daemon and desktop synchronous shared state uses non-poisoning locks.

### Search

- `crates/search/` and `crates/daemon/src/search.rs` implement history identity search plus dedicated note/snapshot text search. They preserve explicit-nullable history titles and select owned checkpoint/sidecar files before strict parsing. Snapshot search walks only the documented two-character shard level and accepts only `.md`; it never reads raw `.html` replay sidecars. Note search overlays current projection-cache entities before scoring so committed notes do not wait for checkpoint persistence. History search also exposes a fixed-parallelism chunk callback for desktop streaming and cancellation.
- `apps/desktop/src-tauri/src/main.rs` exposes `search_history_stream` / `cancel_history_search` Tauri commands and emits `bridge-search-history` chunks to the UI.
- `crates/daemon/src/ws_server.rs` exposes note/snapshot search and page-scoped connector reads, but deliberately does not expose full-history streaming or cancellation.
- `apps/desktop/ui/index.js` keeps typed search text as a draft until Enter commits it, then merges streamed history chunks with note/snapshot result phases. It renders the already-loaded or first available matches once while those phases continue, preserves URL-keyed row selection and chart highlighting when the accumulated set commits, and consumes precise daemon history-mutation entries without rereading the current-day log or restarting searches. Visit/leave observations update visit recency; rename/rating actions only invalidate metadata, query membership, filters, and authoritative page enrichment. Explore device filters still come from daemon-reported `logs/<device>/` directories, and newer searches cancel stale history work.
- `packages/core/search-runtime.js` provides the shared phase-0 identity scorer used by the desktop UI and tests. Desktop search reads daemon history/search projections only; it never merges the extension connector queue into a second read model.

### Pairing and Live Updates

- `crates/daemon/src/ws_server.rs` owns paired-browser websocket sessions.
- `apps/extension/connector/pairing.js` and `apps/extension/connector/ws-client.js` manage the browser side. Pairing sends platform-observed identity and an explicit-null `browserProfile`; no synthetic profile is persisted. Authentication requires a successful strict status round trip before connected state is published. Buffered writes always include queue depth/bytes, and malformed daemon frames close the socket with a persisted diagnostic. Successful daemon responses and mutation entries are shape-checked before queue acknowledgement or UI delivery; precise history mutation fields are forwarded rather than discarded.
- `apps/desktop/src-tauri/src/main.rs` rebroadcasts daemon change notifications to desktop webviews.
- Authenticated connector sockets also receive daemon change notifications for live connector surfaces such as tab badges and open-popup list membership.

### Sync

- `crates/daemon/src/sync.rs` owns GitHub sync orchestration, auth/token handling, persisted sync pause state, typed GitHub branch/tree response decoding, and strict downloaded JSONL parsing before runtime installation.
- `apps/desktop/ui/index.js` edits sync settings and renders sync status.
- Connector websocket RPCs do not expose sync file or manifest operations.

## Current Test Coverage

| Path | Coverage |
|------|----------|
| `tests/unit/` | Shared JS helpers, rule helpers, charts, scrollers, and connector-side utilities |
| `tests/integration/popup-rpc.test.js` | Popup ↔ daemon RPC integration |
| `tests/integration/pairing.test.js` | Browser pairing flow |
| `tests/integration/event-flow.test.js` | Connector event flow into the daemon |
| `tests/integration/page-identity-parity.test.js` | Deterministic cross-language property coverage for JavaScript canonical identity, Rust replay identity, and optional non-page referrer filtering |
| `crates/daemon/tests/read_projections.rs` | Daemon list-display projection coverage, including non-empty page/note pins, deleted visibility, explicit missing targets, and cache-miss-to-disk reads |
| `tests/e2e/popup-lists.spec.js` | Popup list interactions in the shipped connector, including pre-existing membership and toolbar icon state for query-bearing HN-shaped URLs |
| `tests/e2e/badge.spec.js` | Popup/badge behavior in the shipped connector |
| `tests/e2e/extension-error-popouts.spec.js` | Browser-level extension popup and snapshot error popout styling |
| `tests/e2e/snapshot-resource-timeout.spec.js` | Snapshot resource body timeouts, CORS fallback reporting, partial-capture warnings, and deactivation of timed-out stylesheet links through the real connector/daemon path |
| `tests/e2e/seeded-combination-workflows.spec.js` | Seeded randomized extension workflow combining visits, notes, list pins, and popup reads |
| `tests/e2e/manual-seed-workflow.spec.js` | Real daemon/connector regression coverage for the manual seeded-data helper, including valid current settings and post-seed queue flush |
| `tests/e2e/extension-navigation-regressions.spec.js` | Browser navigation coverage for same-document transitions, new-tab referrer relationships, page summaries, and highlight lifecycle behavior |
| `tests/e2e/desktop-locale-setting.spec.js` | Registry-complete desktop locale workflow through the real connector, daemon, settings checkpoints, UI reloads, invalid-override reporting, and RTL verification |
| `tests/e2e/extension-localization.spec.js` | Browser-native WebExtension catalog selection using the packaged extension and the browser-reported UI locale |
| `tests/smoke/macos-desktop-window-lifecycle.mjs` | Ephemeral-session signed-app smoke test proving startup errors remain painted, repaired storage survives a native relaunch, and an accessible tray menu survives repeated close/reopen, focus, and frame preservation; CI runs it on a disposable macOS 26 runner |
| `scripts/test-coverage-monitor.mjs` | Test-suite LoC mix and JS/Rust uncovered production line reporting |
| `crates/daemon/tests/commands.rs` | Desktop command-surface coverage |
| `crates/daemon/tests/command_authority.rs` | Shared semantic command response, validation, committed state, and mutation outcome coverage |
| `crates/daemon/tests/runtime.rs` | Replay transaction coverage for canonical local append, downloaded remote-file installation without duplicate log writes, and explicit projection-load failures |
| `crates/daemon/tests/sync_controller.rs` | Daemon sync-controller coverage |
| `crates/replay/tests/replay_verify.rs` | Production verifier coverage for selecting owned log namespace entries while ignoring unrelated filesystem files |

## Remaining Intentional Gap

A full desktop GUI parity suite is still intentionally absent. The focused macOS lifecycle smoke test covers the native close/tray-reopen boundary; desktop visual behavior remains covered separately in Chromium.
