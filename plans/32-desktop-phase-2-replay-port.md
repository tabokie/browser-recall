# 32 — Desktop Split, Phase 2: Event Ingest + Replay Port

> Part of [29-desktop-split-master.md](./29-desktop-split-master.md). After [31-phase-1](./31-desktop-phase-1-shell-protocol.md).

## Goal

Make events flow extension → daemon → `~/browser-data`. The daemon owns FS, replay, and entity persistence. The extension stops using File System Access entirely. **No UI port yet** — verify via filesystem inspection and a small status endpoint.

This phase ports `effectOf` to Rust, ports its tests, builds the Rust filesystem layer, and rewires the extension as a thin event-streaming connector with `chrome.storage.local` buffering.

## The big sub-project: `effectOf` in Rust

### Source material

- `apps/extension/replay.js` — 1160 lines, 30 handler functions, single dispatch via `effectOf(entry, load, context)`.
- `tests/unit/replay.test.js` — 1471 lines, exercises every branch with idempotency assertions.

### Target

- `crates/replay/src/lib.rs` — public `effect_of(entry: LogEntry, load: impl Fn(&str) -> Future<Option<Entity>>, context: Context) -> Result<EntityMap>`.
- `crates/replay/src/entities.rs` — serde-typed entity structs (Page, Note, Snapshot, List, Settings, three manifest variants).
- `crates/replay/src/handlers/` — one file per action group (visits, notes, snapshots, lists, rules, settings).
- `crates/replay/tests/` — port of `replay.test.js` to Rust integration tests.

### Approach

- Port handler-by-handler. Each handler ports → its corresponding tests port → tests pass → next handler.
- Keep the JS implementation in the repo (under `packages/core/legacy-replay/`) until the Rust version is at parity. Optional bonus: a conformance harness that runs the same entry through both and diffs the result.
- Use `serde_json::Value` only at the WebSocket boundary; convert to typed structs inside the handler. Type safety is the point.
- LWW timestamp semantics, idempotency, tree manipulation: all directly translatable.

### Estimate

~2 weeks for a focused port + test port. Existing tests are the safety net.

## Daemon FS layer

`crates/daemon/src/storage.rs` (or its own crate `crates/storage/` if it grows):

- Mirrors `extension/filesystem-storage.js` API — `load_page`, `save_page`, `load_settings`, etc. — but in Rust on `tokio::fs`.
- No permission gymnastics. No File System Access API. Just paths.
- Entity cache: `parking_lot::RwLock<LruCache<String, Entity>>`. No watermark eviction (no `chrome.storage.session` quota to respect). Default 5000 entries; tune if profiling demands.
- No per-file locks needed: the drain pipeline is sequential, and sync writes to different paths (sync state) than entity writes. Single-writer property collapses the offscreen-era locking concern.
- Append to JSONL log dir: `data/logs/<device>/<YYYY-MM-DD>.jsonl`. Single writer, no contention.

## Drain pipeline

```
WebSocket message (LogEntry)
    ↓
validate_entry (origin, schema, source field present)
    ↓
appendLog → in-memory logBuffer (ordered)
    ↓
drain task (async loop, debounced): for each entry in buffer
    ↓
effect_of(entry, |key| load_entity(key), context)
    ↓
write dirty entities to disk (via storage.rs)
    ↓
append entry to JSONL
    ↓
broadcast change notification to all connected webviews
```

The shape mirrors `offscreen.js` drain logic, but in Rust with no port-channel boundary. Cross-entity effects are inside `effect_of` per existing design — no scope/apply split.

## Extension changes

Replace the offscreen + FS-Access path with the WebSocket path:

- `apps/extension/background.js`:
  - Delete: offscreen document, port channel, hydrateCache, all FS-Access code paths.
  - Keep: visit/leave detection, content script injection, capture orchestration, command handling.
  - Add: `connector/event-buffer.js` — buffer entries in `chrome.storage.local`, drain over WebSocket when connected.
  - Add: connector wraps `addLog(entry)` and routes to buffer. Buffer drains FIFO when WebSocket is connected.
- `apps/extension/connector/event-buffer.js`:
  - `enqueue(entry)` — push to buffer; trigger drain if connected.
  - `drain()` — send entries in order; daemon acks with last-persisted timestamp; entries are removed from buffer only after ack.
  - `bufferStats()` — surfaced to popup as "X events pending."
  - Storage budget: 8MB cap (leaves headroom under the 10MB limit). On overflow: enter refuse mode per decision 4 (stop all capture, popup banner). On drain, exit refuse mode automatically.
