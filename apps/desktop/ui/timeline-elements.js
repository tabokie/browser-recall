// Presentation shared by the desktop Timeline and the product website demo.
import { escapeHtml, collectVisitDateKeys } from './utils.js';

function attentionLevel(normalized) {
  if (!normalized || normalized <= 0) return '';
  if (normalized >= 0.75) return 'high';
  if (normalized >= 0.4) return 'med';
  return 'low';
}

export function resultRowHtml(
  title,
  url,
  opts,
  { formatTime, listNameById, cardDataByUrl, tr, deleteIcon },
) {
  if (typeof url !== 'string' || !url) {
    throw new Error('Result rows require a non-empty URL');
  }
  const safeUrl = escapeHtml(url);
  const {
    pinned,
    deletable = false,
    attScore = 0,
    maxAtt = 1,
    attDetail = null,
    notes = [],
    timestamps = [],
    visitDates = [],
    context = 'global',
    pinnedAt,
    pinSource,
    cssClass,
    hasSnapshots = false,
    listSlugs = [],
    excludeListId,
    likes = 0,
    matchSources,
    hasHighlightNotes,
  } = opts;

  const lastVisit =
    timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;

  const parsed = new URL(url);
  const site =
    parsed.protocol === 'file:'
      ? 'file'
      : parsed.hostname.replace(/^www\./, '');

  const safeTitle = escapeHtml(title || site || url);

  const dates = collectVisitDateKeys({ visitDates, timestamps }).join(',');

  const hasNotes = hasHighlightNotes === true;
  const hasSnaps = hasSnapshots;
  const belongedListNames = [];
  for (const listSlug of listSlugs) {
    if (listSlug.startsWith('system/')) continue;
    if (excludeListId && listSlug === excludeListId) continue;
    const name = listNameById.get(listSlug);
    if (name) belongedListNames.push(name);
  }
  const attLvl = attentionLevel(normalized);
  if (url)
    cardDataByUrl.set(url, {
      attDetail: attDetail
        ? {
            timeOnPage: attDetail.timeOnPage,
            scrollDepth: attDetail.scrollDepth,
            clicks: attDetail.clicks,
          }
        : null,
      timestamps,
    });
  const attCtrlHtml = `<div class="att-ctrl${attLvl ? ' ' + attLvl : ''}" data-url="${safeUrl}" data-title="${safeTitle}"><span class="att-ctrl-dot"></span><button class="att-ctrl-btn" title="${escapeHtml(tr('desktopViewDetails', 'View details'))}"><span class="att-ctrl-icon" aria-hidden="true">⋯</span></button></div>`;
  const listTagsHtml = belongedListNames
    .map((n) => `<span class="card-tag card-tag-list">${escapeHtml(n)}</span>`)
    .join('');
  const isLiked = likes > 0;
  const isAuto = pinSource === 'auto';
  const matchNoteHit = matchSources && matchSources.has('note');
  const matchSnapHit = matchSources && matchSources.has('snapshot');
  const hasExtras =
    hasNotes ||
    hasSnaps ||
    isLiked ||
    isAuto ||
    listTagsHtml ||
    matchNoteHit ||
    matchSnapHit;
  const extrasHtml = hasExtras
    ? `<div class="card-extras">${isAuto ? `<span class="card-tag card-tag-auto">${escapeHtml(tr('desktopAutoTag', 'auto'))}</span>` : ''}${isLiked ? `<span class="card-tag card-tag-liked">${escapeHtml(tr('desktopLikedTag', 'liked'))}</span>` : ''}${hasNotes ? `<span class="card-tag card-tag-note">${escapeHtml(tr('desktopNoteTag', 'note'))}</span>` : ''}${hasSnaps ? `<span class="card-tag card-tag-snap">${escapeHtml(tr('desktopSnapshotTag', 'snapshot'))}</span>` : ''}${matchNoteHit ? `<span class="card-tag card-tag-match-note">${escapeHtml(tr('desktopMatchedInNoteTag', 'matched in note'))}</span>` : ''}${matchSnapHit ? `<span class="card-tag card-tag-match-snap">${escapeHtml(tr('desktopMatchedInSnapshotTag', 'matched in snapshot'))}</span>` : ''}${listTagsHtml}</div>`
    : '';
  const cardActionsHtml = deletable
    ? `<div class="card-actions"><button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="${escapeHtml(tr('commonDelete', 'Delete'))}">${deleteIcon}</button></div>`
    : '';

  return `<div class="result-item${cssClass ? ' ' + cssClass : ''}" draggable="true">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" data-dates="${dates}">
      <div class="card-row">
        <div class="result-title">${safeTitle}</div>
        <span class="result-site">${escapeHtml(site)}</span>
        <span class="result-time">${escapeHtml(lastVisit)}</span>
        ${attCtrlHtml}
      </div>
      ${cardActionsHtml}
    </div>
    ${extrasHtml}
  </div>`;
}

export function searchDraftControlHtml(placeholder, tr) {
  const clearSvg =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  return `
    <div class="search-draft-control" id="searchDraftControl">
      <input type="search" class="search-draft-input" id="searchDraftInput" placeholder="${escapeHtml(placeholder)}" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none">
      <svg class="content-search-spinner" id="contentSearchSpinner" viewBox="0 0 100 34" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="98" height="32" rx="16"></rect>
      </svg>
      <button class="search-draft-clear" id="searchDraftClearBtn" type="button" title="${escapeHtml(tr('desktopClearSearch', 'Clear search'))}" aria-label="${escapeHtml(tr('desktopClearSearch', 'Clear search'))}">${clearSvg}</button>
    </div>
  `;
}
