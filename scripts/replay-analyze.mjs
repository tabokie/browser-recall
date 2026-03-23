#!/usr/bin/env node
/**
 * Analyze replay diffs: investigate root causes of mismatches.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');

// Load all entries sorted by timestamp — scan data/logs/<device>/*.jsonl subdirectories
const entries = [];
for (const deviceDir of readdirSync(LOGS_DIR)) {
  const devicePath = join(LOGS_DIR, deviceDir);
  try { if (!readdirSync(devicePath)) continue; } catch { continue; }
  for (const f of readdirSync(devicePath).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(devicePath, f), 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
  }
}
entries.sort((a, b) => a.timestamp - b.timestamp);

// === Analysis 1: Pages with title=undefined in replay but title in existing ===
// These are pages where page_checkpoint came AFTER page entries, so effectOf
// for the page entry returns null (page doesn't exist yet) and skips it.
console.log('=== ANALYSIS 1: page_checkpoint ordering ===\n');

// Find all page_checkpoint URLs and their position
const checkpointPositions = new Map(); // url -> index
const firstPagePositions = new Map(); // url -> index
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  if (e.action === 'page_checkpoint' && e.url) {
    if (!checkpointPositions.has(e.url)) checkpointPositions.set(e.url, i);
  }
  if (e.action === 'page' && e.url) {
    if (!firstPagePositions.has(e.url)) firstPagePositions.set(e.url, i);
  }
}

// Pages where first page entry comes BEFORE page_checkpoint
let pageBeforeCheckpoint = 0;
let pageAfterCheckpoint = 0;
let pageNoCheckpoint = 0;
const examples = [];

for (const [url, pageIdx] of firstPagePositions) {
  const cpIdx = checkpointPositions.get(url);
  if (cpIdx === undefined) {
    pageNoCheckpoint++;
  } else if (pageIdx < cpIdx) {
    pageBeforeCheckpoint++;
    if (examples.length < 3) {
      const slug = generateSlugFromUrl(url);
      const pageEntry = entries[pageIdx];
      const cpEntry = entries[cpIdx];
      examples.push({
        url: url.slice(0, 80),
        slug,
        pageTs: pageEntry.timestamp,
        pageTitle: pageEntry.title,
        cpTs: cpEntry.timestamp,
        cpTitle: cpEntry.title,
        gap: cpEntry.timestamp - pageEntry.timestamp,
      });
    }
  } else {
    pageAfterCheckpoint++;
  }
}

console.log(`  page entry BEFORE checkpoint: ${pageBeforeCheckpoint}`);
console.log(`  page entry AFTER checkpoint:  ${pageAfterCheckpoint}`);
console.log(`  page entry with NO checkpoint: ${pageNoCheckpoint}`);
if (examples.length > 0) {
  console.log('\n  Examples (page before checkpoint):');
  for (const ex of examples) {
    console.log(`    ${ex.slug}:`);
    console.log(`      page entry: ts=${ex.pageTs} title="${ex.pageTitle}"`);
    console.log(`      checkpoint:  ts=${ex.cpTs} title="${ex.cpTitle}"`);
    console.log(`      gap: ${ex.gap}ms`);
  }
}

// === Analysis 2: childIds differences ===
console.log('\n=== ANALYSIS 2: childIds shallow vs page ref differences ===\n');

// For pages with childIds mismatch, check if it's shallow: vs page: resolution
const pagesDir = join(DATA_DIR, 'pages');
let shallowVsPage = 0;
let extraInExisting = 0;
let extraInReplay = 0;
let replayedDir = '/tmp/portal-replay/pages';

if (existsSync(replayedDir)) {
  for (const f of readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
    const replayedPath = join(replayedDir, f);
    if (!existsSync(replayedPath)) continue;
    const existing = JSON.parse(readFileSync(join(pagesDir, f), 'utf-8'));
    const replayed = JSON.parse(readFileSync(replayedPath, 'utf-8'));

    const ec = existing.childIds || [];
    const rc = replayed.childIds || [];

    if (JSON.stringify(ec) === JSON.stringify(rc)) continue;

    // Check: are existing items page:X where replay has shallow:Y?
    for (const eItem of ec) {
      if (!rc.includes(eItem)) {
        // Is there a shallow: equivalent in replay?
        if (eItem.startsWith('page:')) {
          const hasShallow = rc.some(r => r.startsWith('shallow:'));
          if (hasShallow) shallowVsPage++;
          else extraInExisting++;
        } else if (eItem.startsWith('shallow:')) {
          const slug = generateSlugFromUrl(eItem.slice('shallow:'.length));
          if (rc.includes('page:' + slug)) shallowVsPage++;
          else extraInExisting++;
        } else {
          extraInExisting++;
        }
      }
    }
    for (const rItem of rc) {
      if (!ec.includes(rItem)) extraInReplay++;
    }
  }
  console.log(`  shallow: vs page: mismatches: ${shallowVsPage}`);
  console.log(`  extra items in existing only: ${extraInExisting}`);
  console.log(`  extra items in replay only:   ${extraInReplay}`);
}

// === Analysis 3: mdPath/htmlPath — are these from page_checkpoint entries? ===
console.log('\n=== ANALYSIS 3: mdPath/htmlPath missing in replay ===\n');

let checkpointsWithPaths = 0;
let checkpointsWithoutPaths = 0;
for (const e of entries) {
  if (e.action === 'page_checkpoint') {
    if (e.mdPath || e.htmlPath) checkpointsWithPaths++;
    else checkpointsWithoutPaths++;
  }
}
console.log(`  page_checkpoint entries WITH mdPath/htmlPath: ${checkpointsWithPaths}`);
console.log(`  page_checkpoint entries WITHOUT:              ${checkpointsWithoutPaths}`);

// Check: are mdPath/htmlPath set by a different mechanism (captureSnapshot)?
// Look at what action types carry mdPath
const actionsWithMd = new Map();
for (const e of entries) {
  if (e.mdPath || e.htmlPath) {
    const key = e.action;
    actionsWithMd.set(key, (actionsWithMd.get(key) || 0) + 1);
  }
}
console.log('  Actions carrying mdPath/htmlPath:', Object.fromEntries(actionsWithMd));

// === Analysis 4: existing-only pages — are they from before history starts? ===
console.log('\n=== ANALYSIS 4: existing-only entities ===\n');

const historyStart = entries[0]?.timestamp;
console.log(`  History starts at: ${historyStart} (${new Date(historyStart).toISOString()})`);

let beforeHistory = 0;
let afterHistory = 0;
let noTimestamp = 0;
const existingOnlyPages = [];

for (const f of readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  const replayedPath = join(replayedDir, f);
  if (existsSync(replayedPath)) continue;

  const existing = JSON.parse(readFileSync(join(pagesDir, f), 'utf-8'));
  if (!existing.timestamp) { noTimestamp++; continue; }

  if (existing.timestamp < historyStart) {
    beforeHistory++;
  } else {
    afterHistory++;
    existingOnlyPages.push({ slug: existing.slug, ts: existing.timestamp, url: existing.url?.slice(0, 60) });
  }
}
console.log(`  Existing-only pages with timestamp BEFORE history: ${beforeHistory}`);
console.log(`  Existing-only pages with timestamp AFTER history start: ${afterHistory}`);
console.log(`  Existing-only pages with no timestamp: ${noTimestamp}`);

if (existingOnlyPages.length > 0) {
  console.log(`\n  Examples of existing-only pages AFTER history start:`);
  for (const p of existingOnlyPages.slice(0, 5)) {
    // Check if they have any page/page_checkpoint entries
    const hasCheckpoint = entries.some(e => e.action === 'page_checkpoint' && e.url && generateSlugFromUrl(e.url) === p.slug);
    const pageCount = entries.filter(e => e.action === 'page' && e.url && generateSlugFromUrl(e.url) === p.slug).length;
    console.log(`    ${p.slug}: ts=${p.ts} checkpoint=${hasCheckpoint} pageEntries=${pageCount}`);
    console.log(`      url: ${p.url}`);
  }
}

// === Analysis 5: settings diff ===
console.log('\n=== ANALYSIS 5: settings diff ===\n');
const existingSettings = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf-8'));
const replayedSettings = existsSync(join('/tmp/portal-replay', 'settings.json'))
  ? JSON.parse(readFileSync(join('/tmp/portal-replay', 'settings.json'), 'utf-8'))
  : null;

if (replayedSettings) {
  const allKeys = new Set([...Object.keys(existingSettings), ...Object.keys(replayedSettings)]);
  for (const key of allKeys) {
    if (JSON.stringify(existingSettings[key]) !== JSON.stringify(replayedSettings[key])) {
      console.log(`  ${key}:`);
      console.log(`    existing: ${JSON.stringify(existingSettings[key])}`);
      console.log(`    replayed: ${JSON.stringify(replayedSettings[key])}`);
    }
  }
}

// === Analysis 6: list pins diff ===
console.log('\n=== ANALYSIS 6: list diffs ===\n');
const listsDir = join(DATA_DIR, 'lists');
const replayedListsDir = '/tmp/portal-replay/lists';
for (const f of readdirSync(listsDir).filter(f => f.endsWith('.json'))) {
  const ep = join(listsDir, f);
  const rp = join(replayedListsDir, f);
  if (!existsSync(rp)) continue;
  const existing = JSON.parse(readFileSync(ep, 'utf-8'));
  const replayed = JSON.parse(readFileSync(rp, 'utf-8'));
  if (JSON.stringify(existing) !== JSON.stringify(replayed)) {
    console.log(`  ${f}:`);
    for (const key of new Set([...Object.keys(existing), ...Object.keys(replayed)])) {
      if (JSON.stringify(existing[key]) !== JSON.stringify(replayed[key])) {
        const ev = JSON.stringify(existing[key])?.slice(0, 80);
        const rv = JSON.stringify(replayed[key])?.slice(0, 80);
        console.log(`    ${key}: existing=${ev} | replayed=${rv}`);
      }
    }
  }
}

// === Analysis 7: self-referencing parentId ===
console.log('\n=== ANALYSIS 7: self-referencing parentIds ===\n');
const selfRefUrl = 'https://www.youtube.com/watch?v=N1DjCFbbdHo';
const selfRefSlug = generateSlugFromUrl(selfRefUrl);
console.log('  slug:', selfRefSlug);
const selfRefEntries = entries.filter(e => e.url === selfRefUrl);
for (const e of selfRefEntries) {
  console.log(`  ts=${e.timestamp} action=${e.action} referrerId=${e.referrerId} title=${e.title?.slice(0, 40)}`);
}
