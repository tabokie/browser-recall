#!/usr/bin/env node
/**
 * migrate-list-tree.mjs — Replace list:system/root + per-entity hierarchy
 * fields (parentList, childLists) with manifest/list-order.json tree blob.
 *
 * Changes:
 * 1. Read lists/system/root.json, recursively walk childLists to build nested tree
 * 2. Write manifest/list-order.json with the tree
 * 3. Flatten manifest/list-name-to-id.json: 'root/A/B' → 'B' (leaf name only)
 * 4. Strip parentList and childLists from all lists/*.json files
 * 5. Delete lists/system/root.json
 * 6. Strip reparent_list entries from data/logs/*.jsonl files
 *
 * Idempotent: skips if manifest/list-order.json already exists.
 *
 * Usage:
 *   node scripts/migrate-list-tree.mjs              # dry run
 *   node scripts/migrate-list-tree.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const LISTS_DIR = join(DATA_DIR, 'lists');
const MANIFEST_DIR = join(DATA_DIR, 'manifest');
const LOGS_DIR = join(DATA_DIR, 'data', 'logs');
const ROOT_PATH = join(LISTS_DIR, 'system', 'root.json');
const LIST_ORDER_PATH = join(MANIFEST_DIR, 'list-order.json');
const NAME_TO_ID_PATH = join(MANIFEST_DIR, 'list-name-to-id.json');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Guard: skip if manifest/list-order.json already exists
// ---------------------------------------------------------------------------
if (existsSync(LIST_ORDER_PATH)) {
  console.log('manifest/list-order.json already exists — migration already applied, skipping.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Read root.json, build nested tree
// ---------------------------------------------------------------------------
if (!existsSync(ROOT_PATH)) {
  console.error('lists/system/root.json not found at', ROOT_PATH);
  process.exit(1);
}

const root = JSON.parse(readFileSync(ROOT_PATH, 'utf-8'));
const rootChildren = root.childLists || [];
console.log(`Root has ${rootChildren.length} top-level children`);

// Load a list entity by key (e.g. 'list:reading' → lists/reading.json)
function loadList(key) {
  const slug = key.replace(/^list:/, '');
  const filePath = join(LISTS_DIR, ...slug.split('/')) + '.json';
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// Recursively build tree from root's childLists
function buildTree(childKeys) {
  const nodes = [];
  for (const key of childKeys) {
    const entity = loadList(key);
    const node = { id: key };
    if (entity?.childLists?.length) {
      node.children = buildTree(entity.childLists);
    }
    nodes.push(node);
  }
  return nodes;
}

const tree = buildTree(rootChildren);
const listOrder = { timestamp: root.timestamp || Date.now(), tree };

console.log('Built tree:');
function printTree(nodes, indent = '  ') {
  for (const n of nodes) {
    console.log(`${indent}${n.id}`);
    if (n.children) printTree(n.children, indent + '  ');
  }
}
printTree(tree);

// ---------------------------------------------------------------------------
// 2. Write manifest/list-order.json
// ---------------------------------------------------------------------------
console.log('\nWriting manifest/list-order.json');
if (!dryRun) {
  writeFileSync(LIST_ORDER_PATH, JSON.stringify(listOrder, null, 2));
}

// ---------------------------------------------------------------------------
// 3. Flatten manifest/list-name-to-id.json
// ---------------------------------------------------------------------------
if (existsSync(NAME_TO_ID_PATH)) {
  const nameToId = JSON.parse(readFileSync(NAME_TO_ID_PATH, 'utf-8'));
  const oldPaths = nameToId.paths || {};
  const newPaths = {};
  let flattened = 0;

  for (const [pathKey, id] of Object.entries(oldPaths)) {
    // Extract leaf name: 'root/A/B' → 'B'
    const parts = pathKey.split('/');
    const leaf = parts[parts.length - 1];
    if (leaf !== pathKey) flattened++;
    newPaths[leaf] = id;
  }

  console.log(`Flattened ${flattened} path entries in list-name-to-id.json`);
  nameToId.paths = newPaths;

  if (!dryRun) {
    writeFileSync(NAME_TO_ID_PATH, JSON.stringify(nameToId, null, 2));
  }
} else {
  console.log('No list-name-to-id.json found — skipping');
}

// ---------------------------------------------------------------------------
// 4. Strip parentList and childLists from all lists/*.json files
// ---------------------------------------------------------------------------
function processDir(dir, prefix = '') {
  let updated = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Skip system directory (will be handled separately)
      if (entry.name === 'system') continue;
      updated += processDir(join(dir, entry.name), prefix + entry.name + '/');
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;

    const filePath = join(dir, entry.name);
    const entity = JSON.parse(readFileSync(filePath, 'utf-8'));

    let changed = false;
    if ('parentList' in entity) {
      delete entity.parentList;
      changed = true;
    }
    if ('childLists' in entity) {
      delete entity.childLists;
      changed = true;
    }

    if (changed) {
      console.log(`  Stripping parentList/childLists from ${prefix}${entry.name}`);
      if (!dryRun) {
        writeFileSync(filePath, JSON.stringify(entity, null, 2));
      }
      updated++;
    }
  }
  return updated;
}

const updated = processDir(LISTS_DIR);
console.log(`Updated ${updated} list entities`);

// ---------------------------------------------------------------------------
// 5. Delete lists/system/root.json
// ---------------------------------------------------------------------------
console.log('Deleting lists/system/root.json');
if (!dryRun) {
  unlinkSync(ROOT_PATH);
}

// ---------------------------------------------------------------------------
// 6. Strip reparent_list entries from data/logs/*.jsonl files
// ---------------------------------------------------------------------------
if (existsSync(LOGS_DIR)) {
  let totalStripped = 0;

  for (const file of readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort()) {
    const filePath = join(LOGS_DIR, file);
    const lines = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    let stripped = 0;
    const newLines = lines.filter(line => {
      try {
        const entry = JSON.parse(line);
        if (entry.action === 'reparent_list') {
          stripped++;
          return false;
        }
      } catch { /* keep malformed lines */ }
      return true;
    });

    if (stripped > 0) {
      console.log(`  ${file}: stripped ${stripped} reparent_list entries`);
      if (!dryRun) {
        writeFileSync(filePath, newLines.join('\n') + '\n');
      }
      totalStripped += stripped;
    }
  }

  console.log(`Stripped ${totalStripped} reparent_list entries total`);

  // 7. Append update_list_tree entry to the last log file so replay produces the correct tree.
  // Timestamp must be strictly greater than all other tree-modifying events (create_list, delete_list)
  // to survive the LWW guard in effectOf (rejects entries with timestamp <= current).
  if (totalStripped > 0) {
    const logFiles = readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl')).sort();
    const lastFile = logFiles[logFiles.length - 1];
    if (lastFile) {
      // Find max timestamp of all tree-modifying events
      const treeActions = new Set(['create_list', 'delete_list', 'restore_list']);
      let maxTs = listOrder.timestamp;
      for (const file of logFiles) {
        for (const line of readFileSync(join(LOGS_DIR, file), 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (treeActions.has(e.action) && e.timestamp > maxTs) maxTs = e.timestamp;
          } catch {}
        }
      }
      const entryTs = maxTs + 1;
      const updateEntry = {
        timestamp: entryTs,
        action: 'update_list_tree',
        tree,
      };
      // Also update the checkpoint timestamp to match
      listOrder.timestamp = entryTs;
      console.log(`\nAppending update_list_tree (ts=${entryTs}) to ${lastFile}`);
      if (!dryRun) {
        writeFileSync(LIST_ORDER_PATH, JSON.stringify(listOrder, null, 2));
      }
      if (!dryRun) {
        const lastPath = join(LOGS_DIR, lastFile);
        const content = readFileSync(lastPath, 'utf-8');
        writeFileSync(lastPath, content.trimEnd() + '\n' + JSON.stringify(updateEntry) + '\n');
      }
    }
  }
} else {
  console.log('No data/logs/ directory found — skipping');
}

console.log(dryRun ? '\n=== DRY RUN complete (pass --apply to write) ===' : '\nMigration complete.');
