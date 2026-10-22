const tabs = [...document.querySelectorAll('[role="tab"]')];
document.querySelector('.demo-tabs').hidden = false;
document.querySelector('#demo-fallback').hidden = true;
for (const control of document.querySelectorAll('#demo-search [disabled]')) {
  control.disabled = false;
}
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const caption = document.querySelector('#demo-caption');
const captions = {
  find: 'Search across titles, URLs, highlights, notes, and saved page text.',
  highlight: 'Keep highlights in context, and collect your thoughts in Book.',
  organize:
    'A page can belong to more than one list. Make room for overlapping interests.',
  snapshot:
    'Save webpage snapshots as local files, and return to the saved copy offline.',
};

function selectTab(selectedTab) {
  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.id !== selectedTab.getAttribute('aria-controls');
  }
  caption.textContent = captions[selectedTab.dataset.tab];
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectTab(tabs[nextIndex]);
    tabs[nextIndex].focus();
  });
}

const searchInput = document.querySelector('#search-input');
const rows = [...document.querySelectorAll('.history-row')];

function searchSamples() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  let count = 0;
  for (const row of rows) {
    row.hidden = !row.dataset.search.toLocaleLowerCase().includes(query);
    if (!row.hidden) count += 1;
  }
  document.querySelector('#results-label').textContent = query
    ? `${count} ${count === 1 ? 'match' : 'matches'} in the sample collection`
    : 'A little of what caught your eye';
  document.querySelector('#empty-results').hidden = count !== 0;
}

document.querySelector('#demo-search').addEventListener('submit', (event) => {
  event.preventDefault();
  searchSamples();
});
searchInput.addEventListener('input', () => {
  if (searchInput.value === '') searchSamples();
});

document.querySelector('#note-form').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#note-status').textContent = document
    .querySelector('#sample-note')
    .value.trim()
    ? 'Note saved in this demo'
    : 'Note cleared in this demo';
});
document.querySelector('#sample-note').addEventListener('input', () => {
  document.querySelector('#note-status').textContent =
    'Unsaved changes · Demo only';
});

const listInputs = [...document.querySelectorAll('[name="sample-list"]')];
for (const input of listInputs) {
  input.addEventListener('change', () => {
    const count = listInputs.filter((checkbox) => checkbox.checked).length;
    document.querySelector('#list-status').textContent = count
      ? `One page, at home in ${count} ${count === 1 ? 'list' : 'lists'}.`
      : 'No lists selected. The page remains in your history.';
  });
}
