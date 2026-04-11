#!/usr/bin/env node
/**
 * Replay-verify: replay full JSONL history from scratch using effectOf,
 * persist replayed state to a temp directory, then diff against existing
 * checkpoints in ~/portal-data.
 *
 * Usage: node scripts/replay-verify.mjs [--write <dir>] [--verbose]
 *   --write <dir>  Write replayed entities to <dir> (default: /tmp/portal-replay)
 *   --verbose      Print detailed per-entity diffs (default: summary only)
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { effectOf, defaultEntity } from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');

// Parse args
let outputDir = '/tmp/portal-replay';
let verbose = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write' && args[i + 1]) outputDir = args[++i];
  if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
}

// ---------------------------------------------------------------------------
// 1. Load all log entries, sorted by timestamp
// ---------------------------------------------------------------------------
console.log('Loading logs...');
// Scan data/logs/<device>/*.jsonl subdirectories.
// Tag each entry with _deviceId so replay uses the correct per-device context.
const allEntries = [];
for (const deviceDir of readdirSync(LOGS_DIR)) {
  const devicePath = join(LOGS_DIR, deviceDir);
  try {
    if (!readdirSync(devicePath)) continue;
  } catch {
    continue;
  }
  for (const file of readdirSync(devicePath)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()) {
    const lines = readFileSync(join(devicePath, file), 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        entry._deviceId = deviceDir;
        allEntries.push(entry);
      } catch (e) {
        console.warn(
          `  SKIP bad JSON in ${deviceDir}/${file}: ${line.slice(0, 80)}`,
        );
      }
    }
  }
}

// Sort by timestamp (stable — preserves file order for same-ts entries)
allEntries.sort((a, b) => a.timestamp - b.timestamp);
console.log(`  ${allEntries.length} entries`);

// ---------------------------------------------------------------------------
// 1b. Normalize entries: fix known data inconsistencies
// ---------------------------------------------------------------------------
// Some log entries reference a list by a name it was later renamed to,
// before the rename event. This causes resolveListKey to fail during replay.
// Fix by rewriting pre-rename entries to use the list's original name.
console.log('Normalizing entries...');
let normFixedNames = 0;
let normFixedNulls = 0;
let normFixedCreate = 0;

const listRenames = [];
for (const entry of allEntries) {
  if (
    entry.action === 'update_list' &&
    entry.newName &&
    entry.name !== entry.newName
  ) {
    listRenames.push({
      owner: entry.listOwner,
      oldName: entry.name,
      newName: entry.newName,
      timestamp: entry.timestamp,
    });
  }
}

for (const rename of listRenames) {
  for (const entry of allEntries) {
    if (
      entry.listOwner === rename.owner &&
      entry.name === rename.newName &&
      entry.timestamp < rename.timestamp
    ) {
      entry.name = rename.oldName;
      normFixedNames++;
    }
  }
}

// If pins predate the create_list, move create_list earlier so replay sees it
for (const rename of listRenames) {
  const createEntry = allEntries.find(
    (e) =>
      e.action === 'create_list' &&
      e.name === rename.oldName &&
      e.listOwner === rename.owner,
  );
  if (!createEntry) continue;
  const earliestRef = allEntries
    .filter(
      (e) =>
        e.name === rename.oldName &&
        e.listOwner === rename.owner &&
        e.action !== 'create_list',
    )
    .reduce((min, e) => Math.min(min, e.timestamp), Infinity);
  if (earliestRef < createEntry.timestamp) {
    createEntry.timestamp = earliestRef - 1;
    normFixedCreate++;
  }
}

for (const entry of allEntries) {
  if (
    (entry.action === 'pin_to_list' || entry.action === 'unpin_from_list') &&
    entry.items
  ) {
    const before = entry.items.length;
    entry.items = entry.items.filter((item) => item != null);
    normFixedNulls += before - entry.items.length;
  }
}

if (normFixedNames || normFixedNulls || normFixedCreate) {
  allEntries.sort((a, b) => a.timestamp - b.timestamp);
  if (normFixedNames)
    console.log(`  Fixed ${normFixedNames} entries with future list names`);
  if (normFixedCreate)
    console.log(`  Adjusted ${normFixedCreate} create_list timestamps`);
  if (normFixedNulls)
    console.log(`  Removed ${normFixedNulls} null items from pin_to_list`);
} else {
  console.log('  No fixes needed');
}

// ---------------------------------------------------------------------------
// 2. Replay all entries through effectOf, accumulating state in a Map
// ---------------------------------------------------------------------------
console.log('Replaying...');
const store = new Map();
function loadFromDisk(key) {
  if (key.startsWith('note:')) {
    const slug = key.slice('note:'.length);
    const p = join(DATA_DIR, 'data', 'notes', `${slug}.json`);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return null;
      }
    }
  }
  return null;
}
const load = async (key) => store.get(key) ?? loadFromDisk(key) ?? null;

for (let i = 0; i < allEntries.length; i++) {
  const entry = allEntries[i];
  const deviceId = entry._deviceId;
  delete entry._deviceId;
  try {
    const result = await effectOf(entry, load, { deviceId });
    for (const [key, value] of Object.entries(result)) {
      store.set(key, value);
    }
  } catch (e) {
    console.warn(
      `  ERROR replaying entry ${i} (ts=${entry.timestamp}, action=${entry.action}): ${e.message}`,
    );
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
mkdirSync(join(outputDir, 'manifest'), { recursive: true });

for (const [key, value] of store) {
  if (value === null) continue;
  if (value.deleted) continue; // Deleted entities have no disk file
  let path;
  if (key === 'manifest:settings') {
    path = join(outputDir, 'manifest', 'settings.json');
  } else if (key === 'manifest:orphaned') {
    path = join(outputDir, 'manifest', 'orphaned.json');
  } else if (key === 'manifest:name-to-id') {
    path = join(outputDir, 'manifest', 'list-name-to-id.json');
  } else if (key === 'manifest:list-order') {
    path = join(outputDir, 'manifest', 'list-order.json');
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

function loadExisting(relPath) {
  const full = join(DATA_DIR, relPath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf-8'));
  } catch {
    return null;
  }
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// Classify a per-field diff into a category:
//   schema-gap    — field added/removed by code evolution (replay has it, disk doesn't or vice-versa)
//   timing-drift  — replay and disk differ due to checkpoint timing
//   data          — genuine data discrepancy needing investigation
const SCHEMA_ADDED_FIELDS = new Set(['createdAt', 'visitDates']);

function classifyFieldDiff(field, replayed, existing, entityKey) {
  // Field present in replay but absent (undefined) on disk → schema evolution
  if (SCHEMA_ADDED_FIELDS.has(field) && existing === undefined)
    return 'schema-gap';

  // timestamps: replay undefined vs disk {} (empty obj) → schema gap (old default-init)
  if (
    field === 'timestamps' &&
    replayed === undefined &&
    deepEqual(existing, {})
  )
    return 'schema-gap';
  // timestamps: replay {} vs disk undefined → schema gap
  if (
    field === 'timestamps' &&
    deepEqual(replayed, {}) &&
    existing === undefined
  )
    return 'schema-gap';
  // timestamps: singular 'timestamp' vs per-device 'timestamps' on manifests
  if (field === 'timestamp' && existing !== undefined && replayed === undefined)
    return 'schema-gap';

  // timestamps: replay undefined vs disk has value → page entity created after
  // visit in replay (ensurePageEntity doesn't set timestamps; the visit_page that
  // would have set it ran before the entity existed in replay's timeline)
  if (
    field === 'timestamps' &&
    replayed === undefined &&
    typeof existing === 'object' &&
    existing !== null
  ) {
    return 'timing-drift';
  }

  // scrollDepth/timeOnPage: replay undefined, disk 0 → old default-init
  if (
    (field === 'scrollDepth' || field === 'timeOnPage') &&
    replayed === undefined &&
    existing === 0
  )
    return 'schema-gap';

  // timestamps: both have per-device objects → timing drift when replay is
  // at least as recent (it processed more events than the disk checkpoint)
  if (
    field === 'timestamps' &&
    typeof replayed === 'object' &&
    typeof existing === 'object' &&
    replayed &&
    existing
  ) {
    const allDevices = new Set([
      ...Object.keys(replayed),
      ...Object.keys(existing),
    ]);
    if (allDevices.size > 0) {
      let replayNewer = true;
      for (const d of allDevices) {
        if ((replayed[d] ?? 0) < (existing[d] ?? 0)) {
          replayNewer = false;
          break;
        }
      }
      if (replayNewer) return 'timing-drift';
    }
  }

  // timeOnPage/scrollDepth numeric diffs → timing drift (leave_page ordering)
  if (
    (field === 'timeOnPage' || field === 'scrollDepth') &&
    replayed !== undefined &&
    existing !== undefined
  )
    return 'timing-drift';

  // visitDates: both have arrays but they differ → checkpoint timing
  // (replay accumulates full history, disk checkpointed at intermediate state)
  if (
    field === 'visitDates' &&
    Array.isArray(replayed) &&
    Array.isArray(existing)
  )
    return 'timing-drift';
  // visitDates: disk has value but replay doesn't → visit before entity creation
  if (
    field === 'visitDates' &&
    replayed === undefined &&
    existing !== undefined
  )
    return 'timing-drift';

  // childIds/parentIds with strictly additive referrer entries → timing drift
  if (
    (field === 'childIds' || field === 'parentIds') &&
    Array.isArray(replayed) &&
    Array.isArray(existing)
  ) {
    const rSet = new Set(replayed);
    const eSet = new Set(existing);
    const onlyInReplay = replayed.filter((x) => !eSet.has(x));
    const onlyInExisting = existing.filter((x) => !rSet.has(x));
    const allReferrers = [...onlyInReplay, ...onlyInExisting].every((id) =>
      id.startsWith('page:'),
    );
    if (allReferrers) return 'timing-drift';
  }

  // scrollDepth/timeOnPage: replay undefined, disk has numeric value →
  // leave_page processed before entity existed in replay
  if (
    (field === 'scrollDepth' || field === 'timeOnPage') &&
    replayed === undefined &&
    typeof existing === 'number'
  ) {
    return 'timing-drift';
  }

  // title: undefined vs empty string → old code stored "" as default
  if (
    field === 'title' &&
    ((replayed === undefined && existing === '') ||
      (replayed === '' && existing === undefined))
  ) {
    return 'schema-gap';
  }

  return 'data';
}

function diffFields(replayed, existing) {
  const allFields = new Set([
    ...Object.keys(replayed || {}),
    ...Object.keys(existing || {}),
  ]);
  const fieldDiffs = [];
  for (const field of allFields) {
    const rv = replayed?.[field];
    const ev = existing?.[field];
    if (!deepEqual(rv, ev)) {
      fieldDiffs.push({ field, replayed: rv, existing: ev });
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

// Lists (non-system)
if (existsSync(join(DATA_DIR, 'lists'))) {
  for (const f of readdirSync(join(DATA_DIR, 'lists'))) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace('.json', '');
    entityPaths.set(`list:${slug}`, `lists/${f}`);
  }
}

// Manifest entities
entityPaths.set('manifest:settings', 'manifest/settings.json');
entityPaths.set('manifest:orphaned', 'manifest/orphaned.json');
entityPaths.set('manifest:name-to-id', 'manifest/list-name-to-id.json');
entityPaths.set('manifest:list-order', 'manifest/list-order.json');

// Collect all keys (union of replayed + existing)
const allKeys = new Set([...store.keys(), ...entityPaths.keys()]);

let matchCount = 0;
let replayOnlyCount = 0;
let existingOnlyCount = 0;
const categoryCounts = { 'schema-gap': 0, 'timing-drift': 0, data: 0 };
const categoryExamples = { 'schema-gap': [], 'timing-drift': [], data: [] };
const MAX_EXAMPLES = 5;

const allDiffs = { 'schema-gap': [], 'timing-drift': [], data: [] };
const replayOnlyKeys = [];
const existingOnlyKeys = [];

for (const key of [...allKeys].sort()) {
  if (key.startsWith('snapshot:')) continue;

  const raw = store.get(key) ?? null;
  const replayed = raw && raw.deleted ? null : raw;
  const existingPath = entityPaths.get(key);
  const existing = existingPath ? loadExisting(existingPath) : null;

  if (replayed === null && existing === null) continue;

  // Deleted entities: file stays on disk (deletion = unlink + orphan)
  if (raw?.deleted && existing !== null) {
    matchCount++;
    continue;
  }

  if (replayed !== null && existing === null) {
    replayOnlyCount++;
    replayOnlyKeys.push(key);
    continue;
  }

  if (replayed === null && existing !== null) {
    existingOnlyCount++;
    existingOnlyKeys.push(key);
    continue;
  }

  // Both exist — compare with stable key ordering
  if (deepEqual(replayed, existing)) {
    matchCount++;
    continue;
  }

  // Classify each field diff into a category; the entity's worst category wins
  const fieldDiffs = diffFields(replayed, existing);
  let worstCategory = 'schema-gap';
  const rank = { 'schema-gap': 0, 'timing-drift': 1, data: 2 };
  for (const fd of fieldDiffs) {
    const cat = classifyFieldDiff(fd.field, fd.replayed, fd.existing, key);
    fd.category = cat;
    if (rank[cat] > rank[worstCategory]) worstCategory = cat;
  }

  categoryCounts[worstCategory]++;
  allDiffs[worstCategory].push({ key, fieldDiffs });
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------
const totalCompared =
  matchCount +
  replayOnlyCount +
  existingOnlyCount +
  categoryCounts['schema-gap'] +
  categoryCounts['timing-drift'] +
  categoryCounts.data;
const totalMismatch =
  categoryCounts['schema-gap'] +
  categoryCounts['timing-drift'] +
  categoryCounts.data;

console.log(`\n=== RESULTS (${totalCompared} entities compared) ===`);
console.log(`  Matching:       ${matchCount}`);
console.log(`  Mismatched:     ${totalMismatch}`);
console.log(
  `    schema-gap:     ${categoryCounts['schema-gap']}  (field added/removed by code evolution)`,
);
console.log(
  `    timing-drift:   ${categoryCounts['timing-drift']}  (checkpoint written at intermediate state)`,
);
console.log(
  `    data:           ${categoryCounts.data}  (genuine difference — investigate)`,
);
console.log(`  Replay-only:    ${replayOnlyCount}`);
console.log(`  Existing-only:  ${existingOnlyCount}`);

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

// Field-level mismatch frequency across all categories
const fieldFreq = {};
for (const cat of Object.keys(allDiffs)) {
  for (const ex of allDiffs[cat]) {
    for (const fd of ex.fieldDiffs) {
      fieldFreq[fd.field] = (fieldFreq[fd.field] || 0) + 1;
    }
  }
}
if (Object.keys(fieldFreq).length > 0) {
  console.log('\n=== FIELD MISMATCH FREQUENCY ===');
  for (const [field, count] of Object.entries(fieldFreq).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${field.padEnd(20)} ${count}`);
  }
}

for (const cat of ['data', 'timing-drift', 'schema-gap']) {
  const items = allDiffs[cat];
  if (items.length === 0) continue;
  const shown = verbose ? items : items.slice(0, MAX_EXAMPLES);
  const label = verbose ? items.length : `showing ${shown.length}`;
  console.log(
    `\n--- ${cat.toUpperCase()} (${items.length} total, ${label}) ---`,
  );
  for (const ex of shown) {
    console.log(`\n  ${ex.key}:`);
    for (const fd of ex.fieldDiffs) {
      const rv = truncate(JSON.stringify(fd.replayed) ?? 'undefined', 120);
      const ev = truncate(JSON.stringify(fd.existing) ?? 'undefined', 120);
      const tag = fd.category !== cat ? ` [${fd.category}]` : '';
      console.log(`    ${fd.field}${tag}:`);
      console.log(`      replayed: ${rv}`);
      console.log(`      existing: ${ev}`);
    }
  }
  if (!verbose && items.length > MAX_EXAMPLES) {
    console.log(
      `\n  ... ${items.length - MAX_EXAMPLES} more (use --verbose to see all)`,
    );
  }
}

if (replayOnlyCount > 0) {
  const shown = verbose
    ? replayOnlyKeys
    : replayOnlyKeys.slice(0, MAX_EXAMPLES);
  console.log(`\n--- REPLAY-ONLY (${replayOnlyCount}) ---`);
  for (const key of shown) console.log(`  ${key}`);
  if (!verbose && replayOnlyKeys.length > MAX_EXAMPLES) {
    console.log(`  ... ${replayOnlyKeys.length - MAX_EXAMPLES} more`);
  }
}

if (existingOnlyCount > 0) {
  const shown = verbose
    ? existingOnlyKeys
    : existingOnlyKeys.slice(0, MAX_EXAMPLES);
  console.log(`\n--- EXISTING-ONLY (${existingOnlyCount}) ---`);
  for (const key of shown) console.log(`  ${key}`);
  if (!verbose && existingOnlyKeys.length > MAX_EXAMPLES) {
    console.log(`  ... ${existingOnlyKeys.length - MAX_EXAMPLES} more`);
  }
}

if (
  categoryCounts.data === 0 &&
  replayOnlyCount === 0 &&
  existingOnlyCount === 0
) {
  console.log(
    '\n✔ No data-level discrepancies. All diffs are benign (schema gaps or timing drift).',
  );
} else if (categoryCounts.data === 0) {
  console.log(
    `\n✔ No data-level mismatches. ${replayOnlyCount + existingOnlyCount} entity-presence diffs remain.`,
  );
}

console.log('\nDone.');
