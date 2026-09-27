# Browser Recall — Codebase Map

> Reference map for the current desktop-first product.

## Status Note

The codebase is organized around one main app plus one thin browser connector:

- `apps/desktop/` — desktop shell and main UI
- `apps/extension/` — Chromium/Firefox connector and popup
- `crates/` — replay, search, and daemon back end
- `packages/` — shared JS/CSS modules

This map intentionally excludes removed extension-only storage/sync internals.

## Top-Level Layout

| Path | Role |
|------|------|
| `apps/desktop/ui/` | Main Browser Recall interface rendered in Tauri |
| `apps/desktop/src-tauri/` | Tauri shell, event bridge, OS integration |
| `apps/extension/` | Thin browser connector: capture, popup, pairing, buffering |
| `crates/daemon/` | Storage/search/sync/pairing command layer |
| `crates/replay/` | Authoritative replay engine and replay verifier |
| `crates/search/` | Native search helpers |
| `packages/core/` | Shared JS helpers, theme, CSS, runtime utilities |
| `icons/` | Root SVG sources for desktop and extension runtime icons |
| `tests/` | Unit, integration, and e2e coverage |
| `.gitattributes` | Cross-platform LF text checkout policy, including importable JavaScript shebangs |
| `.github/workflows/ci.yml` | Hosted jobs delegate to canonical local scripts; macOS 26 visual baseline host and platform-specific native smokes; Windows compiles before browser setup |
| `package.json` | Local verification commands, including `check:desktop:windows` for all-target Windows GNU cross-checks from macOS with MinGW |
| `plans/` | Phase plans 29–34 for the desktop split |

## Core Runtime Files

