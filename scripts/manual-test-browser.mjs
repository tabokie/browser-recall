#!/usr/bin/env node

// manual-test-browser.mjs — Launch a temporary Chrome for manual extension testing.
//
// USAGE (from project root):
//   npm run manual            # blank extension state
//   npm run manual:seed       # pre-seeded with 3 pages, 1 note
//
// HOW IT WORKS:
//   1. Starts a temporary daemon and launches Chromium with a temp profile.
//      Nothing touches your personal browser data.
//   2. Seeds data via scripts/lib/seed-builder.mjs → seedTestData → rehydrate.
//   3. Captures initial state snapshot (pages, notes, lists, log entries).
//   4. Opens the options page. You interact with the browser manually.
//   5. When you close the browser window, captures final state and prints a diff.
//
// RUNNING FROM CLAUDE CODE:
//   Launch with `npm run manual:seed` as a background task. When the task completes
//   (user closed the browser), read the task output file. The output contains:
//
//   - Human-readable diff: section between "========== DATA DIFF ==========" and
//     "===============================" showing new/modified/deleted pages, notes,
//     lists, and new log entries with timestamps.
//
//   - Raw JSON diff: section between "RAW_DIFF_JSON_START" and "RAW_DIFF_JSON_END"
//     containing full before/after state for changed entities. Use this for detailed
//     analysis — check field-level changes, verify timestamps, inspect list pins, etc.
//
//   When analyzing the diff, look for:
//   - Unexpected entity creation or deletion (possible bug in event handling)
//   - Missing fields on entities (possible replay or drain issue)
//   - Orphaned references (childIds pointing to non-existent notes/snapshots)
//   - Timestamp anomalies (per-device timestamps not advancing, or going backward)
//   - Log entries without corresponding entity state changes (drain may not have run)

import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { buildSeedFiles } from './lib/seed-builder.mjs';
import {
  cleanupTestExtensionDir,
  createTestExtensionDir,
} from '../tests/fixtures/test-extension.mjs';
import {
  startDaemon,
  waitForDesktopConnector,
} from './lib/desktop-test-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extPath = createTestExtensionDir('browser-recall-manual-extension-');
const seedsDir = path.join(__dirname, '../seeds');
const seed = process.argv.includes('--seed');
// --case <name> loads seeds/<name>.mjs
const caseIdx = process.argv.indexOf('--case');
const seedCase = caseIdx >= 0 ? process.argv[caseIdx + 1] : null;

process.on('exit', () => {
  cleanupTestExtensionDir(extPath);
});

// --- State dump: read all entities via the extension's message API ---

async function dumpState(ctx, extensionId) {
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(
      () => typeof chrome !== 'undefined' && chrome.runtime,
    );
    return await page.evaluate(async () => {
      const { generateSlugFromUrl } = await import(
        chrome.runtime.getURL('utils.js')
      );
      const send = (obj) => chrome.runtime.sendMessage(obj);
      const read = async (key) =>
        (await send({ action: 'readDesktopValue', key }))?.value;

      const listOrderEntity = (await read('manifest:list-order')) || {
        tree: [],
      };
      const settings = await read('manifest:settings');
      const orphaned = (await read('manifest:orphaned')) || [];

      // Read recent logs (today + yesterday) to discover page slugs.
      // Pages have no "list all" API — slugs come from log entries.
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400_000)
        .toISOString()
        .slice(0, 10);
      const log = (await read(`log:${today}`)) || [];
      const yesterdayLog =
        today !== yesterday ? (await read(`log:${yesterday}`)) || [] : [];
      const allLogEntries = [...yesterdayLog, ...log];

      const pageSlugs = new Set();
      for (const entry of allLogEntries) {
        if (entry.url) {
          try {
            pageSlugs.add(generateSlugFromUrl(entry.url));
          } catch {
            /* skip bad URLs */
          }
        }
      }

      // Pages
      const pages = {};
      for (const slug of pageSlugs) {
        const v = await read(`page:${slug}`);
        if (v) pages[slug] = v;
      }

      // Notes (from page childIds)
      const notes = {};
      for (const pg of Object.values(pages)) {
        for (const cid of pg.childIds || []) {
          if (cid.startsWith('note:')) {
            const ns = cid.slice(5);
            if (!notes[ns]) {
              const v = await read(`note:${ns}`);
              if (v) notes[ns] = v;
            }
          }
        }
      }

      // Lists — tree is [{ id: 'list:...', children?: [...] }, ...]
      const tree = listOrderEntity.tree || [];
      function collectListIds(nodes) {
        const ids = [];
        for (const n of nodes) {
          if (n.id) ids.push(n.id);
          if (n.children) ids.push(...collectListIds(n.children));
        }
        return ids;
      }
      const listIds = collectListIds(tree);
      const lists = {};
      for (const lid of listIds) {
        const v = await read(lid);
        if (v) lists[lid] = v;
      }

      return {
        pages,
        notes,
        lists,
        settings,
        orphaned,
        listOrder: tree,
        log: allLogEntries,
      };
    });
  } finally {
    await page.close();
  }
}

