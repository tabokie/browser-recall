const tabs = [...document.querySelectorAll('[role="tab"]')];
document.querySelector('.demo-tabs').hidden = false;
document.querySelector('#demo-fallback').hidden = true;
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const caption = document.querySelector('#demo-caption');

function selectTab(selectedTab) {
  for (const tab of tabs) {
    const selected = tab === selectedTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.id !== selectedTab.getAttribute('aria-controls');
  }
  caption.hidden = selectedTab.dataset.tab !== 'find';
  if (selectedTab.dataset.tab === 'organize') {
    document
      .querySelector('.organize-frame')
      .contentWindow.postMessage({ type: 'measure' }, location.origin);
  }
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

// Frames isolate the unmodified product styles from the marketing page.
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const frames = [...document.querySelectorAll('.product-frame')];
  const frame = frames.find(
    (candidate) => candidate.contentWindow === event.source,
  );
  if (!frame) return;
  if (
    event.data?.type === 'list-height' &&
    frame.classList.contains('organize-frame')
  ) {
    const viewport = frame.parentElement;
    viewport.dataset.height = String(event.data.height);
    sizeProductViewport(viewport);
  }
  if (
    event.data?.type === 'list-status' &&
    frame.classList.contains('organize-frame')
  ) {
    const count = event.data.count;
    document.querySelector('#list-status').textContent = count
      ? `One page, at home in ${count} ${count === 1 ? 'list' : 'lists'}.`
      : 'No lists selected. The page remains in your history.';
  }
});

function sizeProductViewport(target) {
  const container = target.parentElement;
  if (!container.clientWidth || !container.clientHeight) return;
  const frame = target.querySelector('iframe');
  const width = Number(target.dataset.width);
  const height = Number(target.dataset.height);
  const scale = Math.min(
    1,
    container.clientWidth / width,
    container.clientHeight / height,
  );
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${scale})`;
  target.style.width = `${width * scale}px`;
  target.style.height = `${height * scale}px`;
}
const viewportObserver = new ResizeObserver((entries) => {
  for (const { target } of entries)
    sizeProductViewport(target.querySelector('.product-viewport'));
});
for (const viewport of document.querySelectorAll('.product-viewport'))
  viewportObserver.observe(viewport.parentElement);