| File | Role |
|------|------|
| `apps/desktop/ui/index.html` | Main desktop UI document and CSS, including highlight-history navigation/presentation |
| `apps/desktop/ui/shared.css`, `apps/desktop/ui/fonts/` | Bundled desktop font faces, including Gentium Book Plus 6.200 regular, italic, and bold italic for Book date headings |
| `apps/desktop/ui/index.js` | Main UI logic: Explore/history, per-highlight history, lists, search, settings, and recycle bin |
| `apps/desktop/ui/desktop-bridge.js` | Direct Tauri invoke helpers plus strict shell, device, directory, connector, and product-response DTO validation, including explicit-null browser profiles |
| `apps/desktop/ui/desktop-platform.js` | Strict Tauri host adapter for UI storage, runtime messages/reload, external URL opens, and platform readiness |
| `apps/desktop/ui/bookmark-parser.js` | Desktop bookmark import parser |
| `apps/desktop/src-tauri/src/main.rs` | Tauri entry point, invoke bridge, daemon write routing, serialized daemon-start diagnostics/retry, storage-authority enforcement, desktop events, and single-instance window/deep-link handling |
| `apps/desktop/src-tauri/src/windows_icon.rs` | Windows HWND icon setup: loads DPI-matched small and taskbar icons from the executable's multi-resolution resource and reapplies them after monitor-scale changes |
| `apps/desktop/src-tauri/src/config.rs` | Desktop config loading/persistence helpers; fresh setup keeps the data directory empty until onboarding selects one |
| `apps/desktop/src-tauri/src/login_item.rs` | Testable login-item adapter with native macOS `SMAppService`, path-safe Windows Run registration, centralized idempotent reconciliation, exact native-state snapshots for config-write compensation, and nonfatal startup diagnostics |
| `apps/desktop/src-tauri/src/shell_contract.rs` | Typed nullable desktop-shell command response plus the route-only state injected into the warm webview |
| `apps/desktop/src-tauri/capabilities/main.json` | Main webview permission for runtime and storage event subscriptions |
| `apps/desktop/src-tauri/src/search.rs` | Desktop-side search adapters/helpers |
| `apps/extension/background.js` | Thin connector runtime: browser-level same-document navigation forwarding with quick then ongoing delivery retries and tab-scoped failure diagnostics, immediate hidden toolbar/`Alt+R` popup launch, asynchronous authoritative bootstrap handoff, popup RPC, buffering, pairing, snapshot/capture forwarding |
| `apps/extension/browser-build-target.js` | Staging-generated immutable Chromium/Firefox build target loaded before adapter entry points |
| `apps/extension/browser-api.js` | Context-safe WebExtension adapter driven by the staged build target; exposes execution context and centralized shadow-root capabilities; Orion's Chrome-extension mode intentionally follows the Chromium path |
| `apps/extension/browser-privileged-api.js` | Background-only validation boundary for privileged WebExtension namespaces omitted from Firefox content contexts |
| `apps/extension/browser-identity.js` | Product identity detection for pairing, kept separate from the artifact build target; recognizes Orion's Kagi marker before Chrome-compatible user-agent text |
| `apps/extension/icon-paths.js` | Packaged default, stop-recording, and special-state toolbar icon paths |
| `apps/extension/background-test-control.js` | Test-only background RPC handlers staged by `tests/fixtures/test-extension.mjs` |
| `apps/extension/content.js` | Visit/attention capture, live-URL reconciliation and idempotent same-document navigation handling, and browser-message adapter for shared highlight and Markdown extraction modules |
| `apps/extension/spa-navigation-bridge.js` | Document-start page-world navigation adapter and YouTube navigation start/finish lifecycle; queues observations until content capture initializes |
| `packages/core/highlight-lifecycle.js` | Shared prepared-selection interface with strict versioned light-DOM and composed shadow-root selector-plus-block-offset anchors in aligned `cssPath` strings, explicit legacy selector anchors, owned-mark intersection rejection, exact-offset reapply, missing-mark hydration repair, and disposal for live pages and snapshots |
| `packages/core/markdown-extractor.js` | Shared complete DOM-to-Markdown conversion plus the generated classic content-script bridge used for searchable snapshot sidecars |
| `packages/core/snapshot-html.js` | Pure snapshot preparation with authoritative identity replacement, strict identity validation, Browser Recall highlight cleanup, and unavailable external stylesheet deactivation |
| `apps/extension/snapshot-resource-fetch.js` | Capture-policy referrers for host-permission retries; exact-URL temporary rules, bounded manual redirect chains with filtered response-header observation and per-hop referrer policy, same-URL serialization, and cleanup |
| `apps/extension/savepage/content.js` | Maintained Save Page WE serializer; embeds CSS image data directly to preserve vendor-prefixed fallback declarations without introducing custom properties |
| `scripts/migrate-snapshot-identity.mjs` | Strict one-time snapshot HTML migration that verifies each page URL produces the checkpoint/file slug, derives canonical identity from that checkpoint, and atomically rewrites missing or obsolete metadata |
| `apps/extension/popup.js` | Current-tab popup UI using only the dashboard diagnostic panel's status/message fields for connector startup/errors and authoritative asynchronous bootstrap replacement |
| `apps/extension/extension-surface.css` | Shared light paper styling for extension pages |
| `apps/extension/extension-surface.js` | Shared shadow-DOM styling and overlay placement helpers for extension content surfaces |
| `apps/extension/popup-note-session.js` | Volatile popup note drafts handed to the background worker; disconnect joins explicit saves/deletion and transfers unsaved commands to the existing durable connector outbox before releasing the session |
| `apps/extension/extension-ui-tokens.js` | Shared extension paper/error tokens and transient error popout styling |
| `apps/extension/savepage-bridge.js` | Save Page WE capture bridge |
| `apps/extension/connector/ws-client.js` | Five-phase canonical connector state machine, identified websocket session, serialized request/drain lanes, reconnect handling, and daemon-mutation validation/forwarding |
| `apps/extension/connector/pairing.js` | Pairing bootstrap and session helpers |
| `apps/extension/connector/command-buffer.js` | Sole owner of the short-lived outbound queue and its persisted count/byte snapshot |
| `apps/extension/options-stub.html` | Stub page that points users to the desktop app |
| `crates/daemon/src/command_authority.rs` | Shared Tauri/WebSocket semantic mutation classification, strict response validation, typed execution results, and committed mutation meaning |
| `crates/daemon/src/commands.rs` | Replay-backed command and read implementations used behind daemon interfaces, including daemon title cleanup for live note capture without an existing page title |
| `crates/replay/src/settings.rs` | Replay-owned persistent settings keys, light-theme default, enum domains (including amber and mono color schemes), collection shapes, and numeric bounds shared by every log/command/sync ingress |
| `crates/replay/src/entities.rs` | Replay entity/checkpoint schemas; list pins omit absent provenance while retaining every non-null `source` |
| `crates/daemon/src/settings.rs` | Thin re-export of the replay-owned settings contract for daemon commands, reads, capture policy, startup, and sync |
| `crates/daemon/src/config.rs` | Daemon configuration persistence and explicit unconfigured → folder-selected → setup-complete transitions; no default data path |
| `crates/daemon/src/read_projections.rs` | Workflow-shaped semantic page, list, per-highlight history, search-enrichment, recycle-bin, popup, and settings DTOs with coordinated joins, child-reference classification, and visibility policy |
| `crates/daemon/src/runtime.rs` | Authoritative replay transactions: serialized overlay evolution, canonical local log append, projection publication, replay progress, ordered checkpoint submission, downloaded sync-file installation, recovery, and destructive flush coordination |
| `crates/daemon/src/storage.rs` | Data-root storage, sharded object/view paths, coordinated cache reads and namespace enumeration overlays, current projection cache, log append, and flushable ordered checkpoint worker |
| `crates/daemon/src/data_directory_docs.rs`, `crates/daemon/resources/data-AGENTS.md` | Ship and refresh the data-root `AGENTS.md`: storage format reference, current-device offline edits, and virtual-device atomic publication with deferred replay; preserve personal text and report refresh failures without blocking storage |
| `crates/daemon/src/search.rs` | Daemon search queries over history/notes and canonical sharded Markdown snapshot sidecars |
| `crates/daemon/src/sync.rs` | GitHub sync controller, token handling, pause persistence |
| `crates/daemon/src/ws_server.rs` | Browser pairing, authenticated websocket adapter, strict rule command DTOs, browser observations, streaming, and change broadcasts |
| `crates/daemon/src/pairing.rs` | Pairing data/state helpers |
| `crates/replay/src/lib.rs` | Production replay engine |
| `crates/replay/examples/page-identity.rs` | Test-only batch adapter exposing native replay URL slug generation to cross-language identity parity coverage |
| `crates/replay/src/bin/replay-verify.rs` | Full-log checkpoint verifier using production replay/checkpoint policy, unlogged-note base state, and explicit schema/timing/data diff categories |
| `crates/search/src/lib.rs` | Native search primitives |
| `scripts/stage-app-assets.mjs` | Stages loadable app assets under `dist/extension/{chrome,firefox}/` and `dist/desktop/ui/`; its source-tree seam excludes `.DS_Store`, verifies AppleDouble magic before excluding `._*` files, and preserves ordinary `._*` source files before copy/discovery; it also self-hosts Justif plus its license, validates registered locale catalog parity, and generates filtered WebExtension locale files plus shared classic content-script bridges |
| `scripts/desktop-build-plan.mjs` | Immutable normalized desktop build plan shared by Tauri invocation, artifact collection, and platform finalization |
| `scripts/build-tauri-app.mjs` | Launches the declared Tauri JavaScript CLI through Node using the shared canonical platform build plan |
| `scripts/finalize-desktop-build.mjs` | Collects the canonical platform artifacts and runs macOS app signing finalization and verification only when the host is macOS |
| `scripts/collect-desktop-artifacts.mjs` | Stages Tauri release binaries and bundles, then promotes canonical platform output with failure compensation; Windows retires and replaces the executable inside the stable directory before promoting the complete staged remainder, restores the prior executable and remainder tree if promotion fails, and reports a locked retired executable as cleanup separate from successful installation, with tray-quit guidance |
| `scripts/manual-test-browser.mjs` and `scripts/lib/manual-seed.mjs` | Isolated manual Chrome/daemon workflow and its replay-consistent, daemon-default-preserving seed/flush helper |
| `scripts/test-coverage-monitor.mjs` | Test investment and JS/Rust uncovered-line monitor; enforces no JS or inline Rust unit-test LoC growth |
| `scripts/generate-icons.mjs` | Renders root SVG icon sources directly at every native Windows `.ico` and macOS `.icns` desktop slot, including Windows DPI-specific shell sizes, while retaining separately tuned extension icons and the transparent tray icon |
| `scripts/finalize-macos-app-bundle.mjs` | Gives local ad-hoc macOS bundles a stable explicit bundle-identifier designated requirement; real Apple identities bypass this local-only step |
| `scripts/verify-macos-app-bundle.mjs` | Post-build macOS signature verifier for strict bundle validity, identifier binding, bound `Info.plist`, and sealed resources |
| `packages/core/index.js` | Shared package exports |
| `packages/core/page-identity.js` | Shared page URL canonicalization, slug generation, and same-document classification, plus generated classic-script bridge source for content scripts |
| `packages/core/utils.js` | Shared utility helpers that re-export page identity and provide connector request canonicalization |
| `packages/core/i18n.js` | Shared locale registry and UI localization runtime for catalog lookup, desktop language options, document localization, and WebExtension i18n adaptation |
| `packages/core/locales/en/messages.json` | Canonical English message catalog, used by desktop UI assets and filtered into extension `/_locales` |
| `packages/core/locales/<locale>/messages.json` | Complete catalogs for `en`, `ar`, `de`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `pt-BR`, `pt-PT`, `ru`, `zh-CN`, and `zh-TW`; all must match English keys, placeholders, HTML structure, protected literals, and product terms |
| `packages/core/time-chart.js` | Shared history chart rendering, click filtering, and marquee date-selection helpers |
| `packages/core/virtual-scroller.js` | Shared virtual scrolling helper; retains the old layout through data replacement so Timeline refreshes preserve the viewport |
| `packages/core/theme.js` | Shared theme/session helpers |

