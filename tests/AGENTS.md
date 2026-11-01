# Tests — Agent Guide

Follow the root [AGENTS.md](../AGENTS.md) and [Testing guide](../docs/TESTING.md).
Use [Development](../DEVELOPMENT.md#verification) for commands.

## Fixtures and assertions

- `tests/e2e/fixtures.js` starts a real daemon, loads the extension, and completes
  pairing. `tests/e2e/helpers.js` provides reset, seeding, and helper-page actions.
- Compute slugs with `getSlugForUrl`; generated slugs include a hash suffix.
- `sendMessage` reaches background handlers. Use tab messaging or native browser
  events for content-script behavior; page-property overrides do not cross worlds.
- Reset every mutable background module state in `resetForTest`. The service worker
  survives between tests.
- `waitForVisitRecorded` can explicitly record a missing visit. Verify automatic
  persistence first when automatic capture is the behavior under test.
- Prefer conditions over sleeps. Poll `data-search-count` for search results;
  background notifications can replace the in-memory results during an action.
- List-tree timestamps are per device. Put entries in one device log when a test
  requires deterministic ordering between tree updates.
- Headless macOS Chromium may consume Meta shortcuts before page handlers run.
  Dispatch a DOM keyboard event for page-handler tests; use native automation when
  testing the browser shortcut itself.
- When testing IIFE globals under Vitest, install the actual vendored dependency
  on `globalThis` during setup.

Investigate the original failed scenario. Do not replace a failing test with an
unrelated passing case, weaken assertions, or terminate personal browser processes.
