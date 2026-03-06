#!/usr/bin/env node
/**
 * migrate-snapshot-entities.mjs — Generate snap log entries for existing snapshot files.
 *
 * Scans ~/portal-data/pages/ directories for timestamp.md|.html files and
 * generates snap log entries appended to the corresponding history JSONL file.
 *
 * Usage:
 *   node scripts/migrate-snapshot-entities.mjs              # dry run
 *   node scripts/migrate-snapshot-entities.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const PAGES_DIR = join(DATA_DIR, 'pages');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// 1. Scan pages/ directories for snapshot files
// ---------------------------------------------------------------------------
const slugDirs = readdirSync(PAGES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

// Collect unique (slug, timestamp) pairs
const snapshots = []; // { slug, timestamp }

for (const slug of slugDirs) {
  const slugPath = join(PAGES_DIR, slug);
  const files = readdirSync(slugPath);
  const timestamps = new Set();

  for (const file of files) {
    const match = file.match(/^(\d+)\.(md|html)$/);
    if (!match) continue;
    timestamps.add(parseInt(match[1], 10));
  }

  for (const ts of timestamps) {
    snapshots.push({ slug, timestamp: ts });
  }
}

console.log(`Found ${snapshots.length} snapshot(s) across ${slugDirs.length} page directories`);

// ---------------------------------------------------------------------------
// 2. Load existing history to check for duplicates
// ---------------------------------------------------------------------------
const existingSnaps = new Set();
const checkpointTsBySlug = new Map(); // slug -> max page_checkpoint timestamp
const historyFiles = existsSync(HISTORY_DIR)
  ? readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort()
  : [];

for (const file of historyFiles) {
  for (const line of readFileSync(join(HISTORY_DIR, file), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      if (entry.action === 'snap') {
        existingSnaps.add(entry.slug);
      }
      if (entry.action === 'page_checkpoint' && entry.url) {
        const slug = generateSlugFromUrl(entry.url);
        const prev = checkpointTsBySlug.get(slug) || 0;
        if (entry.timestamp > prev) checkpointTsBySlug.set(slug, entry.timestamp);
      }
    } catch {}
  }
}

console.log(`Found ${existingSnaps.size} existing snap entries in history`);
console.log(`Found ${checkpointTsBySlug.size} page checkpoints in history`);

// ---------------------------------------------------------------------------
// 3. Generate new snap entries, grouped by history file date
// ---------------------------------------------------------------------------
const newEntries = new Map(); // filename -> entry[]
let skipped = 0;

for (const { slug, timestamp } of snapshots) {
  const snapSlug = `${slug}/${timestamp}`;

  // Idempotency guard
  if (existingSnaps.has(snapSlug)) {
    skipped++;
    continue;
  }

  // snap must follow the page_checkpoint (ensureCheckpointIfMissing invariant)
  const checkpointTs = checkpointTsBySlug.get(slug) || 0;
  const snapTs = Math.max(checkpointTs, timestamp) + 1;

  const entry = {
    timestamp: snapTs,
    action: 'snap',
    slug: snapSlug,
    parentIds: [`page:${slug}`],
  };

  const date = new Date(snapTs).toISOString().slice(0, 10);
  const filename = `${date}.jsonl`;

  if (!newEntries.has(filename)) newEntries.set(filename, []);
  newEntries.get(filename).push(entry);
}

const totalNew = [...newEntries.values()].reduce((sum, arr) => sum + arr.length, 0);
console.log(`\nNew snap entries to generate: ${totalNew}`);
console.log(`Skipped (already exist): ${skipped}`);

// ---------------------------------------------------------------------------
// 4. Write (or preview)
// ---------------------------------------------------------------------------
for (const [filename, entries] of newEntries) {
  const filePath = join(HISTORY_DIR, filename);
  const lines = entries.map(e => JSON.stringify(e));

  if (dryRun) {
    console.log(`\n--- Would append ${entries.length} entries to ${filename} ---`);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
  } else {
    appendFileSync(filePath, lines.map(l => l + '\n').join(''));
    console.log(`Appended ${entries.length} entries to ${filename}`);
  }
}

if (dryRun) {
  console.log('\n=== DRY RUN COMPLETE — pass --apply to write ===');
} else {
  console.log(`\nDone. Written ${totalNew} snap entries.`);
  console.log('Run replay-verify.mjs to verify the history is consistent.');
}
