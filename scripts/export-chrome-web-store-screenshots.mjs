import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCaptureInputs } from './lib/documentation-freshness.mjs';
import {
  storeScreenshotNames,
  storeScreenshotInputs,
  storeScreenshotRecord,
} from './lib/store-screenshots.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const images = path.join(root, 'docs/images');
const captures = JSON.parse(
  readFileSync(path.join(images, 'browser-capture.json'), 'utf8'),
);
const names = storeScreenshotNames;

if (process.platform !== 'darwin') {
  throw new Error('Chrome Web Store screenshot export requires macOS');
}
assertCaptureInputs(root, 'browser', captures.inputs);
for (const name of names) {
  const bytes = readFileSync(path.join(images, name));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    captures.screenshots[name]?.sha256
  ) {
    throw new Error(`Documentation screenshot changed since capture: ${name}`);
  }
}

const output = path.join(images, 'chrome-web-store');
mkdirSync(output, { recursive: true });
// Stage beneath the destination so final renames stay on the same volume.
const work = mkdtempSync(path.join(output, '.export-'));
try {
  const manifest = { inputs: storeScreenshotInputs(root), screenshots: {} };
  const helper = path.join(work, 'store-screenshot');
  execFileSync('/usr/bin/swiftc', [
    '-module-cache-path',
    path.join(work, 'swift-module-cache'),
    path.join(root, 'scripts/lib/store-screenshot.swift'),
    '-o',
    helper,
  ]);
  for (const name of names) {
    const staged = path.join(work, name);
    execFileSync(helper, [path.join(images, name), staged]);
    const bytes = readFileSync(staged);
    manifest.screenshots[name] = storeScreenshotRecord(bytes, name);
  }
  writeFileSync(
    path.join(work, 'capture.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  // Conversion or validation failure must leave the previous export intact.
  for (const name of [...names, 'capture.json']) {
    renameSync(path.join(work, name), path.join(output, name));
    console.log(`Exported docs/images/chrome-web-store/${name}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
