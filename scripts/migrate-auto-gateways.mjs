#!/usr/bin/env node
/**
 * migrate-auto-gateways.mjs — Migrate gateway data from system entity to auto-list.
 *
 * Old format: lists/system/gateways.json  { timestamp, origins: [...] }
 * New format: lists/auto/gateways.json    { slug, name, auto, parentList, childLists, pins, savedSearches, timestamp }
 *             lists/auto.json             { slug, name, auto, parentList, childLists, pins, savedSearches, timestamp }
 *
 * This script:
 * 1. Reads lists/system/gateways.json → extracts origins array + timestamp
 * 2. For each origin, computes root URL and checks if page entity exists on disk
 *    - If yes → pin ID is `page:<slug>`
 *    - If no → pin ID is `shallow:<rootUrl>`
 * 3. Creates lists/auto/ directory structure
 * 4. Writes lists/auto.json (folder entity)
 * 5. Writes lists/auto/gateways.json (list entity with pins)
 * 6. Updates lists/system/root.json: adds list:auto to childLists
 * 7. Migrates JSONL history entries (system/gateways → auto/gateways)
 * 8. Deletes lists/system/gateways.json
 * 9. Appends list_meta entries for auto and auto/gateways to today's history
 *
 * Usage:
 *   node scripts/migrate-auto-gateways.mjs              # dry run
 *   node scripts/migrate-auto-gateways.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const GATEWAYS_PATH = join(DATA_DIR, 'lists', 'system', 'gateways.json');
const ROOT_PATH = join(DATA_DIR, 'lists', 'system', 'root.json');
const AUTO_DIR = join(DATA_DIR, 'lists', 'auto');
const AUTO_PATH = join(DATA_DIR, 'lists', 'auto.json');
const AUTO_GW_PATH = join(AUTO_DIR, 'gateways.json');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// 1. Read old gateways.json
// ---------------------------------------------------------------------------
if (!existsSync(GATEWAYS_PATH)) {
  console.log('No lists/system/gateways.json found — nothing to migrate.');
  process.exit(0);
}

const old = JSON.parse(readFileSync(GATEWAYS_PATH, 'utf-8'));

if (!Array.isArray(old.origins)) {
  console.log('gateways.json has no origins array — unexpected format.');
  process.exit(1);
}

if (existsSync(AUTO_GW_PATH)) {
  console.log('lists/auto/gateways.json already exists — already migrated.');
  process.exit(0);
}

const origins = old.origins;
const timestamp = old.timestamp || Date.now();
console.log(`Found ${origins.length} gateway origins:`, origins);

// ---------------------------------------------------------------------------
// 2. Compute pin IDs
// ---------------------------------------------------------------------------
const pins = [];
for (const origin of origins) {
  const rootUrl = origin + '/';
  const slug = generateSlugFromUrl(rootUrl);
  const pageDir = join(DATA_DIR, 'pages', slug);
  const pageJson = join(DATA_DIR, 'pages', slug + '.json');

  if (existsSync(pageDir) || existsSync(pageJson)) {
    pins.push({ id: `page:${slug}`, pinnedAt: timestamp });
    console.log(`  ${origin} → page:${slug} (checkpointed)`);
  } else {
    pins.push({ id: `shallow:${rootUrl}`, pinnedAt: timestamp });
    console.log(`  ${origin} → shallow:${rootUrl} (non-checkpointed)`);
  }
}

// ---------------------------------------------------------------------------
// 3-5. Create auto list entities
// ---------------------------------------------------------------------------
const autoFolder = {
  slug: 'auto',
  name: 'Auto',
  auto: true,
  parentList: 'list:system/root',
  childLists: ['list:auto/gateways'],
  pins: [],
  savedSearches: [],
  timestamp,
};

const autoGateways = {
  slug: 'auto/gateways',
  name: 'Gateways',
  auto: true,
  parentList: 'list:auto',
  childLists: [],
  pins,
  savedSearches: [],
  timestamp,
};

console.log('\nauto.json:', JSON.stringify(autoFolder, null, 2));
console.log('auto/gateways.json:', JSON.stringify(autoGateways, null, 2));

// ---------------------------------------------------------------------------
// 6. Update root.json
// ---------------------------------------------------------------------------
let root = { timestamp: 0, childLists: [] };
if (existsSync(ROOT_PATH)) {
  root = JSON.parse(readFileSync(ROOT_PATH, 'utf-8'));
}
const rootChildLists = [...(root.childLists || [])];
if (!rootChildLists.includes('list:auto')) {
  rootChildLists.push('list:auto');
}
const updatedRoot = { ...root, timestamp, childLists: rootChildLists };
console.log('\nUpdated root.json childLists:', updatedRoot.childLists);

// ---------------------------------------------------------------------------
// 7. Migrate JSONL history entries
// ---------------------------------------------------------------------------
const historyFiles = existsSync(HISTORY_DIR)
  ? readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort()
  : [];

let totalMigrated = 0;
const migratedHistoryFiles = new Map(); // filename → new content

for (const file of historyFiles) {
  const filePath = join(HISTORY_DIR, file);
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  let changed = false;
  const newLines = [];

  for (const line of lines) {
    if (!line.trim()) { newLines.push(line); continue; }
    try {
      const entry = JSON.parse(line);
      if (entry.action === 'list' && entry.id === 'system/gateways') {
        // Migrate origins → pin IDs
        const migratedEntry = { ...entry, id: 'auto/gateways' };
        delete migratedEntry.origins;
        if (entry.origins) {
          migratedEntry.ids = entry.origins.map(origin => {
            const rootUrl = origin + '/';
            const slug = generateSlugFromUrl(rootUrl);
            const pageDir = join(DATA_DIR, 'pages', slug);
            const pageJson = join(DATA_DIR, 'pages', slug + '.json');
            return (existsSync(pageDir) || existsSync(pageJson))
              ? `page:${slug}`
              : `shallow:${rootUrl}`;
          });
        }
        newLines.push(JSON.stringify(migratedEntry));
        changed = true;
        totalMigrated++;
      } else {
        newLines.push(line);
      }
    } catch {
      newLines.push(line);
    }
  }

  if (changed) {
    migratedHistoryFiles.set(file, newLines.join('\n'));
  }
}
console.log(`\nMigrated ${totalMigrated} history entries across ${migratedHistoryFiles.size} files`);

// ---------------------------------------------------------------------------
// 9. Append list_meta entries for today's history
// ---------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const todayFile = `${today}.jsonl`;
const metaEntries = [
  { timestamp, action: 'list_meta', id: 'auto', name: 'Auto', parentList: 'list:system/root', childLists: ['list:auto/gateways'] },
  { timestamp, action: 'list_meta', id: 'auto/gateways', name: 'Gateways', parentList: 'list:auto', childLists: [] },
];
console.log('\nAppending list_meta entries to', todayFile);
for (const e of metaEntries) console.log('  ', JSON.stringify(e));

// ---------------------------------------------------------------------------
// Apply changes
// ---------------------------------------------------------------------------
if (!dryRun) {
  // Create auto directory
  mkdirSync(AUTO_DIR, { recursive: true });

  // Write auto entities
  writeFileSync(AUTO_PATH, JSON.stringify(autoFolder, null, 2));
  writeFileSync(AUTO_GW_PATH, JSON.stringify(autoGateways, null, 2));

  // Update root
  writeFileSync(ROOT_PATH, JSON.stringify(updatedRoot, null, 2));

  // Migrate history files
  for (const [file, content] of migratedHistoryFiles) {
    writeFileSync(join(HISTORY_DIR, file), content);
  }

  // Append list_meta entries
  const todayPath = join(HISTORY_DIR, todayFile);
  const metaLines = metaEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(todayPath, metaLines);

  // Delete old gateways.json
  unlinkSync(GATEWAYS_PATH);

  console.log('\nMigration applied successfully.');
} else {
  console.log('\n=== DRY RUN — no changes written ===');
}
