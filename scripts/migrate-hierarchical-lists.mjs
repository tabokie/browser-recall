#!/usr/bin/env node
/**
 * migrate-hierarchical-lists.mjs — Data migration for hierarchical lists.
 *
 * Changes:
 * 1. Create lists/system/root.json with childLists from settings.listOrder
 * 2. Add parentList: 'list:system/root' and childLists: [] to all user list entities
 * 3. Remove listOrder from settings.json
 *
 * Idempotent: skips if lists/system/root.json already exists.
 *
 * Usage:
 *   node scripts/migrate-hierarchical-lists.mjs              # dry run
 *   node scripts/migrate-hierarchical-lists.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const LISTS_DIR = join(DATA_DIR, 'lists');
const SYSTEM_DIR = join(LISTS_DIR, 'system');
const ROOT_PATH = join(SYSTEM_DIR, 'root.json');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Guard: skip if root.json already exists
// ---------------------------------------------------------------------------
if (existsSync(ROOT_PATH)) {
  console.log('lists/system/root.json already exists — migration already applied, skipping.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Read settings.json → extract listOrder
// ---------------------------------------------------------------------------
if (!existsSync(SETTINGS_PATH)) {
  console.error('settings.json not found at', SETTINGS_PATH);
  process.exit(1);
}

const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
const listOrder = settings.listOrder || [];
console.log(`Found ${listOrder.length} lists in settings.listOrder`);

// ---------------------------------------------------------------------------
// 2. Create lists/system/root.json
// ---------------------------------------------------------------------------
const rootEntity = {
  timestamp: Date.now(),
  childLists: listOrder.map(e => e.id), // e.id is already 'list:<slug>' format
};

console.log(`Creating lists/system/root.json with ${rootEntity.childLists.length} children:`);
for (const id of rootEntity.childLists) {
  console.log(`  - ${id}`);
}

if (!dryRun) {
  mkdirSync(SYSTEM_DIR, { recursive: true });
  writeFileSync(ROOT_PATH, JSON.stringify(rootEntity, null, 2));
}

// ---------------------------------------------------------------------------
// 3. Add parentList + childLists to all user list entities
// ---------------------------------------------------------------------------
if (!existsSync(LISTS_DIR)) {
  console.log('No lists/ directory found — skipping list entity updates');
} else {
  const files = readdirSync(LISTS_DIR).filter(f => f.endsWith('.json'));
  let updated = 0;

  for (const file of files) {
    // Skip system files
    if (file.startsWith('system') || file.startsWith('index')) continue;

    const filePath = join(LISTS_DIR, file);
    const entity = JSON.parse(readFileSync(filePath, 'utf-8'));

    let changed = false;
    if (entity.parentList === undefined) {
      entity.parentList = 'list:system/root';
      changed = true;
    }
    if (entity.childLists === undefined) {
      entity.childLists = [];
      changed = true;
    }

    if (changed) {
      console.log(`  Updating ${file}: +parentList, +childLists`);
      if (!dryRun) {
        writeFileSync(filePath, JSON.stringify(entity, null, 2));
      }
      updated++;
    }
  }

  console.log(`Updated ${updated} list entities`);
}

// ---------------------------------------------------------------------------
// 4. Remove listOrder from settings.json
// ---------------------------------------------------------------------------
if (settings.listOrder !== undefined) {
  console.log('Removing listOrder from settings.json');
  delete settings.listOrder;
  if (!dryRun) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  }
}

console.log(dryRun ? '\n=== DRY RUN complete (pass --apply to write) ===' : '\nMigration complete.');
