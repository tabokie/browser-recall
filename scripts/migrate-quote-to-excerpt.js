#!/usr/bin/env node
/**
 * Migrate "quote" → "excerpt" in portal-data:
 * 1. JSONL history log entries (action='note' with "quote" field)
 * 2. Note entity checkpoint files (notes/*.json)
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(os.homedir(), 'portal-data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const NOTES_DIR = path.join(DATA_DIR, 'notes');

let logEntriesChanged = 0;
let noteFilesChanged = 0;

// 1. Migrate JSONL history files
const histFiles = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl'));
for (const file of histFiles) {
  const filePath = path.join(HISTORY_DIR, file);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let changed = false;
  const newLines = lines.map(line => {
    if (!line) return line;
    try {
      const entry = JSON.parse(line);
      if ('quote' in entry) {
        entry.excerpt = entry.quote;
        delete entry.quote;
        changed = true;
        logEntriesChanged++;
        return JSON.stringify(entry);
      }
    } catch (e) { /* skip malformed */ }
    return line;
  });
  if (changed) {
    fs.writeFileSync(filePath, newLines.join('\n'));
  }
}

// 2. Migrate note entity files
const noteFiles = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.json'));
for (const file of noteFiles) {
  const filePath = path.join(NOTES_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    const entity = JSON.parse(content);
    if ('quote' in entity) {
      entity.excerpt = entity.quote;
      delete entity.quote;
      fs.writeFileSync(filePath, JSON.stringify(entity, null, 2));
      noteFilesChanged++;
    }
  } catch (e) {
    console.error(`Failed to parse ${file}:`, e.message);
  }
}

console.log(`Done. Migrated ${logEntriesChanged} log entries, ${noteFilesChanged} note files.`);
