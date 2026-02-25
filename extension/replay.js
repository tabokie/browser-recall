// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';

const REFERRER_CAP = 50;

const PAGE_PREFIX = 'page:';
const NOTE_PREFIX = 'note:';
const SHALLOW_PREFIX = 'shallow:';

/**
 * Return the set of page keys that an entry affects.
 * A visit entry with a referrerId affects both its own key (child-side: parentIds, visitDates)
 * and the referrer's key (parent-side: childIds accumulation).
 * All other entry types affect only the entry's own key.
 */
export function getAffectedKeys(entry) {
  const keys = new Set();
  const entrySlug = entry.slug || (entry.url ? generateSlugFromUrl(entry.url) : null);
  if (entrySlug) keys.add(PAGE_PREFIX + entrySlug);

  // Page entries with referrerId also affect the parent page
  if (entry.action === 'page' && entry.referrerId) {
    const parentKey = entry.referrerId; // already page:slug format
    if (parentKey !== PAGE_PREFIX + entrySlug) keys.add(parentKey);
  }

  return keys;
}

// Legacy alias
export function getAffectedSlugs(entry) {
  const slugs = new Set();
  for (const key of getAffectedKeys(entry)) {
    if (key.startsWith(PAGE_PREFIX)) slugs.add(key.slice(PAGE_PREFIX.length));
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Unified replay interface: scopeOf + applyTo
// ---------------------------------------------------------------------------

/**
 * Return the set of entity keys that an entry affects.
 * Keys use prefixed namespaces:
 *   page:{slug}                — page entity checkpoints
 *   note:{slug}                — note entity
 *   settings                   — global settings
 *   list:{listId}              — user list entity
 *   list:system/recycle-bin    — recycle bin
 *   list:system/permanent-deletes — permanent deletes
 *   list:system/shallow-page    — shallow page index for non-checkpointed pages
 */
export function scopeOf(entry) {
  const scope = {};

  if (entry.action === 'set') {
    scope['settings'] = null;
    return scope;
  }

  if (entry.action === 'list' || entry.action === 'list_meta' || entry.action === 'del_list') {
    if (entry.id) scope[`list:${entry.id}`] = null;
    // List entries with shallow: ids also affect shallow_page index
    if (entry.action === 'list' && entry.ids && entry.ids.some(id => id.startsWith(SHALLOW_PREFIX))) {
      scope['list:system/shallow-page'] = null;
    }
    return scope;
  }

  // Note action: affects the note entity + parent page entities
  if (entry.action === 'note') {
    scope[`${NOTE_PREFIX}${entry.slug}`] = null;
    if (entry.parentIds) {
      for (const parentKey of entry.parentIds) {
        scope[parentKey] = null;
      }
    }
    return scope;
  }

  // Page-affecting entries (page, page_checkpoint)
  for (const key of getAffectedKeys(entry)) {
    scope[key] = null;
  }

  // Page entries with referrer/title also affect shallow_page index
  if (entry.action === 'page' && (entry.referrerId || entry.title || entry.user_title)) {
    scope['list:system/shallow-page'] = null;
  }

  // page_checkpoint may need to absorb shallow_page index entries into new page
  if (entry.action === 'page_checkpoint') {
    scope['list:system/shallow-page'] = null;
  }

  return scope;
}

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
  if (key === 'settings') return { timestamp: 0 };
  if (key === 'list:system/recycle-bin') return { timestamp: 0, items: [] };
  if (key === 'list:system/permanent-deletes') return { timestamp: 0, keys: [] };
  if (key === 'list:system/shallow-page') return { timestamp: 0, index: {} };
  if (key.startsWith('list:')) {
    const slug = key.slice('list:'.length);
    return { timestamp: 0, slug, name: '', qbTrees: [], pins: [] };
  }
  return null;
}

/**
 * Compute the effect of a log entry against a backing store.
 * load(key) → entity | null   — async closure that reads from any backing store
 *                                (session cache, filesystem + round cache, etc.)
 *
 * Returns { key: updatedEntity | null } for every key in scopeOf(entry).
 * Combines scopeOf + load + applyTo into a single call.
 */
export async function effectOf(entry, load) {
  const scope = scopeOf(entry);
  for (const key of Object.keys(scope)) {
    scope[key] = await load(key);
  }
  return applyTo(entry, scope);
}

/**
 * Apply a log entry to a scope of entities.
 * scope: { key: entity | null } — null means entity doesn't exist.
 *
 * Rules for null entities:
 *   - page keys: only page_checkpoint can create from null
 *   - note keys: note action can create from null
 *   - all other keys: create from defaultEntity on first write
 * Returns new scope object with updated entities.
 */
export function applyTo(entry, scope) {
  const result = {};
  for (const [key, entity] of Object.entries(scope)) {
    if (entity === null) {
      // Page: only page_checkpoint can create from null
      if (key.startsWith(PAGE_PREFIX)) {
        if (entry.action === 'page_checkpoint') {
          result[key] = applyLogToPage(defaultEntity(key), entry);
        } else {
          result[key] = null;
        }
        continue;
      }
      // Note: note action can create from null
      if (key.startsWith(NOTE_PREFIX)) {
        if (entry.action === 'note') {
          result[key] = applyLogToNote(defaultEntity(key), entry);
        } else {
          result[key] = null;
        }
        continue;
      }
      // Non-page/note: create default entity and apply
      result[key] = applyEntry(key, defaultEntity(key), entry);
      continue;
    }
    result[key] = applyEntry(key, entity, entry);
  }

  // Cross-entity: when page_checkpoint creates page from null, absorb shallow_page index entries
  if (entry.action === 'page_checkpoint' && entry.url) {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = `${PAGE_PREFIX}${slug}`;
    const page = result[pageKey];
    const spIdx = result['list:system/shallow-page'];
    if (page && spIdx && spIdx.index && spIdx.index[entry.url]) {
      const shallowEntry = spIdx.index[entry.url];
      const parentRefs = shallowEntry.parents || [];
      if (parentRefs.length > 0) {
        // Absorb into page.parentIds
        const updated = { ...page };
        const parentIds = [...(updated.parentIds || [])];
        for (const parentRef of parentRefs) {
          if (!parentIds.includes(parentRef)) parentIds.push(parentRef);
        }
        updated.parentIds = parentIds;
        result[pageKey] = updated;
      }
      // Remove absorbed entry from shallow_page index
      const updatedIdx = { ...spIdx, index: { ...spIdx.index } };
      delete updatedIdx.index[entry.url];
      result['list:system/shallow-page'] = updatedIdx;
    }
  }

  // Cross-entity: when note action creates/updates a note, add to parent page's childIds
  if (entry.action === 'note' && entry.slug) {
    const noteKey = NOTE_PREFIX + entry.slug;
    if (result[noteKey] && entry.parentIds) {
      for (const parentKey of entry.parentIds) {
        if (parentKey.startsWith(PAGE_PREFIX) && result[parentKey]) {
          const parentPage = result[parentKey];
          const childIds = [...(parentPage.childIds || [])];
          if (!childIds.includes(noteKey)) {
            childIds.push(noteKey);
            result[parentKey] = { ...parentPage, childIds };
          }
        }
      }
    }
  }

  // Post-loop: prune shallow_page index entries for URLs whose pages exist in scope
  const spIdx = result['list:system/shallow-page'];
  if (spIdx && spIdx.index) {
    let pruned = false;
    const index = { ...spIdx.index };
    for (const url of Object.keys(index)) {
      const pageKey = PAGE_PREFIX + generateSlugFromUrl(url);
      if (result[pageKey] !== undefined && result[pageKey] !== null) {
        delete index[url];
        pruned = true;
      }
    }
    if (pruned) result['list:system/shallow-page'] = { ...spIdx, index };
  }

  // Post-loop: resolve shallow:<url> references in parentIds/childIds to page:<slug> keys when page exists in scope
  for (const [key, entity] of Object.entries(result)) {
    if (!key.startsWith(PAGE_PREFIX) || !entity) continue;
    let updated = entity;
    for (const field of ['parentIds', 'childIds']) {
      if (!updated[field] || updated[field].length === 0) continue;
      let changed = false;
      const resolved = updated[field].map(ref => {
        if (typeof ref !== 'string' || !ref.startsWith(SHALLOW_PREFIX)) return ref;
        const url = ref.slice(SHALLOW_PREFIX.length);
        const refSlug = generateSlugFromUrl(url);
        const refKey = PAGE_PREFIX + refSlug;
        if (result[refKey] !== undefined && result[refKey] !== null) {
          changed = true;
          return refKey;
        }
        return ref;
      });
      if (changed) updated = { ...updated, [field]: resolved };
    }
    if (updated !== entity) result[key] = updated;
  }

  return result;
}

function applyEntry(key, entity, entry) {
  if (key.startsWith(PAGE_PREFIX)) return applyLogToPage(entity, entry);
  if (key.startsWith(NOTE_PREFIX)) return applyLogToNote(entity, entry);
  if (key === 'settings') return applyLogToSettings(entity, entry);
  if (key === 'list:system/recycle-bin') return applyLogToRecycleBin(entity, entry);
  if (key === 'list:system/permanent-deletes') return applyLogToDeletes(entity, entry);
  if (key === 'list:system/shallow-page') return applyLogToShallowPage(entity, entry);
  if (key.startsWith('list:')) return applyLogToPins(entity, entry);
  return entity;
}

// ---------------------------------------------------------------------------
// Per-entity apply functions (used by applyTo internally, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a log entry to settings state.
 * Entry: { timestamp, action: 'set', key, value }
 * Returns new settings object (or original if entry is irrelevant).
 */
export function applyLogToSettings(settings, entry) {
  if (entry.action !== 'set') return settings;
  return { ...settings, [entry.key]: entry.value, timestamp: entry.timestamp };
}

/**
 * Apply a log entry to a page entity.
 * Handles:
 *   - page_checkpoint: create/update page watermark
 *   - page: unified visit + attention + capture (url, title, referrerId, scrollDepth, timeOnPage, mdPath, htmlPath)
 *     - On parent page (referrerId match): accumulate shallow child ref in childIds[]
 * Returns new page object (or original if entry is irrelevant).
 */
export function applyLogToPage(page, entry) {
  // Derive slug from entry URL (slug field removed from log entries)
  const entrySlug = entry.url ? generateSlugFromUrl(entry.url) : null;

  // page_checkpoint: passthrough that creates/updates page watermark
  if (entry.action === 'page_checkpoint') {
    if (entrySlug !== page.slug && page.slug !== undefined) return page;
    const updated = { ...page };
    if (!updated.url && entry.url) updated.url = entry.url;
    if (!updated.title && entry.title) updated.title = entry.title;
    updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
    return updated;
  }

  // Unified page entry: visit + attention + capture
  if (entry.action === 'page') {
    // Parent-side: if this page's referrerId matches this page, accumulate shallow child ref
    if (entry.referrerId && page.slug !== undefined) {
      const referrerSlug = entry.referrerId.startsWith(PAGE_PREFIX)
        ? entry.referrerId.slice(PAGE_PREFIX.length) : entry.referrerId;
      if (referrerSlug === page.slug && entrySlug !== page.slug) {
        const updated = { ...page };
        const childIds = [...(updated.childIds || [])];
        const shallowRef = SHALLOW_PREFIX + entry.url;
        const pageRef = PAGE_PREFIX + entrySlug;
        if (!childIds.some(c => c === shallowRef || c === pageRef)) {
          childIds.push(shallowRef);
          if (childIds.length > REFERRER_CAP) childIds.shift();
        }
        updated.childIds = childIds;
        updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
        return updated;
      }
    }

    // Child-side slug check
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== page.slug && page.slug !== undefined) return page;

    const prevTimestamp = page.timestamp || 0; // save before mutation for attention idempotency
    const updated = { ...page };

    // Visit fields
    if (entry.url) updated.url = entry.url;
    if (entry.title) updated.title = entry.title;
    if (entry.user_title) updated.user_title = entry.user_title;
    updated.timestamp = entry.timestamp;

    // visitDates (only when url present = visit entry)
    if (entry.url) {
      const d = new Date(entry.timestamp);
      const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      if (!updated.visitDates) updated.visitDates = [];
      else updated.visitDates = [...updated.visitDates];
      if (!updated.visitDates.includes(yyyymmdd)) updated.visitDates.push(yyyymmdd);
    }

    // parentIds from referrerId (already in page:slug format)
    if (entry.referrerId) {
      const parentIds = [...(updated.parentIds || [])];
      if (!parentIds.includes(entry.referrerId)) {
        parentIds.push(entry.referrerId);
        if (parentIds.length > REFERRER_CAP) parentIds.shift();
      }
      updated.parentIds = parentIds;
    }

    // Attention (guard with prevTimestamp for idempotency)
    if ((entry.scrollDepth !== undefined || entry.timeOnPage !== undefined || entry.likes !== undefined)
        && entry.timestamp > prevTimestamp) {
      let att = { scrollDepth: 0, timeOnPage: 0 };
      if (updated.attention && updated.attention !== '') {
        try { att = JSON.parse(updated.attention); } catch {}
      }
      if (entry.scrollDepth !== undefined) {
        att.scrollDepth = Math.max(att.scrollDepth || 0, entry.scrollDepth);
      }
      if (entry.timeOnPage !== undefined) {
        att.timeOnPage = (att.timeOnPage || 0) + entry.timeOnPage;
      }
      if (entry.likes !== undefined) {
        att.likes = (att.likes || 0) + entry.likes;
      }
      updated.attention = JSON.stringify(att);
    }

    // Capture fields
    if (entry.mdPath) updated.mdPath = entry.mdPath;
    if (entry.htmlPath) updated.htmlPath = entry.htmlPath;

    return updated;
  }

  return page;
}

