// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';
import { generateRuleId } from './rule-engine.js';

const REFERRER_CAP = 50;

const PAGE_PREFIX = 'page:';
const NOTE_PREFIX = 'note:';
const SNAPSHOT_PREFIX = 'snapshot:';

/**
 * Get the maximum timestamp across all devices from an entity's timestamps map.
 * Returns 0 if no timestamps are present.
 */
export function maxTimestamp(entity) {
  const ts = entity?.timestamps;
  if (!ts || typeof ts !== 'object') return 0;
  const vals = Object.values(ts);
  return vals.length ? Math.max(...vals) : 0;
}

/** Update the per-device timestamp on an entity, returning a shallow copy. */
function touchTimestamp(entity, deviceId, ts) {
  const timestamps = { ...(entity.timestamps || {}) };
  timestamps[deviceId] = Math.max(timestamps[deviceId] || 0, ts);
  return { ...entity, timestamps };
}

/**
 * Return the set of page keys that an entry affects.
 * Used by hydration to pre-load page entities referenced by logBuffer entries.
 */
export function getAffectedKeys(entry) {
  const keys = new Set();
  const url = entry.url;
  if (url) {
    keys.add(PAGE_PREFIX + generateSlugFromUrl(url));
  }

  // visit_page with referrerUrl also affects the parent page
  if (entry.action === 'visit_page' && entry.referrerUrl) {
    const parentKey = PAGE_PREFIX + generateSlugFromUrl(entry.referrerUrl);
    const childKey = url ? PAGE_PREFIX + generateSlugFromUrl(url) : null;
    if (parentKey !== childKey) keys.add(parentKey);
  }

  // create_snapshot/delete_snapshot/restore_snapshot: url IS the parent page
  // (already added above via entry.url)

  // create_note/delete_note/restore_note: url IS the parent page
  // (already added above via entry.url)

  return keys;
}


// ---------------------------------------------------------------------------
// Unified replay interface: effectOf
// ---------------------------------------------------------------------------

/**
 * Default empty entity for a given key. Used when creating entities from null.
 */
export function defaultEntity(key) {
  if (key.startsWith(PAGE_PREFIX)) {
    const slug = key.slice(PAGE_PREFIX.length);
    return { slug, parentIds: [], childIds: [] };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    const slug = key.slice(NOTE_PREFIX.length);
    return { slug, excerpt: null, note: null, cssPath: null, url: null };
  }
  if (key === 'manifest:settings') return {};
  if (key === 'manifest:orphaned') return { entries: [] };
  if (key === 'manifest:list-order') return { tree: [] };
  if (key === 'manifest:name-to-id') return { paths: {} };
  if (key.startsWith('list:')) {
    const slug = key.slice('list:'.length);
    return { slug, name: '', pins: [], rules: [] };
  }
  return null;
}

/** Load entity, falling back to defaultEntity for non-page/non-note keys. */
async function loadOrDefault(key, load, opts) {
  return (await load(key, opts)) ?? defaultEntity(key);
}

// ---------------------------------------------------------------------------
// Tree manifest helpers (for manifest:list-order)
// ---------------------------------------------------------------------------

/**
 * Remove a node from the tree by ID. Its children are promoted to the
 * same position in the parent array (splice in place).
 * Returns a new tree array (does not mutate input).
 */
function removeFromTree(tree, listId) {
  const out = [];
  for (const node of tree) {
    if (node.id === listId) {
      // Promote children to this level
      if (node.children) {
        for (const child of node.children) {
          out.push(deepCloneTree(child));
        }
      }
    } else {
      const cloned = { id: node.id };
      if (node.children) {
        cloned.children = removeFromTree(node.children, listId);
      }
      out.push(cloned);
    }
  }
  return out;
}

/**
 * Append a node to the tree under a given parent.
 * If parentId is null or not found, appends to top level.
 * Returns a new tree array (does not mutate input).
 */
function appendToTree(tree, listId, parentId) {
  const newNode = { id: listId };
  if (!parentId) {
    return [...tree.map(deepCloneTree), newNode];
  }
  // Try to find parentId in tree and append there
  const cloned = tree.map(deepCloneTree);
  if (appendToTreeRecursive(cloned, listId, parentId)) {
    return cloned;
  }
  // Parent not found — append to top level
  cloned.push(newNode);
  return cloned;
}

