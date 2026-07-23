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
import { createHighlightLifecycleGlobalScript } from '../packages/core/highlight-lifecycle.js';
import { createMarkdownExtractorGlobalScript } from '../packages/core/markdown-extractor.js';
import { createBoundedResponseGlobalScript } from '../packages/core/bounded-response.js';

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
const highlightLifecycleContentScript = 'browser-recall-highlight-lifecycle.js';
const markdownExtractorContentScript = 'browser-recall-markdown-extractor.js';
const boundedResponseContentScript = 'browser-recall-bounded-response.js';

export const defaultArtifactDirs = Object.freeze({
  chromeExtension: chromeExtensionOutDir,
  firefoxExtension: firefoxExtensionOutDir,
  desktopUi: desktopUiOutDir,
});

const extensionProductionExcludes = new Set([
  'background-test-actions.js',
  'background-test-control.js',
]);
const localizationSourceExcludes = new Set([
  ...extensionProductionExcludes,
  'test-helper.html',
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

function writeExtensionHighlightLifecycleGlobal(outDir) {
  fs.writeFileSync(
    path.join(outDir, highlightLifecycleContentScript),
    createHighlightLifecycleGlobalScript(),
  );
}

function writeExtensionMarkdownExtractorGlobal(outDir) {
  fs.writeFileSync(
    path.join(outDir, markdownExtractorContentScript),
    createMarkdownExtractorGlobalScript(),
  );
}

function writeExtensionBoundedResponseGlobal(outDir) {
  fs.writeFileSync(
    path.join(outDir, boundedResponseContentScript),
    createBoundedResponseGlobalScript(),
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

function collectLocalizationSources(dir, relativeRoot = repoRoot) {
  const sources = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      ['_locales', 'lib', 'savepage'].includes(entry.name)
    ) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(...collectLocalizationSources(filePath, relativeRoot));
      continue;
    }
    if (!/\.(?:html|js|json)$/.test(entry.name)) continue;
    if (localizationSourceExcludes.has(entry.name)) continue;
    sources.push({
      path: path.relative(relativeRoot, filePath),
      source: fs.readFileSync(filePath, 'utf8'),
    });
  }
  return sources;
}

function referencedLocalizationKeys(source) {
  const keys = new Set();
  const patterns = [
    /\btr\(\s*['"]([^'"]+)['"]/g,
    /\b(?:chrome\.)?i18n\.getMessage\(\s*['"]([^'"]+)['"]/g,
    /data-i18n(?:-html|-placeholder|-title|-aria-label)?\s*=\s*['"]([^'"]+)['"]/g,
    /__MSG_([A-Za-z][\w.-]*)__\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }
  return keys;
}

function stripHtmlMarkup(value) {
  return value
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\w-]*);/gi, ' ');
}

function skipQuotedJsLiteral(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function scanTemplateLiteral(source, start) {
  const staticParts = [];
  let partStart = start + 1;
  for (let index = partStart; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '`') {
      staticParts.push(source.slice(partStart, index));
      return { end: index + 1, staticText: staticParts.join(' ') };
    }
    if (source[index] === '$' && source[index + 1] === '{') {
      staticParts.push(source.slice(partStart, index));
      index = skipJsExpression(source, index + 2) - 1;
      partStart = index + 1;
    }
  }
  return { end: source.length, staticText: staticParts.join(' ') };
}

function skipJsExpression(source, start) {
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipQuotedJsLiteral(source, index, char) - 1;
      continue;
    }
    if (char === '`') {
      index = scanTemplateLiteral(source, index).end - 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return source.length;
}

