#!/usr/bin/env node
/**
 * migrate-gateways.mjs — Migrate gateway data to log-based format.
 *
 * Old format (lists/system/gateways.json):
 *   { watermark, domains: { [origin]: { rootUrl, childCount, fetched } } }
 *
 * New format (lists/system/gateways.json):
 *   { timestamp, origins: [...] }
 *
 * This script:
 * 1. Reads the old gateways.json
 * 2. Extracts qualifying origins (childCount >= 2)
 * 3. Appends a `list` log entry to today's JSONL history file
 *    so that full replay reconstructs the entity correctly
 * 4. Overwrites gateways.json with the new format
 *
 * Usage:
 *   node scripts/migrate-gateways.mjs              # dry run
 *   node scripts/migrate-gateways.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const GATEWAYS_PATH = join(DATA_DIR, 'lists', 'system', 'gateways.json');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Read old gateways.json
// ---------------------------------------------------------------------------
if (!existsSync(GATEWAYS_PATH)) {
  console.log('No gateways.json found — nothing to migrate.');
  process.exit(0);
}

const old = JSON.parse(readFileSync(GATEWAYS_PATH, 'utf-8'));

if (Array.isArray(old.origins)) {
  console.log('gateways.json is already in new format — nothing to migrate.');
  process.exit(0);
}

if (!old.domains || typeof old.domains !== 'object') {
  console.log('gateways.json has no domains field — nothing to migrate.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Extract qualifying origins (childCount >= 2)
// ---------------------------------------------------------------------------
const origins = [];
for (const [origin, entry] of Object.entries(old.domains)) {
  if (entry.childCount >= 2) {
    origins.push(origin);
  }
}

console.log(`Found ${Object.keys(old.domains).length} domains, ${origins.length} qualify (childCount >= 2):`);
for (const o of origins) {
  const e = old.domains[o];
  console.log(`  ${o} — childCount: ${e.childCount}, rootUrl: ${e.rootUrl || '(none)'}`);
}

if (origins.length === 0) {
  console.log('\nNo qualifying origins. Overwriting gateways.json with empty new format.');
  if (!dryRun) {
    writeFileSync(GATEWAYS_PATH, JSON.stringify({ timestamp: 0, origins: [] }, null, 2) + '\n');
    console.log('Done.');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Write log entry to today's JSONL history file
// ---------------------------------------------------------------------------
const now = Date.now();
const todayStr = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
const historyFile = join(HISTORY_DIR, `${todayStr}.jsonl`);

const logEntry = {
  timestamp: now,
  action: 'list',
  id: 'system/gateways',
  op: 'add',
  origins
};

console.log(`\nLog entry to append to ${todayStr}.jsonl:`);
console.log('  ' + JSON.stringify(logEntry));

// ---------------------------------------------------------------------------
// Write new-format entity file
// ---------------------------------------------------------------------------
const newEntity = { timestamp: now, origins };

console.log(`\nNew gateways.json:`);
console.log('  ' + JSON.stringify(newEntity));

if (!dryRun) {
  appendFileSync(historyFile, JSON.stringify(logEntry) + '\n');
  console.log(`\nAppended log entry to ${historyFile}`);

  writeFileSync(GATEWAYS_PATH, JSON.stringify(newEntity, null, 2) + '\n');
  console.log(`Wrote new-format ${GATEWAYS_PATH}`);

  console.log('Done.');
} else {
  console.log('\nPass --apply to write changes.');
}