/**
 * Apply a log entry to a note entity.
 * Handles:
 *   - note: create/update note (excerpt, note text, cssPath, parentIds, childIds)
 * Returns new note object (or original if entry is irrelevant).
 */
export function applyLogToNote(noteEntity, entry) {
  if (entry.action !== 'note') return noteEntity;
  if (entry.slug !== noteEntity.slug) return noteEntity;

  const updated = { ...noteEntity };
  if (entry.excerpt !== undefined) updated.excerpt = entry.excerpt;
  if (entry.note !== undefined) updated.note = entry.note;
  if (entry.cssPath !== undefined) updated.cssPath = entry.cssPath;
  if (entry.parentIds !== undefined) updated.parentIds = entry.parentIds;
  if (entry.childIds !== undefined) updated.childIds = entry.childIds;
  updated.timestamp = entry.timestamp;
  return updated;
}

/**
 * Apply a log entry to a list entity (self-describing file).
 * Entity: { timestamp, id, name, qbTrees, pins: [...] }
 * Handles:
 *   - list (id="{listId}", op=add/del/clear): granular pin operations (typed ids)
 *   - list_meta (id="{listId}"): list metadata (name, qbTrees)
 *   - del_list (id="{listId}"): mark entity as deleted
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToPins(pinsEntity, entry) {
  if (entry.action === 'list' && entry.id === pinsEntity.slug) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    let pins = [...(pinsEntity.pins || [])];

    if (entry.op === 'clear') {
      updated.pins = [];
    } else if (entry.op === 'add' && entry.ids) {
      for (const id of entry.ids) {
        if (!pins.some(p => p.id === id)) {
          pins.push({ id, pinnedAt: entry.timestamp });
        }
      }
      updated.pins = pins;
    } else if (entry.op === 'del' && entry.ids) {
      pins = pins.filter(p => !entry.ids.includes(p.id));
      updated.pins = pins;
    }

    return updated;
  }
  if (entry.action === 'list_meta' && entry.id === pinsEntity.slug) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    updated.name = entry.name;
    if (entry.qbTrees !== undefined) updated.qbTrees = entry.qbTrees;
    return updated;
  }
  if (entry.action === 'del_list' && entry.id === pinsEntity.slug) {
    return { timestamp: entry.timestamp, deleted: true };
  }
  return pinsEntity;
}

/**
 * Apply a log entry to a recycle-bin entity.
 * Entity: { timestamp, items: [...] }
 * Entry: { timestamp, action: 'list', id: 'system/recycle-bin', op: 'add'|'del'|'clear', keys: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToRecycleBin(recycleBinEntity, entry) {
  if (entry.action !== 'list' || entry.id !== 'system/recycle-bin') return recycleBinEntity;

  const updated = { timestamp: entry.timestamp };
  let items = [...(recycleBinEntity.items || [])];

  if (entry.op === 'clear') {
    updated.items = [];
  } else if (entry.op === 'add' && entry.keys) {
    for (const key of entry.keys) {
      if (!items.some(item => item.key === key)) {
        items.push({ key, title: 'Untitled', deletedAt: entry.timestamp });
      }
    }
    updated.items = items;
  } else if (entry.op === 'del' && entry.keys) {
    items = items.filter(item => !entry.keys.includes(item.key));
    updated.items = items;
  } else {
    updated.items = items;
  }

  return updated;
}

/**
 * Apply a log entry to the shallow page index (for non-checkpointed pages).
 * Index: { timestamp, index: { url: { parents: [...], lists: [...], title, user_title } } }
 * Processes:
 *   - page entries with referrerId: records parent in index[url].parents
 *   - page entries with title/user_title: updates index[url].title/user_title
 *   - list entries with shallow: ids: records list membership in index[url].lists
 * Returns new index (or original if entry is irrelevant).
 */
