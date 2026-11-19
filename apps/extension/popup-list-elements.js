// Presentation shared by the connector popup and the product website demo.
import { escapeHtml } from './utils.js';

export function listChipHtml(list) {
  return `<span class="list-chip${list.containsPage ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${escapeHtml(list.slug)}">${escapeHtml(list.name)}</span>`;
}

export function layoutListChips(lists, frozenOrder = null) {
  const pinned = lists.filter((list) => list.containsPage);
  const recent = lists
    .filter((list) => !list.containsPage)
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const bySlug = new Map(lists.map((list) => [list.slug, list]));
  // Keep positions for existing chips and always show pinned lists. Fill any
  // remaining slots with the most recently active lists.
  const order = [...(frozenOrder ?? [])];
  const ordered = new Set(order);
  const visible = order.filter((slug) => bySlug.has(slug));
  for (const list of pinned) {
    if (ordered.has(list.slug)) continue;
    order.push(list.slug);
    ordered.add(list.slug);
    visible.push(list.slug);
  }
  for (const list of recent) {
    if (visible.length >= 10) break;
    if (ordered.has(list.slug)) continue;
    order.push(list.slug);
    ordered.add(list.slug);
    visible.push(list.slug);
  }
  return {
    order,
    pinnedCount: pinned.length,
    lists: visible.map((slug) => bySlug.get(slug)),
  };
}
