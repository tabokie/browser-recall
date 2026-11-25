import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { documentationSeed } from './lib/documentation-seed.mjs';
import {
  formatHighlightHistoryDate,
  highlightHistoryDayHtml,
  highlightHistoryEntryHtml,
  highlightHistoryPageGroupHtml,
} from '../apps/desktop/ui/book-elements.js';
import { sidebarListItemHtml } from '../apps/desktop/ui/sidebar-elements.js';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../packages/core/i18n.js';
import { demoLists, featuredPage } from '../packages/demo/collection.js';

// Browser Recall website demos must reuse production renderers and typesetting.
// Test every demo at phone widths and keep scrolling on the outer page.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'website');
const output = path.join(root, 'dist/website');
const localeDirectory = path.join(source, 'locales');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const english = await readJson(
  path.join(localeDirectory, `${DEFAULT_LOCALE}.json`),
);
const { document } = new JSDOM(
  await readFile(path.join(source, 'index.html'), 'utf8'),
).window;
const staticKeys = new Set();
for (const element of document.querySelectorAll('*')) {
  for (const { name, value } of element.attributes) {
    if (/^data-i18n(?:-|$)/.test(name)) staticKeys.add(value);
  }
}
staticKeys.delete('language'); // Reuse the product's language picker label.
const websiteKeys = new Set([...staticKeys, ...Object.keys(english)]);
const placeholders = (text) =>
  [...text.matchAll(/\{\w+\}/g)]
    .map(([value]) => value)
    .sort()
    .join(' ');
