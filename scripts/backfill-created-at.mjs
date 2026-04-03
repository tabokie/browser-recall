#!/usr/bin/env node
/**
 * Backfill createdAt on page entities from log history.
 *
 * Scans all JSONL log files for the earliest timestamp per URL, then
 * sets createdAt on page entities that don't already have it.
 * Falls back to earliest visitDates entry when no log match is found.
 *
 * Usage:
 *   node scripts/backfill-created-at.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data/logs');
const PAGES_DIR = join(DATA_DIR, 'pages');

const dryRun = process.argv.includes('--dry-run');

// Phase 1: Build url→earliest timestamp map from logs (across all device dirs)
const earliestByUrl = new Map();

const deviceDirs = readdirSync(LOGS_DIR).filter(d => {
  try { return readdirSync(join(LOGS_DIR, d)).length > 0; } catch { return false; }
});

for (const device of deviceDirs) {
  const devicePath = join(LOGS_DIR, device);
  const logFiles = readdirSync(devicePath).filter(f => f.endsWith('.jsonl')).sort();
  for (const file of logFiles) {
    const lines = readFileSync(join(devicePath, file), 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry.url || !entry.timestamp) continue;
        const existing = earliestByUrl.get(entry.url);
        if (!existing || entry.timestamp < existing) {
          earliestByUrl.set(entry.url, entry.timestamp);
        }
      } catch { /* skip malformed lines */ }
    }
  }
}

console.log(`Found timestamps for ${earliestByUrl.size} URLs in logs (${deviceDirs.length} device dirs)`);

// Phase 2: Patch page entities
let patched = 0;
let skipped = 0;
let fallback = 0;
let noMatch = 0;

const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
for (const file of pageFiles) {
  const filePath = join(PAGES_DIR, file);
  const page = JSON.parse(readFileSync(filePath, 'utf-8'));

  if (page.createdAt) {
    skipped++;
    continue;
  }

  // Try log-derived earliest timestamp via URL
  let ts = page.url ? earliestByUrl.get(page.url) : undefined;

  // Fallback: earliest visitDates entry (YYYYMMDD → epoch at midnight UTC)
  if (!ts && page.visitDates?.length > 0) {
    const earliest = Math.min(...page.visitDates);
    const y = Math.floor(earliest / 10000);
    const m = Math.floor((earliest % 10000) / 100) - 1;
    const d = earliest % 100;
    ts = new Date(y, m, d).getTime();
    fallback++;
  }

  if (!ts) {
    noMatch++;
    continue;
  }

  page.createdAt = ts;
  if (!dryRun) {
    writeFileSync(filePath, JSON.stringify(page, null, 2) + '\n');
  }
  patched++;
}

console.log(`\nSummary:`);
console.log(`  Page entities patched: ${patched}`);
console.log(`  Already had createdAt: ${skipped}`);
console.log(`  Used visitDates fallback: ${fallback}`);
console.log(`  No timestamp found: ${noMatch}`);
if (dryRun) console.log(`  (dry run -- no files written)`);
