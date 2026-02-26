#!/usr/bin/env node
/**
 * Categorize "existing-only" pages and notes: entities on disk but not produced by replay.
 * Outputs reports to /tmp/existing-only-pages.json and /tmp/existing-only-notes.json
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'history');

// Load all history entries
const allEntries = [];
for (const f of readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(HISTORY_DIR, f), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try { allEntries.push(JSON.parse(line)); } catch {}
  }
}

// === PAGES ===
console.log('=== PAGES ===');
const pagesDir = join(DATA_DIR, 'pages');
const replayPagesDir = '/tmp/portal-replay/pages';
const diskPageSlugs = readdirSync(pagesDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
const replayPageSlugs = new Set(readdirSync(replayPagesDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')));

const pageResults = [];
for (const slug of diskPageSlugs) {
  if (replayPageSlugs.has(slug)) continue;
  const entity = JSON.parse(readFileSync(join(pagesDir, `${slug}.json`), 'utf-8'));
  const url = entity.url || '';

  // Check snapshots
  const snapshotDir = join(pagesDir, slug);
  let snapshotFiles = [];
  if (existsSync(snapshotDir)) {
    try { snapshotFiles = readdirSync(snapshotDir).filter(f => f.endsWith('.md') || f.endsWith('.html')); } catch {}
  }

  // Check history
  const checkpointCount = allEntries.filter(e => e.action === 'page_checkpoint' && e.url === url).length;
  const pageCount = allEntries.filter(e => e.action === 'page' && e.url === url).length;

  pageResults.push({
    slug, url,
    hasSnapshots: snapshotFiles.length > 0,
    snapshotFiles,
    hasCheckpointEntry: checkpointCount > 0,
    pageEntryCount: pageCount,
    timestamp: entity.timestamp || 0,
    title: entity.title,
    attention: entity.attention,
    parentIds: entity.parentIds,
    childIds: entity.childIds,
    recommendation: snapshotFiles.length > 0 ? 'checkpoint' : (pageCount > 0 ? 'checkpoint' : 'shallow'),
  });
}
pageResults.sort((a, b) => a.slug.localeCompare(b.slug));

writeFileSync('/tmp/existing-only-pages.json', JSON.stringify(pageResults, null, 2) + '\n');

const cp = pageResults.filter(r => r.recommendation === 'checkpoint').length;
const sh = pageResults.filter(r => r.recommendation === 'shallow').length;
console.log(`  Total: ${pageResults.length}, checkpoint=${cp}, shallow=${sh}`);
console.log(`  With snapshots: ${pageResults.filter(r => r.hasSnapshots).length}`);
console.log(`  With page entries: ${pageResults.filter(r => r.pageEntryCount > 0).length}`);
console.log(`  With page_checkpoint entries: ${pageResults.filter(r => r.hasCheckpointEntry).length}`);

// === NOTES ===
console.log('\n=== NOTES ===');
const notesDir = join(DATA_DIR, 'notes');
const replayNotesDir = '/tmp/portal-replay/notes';
const diskNoteSlugs = readdirSync(notesDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
const replayNoteSlugs = new Set(
  existsSync(replayNotesDir)
    ? readdirSync(replayNotesDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    : []
);

const noteResults = [];
for (const slug of diskNoteSlugs) {
  if (replayNoteSlugs.has(slug)) continue;
  const entity = JSON.parse(readFileSync(join(notesDir, `${slug}.json`), 'utf-8'));
  const historyCount = allEntries.filter(e => e.action === 'note' && e.slug === slug).length;

  noteResults.push({
    slug,
    timestamp: entity.timestamp,
    excerpt: entity.excerpt,
    note: entity.note,
    cssPath: entity.cssPath,
    parentIds: entity.parentIds,
    childIds: entity.childIds,
    historyEntryCount: historyCount,
  });
}
noteResults.sort((a, b) => a.slug.localeCompare(b.slug));

writeFileSync('/tmp/existing-only-notes.json', JSON.stringify(noteResults, null, 2) + '\n');

console.log(`  Total: ${noteResults.length}`);
console.log(`  With history entries: ${noteResults.filter(n => n.historyEntryCount > 0).length}`);
console.log(`  Without history entries: ${noteResults.filter(n => n.historyEntryCount === 0).length}`);
