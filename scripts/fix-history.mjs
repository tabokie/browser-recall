#!/usr/bin/env node
/**
 * fix-history.mjs — Comprehensive JSONL history migration.
 *
 * Fixes:
 * 1. Add missing page_checkpoint entries for pages on disk without any checkpoint in history.
 * 2. Move ALL page_checkpoint entries to before the first page entry for the same URL
 *    (the canonical order: checkpoint creates entity, then page entries mutate it).
 *    Also populate empty checkpoint titles from the first page entry's title.
 * 3. Add missing `set` entries for settings keys written directly without logging.
 * 4. Add missing `list_meta` entries for lists whose name was set without logging.
 * 5. Add missing `note` entries for notes on disk with no history.
 * 6. Remove self-referencing referrerId from page entries.
 *
 * Usage:
 *   node scripts/fix-history.mjs              # dry run
 *   node scripts/fix-history.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { generateSlugFromUrl } from '../extension/utils.js';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Load all history
// ---------------------------------------------------------------------------
const historyFiles = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.jsonl')).sort();
const fileEntries = new Map(); // filename -> entry[]
const allEntries = [];

for (const file of historyFiles) {
  const entries = [];
  for (const line of readFileSync(join(HISTORY_DIR, file), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  fileEntries.set(file, entries);
  allEntries.push(...entries);
}
allEntries.sort((a, b) => a.timestamp - b.timestamp);
console.log(`Loaded ${allEntries.length} entries from ${historyFiles.length} files`);

const historyStart = allEntries[0]?.timestamp || Date.now();

// ---------------------------------------------------------------------------
// Build URL indexes
// ---------------------------------------------------------------------------
// First page entry per URL (for checkpoint placement)
const firstPageEntryByUrl = new Map(); // url -> entry
// All page_checkpoint entries by URL
const checkpointsByUrl = new Map(); // url -> entry[]

for (const e of allEntries) {
  if (e.action === 'page' && e.url && !firstPageEntryByUrl.has(e.url)) {
    firstPageEntryByUrl.set(e.url, e);
  }
  if (e.action === 'page_checkpoint' && e.url) {
    if (!checkpointsByUrl.has(e.url)) checkpointsByUrl.set(e.url, []);
    checkpointsByUrl.get(e.url).push(e);
  }
}

// ---------------------------------------------------------------------------
// Fix 1: Add missing page_checkpoint entries
// ---------------------------------------------------------------------------
console.log('\n--- Fix 1: Missing page_checkpoint entries ---');

const existingOnlyPages = JSON.parse(readFileSync('/tmp/existing-only-pages.json', 'utf-8'));
const newCheckpoints = [];

for (const page of existingOnlyPages) {
  if (!page.url) continue;
  if (checkpointsByUrl.has(page.url)) continue; // already has checkpoint

  const firstPage = firstPageEntryByUrl.get(page.url);
  if (!firstPage) {
    console.log(`  SKIP (no page entries): ${page.slug}`);
    continue;
  }
  newCheckpoints.push({
    timestamp: firstPage.timestamp - 1,
    action: 'page_checkpoint',
    url: page.url,
    title: page.title || firstPage.title || '',
  });
}
console.log(`  ${newCheckpoints.length} new page_checkpoint entries to add (from existing-only report)`);

// ---------------------------------------------------------------------------
// Fix 1b: Add checkpoints for uncheckpointed parent pages (referrerId targets)
// ---------------------------------------------------------------------------
console.log('\n--- Fix 1b: Checkpoints for uncheckpointed parent pages ---');

// Collect all page keys that already have checkpoints (including newly added ones)
const allCheckpointedKeys = new Set();
for (const [url] of checkpointsByUrl) {
  allCheckpointedKeys.add('page:' + generateSlugFromUrl(url));
}
for (const cp of newCheckpoints) {
  allCheckpointedKeys.add('page:' + generateSlugFromUrl(cp.url));
}

// Find parent keys referenced by referrerId or note parentIds that lack checkpoints
const uncheckpointedParents = new Map(); // parentKey -> { firstRefTs, url, title }

for (const e of allEntries) {
  if (e.action === 'page' && e.referrerId && e.url) {
    const parentKey = e.referrerId;
    if (!parentKey.startsWith('page:')) continue;
    if (allCheckpointedKeys.has(parentKey)) continue;
    if (uncheckpointedParents.has(parentKey)) continue;
    uncheckpointedParents.set(parentKey, { firstRefTs: e.timestamp });
  }
  if (e.action === 'note' && e.parentIds) {
    for (const parentKey of e.parentIds) {
      if (!parentKey.startsWith('page:')) continue;
      if (allCheckpointedKeys.has(parentKey)) continue;
      if (uncheckpointedParents.has(parentKey)) continue;
      uncheckpointedParents.set(parentKey, { firstRefTs: e.timestamp });
    }
  }
}

for (const [parentKey, info] of uncheckpointedParents) {
  const parentSlug = parentKey.slice('page:'.length);

  // Try to find page entries for this parent (to get URL and title)
  const parentPageEntry = allEntries.find(e =>
    e.action === 'page' && e.url && generateSlugFromUrl(e.url) === parentSlug
  );

  // Try to load from disk
  const diskPath = join(DATA_DIR, 'pages', parentSlug + '.json');
  let diskEntity = null;
  if (existsSync(diskPath)) {
    try { diskEntity = JSON.parse(readFileSync(diskPath, 'utf-8')); } catch {}
  }

  const url = parentPageEntry?.url || diskEntity?.url || '';
  const title = parentPageEntry?.title || diskEntity?.title || '';
  const ts = parentPageEntry
    ? parentPageEntry.timestamp - 1
    : (diskEntity?.timestamp || info.firstRefTs - 1);

  if (!url) {
    console.log(`  SKIP (no URL): ${parentKey}`);
    continue;
  }

  newCheckpoints.push({
    timestamp: ts,
    action: 'page_checkpoint',
    url,
    title,
  });
  allCheckpointedKeys.add(parentKey);
  console.log(`  Adding checkpoint for ${parentKey} (url=${url.slice(0, 60)}, title="${title.slice(0, 40)}")`);
}
console.log(`  Total new checkpoints now: ${newCheckpoints.length}`);

// ---------------------------------------------------------------------------
// Fix 2: Reorder existing checkpoints to before first page entry + fill titles
// ---------------------------------------------------------------------------
console.log('\n--- Fix 2: Reorder checkpoints + fill empty titles ---');

// Track which entries to remove from their original position
const entriesToRemove = new Set(); // stringified entry for identity
const entriesToInsert = []; // { entry, targetTs }
let reorderCount = 0;
let titleFillCount = 0;

for (const [url, checkpoints] of checkpointsByUrl) {
  const firstPage = firstPageEntryByUrl.get(url);
  if (!firstPage) continue;

  for (const cp of checkpoints) {
    let needsMove = cp.timestamp > firstPage.timestamp;
    let needsTitleFill = !cp.title && firstPage.title;

    if (needsMove || needsTitleFill) {
      // Remove original entry
      entriesToRemove.add(cp);

      // Create replacement with correct timestamp and title
      const fixed = { ...cp };
      if (needsMove) {
        fixed.timestamp = firstPage.timestamp - 1;
        reorderCount++;
      }
      if (needsTitleFill) {
        fixed.title = firstPage.title;
        titleFillCount++;
      }
      entriesToInsert.push(fixed);
    }
  }
}
console.log(`  ${reorderCount} checkpoints moved before first page entry`);
console.log(`  ${titleFillCount} empty titles filled from page entries`);

// ---------------------------------------------------------------------------
// Fix 3: Add missing settings entries
// ---------------------------------------------------------------------------
console.log('\n--- Fix 3: Missing settings entries ---');

const existingSettings = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf-8'));
const loggedSettingsKeys = new Set(allEntries.filter(e => e.action === 'set').map(e => e.key));
const newSettingsEntries = [];

for (const key of Object.keys(existingSettings)) {
  if (key === 'timestamp') continue;
  if (!loggedSettingsKeys.has(key)) {
    newSettingsEntries.push({
      timestamp: historyStart - 1,
      action: 'set',
      key,
      value: existingSettings[key],
    });
    console.log(`  Adding set entry for key="${key}"`);
  }
}
console.log(`  ${newSettingsEntries.length} settings entries to add`);

// ---------------------------------------------------------------------------
// Fix 4: Add missing list_meta entries
// ---------------------------------------------------------------------------
console.log('\n--- Fix 4: Missing list_meta entries ---');

const listsDir = join(DATA_DIR, 'lists');
const newListMetaEntries = [];

for (const f of readdirSync(listsDir).filter(f => f.endsWith('.json'))) {
  const listId = f.replace('.json', '');
  const listEntity = JSON.parse(readFileSync(join(listsDir, f), 'utf-8'));
  if (!listEntity.name) continue;

  const hasListMeta = allEntries.some(e => e.action === 'list_meta' && e.id === listId);
  if (hasListMeta) continue;

  const firstListEntry = allEntries.find(e =>
    (e.action === 'list' || e.action === 'list_meta') && e.id === listId
  );
  const ts = firstListEntry ? firstListEntry.timestamp - 1 : historyStart - 1;

  newListMetaEntries.push({
    timestamp: ts,
    action: 'list_meta',
    id: listId,
    name: listEntity.name,
  });
  console.log(`  Adding list_meta for "${listId}" name="${listEntity.name}"`);
}
console.log(`  ${newListMetaEntries.length} list_meta entries to add`);

// ---------------------------------------------------------------------------
// Fix 5: Add missing note entries
// ---------------------------------------------------------------------------
console.log('\n--- Fix 5: Missing note entries ---');

const existingOnlyNotes = JSON.parse(readFileSync('/tmp/existing-only-notes.json', 'utf-8'));
const loggedNoteSlugs = new Set(allEntries.filter(e => e.action === 'note').map(e => e.slug));
const newNoteEntries = [];

for (const note of existingOnlyNotes) {
  if (loggedNoteSlugs.has(note.slug)) continue; // already in history
  newNoteEntries.push({
    timestamp: note.timestamp,
    action: 'note',
    slug: note.slug,
    excerpt: note.excerpt,
    note: note.note,
    cssPath: note.cssPath,
    parentIds: note.parentIds,
    childIds: note.childIds,
  });
}
console.log(`  ${newNoteEntries.length} note entries to add`);

// ---------------------------------------------------------------------------
// Fix 6: Remove self-referencing referrerId
// ---------------------------------------------------------------------------
console.log('\n--- Fix 6: Remove self-referencing referrerId ---');

let selfRefCount = 0;
const selfRefMutations = new Map(); // "file:index" -> mutated entry

for (const [file, entries] of fileEntries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.action === 'page' && e.url && e.referrerId) {
      const slug = generateSlugFromUrl(e.url);
      const referrerSlug = e.referrerId.startsWith('page:')
        ? e.referrerId.slice('page:'.length) : e.referrerId;
      if (slug === referrerSlug) {
        selfRefCount++;
        const fixed = { ...e };
        delete fixed.referrerId;
        selfRefMutations.set(`${file}:${i}`, fixed);
        console.log(`  ${file}:${i} — ${slug} self-ref removed`);
      }
    }
  }
}
console.log(`  ${selfRefCount} self-referencing entries to fix`);

// ---------------------------------------------------------------------------
// Fix 7: Upgrade shallow: pin IDs in list entries when page is already checkpointed
// ---------------------------------------------------------------------------
console.log('\n--- Fix 7: Upgrade shallow pin IDs for checkpointed pages ---');

// Build a set of checkpointed URLs at each point in time
const checkpointedUrls = new Set();
// Include checkpoints already in history
for (const e of allEntries) {
  if (e.action === 'page_checkpoint' && e.url) checkpointedUrls.add(e.url);
}
// Include newly added checkpoints
for (const cp of newCheckpoints) {
  checkpointedUrls.add(cp.url);
}

let shallowUpgradeCount = 0;
const shallowUpgradeMutations = new Map(); // "file:index" -> mutated entry

for (const [file, entries] of fileEntries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.action !== 'list' || !e.ids) continue;
    let changed = false;
    const fixedIds = e.ids.map(id => {
      if (!id.startsWith('shallow:')) return id;
      const url = id.slice('shallow:'.length);
      if (!checkpointedUrls.has(url)) return id;
      changed = true;
      return 'page:' + generateSlugFromUrl(url);
    });
    if (changed) {
      shallowUpgradeCount++;
      const fixed = { ...e, ids: fixedIds };
      shallowUpgradeMutations.set(`${file}:${i}`, fixed);
      console.log(`  ${file}:${i} — upgraded ${e.ids.filter(id => id.startsWith('shallow:') && checkpointedUrls.has(id.slice(8))).join(', ')}`);
    }
  }
}
console.log(`  ${shallowUpgradeCount} list entries with shallow IDs upgraded`);

// ---------------------------------------------------------------------------
// Summary & Apply
// ---------------------------------------------------------------------------
const totalNew = newCheckpoints.length + entriesToInsert.length + newSettingsEntries.length + newListMetaEntries.length + newNoteEntries.length;
console.log('\n=== SUMMARY ===');
console.log(`  New entries to add: ${totalNew}`);
console.log(`  Entries to remove (reordered): ${entriesToRemove.size}`);
console.log(`  Entries to mutate (self-ref): ${selfRefMutations.size}`);
console.log(`  Entries to mutate (shallow upgrade): ${shallowUpgradeMutations.size}`);

if (dryRun) {
  console.log('\nDry run complete. Pass --apply to write changes.');
  process.exit(0);
}

// --- Apply mutations to file entries ---

// 1. Apply self-ref mutations
for (const [key, mutated] of selfRefMutations) {
  const [file, idxStr] = key.split(':');
  fileEntries.get(file)[parseInt(idxStr)] = mutated;
}

// 1b. Apply shallow upgrade mutations
for (const [key, mutated] of shallowUpgradeMutations) {
  const [file, idxStr] = key.split(':');
  fileEntries.get(file)[parseInt(idxStr)] = mutated;
}

// 2. Remove reordered checkpoints from their original files
for (const [file, entries] of fileEntries) {
  fileEntries.set(file, entries.filter(e => !entriesToRemove.has(e)));
}

// 3. Add all new entries to appropriate date files
function dateFileForTs(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}.jsonl`;
}

const allNewEntries = [
  ...newCheckpoints,
  ...entriesToInsert,
  ...newSettingsEntries,
  ...newListMetaEntries,
  ...newNoteEntries,
];

for (const entry of allNewEntries) {
  const file = dateFileForTs(entry.timestamp);
  if (!fileEntries.has(file)) fileEntries.set(file, []);
  fileEntries.get(file).push(entry);
}

// 4. Sort and write each file
let totalWritten = 0;
for (const [file, entries] of [...fileEntries].sort((a, b) => a[0].localeCompare(b[0]))) {
  entries.sort((a, b) => a.timestamp - b.timestamp);
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(HISTORY_DIR, file), content);
  totalWritten += entries.length;
}

console.log(`\nWrote ${totalWritten} entries across ${fileEntries.size} files.`);
console.log('Done. Re-run replay-verify.mjs to check results.');
