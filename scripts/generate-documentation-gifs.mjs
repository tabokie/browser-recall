#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { assertCaptureInputs } from './lib/documentation-freshness.mjs';
import {
  editGif,
  gifClickRipples,
  gifFraming,
  readFramedGif,
  readDerivedGif,
  readGif,
} from './lib/documentation-gif.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root =
  rootIndex < 0
    ? fileURLToPath(new URL('../', import.meta.url))
    : path.resolve(args.splice(rootIndex, 2)[1]);
const recipeFile = 'scripts/documentation-gifs.json';
const recipes = JSON.parse(readFileSync(path.join(root, recipeFile)));
const names = args.length ? args : Object.keys(recipes);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = Object.fromEntries(
  [
    'scripts/generate-documentation-gifs.mjs',
    'scripts/lib/documentation-gif.mjs',
  ].map((name) => [name, hash(readFileSync(path.join(root, name)))]),
);
async function writeJson(filename, value) {
  writeFileSync(
    `${filename}.tmp`,
    await format(JSON.stringify(value), { parser: 'json' }),
  );
  renameSync(`${filename}.tmp`, filename);
}
for (const name of names) {
  const recipe = recipes[name];
  if (!recipe)
    throw new Error(
      `Unknown GIF: ${name}. Choose ${Object.keys(recipes).join(', ')}`,
    );
  const folder = path.join(root, 'docs/images/details');
  const manifestPath = path.join(folder, `${recipe.kind}-capture.json`);
  const manifest = JSON.parse(readFileSync(manifestPath));
  assertCaptureInputs(root, recipe.kind, manifest.inputs);
  const filename = `${name}.gif`,
    destination = path.join(folder, filename);
  const recorded = manifest.media[filename];
  if (!recorded) throw new Error(`No native capture for ${filename}`);
  const current = readFileSync(destination);
  if (hash(current) !== recorded.sha256)
    throw new Error(`GIF does not match capture manifest: ${filename}`);
  const sourceFolder = path.join(folder, 'sources');
  mkdirSync(sourceFolder, { recursive: true });
  const sourcePath = path.join(sourceFolder, filename);
  const sourceManifestPath = path.join(sourceFolder, `${name}.json`);
  // A fresh native capture replaces the saved source. Subsequent focused edits
  // always start with that source, preserving frames omitted by earlier edits.
  if (!recorded.edit) {
    writeFileSync(sourcePath, current);
    await writeJson(sourceManifestPath, {
      inputs: manifest.inputs,
      media: recorded,
    });
  }
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath));
  assertCaptureInputs(root, recipe.kind, sourceManifest.inputs);
  const source = readFileSync(sourcePath);
  if (hash(source) !== sourceManifest.media.sha256)
    throw new Error(`Saved source changed: ${filename}`);
  const framing = gifFraming(root, source, recipe);
  let framed = source;
  if (framing) {
    if (
      !sourceManifest.framing ||
      Object.entries(framing).some(
        ([key, value]) =>
          JSON.stringify(sourceManifest.framing[key]) !== JSON.stringify(value),
      )
    ) {
      if (process.platform !== 'darwin')
        throw new Error(
          'Changing GIF framing requires macOS; cached frame selection and timing work on every platform',
        );
      const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-gif-'));
      try {
        const encoder = path.join(work, 'frame-gif');
        const output = path.join(work, filename);
        const job = path.join(work, 'recipe.json');
        writeFileSync(job, JSON.stringify(recipe));
        execFileSync(
          '/usr/bin/swiftc',
          [
            '-module-cache-path',
            path.join(work, 'swift-module-cache'),
            path.join(root, 'scripts/lib/documentation-gif-frame.swift'),
            '-o',
            encoder,
          ],
          { timeout: 60000 },
        );
        execFileSync(
          encoder,
          [
            sourcePath,
            output,
            path.join(root, 'scripts/assets/documentation-sonoma-light.png'),
            job,
          ],
          { timeout: 30000 },
        );
        framed = readFileSync(output);
        const framedPath = path.join(sourceFolder, `${name}-framed.gif`);
        writeFileSync(`${framedPath}.tmp`, framed);
        renameSync(`${framedPath}.tmp`, framedPath);
        sourceManifest.framing = { ...framing, sha256: hash(framed) };
        await writeJson(sourceManifestPath, sourceManifest);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    framed = readFramedGif(root, name, sourceManifest.framing, framing);
  }
  const clicks = gifClickRipples(root, framed, recipe);
  let decorated = framed;
  if (clicks) {
    if (
      !sourceManifest.clicks ||
      Object.entries(clicks).some(
        ([key, value]) =>
          JSON.stringify(sourceManifest.clicks[key]) !== JSON.stringify(value),
      )
    ) {
      if (process.platform !== 'darwin')
        throw new Error('Changing GIF click ripples requires macOS');
      const work = mkdtempSync(path.join(tmpdir(), 'browser-recall-clicks-'));
      try {
        const encoder = path.join(work, 'clicks');
        const input = path.join(work, 'input.gif');
        const output = path.join(work, 'output.gif');
        const job = path.join(work, 'recipe.json');
        writeFileSync(input, framed);
        writeFileSync(job, JSON.stringify(recipe));
        execFileSync(
          '/usr/bin/swiftc',
          [
            '-module-cache-path',
            path.join(work, 'swift-module-cache'),
            path.join(root, 'scripts/lib/documentation-gif-clicks.swift'),
            '-o',
            encoder,
          ],
          { timeout: 60000 },
        );
        execFileSync(encoder, [input, output, job], { timeout: 30000 });
        decorated = readFileSync(output);
        const target = path.join(sourceFolder, `${name}-clicks.gif`);
        writeFileSync(`${target}.tmp`, decorated);
        renameSync(`${target}.tmp`, target);
        sourceManifest.clicks = { ...clicks, sha256: hash(decorated) };
        await writeJson(sourceManifestPath, sourceManifest);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    decorated = readDerivedGif(
      root,
      `${name}-clicks`,
      sourceManifest.clicks,
      clicks,
    );
  }
  const edited = editGif(decorated, recipe),
    info = readGif(edited);
  manifest.media[filename] = {
    ...sourceManifest.media,
    sha256: hash(edited),
    frames: info.frames.length,
    duration: info.duration,
    interaction: {
      ...sourceManifest.media.interaction,
      cursorFrames: info.frames.length,
      clicks: recipe.clicks,
    },
    edit: { inputs, recipe },
  };
  writeFileSync(`${destination}.tmp`, edited);
  renameSync(`${destination}.tmp`, destination);
  await writeJson(manifestPath, manifest);
  console.log(
    `Generated ${filename}: ${info.frames.length} frames, ${info.duration.toFixed(2)}s; reused saved capture`,
  );
}
