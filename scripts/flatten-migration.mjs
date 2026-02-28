#!/usr/bin/env node
/**
 * flatten-migration.mjs — Flatten settings, remove workspace, flatten attention.
 *
 * Changes:
 * 1. settings.json: promote settings.settings.* to root level, delete nested settings key; remove workspace key.
 * 2. JSONL history: expand { action:'set', key:'settings', value:{...} } into individual sub-key entries;
 *    remove { action:'set', key:'workspace', ... } entries.
 * 3. Page entities: parse attention JSON string, promote scrollDepth/timeOnPage/likes to flat fields, delete attention key.
 *
 * Usage:
 *   node scripts/flatten-migration.mjs              # dry run
 *   node scripts/flatten-migration.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const PAGES_DIR = join(DATA_DIR, 'pages');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const dryRun = !process.argv.includes('--apply');
if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

let totalChanges = 0;

// ---------------------------------------------------------------------------
// (1) Flatten settings.json: promote settings.settings.* to root, remove workspace
// ---------------------------------------------------------------------------

if (existsSync(SETTINGS_FILE)) {
  const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  let changed = false;

  // Promote nested settings.settings.* to root
  if (settings.settings && typeof settings.settings === 'object') {
    const nested = settings.settings;
    for (const [k, v] of Object.entries(nested)) {
      if (settings[k] === undefined) {
        settings[k] = v;
        console.log(`  settings.json: promoted settings.${k} = ${JSON.stringify(v)}`);
      } else {
        console.log(`  settings.json: skipped settings.${k} (already exists at root)`);
      }
    }
    delete settings.settings;
    changed = true;
    console.log('  settings.json: deleted nested "settings" key');
  }

  // Remove workspace
  if ('workspace' in settings) {
    delete settings.workspace;
    changed = true;
    console.log('  settings.json: deleted "workspace" key');
  }

  if (changed) {
    totalChanges++;
    if (!dryRun) {
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
    }
    console.log(`  settings.json: ${dryRun ? 'would write' : 'written'}`);
  } else {
    console.log('  settings.json: no changes needed');
  }
} else {
  console.log('  settings.json: not found, skipping');
}

// ---------------------------------------------------------------------------
// (2) JSONL history: expand set/settings entries, remove set/workspace entries
// ---------------------------------------------------------------------------

if (existsSync(HISTORY_DIR)) {
  const historyFiles = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`\nProcessing ${historyFiles.length} history files...`);

  for (const file of historyFiles) {
    const filePath = join(HISTORY_DIR, file);
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    const outputLines = [];
    let fileChanged = false;

    for (const line of lines) {
      if (line.trim() === '') continue;
      let entry;
      try { entry = JSON.parse(line); } catch { outputLines.push(line); continue; }

      if (entry.action === 'set' && entry.key === 'settings' && typeof entry.value === 'object') {
        // Expand into individual sub-key entries
        for (const [subKey, subValue] of Object.entries(entry.value)) {
          const expanded = { timestamp: entry.timestamp, action: 'set', key: subKey, value: subValue };
          outputLines.push(JSON.stringify(expanded));
        }
        fileChanged = true;
        console.log(`  ${file}: expanded set/settings entry (${Object.keys(entry.value).length} sub-keys)`);
      } else if (entry.action === 'set' && entry.key === 'workspace') {
        // Remove workspace entries
        fileChanged = true;
        console.log(`  ${file}: removed set/workspace entry`);
      } else {
        outputLines.push(line);
      }
    }

    if (fileChanged) {
      totalChanges++;
      if (!dryRun) {
        writeFileSync(filePath, outputLines.join('\n') + '\n');
      }
      console.log(`  ${file}: ${dryRun ? 'would write' : 'written'} (${outputLines.length} lines)`);
    }
  }
} else {
  console.log('\n  history/ directory not found, skipping');
}

// ---------------------------------------------------------------------------
// (3) Page entities: flatten attention JSON string to flat fields
// ---------------------------------------------------------------------------

if (existsSync(PAGES_DIR)) {
  const pageDirs = readdirSync(PAGES_DIR).filter(d => {
    try { return statSync(join(PAGES_DIR, d)).isDirectory(); } catch { return false; }
  });
  console.log(`\nProcessing ${pageDirs.length} page directories...`);

  let pagesChanged = 0;
  for (const dir of pageDirs) {
    const pageDir = join(PAGES_DIR, dir);
    const jsonFiles = readdirSync(pageDir).filter(f => f.endsWith('.json'));

    for (const jsonFile of jsonFiles) {
      const filePath = join(pageDir, jsonFile);
      let entity;
      try { entity = JSON.parse(readFileSync(filePath, 'utf-8')); } catch { continue; }

      if ('attention' in entity) {
        let att = {};
        if (typeof entity.attention === 'string' && entity.attention !== '') {
          try { att = JSON.parse(entity.attention); } catch {}
        } else if (typeof entity.attention === 'object' && entity.attention !== null) {
          att = entity.attention;
        }

        // Promote flat fields
        if (att.scrollDepth !== undefined) entity.scrollDepth = att.scrollDepth;
        if (att.timeOnPage !== undefined) entity.timeOnPage = att.timeOnPage;
        if (att.likes !== undefined) entity.likes = att.likes;

        // Delete the old attention field
        delete entity.attention;

        pagesChanged++;
        if (!dryRun) {
          writeFileSync(filePath, JSON.stringify(entity, null, 2) + '\n');
        }
      }
    }
  }

  if (pagesChanged > 0) {
    totalChanges += pagesChanged;
    console.log(`  ${pagesChanged} page entities ${dryRun ? 'would be' : ''} updated`);
  } else {
    console.log('  No page entities needed attention flattening');
  }
} else {
  console.log('\n  pages/ directory not found, skipping');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== ${dryRun ? 'DRY RUN' : 'APPLIED'}: ${totalChanges} changes ===`);
if (dryRun && totalChanges > 0) {
  console.log('Run with --apply to write changes.');
}
