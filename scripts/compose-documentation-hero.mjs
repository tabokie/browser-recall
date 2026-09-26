#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { format } from 'prettier';
import { assertCaptureInputs } from './lib/documentation-freshness.mjs';

export async function composeDocumentationHero(directory) {
  const sources = ['timeline.png', 'timeline-mono.png'];
  const inputs = sources.map((name) =>
    readFileSync(path.join(directory, name)),
  );
  const width = inputs[0].readUInt32BE(16);
  const height = inputs[0].readUInt32BE(20);
  if (
    inputs.some(
      (bytes) =>
        bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height,
    )
  ) {
    throw new Error('Timeline screenshots must have identical dimensions');
  }
  const browser = await chromium.launch({ channel: 'chromium' });
  let bytes;
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(
      async ({ images, width, height }) => {
        const loaded = await Promise.all(
          images.map(async (src) => {
            const image = new Image();
            image.src = src;
            await image.decode();
            return image;
          }),
        );
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.drawImage(loaded[0], 0, 0);
        context.save();
        context.beginPath();
        context.moveTo(width * 0.62, 0);
        context.lineTo(width, 0);
        context.lineTo(width, height);
        context.lineTo(width * 0.38, height);
        context.closePath();
        context.clip();
        context.drawImage(loaded[1], 0, 0);
        context.restore();
        context.beginPath();
        context.moveTo(width * 0.62, 0);
        context.lineTo(width * 0.38, height);
        context.strokeStyle = '#ffffff';
        context.lineWidth = width / 580;
        context.stroke();
        return canvas.toDataURL('image/png');
      },
      {
        images: inputs.map(
          (bytes) => `data:image/png;base64,${bytes.toString('base64')}`,
        ),
        width,
        height,
      },
    );
    bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(directory, 'timeline-styles.png'), bytes);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width,
    height,
    composition: {
      sources,
      sourceSha256: inputs.map((input) =>
        createHash('sha256').update(input).digest('hex'),
      ),
      split: { top: 0.62, bottom: 0.38 },
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = fileURLToPath(new URL('../docs/images/', import.meta.url));
  const manifestPath = path.join(directory, 'capture.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertCaptureInputs(
    path.resolve(directory, '../..'),
    'desktop',
    manifest.inputs,
  );
  for (const name of ['timeline.png', 'timeline-mono.png']) {
    const bytes = readFileSync(path.join(directory, name));
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      manifest.screenshots[name].sha256
    )
      throw new Error(`Native capture has changed: ${name}`);
  }
  manifest.screenshots['timeline-styles.png'] =
    await composeDocumentationHero(directory);
  writeFileSync(
    manifestPath,
    await format(JSON.stringify(manifest), { parser: 'json' }),
  );
}
