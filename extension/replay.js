// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';

const REFERRER_CAP = 50;

/**
 * Return the set of atom slugs that an entry affects.
 * A visit entry with a referrer affects both its own slug (child-side: parents, visitDates)
 * and the referrer's slug (parent-side: children accumulation).
 * All other entry types affect only the entry's own slug.
 */
export function getAffectedSlugs(entry) {
  const slugs = new Set();
  const entrySlug = entry.slug || (entry.url ? generateSlugFromUrl(entry.url) : null);
  if (entrySlug) slugs.add(entrySlug);

  // Visit entries with referrers also affect the parent atom
  if (!entry.action && entry.referrer) {
    const parentSlug = generateSlugFromUrl(entry.referrer);
    if (parentSlug && parentSlug !== entrySlug) slugs.add(parentSlug);
  }

  return slugs;
}

// ---------------------------------------------------------------------------
// Unified replay interface: scopeOf + applyTo
// ---------------------------------------------------------------------------

const ATOM_PREFIX = 'atom:';

/**
 * Return the set of entity keys that an entry affects.
 * Keys use prefixed namespaces:
 *   atom:{slug}              — page atom checkpoints
 *   settings                 — global settings
 *   list:user/{collectionId} — collection entity
 *   list:recycle-bin         — recycle bin
 *   list:permanent-deletes   — permanent deletes
 *   index:parent-index       — parent-index for non-checkpointed pages
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

  // Atom-affecting entries (visit, highlight, capture, create_checkpoint, report, etc.)
  for (const slug of getAffectedSlugs(entry)) {
    scope[`${ATOM_PREFIX}${slug}`] = null;
  }

  // Visit entries with referrer also affect parent-index
  if (!entry.action && entry.referrer) {
    scope['index:parent-index'] = null;
  }

  // create_checkpoint may need to absorb parent-index entries into new atom
  if (entry.action === 'create_checkpoint') {
    scope['index:parent-index'] = null;
  }

  return scope;
}

/**
 * Default empty entity for a given key. Used when creating entities from null.
 */
