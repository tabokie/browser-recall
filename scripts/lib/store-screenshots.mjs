import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const storeScreenshotNames = [
  'browser-popup-window.png',
  'browser-note-window.png',
];
const sources = storeScreenshotNames.map((name) => `docs/images/${name}`);
const exporterInputs = [
  'scripts/export-chrome-web-store-screenshots.mjs',
  'scripts/lib/store-screenshot.swift',
  'scripts/lib/store-screenshots.mjs',
];

export function storeScreenshotInputs(root, imagesOnly = false) {
  return Object.fromEntries(
    [...sources, ...(imagesOnly ? [] : exporterInputs)].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(path.join(root, name)))
        .digest('hex'),
    ]),
  );
}

export function assertStoreScreenshotInputs(
  root,
  recorded,
  imagesOnly = false,
) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
    throw new Error('Chrome Web Store export has no source fingerprints');
  }
  const current = storeScreenshotInputs(root, imagesOnly);
  const names = imagesOnly
    ? Object.keys(current)
    : [...new Set([...Object.keys(current), ...Object.keys(recorded)])];
  const changed = names
    .filter((name) => current[name] !== recorded[name])
    .sort();
  if (changed.length)
    throw new Error(
      `Chrome Web Store screenshot inputs changed:\n${changed.join('\n')}`,
    );
}

export function storeScreenshotRecord(bytes, name) {
  const invalid = () => {
    throw new Error(
      `Expected a 1280 × 800, 24-bit RGB PNG without alpha: ${name}`,
    );
  };
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.readUInt32BE(16) !== 1280 ||
    bytes.readUInt32BE(20) !== 800 ||
    bytes[24] !== 8 ||
    bytes[25] !== 2
  )
    invalid();
  let ended = false;
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length || kind === 'tRNS') invalid();
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid();
      ended = true;
      break;
    }
  }
  if (!ended) invalid();
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 1280,
    height: 800,
  };
}