## Feature → Code Map

### Desktop UI

- `apps/desktop/ui/index.html` presents the localized Timeline and Book destinations as a calm one-column stack of 36 px, left-aligned pill rows above Lists. Scheme-specific selected surfaces change the pill and compact line icon together without keycap chrome, motion, or a label-weight jump. The pill and icon share one transition-duration token and the same 1 ms reduced-motion override. Root lists expose accessible, CSS-drawn `−`/`+` folder toggles, leaf lists use a small hollow circle in the same outline color, and the Settings utility icon is 16 px.
- `apps/desktop/ui/index.js` owns Explore/history rendering, the per-highlight history view, lists, search, settings, recycle bin, imports, and mutation dispatch. Timeline and Book clicks synchronously activate the selected pill and matching main title, then defer main-view rendering until the pill's finite, non-paused descendant transitions have settled and their final state has painted; looping decorative animations cannot stall navigation, and a newer navigation action cancels a stale render. Book paints its paper and loading state immediately, then requests every immutable daemon cursor page in sequence and yields a painted frame between pages; loading is progressive without depending on scrolling. Highlight history renders every live highlight on one compact ivory paper surface and groups entries under larger bold-italic local `yymmdd` date headings. Each appended page binds controls and starts Justif only for its new entries, so prior managed DOM and selections remain intact. Within each day it collects all highlights for the same page into one identity-based page group even when their timestamps were interleaved with another page; one shared title/site/time line precedes separate quoted entries. Sibling quotations use an 8 px gap, and shared page lines have the same 8 px whitespace before and after. Metadata, excerpts, notes, and editors share one regular Gentium Book Plus size and line height. Metadata and content share a right text edge, within-day groups use compact whitespace without dividers, and selectable prose shows a text cursor. The page title is selectable, focusable link-role text: a single click or Enter opens its URL through the desktop browser bridge, while a selection drag does not navigate. Entries with note text use a 60/40 highlight/note split, while unnoted highlights keep the full text measure and omit the empty note row. Hover or keyboard focus reveals first-line-aligned controls outside the text measure, with delete centered in the left paper rim before the quote rule and note/edit centered in the right paper rim; the row-wide rim hit target keeps them visible while moving into either margin without making metadata hover active. Starting a note immediately switches to two columns and focuses the right editor; the rendered note and contenteditable editor use the same fixed text measure so their width remains stable. The self-hosted Justif runtime applies whole-paragraph line breaking, English hyphenation, hanging punctuation, and responsive reflow to rendered excerpts and notes, preserving multi-segment source newlines as native hard breaks inside the managed paragraph. The narrower note column includes discretionary hyphenation in its first layout pass, and Justif's clipboard cleanup copies exact source text without layout-only characters. Light and dark themes use visible neutral-grey selection fills for date, page-title, metadata, excerpt, note, editor, and generated Justif text while preserving the normal ink color; only the synthetic Justif break marker remains transparent to prevent an oversized WebKit boundary highlight. Editing restores the untouched source DOM before opening the contenteditable surface. Individual excerpts use a 1 px black quote rule matching the text ink and stopping with the excerpt, and page-detail editing actions appear only while their highlight-and-note block is hovered or keyboard-focused; the note editor is a borderless contenteditable surface confirmed with the same checkmark interaction as the connector popup. Local highlight-history edits and deletes reconcile the affected entry, its possibly empty page group, and its possibly empty day section in place and consume their matching daemon note mutation as an acknowledgement, preserving scroll position and every unaffected entry; page-detail and external note mutations still trigger an authoritative refresh of dependent views. Its search filter panel supports device and page-property filters; multi-day visits are derived consistently from the page projection, and list-membership and time-range filters are not exposed. Committed-search activity is anchored to the search control as an SVG perimeter tracer calculated from rendered control dimensions and driven through the Web Animations API; theme CSS supplies a subtle colored bloom or a crisp mono stroke without changing the motion, and sidebar resizing remeasures the tracer perimeter.
- Primary destination titles retain the active Timeline/Book localization key while list and category titles clear it, so the delayed persisted-locale catalog can retranslate the selected destination without overwriting it with the static Timeline key. The render gate recognizes only the selected pill's background, shadow, and color transitions plus its icon color transition; unrelated finite, infinite, or paused descendant animations cannot delay navigation.
- Window drag-region fullscreen toggles snapshot the independently scrolling main pane and sidebar before invoking the native transition, then restore valid positions on every resize and the following paint until the transition settles.
- Desktop UI localization uses the registry in `packages/core/i18n.js`; system locale comes from the Tauri shell, while `localeOverride` persists in daemon settings. The settings selector is generated from the registry rather than maintained separately in HTML.
- `apps/desktop/ui/desktop-bridge.js` owns direct Tauri command dispatch for desktop product actions.
- `apps/desktop/ui/desktop-platform.js` exposes only the host surfaces current desktop UI code uses and fails startup if Tauri invoke/event bridges are unavailable.
- `apps/desktop/src-tauri/src/main.rs` forwards command results, change events, and storage updates into the webview. Its single-instance lifecycle forwards later Windows, Linux, and macOS protocol activations into the original process, keeps that webview warm while closed, and restores visibility/focus when the tray, Dock, or a deep link reopens it, discarding retained frames that no longer intersect a current display. Windows startup and DPI changes also install exact-size small and taskbar icons through `windows_icon.rs` instead of leaving the shell to enlarge Tauri's first ICO entry. One asynchronous start gate serializes daemon creation; an absent daemon exposes shell recovery actions but no fabricated storage authority, and its real startup path is tested against repair-and-retry recovery.

