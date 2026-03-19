#!/usr/bin/env node
/**
 * Replay-verify: replay full JSONL history from scratch using effectOf,
 * persist replayed state to a temp directory, then diff against existing
 * checkpoints in ~/portal-data.
 *
 * Usage: node scripts/replay-verify.mjs [--write <dir>]
 *   --write <dir>  Write replayed entities to <dir> (default: /tmp/portal-replay)
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { effectOf, defaultEntity } from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');

// Parse args
let outputDir = '/tmp/portal-replay';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write' && args[i + 1]) outputDir = args[++i];
}

// ---------------------------------------------------------------------------
// 1. Load all log entries, sorted by timestamp
// ---------------------------------------------------------------------------
console.log('Loading logs...');
const logFiles = readdirSync(LOGS_DIR)
  .filter(f => f.endsWith('.jsonl'))
  .sort();

const allEntries = [];
for (const file of logFiles) {
  const lines = readFileSync(join(LOGS_DIR, file), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      allEntries.push(JSON.parse(line));
    } catch (e) {
      console.warn(`  SKIP bad JSON in ${file}: ${line.slice(0, 80)}`);
    }
  }
}

// Sort by timestamp (stable — preserves file order for same-ts entries)
allEntries.sort((a, b) => a.timestamp - b.timestamp);
console.log(`  ${allEntries.length} entries from ${logFiles.length} files`);

// ---------------------------------------------------------------------------
// 2. Replay all entries through effectOf, accumulating state in a Map
// ---------------------------------------------------------------------------
console.log('Replaying...');
const store = new Map();
const load = async (key) => store.get(key) ?? null;

for (let i = 0; i < allEntries.length; i++) {
  const entry = allEntries[i];
  try {
    const result = await effectOf(entry, load);
    for (const [key, value] of Object.entries(result)) {
      store.set(key, value);
    }
  } catch (e) {
    console.warn(`  ERROR replaying entry ${i} (ts=${entry.timestamp}, action=${entry.action}): ${e.message}`);
  }
}

console.log(`  ${store.size} keys in replayed store`);

// ---------------------------------------------------------------------------
// 3. Write replayed state to output dir
// ---------------------------------------------------------------------------
console.log(`Writing replayed state to ${outputDir}...`);
mkdirSync(join(outputDir, 'pages'), { recursive: true });
mkdirSync(join(outputDir, 'data', 'notes'), { recursive: true });
mkdirSync(join(outputDir, 'lists', 'system'), { recursive: true });
mkdirSync(join(outputDir, 'lists', 'auto'), { recursive: true });
mkdirSync(join(outputDir, 'manifest'), { recursive: true });

for (const [key, value] of store) {
  if (value === null) continue;
  let path;
  if (key === 'manifest:settings') {
    path = join(outputDir, 'manifest', 'settings.json');
  } else if (key === 'manifest:orphaned') {
    path = join(outputDir, 'manifest', 'orphaned.json');
  } else if (key === 'manifest:name-to-id') {
    path = join(outputDir, 'manifest', 'list-name-to-id.json');
  } else if (key.startsWith('page:')) {
    const slug = key.slice('page:'.length);
    path = join(outputDir, 'pages', `${slug}.json`);
  } else if (key.startsWith('note:')) {
    const slug = key.slice('note:'.length);
    path = join(outputDir, 'data', 'notes', `${slug}.json`);
  } else if (key.startsWith('list:system/')) {
    const name = key.slice('list:system/'.length);
    path = join(outputDir, 'lists', 'system', `${name}.json`);
  } else if (key.startsWith('list:')) {
    const slug = key.slice('list:'.length);
    path = join(outputDir, 'lists', `${slug}.json`);
  } else if (key.startsWith('snapshot:')) {
    // Snapshot keys are identity-only — no entity file on disk
    continue;
  } else {
    console.warn(`  Unknown key prefix: ${key}`);
    continue;
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// 4. Compare replayed state against existing checkpoints
// ---------------------------------------------------------------------------
console.log('\nComparing replayed state vs existing checkpoints...');

const diffs = [];

function loadExisting(relPath) {
  const full = join(DATA_DIR, relPath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf-8'));
  } catch {
    return null;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffFields(replayed, existing, entityKey) {
  const allFields = new Set([...Object.keys(replayed || {}), ...Object.keys(existing || {})]);
  const fieldDiffs = [];
  for (const field of allFields) {
    const rv = replayed?.[field];
    const ev = existing?.[field];
    if (!deepEqual(rv, ev)) {
      fieldDiffs.push({
        field,
        replayed: rv,
        existing: ev,
      });
    }
  }
  return fieldDiffs;
}

// Map of entity key -> relPath for comparison
const entityPaths = new Map();

// Pages
if (existsSync(join(DATA_DIR, 'pages'))) {
  for (const f of readdirSync(join(DATA_DIR, 'pages'))) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace('.json', '');
    entityPaths.set(`page:${slug}`, `pages/${f}`);
  }
}

// Notes
if (existsSync(join(DATA_DIR, 'data', 'notes'))) {
  for (const f of readdirSync(join(DATA_DIR, 'data', 'notes'))) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace('.json', '');
    entityPaths.set(`note:${slug}`, `data/notes/${f}`);
  }
}

// Lists (non-system, non-auto)
if (existsSync(join(DATA_DIR, 'lists'))) {
  for (const f of readdirSync(join(DATA_DIR, 'lists'))) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace('.json', '');
    entityPaths.set(`list:${slug}`, `lists/${f}`);
  }
}

// System lists
for (const name of ['root']) {
  entityPaths.set(`list:system/${name}`, `lists/system/${name}.json`);
}

// Manifest entities
entityPaths.set('manifest:settings', 'manifest/settings.json');
entityPaths.set('manifest:orphaned', 'manifest/orphaned.json');
entityPaths.set('manifest:name-to-id', 'manifest/list-name-to-id.json');
// Collect all keys (union of replayed + existing)
const allKeys = new Set([...store.keys(), ...entityPaths.keys()]);

let matchCount = 0;
let diffCount = 0;
let replayOnlyCount = 0;
let existingOnlyCount = 0;

for (const key of [...allKeys].sort()) {
  // Skip snapshot keys — no entity file
  if (key.startsWith('snapshot:')) continue;

  const replayed = store.get(key) ?? null;
  const existingPath = entityPaths.get(key);
  const existing = existingPath ? loadExisting(existingPath) : null;

  // Skip keys where both are null
  if (replayed === null && existing === null) continue;

  // Replay produced entity but no existing file
  if (replayed !== null && existing === null) {
    replayOnlyCount++;
    diffs.push({ key, type: 'replay-only', replayed });
    continue;
  }

  // Existing file but replay didn't produce it
  if (replayed === null && existing !== null) {
    existingOnlyCount++;
    diffs.push({ key, type: 'existing-only', existing });
    continue;
  }

  // Both exist — compare
  if (deepEqual(replayed, existing)) {
    matchCount++;
  } else {
    diffCount++;
    const fieldDiffs = diffFields(replayed, existing, key);
    diffs.push({ key, type: 'mismatch', fieldDiffs });
  }
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------
console.log(`\n=== RESULTS ===`);
console.log(`  Matching:       ${matchCount}`);
console.log(`  Mismatched:     ${diffCount}`);
console.log(`  Replay-only:    ${replayOnlyCount} (replayed but no existing file)`);
console.log(`  Existing-only:  ${existingOnlyCount} (existing file but not produced by replay)`);

if (diffs.length > 0) {
  console.log(`\n=== DIFFS (${diffs.length} total) ===\n`);

  // Group by type
  const grouped = { 'mismatch': [], 'replay-only': [], 'existing-only': [] };
  for (const d of diffs) grouped[d.type].push(d);

  if (grouped['mismatch'].length > 0) {
    console.log(`--- MISMATCHES (${grouped['mismatch'].length}) ---`);
    for (const d of grouped['mismatch']) {
      console.log(`\n  ${d.key}:`);
      for (const fd of d.fieldDiffs) {
        const rv = JSON.stringify(fd.replayed);
        const ev = JSON.stringify(fd.existing);
        // Truncate long values
        const rvShort = rv?.length > 120 ? rv.slice(0, 117) + '...' : rv;
        const evShort = ev?.length > 120 ? ev.slice(0, 117) + '...' : ev;
        console.log(`    ${fd.field}:`);
        console.log(`      replayed: ${rvShort}`);
        console.log(`      existing: ${evShort}`);
      }
    }
  }

  if (grouped['replay-only'].length > 0) {
    console.log(`\n--- REPLAY-ONLY (${grouped['replay-only'].length}) ---`);
    for (const d of grouped['replay-only']) {
      const preview = JSON.stringify(d.replayed).slice(0, 100);
      console.log(`  ${d.key}: ${preview}`);
    }
  }

  if (grouped['existing-only'].length > 0) {
    console.log(`\n--- EXISTING-ONLY (${grouped['existing-only'].length}) ---`);
    for (const d of grouped['existing-only']) {
      const preview = JSON.stringify(d.existing).slice(0, 100);
      console.log(`  ${d.key}: ${preview}`);
    }
  }
}

console.log('\nDone.');