export function defaultEntity(key) {
  if (key.startsWith(ATOM_PREFIX)) {
    const slug = key.slice(ATOM_PREFIX.length);
    return { slug, timestamp: 0, highlights: [], parents: [], children: [] };
  }
  if (key === 'settings') return { timestamp: 0 };
  if (key.startsWith('list:user/')) {
    const id = key.slice('list:user/'.length);
    return { timestamp: 0, id, name: '', query: '', qbTree: null, pins: [] };
  }
  if (key === 'list:recycle-bin') return { timestamp: 0, items: [] };
  if (key === 'list:permanent-deletes') return { timestamp: 0, urls: [] };
  if (key === 'index:parent-index') return { timestamp: 0, index: {} };
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
 *   - atom keys: only create_checkpoint can create from null
 *   - all other keys: create from defaultEntity on first write
 * Returns new scope object with updated entities.
 */
export function applyTo(entry, scope) {
  const result = {};
  for (const [key, entity] of Object.entries(scope)) {
    if (entity === null) {
      // Atom: only create_checkpoint can create from null
      if (key.startsWith(ATOM_PREFIX)) {
        if (entry.action === 'create_checkpoint') {
          result[key] = applyLogToAtom(defaultEntity(key), entry);
        } else {
          result[key] = null;
        }
        continue;
      }
      // Non-atom: create default entity and apply
      result[key] = applyEntry(key, defaultEntity(key), entry);
      continue;
    }
    result[key] = applyEntry(key, entity, entry);
  }

  // Cross-entity: when create_checkpoint creates atom from null, absorb parent-index entries
  if (entry.action === 'create_checkpoint' && entry.url) {
    const slug = generateSlugFromUrl(entry.url);
    const atomKey = `${ATOM_PREFIX}${slug}`;
    const atom = result[atomKey];
    const pIdx = result['index:parent-index'];
    if (atom && pIdx && pIdx.index && pIdx.index[entry.url]) {
      const parentSlugs = pIdx.index[entry.url];
      if (parentSlugs.length > 0) {
        // Absorb into atom.parents (slugs)
        const updated = { ...atom };
        const parents = [...(updated.parents || [])];
        for (const ps of parentSlugs) {
          if (!parents.includes(ps)) parents.push(ps);
        }
        updated.parents = parents;
        result[atomKey] = updated;
        // Remove absorbed entry from parent-index
        const updatedIdx = { ...pIdx, index: { ...pIdx.index } };
        delete updatedIdx.index[entry.url];
        result['index:parent-index'] = updatedIdx;
      }
    }
  }

  return result;
}

function applyEntry(key, entity, entry) {
  if (key.startsWith(ATOM_PREFIX)) return applyLogToAtom(entity, entry);
  if (key === 'settings') return applyLogToSettings(entity, entry);
  if (key.startsWith('list:user/')) return applyLogToPins(entity, entry);
  if (key === 'list:recycle-bin') return applyLogToRecycleBin(entity, entry);
  if (key === 'list:permanent-deletes') return applyLogToDeletes(entity, entry);
  if (key === 'index:parent-index') return applyLogToParentIndex(entity, entry);
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
 * Apply a log entry to an atom.
 * Handles:
 *   - create_checkpoint: create/update atom watermark
 *   - Visit (no action): update url, title, timestamp; append parent slug
 *     - On parent atom (referrer slug match): accumulate child URL in children[]
 *   - report: accumulate incremental attention (max scrollDepth, sum timeOnPage)
 *   - highlight: push to highlights
 *   - unhighlight: remove by matchTimestamp
 *   - highlights_replace: replace highlights array
 *   - capture: update mdPath/htmlPath references
 * Returns new atom object (or original if entry is irrelevant).
 */
export function applyLogToAtom(atom, entry) {
  // Derive slug from entry URL (slug field removed from log entries)
  const entrySlug = entry.url ? generateSlugFromUrl(entry.url) : null;

  // create_checkpoint: passthrough that creates/updates atom watermark
  if (entry.action === 'create_checkpoint') {
    if (entrySlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    if (!updated.url && entry.url) updated.url = entry.url;
    if (!updated.title && entry.title) updated.title = entry.title;
    updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
    return updated;
  }

  // Visit entry (no action field)
  if (!entry.action) {
    // Parent-side: if this visit's referrer matches this atom, accumulate child URL
    if (entry.referrer && atom.slug !== undefined) {
      const referrerSlug = generateSlugFromUrl(entry.referrer);
      if (referrerSlug === atom.slug && entrySlug !== atom.slug) {
        const updated = { ...atom };
        const children = [...(updated.children || [])];
        if (!children.some(c => typeof c === 'string' ? c === entry.url : c.url === entry.url)) {
          children.push(entry.url);
          if (children.length > REFERRER_CAP) children.shift();
        }
        updated.children = children;
        updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
        return updated;
      }
    }

    // Child-side: must match by slug derived from URL
    if (entrySlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    updated.url = entry.url;
    updated.title = entry.title;
    // Visit entries no longer carry attention data
    updated.timestamp = entry.timestamp;
    // Accumulate visitDates (YYYYMMDD integers)
    const d = new Date(entry.timestamp);
    const yyyymmdd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    if (!updated.visitDates) updated.visitDates = [];
    else updated.visitDates = [...updated.visitDates];
    if (!updated.visitDates.includes(yyyymmdd)) updated.visitDates.push(yyyymmdd);
    if (entry.referrer) {
      const parentSlug = generateSlugFromUrl(entry.referrer);
      const parents = [...(updated.parents || [])];
      const already = parents.some(p =>
        typeof p === 'string' ? (p === entry.referrer || p === parentSlug) : p.url === entry.referrer
      );
      if (!already) {
        parents.push(entry.referrer);
        if (parents.length > REFERRER_CAP) parents.shift();
      }
      updated.parents = parents;
    }
    // mdPath removed: only capture action should set mdPath
    return updated;
  }

  // Report entry (action=report) — accumulates incremental attention
  if (entry.action === 'report') {
    if (entrySlug !== atom.slug && atom.slug !== undefined) return atom;
    // Idempotency: skip if already applied (entry timestamp <= atom timestamp)
    if (entry.timestamp <= (atom.timestamp || 0)) return atom;

    const updated = { ...atom };

    // Parse existing attention or initialize
    let att = { scrollDepth: 0, timeOnPage: 0 };
    if (updated.attention && updated.attention !== '') {
      try {
        att = JSON.parse(updated.attention);
      } catch {}
    }

    // Accumulate: max scrollDepth, sum timeOnPage
    if (entry.scrollDepth !== undefined) {
      att.scrollDepth = Math.max(att.scrollDepth || 0, entry.scrollDepth);
    }
    if (entry.timeOnPage !== undefined) {
      att.timeOnPage = (att.timeOnPage || 0) + entry.timeOnPage;
    }

    updated.attention = JSON.stringify(att);
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'highlight') {
    // Support both old logs (entry.slug) and new logs (derive from entry.url)
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    const hl = [...(updated.highlights || [])];
    if (entry.highlight.isGlobalNote) {
      const idx = hl.findIndex(h => h.isGlobalNote);
      if (idx >= 0) hl[idx] = entry.highlight;
      else hl.unshift(entry.highlight);
    } else {
      hl.push(entry.highlight);
    }
    updated.highlights = hl;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'unhighlight') {
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    let hl = [...(updated.highlights || [])];
    hl = hl.filter(h => h.timestamp !== entry.matchTimestamp);
    updated.highlights = hl;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'highlights_replace') {
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    updated.highlights = entry.highlights;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'capture') {
    const matchSlug = entrySlug || entry.slug;
    if (matchSlug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    if (entry.mdPath) updated.mdPath = entry.mdPath;
    if (entry.htmlPath) updated.htmlPath = entry.htmlPath;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  return atom;
}

/**
 * Apply a log entry to a collection entity (self-describing file).
 * Entity: { timestamp, id, name, query, qbTree, pins: [...] }
 * Handles:
 *   - list (id="user/{collectionId}", op=add/del/clear): granular pin operations (URLs only)
 *   - list_meta (id="user/{collectionId}"): collection metadata (name, query, qbTree)
 *   - del_list (id="user/{collectionId}"): mark entity as deleted
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToPins(pinsEntity, entry) {
  if (entry.action === 'list' && entry.id === `user/${pinsEntity.id}`) {
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
  if (entry.action === 'list_meta' && entry.id === `user/${pinsEntity.id}`) {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    if (entry.name !== undefined) updated.name = entry.name;
    if (entry.query !== undefined) updated.query = entry.query;
    if (entry.qbTree !== undefined) updated.qbTree = entry.qbTree;
    return updated;
  }
  if (entry.action === 'del_list' && entry.id === `user/${pinsEntity.id}`) {
    return { timestamp: entry.timestamp, deleted: true };
  }
  return pinsEntity;
}

/**
 * Apply a log entry to a recycle-bin entity.
 * Entity: { timestamp, items: [...] }
 * Entry: { timestamp, action: 'list', id: 'recycle-bin', op: 'add'|'del'|'clear', urls: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToRecycleBin(recycleBinEntity, entry) {
  if (entry.action !== 'list' || entry.id !== 'recycle-bin') return recycleBinEntity;

  const updated = { timestamp: entry.timestamp };
  let items = [...(recycleBinEntity.items || [])];

  if (entry.op === 'clear') {
    updated.items = [];
  } else if (entry.op === 'add' && entry.urls) {
    for (const url of entry.urls) {
      if (!items.some(item => item.url === url)) {
        items.push({ url, title: 'Untitled', deletedAt: entry.timestamp });
      }
    }
    updated.items = items;
  } else if (entry.op === 'del' && entry.urls) {
    items = items.filter(item => !entry.urls.includes(item.url));
    updated.items = items;
  } else {
    updated.items = items;
  }

  return updated;
}

/**
 * Apply a log entry to the parent-index (for non-checkpointed pages).
 * Index: { timestamp, index: { url: [parentSlug, ...] } }
 * Only processes visit entries (no action) that have a referrer.
 * Returns new index (or original if entry is irrelevant).
 */
export function applyLogToParentIndex(parentIndex, entry) {
  if (entry.action || !entry.referrer || !entry.url) return parentIndex;
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
 * Entity: { timestamp, urls: [...] }
 * Entry: { timestamp, action: 'list', id: 'permanent-deletes', op: 'add'|'del'|'clear', urls: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToDeletes(deletesEntity, entry) {
  if (entry.action !== 'list' || entry.id !== 'permanent-deletes') return deletesEntity;

  const updated = { timestamp: entry.timestamp };
  let urls = [...(deletesEntity.urls || [])];

  if (entry.op === 'clear') {
    updated.urls = [];
  } else if (entry.op === 'add' && entry.urls) {
    for (const url of entry.urls) {
      if (!urls.includes(url)) {
        urls.push(url);
      }
    }
    updated.urls = urls;
  } else if (entry.op === 'del' && entry.urls) {
    urls = urls.filter(u => !entry.urls.includes(u));
    updated.urls = urls;
  } else {
    updated.urls = urls;
  }

  return updated;
}
