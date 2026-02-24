#!/usr/bin/env node
/**
 * Migration script: Fully-Qualified List Keys + Entity slug Rename
 *
 * 1. Rename `id` → `slug` in user list JSON files (lists/*.json)
 * 2. Prefix listOrder and workspace.listIds with `list:` in settings.json
 * 3. Prefix listOrder and workspace.listIds in JSONL `set` entries
 * 4. Move lists/gateways.json and lists/explore.json → lists/system/
 *
 * Usage: node scripts/migrate-list-ids.js <path-to-portal-data>
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node migrate-list-ids.js <path-to-portal-data>');
  process.exit(1);
}

const dataDir = path.resolve(args[0]);
if (!fs.existsSync(dataDir)) {
  console.error(`Directory not found: ${dataDir}`);
  process.exit(1);
}

console.log(`Migrating portal-data at: ${dataDir}`);
console.log('');

// Slug that should NOT be prefixed with list:
function isAlreadyPrefixed(slug) {
  if (!slug) return true;
  return slug.startsWith('list:') || slug.startsWith('page:') || slug.startsWith('note:');
}

// Prefix a bare slug with list: for settings references
function prefixSlug(slug) {
  if (isAlreadyPrefixed(slug)) return slug;
  return 'list:' + slug;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 1: Rename `id` → `slug` in user list JSON files
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 1: Renaming id → slug in list JSON files...');

const listsDir = path.join(dataDir, 'lists');
if (fs.existsSync(listsDir)) {
  const files = fs.readdirSync(listsDir).filter(f => f.endsWith('.json'));
  let updatedCount = 0;

  for (const file of files) {
    const slug = file.replace('.json', '');
    // Skip special files
    if (slug === 'explore' || slug === 'gateways') continue;

    const filePath = path.join(listsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let changed = false;
      if (data.id !== undefined) {
        data.slug = data.id;
        delete data.id;
        changed = true;
      }
      // Backfill missing slug (old saveListPinsById wrote files without it)
      if (data.slug === undefined) {
        data.slug = slug;
        changed = true;
      }
      // Backfill missing name
      if (data.name === undefined) {
        data.name = slug;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        updatedCount++;
      }
    } catch (e) {
      console.warn(`  Warning: could not process ${file}: ${e.message}`);
    }
  }
  console.log(`  Updated ${updatedCount} list files (id → slug)`);
} else {
  console.log('  No lists/ directory found');
}

console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 2: Move lists/gateways.json → lists/system/gateways.json
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 2: Moving gateways.json to lists/system/...');

const systemDir = path.join(listsDir, 'system');
if (!fs.existsSync(systemDir)) fs.mkdirSync(systemDir, { recursive: true });

const gatewaysOldPath = path.join(listsDir, 'gateways.json');
const gatewaysNewPath = path.join(systemDir, 'gateways.json');
if (fs.existsSync(gatewaysOldPath)) {
  fs.renameSync(gatewaysOldPath, gatewaysNewPath);
  console.log('  Moved lists/gateways.json → lists/system/gateways.json');
} else {
  console.log('  gateways.json already migrated or missing');
}

const exploreOldPath = path.join(listsDir, 'explore.json');
const exploreNewPath = path.join(systemDir, 'explore.json');
if (fs.existsSync(exploreOldPath)) {
  fs.renameSync(exploreOldPath, exploreNewPath);
  console.log('  Moved lists/explore.json → lists/system/explore.json');
} else {
  console.log('  explore.json already migrated or missing');
}

console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 3: JSONL Rewrite — prefix listOrder/workspace.listIds in `set` entries
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 3: Rewriting JSONL history files...');

const historyDir = path.join(dataDir, 'history');
if (fs.existsSync(historyDir)) {
  const jsonlFiles = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort();
  console.log(`  Found ${jsonlFiles.length} JSONL files`);

  for (const filename of jsonlFiles) {
    const filePath = path.join(historyDir, filename);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const newLines = [];
    let changed = false;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Strip user/ prefix from list entry IDs (ghost entries from old deleteList/workspace auto-pin bug)
        if ((entry.action === 'list' || entry.action === 'list_meta' || entry.action === 'del_list') && entry.id && entry.id.startsWith('user/')) {
          entry.id = entry.id.slice('user/'.length);
          newLines.push(JSON.stringify(entry));
          changed = true;
          continue;
        }

        // set listOrder: prefix each value element
        if (entry.action === 'set' && entry.key === 'listOrder' && Array.isArray(entry.value)) {
          entry.value = entry.value.map(prefixSlug);
          newLines.push(JSON.stringify(entry));
          changed = true;
          continue;
        }

        // set workspace: prefix listIds elements
        if (entry.action === 'set' && entry.key === 'workspace' && entry.value && Array.isArray(entry.value.listIds)) {
          entry.value.listIds = entry.value.listIds.map(prefixSlug);
          newLines.push(JSON.stringify(entry));
          changed = true;
          continue;
        }

        // All other entries pass through unchanged
        newLines.push(line);
      } catch (e) {
        // Keep malformed lines as-is
        newLines.push(line);
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8');
      console.log(`  Rewrote ${filename}: ${lines.length} entries`);
    }
  }
} else {
  console.log('  No history/ directory found');
}

console.log('');

// ──────────────────────────────────────────────────────────────────────────
// Step 4: settings.json — prefix listOrder and workspace.listIds
// ──────────────────────────────────────────────────────────────────────────

console.log('Step 4: Updating settings.json...');

const settingsPath = path.join(dataDir, 'settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  let changed = false;

  if (Array.isArray(settings.listOrder)) {
    settings.listOrder = settings.listOrder.map(prefixSlug);
    changed = true;
    console.log(`  listOrder: ${settings.listOrder.length} entries prefixed`);
  }

  if (settings.workspace && Array.isArray(settings.workspace.listIds)) {
    settings.workspace.listIds = settings.workspace.listIds.map(prefixSlug);
    changed = true;
    console.log(`  workspace.listIds: ${settings.workspace.listIds.length} entries prefixed`);
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('  settings.json updated');
  } else {
    console.log('  No changes needed');
  }
} else {
  console.log('  No settings.json found');
}

console.log('');
console.log('Migration complete!');
console.log('');
console.log('Next steps:');
console.log('1. Verify the migrated data looks correct');
console.log('2. Load the extension to test');