- Adopt-in-place migration runs on the daemon side (Phase 2 includes the daemon-side migration logic from Q10).

## Migration

**Scope**: the connector extension has no published-user population. Adopt-in-place primarily serves the developer's own `~/browser-data` folder and any pre-1.0 beta testers. Don't over-engineer the migration UX — it's a developer-grade convenience, not a product flow.

- On first daemon launch in this phase, the user explicitly chooses the data folder; no path is selected implicitly.
- Read existing `data/logs/<device>/CURRENT` to preserve device ID — same device, no ghost peers in sync.
- No schema migration needed. The on-disk shape is already what the daemon expects.

### Device-ID safety on shared / synced folders

Edge case: a user enables Syncthing (or similar) on their data folder, installs the daemon on a second machine pointing at the same synced folder. Both machines would otherwise share a device ID and corrupt sync semantics.

Mitigation:

- `CURRENT` file gains a `hostname` field alongside the device ID. Daemon writes this on every startup adopt.
- On daemon adopt, if the stored hostname differs from the current machine's hostname, prompt:

  > This data folder was last used on `othermachine`. Is this the same machine?
  > - **Same machine, continue** — reuse existing device ID (user changed hostname).
  > - **New machine, fork ID** — generate a new device ID, keep existing data readable for sync.

- Default selection: "Same machine" (conservative — avoids accidental device-ID proliferation).
- Hostname lookup uses `hostname::get()`; falls back to "unknown" on failure without blocking startup.

## Function rules in the daemon

Current: function rules (user-written JS predicates on page data) evaluate in `fn-rule-sandbox.html` via `new Function(src)(pageData)`, enabled by manifest sandbox CSP. The sandbox page goes away with the extension.

Daemon-side strategy: embed **rquickjs** (Rust binding to QuickJS) for rule eval.

- Dependency: `rquickjs = "0.6"` in `crates/daemon`. Adds ~600KB to the binary.
- Rule eval runs synchronously during `effectOf` at event ingest time (function rules tag pages — must complete before persistence).
- Sandbox guards: per the existing `validateFnRuleSource()` 16-banned-globals list + 10KB source cap, same checks as today. Rule runtime gets a fresh context per call; no module system; no async; no I/O bindings.
- Execution timeout: 50ms per rule (QuickJS interrupt handler); exceeding logs a warning and returns `false`.
- Error policy: any rule runtime error returns `false` and logs; rule failures never fail the event ingest.

Alternatives considered and rejected:
- **deno_core / V8**: ~40MB binary hit, overkill for predicate eval.
- **boa**: pure Rust, slower and less battle-tested than QuickJS; revisit if rquickjs has vendoring issues.
- **UI webview eval**: requires the window to be open at event-ingest time, which is not guaranteed. Rejected.
- **Drop function rules for a constrained DSL**: contradicts decision 15 (full parity).

## Snapshot transport over WebSocket

Snapshots are multi-MB HTML blobs (Save Page WE captures with embedded data URIs).

- Wire format: **one JSON message per snapshot**, shape:
  ```
  { type: "snapshot", slug, ts, html: "<!doctype html>...", meta: {...} }
  ```
  HTML as a UTF-8 string in the JSON payload. No chunking.
- WebSocket frame limit: configure `tungstenite` `max_message_size` to 16MB (default is 64MB; we cap lower to bound memory).
- Connector budget: a single buffered snapshot can approach the WebSocket frame limit, so the connector's 8MB `chrome.storage.local` cap tracks snapshot sizes strictly. On overflow, the snapshot is **deferred** (see below), not chunked.
- Daemon receiving a snapshot: parse JSON, persist HTML to `data/snapshots/<slug>-<ts>/index.html` per existing layout, ack to connector. No streaming.

When the buffer is near full, the connector enters **refuse mode** per decision 4: visits and snapshots both stop being captured; popup shows "Browser Recall offline — buffer full." On drain (daemon reconnects and buffer empties), refuse mode exits automatically. Users who wanted to snapshot a specific page during the outage retry manually once the banner clears. No separate deferred-snapshot tracking.

## `crates/search` refactor

Drop the WASM target entirely. The daemon links the crate natively; the extension no longer loads WASM.

