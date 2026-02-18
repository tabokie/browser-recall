#!/usr/bin/env node
/**
 * Cleanup: Remove redundant "set collections" entries from JSONL history.
 *
 * The old code wrote `{ action: "set", key: "collections", value: [...] }`
 * on every sidebar render, producing many near-identical entries. The new code
 * uses `collection_meta` actions and self-describing files, making these dead entries.
 *
 * This script removes all `set key=collections` entries from JSONL files,
 * since they are no longer consumed by any code path.
 *
 * Usage: node scripts/deduplicate-collection-entries.js [portal-data-path]
 *   Default path: ~/portal-data
 */

import { readFile, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const portalDir = process.argv[2] || join(process.env.HOME, 'portal-data');
const historyDir = join(portalDir, 'history');

async function main() {
  console.log(`Cleaning JSONL in: ${historyDir}`);

  if (!existsSync(historyDir)) {
    console.log('No history/ directory — nothing to do.');
    return;
  }

  const files = (await readdir(historyDir)).filter(f => f.endsWith('.jsonl')).sort();
  let totalRemoved = 0;

  for (const file of files) {
    const filePath = join(historyDir, file);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    let removed = 0;
    const filtered = lines.filter(line => {
      if (!line.trim()) return true; // keep empty lines
      try {
        const entry = JSON.parse(line);
        if (entry.action === 'set' && entry.key === 'collections') {
          removed++;
          return false;
        }
      } catch {}
      return true;
    });

    if (removed > 0) {
      await writeFile(filePath, filtered.join('\n'), 'utf-8');
      console.log(`  ${file}: removed ${removed} "set collections" entries`);
      totalRemoved += removed;
    }
  }

  console.log(`\nDone! Removed ${totalRemoved} entries total.`);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
