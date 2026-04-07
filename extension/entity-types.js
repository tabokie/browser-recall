// entity-types.js — shared entity key vocabulary.
// Importable by any ES module in the extension.

// --- Prefix constants ---
export const PAGE_PREFIX = 'page:';
export const NOTE_PREFIX = 'note:';
export const SNAPSHOT_PREFIX = 'snapshot:';
export const LIST_PREFIX = 'list:';
export const MANIFEST_PREFIX = 'manifest:';

// --- Key constructors ---
export const pageKey = (slug) => PAGE_PREFIX + slug;
export const noteKey = (slug) => NOTE_PREFIX + slug;
export const listKey = (id) => LIST_PREFIX + id;
export const snapshotKey = (stem) => SNAPSHOT_PREFIX + stem;

// --- Key parsing ---
const ALL_PREFIXES = [PAGE_PREFIX, NOTE_PREFIX, SNAPSHOT_PREFIX, LIST_PREFIX, MANIFEST_PREFIX];

export function entityPrefix(key) {
  for (const p of ALL_PREFIXES)
    if (key.startsWith(p)) return p;
  return null;
}

export function entitySlug(key) {
  const p = entityPrefix(key);
  return p ? key.slice(p.length) : key;
}

// --- Helpers ---
export function isSystemList(key) {
  return key.startsWith(LIST_PREFIX + 'system/');
}

// --- Display ---
export function entityTypeLabel(key) {
  if (key.startsWith(SNAPSHOT_PREFIX)) return 'Snapshot';
  if (key.startsWith(NOTE_PREFIX)) return 'Note';
  if (key.startsWith(LIST_PREFIX)) return 'List';
  if (key.startsWith(PAGE_PREFIX)) return 'Page';
  return 'Unknown';
}
