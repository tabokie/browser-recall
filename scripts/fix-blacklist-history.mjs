#!/usr/bin/env node
/**
 * fix-blacklist-history.mjs — Fix missing urlBlacklist in event log.
 *
 * 1. Prepend an update_setting entry for urlBlacklist with the pre-migration value
 *    to the earliest log file.
 * 2. Remove visit_page/leave_page entries whose url matches the blacklist prefix.
 * 3. Strip referrerUrl from entries where referrerUrl matches the blacklist prefix
 *    but the entry's own url does not.
 *
 * Usage:
 *   node scripts/fix-blacklist-history.mjs              # dry run
 *   node scripts/fix-blacklist-history.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

const BLACKLIST_PREFIX = 'https://gitlab.corp.metabit-trading.com/';
const BLACKLIST_VALUE = [BLACKLIST_PREFIX, 'edge://'];

// The pre-migration settings timestamp from the backup
const SEED_TIMESTAMP = 1770700063618; // Just before the other migrated settings (1770700063619)

const logFiles = readdirSync(LOGS_DIR)
  .filter(f => f.endsWith('.jsonl'))
  .sort();

let removedVisits = 0;
let strippedReferrers = 0;
let settingInserted = false;

for (const file of logFiles) {
  const filePath = join(LOGS_DIR, file);
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  const entries = lines.map(l => JSON.parse(l));
  const newEntries = [];

  // Insert setting at the start of the earliest file
  if (!settingInserted) {
    newEntries.push({
      timestamp: SEED_TIMESTAMP,
      action: 'update_setting',
      key: 'urlBlacklist',
      value: BLACKLIST_VALUE,
    });
    settingInserted = true;
    console.log(`  Inserted update_setting for urlBlacklist in ${file}`);
  }

  for (const entry of entries) {
    const url = entry.url || '';
    const referrerUrl = entry.referrerUrl || '';
    const isBlacklistedUrl = url.startsWith(BLACKLIST_PREFIX);
    const isBlacklistedReferrer = referrerUrl.startsWith(BLACKLIST_PREFIX);

    // Remove visit/leave entries for blacklisted URLs
    if (isBlacklistedUrl && (entry.action === 'visit_page' || entry.action === 'leave_page')) {
      removedVisits++;
      continue;
    }

    // Strip referrerUrl if it points to a blacklisted URL
    if (isBlacklistedReferrer && !isBlacklistedUrl) {
      const cleaned = { ...entry };
      delete cleaned.referrerUrl;
      newEntries.push(cleaned);
      strippedReferrers++;
      continue;
    }

    newEntries.push(entry);
  }

  if (!dryRun) {
    const content = newEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(filePath, content);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`  Setting inserted: ${settingInserted}`);
console.log(`  Visits/leaves removed: ${removedVisits}`);
console.log(`  Referrer URLs stripped: ${strippedReferrers}`);

if (dryRun) {
  console.log('\nDry run complete. Pass --apply to write changes.');
}
