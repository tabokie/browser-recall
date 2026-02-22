#!/usr/bin/env node
/**
 * Migration: Rename "collection" terminology to "list" in persistent data.
 *
 * 1. settings.json: collectionOrder → listOrder, workspace.collectionIds → workspace.listIds
 * 2. history/*.jsonl: set key=collectionOrder → key=listOrder,
 *    set key=workspace value.collectionIds → value.listIds
 *
 * Idempotent: safe to run multiple times — skips already-renamed keys.
 *
 * Usage: node scripts/rename-collection-to-list.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const settingsPath = join(dataDir, 'settings.json');
const historyDir = join(dataDir, 'history');

// --- 1. Migrate settings.json ---
if (existsSync(settingsPath)) {
  console.log(`Reading ${settingsPath}`);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  let changed = false;

  // collectionOrder → listOrder
  if ('collectionOrder' in settings && !('listOrder' in settings)) {
    settings.listOrder = settings.collectionOrder;
    delete settings.collectionOrder;
    changed = true;
    console.log('  Renamed collectionOrder → listOrder');
  } else if ('collectionOrder' in settings && 'listOrder' in settings) {
    // Both exist — drop the old one (listOrder wins)
    delete settings.collectionOrder;
    changed = true;
    console.log('  Removed stale collectionOrder (listOrder already present)');
  }

  // workspace.collectionIds → workspace.listIds
  if (settings.workspace && 'collectionIds' in settings.workspace && !('listIds' in settings.workspace)) {
    settings.workspace.listIds = settings.workspace.collectionIds;
    delete settings.workspace.collectionIds;
    changed = true;
    console.log('  Renamed workspace.collectionIds → workspace.listIds');
  } else if (settings.workspace && 'collectionIds' in settings.workspace && 'listIds' in settings.workspace) {
    delete settings.workspace.collectionIds;
    changed = true;
    console.log('  Removed stale workspace.collectionIds (listIds already present)');
  }

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('  settings.json updated');
  } else {
    console.log('  settings.json already up to date');
  }
} else {
  console.log(`No settings.json found at ${settingsPath}, skipping.`);
}

// --- 2. Migrate JSONL history files ---
if (existsSync(historyDir)) {
  const jsonlFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`\nProcessing ${jsonlFiles.length} JSONL history files`);

  let totalChanged = 0;
  let filesChanged = 0;

  for (const file of jsonlFiles) {
    const filePath = join(historyDir, file);
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    let fileModified = false;
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }
      try {
        const entry = JSON.parse(line);
        let entryModified = false;

        if (entry.action === 'set') {
          // collectionOrder → listOrder
          if (entry.key === 'collectionOrder') {
            entry.key = 'listOrder';
            entryModified = true;
          }

          // workspace value: collectionIds → listIds
          if (entry.key === 'workspace' && entry.value && typeof entry.value === 'object') {
            if ('collectionIds' in entry.value && !('listIds' in entry.value)) {
              entry.value.listIds = entry.value.collectionIds;
              delete entry.value.collectionIds;
              entryModified = true;
            } else if ('collectionIds' in entry.value && 'listIds' in entry.value) {
              delete entry.value.collectionIds;
              entryModified = true;
            }
          }
        }

        if (entryModified) {
          newLines.push(JSON.stringify(entry));
          totalChanged++;
          fileModified = true;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    }

    if (fileModified) {
      writeFileSync(filePath, newLines.join('\n'));
      filesChanged++;
      console.log(`  ${file}: modified`);
    }
  }

  console.log(`\nJSONL: ${totalChanged} entries changed across ${filesChanged} files`);
} else {
  console.log(`\nNo history directory at ${historyDir}, skipping.`);
}

console.log('\nDone.');
