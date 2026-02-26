#!/usr/bin/env node
/**
 * Rebuild shallow-page.json (SPI) from JSONL history.
 *
 * Seeds from existing SPI, then replays all page entries (with title/referrer)
 * and list entries (with shallow: IDs) to fill in any missing entries.
 *
 * Usage: node scripts/rebuild-spi.js [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { effectOf } from '../extension/replay.js';

const PORTAL = path.join(process.env.HOME, 'portal-data');
const HISTORY = path.join(PORTAL, 'history');
const spiPath = path.join(PORTAL, 'lists/system/shallow-page.json');
const dryRun = process.argv.includes('--dry-run');

// Seed from disk
let spi = JSON.parse(fs.readFileSync(spiPath, 'utf-8'));
const before = Object.keys(spi.index || {}).length;
console.log(`Seeded SPI: ${before} entries, ts=${spi.timestamp}`);

// Collect relevant entries from history
const entries = [];
const historyFiles = fs.readdirSync(HISTORY).filter(f => f.endsWith('.jsonl')).sort();

for (const file of historyFiles) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(HISTORY, file)) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // Page entries with title/referrer populate SPI
      if (e.action === 'page' && (e.title || e.referrerId || e.user_title)) {
        entries.push(e);
      }
      // page_checkpoint also affects SPI (absorption)
      if (e.action === 'page_checkpoint') {
        entries.push(e);
      }
      // List entries with shallow: IDs track list membership
      if (e.action === 'list' && e.ids && e.ids.some(id => id.startsWith('shallow:'))) {
        entries.push(e);
      }
    } catch { /* skip malformed */ }
  }
}

entries.sort((a, b) => a.timestamp - b.timestamp);
console.log(`Found ${entries.length} SPI-relevant entries`);

// Replay through effectOf
// We need to provide all entities in scope, not just SPI
const cache = new Map();
cache.set('list:system/shallow-page', spi);

const load = async (key) => cache.get(key) ?? null;

for (const entry of entries) {
  const result = await effectOf(entry, load);
  for (const [k, entity] of Object.entries(result)) {
    cache.set(k, entity);
  }
}

const updatedSpi = cache.get('list:system/shallow-page');
const after = Object.keys(updatedSpi.index || {}).length;
console.log(`\nSPI entries: ${before} -> ${after} (+${after - before})`);

// Show the target URLs
const targets = [
  'https://jandan.net/p/122112',
  'https://jandan.net/p/122060',
  'https://liquidskateboard.com/',
];
for (const url of targets) {
  const e = updatedSpi.index[url];
  console.log(`  ${url}: ${e ? `title="${e.title}" lists=${JSON.stringify(e.lists)}` : 'MISSING'}`);
}

if (dryRun) {
  console.log('\n[DRY RUN] No files written.');
  process.exit(0);
}

fs.writeFileSync(spiPath, JSON.stringify(updatedSpi, null, 2) + '\n');
console.log('\nWritten.');
