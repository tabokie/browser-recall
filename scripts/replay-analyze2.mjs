#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');

// Scan data/logs/<device>/*.jsonl subdirectories
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

// 1. Self-referencing parentId: page:youtube-watch-ttyedk
console.log('=== Self-referencing parentId ===\n');
const selfRefSlug = 'youtube-watch-ttyedk';
const selfRefEntries = entries.filter(e =>
  (e.url && generateSlugFromUrl(e.url) === selfRefSlug) ||
  (e.referrerId && e.referrerId === 'page:' + selfRefSlug)
);
for (const e of selfRefEntries) {
  console.log(JSON.stringify({
    ts: e.timestamp,
    action: e.action,
    url: e.url?.slice(0, 60),
    title: e.title?.slice(0, 40),
    referrerId: e.referrerId,
  }));
}

// 2. page action entries with mdPath
console.log('\n=== page entries with mdPath (sample) ===\n');
const withMd = entries.filter(e => e.action === 'page' && e.mdPath);
for (const e of withMd.slice(0, 3)) {
  console.log(JSON.stringify({
    ts: e.timestamp,
    action: e.action,
    url: e.url?.slice(0, 60),
    mdPath: e.mdPath,
    htmlPath: e.htmlPath,
    title: e.title?.slice(0, 40),
  }));
}
console.log(`Total: ${withMd.length} entries`);

// 3. existing-only pages: are they created by background.js without logging?
// Check pages that have no checkpoint but exist on disk — is there a code path
// that writes page entities without going through JSONL?
console.log('\n=== Pages existing on disk with NO history entries at all ===\n');
const pagesDir = join(DATA_DIR, 'pages');
let noHistoryCount = 0;
for (const f of readdirSync(pagesDir).filter(f => f.endsWith('.json'))) {
  const slug = f.replace('.json', '');
  const hasAny = entries.some(e =>
    (e.url && generateSlugFromUrl(e.url) === slug) ||
    (e.action === 'page_checkpoint' && e.url && generateSlugFromUrl(e.url) === slug)
  );
  if (hasAny) continue;
  noHistoryCount++;
  if (noHistoryCount <= 5) {
    const d = JSON.parse(readFileSync(join(pagesDir, f), 'utf-8'));
    console.log(`  ${slug}: url=${d.url?.slice(0, 70)} ts=${d.timestamp}`);
  }
}
console.log(`  Total pages with zero history entries: ${noHistoryCount}`);

// 4. List name mismatch: ai-core-ffnyqr has name="" in replay but "AI Core" in existing
console.log('\n=== List name: ai-core-ffnyqr history ===\n');
const aiCoreEntries = entries.filter(e =>
  (e.action === 'list' || e.action === 'list_meta' || e.action === 'del_list') && e.id === 'ai-core-ffnyqr'
);
for (const e of aiCoreEntries) {
  console.log(JSON.stringify(e));
}

// 5. Settings: which 'set' entries exist for urlBlacklist and settings?
console.log('\n=== Settings: urlBlacklist and settings key ===\n');
const settingsEntries = entries.filter(e =>
  e.action === 'set' && (e.key === 'urlBlacklist' || e.key === 'settings')
);
console.log(`  set entries for 'urlBlacklist': ${settingsEntries.filter(e => e.key === 'urlBlacklist').length}`);
console.log(`  set entries for 'settings': ${settingsEntries.filter(e => e.key === 'settings').length}`);
// What settings keys ARE in history?
const settingsKeys = new Set(entries.filter(e => e.action === 'set').map(e => e.key));
console.log(`  All settings keys in history: ${[...settingsKeys].join(', ')}`);

// 6. Pins pinnedAt timestamp drift
console.log('\n=== List pin timestamp drift (health, live) ===\n');
const healthEntries = entries.filter(e =>
  (e.action === 'list') && e.id === 'health-ie863v' && e.op === 'add'
);
for (const e of healthEntries) {
  console.log(JSON.stringify({ ts: e.timestamp, ids: e.ids }));
}
const liveEntries = entries.filter(e =>
  (e.action === 'list') && e.id === 'live-xn77a1' && e.op === 'add'
);
for (const e of liveEntries) {
  console.log(JSON.stringify({ ts: e.timestamp, ids: e.ids }));
}