### Connector Popup

- `apps/extension/popup.js` consumes prepared bootstrap payloads when present, requests the same complete page summary on direct loads, and sends both inputs through `renderDashboardSummary`, the one owner of complete dashboard state and section rendering. It resolves private mode before entering the dashboard shell, submits popup mutations through a serialized non-dimming UI lane, refreshes current-page list metadata from committed daemon pin/list mutations through that same lane, and owns the transient list-picker/search keyboard UI. Pending toolbar and direct-load projections remain opacity-hidden; only a completed bootstrap or terminal diagnostic reveals the popup, so cold startup cannot paint a false connector error or partial page shell. Resuming recording retains the paused surface while authoritative identity resolution and awaited visit recording run, then enters the ordinary `showDashboard` load path; a visit failure renders the standard page-data diagnostic. Pending handoff settlement retains success and failure outcomes until the mutation lane settles and uses the current-page generation as the sole render-ownership decision, so failed mutations preserve current handoffs while stale rejected handoffs cannot overwrite a resume. Connector refresh fulfillment and rejection share one diagnostic owner/generation guard, so stale async results cannot replace a newer page diagnostic or dashboard. The picker opens from the per-open popup projection without another list read. Existing membership toggles rely on their command response plus mutation-stream reconciliation instead of an explicit summary reread, while new-list membership uses one `createListAndPin` command rather than two dependent round trips. Its capture and picker modes share one statically mounted input node so popup startup and native IME composition never cross a reparent or replacement boundary. `apps/extension/extension-surface.js` owns the highlight-entry markup, base CSS, icons, retryable in-place editor, per-entry edit/delete lock, and closed-shadow mark-overlay factory shared by the popup, PDF panel, live pages, and snapshot documents; each host supplies only its mutation callbacks and container document. The content script owns transient hidden-markup state so a reopened popup reflects the source page instead of resetting the label locally; popup note rendering does not depend on that receiver being available.
- Extension UI and manifest localization use browser-native WebExtension `i18n` files staged from `packages/core/locales/`; only `extension*`, `command*`, and `common*` keys are packaged. The extension follows the browser's UI locale and does not persist a product locale override.
- `apps/extension/background.js` resolves popup actions through the daemon connection and is the sole owner of tab page-identity rules. Direct popup loads and snapshot-viewer badge refreshes use the same validated reported/content/embedded/snapshot identity; a still-loading HTTP(S) tab inspects already-parsed embedded identity metadata and otherwise uses its browser-reported URL until the `document_idle` identity receiver exists. Raw `file:` snapshot inspection first checks Chrome file-scheme access and returns one localized, actionable diagnostic that opens the extension details page when **Allow access to file URLs** is disabled. Toolbar clicks open `popup.html?bootstrap=...` immediately with an ordinary connector `starting` model and current tab identity while one background task requests the popup-ready daemon projection containing access policy, display title, page data, notes, snapshots, lists, and attention. The popup keeps that initial model unpainted, then reveals the complete dashboard or exact bounded-timeout/connector diagnostic through the same one-shot in-memory token. Normal opens install a per-tab action mapping that is cleared on popup connection or token consumption; the lifecycle port bounds only the pending bootstrap entry until disconnect, and the encoded action-tab identifier lets a restarted worker clear stale browser-owned routing before a missing token falls through to direct startup. A committed daemon mutation still invalidates and rebuilds a prepared projection before final consumption. Engines without programmatic action popups fall back to the same pending extension page in a tab. Token authentication reports the freshly detected browser name and refreshes the saved identity without changing credentials. Pairing/authentication negotiate the sole connector protocol version 4 in both directions, rejecting missing or different versions before ready state. `apps/extension/connector/ws-client.js` owns the identified volatile session, five-phase connection machine, serialized request lane, and ordered outbox drain; request preparation joins pairing/authentication even before a token is cached, and snapshot preparation follows a replacement session through status synchronization. Background no longer mirrors device identity, bridge queue watermarks, or filesystem details. Test-only background RPCs are split into `apps/extension/background-test-control.js` and included only in staged test extensions.
- `apps/extension/icon-paths.js` defines packaged toolbar icon sets for normal capture, paused recording, and special page-marker states; `apps/extension/badge-controller.js` applies those icons after awaiting the background-owned tab identity resolver, and completed snapshot viewers refresh against a live connector probe.
- Desktop, popup, and connector-overlay font stacks retain their bundled or platform-specific Latin faces while placing `system-ui` before the final generic family. This keeps unsupported CJK glyphs aligned with the host OS instead of selecting a generic serif or monospace fallback; Chromium verifies the actual rendered platform font rather than only the declared CSS stack. Desktop controls and ordinary path/rule content inherit the body stack; only code and diagnostic-log content use monospace.
- `apps/extension/options-stub.js` only opens the desktop app; it is not a settings surface.

