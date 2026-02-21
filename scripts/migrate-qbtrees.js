#!/usr/bin/env node
/**
 * Migration: qbTree → qbTrees (array) in list_meta entries and collection files
 *
 * JSONL history:
 *   - list_meta entries: rename `qbTree` to `qbTrees` (wrap in array)
 *   - list_meta entries missing `name`: add `name: ''`
 *
 * Collection entity files (lists/user/*.json):
 *   - Rename `qbTree` field to `qbTrees` (wrap in array)
 *
 * Usage: node scripts/migrate-qbtrees.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const historyDir = join(dataDir, 'history');
const listsDir = join(dataDir, 'lists', 'user');

// --- Migrate JSONL history ---
if (existsSync(historyDir)) {
  const jsonlFiles = readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`Found ${jsonlFiles.length} JSONL history files`);

  let totalChanged = 0;
  let filesChanged = 0;

  for (const file of jsonlFiles) {
    const text = readFileSync(join(historyDir, file), 'utf8');
    const lines = text.split('\n');
    let changed = false;
    const newLines = [];

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }
      try {
        const entry = JSON.parse(line);
        let modified = false;

        if (entry.action === 'list_meta') {
          // qbTree → qbTrees (array)
          if (entry.qbTree !== undefined) {
            entry.qbTrees = entry.qbTree ? [entry.qbTree] : [];
            delete entry.qbTree;
            modified = true;
          }
          // Ensure name is present
          if (entry.name === undefined) {
            entry.name = '';
            modified = true;
          }
        }

        if (modified) {
          newLines.push(JSON.stringify(entry));
          totalChanged++;
          changed = true;
        } else {
          newLines.push(line);
        }
      } catch {
        newLines.push(line);
      }
    }

    if (changed) {
      writeFileSync(join(historyDir, file), newLines.join('\n'));
      filesChanged++;
    }
  }

  console.log(`JSONL: ${totalChanged} entries transformed across ${filesChanged} files`);
} else {
  console.log('No history directory found, skipping JSONL migration.');
}

// --- Migrate collection entity files ---
if (existsSync(listsDir)) {
  const jsonFiles = readdirSync(listsDir).filter(f => f.endsWith('.json'));
  console.log(`Found ${jsonFiles.length} collection files`);

  let filesChanged = 0;

  for (const file of jsonFiles) {
    const path = join(listsDir, file);
    const text = readFileSync(path, 'utf8');
    try {
      const data = JSON.parse(text);
      if (data.qbTree !== undefined) {
        data.qbTrees = data.qbTree ? [data.qbTree] : [];
        delete data.qbTree;
        writeFileSync(path, JSON.stringify(data, null, 2));
        filesChanged++;
      }
    } catch { /* skip malformed */ }
  }

  console.log(`Collection files: ${filesChanged} files transformed`);
} else {
  console.log('No lists/user directory found, skipping collection file migration.');
}
