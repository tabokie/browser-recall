#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  toWebExtensionLocale,
} from '../packages/core/i18n.js';
import { createPageIdentityGlobalScript } from '../packages/core/page-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const extensionSourceDir = path.join(repoRoot, 'apps/extension');
const desktopUiSourceDir = path.join(repoRoot, 'apps/desktop/ui');
const sharedCoreDir = path.join(repoRoot, 'packages/core');
const sharedLocaleDir = path.join(sharedCoreDir, 'locales');
const extensionDistDir = path.join(repoRoot, 'dist/extension');
const chromeExtensionOutDir = path.join(extensionDistDir, 'chrome');
const firefoxExtensionOutDir = path.join(extensionDistDir, 'firefox');
const desktopUiOutDir = path.join(repoRoot, 'dist/desktop/ui');
const pageIdentityContentScript = 'browser-recall-page-identity.js';

export const defaultArtifactDirs = Object.freeze({
  chromeExtension: chromeExtensionOutDir,
  firefoxExtension: firefoxExtensionOutDir,
  desktopUi: desktopUiOutDir,
});

const extensionProductionExcludes = new Set([
  'background-test-actions.js',
  'background-test-control.js',
]);

const targets = {
  extension: {
    sourceDir: extensionSourceDir,
    defaultOutDir: chromeExtensionOutDir,
    coreImportPrefix: '../../packages/core/',
    stagedCorePrefix: './core/',
  },
  'desktop-ui': {
    sourceDir: desktopUiSourceDir,
    defaultOutDir: desktopUiOutDir,
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

function writeExtensionPageIdentityGlobal(outDir) {
  fs.writeFileSync(
    path.join(outDir, pageIdentityContentScript),
    createPageIdentityGlobalScript(),
  );
}

function extensionLocaleMessages(messages) {
  return Object.fromEntries(
    Object.entries(messages).filter(
      ([key]) =>
        key.startsWith('extension') ||
        key.startsWith('command') ||
        key.startsWith('common'),
    ),
  );
}

function messagePlaceholders(message) {
  return [...String(message).matchAll(/\$(\d+)/g)]
    .map((match) => match[1])
    .sort();
}

function messageTagStructure(message) {
  const roots = [];
  const stack = [];
  const voidTags = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  for (const match of String(message).matchAll(/<[^>]+>/g)) {
    const tag = match[0];
    const name = tag.match(/^<\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
    if (!name) continue;
    if (/^<\//.test(tag)) {
      if (stack.pop()?.name !== name) return null;
      continue;
    }
    const node = { name, tag, children: [] };
    const parent = stack.at(-1);
    (parent ? parent.children : roots).push(node);
    if (!/\/\s*>$/.test(tag) && !voidTags.has(name)) stack.push(node);
  }
  if (stack.length > 0) return null;
  const signature = (node) =>
    `${node.tag}[${node.children.map(signature).sort().join(',')}]`;
  return roots.map(signature).sort();
}

function messageProtectedLiterals(message) {
  return [...String(message).matchAll(/<(code|kbd)>(.*?)<\/\1>/g)]
    .map((match) => `${match[1]}:${match[2]}`)
    .sort();
}

function messageProtectedTerms(message) {
  return [
    ...String(message).matchAll(
      /Browser Recall Desktop|Browser Recall|browser-recall|Chrome|Firefox|GitHub|JSONL|settings\.json|\bjq\b|Alt\+[A-Z]/g,
    ),
  ]
    .map((match) => match[0])
    .sort();
}

export function validateLocaleMessage(
  code,
  key,
  defaultMessage,
  localizedMessage,
) {
  // Translate placeholders, protected terms, and HTML as complete sentences.
  // Translating fragments around tokens preserves structure but breaks grammar.
  const expectedPlaceholders = messagePlaceholders(defaultMessage);
  const actualPlaceholders = messagePlaceholders(localizedMessage);
  if (
    JSON.stringify(actualPlaceholders) !== JSON.stringify(expectedPlaceholders)
  ) {
    throw new Error(`Locale ${code} has incompatible placeholders for ${key}`);
  }
  const expectedStructure = messageTagStructure(defaultMessage);
  const actualStructure = messageTagStructure(localizedMessage);
  if (
    !expectedStructure ||
    !actualStructure ||
    JSON.stringify(actualStructure) !== JSON.stringify(expectedStructure)
  ) {
    throw new Error(
      `Locale ${code} has incompatible HTML structure for ${key}`,
    );
  }
  const expectedLiterals = messageProtectedLiterals(defaultMessage);
  const actualLiterals = messageProtectedLiterals(localizedMessage);
  if (JSON.stringify(actualLiterals) !== JSON.stringify(expectedLiterals)) {
    throw new Error(
      `Locale ${code} has incompatible protected literals for ${key}`,
    );
  }
  const expectedTerms = messageProtectedTerms(defaultMessage);
  const actualTerms = messageProtectedTerms(localizedMessage);
  if (JSON.stringify(actualTerms) !== JSON.stringify(expectedTerms)) {
    throw new Error(
      `Locale ${code} has incompatible protected terms for ${key}`,
    );
  }
}

export function validateLocaleCatalogs() {
  const registeredCodes = SUPPORTED_LOCALES.map((locale) => locale.code);
  if (new Set(registeredCodes).size !== registeredCodes.length) {
    throw new Error('Locale registry contains duplicate codes');
  }
  if (!registeredCodes.includes(DEFAULT_LOCALE)) {
    throw new Error(`Default locale ${DEFAULT_LOCALE} is not registered`);
  }

  const catalogDirectories = fs
    .readdirSync(sharedLocaleDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(sharedLocaleDir, entry.name, 'messages.json')),
    )
    .map((entry) => entry.name)
    .sort();
  const unregistered = catalogDirectories.filter(
    (code) => !registeredCodes.includes(code),
  );
  if (unregistered.length > 0) {
    throw new Error(`Unregistered locale catalogs: ${unregistered.join(', ')}`);
  }

  const catalogs = new Map();
  for (const code of registeredCodes) {
    const source = path.join(sharedLocaleDir, code, 'messages.json');
    if (!fs.existsSync(source)) {
      throw new Error(`Missing locale catalog: ${code}`);
    }
    catalogs.set(code, JSON.parse(fs.readFileSync(source, 'utf8')));
  }

  const defaultCatalog = catalogs.get(DEFAULT_LOCALE);
  const defaultKeys = Object.keys(defaultCatalog).sort();
  for (const [code, catalog] of catalogs) {
    const keys = Object.keys(catalog).sort();
    if (JSON.stringify(keys) !== JSON.stringify(defaultKeys)) {
      throw new Error(`Locale ${code} does not match ${DEFAULT_LOCALE} keys`);
    }
    for (const key of defaultKeys) {
      if (!catalog[key]?.message) {
        throw new Error(`Locale ${code} has an empty message for ${key}`);
      }
      validateLocaleMessage(
        code,
        key,
        defaultCatalog[key].message,
        catalog[key].message,
      );
    }
  }
  return catalogs;
}

function writeFilteredExtensionLocales(
  outDir,
  { browserLocaleNames = false } = {},
) {
  const localesOutDir = outDir;
  const catalogs = validateLocaleCatalogs();
  fs.rmSync(localesOutDir, { recursive: true, force: true });
  fs.mkdirSync(localesOutDir, { recursive: true });
  for (const locale of SUPPORTED_LOCALES) {
    const extensionLocale = browserLocaleNames
      ? toWebExtensionLocale(locale.code)
      : locale.code;
    const targetDir = path.join(localesOutDir, extensionLocale);
    fs.mkdirSync(targetDir, { recursive: true });
    const messages = catalogs.get(locale.code);
    fs.writeFileSync(
      path.join(targetDir, 'messages.json'),
      `${JSON.stringify(extensionLocaleMessages(messages), null, 2)}\n`,
    );
  }
}

function writeExtensionLocales(outDir) {
  writeFilteredExtensionLocales(path.join(outDir, '_locales'), {
    browserLocaleNames: true,
  });
  writeFilteredExtensionLocales(path.join(outDir, 'core', 'locales'));
}

function ensurePageIdentityContentScript(manifest) {
  const contentScript = manifest.content_scripts?.find((entry) =>
    entry.js?.includes('content.js'),
  );
  if (!contentScript) return;
  if (contentScript.js.includes(pageIdentityContentScript)) return;
  const contentIndex = contentScript.js.indexOf('content.js');
  const insertIndex =
    contentIndex >= 0 ? contentIndex : contentScript.js.length;
  contentScript.js.splice(insertIndex, 0, pageIdentityContentScript);
}

function writeExtensionManifest(outDir, browser = 'chrome') {
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ensurePageIdentityContentScript(manifest);
  manifest.default_locale = toWebExtensionLocale(DEFAULT_LOCALE);

  if (browser === 'firefox') {
    manifest.action = {
      ...(manifest.action || {}),
      default_popup: 'popup.html',
    };
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
  validateLocaleCatalogs();
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
  writeExtensionLocales(staged);
  writeExtensionPageIdentityGlobal(staged);
  writeExtensionManifest(staged, 'chrome');
  return staged;
}

export function stageFirefoxExtensionAssets(outDir = firefoxExtensionOutDir) {
  const staged = stageTarget('extension', outDir);
  writeExtensionLocales(staged);
  writeExtensionPageIdentityGlobal(staged);
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
  if (target === 'locales') {
    const catalogs = validateLocaleCatalogs();
    console.log(`Validated ${catalogs.size} locale catalogs`);
    return;
  }
  if (target === 'all') {
    console.log(stageExtensionAssets());
    console.log(stageFirefoxExtensionAssets());
    console.log(stageDesktopUiAssets());
    return;
  }
  console.error(
    'Usage: node scripts/stage-app-assets.mjs [extension|extension-chrome|extension-firefox|desktop-ui|locales|all]',
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
