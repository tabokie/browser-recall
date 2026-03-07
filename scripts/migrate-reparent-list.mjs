/**
 * Migration: list_meta { reparent } → reparent_list (flat fields)
 *
 * Rewrites history JSONL entries of the form:
 *   { action: "list_meta", id, reparent: { from, to, index }, ... }
 * to:
 *   { action: "reparent_list", id, from, to, index, timestamp }
 *
 * Idempotent: skips files with no matching entries.
 * Pass --apply to write changes; omit for dry-run.
 */

import fs from 'node:fs';
import path from 'node:path';

const HISTORY_DIR = path.join(process.env.HOME, 'portal-data', 'history');
const DRY_RUN = !process.argv.includes('--apply');

if (DRY_RUN) console.log('[dry-run] Pass --apply to write changes.\n');

let totalConverted = 0;

for (const file of fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  const filePath = path.join(HISTORY_DIR, file);
  const lines = fs.readFileSync(filePath, 'utf-8').trimEnd().split('\n');
  let changed = false;
  const newLines = lines.map(line => {
    let entry;
    try { entry = JSON.parse(line); } catch { return line; }
    if (entry.action !== 'list_meta' || !entry.reparent) return line;
    const { from, to, index } = entry.reparent;
    const converted = { timestamp: entry.timestamp, action: 'reparent_list', id: entry.id, from, to, index };
    changed = true;
    totalConverted++;
    return JSON.stringify(converted);
  });

  if (!changed) continue;
  console.log(`${DRY_RUN ? '[dry-run] would update' : 'Updated'}: ${file} (${newLines.filter((l, i) => l !== lines[i]).length} entries)`);
  if (!DRY_RUN) fs.writeFileSync(filePath, newLines.join('\n') + '\n');
}

console.log(`\n${totalConverted} entries ${DRY_RUN ? 'would be' : ''} converted.`);
