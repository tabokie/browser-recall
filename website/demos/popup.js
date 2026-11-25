import { demoLists, featuredPage } from '../../packages/demo/collection.js';
import { listChipHtml } from '../../apps/extension/popup-list-elements.js';
import { snapshotRowHtml } from '../../apps/extension/popup-snapshot-elements.js';
import { sampleNote } from './sample-note.js';

document.body.classList.add('popup-compact');
const extensionSurface = globalThis.browserRecallExtensionSurface;
extensionSurface.installHighlightEntryStyles(document);
const highlightList = document.querySelector('#highlightList');
highlightList.innerHTML = extensionSurface.highlightEntryHtml(sampleNote, {
  deleteTitle: 'Delete highlight',
  editTitle: 'Edit note',
});
for (const button of highlightList.querySelectorAll('button')) {
  button.disabled = true;
}

const lists = demoLists.map(({ slug, name }) => ({
  slug,
  name,
  containsPage: featuredPage.listSlugs.includes(slug),
}));
const container = document.querySelector('#listChips');
container.innerHTML = lists.map(listChipHtml).join('');
let paused = false;
let markupHidden = false;
const markupButton = document.querySelector('#hideMarkupBtn');
const hideMarkupLabel = markupButton.textContent.trim();
markupButton.addEventListener('click', () => {
  markupHidden = !markupHidden;
  markupButton.classList.toggle('is-markup-hidden', markupHidden);
  markupButton.setAttribute('aria-pressed', String(markupHidden));
  markupButton.textContent = markupHidden ? 'Show markup' : hideMarkupLabel;
  reportHeight();
});
const recordingToggle = document.querySelector('#recordingToggle');
const snapshotSection = document.querySelector('#snapshotSection');
const snapshotList = document.querySelector('#snapshotList');
let captureNumber = 0;
document.querySelector('#captureBtn').addEventListener('click', () => {
  // Fictional captures use the sample collection's date and production popup
  // classes. Capturing adds a receipt only; no visitor data is read or stored.
  const timestamp = Date.UTC(2026, 8, 16, 10, ++captureNumber);
  const timeLabel = new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const template = document.createElement('template');
  template.innerHTML = snapshotRowHtml(
    { timestamp, hasMd: true, hasHtml: true },
    {
      timeLabel,
      deleteTitle: 'Delete snapshot',
      canOpen: false,
    },
  );
  const row = template.content.firstElementChild;
  row.querySelector('.delete-btn').addEventListener('click', () => {
    row.remove();
    snapshotSection.classList.toggle('is-empty', !snapshotList.children.length);
    reportHeight();
  });
  snapshotList.prepend(row);
  snapshotSection.classList.remove('is-empty');
  reportHeight();
});
function update() {
  for (const [index, chip] of [...container.children].entries()) {
    chip.classList.toggle('selected', lists[index].containsPage);
    chip.setAttribute('aria-pressed', String(lists[index].containsPage));
  }
  document.querySelector('#listCount').textContent = String(
    lists.filter((list) => list.containsPage).length,
  ).padStart(2, '0');
  document.querySelector('#recordingBar').classList.toggle('is-paused', paused);
  document.querySelector('#dashboardContent').hidden = paused;
  recordingToggle.setAttribute('aria-pressed', String(paused));
  const action = paused ? 'Resume recording' : 'Pause recording';
  recordingToggle.setAttribute('aria-label', action);
  recordingToggle.title = action;
  reportHeight();
}
recordingToggle.addEventListener('click', () => {
  paused = !paused;
  update();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape')
    parent.postMessage({ type: 'popup-close' }, location.origin);
});
container.addEventListener('click', (event) => {
  const chip = event.target.closest('.list-chip');
  if (!chip) return;
  const list = lists.find((item) => item.slug === chip.dataset.listId);
  list.containsPage = !list.containsPage;
  update();
});
container.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    event.target.click();
  }
});
update();
function reportHeight() {
  parent.postMessage(
    {
      type: 'popup-state',
      height: document.body.getBoundingClientRect().height,
      paused,
      markupHidden,
      count: lists.filter((list) => list.containsPage).length,
    },
    location.origin,
  );
}
// Known content changes drive measurement. Observing the body while the parent
// resizes this iframe can cause a ResizeObserver delivery loop in WebKit.
document.fonts.ready.then(reportHeight);
window.addEventListener('message', (event) => {
  if (
    event.origin === location.origin &&
    event.source === parent &&
    event.data?.type === 'measure'
  )
    reportHeight();
});
