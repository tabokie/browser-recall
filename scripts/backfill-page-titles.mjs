#!/usr/bin/env node
/**
 * Backfill missing titles on page entities from log history.
 *
 * Scans all JSONL log files for visit_page and leave_page entries that carry
 * a title, then patches any page entity file that lacks a title field.
 *
 * Usage:
 *   node scripts/backfill-page-titles.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data/logs');
const PAGES_DIR = join(DATA_DIR, 'pages');

const dryRun = process.argv.includes('--dry-run');

// Phase 1: Build url→title map from logs (latest title wins)
const titleByUrl = new Map();

const logFiles = readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
for (const file of logFiles) {
  const lines = readFileSync(join(LOGS_DIR, file), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if ((entry.action === 'visit_page' || entry.action === 'leave_page') && entry.title && entry.url) {
        titleByUrl.set(entry.url, entry.title);
      }
    } catch { /* skip malformed lines */ }
  }
}

console.log(`Found titles for ${titleByUrl.size} URLs in logs`);

// Phase 2: Patch page entities that lack a title
let patched = 0;
let skipped = 0;
let noMatch = 0;

const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
for (const file of pageFiles) {
  const filePath = join(PAGES_DIR, file);
  const page = JSON.parse(readFileSync(filePath, 'utf-8'));

  // Skip pages that already have a title
  if (page.title || page.user_title) {
    skipped++;
    continue;
  }

  // Look up title by URL
  if (!page.url) {
    noMatch++;
    continue;
  }

  const title = titleByUrl.get(page.url);
  if (!title) {
    noMatch++;
    continue;
  }

  page.title = title;
  if (!dryRun) {
    writeFileSync(filePath, JSON.stringify(page, null, 2) + '\n');
  }
  patched++;
  console.log(`${dryRun ? '[DRY] ' : ''}Patched: ${file} → "${title}"`);
}

// Phase 3: Also backfill titles into pin_to_list log entries for future replays
let logEntriesPatched = 0;
for (const file of logFiles) {
  const filePath = join(LOGS_DIR, file);
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let modified = false;
  const newLines = [];

  for (const line of lines) {
    if (!line.trim()) { newLines.push(line); continue; }
    try {
      const entry = JSON.parse(line);
      // Backfill titles into entity-creating actions
      if (entry.action === 'pin_to_list' && entry.items?.length > 0 && !entry.titles) {
        const titles = {};
        for (const item of entry.items) {
          if (!item.startsWith('notes/')) {
            const t = titleByUrl.get(item);
            if (t) titles[item] = t;
          }
        }
        if (Object.keys(titles).length > 0) {
          entry.titles = titles;
          newLines.push(JSON.stringify(entry));
          modified = true;
          logEntriesPatched++;
          continue;
        }
      }
      if (['rate_page', 'create_snapshot', 'create_note'].includes(entry.action)
          && entry.url && !entry.title) {
        const t = titleByUrl.get(entry.url);
        if (t) {
          entry.title = t;
          newLines.push(JSON.stringify(entry));
          modified = true;
          logEntriesPatched++;
          continue;
        }
      }
    } catch { /* skip malformed */ }
    newLines.push(line);
  }

  if (modified && !dryRun) {
    writeFileSync(filePath, newLines.join('\n'));
  }
}

console.log(`\nSummary:`);
console.log(`  Page entities patched: ${patched}`);
console.log(`  Already had title: ${skipped}`);
console.log(`  No title found in logs: ${noMatch}`);
console.log(`  Log entries backfilled: ${logEntriesPatched}`);
if (dryRun) console.log(`  (dry run — no files written)`);
