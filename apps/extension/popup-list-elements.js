// Presentation shared by the connector popup and the product website demo.
import { escapeHtml } from './utils.js';

export function listChipHtml(list) {
  return `<span class="list-chip${list.containsPage ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${escapeHtml(list.slug)}">${escapeHtml(list.name)}</span>`;
}
