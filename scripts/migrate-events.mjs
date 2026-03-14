#!/usr/bin/env node
/**
 * migrate-events.mjs — Rewrite all JSONL history files from old event format
 * to new event format.
 *
 * Old actions: page, page_checkpoint, snap, list, list_meta, reparent_list,
 *              del_list, restore_list, set, note, del_note, restore_note,
 *              del_snap, restore_snap
 *
 * New actions: visit_page, leave_page, rate_page, rename_page,
 *              create_snapshot, create_note, delete_note, restore_note,
 *              delete_snapshot, restore_snapshot, pin_to_list, unpin_from_list,
 *              create_list, update_list, reparent_list, delete_list, restore_list,
 *              update_setting
 *
 * Usage:
 *   node scripts/migrate-events.mjs              # dry run (prints stats)
 *   node scripts/migrate-events.mjs --apply      # apply changes
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync, cpSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.env.HOME, 'portal-data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const OUTPUT_DIR = join(DATA_DIR, 'data', 'logs');
const BACKUP_DIR = join(DATA_DIR, 'history-backup');
const dryRun = !process.argv.includes('--apply');

if (dryRun) console.log('=== DRY RUN (pass --apply to write) ===\n');

// ---------------------------------------------------------------------------
// Slug generation (must match extension/utils.js exactly)
// ---------------------------------------------------------------------------
function generateSlug(text, hashInput) {
  if (!text || text.trim() === '') text = 'untitled';
  const base = text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 30)
    .replace(/-+$/, '');
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
  }
  return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
}

function generateSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    let domain = parsed.hostname.toLowerCase();
    if (domain.startsWith('www.')) domain = domain.slice(4);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot > 0) domain = domain.slice(0, lastDot);
    const text = domain + parsed.pathname;
    return generateSlug(text, url);
  } catch {
    return 'untitled';
  }
}

// ---------------------------------------------------------------------------
// 1. Build lookup tables
// ---------------------------------------------------------------------------
console.log('Building lookup tables...');

// 1a. slug -> url map from page entity files
const slugToUrl = new Map();
const pagesDir = join(DATA_DIR, 'pages');
if (existsSync(pagesDir)) {
  for (const f of readdirSync(pagesDir)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace('.json', '');
    try {
      const entity = JSON.parse(readFileSync(join(pagesDir, f), 'utf-8'));
      if (entity.url) {
        slugToUrl.set(slug, entity.url);
      }
    } catch {}
  }
}
console.log(`  ${slugToUrl.size} page entities loaded (slug -> URL)`);

// 1b. list ID -> entity map, and build name paths via BFS from root
const listEntities = new Map(); // id -> entity (e.g., 'ai-core-ffnyqr' -> {...})
const listsDir = join(DATA_DIR, 'lists');
if (existsSync(listsDir)) {
  for (const f of readdirSync(listsDir)) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace('.json', '');
    try {
      const entity = JSON.parse(readFileSync(join(listsDir, f), 'utf-8'));
      listEntities.set(id, entity);
    } catch {}
  }
  // System/auto lists in subdirectories
  const systemDir = join(listsDir, 'system');
  if (existsSync(systemDir)) {
    for (const f of readdirSync(systemDir)) {
      if (!f.endsWith('.json')) continue;
      const id = 'system/' + f.replace('.json', '');
      try {
        const entity = JSON.parse(readFileSync(join(systemDir, f), 'utf-8'));
        listEntities.set(id, entity);
      } catch {}
    }
  }
  const autoDir = join(listsDir, 'auto');
  if (existsSync(autoDir)) {
    for (const f of readdirSync(autoDir)) {
      if (!f.endsWith('.json')) continue;
      const id = 'auto/' + f.replace('.json', '');
      try {
        const entity = JSON.parse(readFileSync(join(autoDir, f), 'utf-8'));
        listEntities.set(id, entity);
      } catch {}
    }
  }
}
console.log(`  ${listEntities.size} list entities loaded`);

// Build list ID -> name path map via BFS from root
const listIdToNamePath = new Map(); // e.g., 'ai-core-ffnyqr' -> 'root/AI Core'
const namePathToId = new Map();     // reverse: 'root/AI Core' -> 'ai-core-ffnyqr'

function buildNamePaths() {
  const root = listEntities.get('system/root');
  if (!root) {
    console.warn('  WARNING: system/root entity not found');
    return;
  }

  // BFS from root
  const queue = []; // { listKey, parentPath }
  for (const childKey of (root.childLists || [])) {
    const childId = childKey.startsWith('list:') ? childKey.slice(5) : childKey;
    queue.push({ id: childId, parentPath: 'root' });
  }

  const visited = new Set();
  while (queue.length > 0) {
    const { id, parentPath } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const entity = listEntities.get(id);
    if (!entity) continue;

    const name = entity.name || id;
    const path = `${parentPath}/${name}`;
    listIdToNamePath.set(id, path);
    namePathToId.set(path, id);

    for (const childKey of (entity.childLists || [])) {
      const childId = childKey.startsWith('list:') ? childKey.slice(5) : childKey;
      queue.push({ id: childId, parentPath: path });
    }
  }

  // Also add system and auto lists
  for (const [id, entity] of listEntities) {
    if (listIdToNamePath.has(id)) continue;
    if (id.startsWith('system/')) {
      const path = id; // e.g., 'system/explore'
      listIdToNamePath.set(id, path);
      namePathToId.set(path, id);
    } else if (id.startsWith('auto/')) {
      const path = id; // e.g., 'auto/gateways'
      listIdToNamePath.set(id, path);
      namePathToId.set(path, id);
    } else if (id === 'auto') {
      // The auto parent list
      listIdToNamePath.set(id, 'auto');
      namePathToId.set('auto', id);
    }
  }
}

buildNamePaths();
console.log(`  ${listIdToNamePath.size} list name paths built`);
for (const [id, path] of listIdToNamePath) {
  console.log(`    ${id} -> ${path}`);
}

// ---------------------------------------------------------------------------
// Helper: resolve referrerId to URL
// ---------------------------------------------------------------------------
function resolveReferrerToUrl(referrerId) {
  if (!referrerId) return null;
  // Format: 'page:<slug>'
  const slug = referrerId.startsWith('page:') ? referrerId.slice(5) : referrerId;
  return slugToUrl.get(slug) || null;
}

// Helper: resolve list id to name path
function resolveListNamePath(id) {
  // Direct lookup
  if (listIdToNamePath.has(id)) return listIdToNamePath.get(id);

  // For old entries using 'system/root' as from/to
  if (id === 'system/root') return 'root';

  return null;
}

// Helper: resolve typed ID to item (URL for pages, notes/<slug>.json for notes)
function resolveTypedIdToItem(id) {
  if (id.startsWith('page:')) {
    const slug = id.slice(5);
    return slugToUrl.get(slug) || null;
  }
  if (id.startsWith('shallow:')) {
    return id.slice(8);
  }
  if (id.startsWith('note:')) {
    const noteSlug = id.slice(5);
    return `notes/${noteSlug}.json`;
  }
  return null;
}

// Helper: split a name path into { parents, name } for event format
// 'root/AI Core' -> { parents: ['root'], name: 'AI Core' }
// 'root/Folder/Sub' -> { parents: ['root', 'Folder'], name: 'Sub' }
// 'auto/gateways' -> { parents: [], name: 'auto/gateways' }
function namePathToParentsAndName(namePath) {
  if (!namePath) return null;
  if (namePath.startsWith('system/') || namePath.startsWith('auto/') || namePath === 'auto') {
    return { parents: [], name: namePath };
  }
  const parts = namePath.split('/');
  const name = parts.pop();
  return { parents: parts, name };
}

// Helper: convert parentPath string to parents array for create_list events.
// background.js convention: 'root' -> [], 'root/Foo' -> ['root', 'Foo']
// replay.js create_list: parents.length === 0 means parent is system/root.
function parentPathToArray(parentPath) {
  if (!parentPath || parentPath === 'root') return [];
  return parentPath.split('/');
}

// ---------------------------------------------------------------------------
// 2. Load all JSONL history files
// ---------------------------------------------------------------------------
console.log('\nLoading history files...');
const historyFiles = readdirSync(HISTORY_DIR)
  .filter(f => f.endsWith('.jsonl'))
  .sort();

const fileEntries = new Map(); // filename -> entry[]
let totalOldEntries = 0;

for (const file of historyFiles) {
  const entries = [];
  for (const line of readFileSync(join(HISTORY_DIR, file), 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      console.warn(`  SKIP bad JSON in ${file}: ${line.slice(0, 80)}`);
    }
  }
  fileEntries.set(file, entries);
  totalOldEntries += entries.length;
}
console.log(`  ${totalOldEntries} entries from ${historyFiles.length} files`);

// ---------------------------------------------------------------------------
// 3. Process all entries: convert old -> new format
// ---------------------------------------------------------------------------
console.log('\nMigrating events...');

// Track first occurrence of each list ID for create_list vs update_list
const seenListIds = new Set();

// Track list ID -> name path dynamically (evolves during replay for renames/reparents)
// Initialize from current state — we'll track mutations as we replay
const dynamicListNamePath = new Map(listIdToNamePath);
const dynamicNamePathToId = new Map(namePathToId);

// Dynamically update name paths as we process list_meta and reparent_list
function dynamicResolveListName(id) {
  if (dynamicListNamePath.has(id)) return dynamicListNamePath.get(id);
  if (id === 'system/root') return 'root';
  // Try entity name if we have the entity
  const entity = listEntities.get(id);
  if (entity?.name) {
    // Infer path: if parentList is root, it's root/<name>
    const parentKey = entity.parentList;
    if (parentKey === 'list:system/root' || !parentKey) {
      return `root/${entity.name}`;
    }
    const parentId = parentKey.startsWith('list:') ? parentKey.slice(5) : parentKey;
    const parentPath = dynamicListNamePath.get(parentId);
    if (parentPath) {
      return `${parentPath}/${entity.name}`;
    }
    return `root/${entity.name}`;
  }
  return null;
}

// Stats
const stats = {
  visit_page: 0,
  leave_page: 0,
  rate_page: 0,
  rename_page: 0,
  create_snapshot: 0,
  page_checkpoint_dropped: 0,
  page_snap_merged: 0,
  create_list: 0,
  update_list: 0,
  pin_to_list: 0,
  unpin_from_list: 0,
  reparent_list: 0,
  delete_list: 0,
  restore_list: 0,
  update_setting: 0,
  create_note: 0,
  delete_note: 0,
  restore_note: 0,
  delete_snapshot: 0,
  restore_snapshot: 0,
  unknown_dropped: 0,
  list_clear_dropped: 0,
};

const migratedFiles = new Map(); // filename -> newEntry[]

for (const [file, entries] of fileEntries) {
  const newEntries = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const action = entry.action;

    // --- page (overloaded) ---
    if (action === 'page') {
      // Case 1: Has mdPath/htmlPath -> snapshot capture page entry (skip, merged with snap)
      if (entry.mdPath || entry.htmlPath) {
        stats.page_snap_merged++;
        continue;
      }

      // Case 2: Has likes -> rate_page
      if (entry.likes !== undefined) {
        newEntries.push({
          action: 'rate_page',
          url: entry.url,
          likes: entry.likes,
          timestamp: entry.timestamp,
        });
        stats.rate_page++;
        continue;
      }

      // Case 3: Has user_title AND no other meaningful fields -> rename_page
      if (entry.user_title !== undefined) {
        const hasScroll = entry.scrollDepth !== undefined;
        const hasTime = entry.timeOnPage !== undefined;
        const hasRef = !!entry.referrerId;
        const hasTitle = !!entry.title;
        if (!hasScroll && !hasTime && !hasRef && !hasTitle) {
          newEntries.push({
            action: 'rename_page',
            url: entry.url,
            user_title: entry.user_title,
            timestamp: entry.timestamp,
          });
          stats.rename_page++;
          continue;
        }
      }

      // Case 4: Has scrollDepth or timeOnPage AND no referrerId -> leave_page
      // But must check: if it also has a title and no scroll/time, it's a visit.
      // The key heuristic: entries with ONLY timeOnPage or scrollDepth (no referrerId)
      // and no title being newly introduced are leave events.
      const hasScroll = entry.scrollDepth !== undefined;
      const hasTime = entry.timeOnPage !== undefined;
      const hasRef = !!entry.referrerId;

      if ((hasScroll || hasTime) && !hasRef) {
        const newEntry = {
          action: 'leave_page',
          url: entry.url,
          timestamp: entry.timestamp,
        };
        if (entry.title) newEntry.title = entry.title;
        if (hasScroll) newEntry.scrollDepth = entry.scrollDepth;
        if (hasTime) newEntry.timeOnPage = entry.timeOnPage;
        newEntries.push(newEntry);
        stats.leave_page++;
        continue;
      }

      // Case 5: Otherwise -> visit_page
      {
        const newEntry = {
          action: 'visit_page',
          url: entry.url,
          timestamp: entry.timestamp,
        };
        if (entry.title) newEntry.title = entry.title;
        if (entry.referrerId) {
          const refUrl = resolveReferrerToUrl(entry.referrerId);
          if (refUrl) {
            newEntry.referrerUrl = refUrl;
          }
        }
        newEntries.push(newEntry);
        stats.visit_page++;
        continue;
      }
    }

    // --- page_checkpoint -> DROPPED ---
    if (action === 'page_checkpoint') {
      stats.page_checkpoint_dropped++;
      continue;
    }

    // --- snap -> create_snapshot ---
    if (action === 'snap') {
      // Parse slug: 'pageSlug/captureTs'
      const snapSlug = entry.slug;
      const slashIdx = snapSlug.lastIndexOf('/');
      if (slashIdx < 0) {
        console.warn(`  WARN: snap entry with unparseable slug: ${snapSlug}`);
        stats.unknown_dropped++;
        continue;
      }
      const pageSlug = snapSlug.substring(0, slashIdx);
      const captureTs = parseInt(snapSlug.substring(slashIdx + 1), 10);

      const url = slugToUrl.get(pageSlug);
      if (!url) {
        console.warn(`  WARN: snap entry references unknown page slug: ${pageSlug}`);
        stats.unknown_dropped++;
        continue;
      }

      newEntries.push({
        action: 'create_snapshot',
        url,
        path: `snapshots/${pageSlug}-${captureTs}`,
        timestamp: captureTs,
      });
      stats.create_snapshot++;
      continue;
    }

    // --- list (with op) ---
    if (action === 'list' && entry.op) {
      const listId = entry.id;

      if (entry.op === 'clear') {
        stats.list_clear_dropped++;
        continue;
      }

      // Resolve list name path
      const listName = dynamicResolveListName(listId);
      if (!listName) {
        console.warn(`  WARN: list entry references unknown list ID: ${listId}`);
        stats.unknown_dropped++;
        continue;
      }

      const pn = namePathToParentsAndName(listName);

      // Resolve typed IDs to items (URLs for pages, notes/<slug>.json for notes)
      const items = [];
      for (const id of (entry.ids || [])) {
        const item = resolveTypedIdToItem(id);
        if (item) {
          items.push(item);
        } else {
          console.warn(`  WARN: list entry has unresolvable ID: ${id}`);
        }
      }

      if (entry.op === 'add') {
        newEntries.push({
          action: 'pin_to_list',
          parents: pn.parents,
          name: pn.name,
          items,
          timestamp: entry.timestamp,
        });
        stats.pin_to_list++;
      } else if (entry.op === 'del') {
        newEntries.push({
          action: 'unpin_from_list',
          parents: pn.parents,
          name: pn.name,
          items,
          timestamp: entry.timestamp,
        });
        stats.unpin_from_list++;
      }
      continue;
    }

    // --- list_meta -> create_list or update_list ---
    if (action === 'list_meta') {
      const listId = entry.id;

      if (!seenListIds.has(listId)) {
        // First list_meta for this ID -> create_list
        seenListIds.add(listId);

        // Determine parent path
        let parentPath = 'root';
        if (entry.parentList) {
          const parentId = entry.parentList.startsWith('list:')
            ? entry.parentList.slice(5)
            : entry.parentList;
          if (parentId === 'system/root') {
            parentPath = 'root';
          } else {
            parentPath = dynamicResolveListName(parentId) || 'root';
          }
        } else {
          // No explicit parentList in entry; check the entity
          const entity = listEntities.get(listId);
          if (entity?.parentList) {
            const parentId = entity.parentList.startsWith('list:')
              ? entity.parentList.slice(5)
              : entity.parentList;
            if (parentId === 'system/root') {
              parentPath = 'root';
            } else {
              parentPath = dynamicResolveListName(parentId) || 'root';
            }
          }
        }

        const name = entry.name || '';
        const parents = parentPathToArray(parentPath);
        const newEntry = {
          action: 'create_list',
          name,
          parents,
          listId,
          timestamp: entry.timestamp,
        };
        newEntries.push(newEntry);
        stats.create_list++;

        // Register the dynamic name path
        const fullPath = parentPath === 'root'
          ? `root/${name}`
          : `${parentPath}/${name}`;
        dynamicListNamePath.set(listId, fullPath);
        dynamicNamePathToId.set(fullPath, listId);

        // If there are also savedSearches in this first entry,
        // emit a follow-up update_list.
        if (entry.savedSearches && entry.savedSearches.length > 0) {
          const pn = namePathToParentsAndName(fullPath);
          newEntries.push({
            action: 'update_list',
            parents: pn.parents,
            name: pn.name,
            savedSearches: entry.savedSearches,
            timestamp: entry.timestamp,
          });
          stats.update_list++;
        }

        continue;
      } else {
        // Subsequent list_meta -> update_list
        const listName = dynamicResolveListName(listId);
        if (!listName) {
          console.warn(`  WARN: list_meta update for unknown list ID: ${listId}`);
          stats.unknown_dropped++;
          continue;
        }

        const pn = namePathToParentsAndName(listName);
        const newEntry = {
          action: 'update_list',
          parents: pn.parents,
          name: pn.name,
          timestamp: entry.timestamp,
        };
        if (entry.name !== undefined) newEntry.newName = entry.name;
        if (entry.savedSearches !== undefined) newEntry.savedSearches = entry.savedSearches;
        newEntries.push(newEntry);
        stats.update_list++;

        // Update dynamic name if name changed
        if (entry.name !== undefined) {
          const oldPath = listName;
          const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
          const newPath = parentPath ? `${parentPath}/${entry.name}` : `root/${entry.name}`;
          if (oldPath !== newPath) {
            // Delete old path
            dynamicNamePathToId.delete(oldPath);
            // Add new path
            dynamicListNamePath.set(listId, newPath);
            dynamicNamePathToId.set(newPath, listId);
            // Update descendants
            const oldPrefix = oldPath + '/';
            for (const [p, pId] of [...dynamicNamePathToId]) {
              if (p.startsWith(oldPrefix)) {
                const suffix = p.slice(oldPrefix.length);
                dynamicNamePathToId.delete(p);
                const newChildPath = `${newPath}/${suffix}`;
                dynamicNamePathToId.set(newChildPath, pId);
                dynamicListNamePath.set(pId, newChildPath);
              }
            }
          }
        }

        continue;
      }
    }

    // --- reparent_list ---
    if (action === 'reparent_list') {
      const listId = entry.id;
      const listName = dynamicResolveListName(listId);
      if (!listName) {
        console.warn(`  WARN: reparent_list for unknown list ID: ${listId}`);
        stats.unknown_dropped++;
        continue;
      }

      // Resolve 'to' to parent path
      let toParentPath;
      const toId = entry.to;
      if (toId === 'system/root') {
        toParentPath = 'root';
      } else {
        toParentPath = dynamicResolveListName(toId);
        if (!toParentPath) {
          console.warn(`  WARN: reparent_list to unknown parent: ${toId}`);
          toParentPath = 'root';
        }
      }

      const pn = namePathToParentsAndName(listName);
      const newEntry = {
        action: 'reparent_list',
        parents: pn.parents,
        name: pn.name,
        toParents: parentPathToArray(toParentPath),
        timestamp: entry.timestamp,
      };
      newEntries.push(newEntry);
      stats.reparent_list++;

      // Update dynamic name paths
      const oldPath = listName;
      const baseName = oldPath.substring(oldPath.lastIndexOf('/') + 1);
      const newPath = `${toParentPath}/${baseName}`;
      if (oldPath !== newPath) {
        // Delete old path
        dynamicNamePathToId.delete(oldPath);
        dynamicListNamePath.set(listId, newPath);
        dynamicNamePathToId.set(newPath, listId);
        // Move descendants
        const oldPrefix = oldPath + '/';
        for (const [p, pId] of [...dynamicNamePathToId]) {
          if (p.startsWith(oldPrefix)) {
            const suffix = p.slice(oldPrefix.length);
            dynamicNamePathToId.delete(p);
            const newChildPath = `${newPath}/${suffix}`;
            dynamicNamePathToId.set(newChildPath, pId);
            dynamicListNamePath.set(pId, newChildPath);
          }
        }
      }

      continue;
    }

    // --- del_list -> delete_list ---
    if (action === 'del_list') {
      const listName = dynamicResolveListName(entry.id);
      if (!listName) {
        console.warn(`  WARN: del_list for unknown list: ${entry.id}`);
        stats.unknown_dropped++;
        continue;
      }
      const pn = namePathToParentsAndName(listName);
      newEntries.push({
        action: 'delete_list',
        parents: pn.parents,
        name: pn.name,
        timestamp: entry.timestamp,
      });
      stats.delete_list++;
      continue;
    }

    // --- restore_list ---
    if (action === 'restore_list') {
      const listName = dynamicResolveListName(entry.id) || entry.name || entry.id;
      const pn = namePathToParentsAndName(listName);
      newEntries.push({
        action: 'restore_list',
        parents: pn ? pn.parents : [],
        name: pn ? pn.name : listName,
        timestamp: entry.timestamp,
      });
      stats.restore_list++;
      continue;
    }

    // --- set -> update_setting ---
    if (action === 'set') {
      newEntries.push({
        action: 'update_setting',
        key: entry.key,
        value: entry.value,
        timestamp: entry.timestamp,
      });
      stats.update_setting++;
      continue;
    }

    // --- note -> create_note ---
    if (action === 'note') {
      // Resolve parent page URL from parentIds[0]
      let url = null;
      if (entry.parentIds && entry.parentIds.length > 0) {
        const parentKey = entry.parentIds[0];
        const parentSlug = parentKey.startsWith('page:') ? parentKey.slice(5) : parentKey;
        url = slugToUrl.get(parentSlug) || null;
      }
      if (!url) {
        console.warn(`  WARN: note entry with unresolvable parent: ${JSON.stringify(entry.parentIds)}`);
      }
      newEntries.push({
        action: 'create_note',
        url,
        path: `notes/${entry.slug}.json`,
        timestamp: entry.timestamp,
      });
      stats.create_note++;
      continue;
    }

    // --- del_note -> delete_note ---
    if (action === 'del_note') {
      let url = null;
      if (entry.parentIds && entry.parentIds.length > 0) {
        const parentKey = entry.parentIds[0];
        const parentSlug = parentKey.startsWith('page:') ? parentKey.slice(5) : parentKey;
        url = slugToUrl.get(parentSlug) || null;
      }
      newEntries.push({
        action: 'delete_note',
        url,
        path: `notes/${entry.slug}.json`,
        timestamp: entry.timestamp,
      });
      stats.delete_note++;
      continue;
    }

    // --- restore_note ---
    if (action === 'restore_note') {
      let url = null;
      if (entry.parentIds && entry.parentIds.length > 0) {
        const parentKey = entry.parentIds[0];
        const parentSlug = parentKey.startsWith('page:') ? parentKey.slice(5) : parentKey;
        url = slugToUrl.get(parentSlug) || null;
      }
      newEntries.push({
        action: 'restore_note',
        url,
        path: `notes/${entry.slug}.json`,
        timestamp: entry.timestamp,
      });
      stats.restore_note++;
      continue;
    }

    // --- del_snap -> delete_snapshot ---
    if (action === 'del_snap') {
      const snapSlug = entry.slug;
      const slashIdx = snapSlug.lastIndexOf('/');
      if (slashIdx < 0) {
        console.warn(`  WARN: del_snap with unparseable slug: ${snapSlug}`);
        stats.unknown_dropped++;
        continue;
      }
      const pageSlug = snapSlug.substring(0, slashIdx);
      const snapTs = parseInt(snapSlug.substring(slashIdx + 1), 10);
      const url = slugToUrl.get(pageSlug);

      newEntries.push({
        action: 'delete_snapshot',
        url: url || null,
        path: `snapshots/${pageSlug}-${snapTs}`,
        timestamp: entry.timestamp,
      });
      stats.delete_snapshot++;
      continue;
    }

    // --- restore_snap -> restore_snapshot ---
    if (action === 'restore_snap') {
      const snapSlug = entry.slug;
      const slashIdx = snapSlug.lastIndexOf('/');
      if (slashIdx < 0) {
        console.warn(`  WARN: restore_snap with unparseable slug: ${snapSlug}`);
        stats.unknown_dropped++;
        continue;
      }
      const pageSlug = snapSlug.substring(0, slashIdx);
      const snapTs = parseInt(snapSlug.substring(slashIdx + 1), 10);
      const url = slugToUrl.get(pageSlug);

      newEntries.push({
        action: 'restore_snapshot',
        url: url || null,
        path: `snapshots/${pageSlug}-${snapTs}`,
        timestamp: entry.timestamp,
      });
      stats.restore_snapshot++;
      continue;
    }

    // --- Unknown action ---
    console.warn(`  WARN: unknown action "${action}" in ${file}:${i}: ${JSON.stringify(entry).slice(0, 100)}`);
    stats.unknown_dropped++;
  }

  migratedFiles.set(file, newEntries);
}

// ---------------------------------------------------------------------------
// 4. Summary
// ---------------------------------------------------------------------------
let totalNewEntries = 0;
for (const [, entries] of migratedFiles) {
  totalNewEntries += entries.length;
}

console.log('\n=== MIGRATION SUMMARY ===');
console.log(`  Input:  ${totalOldEntries} entries across ${historyFiles.length} files`);
console.log(`  Output: ${totalNewEntries} entries`);
console.log(`  Diff:   ${totalNewEntries - totalOldEntries} entries`);
console.log('\n  Event counts:');
for (const [key, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
  if (count > 0) console.log(`    ${key}: ${count}`);
}

// ---------------------------------------------------------------------------
// 5. Generate list-name-to-id entity
// ---------------------------------------------------------------------------
console.log('\n=== LIST NAME-TO-ID MAP ===');
const nameMapPaths = {};
let latestTimestamp = 0;
for (const [path, id] of dynamicNamePathToId) {
  // Skip system and auto entries — name-to-id only tracks user lists
  if (path.startsWith('system/') || path.startsWith('auto')) continue;
  if (id.startsWith('system/') || id.startsWith('auto/') || id === 'auto') continue;
  nameMapPaths[path] = id;
}
// Find latest timestamp
for (const [, entries] of migratedFiles) {
  for (const e of entries) {
    if (e.timestamp > latestTimestamp) latestTimestamp = e.timestamp;
  }
}
const nameMapEntity = {
  timestamp: latestTimestamp,
  paths: nameMapPaths,
};
console.log(`  ${Object.keys(nameMapPaths).length} paths in list-name-to-id:`);
for (const [path, id] of Object.entries(nameMapPaths)) {
  console.log(`    ${path} -> ${id}`);
}

// ---------------------------------------------------------------------------
// 6. Generate page-info.json from SPI
// ---------------------------------------------------------------------------
console.log('\n=== PAGE-INFO (SPI -> page-info) ===');
const spiPath = join(DATA_DIR, 'lists', 'system', 'shallow-page.json');
let pageInfoEntity = null;
let spiEntryCount = 0;

if (existsSync(spiPath)) {
  try {
    const spi = JSON.parse(readFileSync(spiPath, 'utf-8'));
    const entries = {};

    for (const [url, data] of Object.entries(spi.index || {})) {
      const slug = generateSlugFromUrl(url);
      entries[slug] = {
        url,
        title: data.title || null,
        user_title: data.user_title || null,
        parentIds: data.parentIds || [],
        childIds: [],
        visitDates: [],
      };
      spiEntryCount++;
    }

    pageInfoEntity = {
      timestamp: spi.timestamp || latestTimestamp,
      entries,
    };
    console.log(`  ${spiEntryCount} entries converted from SPI`);
  } catch (e) {
    console.warn(`  ERROR reading SPI: ${e.message}`);
  }
} else {
  console.log('  SPI file not found, skipping page-info generation');
}

// ---------------------------------------------------------------------------
// 7. Apply (if not dry run)
// ---------------------------------------------------------------------------
if (dryRun) {
  console.log('\nDry run complete. Pass --apply to write changes.');
  process.exit(0);
}

// 7a. Backup original history files
console.log('\nBacking up history files...');
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true });
}
for (const file of historyFiles) {
  cpSync(join(HISTORY_DIR, file), join(BACKUP_DIR, file));
}
console.log(`  Backed up ${historyFiles.length} files to ${BACKUP_DIR}`);

// 7b. Write migrated JSONL files to data/logs/
console.log('Writing migrated JSONL files...');
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}
let filesWritten = 0;
for (const [file, entries] of [...migratedFiles].sort((a, b) => a[0].localeCompare(b[0]))) {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(OUTPUT_DIR, file), content);
  filesWritten++;
}
console.log(`  Wrote ${filesWritten} files to ${OUTPUT_DIR}`);

// 7c. Write list-name-to-id entity
const nameMapDir = join(DATA_DIR, 'manifest');
if (!existsSync(nameMapDir)) {
  mkdirSync(nameMapDir, { recursive: true });
}
const nameMapPath = join(nameMapDir, 'list-name-to-id.json');
writeFileSync(nameMapPath, JSON.stringify(nameMapEntity, null, 2) + '\n');
console.log(`  Wrote list-name-to-id to ${nameMapPath}`);

// 7d. Write page-info.json and delete old SPI
if (pageInfoEntity) {
  const pageInfoPath = join(nameMapDir, 'page-info.json');
  writeFileSync(pageInfoPath, JSON.stringify(pageInfoEntity, null, 2) + '\n');
  console.log(`  Wrote page-info to ${pageInfoPath}`);

  // Delete old SPI file
  try {
    unlinkSync(spiPath);
    console.log(`  Deleted old SPI file: ${spiPath}`);
  } catch (e) {
    console.warn(`  WARNING: Failed to delete SPI: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Verification: count entries
// ---------------------------------------------------------------------------
console.log('\n=== VERIFICATION ===');
let verifyTotal = 0;
for (const file of readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  const lines = readFileSync(join(OUTPUT_DIR, file), 'utf-8').split('\n').filter(l => l.trim());
  verifyTotal += lines.length;
}
console.log(`  Total entries on disk: ${verifyTotal}`);
console.log(`  Expected: ${totalNewEntries}`);
if (verifyTotal === totalNewEntries) {
  console.log('  OK: counts match');
} else {
  console.warn(`  MISMATCH: expected ${totalNewEntries}, got ${verifyTotal}`);
}

console.log('\nDone.');
