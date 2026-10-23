import {
  resultRowHtml,
  searchDraftControlHtml,
} from '../../apps/desktop/ui/timeline-elements.js';

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
search.setAttribute('aria-label', 'Search the sample collection');
const clear = document.querySelector('#searchDraftClearBtn');

function render() {
  const query = search.value.trim().toLocaleLowerCase();
  container.innerHTML = samples
    .filter((sample) =>
      `${sample.title} ${sample.url} ${sample.note} ${(sample.listSlugs || []).map((slug) => listNameById.get(slug)).join(' ')}`
        .toLocaleLowerCase()
        .includes(query),
    )
    .map((sample, index) =>
      resultRowHtml(
        sample.title,
        sample.url,
        {
          ...sample,
          timestamps: [Date.UTC(2026, 8, 16, 10 - index)],
          attScore: 5 - index,
          maxAtt: 5,
          matchSources:
            query && sample.note.toLocaleLowerCase().includes(query)
              ? new Set(['note'])
              : undefined,
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
  if (!container.children.length)
    container.textContent =
      'No pages found in this sample. Try “garden”, “lemon”, or “small web”.';
  // Result cards are real product markup. Details and navigation are outside
  // this focused search demonstration; disable those controls explicitly.
  for (const item of container.querySelectorAll('.result-item'))
    item.draggable = false;
  for (const button of container.querySelectorAll('button'))
    button.disabled = true;
}
search.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') render();
});
search.addEventListener('input', () => {
  clear.classList.toggle('visible', Boolean(search.value));
  if (!search.value) render();
});
clear.addEventListener('click', () => {
  search.value = '';
  clear.classList.remove('visible');
  render();
  search.focus();
});
document
  .querySelector('#exploreBtn')
  .addEventListener('click', () => clear.click());
document
  .querySelector('#highlightsHistoryBtn')
  .addEventListener('click', () => {
    parent.postMessage({ type: 'show-highlight' }, location.origin);
  });
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
render();
