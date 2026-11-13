import {
  timelinePages as samples,
  listPages as listSamples,
} from '../../packages/demo/collection.js';
import {
  resultRowHtml,
  searchDraftControlHtml,
} from '../../apps/desktop/ui/timeline-elements.js';
import { justifyBookParagraph } from '../../apps/desktop/ui/book-typesetting.js';

const tr = (_key, fallback) => fallback;
window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== parent ||
    event.data?.type !== 'desktop-style'
  )
    return;
  const style = event.data.style;
  if (style === 'mono')
    document.documentElement.setAttribute('data-color-scheme', 'mono');
  else if (style === 'amber')
    document.documentElement.removeAttribute('data-color-scheme');
});
const listNameById = new Map(
  Array.from(document.querySelectorAll('#listsList .sidebar-item'), (item) => [
    item.dataset.listId,
    item.querySelector('.label').textContent,
  ]),
);
for (const item of document.querySelectorAll('#listsList .sidebar-item')) {
  const count = listSamples.filter((sample) =>
    sample.listSlugs?.includes(item.dataset.listId),
  ).length;
  item.querySelector('.pin-count').textContent = String(count);
}
const cardDataByUrl = new Map();
const container = document.querySelector('#results');
const listContainer = document.createElement('div');
listContainer.id = 'demoList';
listContainer.className = 'results-container';
listContainer.hidden = true;
document.querySelector('.main').appendChild(listContainer);
document.querySelector('#demoSearch').innerHTML = searchDraftControlHtml(
  'Search...',
  tr,
);
const search = document.querySelector('#searchDraftInput');
search.readOnly = true;
search.setAttribute('aria-label', 'Timeline search preview');
document.querySelector('#demoSearch').inert = true;

function renderResults(target, pages, listId = null) {
  target.innerHTML =
    pages
      .map((sample, index) =>
        resultRowHtml(
          sample.title,
          sample.url,
          {
            ...sample,
            excludeListId: listId,
            timestamps: [Date.UTC(2026, 8, 16, 10 - index)],
            attScore: 5 - index,
            maxAtt: 5,
          },
          {
            tr,
            listNameById,
            cardDataByUrl,
            formatTime: (timestamp) =>
              new Date(timestamp).toLocaleTimeString('en', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'UTC',
              }),
            deleteIcon: '',
          },
        ),
      )
      .join('') || '<div class="no-results">No pinned pages</div>';
  for (const item of target.querySelectorAll('.result-item')) {
    item.draggable = false;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-pressed', 'false');
  }
  for (const button of target.querySelectorAll('button')) {
    button.disabled = true;
    button.setAttribute('aria-hidden', 'true');
  }
  selectionAnchors.delete(target);
}

// Match the desktop's click, toggle, and range selection. The production
// .result-row.selected rule supplies the visual highlight.
const selectionAnchors = new WeakMap();
function selectRow(row, event) {
  const target = row.closest('.results-container');
  const rows = [...target.querySelectorAll('.result-row')];
  let selectionAnchor = selectionAnchors.get(target);
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey && selectionAnchor) {
    const from = rows.indexOf(selectionAnchor);
    const to = rows.indexOf(row);
    if (!additive) rows.forEach((item) => item.classList.remove('selected'));
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++)
      rows[i].classList.add('selected');
  } else if (additive) {
    row.classList.toggle('selected');
    selectionAnchor = row;
  } else {
    const toggleOff =
      row.classList.contains('selected') &&
      rows.filter((item) => item.classList.contains('selected')).length === 1;
    rows.forEach((item) => item.classList.remove('selected'));
    row.classList.toggle('selected', !toggleOff);
    selectionAnchor = toggleOff ? null : row;
  }
  selectionAnchors.set(target, selectionAnchor);
  for (const item of target.querySelectorAll('.result-item'))
    item.setAttribute(
      'aria-pressed',
      String(item.querySelector('.result-row').classList.contains('selected')),
    );
}
renderResults(container, samples);
for (const target of [container, listContainer]) {
  target.addEventListener('click', (event) => {
    if (event.target.closest('.att-ctrl, .card-actions')) return;
    const row = event.target
      .closest('.result-item')
      ?.querySelector('.result-row');
    if (row) selectRow(row, event);
  });
  target.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target
      .closest('.result-item')
      ?.querySelector('.result-row');
    if (!row) return;
    event.preventDefault();
    selectRow(row, event);
  });
}

