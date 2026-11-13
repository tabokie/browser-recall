import { escapeHtml } from './utils.js';

export function sidebarListItemHtml(
  name,
  { hasChildren, expanded = true, readOnly = false, tr },
) {
  const foldTitle = expanded
    ? tr('desktopCollapse', 'Collapse')
    : tr('desktopExpand', 'Expand');
  return `
    ${
      hasChildren
        ? `<button type="button" class="fold-toggle${expanded ? ' expanded' : ''}" title="${escapeHtml(foldTitle)}" aria-label="${escapeHtml(foldTitle)}" aria-expanded="${expanded}"></button>`
        : '<span class="list-leaf-dot" aria-hidden="true"></span>'
    }
    <span class="label">${escapeHtml(name)}</span>
    <span class="pin-count"></span>
    ${readOnly ? '' : `<button class="remove-list" title="${escapeHtml(tr('commonRemove', 'Remove'))}">&times;</button>`}
  `;
}
