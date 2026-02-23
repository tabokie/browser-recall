#!/usr/bin/env node
/**
 * Migration: Rename list checkpoint files from sanitized-name to list ID.
 *
 * Before: lists/user/{sanitized-name}.json  (e.g. "Daily Bread.json")
 * After:  lists/user/{id}.json              (e.g. "jandan-3ohvjd.json")
 *
 * When duplicates exist (same id in multiple files), keeps the one with the
 * latest timestamp and deletes the rest.
 *
 * Idempotent: files already named by ID are left untouched.
 *
 * Usage: node scripts/migrate-list-filenames-to-id.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const userDir = join(dataDir, 'lists', 'user');

if (!existsSync(userDir)) {
  console.log('No lists/user/ directory found, nothing to do.');
  process.exit(0);
}

const files = readdirSync(userDir).filter(f => f.endsWith('.json'));

// Group files by their internal id
const byId = new Map(); // id → [{ filename, data }]
for (const filename of files) {
  const filepath = join(userDir, filename);
  try {
    const data = JSON.parse(readFileSync(filepath, 'utf8'));
    const id = data.id || filename.replace('.json', '');
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ filename, filepath, data });
  } catch (e) {
    console.warn(`Skipping malformed file: ${filename} (${e.message})`);
  }
}

let renamed = 0;
let deleted = 0;

for (const [id, entries] of byId) {
  const targetFilename = `${id}.json`;
  const targetPath = join(userDir, targetFilename);

  // Pick the entry with the latest timestamp as the winner
  entries.sort((a, b) => (b.data.timestamp || 0) - (a.data.timestamp || 0));
  const winner = entries[0];

  // Delete duplicates (everything except the winner)
  for (let i = 1; i < entries.length; i++) {
    console.log(`  DELETE duplicate: ${entries[i].filename} (id=${id})`);
    unlinkSync(entries[i].filepath);
    deleted++;
  }

  // Rename winner if needed
  if (winner.filename === targetFilename) {
    // Already correctly named
    continue;
  }

  console.log(`  RENAME: ${winner.filename} → ${targetFilename}`);
  writeFileSync(targetPath, JSON.stringify(winner.data, null, 2));
  unlinkSync(winner.filepath);
  renamed++;
}

console.log(`\nDone. Renamed: ${renamed}, Deleted duplicates: ${deleted}`);