// --- Diff computation ---

function diffObjects(label, before, after) {
  const lines = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const added = [],
    removed = [],
    modified = [];

  for (const key of allKeys) {
    const inBefore = key in before,
      inAfter = key in after;
    if (!inBefore) {
      added.push({ key, value: after[key] });
    } else if (!inAfter) {
      removed.push({ key, value: before[key] });
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      modified.push({ key, before: before[key], after: after[key] });
    }
  }

  if (added.length + removed.length + modified.length === 0) return lines;
  lines.push(`\n--- ${label} ---`);

  for (const { key, value } of added) {
    const title = value?.title || value?.name || value?.excerpt || key;
    lines.push(`  + [new] ${title}  (${value?.url || key})`);
  }
  for (const { key, value } of removed) {
    const title = value?.title || value?.name || value?.excerpt || key;
    lines.push(`  - [deleted] ${title}  (${value?.url || key})`);
  }
  for (const { key, before: b, after: a } of modified) {
    const title = a?.title || a?.name || key;
    lines.push(`  ~ [modified] ${title}`);
    const fields = new Set([...Object.keys(b || {}), ...Object.keys(a || {})]);
    for (const f of fields) {
      const bv = JSON.stringify(b?.[f]),
        av = JSON.stringify(a?.[f]);
      if (bv !== av) lines.push(`      ${f}: ${bv} → ${av}`);
    }
  }
  return lines;
}

function printDiff(before, after) {
  const lines = [];
  lines.push('\n========== DATA DIFF ==========');
  lines.push(...diffObjects('Pages', before.pages, after.pages));
  lines.push(...diffObjects('Notes', before.notes, after.notes));
  lines.push(...diffObjects('Lists', before.lists, after.lists));

  // Settings diff
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
    lines.push('\n--- Settings ---');
    lines.push(`  before: ${JSON.stringify(before.settings)}`);
    lines.push(`  after:  ${JSON.stringify(after.settings)}`);
  }

  // New log entries
  const beforeLogJson = new Set((before.log || []).map(JSON.stringify));
  const newEntries = (after.log || []).filter(
    (e) => !beforeLogJson.has(JSON.stringify(e)),
  );
  if (newEntries.length) {
    lines.push(`\n--- New log entries (${newEntries.length}) ---`);
    for (const e of newEntries) {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString() : '?';
      lines.push(`  ${ts}  ${e.action}  ${e.title || e.slug || e.url || ''}`);
    }
  }

  if (lines.length <= 1) {
    lines.push('\n  (no changes detected)');
  }
  lines.push('\n===============================\n');
  console.log(lines.join('\n'));

  // Also print raw JSON of changes for detailed analysis
  const rawDiff = {};
  if (
    Object.keys(after.pages).length !== Object.keys(before.pages).length ||
    JSON.stringify(after.pages) !== JSON.stringify(before.pages)
  )
    rawDiff.pages = { before: before.pages, after: after.pages };
  if (JSON.stringify(after.notes) !== JSON.stringify(before.notes))
    rawDiff.notes = { before: before.notes, after: after.notes };
  if (JSON.stringify(after.lists) !== JSON.stringify(before.lists))
    rawDiff.lists = { before: before.lists, after: after.lists };
  if (newEntries.length) rawDiff.newLogEntries = newEntries;

  if (Object.keys(rawDiff).length) {
    console.log('RAW_DIFF_JSON_START');
    console.log(JSON.stringify(rawDiff, null, 2));
    console.log('RAW_DIFF_JSON_END');
  }
}

// --- Main ---

