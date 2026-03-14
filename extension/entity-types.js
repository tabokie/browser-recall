// entity-types.js — pure functions for entity type display.
// Importable by options.js (ES module).

export function entityTypeLabel(key) {
  if (key.startsWith('snapshot:')) return 'Snapshot';
  if (key.startsWith('note:')) return 'Note';
  if (key.startsWith('list:')) return 'List';
  if (key.startsWith('page:')) return 'Page';
  return 'Unknown';
}
