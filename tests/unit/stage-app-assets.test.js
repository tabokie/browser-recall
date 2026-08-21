import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  copyStagedSourceTree,
  cleanupStagedAssets,
  defaultArtifactDirs,
  discoverLocalizationSources,
  stageExtensionAssets,
  stageFirefoxExtensionAssets,
  validateLocalizationReferences,
  validateLocalizedUiSource,
  validateLocaleMessage,
} from '../../scripts/stage-app-assets.mjs';
import { DAEMON_PORTS } from '../../scripts/lib/desktop-test-runtime.mjs';
import {
  collectDesktopArtifacts,
  replaceWindowsOutput,
} from '../../scripts/collect-desktop-artifacts.mjs';
import { createTestExtensionDir } from '../fixtures/test-extension.mjs';

const stagedDirs = [];

afterEach(() => {
  while (stagedDirs.length > 0) {
    cleanupStagedAssets(stagedDirs.pop());
  }
});

describe('extension staged assets', () => {
  it('rejects source localization references missing from the catalog', () => {
    expect(() =>
      validateLocalizationReferences(
        new Map([['en', { extensionKnown: { message: 'Known' } }]]),
        [{ path: 'popup.js', source: "tr('extensionMissing', 'Missing')" }],
      ),
    ).toThrow('popup.js references missing localization key extensionMissing');
  });

  it('rejects hardcoded user-facing attributes in extension source', () => {
    expect(() =>
      validateLocalizedUiSource(
        'popup.js',
        "button.title = 'Hardcoded title'; input.placeholder = 'Hardcoded placeholder';",
      ),
    ).toThrow('popup.js has hardcoded localized UI text');
  });

  it('rejects interpolated hardcoded user-facing attributes', () => {
    expect(() =>
      validateLocalizedUiSource('popup.js', 'button.title = `Delete ${name}`;'),
    ).toThrow('popup.js has hardcoded localized UI text');
  });

  it('rejects hardcoded user-facing text rendered through innerHTML', () => {
    expect(() =>
      validateLocalizedUiSource(
        'popup.js',
        "panel.innerHTML = '<p>Page details unavailable</p>';",
      ),
    ).toThrow('popup.js has hardcoded localized UI text');
  });

  it('rejects hardcoded static text in an interpolated innerHTML template', () => {
    expect(() =>
      validateLocalizedUiSource(
        'popup.js',
        'panel.innerHTML = `<p>Delete ${name}</p>`;',
      ),
    ).toThrow('popup.js has hardcoded localized UI text');
  });

  it('rejects hardcoded HTML text nodes', () => {
    expect(() =>
      validateLocalizedUiSource(
        'popup.html',
        '<main><p>Hardcoded panel</p></main>',
      ),
    ).toThrow('popup.html has hardcoded localized UI text');
  });

  it('excludes AppleDouble metadata at the source-tree boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-recall-source-tree-'));
    const sourceDir = join(root, 'source');
    const outDir = join(root, 'staged');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'options-stub.html'),
      '<p data-i18n="extensionKnown"></p>',
    );
    writeFileSync(
      join(sourceDir, '._options-stub.html'),
      '\u0000\u0005\u0016\u0007Mac OS X\u0000\u0002',
    );
    writeFileSync(
      join(sourceDir, '._intentional.html'),
      '<p data-i18n="extensionKnown"></p>',
    );
    writeFileSync(join(sourceDir, '.DS_Store'), 'Finder metadata');
    stagedDirs.push(root);

    const sources = discoverLocalizationSources([sourceDir], {
      relativeRoot: root,
    });
    expect(sources.map(({ path }) => path).sort()).toEqual(
      [
        join('source', '._intentional.html'),
        join('source', 'options-stub.html'),
      ].sort(),
    );
    expect(() =>
      validateLocalizationReferences(
        new Map([['en', { extensionKnown: { message: 'Known' } }]]),
        sources,
      ),
    ).not.toThrow();

    copyStagedSourceTree(sourceDir, outDir);
    expect(existsSync(join(outDir, 'options-stub.html'))).toBe(true);
    expect(existsSync(join(outDir, '._options-stub.html'))).toBe(false);
    expect(existsSync(join(outDir, '._intentional.html'))).toBe(true);
    expect(existsSync(join(outDir, '.DS_Store'))).toBe(false);
    expect(() =>
      validateLocalizationReferences(new Map(), [
        {
          path: 'injected/._options-stub.html',
          source: 'Mac OS X',
        },
      ]),
    ).toThrow('has hardcoded localized UI text');
  });

  it('rejects localized HTML whose tags are misnested', () => {
    expect(() =>
      validateLocaleMessage(
        'test',
        'richHelp',
        '<strong><em>Help</em></strong>',
        '<strong><em>Help</strong></em>',
      ),
    ).toThrow('Locale test has incompatible HTML structure for richHelp');
  });

  it('uses one dist artifact tree for default staged apps', () => {
    expect(
      defaultArtifactDirs.chromeExtension.endsWith(
        join('dist', 'extension', 'chrome'),
      ),
    ).toBe(true);
    expect(
      defaultArtifactDirs.firefoxExtension.endsWith(
        join('dist', 'extension', 'firefox'),
      ),
    ).toBe(true);
    expect(
      defaultArtifactDirs.desktopUi.endsWith(join('dist', 'desktop', 'ui')),
    ).toBe(true);
  });

  it('stages popup entity helpers into the loadable extension bundle', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const popupSource = readFileSync(join(outDir, 'popup.js'), 'utf8');
    expect(popupSource).toMatch(
      /import\s+\{\s*pageKey\s*\}\s+from\s+['"]\.\/entity-types\.js['"]/,
    );
    expect(popupSource).not.toContain('../../packages/core/');

    const entityTypesSource = readFileSync(
      join(outDir, 'entity-types.js'),
      'utf8',
    );
    expect(entityTypesSource).toBe("export * from './core/entity-types.js';\n");
    const coreEntityTypes = readFileSync(
      join(outDir, 'core/entity-types.js'),
      'utf8',
    );
    expect(coreEntityTypes).toContain('export const listKey = (id) =>');
    expect(coreEntityTypes).toContain('export const pageKey = (slug) =>');

    const backgroundSource = readFileSync(
      join(outDir, 'background.js'),
      'utf8',
    );
    expect(backgroundSource).toContain("from './core/snapshot-html.js';");
    expect(
      readFileSync(join(outDir, 'core/snapshot-html.js'), 'utf8'),
    ).toContain('export function prepareSnapshotHtml');
    const boundedResponseSource = readFileSync(
      join(outDir, 'browser-recall-bounded-response.js'),
      'utf8',
    );
    expect(boundedResponseSource).toContain(
      'globalThis.browserRecallBoundedResponse',
    );
    expect(
      readFileSync(
        join(outDir, 'browser-recall-snapshot-capture-budget.js'),
        'utf8',
      ),
    ).toContain('globalThis.browserRecallSnapshotCaptureBudget');
    expect(
      readFileSync(join(outDir, 'snapshot-capture-budget.js'), 'utf8'),
    ).toBe("export * from './core/snapshot-capture-budget.js';\n");
    const savepageBridgeSource = readFileSync(
      join(outDir, 'savepage-bridge.js'),
      'utf8',
    );
    expect(savepageBridgeSource).toContain(
      "'browser-recall-bounded-response.js',\n      'browser-recall-snapshot-capture-budget.js',\n      'savepage/content.js'",
    );
  });

  it('stages browser-native extension localization files', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    const messages = JSON.parse(
      readFileSync(join(outDir, '_locales', 'en', 'messages.json'), 'utf8'),
    );
    const coreMessages = JSON.parse(
      readFileSync(
        join(outDir, 'core', 'locales', 'en', 'messages.json'),
        'utf8',
      ),
    );
    const zhMessages = JSON.parse(
      readFileSync(join(outDir, '_locales', 'zh_CN', 'messages.json'), 'utf8'),
    );
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    expect(manifest.commands['highlight-selection'].description).toBe(
      '__MSG_commandHighlightSelection__',
    );
    expect(messages.extensionName.message).toBe('Browser Recall');
    expect(messages.commandCaptureSnapshot.message).toBe(
      'Capture snapshot of current page',
    );
    expect(messages.desktopSync).toBeUndefined();
    expect(coreMessages.extensionName.message).toBe('Browser Recall');
    expect(coreMessages.desktopSync).toBeUndefined();
    expect(zhMessages.extensionCaptureFrame.message).toBe('捕获画面');
    expect(zhMessages.desktopSync).toBeUndefined();
  });

  it('keeps shared CSS imports valid in the staged extension bundle', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const sharedCss = readFileSync(join(outDir, 'shared.css'), 'utf8');
    expect(sharedCss.startsWith("@import url('./core/shared.css');")).toBe(
      true,
    );
    expect(sharedCss).not.toContain('../../packages/core/');
  });

  it('stages the popup without the connected desktop shell card', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const popupHtml = readFileSync(join(outDir, 'popup.html'), 'utf8');
    const popupSource = readFileSync(join(outDir, 'popup.js'), 'utf8');
    const backgroundSource = readFileSync(
      join(outDir, 'background.js'),
      'utf8',
    );
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    const extensionUiTokensSource = readFileSync(
      join(outDir, 'extension-ui-tokens.js'),
      'utf8',
    );
    expect(manifest.action.default_popup).toBeUndefined();
    expect(backgroundSource).toContain('chrome.action.onClicked.addListener');
    expect(backgroundSource).toMatch(
      /try\s*\{\s*await setPreparedActionPopup\(token, tabId, popupPath\)/,
    );
    expect(backgroundSource).toContain(
      'await releasePreparedActionPopup(token);',
    );
    expect(backgroundSource).not.toContain('schedulePreparedPopupPrewarm');
    expect(backgroundSource).not.toContain('POPUP_BOOTSTRAP_SESSION_KEY');
    expect(backgroundSource).not.toContain('schedulePreparedActionPopupClear');
    expect(popupHtml).not.toContain('Desktop Shell');
    expect(popupHtml).not.toContain('Setup Required');
    expect(popupHtml).not.toContain('Connection');
    expect(popupHtml).not.toContain('id="desktopOpenBtn"');
    expect(popupHtml).not.toContain('id="desktopConnectBtn"');
    expect(popupHtml).toContain('id="pageDiagnosticSection"');
    expect(popupHtml).not.toContain('id="setup-required"');
    expect(popupHtml).toContain('LOOKING FOR BROWSER RECALL DESKTOP');
    expect(popupHtml).not.toContain('DESKTOP OFFLINE');
    expect(popupHtml).toContain('--bg-base: #f7f4ea');
    expect(popupHtml).toContain('--text-primary: #171713');
    expect(popupHtml).not.toContain('href="shared.css"');
    expect(popupHtml).toContain('data-popup-hidden="true"');
    expect(popupHtml).toContain('opacity: 0');
    expect(popupHtml).toContain('width: 296px');
    expect(popupHtml).toContain('min-height: 320px');
    expect(popupHtml).toContain('body.popup-compact');
    expect(popupHtml).toContain('min-height: 0');
    expect(popupHtml).toContain('<div id="dashboard">');
    expect(popupHtml).toContain('@keyframes spin');
    expect(popupHtml).not.toContain(
      '.page-diagnostic-link:hover {\n        background: var(--recording-hot);',
    );
    expect(popupHtml).not.toContain(
      '.delete-btn:hover {\n        color: var(--accent-red);',
    );
    expect(popupHtml).not.toContain(
      '.note-action-btn.delete:hover {\n        background: var(--accent-red-soft);',
    );
    expect(popupSource).toContain("from './extension-ui-tokens.js'");
    expect(extensionUiTokensSource).toContain(
      "EXTENSION_PAPER_COLOR = '#f7f4ea'",
    );
    expect(extensionUiTokensSource).toContain(
      "EXTENSION_ERROR_COLOR = '#ff2d20'",
    );
    expect(popupSource).not.toContain('background:rgba(180,30,30,0.92)');
    expect(popupHtml).toContain('.recording-toggle:hover');
    expect(popupHtml).not.toContain('Check Again');
    expect(popupHtml).not.toContain('Pair with desktop');
    expect(popupHtml).not.toContain('Try to reconnect');
  });

  it('keeps the unsupported-page popup message visible', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const popupSource = readFileSync(join(outDir, 'popup.js'), 'utf8');
    expect(popupSource).toContain('function showUnavailablePage');
    expect(popupSource).toContain("tr('extensionNotAvailablePage'");
    expect(popupSource).toContain("'Not available for this page'");
  });

  it('moves shortcut management into the extension options page', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const popupHtml = readFileSync(join(outDir, 'popup.html'), 'utf8');
    const optionsHtml = readFileSync(join(outDir, 'options-stub.html'), 'utf8');
    const optionsSource = readFileSync(join(outDir, 'options-stub.js'), 'utf8');
    const extensionSurfaceCss = readFileSync(
      join(outDir, 'extension-surface.css'),
      'utf8',
    );

    expect(popupHtml).not.toContain('shortcut-bar');
    expect(optionsHtml).toContain('Keyboard Shortcuts');
    expect(optionsHtml).toContain('extension-surface.css');
    expect(optionsHtml).toContain('class="extension-page"');
    expect(extensionSurfaceCss).toContain('--bg-base: #f7f4ea');
    expect(extensionSurfaceCss).toContain('--text-primary: #171713');
    expect(extensionSurfaceCss).toContain('width: min(380px');
    expect(extensionSurfaceCss).toContain('.extension-button');
    expect(extensionSurfaceCss).not.toContain('background: var(--accent-red);');
    expect(optionsHtml).toContain('id="customizeShortcuts"');
    expect(optionsSource).toContain('chrome.commands.getAll()');
    expect(optionsSource).toContain('chrome://extensions/shortcuts');
  });

  it('keeps content highlight surfaces on the popup visual system', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const contentSource = readFileSync(join(outDir, 'content.js'), 'utf8');
    const extensionSurfaceSource = readFileSync(
      join(outDir, 'extension-surface.js'),
      'utf8',
    );
    const pageIdentitySource = readFileSync(
      join(outDir, 'browser-recall-page-identity.js'),
      'utf8',
    );
    const highlightLifecycleSource = readFileSync(
      join(outDir, 'browser-recall-highlight-lifecycle.js'),
      'utf8',
    );
    const snapshotViewerSource = readFileSync(
      join(outDir, 'snapshot-viewer.js'),
      'utf8',
    );
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    const snapshotViewerHtml = readFileSync(
      join(outDir, 'snapshot-viewer.html'),
      'utf8',
    );

    expect(manifest.content_scripts[1].js.at(-2)).toBe(
      'browser-recall-markdown-extractor.js',
    );
    expect(pageIdentitySource).toContain(
      'globalThis.browserRecallPageIdentity',
    );
    expect(contentSource).toContain('globalThis.browserRecallPageIdentity');
    expect(highlightLifecycleSource).toContain(
      'globalThis.browserRecallHighlightLifecycle',
    );
    expect(contentSource).toContain(
      'globalThis.browserRecallHighlightLifecycle',
    );
    expect(snapshotViewerHtml).toContain(
      '<script src="extension-surface.js"></script>',
    );
    expect(extensionSurfaceSource).toContain(
      'globalThis.browserRecallExtensionSurface',
    );
    expect(extensionSurfaceSource).toContain('--br-bg-base: #f7f4ea');
    expect(extensionSurfaceSource).toContain('--br-text-primary: #171713');
    expect(extensionSurfaceSource).toContain('highlightEntryHtml');
    expect(extensionSurfaceSource).toContain('openHighlightNoteEditor');
    expect(extensionSurfaceSource).toContain(
      'function createHighlightEditOverlay',
    );
    expect(extensionSurfaceSource).toContain(
      'border-left: 3px solid var(--br-accent-red, var(--accent-red));',
    );
    expect(extensionSurfaceSource).toContain('positionNearRect');
    expect(contentSource).not.toContain('data-note-index');
    expect(contentSource).toContain(
      '.panel::-webkit-scrollbar { display: none; width: 0; height: 0; }',
    );
    expect(contentSource).not.toContain('extensionNoAnnotation');
    expect(contentSource).toContain('var(--br-border-section)');
    expect(contentSource).not.toContain(
      '.delete-btn:hover { background: var(--br-accent-red-soft)',
    );
    expect(contentSource).not.toContain('SCHEME_PALETTES');
    expect(contentSource).not.toContain('EXTENSION_SURFACE_CSS');
    expect(contentSource).toContain(
      'extensionSurface.createHighlightEditOverlay',
    );
    expect(snapshotViewerSource).toContain(
      'extensionSurface.createHighlightEditOverlay',
    );
    expect(contentSource).not.toContain('function createHighlightEditOverlay');
    expect(snapshotViewerSource).not.toContain('const OVERLAY_STYLE');
    expect(snapshotViewerSource).toContain("from './extension-ui-tokens.js'");
    expect(snapshotViewerSource).not.toContain(
      'background:rgba(180,30,30,0.92)',
    );
    expect(snapshotViewerSource).not.toContain(
      '.delete-btn:hover { background: var(--br-accent-red-soft)',
    );
    expect(snapshotViewerSource).not.toContain('EXTENSION_SURFACE_CSS');
    expect(snapshotViewerSource).not.toContain('getSchemePalette');
  });

  it('stages every packaged runtime icon and no removed down-state icons', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const {
      DEFAULT_ICON_PATHS,
      SPECIAL_LIST_ICON_PATHS,
      SPECIAL_MIXED_ICON_PATHS,
      SPECIAL_NOTE_ICON_PATHS,
      STOP_RECORDING_ICON_PATHS,
    } = await import('../../apps/extension/icon-paths.js');
    const runtimeIconPaths = [
      DEFAULT_ICON_PATHS,
      STOP_RECORDING_ICON_PATHS,
      SPECIAL_LIST_ICON_PATHS,
      SPECIAL_NOTE_ICON_PATHS,
      SPECIAL_MIXED_ICON_PATHS,
    ];
    const generatedExtensionIcon = readFileSync(
      join(process.cwd(), 'apps/extension/icons/icon128.png'),
    );
    const extensionIcon = readFileSync(join(outDir, 'icons/icon128.png'));
    expect(extensionIcon.equals(generatedExtensionIcon)).toBe(true);
    for (const iconPaths of runtimeIconPaths) {
      for (const iconPath of Object.values(iconPaths)) {
        expect(existsSync(join(outDir, iconPath))).toBe(true);
      }
    }
    expect(existsSync(join(outDir, 'icons/icon128-down.png'))).toBe(false);
    expect(existsSync(join(outDir, 'icons/icon128-special.png'))).toBe(false);
  });

  it('stages explicit build metadata and the browser API shim before first-party extension entry points', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
      type: 'module',
    });
    expect(manifest.content_scripts[0].js).toEqual([
      'spa-navigation-bridge.js',
    ]);
    expect(manifest.content_scripts[1].js).toEqual([
      'browser-build-target.js',
      'browser-api.js',
      'extension-surface.js',
      'browser-recall-page-identity.js',
      'browser-recall-highlight-lifecycle.js',
      'browser-recall-markdown-extractor.js',
      'content.js',
    ]);
    expect(manifest.content_scripts[2].js).toEqual([
      'browser-build-target.js',
      'browser-api.js',
      'savepage/content-fontface.js',
    ]);
    expect(readFileSync(join(outDir, 'popup.html'), 'utf8')).toContain(
      '<script src="browser-api.js"></script>',
    );
    expect(readFileSync(join(outDir, 'background.js'), 'utf8')).toContain(
      "import './browser-api.js';",
    );
    expect(existsSync(join(outDir, 'background-test-actions.js'))).toBe(false);
    expect(existsSync(join(outDir, 'background-test-control.js'))).toBe(false);
  });

  it('can stage a Firefox manifest with background module scripts', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-firefox-test-'));
    stagedDirs.push(outDir);
    stageFirefoxExtensionAssets(outDir);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.background).toEqual({
      scripts: ['background.js'],
      type: 'module',
    });
    expect(manifest.background.service_worker).toBeUndefined();
    expect(manifest.browser_specific_settings.gecko.id).toBe(
      'browser-recall@example.invalid',
    );
    expect(manifest.content_security_policy.extension_pages).toContain(
      'connect-src',
    );
    expect(manifest.content_security_policy.extension_pages).toContain(
      'ws://127.0.0.1:*',
    );
    expect(manifest.content_security_policy.extension_pages).not.toContain(
      'ws://localhost:*',
    );
    expect(manifest.content_security_policy.extension_pages).not.toContain(
      'http://127.0.0.1:*',
    );
    expect(manifest.content_security_policy.extension_pages).not.toContain(
      'http://localhost:*',
    );
    expect(
      manifest.browser_specific_settings.gecko.data_collection_permissions,
    ).toEqual({
      required: ['none'],
    });
  });

  it('pins E2E test extensions to non-production daemon ports', () => {
    const outDir = createTestExtensionDir(
      'browser-recall-stage-test-extension-',
    );
    stagedDirs.push(outDir);

    const connectorSource = readFileSync(
      join(outDir, 'connector', 'ws-client.js'),
      'utf8',
    );
    expect(connectorSource).toContain(
      `globalThis.__BROWSER_RECALL_CONNECTOR_PORTS = ${JSON.stringify(DAEMON_PORTS)};`,
    );
    expect(DAEMON_PORTS).not.toContain(28471);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    expect(manifest.background.service_worker).toBe('background-test.js');
    const testBackground = readFileSync(
      join(outDir, 'background-test.js'),
      'utf8',
    );
    expect(testBackground).toBe(
      "import './background-test-actions.js';\nimport './background.js';\nimport './background-test-control.js';\n",
    );
    expect(existsSync(join(outDir, 'background-test-actions.js'))).toBe(true);
    expect(existsSync(join(outDir, 'background-test-control.js'))).toBe(true);
    expect(existsSync(join(outDir, 'core', 'package.json'))).toBe(false);
    expect(
      testBackground.indexOf("import './background-test-actions.js';"),
    ).toBeLessThan(testBackground.indexOf("import './background.js';"));
    expect(testBackground).toContain("import './background-test-control.js';");
    const testActions = readFileSync(
      join(outDir, 'background-test-actions.js'),
      'utf8',
    );
    expect(testActions).toContain('BACKGROUND_TEST_ACTIONS');
    const testControl = readFileSync(
      join(outDir, 'background-test-control.js'),
      'utf8',
    );
    expect(testControl).toContain(
      "import { BACKGROUND_TEST_ACTIONS } from './background-test-actions.js';",
    );
    const productionBackground = readFileSync(
      join(outDir, 'background.js'),
      'utf8',
    );
    expect(productionBackground).toContain(
      'browserRecallBackgroundTestActions?.has(request.action)',
    );
    expect(productionBackground).not.toContain("case 'resetForTest'");
    expect(productionBackground).not.toContain("case 'seedTestData'");
  });
});

