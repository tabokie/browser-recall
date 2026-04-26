# 31 — Desktop Split, Phase 1: Shell + Protocol

> Part of [29-desktop-split-master.md](./29-desktop-split-master.md). After [30-phase-0](./30-desktop-phase-0-repo-reshape.md).

## Goal

Land the Tauri shell, tray + login item, WebSocket server with token auth and Origin checks, click-to-approve pairing, and a connector-extension stub that successfully pairs and holds a connection. **No data flows yet.**

This phase proves the hardest decisions (Q3 IPC, Q5 lifecycle, Q6 pairing) before any porting work. If pairing doesn't work cleanly, none of Phase 2 matters.

## Components

### `apps/desktop/` — Tauri shell

```
apps/desktop/
  src-tauri/                  # Rust side
    src/
      main.rs                 # Tauri entry, window/tray setup
      ws_server.rs            # WebSocket server bound to 127.0.0.1
      pairing.rs              # Pairing handshake + approval dialog
      config.rs               # Read/write daemon config (token registry, port, data folder)
      login_item.rs           # Platform-specific login-item registration
    Cargo.toml
    tauri.conf.json           # Window config, tray, allowlist
  ui/                         # Webview HTML/JS — empty placeholder this phase
    index.html                # "Browser Recall — connecting..." status only
  package.json
```

### `crates/daemon/` — pulled in as a dependency

`crates/daemon/` is the long-running service logic. In Phase 1 it's nearly empty — just the WebSocket server and pairing. Phase 2 fills it.

### `packages/protocol/` — wire format

```
packages/protocol/
  src/
    messages.js               # JSDoc-typed message constructors + parsers
    schema.json               # Authoritative schema (referenced by both JS and Rust tests)
  test/
    conformance.test.js       # ~20 canonical messages, expected parse results
  package.json
```

Mirror this in Rust under `crates/daemon/src/protocol.rs` — same schema, generated structs (or hand-written, given small surface in Phase 1).

### `apps/extension/` — connector stub

The existing extension code stays put for now. Add:

- `apps/extension/connector/ws-client.js` — WebSocket client with reconnect, token persistence in `chrome.storage.local`.
- `apps/extension/connector/pairing.js` — first-run pairing flow.

The connector code runs automatically on extension load: if a daemon is reachable, it pairs. If not, it stays silent (no UI surface, no error). The existing FS-Access path continues to work in parallel; Phase 2 removes it. No dev toggle needed.

## Protocol surface for Phase 1

Only enough to pair and stay alive. Full event/RPC surface is defined in Phase 2/3.

```
// Connector → Daemon
{ type: "pair_request", browserId: string, browserName: string, extensionId: string }
{ type: "auth", token: string }
{ type: "ping" }

// Daemon → Connector
{ type: "pair_pending", requestId: string }     // shown in approval dialog
{ type: "pair_approved", token: string, deviceId: string }
{ type: "pair_denied" }
{ type: "auth_ok" }
{ type: "auth_fail", reason: string }
{ type: "pong" }
```

## Pairing flow

1. Connector starts, no token cached. Opens WebSocket to `ws://127.0.0.1:28471` (probes 28471, 28472, 28473 if needed).
2. Daemon accepts the connection. Origin check: extension origins (`chrome-extension://...`) allowed; webpage origins (`http://...`, `https://...`) rejected with HTTP 403 before WebSocket upgrade.
3. Connector sends `pair_request` with browser name + extension ID.
4. Daemon parks the connection in pending state, raises a native dialog in the desktop UI:

   > **Allow connection?**
   > Browser: Chrome (extension ID: `abcdefghi…`)
   > [Allow] [Deny]

5. On Allow: daemon mints a 32-byte random token, persists `{browserId, extensionId, token, approvedAt}` in its config, sends `pair_approved` with token + device ID.
6. Connector persists `{port, token}` in `chrome.storage.local`, holds connection open.
7. On Deny or 60s timeout: `pair_denied`, connection dropped.