/** Mutates `nodes` in place. Returns true if parent was found. */
function appendToTreeRecursive(nodes, listId, parentId) {
  for (const node of nodes) {
    if (node.id === parentId) {
      if (!node.children) node.children = [];
      node.children.push({ id: listId });
      return true;
    }
    if (node.children && appendToTreeRecursive(node.children, listId, parentId)) {
      return true;
    }
  }
  return false;
}

function deepCloneTree(node) {
  const cloned = { id: node.id };
  if (node.children) {
    cloned.children = node.children.map(deepCloneTree);
  }
  return cloned;
}

/**
 * A page entity is eligible for retention if ANY of:
 * - parentIds contains at least one list: key (pinned to a user list)
 * - childIds contains at least one note: or snapshot: key
 * - user_title is set and truthy
 * - likes is set and non-zero
 */
export function isPageEligible(entity) {
  if (entity.parentIds?.some(id => id.startsWith('list:'))) return true;
  if (entity.childIds?.some(id => id.startsWith('note:') || id.startsWith('snapshot:'))) return true;
  if (entity.user_title) return true;
  if (entity.likes) return true;
  return false;
}

/**
 * Compute the effect of a log entry against a backing store.
 * load(key) → entity | null   — async closure that reads from any backing store
 *                                (session cache, filesystem + round cache, etc.)
 *
 * Returns { key: updatedEntity | null } for every affected key.
 * Each action branch loads what it needs and applies immediately.
 */
