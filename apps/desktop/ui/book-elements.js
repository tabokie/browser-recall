import { escapeHtml } from './utils.js';
import { formatHighlightExcerpt } from './highlight-format.js';

export const DETAIL_ICON_EDIT =
  '<svg data-icon="edit" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>';
export const DETAIL_ICON_DELETE =
  '<svg data-icon="delete" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

export function highlightHistoryTextHtml(text) {
  return escapeHtml(text).replace(/\r\n?|\n/g, '<br>\n');
}

export function detailNoteContentHtml(noteText, formatText = escapeHtml) {
  if (!noteText) return '';
  return `<span class="detail-note-content">${formatText(noteText)}</span>`;
}

export function highlightHistoryEntryHtml(
  { note },
  {
    readOnly = false,
    deleteLabel = 'Delete highlight',
    editLabel = 'Edit note',
  } = {},
) {
  const excerpt = formatHighlightExcerpt(note.excerpt);
  const noteBody = detailNoteContentHtml(note.note, highlightHistoryTextHtml);
  const contentClass = note.note
    ? 'highlight-history-content has-note'
    : 'highlight-history-content';
  return `<article class="highlight-history-entry detail-note-entry" data-note-slug="${escapeHtml(note.slug)}">
    <div class="${contentClass}">
      <div class="highlight-history-quote">
        <div class="detail-note-header">
          <div class="detail-note-excerpt">${highlightHistoryTextHtml(excerpt)}</div>
          ${readOnly ? '' : `<button class="detail-note-action-btn delete" title="${escapeHtml(deleteLabel)}">${DETAIL_ICON_DELETE}</button>`}
        </div>
      </div>
      <div class="detail-note-body">
        ${noteBody}
        ${readOnly ? '' : `<button class="detail-note-action-btn edit" title="${escapeHtml(editLabel)}">${DETAIL_ICON_EDIT}</button>`}
      </div>
    </div>
  </article>`;
}

export function formatHighlightHistoryDate(timestamp) {
  const date = new Date(timestamp);
  return [
    String(date.getFullYear()).slice(-2),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

export function highlightHistoryDayHtml(dateLabel, entriesHtml = '') {
  return `<section class="highlight-history-day-section" data-highlight-history-date="${escapeHtml(dateLabel)}">
      <h2 class="highlight-history-date"><span class="highlight-history-date-label">${escapeHtml(dateLabel)}</span></h2>
      <div class="highlight-history-day-entries">${entriesHtml}</div>
    </section>`;
}

export function highlightHistoryPageGroupHtml(
  { page },
  { timeLabel, readOnly = false, entriesHtml = '' },
) {
  const url = new URL(page.url);
  const site =
    url.protocol === 'file:' ? 'file' : url.hostname.replace(/^www\./, '');
  const title = page.user_title || page.title || page.url;
  return `<section class="highlight-history-page-group" data-highlight-history-page-url="${escapeHtml(page.url)}">
      <div class="highlight-history-meta">
    <span class="highlight-history-page-title"${readOnly ? '' : ` data-url="${escapeHtml(page.url)}" role="link" tabindex="0"`}><span class="highlight-history-page-title-label">${escapeHtml(title)}</span></span>
    <span class="highlight-history-site">${escapeHtml(site)}</span>
    <span class="highlight-history-time">${escapeHtml(timeLabel)}</span>
  </div>
      <div class="highlight-history-page-entries">${entriesHtml}</div>
    </section>`;
}
