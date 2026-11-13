import { escapeHtml } from './utils.js';

// Shared by the extension popup and the website's fictional capture controls.
export function snapshotRowHtml(
  snapshot,
  { timeLabel, deleteTitle, canOpen = true },
) {
  const openAttributes = canOpen ? ' role="button" tabindex="0"' : '';
  return `
    <div class="snapshot-row"${openAttributes} data-ts="${snapshot.timestamp}">
      <span class="snapshot-time">${escapeHtml(timeLabel)}</span>
      <span class="snapshot-badges">
        ${snapshot.hasMd ? `<span class="badge md" data-ts="${snapshot.timestamp}">Markdown</span>` : ''}
        ${snapshot.hasHtml ? `<span class="badge html" data-ts="${snapshot.timestamp}">HTML</span>` : ''}
        <button class="delete-btn" data-ts="${snapshot.timestamp}" title="${escapeHtml(deleteTitle)}" aria-label="${escapeHtml(deleteTitle)}">&times;</button>
      </span>
    </div>
  `;
}
