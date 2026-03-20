#!/usr/bin/env node
/**
 * fix-cumulative-time.mjs — Convert cumulative timeOnPage values to deltas.
 *
 * Bug: content.js sent Date.now() - startTime (cumulative since page load) on every
 * leave_page event. Multiple fires (tab switch away, tab close) caused overcounting
 * when replay accumulated these values.
 *
 * Fix: For consecutive leave_page entries for the same URL within a session
 * (between visit_page events), convert cumulative values to deltas:
 *   - 1st leave_page in session: keep as-is (correct delta from page load)
 *   - Nth leave_page: delta = cumulative_N - cumulative_(N-1)
 *
 * Note: this does not retroactively separate foreground from background time
 * (impossible without visibility change timestamps). It only fixes double-counting.
 *
 * Usage:
 *   node scripts/fix-cumulative-time.mjs              # dry run
 *   node scripts/fix-cumulative-time.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'data', 'logs');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// Load all history files
const historyFiles = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();
const fileEntries = new Map(); // filename -> entry[]
let totalEntries = 0;

for (const file of historyFiles) {
  const entries = [];
  for (const line of readFileSync(join(HISTORY_DIR, file), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  fileEntries.set(file, entries);
  totalEntries += entries.length;
}
console.log(`Loaded ${totalEntries} entries from ${historyFiles.length} files`);

// Process all entries chronologically across files.
// Track per-URL: the last cumulative timeOnPage in the current session.
const lastCumulative = new Map(); // url -> cumulative timeOnPage from previous leave_page
let fixCount = 0;
let sessionResets = 0;

// Process files in order (already sorted by date)
for (const file of historyFiles) {
  const entries = fileEntries.get(file);
  for (const entry of entries) {
    // visit_page resets the session for this URL (new content script instance)
    if (entry.action === 'visit_page' && entry.url) {
      if (lastCumulative.has(entry.url)) {
        lastCumulative.delete(entry.url);
        sessionResets++;
      }
      continue;
    }

    if (entry.action !== 'leave_page' || !entry.url || entry.timeOnPage === undefined) continue;

    const prevCumulative = lastCumulative.get(entry.url);
    if (prevCumulative !== undefined) {
      // Subsequent leave_page in same session: convert cumulative to delta
      const delta = Math.max(0, entry.timeOnPage - prevCumulative);
      if (delta !== entry.timeOnPage) {
        console.log(`  ${file}: ${entry.url.slice(0, 60)} timeOnPage ${entry.timeOnPage} → ${delta} (prev cumulative: ${prevCumulative})`);
        // Store original before mutating (for delta computation of next entry)
        const originalCumulative = entry.timeOnPage;
        entry.timeOnPage = delta;
        lastCumulative.set(entry.url, originalCumulative);
        fixCount++;
      }
    } else {
      // First leave_page in session: keep as-is, record cumulative
      lastCumulative.set(entry.url, entry.timeOnPage);
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`  Session resets (visit_page): ${sessionResets}`);
console.log(`  Entries fixed: ${fixCount}`);

if (fixCount === 0) {
  console.log('\nNothing to fix.');
  process.exit(0);
}

if (dryRun) {
  console.log('\nDry run complete. Pass --apply to write changes.');
  process.exit(0);
}

// Write back
let totalWritten = 0;
for (const [file, entries] of fileEntries) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(HISTORY_DIR, file), content);
  totalWritten += entries.length;
}

console.log(`\nWrote ${totalWritten} entries across ${fileEntries.size} files.`);
console.log('Done. Re-run replay-verify.mjs to rebuild entities from fixed history.');
