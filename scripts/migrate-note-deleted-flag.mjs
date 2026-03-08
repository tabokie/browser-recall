#!/usr/bin/env node
/**
 * migrate-note-deleted-flag.mjs — Add `deleted: true` to orphaned note entities.
 *
 * Background: del_note now sets `deleted: true` on the note entity (matching
 * how del_list marks lists). Existing orphaned notes lack this flag, so
 * readCacheable() would still return them as live entities.
 *
 * What it does:
 * 1. Read lists/system/orphaned.json to find orphaned note keys.
 * 2. For each note:<slug> in the orphaned list, load notes/<slug>.json.
 * 3. If the entity exists and doesn't already have `deleted: true`, add it.
 *
 * Usage:
 *   node scripts/migrate-note-deleted-flag.mjs              # dry run
 *   node scripts/migrate-note-deleted-flag.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// 1. Load orphaned list
const orphanedPath = join(DATA_DIR, 'lists', 'system', 'orphaned.json');
if (!existsSync(orphanedPath)) {
  console.log('No orphaned.json found — nothing to migrate.');
  process.exit(0);
}

const orphaned = JSON.parse(readFileSync(orphanedPath, 'utf-8'));
const noteKeys = (orphaned.keys || []).filter(k => k.startsWith('note:'));

if (noteKeys.length === 0) {
  console.log('No orphaned notes found — nothing to migrate.');
  process.exit(0);
}

console.log(`Found ${noteKeys.length} orphaned note key(s).\n`);

// 2. Add deleted: true to each orphaned note entity
let updated = 0;
let missing = 0;
let alreadyDeleted = 0;

for (const key of noteKeys) {
  const slug = key.slice(5); // strip 'note:'
  const notePath = join(DATA_DIR, 'notes', slug + '.json');

  if (!existsSync(notePath)) {
    console.log(`  SKIP ${key} — file not found (already physically deleted)`);
    missing++;
    continue;
  }

  const entity = JSON.parse(readFileSync(notePath, 'utf-8'));

  if (entity.deleted === true) {
    console.log(`  SKIP ${key} — already has deleted: true`);
    alreadyDeleted++;
    continue;
  }

  entity.deleted = true;
  console.log(`  UPDATE ${key} — adding deleted: true`);

  if (!dryRun) {
    writeFileSync(notePath, JSON.stringify(entity, null, 2) + '\n');
  }
  updated++;
}

console.log(`\nSummary: ${updated} updated, ${alreadyDeleted} already flagged, ${missing} missing files.`);
if (dryRun && updated > 0) {
  console.log('\nRe-run with --apply to write changes.');
}
