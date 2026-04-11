# Tests — Agent Guide

## Running Tests

- **Unit tests**: `npm test` (vitest, ~600 tests). Config: `vitest.config.js`, files: `tests/**/*.test.js`.
- **E2E tests**: `npx playwright test` (~349 tests). Config: `playwright.config.js`, files: `tests/e2e/*.spec.js`. Single worker, chromium channel, 30s per-test timeout.
- The two suites are independent — run either without the other.

## E2E Infrastructure

### Fixtures (`tests/e2e/fixtures.js`)

Worker-scoped: `extContext` (persistent browser context with extension loaded), `extensionId`, `setupDir` (OPFS-backed test directory via `setTestDirectory`).

### Helpers (`tests/e2e/helpers.js`)

- `resetAndSeed(extContext, extensionId, files)` — full reset + optional seed data
- `openOptionsPage(extContext, extensionId)` — waits for `data-ready` attribute
- `openHelperPage(extContext, extensionId)` — blank extension page for `sendMessage`
- `getSlugForUrl(page, url)` — pure function, no browser needed
- `waitForListView(page, listName)` — waits for sidebar click + list rendering
- `waitForVisitRecorded(helper, page, url, referrer)` — polls for page entity, falls back to `reportPage`

### Test Actions (background.js message handlers)

- `resetForTest` — wipe + rehydrate; resets `localDeviceId = null`
- `rehydrateForTest` — rehydrate without wipe; pass `keepLogBuffer: true` to preserve injected logBuffer
- `simulatePreHydrationForTest` — sets `localDeviceId = null` to simulate the pre-hydration window
- `pauseServiceForTest` — calls `pauseService(code, message)` for testing downtime UI
- `seedTestData` — relay to offscreen file writes

### Seed Builder (`tests/seed-builder.mjs`)

`buildSeedFiles(events, { deviceId, checkpointProgress, settings, entities })` produces file arrays for `seedTestData`. All events go to JSONL; `checkpointProgress` controls which also produce entity checkpoint files. `entities` provides pre-existing data (note content, etc.) that replay expects to find.

## Property-Based Tests

Randomized/property tests use [fast-check](https://github.com/dubzzz/fast-check) to generate arbitrary event sequences and verify structural invariants.

### Arbitraries (`tests/arbitrary-events.mjs`)

Shared event-sequence generators used by both Vitest and E2E tests. `arbEventSequence(minLen, maxLen)` produces a random array of log entries covering all 22 replay action types. Stateful tracking during generation ensures referential consistency (e.g., only deleting notes that were created, deduplicating `create_list` events per `owner/name`).

Key exports: `arbEventSequence`, `URL_POOL`, `LIST_NAMES`, `DEVICES`.

### Vitest Properties (`tests/replay-properties.test.js`)

Tests P1–P6 (idempotency, referential integrity, checkpoint equivalence, multi-device convergence, monotonic timestamps, three-way consistency). Runs the `effectOf` replay engine directly in Node with an in-memory store.

Run: `npm test -- tests/replay-properties.test.js`

### E2E Properties (`tests/e2e/property-invariants.spec.js`)

Tests P7–P10 (sidebar list count, pin count, recycle bin, history ordering). Uses a seeded PRNG to generate scenarios, builds seed files via `seed-builder.mjs`, loads them into the real extension, and asserts UI state. Three deterministic seeds per invariant.

Run: `npx playwright test tests/e2e/property-invariants.spec.js`

See ARCHITECTURE.md "Verified Invariants" for the full catalogue.

## Gotchas

**Slug mismatch**: Use `getSlugForUrl(url)` to compute slugs — `generateSlugFromUrl` appends a hash suffix.

**No `waitForTimeout`**: Use `waitForSelector`, `waitForFunction`, or Playwright auto-polling instead.

`**sendMessage` only reaches background.** Offscreen uses port channel only. Use background-routed actions in test assertions.

**Chrome infra errors**: Kill all Chrome processes before retrying: `pkill -9 -f 'Google Chrome'`

**Popup E2E needs real tab**: When opening `popup.html` as a regular page, `chrome.tabs.query` returns the popup page itself. Use the `localServer` fixture to create a real HTTP page, navigate a tab to it first, then open popup.html.

**Playwright `keyboard.press('Meta+key')` is unreliable** in headless Chrome on macOS — Chrome consumes Meta+key combinations for native shortcuts before page `keydown` fires. Use `page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true })))` instead.

`**searchResults` mutation race**: Background mutation notifications can reset `searchResults` to `[]` mid-operation. Use `data-search-count` attribute on `#relatedResults` to poll for result count. Perform blur + keyboard dispatch in a single `evaluate()` call to minimize the race window.

**Offscreen restart loses OPFS handle**: After `killOffscreenForTest` or any offscreen crash/restart, the new offscreen document starts fresh. `resetForTest` must call `setTestDirectory` before `resetDirectory` to re-establish it.

`**resetForTest` must reset ALL module-level state**: The SW process survives across tests. Missing resets (e.g., `localDeviceId = null`) cause stale state to leak between tests, hiding startup-only bugs. When adding new module-level mutable state to background.js, add a matching reset line in `resetForTest` and `rehydrateForTest`.

`**update_list_tree` uses per-device timestamps, not global LWW**: Two different devices can both apply their tree updates regardless of ordering. For deterministic test results, put both entries in a single device's log file.

**Content script isolated worlds**: DOM events cross worlds but JS property overrides don't. `Object.defineProperty(document, 'visibilityState', ...)` from `page.evaluate()` is invisible to the content script. Use native browser events: `document.dispatchEvent(new Event('visibilitychange'))`.

**Vendored IIFE globals in tests**: When extension loads a lib via `<script>` (IIFE global), vitest/jsdom needs `globalThis.X = (await import('pkg')).default` in `beforeEach`.

**When an E2E test fails, investigate the failure** — don't swap it for a different test that passes.

## Manual Testing

Launch a temporary Chrome with the extension for manual testing — nothing touches your personal browser profile.

```bash
npm run manual              # blank state
npm run manual:seed         # pre-seeded with 3 pages + 1 note
npm run manual:case <name>  # loads seeds/<name>.mjs
npm run manual:onboarding   # first-run experience
```

Closing the browser prints a data diff (changed pages, notes, lists, new log entries). Seed cases live in `seeds/` (gitignored). Each `.mjs` file exports `{ events, entities, deviceId, settings }`.