const daemon = await startDaemon();
const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'browser-recall-manual-'),
);
console.log(`Temp profile: ${userDataDir}`);

let ctx, extensionId;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    });

    // Wait for the extension service worker and verify it's alive.
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 });
    extensionId = sw.url().split('/')[2];

    // Health check: load a page and confirm chrome.runtime works (same as E2E fixtures).
    const probe = await ctx.newPage();
    await probe.goto(`chrome-extension://${extensionId}/test-helper.html`, {
      timeout: 5000,
    });
    await probe.waitForFunction(
      () => typeof chrome !== 'undefined' && chrome.runtime,
      { timeout: 5000 },
    );
    await probe.close();
    break;
  } catch (e) {
    console.warn(`Launch attempt ${attempt + 1} failed: ${e.message}`);
    await ctx?.close().catch(() => {});
    if (attempt >= 2) throw e;
    await new Promise((r) => setTimeout(r, 500));
  }
}
console.log(`Extension loaded: ${extensionId}`);

// Wait for onInstalled handler to finish (it may auto-open the options stub).
await new Promise((r) => setTimeout(r, 1000));
// Close any auto-opened options stub pages to avoid navigation races.
for (const p of ctx.pages()) {
  if (p.url().includes('options-stub.html')) await p.close();
}

const setupPage = await ctx.newPage();
await setupPage.goto(`chrome-extension://${extensionId}/test-helper.html`);
await setupPage.waitForFunction(
  () => typeof chrome !== 'undefined' && chrome.runtime,
);

await waitForDesktopConnector(ctx, extensionId);

const resetResult = await setupPage.evaluate(() =>
  chrome.runtime.sendMessage({ action: 'resetForTest' }),
);
if (!resetResult?.success) {
  console.error('resetForTest failed:', resetResult);
  process.exit(1);
}

if (seed) {
  console.log('Seeding sample data...');
  const now = Date.now();
  const deviceId = crypto.randomUUID().slice(0, 8);
  const WIKI_URL = 'https://en.wikipedia.org/wiki/Rust_(programming_language)';

  const sampleFiles = await buildSeedFiles(
    [
      // rate_page creates page entities (visit_page alone doesn't)
      {
        action: 'rate_page',
        url: 'https://github.com/',
        title: 'GitHub',
        timestamp: now - 3600_000,
        likes: 1,
      },
      {
        action: 'rate_page',
        url: WIKI_URL,
        title: 'Rust (programming language) - Wikipedia',
        timestamp: now - 1800_000,
        likes: 1,
      },
      {
        action: 'rate_page',
        url: 'https://news.ycombinator.com/',
        title: 'Hacker News',
        timestamp: now - 600_000,
        likes: 1,
      },
      // create_note links note to wiki page
      {
        action: 'create_note',
        url: WIKI_URL,
        timestamp: now - 1700_000,
        path: 'notes/rust-note.json',
      },
      // visit_page entries enrich pages with visit dates
      {
        action: 'visit_page',
        url: 'https://github.com/',
        title: 'GitHub',
        timestamp: now - 3600_000,
      },
      {
        action: 'visit_page',
        url: WIKI_URL,
        title: 'Rust (programming language) - Wikipedia',
        timestamp: now - 1800_000,
      },
      {
        action: 'visit_page',
        url: 'https://news.ycombinator.com/',
        title: 'Hacker News',
        timestamp: now - 600_000,
      },
    ],
    {
      deviceId,
      // Default checkpointProgress = events.length: all events produce entity checkpoints AND JSONL.
      settings: { trimRules: [] },
      entities: {
        'note:rust-note': {
          slug: 'rust-note',
          excerpt: ['Memory safety without garbage collection'],
          note: 'Key insight: ownership + borrowing = memory safety without GC.',
          cssPath: [''],
          url: WIKI_URL,
        },
      },
    },
  );

  const seedResult = await setupPage.evaluate(
    (files) => chrome.runtime.sendMessage({ action: 'seedTestData', files }),
    sampleFiles,
  );
  if (!seedResult?.success) {
    console.error('seedTestData failed:', seedResult);
    process.exit(1);
  }

  const rehydrateResult = await setupPage.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
  );
  if (!rehydrateResult?.success) {
    console.error('rehydrateForTest failed:', rehydrateResult);
    process.exit(1);
  }
  console.log('Sample data seeded (3 pages, 1 note).');
}

