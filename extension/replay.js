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
    return { slug, timestamp: 0, parentIds: [], childIds: [] };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    const slug = key.slice(NOTE_PREFIX.length);
    return { slug, timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
  }
  if (key === 'manifest:settings') return { timestamp: 0 };
  if (key === 'manifest:orphaned') return { timestamp: 0, keys: [] };
  if (key === 'list:system/root') return { timestamp: 0, childLists: [] };
  if (key === 'manifest:name-to-id') return { timestamp: 0, paths: {} };
  if (key.startsWith('list:')) {
    const slug = key.slice('list:'.length);
    return { timestamp: 0, slug, name: '', pins: [], rules: [], parentList: null, childLists: [] };
  }
  return null;
}

/** Load entity, falling back to defaultEntity for non-page/non-note keys. */
async function loadOrDefault(key, load, opts) {
  return (await load(key, opts)) ?? defaultEntity(key);
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
export async function effectOf(entry, load) {
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

  async function orphan(childKey, ts) {
    const orphaned = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    const keys = [...(orphaned.keys || [])];
    if (!keys.includes(childKey)) keys.push(childKey);
    result['manifest:orphaned'] = { ...orphaned, timestamp: ts, keys };
  }

  async function unorphan(childKey, ts) {
    const orphaned = result['manifest:orphaned'] || await loadOrDefault('manifest:orphaned', load);
    const keys = (orphaned.keys || []).filter(k => k !== childKey);
    result['manifest:orphaned'] = { ...orphaned, timestamp: ts, keys };
  }

  /**
   * Resolve a list from parents array + name to its internal list key via manifest:name-to-id.
   * System lists use their name directly as the ID.
   * Returns null if user list not found in name-to-id.
   */
  async function resolveListKey(parents, name) {
    if (!name) return null;
    // System lists: name IS the ID
    if (name.startsWith('system/')) {
      return `list:${name}`;
    }
    // User lists: resolve via manifest:name-to-id
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const path = parents.length === 0 ? `root/${name}` : `${parents.join('/')}/${name}`;
    const id = nameToId.paths?.[path];
    return id ? `list:${id}` : null;
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

  // --- update_setting ---
  if (entry.action === 'update_setting') {
    const settings = await loadOrDefault('manifest:settings', load);
    result['manifest:settings'] = { ...settings, [entry.key]: entry.value, timestamp: entry.timestamp };
    return result;
  }

  // --- visit_page ---
  // Enriches existing page entities only. Passive visits do NOT create entities.
  if (entry.action === 'visit_page') {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = PAGE_PREFIX + slug;
    const page = await load(pageKey);

    if (page) {
      const updated = { ...page, timestamp: entry.timestamp };
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
          result[referrerKey] = { ...parent, childIds, timestamp: Math.max(parent.timestamp || 0, entry.timestamp) };
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
      const prevTimestamp = page.timestamp || 0;
      const updated = { ...page, timestamp: entry.timestamp };

      // Title: latest auto-detected from MutationObserver, folded into leave report
      if (entry.title) updated.title = entry.title;

      // Attention (guard with prevTimestamp for idempotency)
      if (entry.timestamp > prevTimestamp) {
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
    result[pageKey] = { ...page, user_title: entry.user_title, timestamp: entry.timestamp };
    return result;
  }

  // --- rate_page ---
  // Like/dislike. Creates entity if missing (explicit user action).
  if (entry.action === 'rate_page') {
    const { pageKey } = await ensurePageEntity(entry.url, entry.timestamp, entry.title);
    const page = result[pageKey];
    const prevTimestamp = page.timestamp || 0;
    const updated = { ...page, timestamp: entry.timestamp };

    if (entry.timestamp > prevTimestamp && entry.likes !== undefined) {
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
    const updated = { ...page, timestamp: entry.timestamp };

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
    await linkChild(noteKey, [pageKey]);
    return result;
  }

  // --- delete_note ---
  if (entry.action === 'delete_note') {
    const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const noteKey = `${NOTE_PREFIX}${noteSlug}`;
    // Load with includeDeleted; noop if already deleted
    const note = await loadOrDefault(noteKey, load, { includeDeleted: true });
    if (note.deleted) return result;

    // Unlink from parent pages
    const pageParents = (note.parentIds || []).filter(p => p.startsWith(PAGE_PREFIX));
    await unlinkChild(noteKey, pageParents);
    // GC parent pages that became ineligible
    for (const pk of pageParents) {
      const p = result[pk];
      if (p && !isPageEligible(p)) result[pk] = null;
    }
    // Remove note pin from lists
    const listParents = (note.parentIds || []).filter(p => p.startsWith('list:') && !p.startsWith('list:system/'));
    for (const lk of listParents) {
      const list = await load(lk);
      if (!list) continue;
      result[lk] = { ...list, pins: (list.pins || []).filter(p => p.id !== noteKey) };
    }
    // Mark deleted (note entity retains parentIds for restore)
    result[noteKey] = { ...note, deleted: true, timestamp: entry.timestamp };
    await orphan(noteKey, entry.timestamp);
    return result;
  }

  // --- restore_note ---
  if (entry.action === 'restore_note') {
    const noteSlug = entry.path.slice('notes/'.length, -'.json'.length);
    const noteKey = `${NOTE_PREFIX}${noteSlug}`;
    // Load with includeDeleted to preserve original entity fields
    const note = await loadOrDefault(noteKey, load, { includeDeleted: true });

    // Re-link to parent pages
    const pageParents = (note.parentIds || []).filter(p => p.startsWith(PAGE_PREFIX));
    await linkChild(noteKey, pageParents);
    // Re-add note to lists
    const listParents = (note.parentIds || []).filter(p => p.startsWith('list:') && !p.startsWith('list:system/'));
    for (const lk of listParents) {
      const list = await load(lk);
      if (!list) continue;
      const pins = [...(list.pins || [])];
      if (!pins.some(p => p.id === noteKey)) {
        pins.push({ id: noteKey, pinnedAt: entry.timestamp });
      }
      result[lk] = { ...list, pins };
    }
    // Clear deleted flag
    result[noteKey] = { ...note, deleted: false, timestamp: entry.timestamp };
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
    await orphan(snapKey, entry.timestamp);
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

    // Load old note; noop if already deleted
    const oldNote = await loadOrDefault(oldNoteKey, load, { includeDeleted: true });
    if (oldNote.deleted) return result;

    // Unlink old note from parent pages (derived from entity, same pattern as delete_note)
    const pageParents = (oldNote.parentIds || []).filter(p => p.startsWith(PAGE_PREFIX));
    await unlinkChild(oldNoteKey, pageParents);

    // Link new note to same parent pages
    await linkChild(newNoteKey, pageParents);

    // Transfer list pins: replace old note with new note in each list
    const listParents = (oldNote.parentIds || []).filter(p => p.startsWith('list:') && !p.startsWith('list:system/'));
    for (const lk of listParents) {
      const list = result[lk] !== undefined ? result[lk] : await load(lk);
      if (!list) continue;
      const pins = (list.pins || []).map(p =>
        p.id === oldNoteKey ? { ...p, id: newNoteKey } : p
      );
      result[lk] = { ...list, pins };
    }

    // Set up new note's parentIds (inheriting from old)
    const newNote = result[newNoteKey] !== undefined ? result[newNoteKey] : await load(newNoteKey);
    const newParentIds = [...(oldNote.parentIds || [])];
    if (newNote) {
      result[newNoteKey] = { ...newNote, parentIds: newParentIds };
    } else {
      result[newNoteKey] = { ...defaultEntity(newNoteKey), parentIds: newParentIds };
    }

    // Mark old note as replaced + orphan
    result[oldNoteKey] = {
      ...oldNote,
      deleted: true,
      deletionReason: 'replaced',
      replacedBy: newNoteKey,
      timestamp: entry.timestamp,
    };
    await orphan(oldNoteKey, entry.timestamp);

    return result;
  }

  // --- pin_to_list ---
  // Add items to a list. Items are URLs (for pages) or "notes/<slug>.json" paths (for notes).
  if (entry.action === 'pin_to_list') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    // Guard: reject actions on orphaned (deleted) lists
    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
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

      // Update page/note parentIds with list key
      if (pinId.startsWith(PAGE_PREFIX)) {
        const page = result[pinId] || await load(pinId);
        if (page) {
          const parentIds = [...(page.parentIds || [])];
          if (!parentIds.includes(listKey)) parentIds.push(listKey);
          result[pinId] = { ...page, parentIds };
        }
      } else if (pinId.startsWith(NOTE_PREFIX)) {
        const note = await load(pinId);
        if (note) {
          const parentIds = [...(note.parentIds || [])];
          if (!parentIds.includes(listKey)) parentIds.push(listKey);
          result[pinId] = { ...note, parentIds };
        }
      }
    }

    result[listKey] = { ...entity, pins, timestamp: entry.timestamp };
    return result;
  }

  // --- unpin_from_list ---
  // Remove items from a list. Items are URLs (for pages) or "notes/<slug>.json" paths (for notes).
  if (entry.action === 'unpin_from_list') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    // Guard: reject actions on orphaned (deleted) lists
    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
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
    result[listKey] = { ...entity, pins, timestamp: entry.timestamp };

    // Update page/note parentIds: remove list key
    for (const pinId of removeIds) {
      if (pinId.startsWith(PAGE_PREFIX)) {
        const page = await load(pinId);
        if (page) {
          const parentIds = (page.parentIds || []).filter(p => p !== listKey);
          const updated = { ...page, parentIds };
          result[pinId] = isPageEligible(updated) ? updated : null;
        }
      } else if (pinId.startsWith(NOTE_PREFIX)) {
        const note = await load(pinId);
        if (note) {
          const parentIds = (note.parentIds || []).filter(p => p !== listKey);
          result[pinId] = { ...note, parentIds };
        }
      }
    }

    return result;
  }

  // --- add_rule ---
  // Add a matching rule to a list.
  if (entry.action === 'add_rule') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
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

    result[listKey] = { ...entity, rules, timestamp: entry.timestamp };
    return result;
  }

  // --- remove_rule ---
  // Remove a matching rule from a list by ID.
  if (entry.action === 'remove_rule') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
    const rules = (entity.rules || []).filter(r => r.id !== entry.ruleId);
    result[listKey] = { ...entity, rules, timestamp: entry.timestamp };
    return result;
  }

  // --- update_rule ---
  // Update config of an existing rule by ID (merges config fields).
  if (entry.action === 'update_rule') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
    const rules = (entity.rules || []).map(r => {
      if (r.id !== entry.ruleId) return r;
      return { ...r, config: { ...r.config, ...entry.config } };
    });
    result[listKey] = { ...entity, rules, timestamp: entry.timestamp };
    return result;
  }

  // --- create_list ---
  // Creates a new list entity. Generates internal ID, updates name-to-id, links to parent.
  if (entry.action === 'create_list') {
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };

    // Resolve parent from entry.parents array
    const parents = entry.parents || [];
    let parentKey;
    if (parents.length === 0) {
      parentKey = 'list:system/root';
    } else {
      const parentName = parents[parents.length - 1];
      const parentParents = parents.slice(0, -1);
      parentKey = await resolveListKey(parentParents, parentName);
      if (!parentKey) parentKey = 'list:system/root';
    }

    // Use provided listId (migrated events) or generate from name+timestamp (new events)
    const listId = entry.listId || (entry.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').substring(0, 30) + '-' + Math.abs(hashString(entry.name + entry.timestamp)).toString(36));
    const listKey = `list:${listId}`;

    // Create list entity
    const entity = defaultEntity(listKey);
    entity.name = entry.name;
    entity.parentList = parentKey;
    entity.timestamp = entry.timestamp;
    result[listKey] = entity;

    // Add to parent's childLists
    const parent = result[parentKey] || await loadOrDefault(parentKey, load);
    const childLists = [...(parent.childLists || [])];
    if (!childLists.includes(listKey)) childLists.push(listKey);
    result[parentKey] = { ...parent, timestamp: entry.timestamp, childLists };

    // Update name-to-id
    const fullPath = parents.length === 0
      ? `root/${entry.name}`
      : `${parents.join('/')}/${entry.name}`;
    paths[fullPath] = listId;
    result['manifest:name-to-id'] = { ...nameToId, timestamp: entry.timestamp, paths };

    return result;
  }

  // --- update_list ---
  // Rename list.
  // entry.name identifies the current list; entry.newName is the rename target.
  if (entry.action === 'update_list') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    // Guard: reject actions on orphaned (deleted) lists
    if (!listKey.startsWith('list:system/')) {
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      if ((orphanedEntity.keys || []).includes(listKey)) return result;
    }

    const entity = await loadOrDefault(listKey, load);
    const updated = { ...entity, timestamp: entry.timestamp };

    if (entry.newName !== undefined) {
      const oldName = entity.name;
      updated.name = entry.newName;

      // Update name-to-id: rename this path and all descendant paths
      if (oldName !== entry.newName) {
        const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
        const paths = { ...nameToId.paths };
        const oldPath = entry.parents.length === 0 ? `root/${entry.name}` : `${entry.parents.join('/')}/${entry.name}`;
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentPath}/${entry.newName}`;

        // Rename: delete old path, add new path
        const listId = paths[oldPath];
        delete paths[oldPath];
        paths[newPath] = listId;

        // Rename all descendant paths
        const oldPrefix = oldPath + '/';
        for (const [p, id] of Object.entries(paths)) {
          if (p.startsWith(oldPrefix)) {
            const suffix = p.slice(oldPrefix.length);
            delete paths[p];
            paths[`${newPath}/${suffix}`] = id;
          }
        }

        result['manifest:name-to-id'] = { ...nameToId, timestamp: entry.timestamp, paths };
      }
    }

    result[listKey] = updated;
    return result;
  }

  // --- reparent_list ---
  // Move list between parents. Uses full childNames for destination parent (last-write-wins).
  if (entry.action === 'reparent_list') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    if (listKey.startsWith('list:system/')) return result;

    const entity = await loadOrDefault(listKey, load);
    const fromKey = entity.parentList || 'list:system/root';

    // Resolve destination parent from toParents array
    const toParents = entry.toParents || [];
    let toKey;
    if (toParents.length === 0) {
      toKey = 'list:system/root';
    } else {
      const toName = toParents[toParents.length - 1];
      const toParentParents = toParents.slice(0, -1);
      toKey = await resolveListKey(toParentParents, toName);
      if (!toKey) toKey = 'list:system/root';
    }

    // Remove from source parent's childLists
    const fromEntity = result[fromKey] || await loadOrDefault(fromKey, load);
    fromEntity.childLists = (fromEntity.childLists || []).filter(k => k !== listKey);
    result[fromKey] = { ...fromEntity, timestamp: entry.timestamp };

    // Update child's parentList
    entity.parentList = toKey;
    result[listKey] = { ...entity, timestamp: entry.timestamp };

    // Update name-to-id FIRST (before childNames resolution, since moved list's path changes)
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };
    const oldPath = entry.parents.length === 0 ? `root/${entry.name}` : `${entry.parents.join('/')}/${entry.name}`;
    const toPath = toParents.length === 0 ? 'root' : toParents.join('/');
    const newPath = `${toPath}/${entry.name}`;

    if (oldPath !== newPath) {
      const listId = paths[oldPath];
      delete paths[oldPath];
      paths[newPath] = listId;

      // Move all descendant paths
      const oldPrefix = oldPath + '/';
      for (const [p, id] of Object.entries(paths)) {
        if (p.startsWith(oldPrefix)) {
          const suffix = p.slice(oldPrefix.length);
          delete paths[p];
          paths[`${newPath}/${suffix}`] = id;
        }
      }

      result['manifest:name-to-id'] = { ...nameToId, timestamp: entry.timestamp, paths };
    }

    // Set destination parent's childLists from childNames (complete, last-write-wins)
    const toEntity = (toKey === fromKey) ? result[fromKey] : (result[toKey] || await loadOrDefault(toKey, load));

    if (entry.childNames) {
      // Resolve child names to keys using the UPDATED name-to-id
      const updatedNameToId = result['manifest:name-to-id'] || nameToId;
      const childKeys = [];
      for (const cname of entry.childNames) {
        const childPath = `${toPath}/${cname}`;
        const childId = updatedNameToId.paths?.[childPath];
        if (childId) childKeys.push(`list:${childId}`);
      }
      result[toKey] = { ...toEntity, timestamp: entry.timestamp, childLists: childKeys };
    } else {
      // Fallback: just append to destination (for simple cases)
      const cl = [...(toEntity.childLists || [])].filter(k => k !== listKey);
      cl.push(listKey);
      result[toKey] = { ...toEntity, timestamp: entry.timestamp, childLists: cl };
    }

    return result;
  }

  // --- delete_list ---
  // Soft-delete a list. Cascading effects derived from entity state.
  if (entry.action === 'delete_list') {
    const listKey = await resolveListKey(entry.parents, entry.name);
    if (!listKey) return result;

    if (listKey.startsWith('list:system/')) return result;

    const entity = await loadOrDefault(listKey, load, { includeDeleted: true });
    // Noop if already deleted
    if (entity.deleted) return result;

    // Mark deleted
    result[listKey] = { ...entity, timestamp: entry.timestamp, deleted: true };

    // Remove from parent's childLists
    const parentKey = entity.parentList || 'list:system/root';
    const parent = result[parentKey] || await loadOrDefault(parentKey, load);
    result[parentKey] = { ...parent, timestamp: entry.timestamp, childLists: (parent.childLists || []).filter(k => k !== listKey) };

    // Soft-delete all descendant lists (BFS)
    const queue = [...(entity.childLists || [])];
    const visited = new Set();
    while (queue.length > 0) {
      const childKey = queue.shift();
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      const child = result[childKey] || await loadOrDefault(childKey, load);
      result[childKey] = { ...child, timestamp: entry.timestamp, deleted: true };
      await orphan(childKey, entry.timestamp);
      if (child.childLists) queue.push(...child.childLists);
    }

    // Remove list key from all pinned page/note parentIds
    const pins = entity.pins || [];
    for (const pin of pins) {
      if (pin.id.startsWith(PAGE_PREFIX)) {
        const page = await load(pin.id);
        if (!page) continue;
        const parentIds = (page.parentIds || []).filter(p => p !== listKey);
        const updated = { ...page, parentIds };
        result[pin.id] = isPageEligible(updated) ? updated : null;
      } else if (pin.id.startsWith(NOTE_PREFIX)) {
        const note = await load(pin.id);
        if (!note) continue;
        const parentIds = (note.parentIds || []).filter(p => p !== listKey);
        result[pin.id] = { ...note, parentIds };
      }
    }

    // Remove from name-to-id (this list and all descendants)
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };
    const listPath = entry.parents.length === 0 ? `root/${entry.name}` : `${entry.parents.join('/')}/${entry.name}`;
    delete paths[listPath];
    const pathPrefix = listPath + '/';
    for (const p of Object.keys(paths)) {
      if (p.startsWith(pathPrefix)) delete paths[p];
    }
    result['manifest:name-to-id'] = { ...nameToId, timestamp: entry.timestamp, paths };

    await orphan(listKey, entry.timestamp);
    return result;
  }

  // --- restore_list ---
  // Restore a deleted list. Restores to root by default.
  if (entry.action === 'restore_list') {
    // Resolve by name-to-id first; if not found (deleted), try to find by searching entities
    let listKey = await resolveListKey(entry.parents, entry.name);

    // Deleted lists are removed from name-to-id, so resolve from orphaned entities
    if (!listKey) {
      // Scan orphaned keys for a list matching this name
      const orphanedEntity = await loadOrDefault('manifest:orphaned', load);
      for (const key of (orphanedEntity.keys || [])) {
        if (!key.startsWith('list:') || key.startsWith('list:system/')) continue;
        const entity = await load(key, { includeDeleted: true });
        if (entity?.name === entry.name) {
          listKey = key;
          break;
        }
      }
    }
    if (!listKey) return result;

    // Load list entity with includeDeleted to preserve original fields
    const entity = await loadOrDefault(listKey, load, { includeDeleted: true });
    const restored = { ...entity, deleted: false, timestamp: entry.timestamp };

    // Re-add to root's childLists (restored lists always go to root)
    const root = result['list:system/root'] || await loadOrDefault('list:system/root', load);
    const rootCL = [...(root.childLists || [])];
    if (!rootCL.includes(listKey)) rootCL.push(listKey);
    result['list:system/root'] = { ...root, timestamp: entry.timestamp, childLists: rootCL };
    restored.parentList = 'list:system/root';
    result[listKey] = restored;

    // Restore all descendants
    const queue = [...(entity.childLists || [])];
    const visited = new Set();
    while (queue.length > 0) {
      const childKey = queue.shift();
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      const child = result[childKey] || await loadOrDefault(childKey, load, { includeDeleted: true });
      result[childKey] = { ...child, deleted: false, timestamp: entry.timestamp };
      await unorphan(childKey, entry.timestamp);
      if (child.childLists) queue.push(...child.childLists);
    }

    // Restore page/note parentIds for pins
    const pins = restored.pins || [];
    for (const pin of pins) {
      if (pin.id.startsWith(PAGE_PREFIX)) {
        const page = await load(pin.id);
        if (!page) continue;
        const parentIds = [...(page.parentIds || [])];
        if (!parentIds.includes(listKey)) parentIds.push(listKey);
        result[pin.id] = { ...page, parentIds };
      } else if (pin.id.startsWith(NOTE_PREFIX)) {
        const note = await load(pin.id);
        if (!note) continue;
        const parentIds = [...(note.parentIds || [])];
        if (!parentIds.includes(listKey)) parentIds.push(listKey);
        result[pin.id] = { ...note, parentIds };
      }
    }

    // Re-add to name-to-id
    const nameToId = result['manifest:name-to-id'] || await loadOrDefault('manifest:name-to-id', load);
    const paths = { ...nameToId.paths };
    const listName = restored.name || entry.name;
    const listId = listKey.slice('list:'.length);
    paths[`root/${listName}`] = listId;
    // Also re-add descendants
    for (const childKey of visited) {
      const child = result[childKey];
      if (child?.name) {
        const childId = childKey.slice('list:'.length);
        // Simplified: put descendants directly under restored list
        paths[`root/${listName}/${child.name}`] = childId;
      }
    }
    result['manifest:name-to-id'] = { ...nameToId, timestamp: entry.timestamp, paths };

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
export function applyLogToSettings(settings, entry) {
  if (entry.action !== 'update_setting') return settings;
  return { ...settings, [entry.key]: entry.value, timestamp: entry.timestamp };
}