### Capture Path

- `apps/extension/content.js` captures visit/attention signals and adapts browser messages and daemon note reads to `packages/core/highlight-lifecycle.js`. The shared module prepares selections by rejecting any range intersecting an owned mark, deriving aligned strict text-anchor strings with exact block-relative UTF-16 offsets, and retaining the exact ranges for application only after persistence succeeds; light DOM uses a v1 selector and nested open shadow roots use a v2 outer-host-to-inner-block selector array. Live pages and the snapshot viewer no longer implement those decisions separately. Reapply traverses the composed selector path and verifies each excerpt at those offsets without a first-match fallback, while plain-selector strings are parsed only as the explicit legacy anchor variant. It also owns scoped reapply, recursive mark ownership, mark groups, hydration retries, and route disposal. Snapshot selection remains ordinary browser selection until the same highlight shortcut or context-menu action used by a live page explicitly activates it; `background.js` targets that command to the active viewer tab. Live content and the snapshot viewer expose equivalent Hide/Show markup adapters that dispose the active hydration watcher and unwrap or reapply marks while preserving the saved note projection, so unrelated DOM mutations do not immediately reapply hidden markup. Snapshot identity uses only `x-browser-recall-slug` and `x-browser-recall-url` metadata. Staged builds generate and load both `browser-recall-page-identity.js` and `browser-recall-highlight-lifecycle.js` before classic `content.js`, so module and content-script callers execute the same implementations.
- `apps/extension/savepage-bridge.js` performs snapshot capture through one identified per-tab session that owns capture settings, lifecycle timers, and typed resource diagnostics. Its host-permission-backed HTTP(S) fallback recovers resources that page-context fetch cannot read because of CORS, and the extension CSP explicitly permits that capture-only network path. Page and fallback fetches share streamed 50 MB enforcement in `packages/core/bounded-response.js`. `packages/core/snapshot-capture-budget.js`, exposed to nested connector code through `apps/extension/snapshot-capture-budget.js`, derives a JSON-encoded HTML budget from the daemon's exact message limit after `apps/extension/connector/ws-client.js` completes the authenticated socket's status round trip, estimates embedded expansion, and supplies the generated `browser-recall-snapshot-capture-budget.js` classic-script runtime. After frame replies arrive, the vendored content script measures one resource-free serializer pass, reserves that complete nested-frame/shadow structure plus mutation overhead, then schedules six resource reads and provisionally shares the remaining aggregate allowance across them; missing generated runtimes and final over-budget output are explicit errors. The all-frame injection installs `browser-build-target.js` and `browser-api.js` alongside the frame serializer so `srcdoc` and other retained child frames use the same context-safe capability contract even when manifest content-script matching does not initialize them. Content-script notification hosts are registered in an isolated-world `WeakSet`; both serializers omit only those exact extension-owned nodes. `apps/extension/background.js` applies the pure `packages/core/snapshot-html.js` boundary when storing and serving captures. The persistence boundary replaces identity metadata with one authoritative pair, while the read boundary validates the current pair without repairing identity. Completed raw `file:` snapshots use strict scripting inspection; disabled browser file-URL access produces the popup's explicit extension-settings diagnostic. `scripts/migrate-snapshot-identity.mjs` verifies the authoritative URL-to-slug relationship and upgrades every older stored HTML file before the runtime uses the current format; there is no filename or obsolete-marker compatibility reader. `savepage/content-frame.js` serializes live shadow roots before cross-origin frame transfer, and `apps/extension/snapshot-viewer.js` recursively prepares nested frame documents across template contents and attached shadow roots while archived scripts remain blocked.
- `apps/extension/background.js` buffers and forwards capture events to the daemon, and injects a page reload warning when shortcut/context-menu actions cannot reach a stale content script.
- `apps/extension/popup.js` surfaces popup-initiated capture failures through page notifications with popup-bubble fallback.

