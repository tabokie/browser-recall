import { getLocale, onLocaleChange, t } from './locale.js';

const demo = document.querySelector('.finder-demo');
const tree = demo.querySelector('.finder-tree');
tree.setAttribute('aria-busy', 'true');
const preview = demo.querySelector('.finder-quick-look');
const previewButton = demo.querySelector('[data-finder-preview]');
const back = demo.querySelector('[data-finder-back]');
const forward = demo.querySelector('[data-finder-forward]');
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const icon = (folder) =>
  `<svg class="finder-item-icon" aria-hidden="true"><use href="#finder-${folder ? 'folder' : 'document'}"/></svg>`;
const nodes = new Map([
  ['', { path: '', name: 'Browser Recall', children: [] }],
]);
const expanded = new Set([
  'logs',
  'objects',
  'objects/notes',
  'objects/snapshots',
]);
let folder = '',
  selected = '',
  visible = [],
  history = [''],
  historyIndex = 0;
let modified;
let sampleDate;

function addFile(file) {
  let parent = nodes.get('');
  const parts = file.path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const path = parts.slice(0, index + 1).join('/');
    if (!nodes.has(path)) {
      const node = {
        path,
        name: parts[index],
        parent: parent.path,
        ...(index === parts.length - 1
          ? { text: file.text }
          : { children: [] }),
      };
      nodes.set(path, node);
      parent.children.push(node);
    }
    parent = nodes.get(path);
  }
}

function kind(node) {
  if (node.children) return t('folder');
  return (
    { json: 'JSON', jsonl: 'JSONL', html: 'HTML', md: 'Markdown' }[
      node.name.split('.').at(-1)
    ] || t('document')
  );
}

function children(path) {
  return [...nodes.get(path).children].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
}

function selectedRow() {
  return [...tree.querySelectorAll('[role="treeitem"]')].find(
    (row) => row.dataset.path === selected,
  );
}

function updateSelection(focus = false) {
  for (const row of tree.querySelectorAll('[role="treeitem"]')) {
    const active = row.dataset.path === selected;
    row.setAttribute('aria-selected', String(active));
    row.tabIndex = active ? 0 : -1;
  }
  const node = nodes.get(selected);
  previewButton.disabled = !node || !!node.children;
  demo.querySelector('.finder-status').textContent = t(
    node && node.path !== folder ? 'selectedItems' : 'items',
    { count: children(folder).length },
  );
  const path = demo.querySelector('.finder-path');
  path.replaceChildren();
  const parts = (selected || folder).split('/').filter(Boolean);
  for (let index = -1; index < parts.length; index++) {
    const target = index < 0 ? '' : parts.slice(0, index + 1).join('/');
    const item = nodes.get(target);
    if (index >= 0) {
      const separator = document.createElement('span');
      separator.textContent = '›';
      separator.setAttribute('aria-hidden', 'true');
      path.append(separator);
    }
    const label = document.createElement(item.children ? 'button' : 'span');
    label.textContent = item.name;
    label.title = `Browser Recall${target ? `/${target}` : ''}`;
    if (item.children) {
      label.type = 'button';
      label.addEventListener('click', () => navigate(target));
    }
    path.append(label);
  }
  if (focus) {
    selectedRow()?.focus({ preventScroll: true });
    selectedRow()?.scrollIntoView({ block: 'nearest' });
  }
}

function finderRowHtml(node, depth) {
  const open = expanded.has(node.path);
  const active = node.path === selected;
  const path = escape(node.path);
  const expandedAttribute = node.children ? `aria-expanded="${open}"` : '';
  let disclosure = '<span class="finder-disclosure-space"></span>';
  if (node.children) {
    const label = escape(t(open ? 'collapse' : 'expand', { name: node.name }));
    disclosure = `<button class="finder-disclosure" type="button" tabindex="-1" aria-label="${label}">${open ? '⌄' : '›'}</button>`;
  }
  return `<div class="finder-row" role="treeitem" aria-level="${depth + 1}" aria-selected="${active}" ${expandedAttribute} tabindex="${active ? 0 : -1}" data-path="${path}" style="--finder-depth:${depth}">
        <span class="finder-name">${disclosure}${icon(!!node.children)}<span class="finder-filename" title="${path}">${escape(node.name)}</span></span>
        <span class="finder-date">${modified}</span><span class="finder-kind">${kind(node)}</span></div>`;
}

function treeRowsHtml(path, depth = 0) {
  let html = '';
  for (const node of children(path)) {
    visible.push(node.path);
    html += finderRowHtml(node, depth);
    if (node.children && expanded.has(node.path))
      html += treeRowsHtml(node.path, depth + 1);
  }
  return html;
}

