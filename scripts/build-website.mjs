import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/website');
await rm(output, { recursive: true, force: true });
await cp(path.join(root, 'website'), output, { recursive: true });
await mkdir(path.join(output, 'assets'), { recursive: true });

const assets = [
  ['icons/browser-recall-default.svg', 'icon.svg'],
  ...['fraunces-regular.woff2', 'fraunces-italic.woff2'].map((name) => [
    `apps/desktop/ui/fonts/${name}`,
    name,
  ]),
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
console.log(`Browser Recall website built in ${output}`);
