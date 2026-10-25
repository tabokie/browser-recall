import {
  resultRowHtml,
  searchDraftControlHtml,
} from '../../apps/desktop/ui/timeline-elements.js';
import { justifyBookParagraph } from '../../apps/desktop/ui/book-typesetting.js';

const tr = (_key, fallback) => fallback;
const samples = [
  {
    title: 'A smaller, slower web',
    url: 'https://fieldnotes.example/a-smaller-web',
    note: 'Leave room for the unfinished things.',
    listSlugs: ['small-web'],
    hasHighlightNotes: true,
  },
  {
    title: 'A garden that grows with you',
    url: 'https://leaf.example/garden',
    note: 'Start with one pot and let curiosity take over.',
    hasHighlightNotes: true,
  },
  {
    title: 'Good tools leave room for you',
    url: 'https://workshop.example/good-tools',
    note: 'Quiet places for a personal website.',
    listSlugs: ['design-details'],
  },
  {
    title: 'Lemon and white bean soup',
    url: 'https://table.example/lemon-soup',
    note: 'A squeeze of lemon at the end.',
    listSlugs: ['weekend-reading'],
  },
  {
    title: 'Notes from the old coast path',
    url: 'https://footpath.example/coast-path',
    note: 'The path bends toward the sea.',
    hasSnapshots: true,
  },
];
const listNameById = new Map([
  ['small-web', 'Small web'],
  ['design-details', 'Design details'],
  ['weekend-reading', 'Weekend reading'],
]);
const cardDataByUrl = new Map();
const container = document.querySelector('#results');
document.querySelector('#demoSearch').innerHTML = searchDraftControlHtml(
  'Search...',
  tr,
);
const search = document.querySelector('#searchDraftInput');
search.readOnly = true;
search.setAttribute('aria-label', 'Timeline search preview');
document.querySelector('#demoSearch').inert = true;

container.innerHTML = samples
  .map((sample, index) =>
    resultRowHtml(
      sample.title,
      sample.url,
      {
        ...sample,
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
  .join('');
for (const item of container.querySelectorAll('.result-item'))
  item.draggable = false;
for (const button of container.querySelectorAll('button')) {
  button.disabled = true;
  button.setAttribute('aria-hidden', 'true');
}

// Match the desktop's click, toggle, and range selection. The production
// .result-row.selected rule supplies the visual highlight.
let selectionAnchor = null;
function selectRow(row, event) {
  const rows = [...container.querySelectorAll('.result-row')];
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
  for (const item of container.querySelectorAll('.result-item'))
    item.setAttribute(
      'aria-pressed',
      String(item.querySelector('.result-row').classList.contains('selected')),
    );
}
for (const item of container.querySelectorAll('.result-item')) {
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-pressed', 'false');
}
container.addEventListener('click', (event) => {
  if (event.target.closest('.att-ctrl, .card-actions')) return;
  const row = event.target
    .closest('.result-item')
    ?.querySelector('.result-row');
  if (row) selectRow(row, event);
});
container.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target
    .closest('.result-item')
    ?.querySelector('.result-row');
  if (!row) return;
  event.preventDefault();
  selectRow(row, event);
});

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

function showView(book) {
  document.querySelector('#mainTitle').textContent = book ? 'Book' : 'Timeline';
  document.querySelector('#exploreBtn').classList.toggle('active', !book);
  document
    .querySelector('#highlightsHistoryBtn')
    .classList.toggle('active', book);
  document.querySelector('.search-filters-panel').hidden = book;
  document.querySelector('#resultsWrapper').hidden = book;
  document.querySelector('#demoBook').hidden = !book;
  document.querySelector('.sidebar').classList.remove('sidebar-open');
  if (book) typesetBook();
}
document
  .querySelector('#exploreBtn')
  .addEventListener('click', () => showView(false));
document
  .querySelector('#highlightsHistoryBtn')
  .addEventListener('click', () => showView(true));
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
