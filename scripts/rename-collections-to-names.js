#!/usr/bin/env node
/**
 * Migration: Rename collection files from {id}.json to {sanitizedName}.json
 *
 * The extension now uses the collection's user-provided name as the filename.
 * This script renames existing files from ID-based to name-based filenames.
 *
 * Usage: node scripts/rename-collections-to-names.js [portal-data-path]
 *   Default path: ~/portal-data
 */

import { readFile, writeFile, rename, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

function sanitizeFilename(name) {
  return name.replace(/\//g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || '_';
}

const portalDir = process.argv[2] || join(process.env.HOME, 'portal-data');
const userDir = join(portalDir, 'lists', 'user');

async function main() {
  console.log(`Renaming collection files in: ${userDir}`);

  if (!existsSync(userDir)) {
    console.log('No lists/user/ directory — nothing to do.');
    return;
  }

  const files = await readdir(userDir);
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'explore.json');

  for (const file of jsonFiles) {
    const filePath = join(userDir, file);
    const data = JSON.parse(await readFile(filePath, 'utf-8'));

    if (!data.name) {
      console.log(`  SKIP ${file} — no name field`);
      continue;
    }

    const newFilename = sanitizeFilename(data.name) + '.json';

    if (file === newFilename) {
      console.log(`  OK   ${file} — already correct`);
      continue;
    }

    const newPath = join(userDir, newFilename);
    if (existsSync(newPath)) {
      console.log(`  SKIP ${file} → ${newFilename} — target already exists!`);
      continue;
    }

    await rename(filePath, newPath);
    console.log(`  MOVE ${file} → ${newFilename}`);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