### Replay and Storage

- `crates/daemon/src/config.rs` owns locked read-modify-write configuration
  transactions and atomic JSON replacement. Desktop shell settings, daemon
  connector activity/pairing, and sync state mutate only their own fields through
  `ConfigStore::update`; WebSocket handling has no duplicate configuration cache.
- `crates/replay/` is the production replay engine and owns replay-derived checkpoint policy used by verification and daemon persistence. Its visit replay caps transient page-to-page relationships independently of durable list/note/snapshot relationships so referrer churn cannot evict checkpoint-retaining user state.
- `packages/core/page-identity.js` canonicalizes extension-originated page URLs before they are sent to desktop, removes underscore-prefixed query params while keeping ordinary query params and fragments, and classifies same-document navigation for both background and content-script callers. Optional non-page referrers are omitted at the connector boundary. `packages/core/utils.js` and the generated content-script bridge use that shared implementation. `packages/core/markdown-extractor.js` similarly owns live-DOM Markdown conversion and its generated classic bridge, so capture and tests exercise one implementation. `crates/replay/src/lib.rs` hashes the URL it receives with a native Rust implementation; non-extension producers must send canonical URLs, and `tests/integration/page-identity-parity.test.js` differentially checks both implementations over a deterministic generated corpus.
- `crates/daemon/src/storage.rs` owns coordinated cache-miss reads, filesystem primitives, the current projection cache, synchronous log append, history file/device-directory listing, the ordered async checkpoint worker, replay-progress files, and the current `logs/`, `objects/`, `views/` path layout.
- `crates/daemon/src/command_authority.rs` is the shared semantic mutation interface used by the in-process Tauri adapter and authenticated WebSocket adapter. It owns the supported action set, validation, response formation, and post-commit mutation meaning, including affected URL sets used by connector surfaces; note-pin commands derive that URL from the authoritative note when the request has no page URL. Mutation payload construction is shared with replay notification paths through `crates/daemon/src/mutations.rs`. Native shell actions and connector observations remain adapter-specific. Extension command handlers consume this notification stream instead of reclassifying mutations or directly refreshing product badges.
- `crates/daemon/src/commands.rs` implements replay-backed reads and mutations behind daemon interfaces, constructs strict replay entries, and keeps command-only fields out of JSONL.
- `crates/replay/src/settings.rs` is the only product-settings schema. Replay validates every `update_setting` key/value, while startup, destructive reset, command writes, projections, capture policy, and sync consume the same contract and reject unknown, partial, or mistyped settings instead of supplying consumer-local defaults.
- `crates/replay/src/entities.rs` defines the one checkpoint schema. List `slug`, `name`, and `owner` are required non-empty strings; an ownerless or blank-identity list is invalid data rather than a request to infer ownership from the current device.
- `crates/daemon/src/rules.rs` is the sole rule validation, preview, and automatic-matching implementation; desktop keyword and function previews both call this native module through daemon commands, and automatic matching preserves an observation's explicit-nullable title.
- `crates/daemon/src/read_projections.rs` owns workflow joins and visibility policy for deep read interfaces. It supplies list display, page/search context, all-page filter context, creation-ordered live highlight history, page info/snapshots, list trees, recycle-bin entries, compact popup list membership (`containsPage` plus `lastActivity`), and settings through coordinated cache/disk reads. Highlight creation time comes from canonical `create_note` records and is resolved across `replace_note` chains without relying on cross-device timestamp order; concurrent replacements of one predecessor remain separate live branches. Highlight-history pagination keeps a small bounded set of immutable logical-highlight indexes and resolves only each requested page's note/page entities, so page one does not read or retain the complete projection. Tauri and WebSocket adapters translate these results without leaking entity-key construction or raw popup pin collections into product callers.
- `crates/daemon/src/command_authority.rs` deserializes shared mutations once through a closed tagged enum and returns the committed response with mutation notifications. Typed note/list inputs flow into `commands.rs`; those implementations do not inspect the transport JSON again.
- `crates/daemon/src/storage.rs` uses one internal log catalog for replay recovery, history enumeration/loading, highlight chronology, and sync collection. The catalog selects owned device directories and dated JSONL files, ignores entries outside that namespace, and strictly validates selected filenames and records. Highlight chronology parsing is cached separately and invalidated only when note logs or coordinated storage replacement can change it, so ordinary visit traffic does not force another full JSONL parse.
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