const bookTypesetting = new Map();
function typesetBook() {
  for (const paragraph of document.querySelectorAll(
    '#demoBook .detail-note-excerpt, #demoBook .detail-note-content',
  )) {
    const existing = bookTypesetting.get(paragraph);
    if (existing) {
      existing.refresh();
      continue;
    }
    const controller = justifyBookParagraph(
      paragraph,
      (_skippedParagraph, reason) =>
        console.debug('Book text kept native layout:', reason),
    );
    bookTypesetting.set(paragraph, controller);
    controller.ready.catch((error) =>
      console.error('Failed to finish Book text layout', error),
    );
  }
}

function showView({ book = false, listId = null } = {}) {
  const isList = listId !== null;
  let title;
  if (isList) title = listNameById.get(listId);
  else if (book) title = 'Book';
  else title = 'Timeline';
  if (!title) throw new Error(`Unknown sample list: ${listId}`);
  if (isList)
    renderResults(
      listContainer,
      listSamples.filter((sample) => sample.listSlugs?.includes(listId)),
      listId,
    );
  document.querySelector('#mainTitle').textContent = title;
  search.setAttribute('aria-label', `${title} search preview`);
  document
    .querySelector('#exploreBtn')
    .classList.toggle('active', !book && !isList);
  document
    .querySelector('#highlightsHistoryBtn')
    .classList.toggle('active', book);
  document.querySelector('.search-filters-panel').hidden = book;
  document.querySelector('#resultsWrapper').hidden = book || isList;
  document.querySelector('#demoBook').hidden = !book;
  listContainer.hidden = !isList;
  for (const item of document.querySelectorAll('#listsList .sidebar-item')) {
    const active = item.dataset.listId === listId;
    item.classList.toggle('active', active);
    item.querySelector('.label').setAttribute('aria-pressed', String(active));
  }
  document.querySelector('.sidebar').classList.remove('sidebar-open');
  if (book) typesetBook();
}
showView();
document
  .querySelector('#exploreBtn')
  .addEventListener('click', () => showView());
document
  .querySelector('#highlightsHistoryBtn')
  .addEventListener('click', () => showView({ book: true }));
document
  .querySelector('#sidebarToggle')
  .addEventListener('click', () =>
    document.querySelector('.sidebar').classList.toggle('sidebar-open'),
  );
document
  .querySelector('#sidebarOverlay')
  .addEventListener('click', () =>
    document.querySelector('.sidebar').classList.remove('sidebar-open'),
  );

document.querySelector('#listsList').addEventListener('click', (event) => {
  const toggle = event.target.closest('.fold-toggle');
  if (!toggle) {
    const item = event.target.closest('.sidebar-item');
    if (item) showView({ listId: item.dataset.listId });
    return;
  }
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.closest('.sidebar-item').nextElementSibling.hidden = !expanded;
  toggle.classList.toggle('expanded', expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.title = expanded ? 'Collapse' : 'Expand';
  toggle.setAttribute('aria-label', toggle.title);
});
for (const label of document.querySelectorAll('#listsList .label')) {
  label.tabIndex = 0;
  label.setAttribute('role', 'button');
}
document.querySelector('#listsList').addEventListener('keydown', (event) => {
  if (
    (event.key !== 'Enter' && event.key !== ' ') ||
    !event.target.matches('.label')
  )
    return;
  event.preventDefault();
  showView({ listId: event.target.closest('.sidebar-item').dataset.listId });
});