export async function effectOf(entry, load, context = {}) {
  const result = {};

  // --- shared helpers for link/unlink/orphan across note, snap, and list branches ---
  async function linkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = result[parentKey] !== undefined ? result[parentKey] : await load(parentKey);
      if (!parent) { result[parentKey] = null; continue; }
      const childIds = [...(parent.childIds || [])];
      if (!childIds.includes(childKey)) childIds.push(childKey);
      result[parentKey] = { ...parent, childIds };
    }
  }

  async function unlinkChild(childKey, parentIds) {
    if (!parentIds) return;
    for (const parentKey of parentIds) {
      const parent = result[parentKey] !== undefined ? result[parentKey] : await load(parentKey);
      if (!parent) { result[parentKey] = null; continue; }
      const childIds = (parent.childIds || []).filter(c => c !== childKey);
      result[parentKey] = { ...parent, childIds };
    }
  }

  async function orphan(childKey, ts, parentUrl) {
    const orphaned = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    const entries = [...(orphaned.entries || [])];
    if (!entries.some(e => e.key === childKey)) {
      const entry = { key: childKey };
      if (parentUrl) entry.url = parentUrl;
      entries.push(entry);
    }
    result['manifest:orphaned'] = { ...touchTimestamp(orphaned, context.deviceId, ts), entries };
  }

  async function unorphan(childKey, ts) {
    const orphaned = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    const entries = (orphaned.entries || []).filter(e => e.key !== childKey);
    result['manifest:orphaned'] = { ...touchTimestamp(orphaned, context.deviceId, ts), entries };
  }

  /**
   * Resolve a list to its internal list key via manifest:name-to-id.
   * Uses compound key entry.listOwner/name. Falls back to orphaned entity search.
   * System lists use their name directly as the ID.
   * Returns null if user list not found in name-to-id or orphaned entities.
   */
  async function resolveListKey(name) {
    if (!name) return null;
    if (name.startsWith('system/')) {
      return `list:${name}`;
    }
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const owner = entry.listOwner;
    if (!owner) return null;
    const id = nameToId.paths?.[owner + '/' + name];
    if (id) return `list:${id}`;
    // Fallback: search orphaned entities by owner+name (deleted lists removed from name-to-id)
    const orphanedEntity = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    for (const oe of (orphanedEntity.entries || [])) {
      if (!oe.key.startsWith('list:') || oe.key.startsWith('list:system/')) continue;
      const entity = await load(oe.key, { includeDeleted: true });
      if (entity?.owner === owner && entity?.name === name) return oe.key;
    }
    return null;
  }

  /**
   * Ensure a page entity exists for the given URL. Creates one if missing.
   * Used by explicit user actions (pin, rate, snapshot, note, rename) that
   * require an entity to exist.
   */
  async function ensurePageEntity(url, ts, title) {
    const slug = generateSlugFromUrl(url);
    const pageKey = PAGE_PREFIX + slug;
    let page = result[pageKey] !== undefined ? result[pageKey] : await load(pageKey);
    if (!page) {
      page = { ...defaultEntity(pageKey), url };
      if (title) page.title = title;
    }
    result[pageKey] = page;
    return { pageKey, page };
  }

  /**
   * Find all lists that have pinId in their pins array.
   */
  async function findListsWithPin(pinId) {
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const lists = [];
    for (const id of Object.values(nameToId.paths || {})) {
      const lk = `list:${id}`;
      const list = result[lk] !== undefined ? result[lk] : await load(lk);
      if (list && (list.pins || []).some(p => p.id === pinId)) lists.push(lk);
    }
    return lists;
  }

  /**
   * Load a list entity for mutation. In sync mode, loads with includeDeleted
   * (preserves data through delete/restore cycles). In non-sync, rejects
   * orphaned lists (current behavior).
   * Returns null if the list should be skipped.
   */
  async function loadListForMutation(listKey) {
    return await loadOrDefault(listKey, load, { includeDeleted: true });
  }

  // --- update_setting ---
  if (entry.action === 'update_setting') {
    const settings = await loadOrDefault('manifest:settings', load);
    result['manifest:settings'] = { ...touchTimestamp(settings, context.deviceId, entry.timestamp), [entry.key]: entry.value };
    return result;
  }

  // --- visit_page ---
  // Enriches existing page entities only. Passive visits do NOT create entities.
  if (entry.action === 'visit_page') {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    const page = await load(pageKey);

    if (page) {
      const updated = touchTimestamp(page, context.deviceId, entry.timestamp);
      if (entry.url) updated.url = entry.url;
      if (entry.title) updated.title = entry.title;

      // visitDates
      const d = new Date(entry.timestamp);
      const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      const visitDates = [...(updated.visitDates || [])];
      if (!visitDates.includes(yyyymmdd)) visitDates.push(yyyymmdd);
      updated.visitDates = visitDates;

      // referrerUrl → parentIds
      if (entry.referrerUrl) {
        const referrerKey = PAGE_PREFIX + generateSlugFromUrl(entry.referrerUrl);
        const parentIds = [...(updated.parentIds || [])];
        if (!parentIds.includes(referrerKey)) {
          parentIds.push(referrerKey);
          if (parentIds.length > REFERRER_CAP) parentIds.shift();
        }
        updated.parentIds = parentIds;
      }

      result[pageKey] = updated;
    }

    // Parent-side: accumulate child ref on referrer page
    if (entry.referrerUrl) {
      const referrerSlug = generateSlugFromUrl(entry.referrerUrl);
      const referrerKey = PAGE_PREFIX + referrerSlug;
      if (referrerKey !== pageKey) {
        const parent = result[referrerKey] !== undefined ? result[referrerKey] : await load(referrerKey);
        if (parent) {
          const childIds = [...(parent.childIds || [])];
          const childRef = PAGE_PREFIX + slug;
          if (!childIds.includes(childRef)) {
            childIds.push(childRef);
            if (childIds.length > REFERRER_CAP) childIds.shift();
          }
          result[referrerKey] = { ...touchTimestamp(parent, context.deviceId, entry.timestamp), childIds };
        }
      }
    }

    return result;
  }

  // --- leave_page ---
  // Updates attention data on existing page entities only. Does NOT create entities.
  if (entry.action === 'leave_page') {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    const page = await load(pageKey);

    if (page) {
      const updated = touchTimestamp(page, context.deviceId, entry.timestamp);

      // Title: latest auto-detected from MutationObserver, folded into leave report
      if (entry.title) updated.title = entry.title;

      // Attention guard: per-device timestamp (skip additive fields if already applied)
      const deviceTs = (page.timestamps || {})[context.deviceId] || 0;
      if (entry.timestamp > deviceTs) {
        if (entry.scrollDepth !== undefined) {
          updated.scrollDepth = Math.max(updated.scrollDepth || 0, entry.scrollDepth);
        }
        if (entry.timeOnPage !== undefined) {
          updated.timeOnPage = (updated.timeOnPage || 0) + entry.timeOnPage;
        }
      }

      result[pageKey] = updated;
    }

    return result;
  }

  // --- rename_page ---
  // User-initiated title rename. Creates entity if missing (explicit user action).
  if (entry.action === 'rename_page') {
    const { pageKey } = await ensurePageEntity(entry.url, entry.timestamp);
    const page = result[pageKey];
    result[pageKey] = { ...touchTimestamp(page, context.deviceId, entry.timestamp), user_title: entry.user_title };
    return result;
  }

  // --- rate_page ---
  // Like/dislike. Creates entity if missing (explicit user action).
  if (entry.action === 'rate_page') {
    const { pageKey } = await ensurePageEntity(entry.url, entry.timestamp, entry.title);
    const page = result[pageKey];
    const updated = touchTimestamp(page, context.deviceId, entry.timestamp);

    // Per-device guard (skip additive fields if already applied)
    const deviceTs = (page.timestamps || {})[context.deviceId] || 0;
    if (entry.timestamp > deviceTs && entry.likes !== undefined) {
      updated.likes = (updated.likes || 0) + entry.likes;
    }

    result[pageKey] = updated;
    return result;
  }

  // --- create_snapshot ---
  // Merged page+snapshot: captures snapshot and links to parent page.
  // Creates entity if missing (explicit user action).
  // entry.path is the stem: "snapshots/<slug>-<ts>"
  if (entry.action === 'create_snapshot') {
    const { pageKey } = await ensurePageEntity(entry.url, entry.timestamp, entry.title);
    const page = result[pageKey];
    const updated = touchTimestamp(page, context.deviceId, entry.timestamp);

    // Snapshot key derived from path: "snapshots/<slug>-<ts>" → "snapshot:<slug>-<ts>"
    const snapKey = `${SNAPSHOT_PREFIX}${entry.path.slice('snapshots/'.length)}`;
    const childIds = [...(updated.childIds || [])];
    if (!childIds.includes(snapKey)) childIds.push(snapKey);
    updated.childIds = childIds;

    result[pageKey] = updated;
    return result;
  }

  // --- create_note ---
  // Creates note entity link to parent page. Creates page entity if missing.
  // entry.path: "notes/<slug>.json"
  if (entry.action === 'create_note') {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    await ensurePageEntity(entry.url, entry.timestamp, entry.title);

    // Derive note slug from path: "notes/<slug>.json" → "<slug>"
    const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const noteKey = `${NOTE_PREFIX}${noteSlug}`;
    // Link note as child of page (page.childIds)
    await linkChild(noteKey, [pageKey]);
    // Set url on note entity
    const note = result[noteKey] !== undefined ? result[noteKey] : await load(noteKey);
    if (note) result[noteKey] = { ...note, url: entry.url };
    return result;
  }

  // --- delete_note ---
  if (entry.action === 'delete_note') {
    const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const noteKey = `${NOTE_PREFIX}${noteSlug}`;
    // Load with includeDeleted; noop if already deleted
    const note = await loadOrDefault(noteKey, load, { includeDeleted: true });
    // LWW via deletedTs
    if (note.deletedTs && note.deletedTs >= entry.timestamp) return result;

    // Derive page key from note.url
    const noteUrl = note.url || entry.url;
    if (noteUrl) {
      const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
      await unlinkChild(noteKey, [pageKey]);
      // GC parent page if it became ineligible
      const p = result[pageKey];
      if (p && !isPageEligible(p)) result[pageKey] = null;
    }
    // Remove note pin from lists (find via pins scan)
    const listKeys = await findListsWithPin(noteKey);
    for (const lk of listKeys) {
      const list = result[lk] !== undefined ? result[lk] : await load(lk);
      if (!list) continue;
      result[lk] = { ...list, pins: (list.pins || []).filter(p => p.id !== noteKey) };
    }
    // Mark deleted
    const deletedNote = { ...note, deleted: true, deletedTs: entry.timestamp };
    result[noteKey] = deletedNote;
    await orphan(noteKey, entry.timestamp, noteUrl);
    return result;
  }

  // --- restore_note ---
  if (entry.action === 'restore_note') {
    const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const noteKey = `${NOTE_PREFIX}${noteSlug}`;
    // Load with includeDeleted to preserve original entity fields
    const note = await loadOrDefault(noteKey, load, { includeDeleted: true });

    // LWW via deletedTs
    if (note.deletedTs && note.deletedTs >= entry.timestamp) return result;

    // Get parent URL from orphaned entries or note.url
    const orphaned = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    const orphanEntry = (orphaned.entries || []).find(e => e.key === noteKey);
    const noteUrl = orphanEntry?.url || note.url || entry.url;
    // Re-link to parent page
    if (noteUrl) {
      const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
      await linkChild(noteKey, [pageKey]);
    }
    // Clear deleted flag
    const restoredNote = { ...note, deleted: false, deletedTs: entry.timestamp };
    result[noteKey] = restoredNote;
    await unorphan(noteKey, entry.timestamp);
    return result;
  }

  // --- delete_snapshot ---
  // entry.path: "snapshots/<slug>-<ts>"
  if (entry.action === 'delete_snapshot') {
    const snapStem = entry.path.slice('snapshots/'.length);
    const snapKey = `${SNAPSHOT_PREFIX}${snapStem}`;
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    await unlinkChild(snapKey, [pageKey]);
    // GC parent page if it became ineligible
    const snapPage = result[pageKey];
    if (snapPage && !isPageEligible(snapPage)) result[pageKey] = null;
    await orphan(snapKey, entry.timestamp, entry.url);
    return result;
  }

  // --- restore_snapshot ---
  // entry.path: "snapshots/<slug>-<ts>"
  if (entry.action === 'restore_snapshot') {
    const snapStem = entry.path.slice('snapshots/'.length);
    const snapKey = `${SNAPSHOT_PREFIX}${snapStem}`;
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    await linkChild(snapKey, [pageKey]);
    await unorphan(snapKey, entry.timestamp);
    return result;
  }

  // --- replace_note ---
  // Immutable note edit: creates new note entity, orphans old one.
  // entry.path: "notes/<new-slug>.json", entry.oldPath: "notes/<old-slug>.json"
  if (entry.action === 'replace_note') {
    const oldNoteSlug = entry.oldPath.slice('notes/'.length, -'.json'.length);
    const oldNoteKey = `${NOTE_PREFIX}${oldNoteSlug}`;
    const newNoteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const newNoteKey = `${NOTE_PREFIX}${newNoteSlug}`;

    // Load old note
    const oldNote = await loadOrDefault(oldNoteKey, load, { includeDeleted: true });

    // Derive page key from old note's url
    const noteUrl = oldNote.url || entry.url;
    if (noteUrl) {
      const pageKey = PAGE_PREFIX + generateSlugFromUrl(noteUrl);
      await unlinkChild(oldNoteKey, [pageKey]);
      // Page may have been GC'd by a concurrent delete_note; re-create it
      await ensurePageEntity(noteUrl, entry.timestamp);
      await linkChild(newNoteKey, [pageKey]);
    }

    // Transfer list pins: replace old note with new note in each list
    const listKeys = await findListsWithPin(oldNoteKey);
    for (const lk of listKeys) {
      const list = result[lk] !== undefined ? result[lk] : await load(lk);
      if (!list) continue;
      const pins = (list.pins || []).map(p =>
        p.id === oldNoteKey ? { ...p, id: newNoteKey } : p
      );
      result[lk] = { ...list, pins };
    }

    // Set up new note with url from old note.
    // If the new note file can't be loaded (transient save error, missing file),
    // inherit content fields from the old note — these are primary user data
    // (excerpt, cssPath, note text) that would be lost if we fell back to defaultEntity.
    const newNote = result[newNoteKey] !== undefined ? result[newNoteKey] : await load(newNoteKey);
    if (newNote) {
      result[newNoteKey] = { ...newNote, url: noteUrl };
    } else {
      result[newNoteKey] = {
        ...defaultEntity(newNoteKey),
        excerpt: oldNote.excerpt,
        cssPath: oldNote.cssPath,
        note: oldNote.note,
        url: noteUrl,
      };
    }

    // Mark old note as replaced + orphan (LWW — only if our timestamp wins)
    const oldDeletedTs = oldNote.deletedTs || 0;
    if (entry.timestamp > oldDeletedTs) {
      result[oldNoteKey] = {
        ...oldNote, deleted: true, deletedTs: entry.timestamp,
        deletionReason: 'replaced', replacedBy: newNoteKey,
      };
      await orphan(oldNoteKey, entry.timestamp, noteUrl);
    }

    return result;
  }

  // --- pin_to_list ---
  // Add items to a list. Items are URLs (for pages) or "notes/<slug>.json" paths (for notes).
  if (entry.action === 'pin_to_list') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const pins = [...(entity.pins || [])];

    for (const item of (entry.items || [])) {
      // Resolve item to pin ID — notes use path prefix, others are URLs
      let pinId;
      if (item.startsWith('notes/')) {
        // Note path: "notes/<slug>.json" → "note:<slug>"
        const noteSlug = item.slice('notes/'.length, -'.json'.length);
        pinId = NOTE_PREFIX + noteSlug;
      } else {
        const slug = generateSlugFromUrl(item);
        const pageKey = PAGE_PREFIX + slug;
        await ensurePageEntity(item, entry.timestamp, entry.titles?.[item]);
        pinId = pageKey;
      }

      if (!pins.some(p => p.id === pinId)) {
        pins.push({ id: pinId, pinnedAt: entry.timestamp });
      }

      // Update page parentIds with list key (notes don't track parentIds)
      if (pinId.startsWith(PAGE_PREFIX)) {
        const page = result[pinId] || await load(pinId);
        if (page) {
          const parentIds = [...(page.parentIds || [])];
          if (!parentIds.includes(listKey)) parentIds.push(listKey);
          result[pinId] = { ...page, parentIds };
        }
      }
    }

    result[listKey] = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), pins };
    return result;
  }

  // --- unpin_from_list ---
  // Remove items from a list. Items are URLs (for pages) or "notes/<slug>.json" paths (for notes).
  if (entry.action === 'unpin_from_list') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const removeIds = new Set();

    for (const item of (entry.items || [])) {
      let pinId;
      if (item.startsWith('notes/')) {
        const noteSlug = item.slice('notes/'.length, -'.json'.length);
        pinId = NOTE_PREFIX + noteSlug;
      } else {
        pinId = PAGE_PREFIX + generateSlugFromUrl(item);
      }
      removeIds.add(pinId);
    }

    const pins = (entity.pins || []).filter(p => !removeIds.has(p.id));
    result[listKey] = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), pins };

    // Update page parentIds: remove list key (notes don't track parentIds)
    for (const pinId of removeIds) {
      if (pinId.startsWith(PAGE_PREFIX)) {
        const page = await load(pinId);
        if (page) {
          const parentIds = (page.parentIds || []).filter(p => p !== listKey);
          const updated = { ...page, parentIds };
          result[pinId] = isPageEligible(updated) ? updated : null;
        }
      }
    }

    return result;
  }

  // --- add_rule ---
  // Add a matching rule to a list.
  if (entry.action === 'add_rule') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const rules = [...(entity.rules || [])];
    const ruleId = entry.rule.id || generateRuleId(entry.rule.type, entry.timestamp);

    // Idempotent: skip if rule with same ID already exists
    if (!rules.some(r => r.id === ruleId)) {
      rules.push({
        id: ruleId,
        type: entry.rule.type,
        config: entry.rule.config,
        createdAt: entry.timestamp,
      });
    }

    result[listKey] = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), rules };
    return result;
  }

  // --- remove_rule ---
  // Remove a matching rule from a list by ID.
  if (entry.action === 'remove_rule') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const rules = (entity.rules || []).filter(r => r.id !== entry.ruleId);
    result[listKey] = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), rules };
    return result;
  }

  // --- update_rule ---
  // Update config of an existing rule by ID (merges config fields).
  if (entry.action === 'update_rule') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const rules = (entity.rules || []).map(r => {
      if (r.id !== entry.ruleId) return r;
      return { ...r, config: { ...r.config, ...entry.config } };
    });
    result[listKey] = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), rules };
    return result;
  }

  // --- create_list ---
  // Creates a new list entity. Generates internal ID, updates name-to-id and tree manifest.
  // Idempotent: skips if entity already exists (guards against redundant replay after partial drain).
  if (entry.action === 'create_list') {
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };

    // Resolve parent for tree placement (optional)
    const parentKey = entry.parentListId ? `list:${entry.parentListId}` : null;

    // Use provided listId (migrated events) or generate from name+timestamp (new events)
    const listId = entry.listId || (entry.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').substring(0, 30) + '-' + Math.abs(hashString(entry.name + entry.timestamp)).toString(36));
    const listKey = `list:${listId}`;

    // Idempotency: if entity already exists, this is a redundant replay — skip
    const existing = result[listKey] !== undefined ? result[listKey] : await load(listKey);
    if (existing) return result;

    // Create list entity (no parentList/childLists)
    const entity = defaultEntity(listKey);
    entity.name = entry.name;
    entity.owner = entry.listOwner;
    entity.timestamps = { [context.deviceId]: entry.timestamp };
    result[listKey] = entity;

    // Append to tree manifest
    const treeEntity = result['manifest:list-order'] || await loadOrDefault('manifest:list-order', load);
    const newTree = appendToTree(treeEntity.tree || [], listKey, parentKey);
    result['manifest:list-order'] = { ...touchTimestamp(treeEntity, context.deviceId, entry.timestamp), tree: newTree };

    // Update name-to-id: compound key owner/name
    const nameKey = entry.listOwner + '/' + entry.name;
    paths[nameKey] = listId;
    result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, context.deviceId, entry.timestamp), paths };

    return result;
  }

  // --- update_list ---
  // Rename list.
  // entry.name identifies the current list; entry.newName is the rename target.
  if (entry.action === 'update_list') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    // Guard: reject actions on orphaned (deleted) lists
    const entity = await loadListForMutation(listKey);
    if (!entity) return result;
    const updated = touchTimestamp(entity, context.deviceId, entry.timestamp);

    if (entry.newName !== undefined) {
      const oldName = entity.name;
      updated.name = entry.newName;

      // Update name-to-id: delete old key, add new key
      if (oldName !== entry.newName) {
        const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
        const paths = { ...nameToId.paths };
        const listId = listKey.slice('list:'.length);
        const owner = entity.owner;
        const oldKey = owner + '/' + oldName;
        const newKey = owner + '/' + entry.newName;
        delete paths[oldKey];
        paths[newKey] = listId;
        result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, context.deviceId, entry.timestamp), paths };
      }
    }

    result[listKey] = updated;
    return result;
  }

  // --- update_list_tree ---
  // Write the full tree structure. LWW by timestamp.
  // In sync mode, reconcile the accepted tree against current entity state:
  // remove deleted lists (promote children), append non-deleted lists missing from tree.
  if (entry.action === 'update_list_tree') {
    const treeEntity = result['manifest:list-order'] || await loadOrDefault('manifest:list-order', load);
    const treeDeviceTs = (treeEntity.timestamps || {})[context.deviceId] || 0;
    if (treeDeviceTs >= entry.timestamp) return result;
    // Reconcile the accepted tree against current entity state:
    // remove deleted lists (promote children), append non-deleted lists missing from tree.
    function collectIds(nodes) {
      const ids = new Set();
      for (const n of nodes) {
        ids.add(n.id);
        if (n.children) for (const id of collectIds(n.children)) ids.add(id);
      }
      return ids;
    }
    let newTree = entry.tree;
    const treeIds = collectIds(newTree);
    let reconciled = newTree.map(deepCloneTree);
    // Remove deleted lists from tree (promotes children)
    for (const id of treeIds) {
      if (id.startsWith('list:system/')) continue;
      const entity = await load(id, { includeDeleted: true });
      if (entity?.deleted) {
        reconciled = removeFromTree(reconciled, id);
      }
    }
    // Append non-deleted lists that exist in name-to-id but are missing from tree
    const reconciledIds = collectIds(reconciled);
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    for (const listId of Object.values(nameToId.paths || {})) {
      const listKey = `list:${listId}`;
      if (reconciledIds.has(listKey)) continue;
      if (listKey.startsWith('list:system/')) continue;
      const entity = await load(listKey, { includeDeleted: true });
      if (entity && !entity.deleted) {
        reconciled.push({ id: listKey });
        reconciledIds.add(listKey);
      }
    }
    newTree = reconciled;
    result['manifest:list-order'] = { ...touchTimestamp(treeEntity, context.deviceId, entry.timestamp), tree: newTree };
    return result;
  }

  // --- delete_list ---
  // Soft-delete a single list. Non-cascading — children promoted in tree.
  if (entry.action === 'delete_list') {
    const listKey = await resolveListKey(entry.name);
    if (!listKey) return result;

    if (listKey.startsWith('list:system/')) return result;

    const entity = await loadOrDefault(listKey, load, { includeDeleted: true });
    // LWW via deletedTs
    if (entity.deletedTs && entity.deletedTs >= entry.timestamp) return result;

    // Mark deleted
    const deletedEntity = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), deleted: true, deletedTs: entry.timestamp };
    result[listKey] = deletedEntity;

    // Remove from tree manifest (promotes children to parent level)
    const treeEntity = result['manifest:list-order'] || await loadOrDefault('manifest:list-order', load);
    result['manifest:list-order'] = { ...touchTimestamp(treeEntity, context.deviceId, entry.timestamp), tree: removeFromTree(treeEntity.tree || [], listKey) };

    // Remove list key from all pinned page parentIds (notes don't track parentIds)
    const pins = entity.pins || [];
    for (const pin of pins) {
      if (pin.id.startsWith(PAGE_PREFIX)) {
        const page = await load(pin.id);
        if (!page) continue;
        const parentIds = (page.parentIds || []).filter(p => p !== listKey);
        const updated = { ...page, parentIds };
        result[pin.id] = isPageEligible(updated) ? updated : null;
      }
    }

    // Remove from name-to-id
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };
    const listName = entity.name || entry.name;
    const nameKey = entity.owner + '/' + listName;
    delete paths[nameKey];
    result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, context.deviceId, entry.timestamp), paths };

    await orphan(listKey, entry.timestamp);
    return result;
  }

  // --- restore_list ---
  // Restore a deleted list. Adds to top-level of tree manifest.
  if (entry.action === 'restore_list') {
    // Resolve by name-to-id first; if not found (deleted), try to find by searching entities
    let listKey = await resolveListKey(entry.name);

    // Deleted lists are removed from name-to-id, so resolve from orphaned entities
    if (!listKey) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      for (const oe of (orphanedEntity.entries || [])) {
        const key = oe.key;
        if (!key.startsWith('list:') || key.startsWith('list:system/')) continue;
        const entity = await load(key, { includeDeleted: true });
        if (!entity) continue;
        if (entity.owner === entry.listOwner && entity.name === entry.name) { listKey = key; break; }
      }
    }
    if (!listKey) return result;

    // Load list entity with includeDeleted to preserve original fields
    const entity = await loadOrDefault(listKey, load, { includeDeleted: true });

    // LWW via deletedTs
    if (entity.deletedTs && entity.deletedTs >= entry.timestamp) return result;

    const restored = { ...touchTimestamp(entity, context.deviceId, entry.timestamp), deleted: false, deletedTs: entry.timestamp };
    result[listKey] = restored;

    // Append to tree manifest as top-level node
    const treeEntity = result['manifest:list-order'] || await loadOrDefault('manifest:list-order', load);
    const tree = treeEntity.tree || [];
    // Only add if not already in tree
    const inTree = (function findInTree(nodes) {
      for (const n of nodes) {
        if (n.id === listKey) return true;
        if (n.children && findInTree(n.children)) return true;
      }
      return false;
    })(tree);
    if (!inTree) {
      result['manifest:list-order'] = { ...touchTimestamp(treeEntity, context.deviceId, entry.timestamp), tree: [...tree.map(deepCloneTree), { id: listKey }] };
    }

    // Restore page parentIds for pins
    const pins = restored.pins || [];
    for (const pin of pins) {
      if (pin.id.startsWith(PAGE_PREFIX)) {
        const page = await load(pin.id);
        if (!page) continue;
        const parentIds = [...(page.parentIds || [])];
        if (!parentIds.includes(listKey)) parentIds.push(listKey);
        result[pin.id] = { ...page, parentIds };
      }
    }

    // Re-add to name-to-id
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };
    const listName = restored.name || entry.name;
    const listId = listKey.slice('list:'.length);
    const nameKey = restored.owner + '/' + listName;
    paths[nameKey] = listId;
    result['manifest:name-to-id'] = { ...touchTimestamp(nameToId, context.deviceId, entry.timestamp), paths };

    await unorphan(listKey, entry.timestamp);
    return result;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: simple string hash (same as generateSlug in utils.js)
// ---------------------------------------------------------------------------

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Per-entity apply functions (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a log entry to settings state.
 * Entry: { timestamp, action: 'update_setting', key, value }
 * Returns new settings object (or original if entry is irrelevant).
 */
export function applyLogToSettings(settings, entry, context = {}) {
  if (entry.action !== 'update_setting') return settings;
  return { ...touchTimestamp(settings, context.deviceId, entry.timestamp), [entry.key]: entry.value };
}