- `crates/daemon/src/ws_server.rs` owns paired-browser websocket sessions, accepts Orion pairing identity, refreshes persisted last-seen timestamps on authenticated activity, and removes socket registrations after normal closure, transport errors, or caught panics. Its snapshot stores one typed running/paused authority and the full connected-connector identities; it does not maintain duplicate status/error or browser-name projections.
- `apps/desktop/ui/index.js` refreshes the paired-browser list in an open Settings view when the Tauri shell receives a daemon snapshot update, without replacing the user's preference controls.
- `apps/extension/connector/pairing.js` and `apps/extension/connector/ws-client.js` manage the browser side. Pairing sends platform-observed identity and an explicit-null `browserProfile`; no synthetic profile is persisted. Authentication enters `synchronizing`; a successful strict status round trip and initial FIFO outbox drain are required before ready state is published. Queue counts remain extension-local, and malformed daemon frames close the current session with a persisted diagnostic. Successful daemon responses and connector mutation entries are shape-checked before queue acknowledgement or UI delivery.
- `apps/desktop/src-tauri/src/main.rs` rebroadcasts the daemon's rich internal change notifications to desktop webviews. Websocket subscribers receive the narrower connector notification containing only `type`, `url`, and `urls`.
- Authenticated connector sockets also receive daemon change notifications for live connector surfaces such as tab badges and open-popup list membership.

### Sync

- `crates/daemon/src/sync.rs` owns GitHub sync orchestration, auth/token handling, persisted sync pause state, typed GitHub branch/tree response decoding, and strict downloaded JSONL parsing before runtime installation.
- `apps/desktop/ui/index.js` edits sync settings and renders sync status.
- Connector websocket RPCs do not expose sync file or manifest operations.

## User Documentation

- `README.md` introduces Browser Recall through feature demonstrations and real
  screenshots; `docs/STORE_LISTING.md` contains the Chrome Web Store copy.
- `scripts/capture-documentation.mjs` builds and captures an isolated native
  macOS app. `scripts/lib/documentation-seed.mjs` owns fictional reading data;
  `scripts/lib/documentation-window.swift` navigates native accessible controls
  and captures the actual window. Timeline is captured in Amber and Mono;
  Book is captured in Amber at a shorter window height.
  `scripts/compose-documentation-hero.mjs` combines the aligned Timeline
  sources with a diagonal slash for the opening README image. `docs/images/`
  holds the native sources, combined image, and capture manifest.
- `scripts/lib/documentation-freshness.mjs` owns the desktop/browser source-file
  fingerprint scopes recorded by capture. `scripts/check-documentation-screenshots.mjs`
  checks fingerprints, PNG inventory/hashes/dimensions, diagonal composition
  provenance, and the four README image references through `ci:check-docs` in
  local CI and after hosted native generation. The `documentation-screenshots`
  job runs `ci:generate-docs`, uploads pull-request images, and publishes refreshed
  `docs/images/` on main. The Linux unit job checks committed image integrity.
  `tests/integration/documentation-freshness.test.js`
  exercises the checker CLI against disposable source and image mutations.
- `tests/e2e/manual-seed-workflow.spec.js` checks the documentation collection's
  lists, highlights, and complete settings through the real daemon and connector.
- `scripts/capture-browser-documentation.mjs` runs
  `tests/e2e/documentation-browser.spec.js` to capture the production extension's
  popup and live note editor against the real daemon. Documentation export
  captures two native 800 × 434-point browser-window images in English: the toolbar popup over
  an unmarked article, then the note editor beneath a newly created highlight.
  The scenario verifies English labels, the clean popup state, and note
  persistence before exporting images and `docs/images/browser-capture.json`.
  Ordinary E2E runs keep the two content captures headless.

## Current Test Coverage

