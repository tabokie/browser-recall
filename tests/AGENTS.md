# Tests — Agent Guide

## Running Tests

- **Unit tests**: `npm test` (vitest). Config: `vitest.config.js`, files: `tests/**/*.test.js`.
- **E2E tests**: `npx playwright test`. Config: `playwright.config.js`, files: `tests/e2e/*.spec.js`. Single worker, chromium channel, 30s per-test timeout.
- **Coverage monitor**: `npm run coverage:monitor` reports uncovered JS and Rust production line ranges plus test LoC by suite type, and fails if JS or inline Rust unit-test LoC grows above the current baseline. `npm run coverage` first generates Vitest V8 line data for the stable unit/protocol subset and Rust llvm-cov data for the workspace.
- The two suites are independent — run either without the other.

## Test Investment Policy

- Prefer Playwright E2E for desktop UI, extension UI, connector, daemon command, and user workflow behavior.
- Use Rust daemon integration tests for daemon authority behavior that is impractical or too indirect to assert through browser E2E; keep them at the command/WebSocket/storage boundary instead of expanding inline unit tests.
- Add new unit tests only for behavior that is impractical to cover in E2E or for narrow architecture invariants such as replay idempotence, strict protocol validation, deterministic helpers, or serialization contracts.
- When feasible, replace brittle or low-signal unit coverage with E2E coverage instead of expanding the unit suite.
- E2E scenarios should cover combinations of features, not just individual controls. Use seeded randomized input for names, titles, URLs, timestamps, list structures, note text, and navigation sequences when that can reveal ordering/state bugs.
- Randomized E2E must be reproducible: derive data from an explicit seed and include the seed in failure output or test title.
- For every escaped bug, add the missing E2E coverage first, then fix the product behavior.
- Treat coverage output as a triage map. The question is which uncovered lines correspond to valuable user scenarios or risky state combinations, not whether a percentage went up; prefer closing meaningful gaps with E2E coverage.

## E2E Infrastructure

### Fixtures (`tests/e2e/fixtures.js`)

Worker-scoped: `daemon` (real Rust daemon process started before the browser), `extContext` (persistent browser context with the production extension loaded), `extensionId`, `setupDir` (daemon data directory path after the connector is fully paired).

### Helpers (`tests/e2e/helpers.js`)

- `resetAndSeed(extContext, extensionId, files)` — full reset + optional seed data
- `openHelperPage(extContext, extensionId)` — blank extension page for `sendMessage`
- `getSlugForUrl(page, url)` — pure function, no browser needed
- `waitForVisitRecorded(helper, page, url, referrer)` — polls for page entity, falls back to `recordPageActivity`

### Test Actions (background.js message handlers)

- `resetForTest` — wipe daemon data + clear extension-local state; resets `localDeviceId = null`
- `flushDesktopQueueForTest` — flushes the connector write queue after seeding
- `setDesktopQueueForTest` — injects entries into the connector write queue
- `getDesktopQueueForTest` — reports connector write queue length/watermark
- `seedTestData` — writes raw files into the daemon data dir through the daemon's test-control WebSocket

### Seed Builder

`scripts/lib/seed-builder.mjs` produces file arrays for `seedTestData`. It is a convenience helper for daemon-backed test/manual seeding, not an automated correctness target.

## Gotchas

**Slug mismatch**: Use `getSlugForUrl(url)` to compute slugs — `generateSlugFromUrl` appends a hash suffix.

**No `waitForTimeout`**: Use `waitForSelector`, `waitForFunction`, or Playwright auto-polling instead.

`**sendMessage` only reaches background.** E2E tests seed and reset through background-routed test actions, but the actual persistence path is the real daemon and the production connector RPC.

**Chrome infra errors**: Kill all Chrome processes before retrying: `pkill -9 -f 'Google Chrome'`

**Popup E2E needs real tab**: When opening `popup.html` as a regular page, `chrome.tabs.query` returns the popup page itself. Use the `localServer` fixture to create a real HTTP page, navigate a tab to it first, then open popup.html.

**Playwright `keyboard.press('Meta+key')` is unreliable** in headless Chrome on macOS — Chrome consumes Meta+key combinations for native shortcuts before page `keydown` fires. Use `page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true })))` instead.

`**searchResults` mutation race**: Background mutation notifications can reset `searchResults` to `[]` mid-operation. Use `data-search-count` attribute on `#relatedResults` to poll for result count. Perform blur + keyboard dispatch in a single `evaluate()` call to minimize the race window.

`**resetForTest` must reset ALL module-level state**: The SW process survives across tests. Missing resets (e.g., `localDeviceId = null`) cause stale state to leak between tests, hiding startup-only bugs. When adding new module-level mutable state to background.js, add matching reset handling in `resetForTest`.

`**update_list_tree` uses per-device timestamps, not global LWW**: Two different devices can both apply their tree updates regardless of ordering. For deterministic test results, put both entries in a single device's log file.

**Content script isolated worlds**: DOM events cross worlds but JS property overrides don't. `Object.defineProperty(document, 'visibilityState', ...)` from `page.evaluate()` is invisible to the content script. Use native browser events: `document.dispatchEvent(new Event('visibilitychange'))`.

**Vendored IIFE globals in tests**: When extension loads a lib via `<script>` (IIFE global), vitest/jsdom needs `globalThis.X = (await import('pkg')).default` in `beforeEach`.

**When an E2E test fails, investigate the failure** — don't swap it for a different test that passes.

## Manual Testing

Launch a temporary Chrome with the extension for manual testing — nothing touches your personal browser profile.

Manual browser workflows are currently secondary to the daemon-backed Playwright path. Prefer `npx playwright test` for reproducible coverage.
