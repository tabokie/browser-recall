#!/usr/bin/env node
/**
 * migrate-always-device.mjs — Assign a device name and convert all data to
 * the always-on device name format (compound keys, owner field, listOwner events).
 *
 * Changes:
 * 1. Generate device name → write to manifest/settings.json as deviceName
 * 2. Move data/logs/YYYY-MM-DD.jsonl → data/logs/<device>/YYYY-MM-DD.jsonl
 * 3. Add owner: <device> to all lists/*.json (skip system/ lists)
 * 4. Transform manifest/list-name-to-id.json keys: name → device/name
 * 5. Backfill listOwner: <device> and drop parents from all JSONL log entries
 *
 * Idempotent: skips if settings.json already has a deviceName.
 *
 * Usage:
 *   node scripts/migrate-always-device.mjs              # dry run
 *   node scripts/migrate-always-device.mjs --apply      # apply changes
 *   node scripts/migrate-always-device.mjs --apply --device mypc  # custom name
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LISTS_DIR = join(DATA_DIR, 'lists');
const MANIFEST_DIR = join(DATA_DIR, 'manifest');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const SETTINGS_PATH = join(MANIFEST_DIR, 'settings.json');
const NAME_TO_ID_PATH = join(MANIFEST_DIR, 'list-name-to-id.json');
const dryRun = !process.argv.includes('--apply');
const deviceArgIdx = process.argv.indexOf('--device');
const customDevice = deviceArgIdx >= 0 ? process.argv[deviceArgIdx + 1] : null;

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Guard: skip if settings already has deviceName
// ---------------------------------------------------------------------------
let settings = {};
if (existsSync(SETTINGS_PATH)) {
  settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
}
if (settings.deviceName) {
  console.log(`settings.json already has deviceName="${settings.deviceName}" — migration already applied, skipping.`);
  process.exit(0);
}

// Generate device name
const deviceName = customDevice || randomUUID().slice(0, 8);
console.log(`Device name: ${deviceName}\n`);

// ---------------------------------------------------------------------------
// 1. Write deviceName to settings.json
// ---------------------------------------------------------------------------
console.log('--- Step 1: Update manifest/settings.json ---');
settings.deviceName = deviceName;
console.log(`  Set deviceName = "${deviceName}"`);
if (!dryRun) writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

// ---------------------------------------------------------------------------
// 2. Move log files into device subdirectory: YYYY-MM-DD.jsonl → <device>/YYYY-MM-DD.jsonl
// ---------------------------------------------------------------------------
console.log('\n--- Step 2: Move log files to device subdirectory ---');
if (existsSync(LOGS_DIR)) {
  const deviceDir = join(LOGS_DIR, deviceName);
  // Only move .jsonl files at the root level (not in subdirectories)
  const logFiles = readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
    .map(d => d.name);
  if (logFiles.length > 0) {
    console.log(`  Creating ${deviceName}/`);
    if (!dryRun) mkdirSync(deviceDir, { recursive: true });
    let moved = 0;
    for (const f of logFiles) {
      console.log(`  ${f} → ${deviceName}/${f}`);
      if (!dryRun) renameSync(join(LOGS_DIR, f), join(deviceDir, f));
      moved++;
    }
    console.log(`  ${moved} files moved`);
  } else {
    console.log('  No log files at root level to move');
  }
} else {
  console.log('  No logs directory found, skipping');
}

// ---------------------------------------------------------------------------
// 3. Add owner to list entities
// ---------------------------------------------------------------------------
console.log('\n--- Step 3: Add owner to list entities ---');
if (existsSync(LISTS_DIR)) {
  const listFiles = readdirSync(LISTS_DIR).filter(f => f.endsWith('.json'));
  let updated = 0;
  for (const f of listFiles) {
    const path = join(LISTS_DIR, f);
    const list = JSON.parse(readFileSync(path, 'utf-8'));
    if (list.owner) {
      console.log(`  ${f} — already has owner, skipped`);
      continue;
    }
    list.owner = deviceName;
    console.log(`  ${f} — added owner="${deviceName}"`);
    if (!dryRun) writeFileSync(path, JSON.stringify(list, null, 2));
    updated++;
  }
  // Don't add owner to system lists
  const systemDir = join(LISTS_DIR, 'system');
  if (existsSync(systemDir)) {
    console.log('  (system/ lists not modified)');
  }
  console.log(`  ${updated} files updated`);
} else {
  console.log('  No lists directory found, skipping');
}

// ---------------------------------------------------------------------------
// 4. Transform name-to-id keys: name → device/name
// ---------------------------------------------------------------------------
console.log('\n--- Step 4: Transform name-to-id compound keys ---');
if (existsSync(NAME_TO_ID_PATH)) {
  const nameToId = JSON.parse(readFileSync(NAME_TO_ID_PATH, 'utf-8'));
  const oldPaths = nameToId.paths || {};
  const newPaths = {};
  let transformed = 0;
  for (const [name, id] of Object.entries(oldPaths)) {
    if (name.includes('/')) {
      // Already has a compound key — skip
      console.log(`  "${name}" → "${name}" (already compound, skipped)`);
      newPaths[name] = id;
    } else {
      const newKey = `${deviceName}/${name}`;
      console.log(`  "${name}" → "${newKey}"`);
      newPaths[newKey] = id;
      transformed++;
    }
  }
  nameToId.paths = newPaths;
  console.log(`  ${transformed} keys transformed`);
  if (!dryRun) writeFileSync(NAME_TO_ID_PATH, JSON.stringify(nameToId, null, 2));
} else {
  console.log('  No name-to-id file found, skipping');
}

// ---------------------------------------------------------------------------
// 5. Backfill listOwner and drop parents from JSONL entries
// ---------------------------------------------------------------------------
console.log('\n--- Step 5: Backfill listOwner in JSONL entries ---');
const LIST_ACTIONS = new Set([
  'pin_to_list', 'unpin_from_list', 'create_list', 'update_list',
  'delete_list', 'restore_list', 'add_rule', 'remove_rule', 'update_rule',
]);
if (existsSync(LOGS_DIR)) {
  // Collect all .jsonl files from device subdirectories
  const logPaths = [];
  for (const d of readdirSync(LOGS_DIR, { withFileTypes: true })) {
    if (d.isDirectory()) {
      const subDir = join(LOGS_DIR, d.name);
      for (const f of readdirSync(subDir).filter(f => f.endsWith('.jsonl')).sort()) {
        logPaths.push({ dir: d.name, file: f, path: join(subDir, f) });
      }
    }
  }
  let totalEntries = 0;
  let modifiedEntries = 0;
  for (const { dir, file: f, path } of logPaths) {
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    let fileModified = false;
    const newLines = [];
    for (const line of lines) {
      totalEntries++;
      const entry = JSON.parse(line);
      if (LIST_ACTIONS.has(entry.action)) {
        if (!entry.listOwner) {
          entry.listOwner = deviceName;
          fileModified = true;
          modifiedEntries++;
        }
        if (entry.parents !== undefined) {
          delete entry.parents;
          fileModified = true;
        }
      }
      newLines.push(JSON.stringify(entry));
    }
    if (fileModified) {
      console.log(`  ${dir}/${f} — ${newLines.length} entries processed`);
      if (!dryRun) writeFileSync(path, newLines.join('\n') + '\n');
    }
  }
  console.log(`  ${modifiedEntries}/${totalEntries} entries modified`);
} else {
  console.log('  No logs directory found, skipping');
}

console.log('\n' + (dryRun ? '=== DRY RUN COMPLETE (pass --apply to write) ===' : '=== MIGRATION COMPLETE ==='));
