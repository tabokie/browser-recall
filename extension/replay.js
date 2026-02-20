// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.
import { generateSlugFromUrl } from './utils.js';

const REFERRER_CAP = 50;

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
 *   - ensure_checkpoint: create/update atom watermark
 *   - add_child: accumulate child slugs
 *   - Visit (no action): update url, title, attention, timestamp; append parent slug
 *   - highlight: push to highlights
 *   - unhighlight: remove by matchTimestamp
 *   - highlights_replace: replace highlights array
 *   - capture: update mdPath/htmlPath references
 * Returns new atom object (or original if entry is irrelevant).
 */
export function applyLogToAtom(atom, entry) {
  // ensure_checkpoint: passthrough that creates/updates atom watermark
  if (entry.action === 'ensure_checkpoint') {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    if (!updated.url && entry.url) updated.url = entry.url;
    if (!updated.title && entry.title) updated.title = entry.title;
    updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
    return updated;
  }

  // add_child: accumulate child URLs (drain resolves to slug or {url,title})
  if (entry.action === 'add_child') {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    const children = [...(updated.children || [])];
    const already = children.some(c =>
      typeof c === 'string' ? (c === entry.childUrl || c === entry.childSlug) : c.url === entry.childUrl
    );
    if (!already) {
      children.push(entry.childUrl);
      if (children.length > REFERRER_CAP) children.shift();
    }
    updated.children = children;
    updated.timestamp = Math.max(updated.timestamp || 0, entry.timestamp);
    return updated;
  }

  // Visit entry (no action field) — must match by slug
  if (!entry.action) {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    updated.url = entry.url;
    updated.title = entry.title;
    if (entry.attention !== undefined) updated.attention = entry.attention;
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
    if (entry.mdPath !== undefined) updated.mdPath = entry.mdPath;
    return updated;
  }

  if (entry.action === 'highlight') {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
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
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    let hl = [...(updated.highlights || [])];
    hl = hl.filter(h => h.timestamp !== entry.matchTimestamp);
    updated.highlights = hl;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'highlights_replace') {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    updated.highlights = entry.highlights;
    updated.timestamp = entry.timestamp;
    return updated;
  }

  if (entry.action === 'capture') {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
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
 *   - pins_replace: replace pins array, preserve metadata
 *   - collection_meta: merge metadata fields (name, query, qbTree), preserve pins
 *   - collection_delete: mark entity as deleted
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToPins(pinsEntity, entry) {
  if (entry.action === 'pins_replace') {
    return { ...pinsEntity, timestamp: entry.timestamp, pins: entry.pins };
  }
  if (entry.action === 'collection_meta') {
    const updated = { ...pinsEntity, timestamp: entry.timestamp };
    if (entry.collectionId !== undefined) updated.id = entry.collectionId;
    if (entry.name !== undefined) updated.name = entry.name;
    if (entry.query !== undefined) updated.query = entry.query;
    if (entry.qbTree !== undefined) updated.qbTree = entry.qbTree;
    return updated;
  }
  if (entry.action === 'collection_delete') {
    return { timestamp: entry.timestamp, deleted: true };
  }
  return pinsEntity;
}

/**
 * Apply a log entry to a recycle-bin entity.
 * Entity: { timestamp, items: [...] }
 * Entry: { timestamp, action: 'recycle_replace', items: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToRecycleBin(recycleBinEntity, entry) {
  if (entry.action !== 'recycle_replace') return recycleBinEntity;
  return { timestamp: entry.timestamp, items: entry.items };
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
 * Entry: { timestamp, action: 'deletes_replace', urls: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToDeletes(deletesEntity, entry) {
  if (entry.action !== 'deletes_replace') return deletesEntity;
  return { timestamp: entry.timestamp, urls: entry.urls };
}