export function validateLocalizedUiSource(filePath, source) {
  // Cover HTML text nodes, UI attributes, and static innerHTML segments.
  // Mark intentional non-translated product or provider names with translate="no".
  const literalPatterns = [
    String.raw`"((?:\\.|[^"\\])*)"`,
    String.raw`'((?:\\.|[^'\\])*)'`,
    String.raw`\`((?:\\.|[^\`\\])*)\``,
  ];
  const assignmentGroups = [
    {
      prefix: String.raw`\.(?:title|placeholder|textContent|innerText)\s*=\s*`,
      html: false,
    },
    {
      prefix: String.raw`\.innerHTML\s*=\s*`,
      html: true,
      literals: literalPatterns.slice(0, 2),
    },
    {
      prefix: String.raw`\.setAttribute\(\s*['"](?:title|placeholder|aria-label)['"]\s*,\s*`,
      html: false,
    },
  ];
  if (filePath.endsWith('.js')) {
    assignmentGroups.push({
      prefix: String.raw`(?:title|placeholder|aria-label)\s*=\s*`,
      html: false,
    });
  }
  const assignments = assignmentGroups.flatMap(
    ({ prefix, html, literals = literalPatterns }) =>
      literals.map((literal) => ({
        pattern: new RegExp(`${prefix}${literal}`, 'gs'),
        html,
      })),
  );
  for (const { pattern, html } of assignments) {
    for (const match of source.matchAll(pattern)) {
      const literalText = match[1];
      let visibleText = literalText
        .replace(/\$\{[\s\S]*?\}/g, ' ')
        .replace(/\\u[\da-f]{4}|\\x[\da-f]{2}/gi, '');
      if (html) {
        visibleText = stripHtmlMarkup(visibleText);
      }
      if (
        /\p{L}/u.test(visibleText) &&
        !visibleText.trimStart().startsWith('//')
      ) {
        throw new Error(
          `${filePath} has hardcoded localized UI text: ${literalText}`,
        );
      }
    }
  }
  if (filePath.endsWith('.js')) {
    for (const match of source.matchAll(/\.innerHTML\s*=\s*`/g)) {
      const start = match.index + match[0].length - 1;
      const { staticText } = scanTemplateLiteral(source, start);
      const visibleText = stripHtmlMarkup(staticText).replace(
        /\\u[\da-f]{4}|\\x[\da-f]{2}/gi,
        '',
      );
      if (/\p{L}/u.test(visibleText)) {
        throw new Error(
          `${filePath} has hardcoded localized UI text: ${visibleText.trim()}`,
        );
      }
    }
  }
  if (!filePath.endsWith('.html')) return;
  for (const tagMatch of source.matchAll(/<[^>]+>/gs)) {
    const tag = tagMatch[0];
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const value = tag.match(
        new RegExp(`\\s${attribute}=(['"])([^'"]+)\\1`),
      )?.[2];
      if (!value || !/\p{L}/u.test(value)) continue;
      if (tag.includes(`data-i18n-${attribute}=`)) continue;
      if (
        tag.includes('data-scheme=') ||
        /^(?:https?:\/\/|github_pat_)/.test(value)
      ) {
        continue;
      }
      throw new Error(`${filePath} has hardcoded localized UI text: ${value}`);
    }
  }

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
  const stack = [];
  for (const tokenMatch of source.matchAll(
    /<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g,
  )) {
    const token = tokenMatch[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const tagName = token.match(/^<\s*([\w-]+)/)?.[1]?.toLowerCase();
      if (!tagName || voidTags.has(tagName) || /\/\s*>$/.test(token)) continue;
      stack.push({
        excluded: ['script', 'style'].includes(tagName),
        localized: /\sdata-i18n(?:-html)?\s*=/.test(token),
        untranslated: /\stranslate\s*=\s*['"]no['"]/.test(token),
      });
      continue;
    }
    if (stack.some(({ excluded }) => excluded)) continue;
    if (stack.some(({ localized }) => localized)) continue;
    if (stack.some(({ untranslated }) => untranslated)) continue;
    const visibleText = token
      .replace(/__MSG_[A-Za-z][\w.-]*__/g, '')
      .replace(/&(?:#\d+|#x[\da-f]+|[a-z][\w-]*);/gi, ' ');
    if (/\p{L}/u.test(visibleText)) {
      throw new Error(
        `${filePath} has hardcoded localized UI text: ${visibleText.trim()}`,
      );
    }
  }
}

export function validateLocalizationReferences(
  catalogs,
  sources = [
    ...collectLocalizationSources(extensionSourceDir),
    ...collectLocalizationSources(desktopUiSourceDir),
  ],
) {
  const defaultCatalog =
    catalogs.get(DEFAULT_LOCALE) || catalogs.get('en') || new Map();
  for (const { path: filePath, source } of sources) {
    for (const key of referencedLocalizationKeys(source)) {
      if (!defaultCatalog[key]?.message) {
        throw new Error(
          `${filePath} references missing localization key ${key}`,
        );
      }
    }
    validateLocalizedUiSource(filePath, source);
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
  validateLocalizationReferences(catalogs);
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

function ensureHighlightLifecycleContentScript(manifest) {
  const contentScript = manifest.content_scripts?.find((entry) =>
    entry.js?.includes('content.js'),
  );
  if (!contentScript) return;
  if (contentScript.js.includes(highlightLifecycleContentScript)) return;
  const contentIndex = contentScript.js.indexOf('content.js');
  if (contentIndex < 0) {
    throw new Error('Cannot stage highlight lifecycle without content.js');
  }
  contentScript.js.splice(contentIndex, 0, highlightLifecycleContentScript);
}

function ensureMarkdownExtractorContentScript(manifest) {
  const contentScript = manifest.content_scripts?.find((entry) =>
    entry.js?.includes('content.js'),
  );
  if (!contentScript) return;
  if (contentScript.js.includes(markdownExtractorContentScript)) return;
  const contentIndex = contentScript.js.indexOf('content.js');
  if (contentIndex < 0) {
    throw new Error('Cannot stage Markdown extractor without content.js');
  }
  contentScript.js.splice(contentIndex, 0, markdownExtractorContentScript);
}

function writeExtensionManifest(outDir, browser = 'chrome') {
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  ensurePageIdentityContentScript(manifest);
  ensureHighlightLifecycleContentScript(manifest);
  ensureMarkdownExtractorContentScript(manifest);
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
  writeExtensionHighlightLifecycleGlobal(staged);
  writeExtensionMarkdownExtractorGlobal(staged);
  writeExtensionBoundedResponseGlobal(staged);
  writeExtensionManifest(staged, 'chrome');
  return staged;
}

export function stageFirefoxExtensionAssets(outDir = firefoxExtensionOutDir) {
  const staged = stageTarget('extension', outDir);
  writeExtensionLocales(staged);
  writeExtensionPageIdentityGlobal(staged);
  writeExtensionHighlightLifecycleGlobal(staged);
  writeExtensionMarkdownExtractorGlobal(staged);
  writeExtensionBoundedResponseGlobal(staged);
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