For subsequent connections (cached token):

1. Connector opens WebSocket, sends `auth` with cached token.
2. Daemon validates token against config. `auth_ok` or `auth_fail`.
3. On `auth_fail`: extension clears cached token, falls through to fresh pairing.

## Lifecycle

- **First daemon launch:** prompt for data folder location (default `~/portal-data` if exists, else `~/Documents/Browser Recall`). Prompt for login-item enrollment. Both consents explicit.
- **Steady state:** daemon runs in tray. Closing main window hides to tray, doesn't quit. Quit only from tray menu.
- **Crash policy:** panics in async tasks log via `tracing` and the task is dropped. Repeated panics in core tasks (drain, sync) trigger `ServiceState::Paused` so the user sees the failure rather than a silent broken daemon.

## URL scheme registration

Register `browser-recall://` with the OS via Tauri's `deep-link` plugin (`tauri-plugin-deep-link`):

- Handler opens the main window and routes the path (`browser-recall://open`, `browser-recall://page/<slug>`, etc.).
- Used by the popup's "Open in app" button in Phase 3.
- macOS: registered via `CFBundleURLTypes` in `Info.plist` (Tauri bundler handles).
- Windows: registry entry under `HKCU\Software\Classes\browser-recall\shell\open\command` (Tauri bundler handles).
- Linux: `.desktop` file with `MimeType=x-scheme-handler/browser-recall` (for later when Linux ships).

## Daemon logging

Use the `tracing` crate with `tracing-appender` for file output:

- Log dir: `~/Library/Logs/browser-recall/` (mac), `%LOCALAPPDATA%\browser-recall\logs\` (win).
- Daily rotation, 7-day retention.
- Default level `info`; user-toggleable to `debug` via settings.
- Token values **never** logged — add a custom `Debug` impl for the token type that renders as `<redacted>`.
- "View logs" menu item in the tray opens the log dir in the OS file manager.

## Tray menu (minimum)

- Open Browser Recall
- Status: ● Running / ◌ Connecting / ✕ Error
- Settings…
- Quit Browser Recall

(Per-browser submenu deferred to Phase 3 where the Settings UI lists paired browsers with revoke buttons.)

## Tests

- **`packages/protocol/test/conformance.test.js`** — round-trip every Phase 1 message; assert parse result matches expectation.
- **`crates/daemon/tests/pairing.rs`** — Rust integration test: spawn server, connect WebSocket client, run full pairing handshake, assert token persisted to config dir.
- **`tests/integration/pairing.test.js`** — Node WebSocket client acts as extension, runs against built daemon binary in a tempdir. Covers: fresh pair, deny, cached-token auth, expired-token rejection, port collision fallback.

No browser tests in this phase.

## End state

- `npm run dev:desktop` launches Tauri shell, tray icon appears, main window shows "Waiting for browser connection."
- Loading the connector extension into Chrome and clicking "Pair with desktop" triggers the approval dialog in the daemon. Approving updates the main window: "Connected: Chrome."
- Killing the daemon, restarting it, observing the extension reconnects automatically using the cached token.
- All Phase 1 tests pass.

## Risks

- **macOS WebKit may have WebSocket quirks** that don't show up in Chrome-based testing. Smoke-test the daemon's UI WebSocket consumption (when added in Phase 3) early.
- **Login-item APIs are platform-specific.** Lock to macOS 13+ for `SMAppService.mainApp`; document the minimum macOS version in the README. Don't carry legacy `LSSharedFileList` support.
- **Windows firewall prompt on first listen.** Tauri's installer should request the permission upfront, but test on a clean Windows VM to confirm.
- **Token leakage in logs.** The token type carries a custom `Debug` impl that renders `<redacted>`; that is the protection. (No log-grepping test — relies on the type system, not on output inspection.)
