// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';

const REFERRER_CAP = 50;

const PAGE_PREFIX = 'page:';
const NOTE_PREFIX = 'note:';

/**
 * Return the set of page keys that an entry affects.
 * A visit entry with a referrer affects both its own key (child-side: parents, visitDates)
 * and the referrer's key (parent-side: children accumulation).
 * All other entry types affect only the entry's own key.
 */
export function getAffectedKeys(entry) {
  const keys = new Set();
  const entrySlug = entry.slug || (entry.url ? generateSlugFromUrl(entry.url) : null);
  if (entrySlug) keys.add(PAGE_PREFIX + entrySlug);

  // Page entries with referrers also affect the parent page
  if (entry.action === 'page' && entry.referrer) {
    const parentSlug = generateSlugFromUrl(entry.referrer);
    const parentKey = PAGE_PREFIX + parentSlug;
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
 *   list:index/parent          — parent-index for non-checkpointed pages
 */
export function scopeOf(entry) {
  const scope = {};

  if (entry.action === 'set') {
    scope['settings'] = null;
    return scope;
  }

  if (entry.action === 'list' || entry.action === 'list_meta' || entry.action === 'del_list') {
    if (entry.id) scope[`list:${entry.id}`] = null;
    return scope;
  }

  // Note action: affects the note entity + parent page entities
  if (entry.action === 'note') {
    scope[`${NOTE_PREFIX}${entry.slug}`] = null;
    if (entry.parents) {
      for (const parentKey of entry.parents) {
        scope[parentKey] = null;
      }
    }
    return scope;
  }

  // Page-affecting entries (page, page_checkpoint)
  for (const key of getAffectedKeys(entry)) {
    scope[key] = null;
  }

  // Page entries with referrer also affect parent-index
  if (entry.action === 'page' && entry.referrer) {
    scope['list:index/parent'] = null;
  }

  // page_checkpoint may need to absorb parent-index entries into new page
  if (entry.action === 'page_checkpoint') {
    scope['list:index/parent'] = null;
  }

  return scope;
}

/**
 * Default empty entity for a given key. Used when creating entities from null.
 */
export function defaultEntity(key) {
  if (key.startsWith(PAGE_PREFIX)) {
    const slug = key.slice(PAGE_PREFIX.length);
    return { slug, timestamp: 0, parents: [], children: [] };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    const slug = key.slice(NOTE_PREFIX.length);
    return { slug, timestamp: 0, quote: null, note: null, cssPath: null, parents: [], children: [] };
  }
  if (key === 'settings') return { timestamp: 0 };
  if (key === 'list:system/recycle-bin') return { timestamp: 0, items: [] };
  if (key === 'list:system/permanent-deletes') return { timestamp: 0, keys: [] };
  if (key === 'list:index/parent') return { timestamp: 0, index: {} };
  if (key.startsWith('list:')) {
    const id = key.slice('list:'.length);
    return { timestamp: 0, id, name: '', qbTrees: [], pins: [] };
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

  // Cross-entity: when page_checkpoint creates page from null, absorb parent-index entries
  if (entry.action === 'page_checkpoint' && entry.url) {
    const slug = generateSlugFromUrl(entry.url);
    const pageKey = `${PAGE_PREFIX}${slug}`;
    const page = result[pageKey];
    const pIdx = result['list:index/parent'];
    if (page && pIdx && pIdx.index && pIdx.index[entry.url]) {
      const parentSlugs = pIdx.index[entry.url];
      if (parentSlugs.length > 0) {
        // Absorb into page.parents (as page:slug keys)
        const updated = { ...page };
        const parents = [...(updated.parents || [])];
        for (const ps of parentSlugs) {
          const parentKey = PAGE_PREFIX + ps;
          if (!parents.includes(parentKey)) parents.push(parentKey);
        }
        updated.parents = parents;
        result[pageKey] = updated;
        // Remove absorbed entry from parent-index
        const updatedIdx = { ...pIdx, index: { ...pIdx.index } };
        delete updatedIdx.index[entry.url];
        result['list:index/parent'] = updatedIdx;
      }
    }
  }

  // Cross-entity: when note action creates/updates a note, add to parent page's children
  if (entry.action === 'note' && entry.slug) {
    const noteKey = NOTE_PREFIX + entry.slug;
    if (result[noteKey] && entry.parents) {
      for (const parentKey of entry.parents) {
        if (parentKey.startsWith(PAGE_PREFIX) && result[parentKey]) {
          const parentPage = result[parentKey];
          const children = [...(parentPage.children || [])];
          if (!children.includes(noteKey)) {
            children.push(noteKey);
            result[parentKey] = { ...parentPage, children };
          }
        }
      }
    }
  }

  // Post-loop: prune parent-index entries for URLs whose pages exist in scope
  const pIdx = result['list:index/parent'];
  if (pIdx && pIdx.index) {
    let pruned = false;
    const index = { ...pIdx.index };
    for (const url of Object.keys(index)) {
      const pageKey = PAGE_PREFIX + generateSlugFromUrl(url);
      if (result[pageKey] !== undefined && result[pageKey] !== null) {
        delete index[url];
        pruned = true;
      }
    }
    if (pruned) result['list:index/parent'] = { ...pIdx, index };
  }

  // Post-loop: resolve URL references in parents/children to page:slug keys when page exists in scope
  for (const [key, entity] of Object.entries(result)) {
    if (!key.startsWith(PAGE_PREFIX) || !entity) continue;
    let updated = entity;
    for (const field of ['parents', 'children']) {
      if (!updated[field] || updated[field].length === 0) continue;
      let changed = false;
      const resolved = updated[field].map(ref => {
        if (typeof ref !== 'string' || !ref.startsWith('http')) return ref;
        const refSlug = generateSlugFromUrl(ref);
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
  if (key === 'list:index/parent') return applyLogToParentIndex(entity, entry);
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
 *   - page: unified visit + attention + capture (url, title, referrer, scrollDepth, timeOnPage, mdPath, htmlPath)
 *     - On parent page (referrer slug match): accumulate child URL in children[]
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
    // Parent-side: if this page's referrer matches this page, accumulate child URL
    if (entry.referrer && page.slug !== undefined) {
      const referrerSlug = generateSlugFromUrl(entry.referrer);
      if (referrerSlug === page.slug && entrySlug !== page.slug) {
        const updated = { ...page };
        const children = [...(updated.children || [])];
        const childRef = entry.url;
        if (!children.some(c => typeof c === 'string' ? (c === entry.url || c === entrySlug || c === PAGE_PREFIX + entrySlug) : c.url === entry.url)) {
          children.push(entry.url);
          if (children.length > REFERRER_CAP) children.shift();
        }
        updated.children = children;
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
    updated.timestamp = entry.timestamp;

    // visitDates (only when url present = visit entry)
    if (entry.url) {
      const d = new Date(entry.timestamp);
      const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      if (!updated.visitDates) updated.visitDates = [];
      else updated.visitDates = [...updated.visitDates];
      if (!updated.visitDates.includes(yyyymmdd)) updated.visitDates.push(yyyymmdd);
    }

    // Parents from referrer (store as page:slug keys)
    if (entry.referrer) {
      const parentSlug = generateSlugFromUrl(entry.referrer);
      const parentKey = PAGE_PREFIX + parentSlug;
      const parents = [...(updated.parents || [])];
      const already = parents.some(p =>
        typeof p === 'string' ? (p === entry.referrer || p === parentSlug || p === parentKey) : p.url === entry.referrer
      );
      if (!already) {
        parents.push(entry.referrer);
        if (parents.length > REFERRER_CAP) parents.shift();
      }
      updated.parents = parents;
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
 *   - note: create/update note (quote, note text, cssPath, parents, children)
 * Returns new note object (or original if entry is irrelevant).
 */
export function applyLogToNote(noteEntity, entry) {
  if (entry.action !== 'note') return noteEntity;
  if (entry.slug !== noteEntity.slug) return noteEntity;

  const updated = { ...noteEntity };
  if (entry.quote !== undefined) updated.quote = entry.quote;
  if (entry.note !== undefined) updated.note = entry.note;
  if (entry.cssPath !== undefined) updated.cssPath = entry.cssPath;
  if (entry.parents !== undefined) updated.parents = entry.parents;
  if (entry.children !== undefined) updated.children = entry.children;
  updated.timestamp = entry.timestamp;
  return updated;
}

/**
 * Apply a log entry to a list entity (self-describing file).
 * Entity: { timestamp, id, name, qbTrees, pins: [...] }
 * Handles:
 *   - list (id="{listId}", op=add/del/clear): granular pin operations (URLs only)
 *   - list_meta (id="{listId}"): list metadata (name, qbTrees)
 *   - del_list (id="{listId}"): mark entity as deleted
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToPins(pinsEntity, entry) {
  if (entry.action === 'list' && entry.id === pinsEntity.id) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    let pins = [...(pinsEntity.pins || [])];

    if (entry.op === 'clear') {
      updated.pins = [];
    } else if (entry.op === 'add' && entry.urls) {
      for (const url of entry.urls) {
        if (!pins.some(p => p.url === url)) {
          pins.push({ url, title: 'Untitled', pinnedAt: entry.timestamp });
        }
      }
      updated.pins = pins;
    } else if (entry.op === 'del' && entry.urls) {
      pins = pins.filter(p => !entry.urls.includes(p.url));
      updated.pins = pins;
    }

    return updated;
  }
  if (entry.action === 'list_meta' && entry.id === pinsEntity.id) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    updated.name = entry.name;
    if (entry.qbTrees !== undefined) updated.qbTrees = entry.qbTrees;
    return updated;
  }
  if (entry.action === 'del_list' && entry.id === pinsEntity.id) {
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
 * Apply a log entry to the parent-index (for non-checkpointed pages).
 * Index: { timestamp, index: { url: [parentSlug, ...] } }
 * Only processes page entries (action='page') that have a referrer.
 * Returns new index (or original if entry is irrelevant).
 */
export function applyLogToParentIndex(parentIndex, entry) {
  if (entry.action !== 'page' || !entry.referrer || !entry.url) return parentIndex;
  const parentSlug = generateSlugFromUrl(entry.referrer);
  const updated = { ...parentIndex };
  const index = { ...updated.index };
  const parents = [...(index[entry.url] || [])];
  if (!parents.includes(parentSlug)) parents.push(parentSlug);
  index[entry.url] = parents;
  updated.index = index;
  updated.timestamp = entry.timestamp;
  return updated;
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