if (seedCase) {
  const casePath = path.join(seedsDir, seedCase + '.mjs');
  if (!fs.existsSync(casePath)) {
    console.error(`Seed case not found: ${casePath}`);
    process.exit(1);
  }
  console.log(`Loading seed case: ${seedCase}`);
  const { default: generateSeed } = await import(casePath);
  const { events, entities, deviceId, settings } = generateSeed();

  console.log(
    `  ${events.length} events, ${Object.keys(entities || {}).length} entity overrides`,
  );

  const sampleFiles = await buildSeedFiles(events, {
    deviceId,
    settings: settings || {},
    entities: entities || {},
  });

  console.log(`  ${sampleFiles.length} seed files generated. Uploading...`);

  const seedResult = await setupPage.evaluate(
    (files) => chrome.runtime.sendMessage({ action: 'seedTestData', files }),
    sampleFiles,
  );
  if (!seedResult?.success) {
    console.error('seedTestData failed:', seedResult);
    process.exit(1);
  }

  const rehydrateResult = await setupPage.evaluate(() =>
    chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
  );
  if (!rehydrateResult?.success) {
    console.error('rehydrateForTest failed:', rehydrateResult);
    process.exit(1);
  }
  console.log(`Seed case "${seedCase}" ready.`);
}

await setupPage.close();

// Capture initial state for diffing.
console.log('Capturing initial state...');
const initialState = await dumpState(ctx, extensionId);
console.log(
  `  ${Object.keys(initialState.pages).length} pages, ${Object.keys(initialState.notes).length} notes, ${Object.keys(initialState.lists).length} lists, ${initialState.log.length} log entries`,
);

// Close the default about:blank page so only the options page shows.
for (const p of ctx.pages()) {
  if (p.url() === 'about:blank') await p.close();
}

// Open the shipped extension stub page.
const optionsPage = await ctx.newPage();
await optionsPage.goto(`chrome-extension://${extensionId}/options-stub.html`);

console.log('\nBrowser ready for manual testing.');
console.log(
  `  Options stub: chrome-extension://${extensionId}/options-stub.html`,
);
console.log(`  Popup:   chrome-extension://${extensionId}/popup.html`);
console.log('Close the browser window when done.\n');

// Wait for exit: user closes the browser window, or presses Ctrl+C.
// On macOS, closing the Chrome window doesn't quit the process — we detect
// all pages closing and use that as the trigger.
let exitReason = await new Promise((resolve) => {
  let resolved = false;
  const once = (reason) => {
    if (!resolved) {
      resolved = true;
      resolve(reason);
    }
  };

  // Track page closes — when all pages are gone, the user closed the window.
  const checkEmpty = () => {
    if (ctx.pages().length === 0) once('window-closed');
  };
  for (const p of ctx.pages()) p.on('close', () => setTimeout(checkEmpty, 300));
  ctx.on('page', (p) => p.on('close', () => setTimeout(checkEmpty, 300)));

  ctx.on('close', () => once('browser-quit'));
  process.on('SIGINT', () => once('sigint'));
  process.on('SIGTERM', () => once('sigterm'));
});

console.log(`\nSession ended (${exitReason}). Capturing final state...`);

let finalState = null;
if (exitReason !== 'browser-quit') {
  // Context is still alive — we can open a page and read data.
  try {
    finalState = await dumpState(ctx, extensionId);
    console.log(
      `  ${Object.keys(finalState.pages).length} pages, ${Object.keys(finalState.notes).length} notes, ${Object.keys(finalState.lists).length} lists, ${finalState.log.length} log entries`,
    );
  } catch (e) {
    console.error(`  Failed to capture final state: ${e.message}`);
  }
}

if (finalState) {
  printDiff(initialState, finalState);
} else {
  console.log('\n  Could not capture final state (browser already exited).');
  console.log(
    '  Tip: close the browser window instead of force-quitting for data diff.\n',
  );
}

// Cleanup
console.log('Cleaning up...');
await ctx.close().catch(() => {});
await daemon.stop();
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch (e) {
  // Node 24 rmSync can race with Chrome lock files; ignore.
  console.warn(
    `  Warning: temp dir cleanup incomplete (${e.code}). Dir: ${userDataDir}`,
  );
}
console.log('Done.');