- Remove `wasm-bindgen` annotations from `src/lib.rs`; replace with plain `pub fn`.
- Remove `wasm-bindgen`, `js-sys`, `web-sys` from `Cargo.toml`. Keep `serde`, `serde_json` for JSONL parsing.
- Remove `wasm32-unknown-unknown` from CI's build matrix.
- Remove `apps/extension/pkg/` (WASM artifacts). Delete the vendored wasm loader.
- Update `crates/search/Cargo.toml` to `crate-type = ["rlib"]` only.
- Search API becomes plain Rust: `fn search_batch(&self, query: &str, limit: usize) -> Vec<SearchResult>`. Daemon wraps these in Tauri commands.

## Daemon `ServiceState` (the `pauseService` equivalent)

Mirrors the current `pauseService(code, message)` / `resumeService()` pattern in Rust.

```rust
enum ServiceState {
    Running,
    Paused { code: ErrorCode, message: String },
}

enum ErrorCode {
    FsError,       // disk full, permission denied, corruption
    SyncError,     // unrecoverable sync state
    ReplayError,   // effect_of panic'd repeatedly on a single entry
    ManualPause,   // user-requested via settings
}
```

- Single `Arc<RwLock<ServiceState>>` in the daemon; all mutation paths (`appendLog`, drain, sync push/pull) check state before proceeding, return early if paused.
- Desktop UI (in-process webview) reads state directly via Tauri events — no WebSocket round-trip needed.
- Tray icon reflects state: filled (Running), outlined (Connecting / no browsers), error badge (Paused).
- **Connector discovers pause state reactively, not proactively.** When the daemon is paused, incoming event messages from the connector are rejected with `{ error: "paused", code, message }` in the response. Connector shows the error in the popup banner (same code → message mapping as today's `ERROR_CODE_MESSAGES`). No broadcast channel, no server-initiated push for this.
- Popup refresh: popup sends a lightweight `ping` or `getPageSummary` on open; if the response is an error, banner updates from that. Stale "running" display between opens is acceptable.
- Resume: user action from settings panel, or automatic on FS/sync recovery after a cool-off period.

## Daemon logging

Use `tracing` + `tracing-appender` (already added in Phase 1). Ensure:

- No log line ever contains the WebSocket token (custom `Debug` impl redacts it).
- Log levels: error/warn/info/debug/trace. Default `info`.
- User-toggleable via settings (writes daemon config; takes effect on restart).
- Log rotation: daily files, 7-day retention.

## Tests

- **Rust unit tests in `crates/replay/`** — port of every test case in `replay.test.js`. Same test names. Same assertions.
- **`crates/daemon/tests/storage.rs`** — round-trip every entity type to disk. Concurrent write safety.
- **`crates/daemon/tests/drain.rs`** — feed a sequence of entries, assert disk state matches expected.
- **`tests/integration/event-flow.test.js`** — Node WebSocket client (no browser) sends a stream of canonical events; assert daemon writes the correct files. Covers the full pipeline end-to-end without a browser.
- **`tests/integration/buffer-and-flush.test.js`** — kill the daemon, queue events in extension, restart daemon, assert events drain in order and entity state is correct.
- Smoke test in a real Chrome with the connector enabled: visit some pages, observe `~/browser-data/data/logs/.../*.jsonl` and `~/browser-data/pages/*.json` populating.

## End state

- Real browsing in real Chrome with the connector extension produces real files in `~/browser-data` via the new path.
- Brave-on-mac repro: same flow, no `fs_permission` error, no offscreen lifecycle to break.
- The daemon survives killing and restarting the browser; reconnection drains the buffer cleanly.
- All Rust replay tests pass. Coverage matches the legacy JS suite.
- Status endpoint (`GET /status` over WebSocket or HTTP) returns `{connectedBrowsers, bufferDepth, lastDrainedAt, dataFolder, deviceId}` for diagnosis.

## Risks

- **Replay edge cases.** Idempotency, LWW timestamps, tree reconciliation — these are subtle. The 1471-line test suite is your safety net; if a test fails, fix the code, don't loosen the test.
- **Schema drift between JS connector and Rust daemon.** Mitigated by `packages/protocol/` conformance tests run on both sides.
- **Buffer ordering across reconnect.** Drain must be strictly FIFO. Test this explicitly under contention.
- **Snapshot size.** A few-MB HTML capture in `chrome.storage.local` chews through the 10MB quota fast. Confirm the 5-snapshot ceiling holds in practice; lower it if needed.
- **Dev-folder migration on the daemon's side.** The owner of this phase needs to test against their own real `~/browser-data` to confirm adopt-in-place works without surprises.
