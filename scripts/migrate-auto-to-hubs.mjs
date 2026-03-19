#!/usr/bin/env node
/**
 * migrate-auto-to-hubs.mjs — Remove auto-list infrastructure, rename Gateways to Hubs.
 *
 * This script:
 * 1. Renames gateways-3km4de list to "Hubs" (updates name field + name-to-id path)
 * 2. Runs the Hubs function rule over all page entities to derive pins
 * 3. Adds a Function rule to the Hubs list
 * 4. Removes lists/auto.json and lists/auto/ directory
 * 5. Updates lists/system/root.json — removes list:auto from childLists
 * 6. Updates manifest/list-name-to-id.json — removes Auto/* paths
 * 7. Rewrites JSONL logs — removes all auto/gateways entries, appends fresh pin_to_list for derived pins
 *
 * Usage:
 *   node scripts/migrate-auto-to-hubs.mjs              # dry run
 *   node scripts/migrate-auto-to-hubs.mjs --apply      # apply changes
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const PAGES_DIR = join(DATA_DIR, 'pages');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
  if (dryRun) {
    console.log(`  [write] ${path}`);
    return;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// The Hubs function rule — matches hub/landing pages
const HUBS_FN_SOURCE = "const p = new URL(page.url).pathname.toLowerCase(); if (p === '/' || p === '') return 1; if (p.includes('index')) return 1; const parts = p.split('/').filter(Boolean); if (parts.length === 1 && p.endsWith('/')) return 1; const last = parts[parts.length - 1] || ''; const hub = ['blog', 'wiki', 'home', 'landing', 'explore', 'discover']; if (hub.some(k => last.includes(k))) return 1; return 0;";
const hubsFn = new Function('page', HUBS_FN_SOURCE);

// ---------------------------------------------------------------------------
// 1. Find the Gateways list (gateways-3km4de)
// ---------------------------------------------------------------------------
const GATEWAYS_ID = 'gateways-3km4de';
const GATEWAYS_PATH = join(DATA_DIR, 'lists', `${GATEWAYS_ID}.json`);

if (!existsSync(GATEWAYS_PATH)) {
  console.log(`No lists/${GATEWAYS_ID}.json found — nothing to migrate.`);
  process.exit(0);
}

const gwList = readJson(GATEWAYS_PATH);
console.log(`Found Gateways list: name="${gwList.name}", ${(gwList.pins || []).length} existing pins`);

// ---------------------------------------------------------------------------
// 2. Derive pins by running the Hubs function over all page entities
// ---------------------------------------------------------------------------
const derivedPins = [];
const pageFiles = readdirSync(PAGES_DIR).filter(f => f.endsWith('.json'));
const now = Date.now();

for (const f of pageFiles) {
  try {
    const page = readJson(join(PAGES_DIR, f));
    if (!page.url) continue;
    if (hubsFn({ url: page.url, title: page.title || '' }) === 1) {
      const slug = f.replace('.json', '');
      derivedPins.push({ id: `page:${slug}`, pinnedAt: now });
    }
  } catch {}
}

console.log(`Derived ${derivedPins.length} pins from ${pageFiles.length} page entities via Hubs function`);

// ---------------------------------------------------------------------------
// 3. Rename to "Hubs", set derived pins, add function rule
// ---------------------------------------------------------------------------
const hubsRule = {
  id: 'rule-s-hubs-' + now.toString(36),
  type: 'smart',
  config: {
    description: 'Hub and landing pages',
    fnSource: HUBS_FN_SOURCE,
  },
  createdAt: now,
};

const hubsList = {
  ...gwList,
  name: 'Hubs',
  pins: derivedPins,
  rules: [...(gwList.rules || []), hubsRule],
  timestamp: now,
};

console.log(`Renamed list to "Hubs", added function rule: ${hubsRule.id}`);
writeJson(GATEWAYS_PATH, hubsList);

// ---------------------------------------------------------------------------
// 4. Update manifest/list-name-to-id.json
// ---------------------------------------------------------------------------
const NAME_MAP_PATH = join(DATA_DIR, 'manifest', 'list-name-to-id.json');
if (existsSync(NAME_MAP_PATH)) {
  const nameMap = readJson(NAME_MAP_PATH);
  const paths = { ...nameMap.paths };

  // Remove old Gateways path, add Hubs path
  delete paths['root/Gateways'];
  delete paths['root/Auto'];
  delete paths['root/Auto/Gateways'];
  paths['root/Hubs'] = GATEWAYS_ID;

  console.log('Updated name-to-id: removed Gateways/Auto paths, added root/Hubs');
  writeJson(NAME_MAP_PATH, { ...nameMap, paths, timestamp: now });
}

// ---------------------------------------------------------------------------
// 5. Update lists/system/root.json — remove list:auto from childLists
// ---------------------------------------------------------------------------
const ROOT_PATH = join(DATA_DIR, 'lists', 'system', 'root.json');
if (existsSync(ROOT_PATH)) {
  const root = readJson(ROOT_PATH);
  const childLists = (root.childLists || []).filter(k => k !== 'list:auto');
  console.log(`Updated root.json: removed list:auto (${root.childLists.length} → ${childLists.length} children)`);
  writeJson(ROOT_PATH, { ...root, childLists, timestamp: now });
}

// ---------------------------------------------------------------------------
// 6. Remove lists/auto.json and lists/auto/ directory
// ---------------------------------------------------------------------------
const AUTO_PATH = join(DATA_DIR, 'lists', 'auto.json');
const AUTO_DIR = join(DATA_DIR, 'lists', 'auto');

if (existsSync(AUTO_PATH)) {
  console.log('Removing lists/auto.json');
  if (!dryRun) rmSync(AUTO_PATH);
}
if (existsSync(AUTO_DIR)) {
  console.log('Removing lists/auto/ directory');
  if (!dryRun) rmSync(AUTO_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// 7. Rewrite JSONL logs — remove all auto/gateways entries, append fresh pins
// ---------------------------------------------------------------------------
if (existsSync(LOGS_DIR)) {
  const logFiles = readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
  let totalRemoved = 0;

  for (const file of logFiles) {
    const filePath = join(LOGS_DIR, file);
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    const newLines = [];
    let changed = false;
    let fileRemoved = 0;

    for (const line of lines) {
      if (!line.trim()) { newLines.push(line); continue; }
      let entry;
      try { entry = JSON.parse(line); } catch { newLines.push(line); continue; }

      // Remove create_list for Auto folder or auto/gateways
      if (entry.action === 'create_list') {
        const isAutoFolder = entry.name === 'Auto' && (entry.parents || []).includes('root');
        const isAutoGw = entry.name === 'Gateways' &&
          ((entry.parents || []).join('/') === 'root/Auto' || entry.listId === 'auto/gateways');
        if (isAutoFolder || isAutoGw) {
          fileRemoved++;
          totalRemoved++;
          changed = true;
          continue;
        }
      }

      // Remove pin_to_list / unpin_from_list for auto/gateways
      if (entry.action === 'pin_to_list' || entry.action === 'unpin_from_list') {
        const isAutoGwPin = entry.name === 'auto/gateways' ||
          (entry.name === 'Gateways' && (entry.parents || []).join('/') === 'root/Auto');
        if (isAutoGwPin) {
          fileRemoved++;
          totalRemoved++;
          changed = true;
          continue;
        }
      }

      newLines.push(line);
    }

    if (changed) {
      console.log(`  ${file}: removed ${fileRemoved} entries`);
      if (!dryRun) {
        writeFileSync(filePath, newLines.join('\n'));
      }
    }
  }

  console.log(`\nLog cleanup: removed ${totalRemoved} auto/gateways entries`);

  // Append fresh pin_to_list entries for derived pins to today's log
  if (derivedPins.length > 0) {
    const d = new Date(now);
    const todayFile = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
    const todayPath = join(LOGS_DIR, todayFile);
    const pinUrls = [];

    // Resolve pin IDs back to URLs from page entities
    for (const pin of derivedPins) {
      const slug = pin.id.replace('page:', '');
      try {
        const page = readJson(join(PAGES_DIR, `${slug}.json`));
        if (page.url) pinUrls.push(page.url);
      } catch {}
    }

    if (pinUrls.length > 0) {
      const pinEntry = {
        timestamp: now,
        action: 'pin_to_list',
        parents: ['root'],
        name: 'Hubs',
        items: pinUrls,
      };
      console.log(`Appending pin_to_list with ${pinUrls.length} items to ${todayFile}`);
      if (!dryRun) {
        appendFileSync(todayPath, JSON.stringify(pinEntry) + '\n');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
console.log('\n' + (dryRun ? 'Dry run complete. Pass --apply to write changes.' : 'Migration complete.'));
console.log('Next: run `node scripts/replay-verify.mjs` to verify replay consistency.');
