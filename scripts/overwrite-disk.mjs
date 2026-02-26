#!/usr/bin/env node
/**
 * overwrite-disk.mjs — Overwrite ~/portal-data entity files with replay output.
 *
 * Only touches entity JSON files (pages/*.json, notes/*.json, lists/*.json, settings.json).
 * Does NOT touch history/, snapshots, highlights, or other non-entity files.
 *
 * Usage:
 *   node scripts/overwrite-disk.mjs              # dry run
 *   node scripts/overwrite-disk.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const REPLAY_DIR = '/tmp/portal-replay';
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

let overwrites = 0, creates = 0, deletes = 0, skippedDeleted = 0;

for (const subdir of ['pages', 'notes', 'lists']) {
  const replayDir = join(REPLAY_DIR, subdir);
  const existDir = join(DATA_DIR, subdir);

  // Get replay files
  let replayFiles;
  try { replayFiles = readdirSync(replayDir).filter(f => f.endsWith('.json')); } catch { continue; }

  const replaySet = new Set(replayFiles);

  // Copy replay -> existing
  for (const f of replayFiles) {
    const replayPath = join(replayDir, f);
    const existPath = join(existDir, f);
    const entity = JSON.parse(readFileSync(replayPath, 'utf-8'));

    // Skip deleted entities — they shouldn't have disk files
    if (entity.deleted) {
      skippedDeleted++;
      // If file exists on disk, remove it
      if (existsSync(existPath)) {
        console.log(`  DELETE (marked deleted): ${subdir}/${f}`);
        if (!dryRun) unlinkSync(existPath);
        deletes++;
      }
      continue;
    }

    if (existsSync(existPath)) {
      const existing = readFileSync(existPath, 'utf-8');
      const replayed = JSON.stringify(entity, null, 2) + '\n';
      if (existing === replayed) continue; // already matches
      console.log(`  OVERWRITE: ${subdir}/${f}`);
      if (!dryRun) writeFileSync(existPath, replayed);
      overwrites++;
    } else {
      console.log(`  CREATE: ${subdir}/${f}`);
      if (!dryRun) writeFileSync(existPath, JSON.stringify(entity, null, 2) + '\n');
      creates++;
    }
  }

  // Check for existing-only files (on disk but not in replay)
  let existFiles;
  try { existFiles = readdirSync(existDir).filter(f => f.endsWith('.json')); } catch { continue; }

  for (const f of existFiles) {
    if (!replaySet.has(f)) {
      // Check if it's a case-sensitivity duplicate
      const lower = f.toLowerCase();
      const hasLowerMatch = replayFiles.some(rf => rf.toLowerCase() === lower && rf !== f);
      if (hasLowerMatch) {
        console.log(`  DELETE (case dup): ${subdir}/${f}`);
        if (!dryRun) unlinkSync(join(existDir, f));
        deletes++;
      } else {
        console.log(`  ORPHAN (exists on disk, not in replay): ${subdir}/${f}`);
      }
    }
  }
}

// Settings
const replaySettings = join(REPLAY_DIR, 'settings.json');
const existSettings = join(DATA_DIR, 'settings.json');
if (existsSync(replaySettings)) {
  const rs = readFileSync(replaySettings, 'utf-8');
  const es = existsSync(existSettings) ? readFileSync(existSettings, 'utf-8') : '';
  const replayed = JSON.stringify(JSON.parse(rs), null, 2) + '\n';
  if (es !== replayed) {
    console.log('  OVERWRITE: settings.json');
    if (!dryRun) writeFileSync(existSettings, replayed);
    overwrites++;
  }
}

console.log('\n=== SUMMARY ===');
console.log(`  Overwrites: ${overwrites}`);
console.log(`  Creates: ${creates}`);
console.log(`  Deletes: ${deletes}`);
console.log(`  Skipped (deleted entities): ${skippedDeleted}`);

if (dryRun) console.log('\nDry run. Pass --apply to write.');