describe('desktop artifact collection', () => {
  it('promotes complete Windows output while replacing the executable', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    const cargoReleaseDir = join(root, 'target-release');
    const outDir = join(root, 'dist-desktop');
    mkdirSync(join(cargoReleaseDir, 'bundle', 'msi'), { recursive: true });
    mkdirSync(join(outDir, 'windows', 'bin'), { recursive: true });
    mkdirSync(join(outDir, 'windows', 'stale-bundle'), { recursive: true });
    writeFileSync(
      join(cargoReleaseDir, 'browser-recall-desktop.exe'),
      'new release',
    );
    writeFileSync(
      join(cargoReleaseDir, 'bundle', 'msi', 'Browser Recall.msi'),
      'new installer',
    );
    writeFileSync(
      join(outDir, 'windows', 'bin', 'browser-recall-desktop.exe'),
      'old release',
    );
    writeFileSync(
      join(outDir, 'windows', 'stale-bundle', 'Old Installer.msi'),
      'stale installer',
    );
    stagedDirs.push(root);

    collectDesktopArtifacts({
      cargoReleaseDir,
      outDir,
      platformName: 'windows',
      bundles: ['msi'],
    });

    expect(
      readFileSync(
        join(outDir, 'windows', 'bin', 'browser-recall-desktop.exe'),
        'utf8',
      ),
    ).toBe('new release');
    expect(
      readFileSync(
        join(outDir, 'windows', 'msi', 'Browser Recall.msi'),
        'utf8',
      ),
    ).toBe('new installer');
    expect(existsSync(join(outDir, 'windows', 'stale-bundle'))).toBe(false);
  });

  it('restores the complete prior Windows output when remainder promotion fails', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-rollback-'),
    );
    const platformOutDir = join(root, 'windows');
    const stagedDir = join(root, 'windows.staging');
    mkdirSync(join(platformOutDir, 'bin'), { recursive: true });
    mkdirSync(join(platformOutDir, 'msi'), { recursive: true });
    mkdirSync(join(stagedDir, 'bin'), { recursive: true });
    mkdirSync(join(stagedDir, 'msi'), { recursive: true });
    writeFileSync(
      join(platformOutDir, 'bin', 'browser-recall-desktop.exe'),
      'old release',
    );
    writeFileSync(join(platformOutDir, 'msi', 'Browser Recall.msi'), 'old msi');
    writeFileSync(
      join(stagedDir, 'bin', 'browser-recall-desktop.exe'),
      'new release',
    );
    writeFileSync(join(stagedDir, 'msi', 'Browser Recall.msi'), 'new msi');
    stagedDirs.push(root);

    expect(() =>
      replaceWindowsOutput(platformOutDir, stagedDir, () => {}, {
        promote(_source, destination) {
          mkdirSync(join(destination, 'msi'), { recursive: true });
          writeFileSync(
            join(destination, 'msi', 'Browser Recall.msi'),
            'partial new msi',
          );
          throw new Error('simulated remainder promotion failure');
        },
      }),
    ).toThrow('simulated remainder promotion failure');

    expect(
      readFileSync(
        join(platformOutDir, 'bin', 'browser-recall-desktop.exe'),
        'utf8',
      ),
    ).toBe('old release');
    expect(
      readFileSync(join(platformOutDir, 'msi', 'Browser Recall.msi'), 'utf8'),
    ).toBe('old msi');
    expect(
      readdirSync(root).filter((name) => name.startsWith('windows.backup-')),
    ).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    'replaces Windows output while the previously collected executable is running',
    async () => {
      const root = mkdtempSync(
        join(tmpdir(), 'browser-recall-desktop-artifacts-'),
      );
      const cargoReleaseDir = join(root, 'target-release');
      const outDir = join(root, 'dist-desktop');
      const currentExecutable = join(
        outDir,
        'windows',
        'bin',
        'browser-recall-desktop.exe',
      );
      mkdirSync(cargoReleaseDir, { recursive: true });
      mkdirSync(join(outDir, 'windows', 'bin'), { recursive: true });
      writeFileSync(
        join(cargoReleaseDir, 'browser-recall-desktop.exe'),
        'new release',
      );
      copyFileSync(
        join(process.env.WINDIR, 'System32', 'ping.exe'),
        currentExecutable,
      );
      stagedDirs.push(root);

      const runningArtifact = spawn(currentExecutable, ['-t', '127.0.0.1'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const warnings = [];
      await new Promise((resolve, reject) => {
        runningArtifact.once('spawn', resolve);
        runningArtifact.once('error', reject);
      });

      try {
        collectDesktopArtifacts({
          cargoReleaseDir,
          outDir,
          platformName: 'windows',
          warn: (message) => warnings.push(message),
        });

        expect(readFileSync(currentExecutable, 'utf8')).toBe('new release');
        expect(runningArtifact.exitCode).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(
          'Build succeeded and installed the new desktop executable',
        );
        expect(warnings[0]).toContain(
          'Quit Browser Recall from its tray menu; closing the window only hides it',
        );
        expect(warnings[0]).not.toContain('EPERM');
      } finally {
        runningArtifact.kill();
        await new Promise((resolve) => runningArtifact.once('close', resolve));
      }
    },
  );

  it('copies the expected platform executable and bundle into dist/desktop shape', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    const cargoReleaseDir = join(root, 'target-release');
    const outDir = join(root, 'dist-desktop');
    mkdirSync(join(cargoReleaseDir, 'bundle', 'macos', 'Browser Recall.app'), {
      recursive: true,
    });
    writeFileSync(join(cargoReleaseDir, 'browser-recall-desktop'), 'bin');
    writeFileSync(
      join(
        cargoReleaseDir,
        'bundle',
        'macos',
        'Browser Recall.app',
        'Contents',
      ),
      'app',
    );

    const collected = collectDesktopArtifacts({
      cargoReleaseDir,
      outDir,
      platformName: 'macos',
      bundles: ['app'],
    });
    stagedDirs.push(root);

    expect(collected).toBe(outDir);
    expect(
      existsSync(join(outDir, 'macos', 'bin', 'browser-recall-desktop')),
    ).toBe(true);
    expect(existsSync(join(outDir, 'macos', 'app', 'Browser Recall.app'))).toBe(
      true,
    );
  });

  it('clears stale platform output before collecting current bundle types', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    const cargoReleaseDir = join(root, 'target-release');
    const outDir = join(root, 'dist-desktop');
    mkdirSync(join(cargoReleaseDir, 'bundle', 'dmg'), { recursive: true });
    mkdirSync(join(outDir, 'macos', 'app', 'Old.app'), { recursive: true });
    writeFileSync(join(cargoReleaseDir, 'browser-recall-desktop'), 'bin');
    writeFileSync(
      join(cargoReleaseDir, 'bundle', 'dmg', 'Browser Recall.dmg'),
      'dmg',
    );

    collectDesktopArtifacts({
      cargoReleaseDir,
      outDir,
      platformName: 'macos',
      bundles: ['dmg'],
    });
    stagedDirs.push(root);

    expect(existsSync(join(outDir, 'macos', 'app', 'Old.app'))).toBe(false);
    expect(existsSync(join(outDir, 'macos', 'dmg', 'Browser Recall.dmg'))).toBe(
      true,
    );
  });

  it('does not copy wrong-platform executables into the platform output', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    const cargoReleaseDir = join(root, 'target-release');
    const outDir = join(root, 'dist-desktop');
    mkdirSync(join(cargoReleaseDir, 'bundle', 'macos', 'Browser Recall.app'), {
      recursive: true,
    });
    writeFileSync(join(cargoReleaseDir, 'browser-recall-desktop'), 'bin');
    writeFileSync(join(cargoReleaseDir, 'browser-recall-desktop.exe'), 'exe');

    collectDesktopArtifacts({
      cargoReleaseDir,
      outDir,
      platformName: 'macos',
      bundles: ['app'],
    });
    stagedDirs.push(root);

    expect(
      existsSync(join(outDir, 'macos', 'bin', 'browser-recall-desktop')),
    ).toBe(true);
    expect(
      existsSync(join(outDir, 'macos', 'bin', 'browser-recall-desktop.exe')),
    ).toBe(false);
  });

  it('fails when expected desktop artifacts are missing', () => {
    const root = mkdtempSync(
      join(tmpdir(), 'browser-recall-desktop-artifacts-'),
    );
    stagedDirs.push(root);

    expect(() =>
      collectDesktopArtifacts({
        cargoReleaseDir: join(root, 'target-release'),
        outDir: join(root, 'dist-desktop'),
        platformName: 'macos',
        bundles: ['app'],
      }),
    ).toThrow(/Missing release executable/);
  });
});
