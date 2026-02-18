// replay.js — pure functions for applying log entries to entity state.
// Imported by both background.js (cache-miss replay) and offscreen.js (checkpoint).
// Each function is idempotent — safe to replay the same entry twice.

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
 *   - Visit (no action): update url, title, attention, timestamp; append referrer
 *   - highlight: push to highlights
 *   - unhighlight: remove by matchTimestamp
 *   - highlights_replace: replace highlights array
 *   - capture: update mdPath/htmlPath references
 * Returns new atom object (or original if entry is irrelevant).
 */
export function applyLogToAtom(atom, entry) {
  // Visit entry (no action field) — must match by slug
  if (!entry.action) {
    if (entry.slug !== atom.slug && atom.slug !== undefined) return atom;
    const updated = { ...atom };
    updated.url = entry.url;
    updated.title = entry.title;
    if (entry.attention !== undefined) updated.attention = entry.attention;
    updated.timestamp = entry.timestamp;
    if (entry.referrer) {
      const referrers = [...(updated.referrers || [])];
      if (!referrers.includes(entry.referrer)) {
        referrers.push(entry.referrer);
        if (referrers.length > REFERRER_CAP) referrers.shift();
      }
      updated.referrers = referrers;
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
 * Apply a log entry to a permanent-deletes entity.
 * Entity: { timestamp, urls: [...] }
 * Entry: { timestamp, action: 'deletes_replace', urls: [...] }
 * Returns new entity (or original if entry is irrelevant).
 */
export function applyLogToDeletes(deletesEntity, entry) {
  if (entry.action !== 'deletes_replace') return deletesEntity;
  return { timestamp: entry.timestamp, urls: entry.urls };
}
