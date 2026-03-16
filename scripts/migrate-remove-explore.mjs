#!/usr/bin/env node
/**
 * migrate-remove-explore.mjs — Remove explore entity and savedSearches from data model.
 *
 * Changes:
 * 1. Strip `savedSearches` field from all list entity files.
 * 2. Strip `savedSearches` field from update_list log entries in JSONL history.
 * 3. Delete lists/system/explore.json entity file.
 * 4. Remove log entries targeting the explore list:
 *    - pin_to_list / unpin_from_list with parents=['Explore'] (explore pins)
 *    - update_list with parents=[] and name='Explore' (explore savedSearches updates)
 *    - create_list with parents=[] and name='Explore'
 *
 * Usage:
 *   node scripts/migrate-remove-explore.mjs              # dry run
 *   node scripts/migrate-remove-explore.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'data', 'logs');
const LISTS_DIR = join(DATA_DIR, 'lists');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// 1. Strip savedSearches from list entity files
// ---------------------------------------------------------------------------
let listFilesModified = 0;

function stripSavedSearchesFromDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      stripSavedSearchesFromDir(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const filePath = join(dir, entry.name);
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if ('savedSearches' in data) {
        delete data.savedSearches;
        console.log(`  Strip savedSearches from ${filePath}`);
        if (!dryRun) writeFileSync(filePath, JSON.stringify(data, null, 2));
        listFilesModified++;
      }
    } catch {}
  }
}

console.log('--- Step 1: Strip savedSearches from list entity files ---');
stripSavedSearchesFromDir(LISTS_DIR);
console.log(`  Modified: ${listFilesModified} files\n`);

// ---------------------------------------------------------------------------
// 2 & 4. Process JSONL history — strip savedSearches, remove explore entries
// ---------------------------------------------------------------------------
console.log('--- Step 2: Process JSONL history ---');

// Identity-only fields that carry no meaningful update payload on their own.
const UPDATE_LIST_IDENTITY_FIELDS = new Set(['action', 'timestamp', 'ts', 'parents', 'name']);

function isExploreEntry(entry) {
  const parents = entry.parents || [];
  const name = entry.name || '';
  const isPinOp = entry.action === 'pin_to_list' || entry.action === 'unpin_from_list';

  // Pin ops targeting the Explore system list as parent.
  if (isPinOp && parents.length === 1 && parents[0] === 'Explore') return true;

  // create_list / update_list that IS the Explore entity itself (parents=[], name='Explore').
  // Note: create_list with parents=['Explore'] means a user list nested under Explore — preserve those.
  if (!isPinOp && parents.length === 0 && name === 'Explore') return true;

  return false;
}

// Returns true if an update_list entry has no meaningful payload beyond identity fields.
function isUpdateListNoOp(entry) {
  return Object.keys(entry).every(k => UPDATE_LIST_IDENTITY_FIELDS.has(k));
}

let totalExploreRemoved = 0;
let totalSavedSearchesStripped = 0;
let historyFilesModified = 0;

if (existsSync(HISTORY_DIR)) {
  const historyFiles = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();

  for (const file of historyFiles) {
    const filePath = join(HISTORY_DIR, file);
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    let modified = false;
    const newLines = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Remove explore-targeted entries
        if (['pin_to_list', 'unpin_from_list', 'update_list', 'create_list'].includes(entry.action) && isExploreEntry(entry)) {
          console.log(`  Remove explore entry: ${entry.action} in ${file}`);
          totalExploreRemoved++;
          modified = true;
          continue;
        }

        // Strip savedSearches from update_list entries; remove if it was the only payload.
        if (entry.action === 'update_list' && 'savedSearches' in entry) {
          delete entry.savedSearches;
          totalSavedSearchesStripped++;
          modified = true;
          if (isUpdateListNoOp(entry)) {
            console.log(`  Remove savedSearches-only update_list no-op in ${file}`);
            continue;
          }
          newLines.push(JSON.stringify(entry));
          continue;
        }

        newLines.push(line);
      } catch {
        newLines.push(line);
      }
    }

    if (modified) {
      historyFilesModified++;
      if (newLines.length === 0) {
        console.log(`  Delete now-empty log file: ${file}`);
        if (!dryRun) unlinkSync(filePath);
      } else {
        if (!dryRun) writeFileSync(filePath, newLines.join('\n') + '\n');
      }
    }
  }
}

console.log(`  Explore entries removed: ${totalExploreRemoved}`);
console.log(`  savedSearches stripped from update_list: ${totalSavedSearchesStripped}`);
console.log(`  History files modified: ${historyFilesModified}\n`);

// ---------------------------------------------------------------------------
// 3. Delete lists/system/explore.json
// ---------------------------------------------------------------------------
console.log('--- Step 3: Delete explore entity file ---');
const explorePath = join(LISTS_DIR, 'system', 'explore.json');
if (existsSync(explorePath)) {
  console.log(`  Delete ${explorePath}`);
  if (!dryRun) unlinkSync(explorePath);
} else {
  console.log('  explore.json not found (already deleted or never existed)');
}

console.log('\n--- Summary ---');
console.log(`  List files modified: ${listFilesModified}`);
console.log(`  Explore log entries removed: ${totalExploreRemoved}`);
console.log(`  savedSearches stripped from logs: ${totalSavedSearchesStripped}`);
console.log(`  History files modified: ${historyFilesModified}`);
if (dryRun) console.log('\n=== DRY RUN — no files were modified. Pass --apply to apply. ===');
