import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const shared = [
  'package.json',
  'package-lock.json',
  'packages/core',
  'apps/extension/utils.js',
  'scripts/stage-app-assets.mjs',
  'scripts/lib/documentation-seed.mjs',
  'scripts/lib/documentation-window.swift',
  'scripts/lib/documentation-freshness.mjs',
  'scripts/lib/manual-seed.mjs',
  'scripts/lib/seed-builder.mjs',
  'scripts/lib/replay-store.mjs',
  'tests/integration/daemon-test-harness.js',
];
const scopes = {
  desktop: [
    ...shared,
    'apps/desktop/ui',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/icons',
    'apps/desktop/src-tauri/tauri.conf.json',
    'scripts/capture-documentation.mjs',
    'scripts/compose-documentation-hero.mjs',
  ],
  browser: [
    ...shared,
    'apps/extension',
    'scripts/capture-browser-documentation.mjs',
    'scripts/lib/desktop-test-runtime.mjs',
    'tests/e2e/documentation-browser.spec.js',
    'tests/e2e/fixtures.js',
    'tests/e2e/helpers.js',
    'tests/fixtures',
    'playwright.config.js',
  ],
};

export function captureInputs(root, kind) {
  if (!Object.hasOwn(scopes, kind)) throw new Error(`Unknown capture: ${kind}`);
  const files = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    const entry = statSync(absolute, { throwIfNoEntry: true });
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolute).sort())
        visit(`${relative}/${name}`);
    } else if (entry.isFile()) {
      files[relative] = createHash('sha256')
        .update(readFileSync(absolute))
        .digest('hex');
    } else {
      throw new Error(`Unsupported screenshot input: ${relative}`);
    }
  }
  for (const source of scopes[kind]) visit(source);
  return files;
}

export function assertCaptureInputs(root, kind, recorded) {
  const current = captureInputs(root, kind);
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
    throw new Error(`${kind} capture has no source fingerprints`);
  }
  const changed = [
    ...new Set([...Object.keys(current), ...Object.keys(recorded)]),
  ]
    .filter((file) => current[file] !== recorded[file])
    .sort();
  if (changed.length)
    throw new Error(
      `${kind} screenshot inputs changed:\n${changed.join('\n')}`,
    );
}
