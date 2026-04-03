# Manual Testing Browser

Launch a temporary Chrome instance with the extension loaded, using isolated storage. Nothing touches your personal browser profile.

## Usage

```bash
# Blank extension state (empty OPFS, default lists only)
npm run manual

# Pre-seeded with sample data (3 pages, 1 note, today's log entries)
npm run manual:seed
```

The browser opens the options page automatically. The popup is also available at the URL printed in the terminal.

**Close the browser window** when done — the script detects the close, captures a state snapshot, and prints a diff of everything that changed during the session.

## What it does

1. Creates a temporary Chrome user-data directory in `/tmp/portal-manual-*`
2. Launches Chromium via Playwright with `--load-extension` pointing at `extension/`
3. Calls `setTestDirectory` to point storage at OPFS (same as E2E tests)
4. Calls `resetForTest` to ensure a clean slate
5. Optionally seeds data via `seedTestData` + `rehydrateForTest`
6. Captures initial state snapshot
7. Opens the options page and waits for the browser to close
8. Captures final state snapshot and prints a diff (changed pages, notes, lists, new log entries)

## Data diff output

When the browser closes, the script prints:
- **Human-readable summary**: new/modified/deleted pages, notes, lists, and new log entries
- **Raw JSON diff** (between `RAW_DIFF_JSON_START` / `RAW_DIFF_JSON_END` markers): full before/after for changed entities, suitable for automated analysis

## Seeded data (`--seed`)

| Entity | URL | Notes |
|--------|-----|-------|
| Page | `https://github.com/` | visited 1h ago |
| Page | `https://en.wikipedia.org/wiki/Rust_(programming_language)` | visited 30m ago, has a note |
| Page | `https://news.ycombinator.com/` | visited 10m ago |
| Note | on the Wikipedia page | "ownership + borrowing" excerpt |

All log entries are in today's JSONL file.

## Prerequisites

- `@playwright/test` installed (already a devDependency)
- Playwright browsers installed (`npx playwright install chromium` if not)
