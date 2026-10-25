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

// Browser Recall website demos must reuse production renderers and typesetting.
// Test every demo tab at phone widths and keep scrolling on the outer page.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/website');
await rm(output, { recursive: true, force: true });
await cp(path.join(root, 'website'), output, { recursive: true });
for (const name of ['timeline', 'organize', 'highlight']) {
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
  ...['fraunces-regular.woff2', 'fraunces-italic.woff2', 'nunito.woff2'].map(
    (name) => [`apps/desktop/ui/fonts/${name}`, name],
  ),
  ...[
    'timeline-styles.png',
    'book.png',
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
  'apps/desktop/ui/utils.js',
  'apps/desktop/ui/shared.css',
  'apps/desktop/ui/fonts',
  'apps/extension/popup-list-elements.js',
  'apps/extension/utils.js',
  'apps/extension/extension-surface.js',
  'apps/extension/color-schemes.css',
  'packages/core/utils.js',
  'packages/core/page-identity.js',
  'packages/core/highlight-lifecycle.js',
  'packages/core/shared.css',
  'packages/core/color-schemes.css',
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

const days = new Map();
const highlights = documentationSeed()
  .events.filter((event) => event.action === 'create_note')
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
    '#settingsBtn, #desktopUpdateNotice, #recycleBinBtn, .sidebar-content',
  )
  .forEach((element) => element.remove());
sidebar.querySelector('#exploreBtn').classList.add('active');
const header = fragment(desktop, '.main-header');
header
  .querySelectorAll('input, button:not(#sidebarToggle)')
  .forEach((element) => element.remove());
await demoDocument(
  'timeline',
  `
<link rel="stylesheet" href="product/apps/desktop/ui/shared.css">
${desktop.querySelector('style').outerHTML}`,
  `
${sidebar.outerHTML}${fragment(desktop, '#sidebarOverlay').outerHTML}
<div class="main scroll-boundary-contained">${header.outerHTML}
<div class="search-filters-panel"><div class="search-draft" id="demoSearch"></div></div>
${fragment(desktop, '#resultsWrapper').outerHTML}<div id="demoBook" class="results-container" hidden><div class="highlight-history-list detail-notes-section" aria-label="Sample saved highlights">${bookHtml}</div></div></div>`,
);

const popup = await productDocument('apps/extension/popup.html');
const pageHeader = fragment(popup, '#pageHeader');
pageHeader.style.display = '';
pageHeader.querySelector('#pageTitle').textContent = 'A smaller, slower web';
pageHeader.querySelector('#pageUrl').textContent =
  'https://fieldnotes.example/a-smaller-web';
const lists = fragment(popup, '#listSection');
lists.style.display = '';
// The demo focuses on toggling existing lists; creating/searching lists belongs
// to the full popup, so omit the associated hint and add button here.
lists.querySelector('.list-search-hint').remove();
await demoDocument(
  'organize',
  `${popup.querySelector('style').outerHTML}<link rel="stylesheet" href="product/apps/extension/color-schemes.css">`,
  `
${pageHeader.outerHTML}${lists.outerHTML}`,
);
console.log(`Browser Recall website built in ${output}`);