function render(focus = false) {
  const scrollTop = tree.scrollTop;
  visible = [];
  tree.innerHTML = treeRowsHtml(folder);
  if (!visible.includes(selected)) selected = visible[0] || folder;
  tree.scrollTop = scrollTop;
  demo.querySelector('.finder-title').textContent = nodes.get(folder).name;
  for (const shortcut of demo.querySelectorAll('[data-finder-folder]')) {
    if (shortcut.dataset.finderFolder === folder)
      shortcut.setAttribute('aria-current', 'page');
    else shortcut.removeAttribute('aria-current');
  }
  back.disabled = historyIndex === 0;
  forward.disabled = historyIndex === history.length - 1;
  updateSelection(focus);
}

function navigate(path, record = true) {
  if (!nodes.get(path)?.children) return;
  folder = path;
  selected = children(path)[0]?.path || path;
  if (record && history[historyIndex] !== path) {
    history = [...history.slice(0, historyIndex + 1), path];
    historyIndex = history.length - 1;
  }
  tree.scrollTop = 0;
  render(true);
}

function toggle(node) {
  if (expanded.has(node.path)) expanded.delete(node.path);
  else expanded.add(node.path);
  render(true);
}

function quickLook() {
  const node = nodes.get(selected);
  if (!node || node.children) return;
  demo.querySelector('#finder-preview-title').textContent = node.name;
  demo.querySelector('.finder-preview-kind').textContent = kind(node);
  demo.querySelector('.finder-preview-text').textContent = node.text;
  demo.querySelector('.finder-preview-path').textContent =
    `Browser Recall/${node.path}`;
  preview.showModal();
}

tree.addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  selected = row.dataset.path;
  if (event.target.closest('.finder-disclosure')) toggle(nodes.get(selected));
  else updateSelection(true);
});
tree.addEventListener('dblclick', () =>
  nodes.get(selected).children ? navigate(selected) : quickLook(),
);
tree.addEventListener('keydown', (event) => {
  const node = nodes.get(selected);
  const index = visible.indexOf(selected);
  if (!node) return;
  if (
    ![
      'ArrowDown',
      'ArrowUp',
      'ArrowRight',
      'ArrowLeft',
      'Home',
      'End',
      'Enter',
      ' ',
    ].includes(event.key)
  )
    return;
  event.preventDefault();
  if (event.key === 'ArrowDown')
    selected = visible[Math.min(index + 1, visible.length - 1)];
  if (event.key === 'ArrowUp') selected = visible[Math.max(index - 1, 0)];
  if (event.key === 'Home') selected = visible[0];
  if (event.key === 'End') selected = visible.at(-1);
  if (event.key === 'ArrowRight' && node.children) {
    if (!expanded.has(node.path)) return toggle(node);
    selected = children(node.path)[0]?.path || selected;
  }
  if (event.key === 'ArrowLeft') {
    if (node.children && expanded.has(node.path)) return toggle(node);
    if (node.parent !== folder) selected = node.parent;
  }
  if (event.key === 'Enter')
    return node.children ? navigate(selected) : quickLook();
  if (event.key === ' ' && !node.children) return quickLook();
  updateSelection(true);
});
for (const shortcut of demo.querySelectorAll('[data-finder-folder]'))
  shortcut.addEventListener('click', () =>
    navigate(shortcut.dataset.finderFolder),
  );
back.addEventListener('click', () => navigate(history[--historyIndex], false));
forward.addEventListener('click', () =>
  navigate(history[++historyIndex], false),
);
previewButton.addEventListener('click', quickLook);
demo
  .querySelector('[data-finder-close]')
  .addEventListener('click', () => preview.close());
preview.addEventListener('close', () =>
  selectedRow()?.focus({ preventScroll: true }),
);

try {
  const response = await fetch(
    new URL('./demos/finder-data.json', import.meta.url),
  );
  if (!response.ok) throw new Error(`Sample library: HTTP ${response.status}`);
  const sample = await response.json();
  if (
    !Array.isArray(sample.files) ||
    !sample.files.length ||
    sample.files.some(
      (file) =>
        typeof file.path !== 'string' ||
        typeof file.text !== 'string' ||
        file.path.split('/').some((part) => !part || part === '..'),
    )
  )
    throw new Error('Invalid sample library');
  for (const file of sample.files) addFile(file);
  for (const node of children('logs')) expanded.add(node.path);
  for (const node of children('objects/snapshots')) expanded.add(node.path);
  sampleDate = new Date(`${sample.modified}T12:00:00Z`);
  function localizeFiles() {
    modified = new Intl.DateTimeFormat(
      getLocale() === 'en' ? 'en-US' : getLocale(),
      {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      },
    ).format(sampleDate);
    render();
    if (preview.open)
      demo.querySelector('.finder-preview-kind').textContent = kind(
        nodes.get(selected),
      );
  }
  selected = children('objects/notes')[0].path;
  localizeFiles();
  onLocaleChange(localizeFiles);
  tree.setAttribute('aria-busy', 'false');
} catch (error) {
  tree.textContent = t('libraryError');
  tree.setAttribute('aria-busy', 'false');
  demo.querySelector('.finder-status').textContent = error.message;
}
