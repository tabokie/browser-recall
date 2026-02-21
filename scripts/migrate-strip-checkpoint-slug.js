#!/usr/bin/env node
/**
 * Migration: Strip slug from page_checkpoint entries
 *
 * Removes the redundant `slug` field from `page_checkpoint` log entries.
 * The slug is always derivable from the `url` field via generateSlugFromUrl.
 *
 * Usage: node scripts/migrate-strip-checkpoint-slug.js [portal-data-path]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const dataDir = resolve(process.argv[2] || join(process.env.HOME, 'portal-data'));
const historyDir = join(dataDir, 'history');

if (!existsSync(historyDir)) {
  console.log('No history directory found, nothing to migrate.');
  process.exit(0);
}

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
      if (entry.action === 'page_checkpoint' && entry.slug !== undefined) {
        delete entry.slug;
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

console.log(`Done: ${totalChanged} entries stripped across ${filesChanged} files`);
