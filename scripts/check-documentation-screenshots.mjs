#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureInputs } from './lib/documentation-freshness.mjs';
import {
  storeScreenshotNames,
  assertStoreScreenshotInputs,
  storeScreenshotRecord,
} from './lib/store-screenshots.mjs';
import {
  documentationImagePixels,
  documentationWallpaper,
} from './lib/documentation-image-spec.mjs';

const args = process.argv.slice(2);
const imagesOnly = args.includes('--images-only');
const directory = args.filter((arg) => arg !== '--images-only')[0];
const root = directory
  ? path.resolve(directory)
  : fileURLToPath(new URL('../', import.meta.url));
const captures = [
  {
    kind: 'desktop',
    manifest: 'capture.json',
    command: 'npm run docs:screenshots',
    names: [
      'timeline.png',
      'timeline-mono.png',
      'timeline-styles.png',
      'book.png',
    ],
  },
  {
    kind: 'browser',
    manifest: 'browser-capture.json',
    command: 'npm run docs:screenshots:browser',
    names: ['browser-popup-window.png', 'browser-note-window.png'],
  },
];
const errors = [];
const available = new Set();
for (const capture of captures) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'docs/images', capture.manifest), 'utf8'),
    );
    const wallpaperSha256 = createHash('sha256')
      .update(readFileSync(path.join(root, documentationWallpaper.file)))
      .digest('hex');
    if (
      manifest.wallpaper?.name !== documentationWallpaper.name ||
      manifest.wallpaper?.file !== documentationWallpaper.file ||
      manifest.wallpaper?.crop !== documentationWallpaper.crop ||
      manifest.wallpaper?.sha256 !== wallpaperSha256
    ) {
      throw new Error(
        'Documentation wallpaper does not match capture manifest',
      );
    }
    if (!imagesOnly) assertCaptureInputs(root, capture.kind, manifest.inputs);
    const names = Object.keys(manifest.screenshots).sort();
    if (JSON.stringify(names) !== JSON.stringify([...capture.names].sort()))
      throw new Error(`${capture.manifest}: unexpected screenshot inventory`);
    for (const name of names) {
      const recorded = manifest.screenshots[name];
      const bytes = readFileSync(path.join(root, 'docs/images', name));
      if (
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        bytes.length < 24
      )
        throw new Error(`Invalid PNG: ${name}`);
      const expected = documentationImagePixels[name];
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width !== expected.width || height !== expected.height) {
        throw new Error(
          `${name} must be ${expected.width} × ${expected.height} pixels`,
        );
      }
      if (
        createHash('sha256').update(bytes).digest('hex') !== recorded.sha256 ||
        width !== recorded.width ||
        height !== recorded.height
      )
        throw new Error(`Screenshot does not match capture manifest: ${name}`);
      available.add(`docs/images/${name}`);
    }
    if (capture.kind === 'desktop') {
      const composed = manifest.screenshots['timeline-styles.png'];
      const composition = composed.composition;
      if (
        JSON.stringify(composition?.sources) !==
        JSON.stringify(['timeline.png', 'timeline-mono.png'])
      )
        throw new Error('Invalid Timeline composition sources');
      for (const [index, name] of composition.sources.entries()) {
        const source = manifest.screenshots[name];
        if (
          composition.sourceSha256[index] !== source.sha256 ||
          source.width !== composed.width ||
          source.height !== composed.height
        )
          throw new Error(`Timeline composition is stale: ${name}`);
      }
    }
  } catch (error) {
    errors.push(
      `${error.message}\nRegenerate on macOS with ${capture.command}, then commit the images and manifest.`,
    );
  }
}
try {
  const folder = path.join(root, 'docs/images/chrome-web-store');
  const manifest = JSON.parse(
    readFileSync(path.join(folder, 'capture.json'), 'utf8'),
  );
  assertStoreScreenshotInputs(root, manifest.inputs, imagesOnly);
  if (
    JSON.stringify(Object.keys(manifest.screenshots).sort()) !==
    JSON.stringify([...storeScreenshotNames].sort())
  ) {
    throw new Error(
      'Chrome Web Store export has an unexpected screenshot inventory',
    );
  }
  for (const name of storeScreenshotNames) {
    const bytes = readFileSync(path.join(folder, name));
    const recorded = manifest.screenshots[name];
    if (createHash('sha256').update(bytes).digest('hex') !== recorded.sha256) {
      throw new Error(
        `Chrome Web Store screenshot does not match capture manifest: ${name}`,
      );
    }
    const current = storeScreenshotRecord(bytes, name);
    if (
      current.width !== recorded.width ||
      current.height !== recorded.height
    ) {
      throw new Error(
        `Chrome Web Store screenshot dimensions do not match capture manifest: ${name}`,
      );
    }
  }
} catch (error) {
  errors.push(
    `${error.message}\nRegenerate on macOS with node scripts/export-chrome-web-store-screenshots.mjs, then commit the images and manifest.`,
  );
}
try {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const images = [
    ...[...readme.matchAll(/!\[[^\]]*\]\(([^\s)]+)/g)].map((match) => match[1]),
    ...[
      ...readme.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
    ].map((match) => match[1] ?? match[2]),
  ].filter((name) => name !== 'icons/browser-recall-default.svg');
  const expected = [
    'docs/images/timeline-styles.png',
    'docs/images/browser-popup-window.png',
    'docs/images/browser-note-window.png',
    'docs/images/book.png',
  ];
  if (
    JSON.stringify(images.sort()) !== JSON.stringify(expected.sort()) ||
    images.some((name) => !available.has(name))
  )
    throw new Error(
      'README must reference each of the four verified documentation images exactly once',
    );
} catch (error) {
  errors.push(error.message);
}
if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exitCode = 1;
} else {
  console.log(
    imagesOnly
      ? 'Documentation and Chrome Web Store image integrity verified; run the full check locally for source freshness.'
      : 'Documentation and Chrome Web Store screenshots are current: source fingerprints, PNG hashes, dimensions, composition, formats, and references verified.',
  );
}
