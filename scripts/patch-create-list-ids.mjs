#!/usr/bin/env node
/**
 * patch-create-list-ids.mjs — Add listId field to create_list events in data/logs/.
 *
 * Maps each create_list event (by timestamp) to its known listId from the backup's
 * list_meta events. This is needed because effectOf generates different IDs than
 * the original ones, and the entity files on disk use the original IDs.
 *
 * Usage:
 *   node scripts/patch-create-list-ids.mjs              # dry run
 *   node scripts/patch-create-list-ids.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// Known timestamp → listId mapping (from backup history list_meta events)
const timestampToId = {
  1771425459689: 'gateways-3km4de',
  1771425463577: 'jandan-3ohvjd',
  1771473823256: 'health-ie863v',
  1771474776772: 'product-30lw2q',
  1771644403896: 'live-xn77a1',
  1771823639734: 'test-46vt29',
  1771940491508: 'cognition-rjhge3',
  1771991693578: 'ai-core-ffnyqr',
  1772078025172: 'fashion-7azmls',
  1772346853878: 'mv-6l2p8t',
  1772420474371: 'community-33c8w3',
  1772465439994: 'social-lon02n',
  1772551481706: 'music-fc9dbv',
  1772723303674: 'library-ug53bc',
  1772803577355: 'cinema-gfl1h7',
  1772980111363: 'finance-z8j6ss',
  1773045826825: 'ai-agent-xh67a7',
};

// Special cases: auto lists (timestamp shared — use name to disambiguate)
const autoTimestampEntries = {
  1773032262759: { 'Auto': 'auto', 'Gateways': 'auto/gateways' },
};

let patched = 0;
let skipped = 0;

const logFiles = readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
for (const file of logFiles) {
  const filePath = join(LOGS_DIR, file);
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let changed = false;

  const newLines = lines.map(line => {
    if (!line.trim()) return line;
    let entry;
    try { entry = JSON.parse(line); } catch { return line; }
    if (entry.action !== 'create_list') return line;
    if (entry.listId) return line; // already has listId

    // Look up ID
    let listId = timestampToId[entry.timestamp];

    // Check auto list disambiguation
    if (!listId && autoTimestampEntries[entry.timestamp]) {
      listId = autoTimestampEntries[entry.timestamp][entry.name];
    }

    if (listId) {
      entry.listId = listId;
      console.log(`  ${file}: create_list "${entry.name}" → listId=${listId}`);
      changed = true;
      patched++;
      return JSON.stringify(entry);
    } else {
      console.log(`  ${file}: SKIP create_list "${entry.name}" ts=${entry.timestamp} (no known ID)`);
      skipped++;
      return line;
    }
  });

  if (changed && !dryRun) {
    writeFileSync(filePath, newLines.join('\n'));
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`  Patched: ${patched}`);
console.log(`  Skipped: ${skipped}`);
if (dryRun) console.log('\nDry run. Pass --apply to write.');