export function applyLogToShallowPage(shallowPageIndex, entry) {
  // Page entry: record parents and title info
  if (entry.action === 'page' && entry.url) {
    const hasReferrer = !!entry.referrerId;
    const hasTitle = !!entry.title;
    const hasUserTitle = !!entry.user_title;
    if (!hasReferrer && !hasTitle && !hasUserTitle) return shallowPageIndex;

    const updated = { ...shallowPageIndex };
    const index = { ...updated.index };
    const existing = index[entry.url] || { parents: [], lists: [], title: null, user_title: null };
    const rec = { ...existing };

    if (hasReferrer) {
      const parents = [...rec.parents];
      if (!parents.includes(entry.referrerId)) parents.push(entry.referrerId);
      rec.parents = parents;
    }
    if (hasTitle) rec.title = entry.title;
    if (hasUserTitle) rec.user_title = entry.user_title;

    index[entry.url] = rec;
    updated.index = index;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  // List entry with shallow: ids: record list membership
  if (entry.action === 'list' && entry.ids && entry.id) {
    const shallowUrls = entry.ids
      .filter(id => id.startsWith(SHALLOW_PREFIX))
      .map(id => id.slice(SHALLOW_PREFIX.length));
    if (shallowUrls.length === 0) return shallowPageIndex;

    const listKey = `list:${entry.id}`;
    const updated = { ...shallowPageIndex };
    const index = { ...updated.index };

    for (const url of shallowUrls) {
      const existing = index[url] || { parents: [], lists: [], title: null, user_title: null };
      const rec = { ...existing };

      if (entry.op === 'add') {
        const lists = [...rec.lists];
        if (!lists.includes(listKey)) lists.push(listKey);
        rec.lists = lists;
      } else if (entry.op === 'del') {
        rec.lists = rec.lists.filter(l => l !== listKey);
      }

      index[url] = rec;
    }

    updated.index = index;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  return shallowPageIndex;
}

/**
 * Apply a log entry to a permanent-deletes entity.
 * Entity: { timestamp, keys: [...] }
 * Entry: { timestamp, action: 'list', id: 'system/permanent-deletes', op: 'add'|'del'|'clear', keys: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToDeletes(deletesEntity, entry) {
  if (entry.action !== 'list' || entry.id !== 'system/permanent-deletes') return deletesEntity;

  const updated = { timestamp: entry.timestamp };
  let keys = [...(deletesEntity.keys || [])];

  if (entry.op === 'clear') {
    updated.keys = [];
  } else if (entry.op === 'add' && entry.keys) {
    for (const key of entry.keys) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    updated.keys = keys;
  } else if (entry.op === 'del' && entry.keys) {
    keys = keys.filter(k => !entry.keys.includes(k));
    updated.keys = keys;
  } else {
    updated.keys = keys;
  }

  return updated;
}
