import { listChipHtml } from '../../apps/extension/popup-list-elements.js';

document.body.classList.add('popup-compact');
const lists = [
  { slug: 'small-web', name: 'Small web', containsPage: true },
  { slug: 'weekend-reading', name: 'Weekend reading', containsPage: true },
  { slug: 'design-details', name: 'Design details', containsPage: false },
];
const container = document.querySelector('#listChips');
container.innerHTML = lists.map(listChipHtml).join('');
function update() {
  for (const [index, chip] of [...container.children].entries()) {
    chip.classList.toggle('selected', lists[index].containsPage);
    chip.setAttribute('aria-pressed', String(lists[index].containsPage));
  }
  const count = lists.filter((list) => list.containsPage).length;
  document.querySelector('#listCount').textContent = String(count).padStart(
    2,
    '0',
  );
  parent.postMessage({ type: 'list-status', count }, location.origin);
  reportHeight();
}
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
      type: 'list-height',
      height: document.body.getBoundingClientRect().height,
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
