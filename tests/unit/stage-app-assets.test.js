import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupStagedAssets,
  stageExtensionAssets,
  stageFirefoxExtensionAssets,
} from '../../scripts/stage-app-assets.mjs';
import { DAEMON_PORTS } from '../../scripts/lib/desktop-test-runtime.mjs';
import { createTestExtensionDir } from '../fixtures/test-extension.mjs';

const stagedDirs = [];

afterEach(() => {
  while (stagedDirs.length > 0) {
    cleanupStagedAssets(stagedDirs.pop());
  }
});

describe('extension staged assets', () => {
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
    const extensionUiTokensSource = readFileSync(
      join(outDir, 'extension-ui-tokens.js'),
      'utf8',
    );
    expect(popupHtml).not.toContain('Desktop Shell');
    expect(popupHtml).not.toContain('Setup Required');
    expect(popupHtml).not.toContain('Connection');
    expect(popupHtml).toContain('id="setupDesktopConnectBtn"');
    expect(popupHtml).toContain('DESKTOP OFFLINE');
    expect(popupHtml).toContain(
      'Start Browser Recall Desktop to resume live capture.',
    );
    expect(popupHtml).toContain('--bg-base: #f7f4ea');
    expect(popupHtml).toContain('--text-primary: #171713');
    expect(popupHtml).not.toContain(
      '.setup-action-btn:hover {\n        background: var(--recording-hot);',
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
    expect(popupHtml).toContain('Check Again');
    expect(popupHtml).not.toContain('Pair with desktop');
    expect(popupHtml).not.toContain('Try to reconnect');
  });

  it('keeps the unsupported-page popup message visible', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'browser-recall-stage-test-'));
    stagedDirs.push(outDir);
    stageExtensionAssets(outDir);

    const popupSource = readFileSync(join(outDir, 'popup.js'), 'utf8');
    expect(popupSource).toContain('function showUnavailablePage');
    expect(popupSource).toContain(
      "showUnavailablePage('Not available for this page')",
    );
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
    const snapshotViewerSource = readFileSync(
      join(outDir, 'snapshot-viewer.js'),
      'utf8',
    );
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json')));
    const snapshotViewerHtml = readFileSync(
      join(outDir, 'snapshot-viewer.html'),
      'utf8',
    );

    expect(manifest.content_scripts[1].js).toEqual([
      'browser-api.js',
      'extension-surface.js',
      'content.js',
    ]);
    expect(snapshotViewerHtml).toContain(
      '<script src="extension-surface.js"></script>',
    );
    expect(extensionSurfaceSource).toContain(
      'globalThis.browserRecallExtensionSurface',
    );
    expect(extensionSurfaceSource).toContain('--br-bg-base: #f7f4ea');
    expect(extensionSurfaceSource).toContain('--br-text-primary: #171713');
    expect(extensionSurfaceSource).toContain('br-note-label');
    expect(extensionSurfaceSource).toContain('br-note-excerpt');
    expect(extensionSurfaceSource).toContain('positionNearRect');
    expect(contentSource).toContain('data-note-index');
    expect(contentSource).toContain('var(--br-border-section)');
    expect(contentSource).not.toContain(
      '.delete-btn:hover { background: var(--br-accent-red-soft)',
    );
    expect(contentSource).not.toContain('SCHEME_PALETTES');
    expect(contentSource).not.toContain('EXTENSION_SURFACE_CSS');
    expect(contentSource).toContain('extensionSurface.positionNearRect');
    expect(snapshotViewerSource).toContain('extensionSurface.positionNearRect');
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

  it('stages browser API shim before first-party extension entry points', () => {
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
      'browser-api.js',
      'extension-surface.js',
      'content.js',
    ]);
    expect(manifest.content_scripts[2].js).toEqual([
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
    expect(manifest.background).toEqual({
      scripts: ['browser-api.js', 'background.js'],
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
