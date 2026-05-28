#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const extensionSourceDir = path.join(repoRoot, 'apps/extension');
const desktopUiSourceDir = path.join(repoRoot, 'apps/desktop/ui');
const sharedCoreDir = path.join(repoRoot, 'packages/core');

const extensionProductionExcludes = new Set([
  'background-test-actions.js',
  'background-test-control.js',
]);

const targets = {
  extension: {
    sourceDir: extensionSourceDir,
    defaultOutDir: path.join(repoRoot, 'dist/extension'),
    coreImportPrefix: '../../packages/core/',
    stagedCorePrefix: './core/',
  },
  'desktop-ui': {
    sourceDir: desktopUiSourceDir,
    defaultOutDir: path.join(repoRoot, 'dist/desktop-ui'),
    coreImportPrefix: '../../../packages/core/',
    stagedCorePrefix: './core/',
  },
};

function copyDir(sourceDir, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.cpSync(sourceDir, outDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const basename = path.basename(source);
      if (basename === 'package.json') return false;
      if (
        sourceDir === extensionSourceDir &&
        extensionProductionExcludes.has(basename)
      ) {
        return false;
      }
      return true;
    },
  });
}

function rewriteCoreImports(outDir, { coreImportPrefix, stagedCorePrefix }) {
  const entries = fs.readdirSync(outDir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(outDir, entry.name);
    if (!entry.isFile()) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(coreImportPrefix)) continue;
    fs.writeFileSync(
      filePath,
      source.replaceAll(coreImportPrefix, stagedCorePrefix),
    );
  }
}

function writeExtensionManifest(outDir, browser = 'chrome') {
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (browser === 'firefox') {
    manifest.background = {
      scripts: ['browser-api.js', 'background.js'],
      type: 'module',
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'browser-recall@example.invalid',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    };
  } else {
    manifest.background = {
      service_worker: 'background.js',
      type: 'module',
    };
    delete manifest.browser_specific_settings;
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function stageTarget(name, outDir = targets[name].defaultOutDir) {
  const target = targets[name];
  copyDir(target.sourceDir, outDir);
  fs.cpSync(sharedCoreDir, path.join(outDir, 'core'), {
    recursive: true,
    dereference: true,
  });
  rewriteCoreImports(outDir, target);
  return outDir;
}

export function stageExtensionAssets(outDir = targets.extension.defaultOutDir) {
  const staged = stageTarget('extension', outDir);
  writeExtensionManifest(staged, 'chrome');
  return staged;
}

export function stageFirefoxExtensionAssets(
  outDir = path.join(repoRoot, 'dist/extension-firefox'),
) {
  const staged = stageTarget('extension', outDir);
  writeExtensionManifest(staged, 'firefox');
  return staged;
}

export function stageDesktopUiAssets(
  outDir = targets['desktop-ui'].defaultOutDir,
) {
  return stageTarget('desktop-ui', outDir);
}

export function createStagedExtensionDir(prefix = 'browser-recall-extension-') {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return stageExtensionAssets(outDir);
}

export function cleanupStagedAssets(outDir) {
  if (!outDir) return;
  fs.rmSync(outDir, { recursive: true, force: true });
}

function runCli() {
  const target = process.argv[2] || 'all';
  if (target === 'extension') {
    console.log(stageExtensionAssets());
    console.log(stageFirefoxExtensionAssets());
    return;
  }
  if (target === 'extension-chrome') {
    console.log(stageExtensionAssets());
    return;
  }
  if (target === 'extension-firefox') {
    console.log(stageFirefoxExtensionAssets());
    return;
  }
  if (target === 'desktop-ui') {
    console.log(stageDesktopUiAssets());
    return;
  }
  if (target === 'all') {
    console.log(stageExtensionAssets());
    console.log(stageFirefoxExtensionAssets());
    console.log(stageDesktopUiAssets());
    return;
  }
  console.error(
    'Usage: node scripts/stage-app-assets.mjs [extension|extension-chrome|extension-firefox|desktop-ui|all]',
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