const catalogs = {};
for (const { code } of SUPPORTED_LOCALES) {
  const messages = await readJson(path.join(localeDirectory, `${code}.json`));
  const requiredKeys =
    code === DEFAULT_LOCALE ? Object.keys(english) : [...websiteKeys];
  for (const key of requiredKeys) {
    const value = messages[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Missing website translation ${code}/${key}`);
    }
    if (placeholders(value) !== placeholders(english[key] ?? '')) {
      throw new Error(`Mismatched website placeholders ${code}/${key}`);
    }
    const text =
      key === 'heroTitle' ? value.replace(/<\/?em>|<br\s*\/?>/g, '') : value;
    if (/[<>]/.test(text))
      throw new Error(`Unexpected website markup ${code}/${key}`);
  }
  for (const key of Object.keys(messages)) {
    if (!websiteKeys.has(key))
      throw new Error(`Unknown website translation ${code}/${key}`);
  }
  const productMessages = await readJson(
    path.join(root, `packages/core/locales/${code}/messages.json`),
  );
  catalogs[code] = {
    ...messages,
    language: productMessages.desktopLanguage.message,
  };
}

await rm(output, { recursive: true, force: true });
await cp(source, output, {
  recursive: true,
  filter: (file) => file !== localeDirectory,
});
await writeFile(
  path.join(output, 'locale-catalogs.js'),
  `export const catalogs = ${JSON.stringify(catalogs)};\n`,
);
const localeRuntime = path.join(output, 'locale.js');
await writeFile(
  localeRuntime,
  (await readFile(localeRuntime, 'utf8')).replace(
    "'../packages/core/i18n.js'",
    "'./demos/product/packages/core/i18n.js'",
  ),
);
for (const name of ['timeline', 'popup', 'highlight']) {
  const file = path.join(output, `demos/${name}.js`);
  const source = await readFile(file, 'utf8');
  await writeFile(
    file,
    source
      .replaceAll("'../../apps/", "'./product/apps/")
      .replaceAll("'../../packages/", "'./product/packages/"),
  );
}
await mkdir(path.join(output, 'assets'), { recursive: true });

const assets = [
  ['icons/browser-recall-default.svg', 'icon.svg'],
  ['icons/browser-recall-default-transparent.svg', 'extension-recording.svg'],
  [
    'icons/browser-recall-stop-recording-transparent.svg',
    'extension-paused.svg',
  ],
  ...['fraunces-regular.woff2', 'fraunces-italic.woff2', 'nunito.woff2'].map(
    (name) => [`apps/desktop/ui/fonts/${name}`, name],
  ),
  ...[
    'timeline-styles.png',
    'browser-note-window.png',
    'browser-popup-window.png',
  ].map((name) => [`docs/images/${name}`, name]),
];

for (const [source, destination] of assets) {
  await cp(path.join(root, source), path.join(output, 'assets', destination));
}
await writeFile(path.join(output, '.nojekyll'), '');

// Preserve the source directory layout so production module and CSS imports
// resolve without a bundler or alternate implementations of product controls.
const productFiles = [
  'apps/desktop/ui/book-typesetting.js',
  'apps/desktop/ui/timeline-elements.js',
  'apps/desktop/ui/sidebar-elements.js',
  'apps/desktop/ui/utils.js',
  'apps/desktop/ui/shared.css',
  'apps/desktop/ui/fonts',
  'apps/extension/popup-list-elements.js',
  'apps/extension/popup-snapshot-elements.js',
  'apps/extension/utils.js',
  'apps/extension/extension-surface.js',
  'apps/extension/color-schemes.css',
  'packages/core/utils.js',
  'packages/core/page-identity.js',
  'packages/core/highlight-lifecycle.js',
  'packages/core/i18n.js',
  'packages/core/shared.css',
  'packages/core/color-schemes.css',
  'packages/demo/collection.js',
];
for (const file of productFiles) {
  const destination = path.join(output, 'demos/product', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, file), destination, { recursive: true });
}

// Use the desktop app's locked Justif package, including its local module
// dependencies and license. No remote scripts are needed for typesetting.
const justifSource = path.join(root, 'node_modules/justif');
const justifDestination = path.join(
  output,
  'demos/product/apps/desktop/ui/vendor/justif',
);
await cp(path.join(justifSource, 'dist'), justifDestination, {
  recursive: true,
  filter: (file) => !/\.(map|ts)$/.test(file),
});
await cp(
  path.join(justifSource, 'LICENSE'),
  path.join(justifDestination, 'LICENSE'),
);

async function productDocument(file) {
  return new JSDOM(await readFile(path.join(root, file), 'utf8')).window
    .document;
}
function fragment(document, selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Product demo source is missing ${selector}`);
  return element.cloneNode(true);
}
async function demoDocument(name, head, body) {
  await writeFile(
    path.join(output, `demos/${name}.html`),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Recall ${name} demo</title>${head}<link rel="stylesheet" href="frame.css"></head><body>${body}
<script type="module" src="${name}.js"></script></body></html>`,
  );
}

const seed = documentationSeed();
const days = new Map();
const highlights = seed.events
  .filter((event) => event.action === 'create_note')
  .sort((a, b) => b.timestamp - a.timestamp);
for (const highlight of highlights) {
  const date = formatHighlightHistoryDate(highlight.timestamp);
  if (!days.has(date)) days.set(date, new Map());
  const pages = days.get(date);
  if (!pages.has(highlight.url)) pages.set(highlight.url, []);
  pages.get(highlight.url).push({
    page: { url: highlight.url, title: highlight.title },
    note: {
      slug: path.basename(highlight.path, '.json'),
      excerpt: highlight.excerpt,
      note: highlight.note,
    },
    createdAt: highlight.timestamp,
  });
}
const bookHtml = [...days]
  .map(([date, pages]) =>
    highlightHistoryDayHtml(
      date,
      [...pages.values()]
        .map((items) =>
          highlightHistoryPageGroupHtml(items[0], {
            readOnly: true,
            timeLabel: new Date(items[0].createdAt).toLocaleDateString('en-US'),
            entriesHtml: items
              .map((item) =>
                highlightHistoryEntryHtml(item, { readOnly: true }),
              )
              .join(''),
          }),
        )
        .join(''),
    ),
  )
  .join('');
const desktop = await productDocument('apps/desktop/ui/index.html');
const sidebar = fragment(desktop, '.sidebar');
sidebar
  .querySelectorAll(
    '#settingsBtn, #desktopUpdateNotice, #recycleBinBtn, #createListBtn, #listsEmpty',
  )
  .forEach((element) => element.remove());
// Share the capture's list hierarchy and the desktop's list controls.
// Creating a list prepends the list among its siblings in production replay.
function appendLists(container, parentListId = null, depth = 0) {
  for (const list of demoLists.filter(
    (item) => item.parentSlug === parentListId,
  )) {
    const hasChildren = demoLists.some((item) => item.parentSlug === list.slug);
    const item = desktop.createElement('div');
    item.className = 'sidebar-item';
    item.dataset.listId = list.slug;
    item.style.paddingLeft = `calc(var(--sidebar-item-inset) + ${depth * 16}px)`;
    item.innerHTML = sidebarListItemHtml(list.name, {
      hasChildren,
      readOnly: true,
      tr: (_key, fallback) => fallback,
    });
    container.appendChild(item);
    if (hasChildren) {
      const children = desktop.createElement('div');
      children.className = 'sidebar-children';
      children.dataset.parentSlug = list.slug;
      appendLists(children, list.slug, depth + 1);
      container.appendChild(children);
    }
  }
}
appendLists(sidebar.querySelector('#listsList'));
sidebar.querySelector('#exploreBtn').classList.add('active');
const header = fragment(desktop, '.main-header');
header
  .querySelectorAll('input, button:not(#sidebarToggle)')
  .forEach((element) => element.remove());
await demoDocument(
  'timeline',
  `
<link rel="stylesheet" href="product/apps/desktop/ui/shared.css">
${desktop.querySelector('style').outerHTML}
<link rel="stylesheet" href="product/packages/core/color-schemes.css">`,
  `
${sidebar.outerHTML}${fragment(desktop, '#sidebarOverlay').outerHTML}
<div class="main scroll-boundary-contained">${header.outerHTML}
<div class="search-filters-panel"><div class="search-draft" id="demoSearch"></div></div>
${fragment(desktop, '#resultsWrapper').outerHTML}<div id="demoBook" class="results-container" hidden><div class="highlight-history-list detail-notes-section" aria-label="Sample saved highlights">${bookHtml}</div></div></div>`,
);

const popup = await productDocument('apps/extension/popup.html');
const pageHeader = fragment(popup, '#pageHeader');
pageHeader.style.display = '';
pageHeader.querySelector('#pageTitle').textContent = featuredPage.title;
pageHeader.querySelector('#pageUrl').textContent = featuredPage.url;
const lists = fragment(popup, '#listSection');
lists.style.display = '';
// The demo focuses on toggling existing lists; creating/searching lists belongs
// to the full popup, so omit the associated hint and add button here.
lists.querySelector('.list-search-hint').remove();
const notes = fragment(popup, '#notesSection');
notes.style.display = '';
const markupToggleTemplate = notes.querySelector('#markupToggleTemplate');
notes.querySelector('#markupControls').append(markupToggleTemplate.content);
markupToggleTemplate.remove();
const snapshots = fragment(popup, '#snapshotSection');
snapshots.style.display = '';
snapshots.classList.add('is-empty');
await demoDocument(
  'popup',
  `${popup.querySelector('style').outerHTML}<link rel="stylesheet" href="product/apps/extension/color-schemes.css">`,
  `
<div id="dashboard">${fragment(popup, '#recordingBar').outerHTML}
<div id="dashboardContent">${pageHeader.outerHTML}${lists.outerHTML}${notes.outerHTML}${snapshots.outerHTML}</div></div>
<script src="product/apps/extension/extension-surface.js"></script>`,
);
console.log(`Browser Recall website built in ${output}`);
