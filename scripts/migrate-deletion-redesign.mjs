#!/usr/bin/env node
/**
 * migrate-deletion-redesign.mjs — Data migration for the deletion system redesign.
 *
 * Changes:
 * 1. Strip old recycle-bin and permanent-deletes log entries from JSONL history.
 *    These used `action: 'list'` with `id: 'system/recycle-bin'` or `id: 'system/permanent-deletes'`.
 *    The new code no longer replays these — they'd route to `applyLogToPins` and produce garbage.
 *
 * 2. Strip inlined content from old `note` log entries.
 *    Old entries carry excerpt, note, cssPath, childIds. New replay only reads slug + parentIds.
 *    Content is already on disk in notes/<slug>.json files.
 *
 * 3. Delete entity files: lists/system/recycle-bin.json, lists/system/permanent-deletes.json.
 *    These entities are no longer used.
 *
 * 4. Delete the deleted/ directory (old soft-delete staging).
 *    Files moved here by the old system are no longer tracked.
 *
 * Usage:
 *   node scripts/migrate-deletion-redesign.mjs              # dry run
 *   node scripts/migrate-deletion-redesign.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// 1. Strip old recycle-bin / permanent-deletes entries from JSONL
// 2. Strip inlined content from old note entries
// ---------------------------------------------------------------------------
const historyFiles = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();
let totalStripped = 0;
let totalNotesCleaned = 0;
let totalFilesModified = 0;

for (const file of historyFiles) {
  const filePath = join(HISTORY_DIR, file);
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let modified = false;
  const output = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { output.push(line); continue; }

    // Strip recycle-bin and permanent-deletes entries
    if (entry.action === 'list' &&
        (entry.id === 'system/recycle-bin' || entry.id === 'system/permanent-deletes')) {
      totalStripped++;
      modified = true;
      continue; // skip this entry entirely
    }

    // Strip inlined content from old note entries (keep slug + parentIds only)
    if (entry.action === 'note' && (entry.excerpt !== undefined || entry.note !== undefined || entry.cssPath !== undefined)) {
      const cleaned = {
        timestamp: entry.timestamp,
        action: 'note',
        slug: entry.slug,
      };
      if (entry.parentIds) cleaned.parentIds = entry.parentIds;
      output.push(JSON.stringify(cleaned));
      totalNotesCleaned++;
      modified = true;
      continue;
    }

    output.push(line);
  }

  if (modified) {
    totalFilesModified++;
    console.log(`  ${file}: ${modified ? 'modified' : 'unchanged'}`);
    if (!dryRun) {
      writeFileSync(filePath, output.join('\n') + '\n');
    }
  }
}

console.log(`\nHistory: ${totalStripped} recycle/permanent-delete entries stripped, ${totalNotesCleaned} note entries cleaned, ${totalFilesModified} files modified.\n`);

// ---------------------------------------------------------------------------
// 3. Delete old entity files
// ---------------------------------------------------------------------------
const filesToDelete = [
  join(DATA_DIR, 'lists/system/recycle-bin.json'),
  join(DATA_DIR, 'lists/system/permanent-deletes.json'),
];

for (const filePath of filesToDelete) {
  if (existsSync(filePath)) {
    console.log(`  Delete: ${filePath}`);
    if (!dryRun) unlinkSync(filePath);
  } else {
    console.log(`  Already gone: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Delete old deleted/ directory
// ---------------------------------------------------------------------------
const deletedDir = join(DATA_DIR, 'deleted');
if (existsSync(deletedDir)) {
  const contents = readdirSync(deletedDir);
  console.log(`\n  Delete: ${deletedDir}/ (${contents.length} files)`);
  if (contents.length > 0) {
    console.log(`    Contents: ${contents.join(', ')}`);
  }
  if (!dryRun) rmSync(deletedDir, { recursive: true });
} else {
  console.log(`\n  Already gone: ${deletedDir}/`);
}

console.log(dryRun ? '\n=== DRY RUN COMPLETE (pass --apply to write) ===' : '\n=== MIGRATION APPLIED ===');