| Path | Coverage |
|------|----------|
| `tests/unit/` | Shared JS helpers, rule helpers, charts, scrollers, and connector-side utilities |
| `tests/integration/popup-rpc.test.js` | Popup ↔ daemon RPC integration |
| `tests/integration/pairing.test.js` | Browser pairing flow |
| `tests/integration/event-flow.test.js` | Connector event flow into the daemon |
| `tests/integration/page-identity-parity.test.js` | Deterministic cross-language property coverage for JavaScript canonical identity, Rust replay identity, and optional non-page referrer filtering |
| `crates/daemon/tests/read_projections.rs` | Daemon list/page/highlight-history projection coverage, including original creation order across replacement and cross-device clock skew, non-empty page/note pins, deleted visibility, explicit missing targets, and cache-miss-to-disk reads |
| `tests/e2e/popup-lists.spec.js` | Popup list interactions in the shipped connector, including persistent stale-receiver delivery faults across bootstrap refresh and recovery, the `Alt+R` popup command, pre-existing membership, and toolbar icon state for query-bearing HN-shaped URLs |
| `tests/smoke/native-extension-shortcut.mjs` | Opt-in macOS headed-Chromium smoke that sends native Option+R and observes the real action popup |
| `tests/smoke/firefox-real-content.mjs` | Opt-in real-Firefox smoke that loads the staged add-on and verifies its content-context adapter contract |
| `tests/e2e/badge.spec.js` | Popup/badge behavior in the shipped connector |
| `tests/e2e/extension-error-popouts.spec.js` | Browser-level extension popup and snapshot error popout styling |
| `tests/e2e/extension-font-fallback.spec.js` | Distinct-glyph prerequisite and Chromium platform-font verification that popup and shadow-overlay CJK glyphs actually render with the same host font as a `system-ui` control; the Windows CI job requires this behavior rather than skipping it |
| `tests/e2e/snapshot-resource-timeout.spec.js` | Snapshot open/closed shadow-root capture and replay, resource body timeouts, cross-origin CSS/image recovery through redirects, per-hop referrer restrictions and redirect-loop limits, offline vendor-prefixed image-set rendering, temporary-rule isolation/cleanup, persisted viewer paint, partial-capture warnings, and deactivation of timed-out stylesheet links through the real connector/daemon path |
| `tests/integration/snapshot-resource-limits.test.js` | Streamed per-resource byte limits with missing or oversized `Content-Length`, including the generated classic-script interface |
| `tests/e2e/seeded-combination-workflows.spec.js` | Seeded randomized extension workflow combining visits, notes, list pins, and popup reads |
| `tests/e2e/manual-seed-workflow.spec.js` | Real daemon/connector regression coverage for the manual seeded-data helper, including valid current settings and post-seed queue flush |
| `tests/e2e/extension-navigation-regressions.spec.js` | Browser navigation coverage for ordinary and History-wrapper-bypassing transitions, failed delivery recovery, delayed YouTube metadata through the popup, new-tab referrers, page summaries, and highlight lifecycle behavior |
| `tests/e2e/highlight-note-edit.spec.js` | Canonical extension CI coverage for live highlight titles, editing and reapply, plus PDF panel failure/retry and committed replacement identity |
| `tests/e2e/note-dismiss-save.spec.js` | Daemon-backed save-on-dismiss coverage for webpage overlays, popup destruction, concurrent drafts, deletion/dismissal races, offline popup handoff and reconnect delivery, and retryable PDF panel closure |
| `tests/e2e/desktop-locale-setting.spec.js` | Registry-complete desktop locale workflow through the real connector, daemon, settings checkpoints, UI reloads, invalid-override reporting, and RTL verification |
| `tests/e2e/extension-localization.spec.js` | Browser-native WebExtension catalog selection using the packaged extension and the browser-reported UI locale |
| `tests/smoke/macos-wkwebview-chart-layout.{mjs,swift}` | Native WKWebView regression probe for the first-selection chart-to-list spacing shift that Playwright WebKit does not reproduce |
| `tests/smoke/macos-desktop-window-lifecycle.mjs` | Ephemeral-session signed-app smoke test proving startup errors remain painted, repaired storage survives a native relaunch, and an accessible tray menu survives repeated close/reopen, focus, and frame preservation; CI runs it on a disposable macOS 26 runner |
| `tests/smoke/desktop-startup-paint.mjs` | Shared bounded bitmap paint check used by the isolated native lifecycle smoke and delayed/blank-frame Playwright regression; native failure evidence survives temporary-app cleanup |
| `tests/smoke/windows-desktop-single-instance.mjs` | Disposable-profile native Windows smoke test proving every generated ICO representation is embedded pixel-for-pixel, the live HWND exposes DPI-sized small and taskbar icons, and a second executable/deep-link activation exits and forwards the settings route into the original desktop process without changing product data or OS registrations |
| `tests/smoke/windows-desktop-process.mjs` | Complete teardown with aggregated errors, process-tree termination, exit observation, and asynchronous profile removal with observable bounded lock retries |
| `tests/integration/windows-desktop-cleanup.test.js` | Teardown failure preservation, real child-process exit and read-only-file cleanup; Windows-only descendant termination and exclusive-lock release after an observed failed removal |
| `scripts/test-coverage-monitor.mjs` | Test-suite LoC mix and JS/Rust uncovered production line reporting |
| `crates/daemon/tests/commands.rs` | Desktop command-surface coverage |
| `crates/daemon/tests/command_authority.rs` | Shared semantic command response, validation, committed state, and mutation outcome coverage |
| `crates/daemon/tests/runtime.rs` | Replay transaction coverage for canonical local append, downloaded remote-file installation without duplicate log writes, and explicit projection-load failures |
| `crates/daemon/tests/sync_controller.rs` | Daemon sync-controller coverage |
| `crates/replay/tests/replay_verify.rs` | Production verifier coverage for selecting owned log namespace entries while ignoring unrelated filesystem files |

## Remaining Intentional Gap

A full desktop GUI parity suite is still intentionally absent. Focused native
smoke tests cover macOS close/tray-reopen behavior and Windows single-instance
deep-link forwarding; desktop visual behavior remains covered separately in
Chromium.
