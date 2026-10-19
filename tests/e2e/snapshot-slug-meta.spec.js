import { test, expect } from './fixtures.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { migrateSnapshotIdentity } from '../../scripts/migrate-snapshot-identity.mjs';
import { setSnapshotIdentity } from '../../packages/core/snapshot-html.js';
import {
  resetAndSeed,
  settingsCheckpoint,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
  longestLeftBorderRun,
} from './helpers.js';

async function setExtensionFileAccess(extContext, extensionId, fileAccess) {
  const extensionsPage = await extContext.newPage();
  await extensionsPage.goto('chrome://extensions/');
  await extensionsPage.evaluate(
    ({ id, fileAccess: allowed }) =>
      new Promise((resolve, reject) => {
        chrome.developerPrivate.updateExtensionConfiguration(
          { extensionId: id, fileAccess: allowed },
          () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          },
        );
      }),
    { id: extensionId, fileAccess },
  );
  await extensionsPage.close();
}

function snapshotSidecarPath(slug, timestamp, ext) {
  const stem = `${slug}-${timestamp}`;
  const shard = crypto
    .createHash('sha256')
    .update(stem)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `objects/snapshots/${shard}/${stem}.${ext}`;
}

function currentSnapshotHtml({ slug, url, html }) {
  return setSnapshotIdentity(html, { slug, url });
}

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const helper = await openHelperPage(extContext, extensionId);
  const prepared = await helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (tabs.length !== 1) {
      return {
        success: false,
        error: `Expected one source tab for ${pageUrl}, found ${tabs.length}`,
      };
    }
    return chrome.runtime.sendMessage({
      action: 'preparePopupBootstrapForTest',
      tabId: tabs[0].id,
    });
  }, url);
  await helper.close();
  if (!prepared?.success) {
    throw new Error(
      `preparePopupBootstrapForTest failed for ${title}: ${JSON.stringify(prepared)}`,
    );
  }
  const popup = await extContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  return popup;
}

async function getActionIconForUrl(helper, url) {
  return helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (tabs.length !== 1 || !Number.isFinite(tabs[0].id)) return null;
    const response = await chrome.runtime.sendMessage({
      action: 'getActionIconForTest',
      tabId: tabs[0].id,
    });
    if (!response?.success) {
      throw new Error(response?.error || 'getActionIconForTest failed');
    }
    return response.path;
  }, url);
}

async function getActionBadgeForUrl(helper, url) {
  return helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (tabs.length !== 1 || !Number.isFinite(tabs[0].id)) return null;
    return {
      text: await chrome.action.getBadgeText({ tabId: tabs[0].id }),
      title: await chrome.action.getTitle({ tabId: tabs[0].id }),
    };
  }, url);
}

test.describe('Snapshot slug meta tag', () => {
  test('prepares current snapshot HTML when it is read for replay', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    void setupDir;
    const originalUrl = 'https://example.com/legacy-snapshot-repair';
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const nestedLegacyHtml =
      '<!doctype html><html><body><legacy-inner-card id="legacy-inner-card"><template data-savepage-shadowroot=""><p id="legacy-inner-copy">Legacy nested shadow content</p></template></legacy-inner-card></body></html>';
    const escapedNestedLegacyHtml = nestedLegacyHtml
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Legacy Snapshot Repair',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head>
          <link rel="stylesheet" href="https://unavailable.example/legacy.css">
          <script id="savepage-shadowloader">savepage_ShadowLoader(5);</script>
        </head><body><p>Legacy snapshot body</p>
          <legacy-outer-card id="legacy-outer-card">
            <template data-savepage-shadowroot="">
              <iframe id="legacy-nested-shadow-frame" srcdoc="${escapedNestedLegacyHtml}"></iframe>
            </template>
          </legacy-outer-card>
        </body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: 'Legacy snapshot body',
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const response = await helper.evaluate(
      ({ pageSlug, ts }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug: pageSlug,
          timestamp: ts,
        }),
      { pageSlug: slug, ts: timestamp },
    );
    expect(response.success).toBe(true);
    expect(response.html).toContain(
      'data-browser-recall-unavailable-href="https://unavailable.example/legacy.css"',
    );
    expect(response.html).not.toContain('id="savepage-shadowloader"');
    expect(response.html).toContain(
      `<meta name="x-browser-recall-slug" content="${slug}">`,
    );

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    const frame = viewer.frameLocator('#frame');
    await expect
      .poll(() =>
        frame.locator('#legacy-outer-card').evaluate((outerCard) => {
          const nestedFrame = outerCard.shadowRoot?.querySelector(
            '#legacy-nested-shadow-frame',
          );
          const innerCard =
            nestedFrame?.contentDocument?.querySelector('#legacy-inner-card');
          return (
            innerCard?.shadowRoot?.querySelector('#legacy-inner-copy')
              ?.textContent ?? null
          );
        }),
      )
      .toBe('Legacy nested shadow content');

    await viewer.close();
    await helper.close();
  });

  test('snapshot shortcut reconnects during connector cold start', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/capture-cold-start-shortcut', {
      title: 'Capture Cold Start Shortcut',
      body: '<p>Cold-start shortcut snapshot content.</p>',
    });
    const pageUrl = localServer.url('/capture-cold-start-shortcut');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'restartConnectorRuntimeForTest' }),
    );
    await page.bringToFront();

    const commandResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'triggerCommandForTest',
        command: 'capture-snapshot',
      }),
    );
    expect(commandResp).toEqual({ success: true });

    await expect
      .poll(
        () =>
          helper.evaluate(
            (key) =>
              chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
            `page:${slug}`,
          ),
        { timeout: 10_000 },
      )
      .toMatchObject({
        success: true,
        value: { childIds: [expect.stringMatching(/^snapshot:/)] },
      });
    await helper.close();
    await page.close();
  });

  test('captured snapshots preserve inherited font sizes in the extension viewer', async ({
    extContext,
    extensionId,
    localServer,
  }) => {
    const frameHtml = (
      size,
    ) => `<!doctype html><html style="color: rgb(20, 30, 40)"><head>
      <style>html { font-size: ${size}% !important; } body { line-height: 1.6; }</style>
      </head><body><p>Frame text keeps its captured size.</p></body></html>`;
    localServer.addRawPage('/snapshot-font-same-origin', frameHtml(125));
    localServer.addRawPage('/snapshot-font-cross-origin', frameHtml(150));
    localServer.addRawPage(
      '/snapshot-inherited-font',
      `<!doctype html><html style="color: rgb(20, 30, 40)"><head>
        <title>Snapshot inherited font size</title>
        <style>body { line-height: 1.6; } h1 { font-size: 24px; }
          #relative-copy { font-size: 1.25rem; } #fixed-copy { font-size: 10px; }</style>
        </head><body><h1>Explicit heading size</h1><p id="inherited-copy">最近听了一</p>
        <p id="relative-copy">Relative text size</p><p id="fixed-copy">Explicit text size</p>
        <iframe id="same-origin" src="/snapshot-font-same-origin"></iframe>
        <iframe id="cross-origin" src="http://localhost:${localServer.port}/snapshot-font-cross-origin"></iframe>
        </body></html>`,
    );
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
    const pageUrl = localServer.url('/snapshot-inherited-font');
    const slug = getSlugForUrl(pageUrl);
    const page = await extContext.newPage();
    const helper = await openHelperPage(extContext, extensionId);
    const preferences = await extContext.newPage();
    let viewer;
    let originalFontSize;
    const setDefaultFontSize = (value) =>
      preferences.evaluate(
        (fontSize) =>
          new Promise((resolve, reject) => {
            chrome.settingsPrivate.setPref(
              'webkit.webprefs.default_font_size',
              fontSize,
              '',
              (success) => {
                const error = chrome.runtime.lastError;
                if (error || !success) {
                  reject(
                    new Error(error?.message || 'Could not set font size'),
                  );
                } else resolve();
              },
            );
          }),
        value,
      );
    try {
      await preferences.goto('chrome://settings/fonts');
      originalFontSize = await preferences.evaluate(
        () =>
          new Promise((resolve) => {
            chrome.settingsPrivate.getPref(
              'webkit.webprefs.default_font_size',
              (pref) => resolve(pref.value),
            );
          }),
      );
      await setDefaultFontSize(16);
      await page.goto(pageUrl);
      await expect(page.locator('#inherited-copy')).toHaveCSS(
        'font-size',
        '16px',
      );
      await expect(page.frameLocator('#same-origin').locator('p')).toHaveCSS(
        'font-size',
        '20px',
      );
      await expect(page.frameLocator('#cross-origin').locator('p')).toHaveCSS(
        'font-size',
        '24px',
      );
      const originalRootStyle = await page
        .locator('html')
        .getAttribute('style');
      await page.bringToFront();
      const captured = await helper.evaluate(() =>
        chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
      );
      expect(captured, JSON.stringify(captured)).toMatchObject({
        success: true,
      });
      await expect(page.locator('html')).toHaveAttribute(
        'style',
        originalRootStyle,
      );

      viewer = await extContext.newPage();
      await viewer.goto(
        `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${slug}&ts=${captured.timestamp}`,
      );
      const frame = viewer.frameLocator('#frame');
      await frame.locator('#inherited-copy').waitFor();
      await expect(frame.locator('#inherited-copy')).toHaveCSS(
        'font-size',
        '16px',
      );
      await setDefaultFontSize(12);
      await expect(page.locator('#inherited-copy')).toHaveCSS(
        'font-size',
        '12px',
      );
      await expect(frame.locator('#inherited-copy')).toHaveCSS(
        'font-size',
        '16px',
      );
      await expect(frame.locator('#inherited-copy')).toHaveCSS(
        'line-height',
        '25.6px',
      );
      await expect(frame.locator('#relative-copy')).toHaveCSS(
        'font-size',
        '20px',
      );
      await expect(frame.locator('#fixed-copy')).toHaveCSS('font-size', '10px');
      await expect(frame.locator('h1')).toHaveCSS('font-size', '24px');
      await expect(frame.locator('html')).toHaveCSS('color', 'rgb(20, 30, 40)');
      await expect(frame.frameLocator('#same-origin').locator('p')).toHaveCSS(
        'font-size',
        '20px',
      );
      await expect(frame.frameLocator('#cross-origin').locator('p')).toHaveCSS(
        'font-size',
        '24px',
      );
      await frame
        .locator('body')
        .screenshot({ path: test.info().outputPath('snapshot-font.png') });
    } finally {
      if (originalFontSize !== undefined)
        await setDefaultFontSize(originalFontSize);
      await viewer?.close();
      await preferences.close();
      await helper.close();
      await page.close();
    }
  });

  test('capture excludes Browser Recall transient page UI', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/capture-with-transient-ui', {
      title: 'Capture Without Transient UI',
      body: '<p>Only source-page content belongs in this snapshot.</p><p data-browser-recall-transient-ui>Site-owned attributes must not remove source content.</p>',
    });
    const pageUrl = localServer.url('/capture-with-transient-ui');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');
    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();

    const spinnerResponse = await helper.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length !== 1 || !Number.isFinite(tabs[0].id)) {
        throw new Error(`Expected one source tab, found ${tabs.length}`);
      }
      return chrome.tabs.sendMessage(tabs[0].id, {
        action: 'showCaptureSpinner',
      });
    }, pageUrl);
    expect(spinnerResponse).toEqual({ success: true });
    await expect(
      page.locator('[data-browser-recall-transient-ui]'),
    ).toHaveCount(1);

    const captureResponse = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'captureCurrentPageFromPopup',
      }),
    );
    expect(captureResponse, JSON.stringify(captureResponse)).toMatchObject({
      success: true,
      timestamp: expect.any(Number),
    });

    const snapshotResponse = await helper.evaluate(
      ({ pageSlug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug: pageSlug,
          timestamp,
        }),
      {
        pageSlug: slug,
        timestamp: captureResponse.timestamp,
      },
    );
    expect(snapshotResponse.success).toBe(true);
    expect(snapshotResponse.html).toContain(
      'Only source-page content belongs in this snapshot.',
    );
    expect(snapshotResponse.html).toContain(
      'Site-owned attributes must not remove source content.',
    );
    expect(snapshotResponse.html).not.toContain(
      '<span class="spinner"></span>',
    );

    await helper.close();
    await page.close();
  });

  test('snapshot migration rejects a page checkpoint whose URL hashes to a different slug', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const originalUrl = 'https://example.com/mismatched-snapshot-page';
    const wrongSlug = 'deliberately-wrong-snapshot-slug';
    const timestamp = Date.now();
    expect(getSlugForUrl(originalUrl)).not.toBe(wrongSlug);

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(wrongSlug),
        data: pageEntityFixture({
          slug: wrongSlug,
          url: originalUrl,
          title: 'Mismatched Snapshot Page',
          parentIds: [],
          childIds: [`snapshot:${wrongSlug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: snapshotSidecarPath(wrongSlug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug: wrongSlug,
          url: originalUrl,
          html: '<!doctype html><html><head><title>Mismatched Snapshot Page</title></head><body>Snapshot body</body></html>',
        }),
      },
    ]);

    await expect(
      migrateSnapshotIdentity({ dataDir: setupDir, checkOnly: true }),
    ).rejects.toThrow('Snapshot page URL does not match');
  });

  test('toolbar popup explains how to enable snapshot file access', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const originalUrl = 'https://example.com/snapshot-file-access-required';
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot File Access Required',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: '<!doctype html><html><head><title>Snapshot File Access Required</title></head><body>Snapshot body</body></html>',
        }),
      },
    ]);
    const snapshotFile = join(
      setupDir,
      snapshotSidecarPath(slug, timestamp, 'html'),
    );
    const viewer = await extContext.newPage();
    await viewer.goto(pathToFileURL(snapshotFile).href);
    const helper = await openHelperPage(extContext, extensionId);
    expect(
      await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'setFileSchemeAccessForTest',
          allowed: false,
        }),
      ),
    ).toEqual({ success: true });
    const prepared = await helper.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({
        action: 'preparePopupBootstrapForTest',
        tabId: tabs[0]?.id,
      });
    }, viewer.url());
    expect(prepared).toMatchObject({
      success: true,
      mode: 'data-unavailable',
    });
    const expectedMessage = await helper.evaluate(() =>
      chrome.i18n.getMessage('extensionSnapshotFileAccessRequired'),
    );

    const popup = await extContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
    await expect(popup.locator('#pageDiagnosticSection')).toBeVisible();
    await expect(popup.locator('#pageDiagnosticMessage')).toHaveText(
      expectedMessage,
    );
    const settingsButton = popup.locator('#extensionFileAccessSettingsBtn');
    await expect(settingsButton).toBeVisible();
    const settingsPagePromise = extContext.waitForEvent('page');
    await settingsButton.click();
    const settingsPage = await settingsPagePromise;
    await expect
      .poll(() => settingsPage.url())
      .toContain('chrome://extensions');

    await popup.close().catch(() => {});
    await settingsPage.close();
    await helper.close();
    await viewer.close();
  });

  test('toolbar popup on a migrated legacy snapshot uses the original page data', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const originalUrl = 'https://example.com/legacy-desktop-snapshot-popup';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'desktop-file-snapshot-note';
    const highlightText = 'Legacy snapshot with obsolete identity metadata.';
    const timestamp = Date.now();

    await setExtensionFileAccess(extContext, extensionId, true);
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Legacy Desktop Snapshot Popup',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`, `note:${noteSlug}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: '',
          cssPath: ['body > p'],
          url: originalUrl,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content:
          '<!doctype html><html><head><meta name="x-browser-recall-slug" content="obsolete-page-slug"><title>Legacy Desktop Snapshot Popup</title></head><body><p>Legacy snapshot with obsolete identity metadata.</p><p id="keyboard-highlight">New keyboard highlight in saved HTML.</p><p id="menu-highlight">New context-menu highlight in saved HTML.</p></body></html>',
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: 'Legacy snapshot without embedded Browser Recall identity.',
      },
      {
        path: 'logs/test-device/2026-08-20.jsonl',
        lines: [
          {
            timestamp,
            action: 'visit_page',
            url: originalUrl,
            title: 'Legacy Desktop Snapshot Popup',
            referrerUrl: null,
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const legacyRead = await helper.evaluate(
      ({ pageSlug, snapshotTimestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotHtml',
          slug: pageSlug,
          timestamp: snapshotTimestamp,
        }),
      { pageSlug: slug, snapshotTimestamp: timestamp },
    );
    expect(legacyRead).toMatchObject({ success: false });
    expect(legacyRead.error).toContain('snapshot identity');

    const migration = await migrateSnapshotIdentity({ dataDir: setupDir });
    expect(migration).toMatchObject({
      scanned: 1,
      current: 0,
      pending: 1,
      updated: 1,
    });
    await expect(
      migrateSnapshotIdentity({ dataDir: setupDir, checkOnly: true }),
    ).resolves.toMatchObject({
      scanned: 1,
      current: 1,
      pending: 0,
      updated: 0,
    });

    const snapshotFile = join(
      setupDir,
      snapshotSidecarPath(slug, timestamp, 'html'),
    );
    const migratedHtml = readFileSync(snapshotFile, 'utf8');
    expect(migratedHtml).toContain(
      `<meta name="x-browser-recall-slug" content="${slug}">`,
    );
    expect(migratedHtml).toContain(
      `<meta name="x-browser-recall-url" content="${originalUrl}">`,
    );
    expect(migratedHtml).not.toContain('obsolete-page-slug');
    localServer.addPage('/before-desktop-snapshot', {
      title: 'Before Desktop Snapshot',
      body: '<p>A live page before opening a saved snapshot.</p>',
    });
    const viewer = await extContext.newPage();
    const liveUrl = localServer.url('/before-desktop-snapshot');
    await viewer.goto(liveUrl);
    await expect
      .poll(() =>
        helper.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          return chrome.runtime.sendMessage({
            action: 'getReportedUrl',
            tabId: tab.id,
          });
        }, liveUrl),
      )
      .toMatchObject({ success: true, url: liveUrl });
    await viewer.goto(pathToFileURL(snapshotFile).href);
    await viewer.waitForLoadState('load');
    await viewer.bringToFront();
    const viewerTabId = await helper.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      return tabs.length === 1 ? tabs[0].id : null;
    }, viewer.url());
    expect(viewerTabId).toEqual(expect.any(Number));
    expect(
      await helper.evaluate(
        (tabId) =>
          chrome.tabs.sendMessage(tabId, {
            action: 'getHighlightMarkupState',
          }),
        viewerTabId,
      ),
    ).toEqual({ success: true, hidden: false });
    await expect(viewer.locator('mark.browser-recall-highlight')).toHaveText(
      highlightText,
    );

    const openRequest = helper.evaluate((tabId) => {
      return chrome.runtime.sendMessage({
        action: 'openPreparedPopupForTest',
        tabId,
      });
    }, viewerTabId);
    await expect
      .poll(() =>
        helper.evaluate(() => {
          const popup = chrome.extension.getViews({ type: 'popup' })[0];
          return {
            title: popup?.document.getElementById('pageTitle')?.textContent,
            url: popup?.document.getElementById('pageUrl')?.textContent,
            dashboardVisible: popup
              ? popup.getComputedStyle(
                  popup.document.getElementById('dashboardContent'),
                ).display !== 'none'
              : false,
            diagnosticVisible: popup
              ? popup.getComputedStyle(
                  popup.document.getElementById('pageDiagnosticSection'),
                ).display !== 'none'
              : false,
          };
        }),
      )
      .toEqual({
        title: 'Legacy Desktop Snapshot Popup',
        url: originalUrl,
        dashboardVisible: true,
        diagnosticVisible: false,
      });
    await expect(openRequest).resolves.toMatchObject({ success: true });

    const toggleMarkup = () =>
      helper.evaluate(() => {
        const popup = chrome.extension.getViews({ type: 'popup' })[0];
        const button = popup?.document.getElementById('hideMarkupBtn');
        if (!button) throw new Error('Snapshot markup toggle is missing');
        button.click();
      });
    await toggleMarkup();
    await expect(viewer.locator('mark.browser-recall-highlight')).toHaveCount(
      0,
    );
    await expect
      .poll(() =>
        helper.evaluate(() =>
          chrome.extension
            .getViews({ type: 'popup' })[0]
            ?.document.getElementById('hideMarkupBtn')
            ?.getAttribute('aria-pressed'),
        ),
      )
      .toBe('true');
    await toggleMarkup();
    await expect(viewer.locator('mark.browser-recall-highlight')).toHaveText(
      highlightText,
    );

    await helper.evaluate(() => {
      chrome.extension.getViews({ type: 'popup' })[0]?.close();
    });
    await viewer.reload();
    await expect(viewer.locator('mark.browser-recall-highlight')).toHaveText(
      highlightText,
    );
    for (const [id, action] of [
      ['keyboard-highlight', 'highlight-selection'],
      ['menu-highlight', 'contextMenuHighlight'],
    ]) {
      const selectionText = await viewer
        .locator(`#${id}`)
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        });
      await viewer.bringToFront();
      const response = await helper.evaluate(
        ({ action, url, selectionText }) =>
          chrome.runtime.sendMessage(
            action === 'contextMenuHighlight'
              ? {
                  action,
                  url,
                  title: 'Legacy Desktop Snapshot Popup',
                  selectionText,
                }
              : { action: 'triggerCommandForTest', command: action },
          ),
        { action, url: viewer.url(), selectionText },
      );
      expect(response, JSON.stringify(response)).toMatchObject({
        success: true,
      });
    }
    const savedNotes = await helper.evaluate(
      (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
      slug,
    );
    expect(savedNotes.notes).toHaveLength(3);
    expect(savedNotes.notes.map((note) => note.url)).toEqual([
      originalUrl,
      originalUrl,
      originalUrl,
    ]);
    await viewer.reload();
    await expect(viewer.locator('mark.browser-recall-highlight')).toHaveCount(
      3,
    );
    await viewer.bringToFront();
    expect(
      await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'triggerCommandForTest',
          command: 'like-page',
        }),
      ),
    ).toEqual({ success: true });
    await viewer.close();
    await helper.close();
  });

  test('capture reconnects when cached connector state is stale', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/capture-stale-connector', {
      title: 'Capture Stale Connector',
      body: '<p>Snapshot content survives stale connector state.</p>',
    });
    const pageUrl = localServer.url('/capture-stale-connector');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();

    await helper.evaluate(() =>
      chrome.storage.local.set({ connectorState: 'offline' }),
    );
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp, JSON.stringify(captureResp)).toMatchObject({
      success: true,
    });

    await expect
      .poll(() =>
        helper.evaluate(
          (key) =>
            chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
          `page:${slug}`,
        ),
      )
      .toMatchObject({
        success: true,
        value: {
          childIds: [expect.stringMatching(/^snapshot:/)],
        },
      });

    await helper.close();
    await page.close();
  });

  for (const operation of ['snapshot budget', 'direct command']) {
    test(`${operation} waits for commands arriving during and after drain completion`, async ({
      extContext,
      extensionId,
      localServer,
    }) => {
      localServer.addPage('/capture-concurrent-commands', {
        title: 'Capture Concurrent Commands',
        body: '<p>Snapshot content survives concurrent page activity.</p>',
      });
      const url = localServer.url('/capture-concurrent-commands');
      const slug = getSlugForUrl(url);
      await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
      const page = await extContext.newPage();
      await page.goto(url);
      const helper = await openHelperPage(extContext, extensionId);
      await page.bringToFront();
      const worker = extContext.serviceWorkers()[0];
      const outcomes = await worker.evaluate(
        async ({ operation, url, slug }) => {
          const control = globalThis.browserRecallBackgroundTestControl;
          await control.flushDesktopBuffer();
          const originalSet = chrome.storage.local.set.bind(
            chrome.storage.local,
          );
          const outcomes = [];
          // null enqueues during the final state write. Microtask delays exercise
          // arrivals between drain completion and the caller's queue inspection.
          for (const delay of [
            null,
            ...Array.from({ length: 25 }, (_, i) => i),
          ]) {
            let injection = null;
            chrome.storage.local.set = async (patch) => {
              const finalState =
                Object.keys(patch).length === 1 &&
                patch.connectorState === 'connected';
              if (!injection && finalState && delay === null) {
                injection = control.enqueueDesktopCommand('saveSettingsKey', {
                  key: 'theme',
                  value: 'dark',
                });
                await injection;
              }
              const result = await originalSet(patch);
              if (!injection && finalState) {
                injection = (async () => {
                  for (let i = 0; i < delay; i++) await Promise.resolve();
                  await control.enqueueDesktopCommand('saveSettingsKey', {
                    key: 'theme',
                    value: 'dark',
                  });
                })();
              }
              return result;
            };
            let outcome;
            try {
              // Seed work after installing the hook. An empty request can join
              // a previous drain whose final state write already bypassed it.
              await control.enqueueDesktopCommand('saveSettingsKey', {
                key: 'theme',
                value: 'light',
              });
              if (operation === 'snapshot budget') {
                await control.requestDesktopSnapshotCaptureBudget({
                  url,
                  slug,
                  ts: Date.now(),
                  title: 'Capture Concurrent Commands',
                  markdown: null,
                });
              } else {
                await control.requestDesktopCommand('saveSettingsKey', {
                  key: 'theme',
                  value: 'light',
                });
              }
              outcome = { success: true };
            } catch (error) {
              outcome = { success: false, error: error.message };
            } finally {
              chrome.storage.local.set = originalSet;
              await injection;
              await control.flushDesktopBuffer();
            }
            outcomes.push({ delay, injected: injection !== null, ...outcome });
          }
          return outcomes;
        },
        { operation, url, slug },
      );
      expect(outcomes, JSON.stringify(outcomes)).toEqual(
        outcomes.map(({ delay }) => ({ delay, injected: true, success: true })),
      );
      const capture = await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'captureCurrentPageFromPopup',
        }),
      );
      expect(capture, JSON.stringify(capture)).toMatchObject({ success: true });
      await helper.close();
      await page.close();
    });
  }

  // Content script resolves slug from x-browser-recall-slug meta tag and reapplies highlights.
  // Simulates the snapshot viewer scenario: the page URL doesn't match the original,
  // but the embedded meta tag tells content.js which page entity to load notes from.
  test('highlights reapplied on page with x-browser-recall-slug meta tag', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const originalUrl = 'https://example.com/article';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'test-note-abc';
    const highlightText = 'important sentence';
    const now = Date.now();

    // Serve a page that has the meta tag (simulating a snapshot blob) and matching text
    localServer.addPage('/snapshot-view', {
      title: 'Snapshot View',
      body: `<meta name="x-browser-recall-slug" content="${slug}"><p>This is an ${highlightText} in the document.</p>`,
    });

    // Seed: page entity with a note child, and the note entity with an excerpt
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Example Article',
          deviceTimestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: '',
          cssPath: ['body > p'],
          url: originalUrl,
        }),
      },
    ]);

    // Navigate to the "snapshot" page — content script should inject, read meta tag,
    // and reapply highlights from the matching page entity
    const page = await extContext.newPage();
    await page.goto(localServer.url('/snapshot-view'));
    await page.waitForLoadState('domcontentloaded');

    // Wait for content script to create <mark> elements (reapplyHighlights is async)
    await page.waitForSelector('mark', { timeout: 5000 });

    // Verify the highlight mark exists with correct text
    const markText = await page.textContent('mark');
    expect(markText).toBe(highlightText);

    await page.close();
  });

  test('popup preserves embedded snapshot identity while the page is still loading', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const originalUrl = 'https://example.com/snapshot-original';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'snapshot-popup-note';
    const highlightText = 'snapshot popup highlight';
    const now = Date.now();

    localServer.addPage('/snapshot-popup-view', {
      title: 'Stored Snapshot',
      body: `<meta name="x-browser-recall-slug" content="${slug}"><meta name="x-browser-recall-url" content="${originalUrl}"><p>This page contains a ${highlightText}.</p>`,
      endDelayMs: 3_000,
    });

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Original Snapshot Page',
          parentIds: [],
          childIds: [`note:${noteSlug}`],
          timestamps: { 'test-device': now },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: 'snapshot popup note',
          cssPath: ['body > p'],
          url: originalUrl,
        }),
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: originalUrl,
            title: 'Original Snapshot Page',
            referrerUrl: null,
          },
        ],
      },
    ]);

    const snapshotUrl = localServer.url('/snapshot-popup-view');
    const snapshotPage = await extContext.newPage();
    await snapshotPage.goto(snapshotUrl, { waitUntil: 'commit' });

    const helper = await openHelperPage(extContext, extensionId);
    const snapshotTab = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab
        ? {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            status: tab.status,
          }
        : null;
    }, snapshotUrl);
    expect(snapshotTab).not.toBeNull();
    expect(snapshotTab.status).toBe('loading');

    const flushResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueueForTest' }),
    );
    expect(flushResult.success).toBe(true);
    const prepared = await helper.evaluate(
      (tabId) =>
        chrome.runtime.sendMessage({
          action: 'preparePopupBootstrapForTest',
          tabId,
        }),
      snapshotTab.id,
    );
    expect(prepared.success).toBe(true);
    expect(prepared.mode, prepared.error).toBe('dashboard');
    const popup = await extContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);

    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#pageTitle')).toHaveText(
      'Original Snapshot Page',
    );
    await expect(popup.locator('#pageUrl')).toHaveText(originalUrl);
    await expect(popup.locator('#notesSection')).toContainText(highlightText);

    await popup.close();
    await helper.close();
    await snapshotPage.close();
  });

  test('popup snapshot row opens an extension viewer that renders and reapplies highlights', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const originalUrl = 'https://example.com/popup-open-snapshot';
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const noteSlug = 'popup-open-snapshot-note';
    const highlightText = 'restored snapshot highlight';

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Popup Open Snapshot',
          parentIds: [],
          childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: 'snapshot note',
          cssPath: ['body > p'],
          url: originalUrl,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Popup Open Snapshot</title></head><body><p>A saved page with ${highlightText} inside.</p></body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: `A saved page with ${highlightText} inside.`,
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp,
            action: 'visit_page',
            url: originalUrl,
            title: 'Popup Open Snapshot',
            referrerUrl: null,
          },
        ],
      },
    ]);

    await extContext.route(originalUrl, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Popup Open Snapshot</title><p>Original page</p>',
      }),
    );
    const sourcePage = await extContext.newPage();
    await sourcePage.goto(originalUrl);

    const popup = await openPopupForUrl(extContext, extensionId, {
      url: originalUrl,
      title: 'Popup Open Snapshot',
    });

    const pageUrl = popup.locator('#pageUrl');
    await expect(pageUrl).toHaveText(originalUrl);
    await expect(pageUrl).toHaveCSS('cursor', 'pointer');

    const openedOriginalPromise = extContext.waitForEvent('page');
    await pageUrl.click();
    const originalPage = await openedOriginalPromise;
    expect(originalPage.url()).toBe(originalUrl);
    await originalPage.close();

    const snapshotRow = popup.locator('.snapshot-row').first();
    await expect(snapshotRow).toBeVisible();
    await expect(snapshotRow).toHaveCSS('cursor', 'pointer');

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'restartConnectorRuntimeForTest' }),
    );

    const openedPromise = extContext.waitForEvent('page');
    await snapshotRow.click();
    const viewer = await openedPromise;
    await viewer.waitForLoadState('domcontentloaded');

    expect(viewer.url()).toContain(
      `chrome-extension://${extensionId}/snapshot-viewer.html`,
    );
    await expect(viewer.locator('iframe')).toBeVisible();
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('body')).toContainText(highlightText);
    await expect(frame.locator('mark')).toHaveText(highlightText);
    await frame.locator('mark').click();
    const viewerOverlayBorderRun = await longestLeftBorderRun(
      frame.locator('#browser-recall-highlight-overlay'),
    );
    expect(viewerOverlayBorderRun).toBeGreaterThanOrEqual(2);
    await viewer.keyboard.press('Escape');

    await expect
      .poll(() => getActionIconForUrl(helper, viewer.url()))
      .toMatchObject({
        16: 'icons/icon16-special-notes.png',
        48: 'icons/icon48-special-notes.png',
        128: 'icons/icon128-special-notes.png',
      });

    const viewerPopup = await openPopupForUrl(extContext, extensionId, {
      url: viewer.url(),
      title: 'Popup Open Snapshot',
    });
    await expect(viewerPopup.locator('#pageTitle')).toHaveText(
      'Popup Open Snapshot',
    );
    await expect(viewerPopup.locator('#pageUrl')).toHaveText(originalUrl);
    await expect(viewerPopup.locator('#notesSection')).toContainText(
      highlightText,
    );
    const markupButton = viewerPopup.locator('#hideMarkupBtn');
    await expect(markupButton).toBeVisible();
    await markupButton.click();
    await expect(markupButton).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('mark')).toHaveCount(0);
    await markupButton.click();
    await expect(markupButton).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('mark')).toHaveText(highlightText);
    await viewerPopup.close();

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resetForTest' }),
    );
    await viewer.reload();
    await expect
      .poll(() => getActionBadgeForUrl(helper, viewer.url()))
      .toMatchObject({
        text: '!',
        title: expect.stringContaining('unavailable'),
      });

    await helper.close();
    await viewer.close();
    await popup.close();
    await sourcePage.close();
  });

  test('snapshot highlight persists its repeated-text scope and rejects re-highlighting', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const caseSeed = 421;
    const originalUrl = `https://example.com/snapshot-create-highlight-${caseSeed}`;
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const highlightText = `new snapshot highlight ${caseSeed}`;
    const repeatedParagraph = `Same block first: ${highlightText}. Same block second: ${highlightText}.`;
    const selectedStart = repeatedParagraph.lastIndexOf(highlightText);
    const repeatedBody = `<main><section><p>Other block: ${highlightText}.</p></section><section><p>${repeatedParagraph}</p></section></main>`;

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot Create Highlight',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Snapshot Create Highlight</title></head><body>${repeatedBody}</body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: `First occurrence: ${highlightText}.\n\nSecond occurrence: ${highlightText}.`,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    await expect(viewer.locator('iframe')).toBeVisible();
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('body')).toContainText(highlightText);

    await frame
      .locator('section')
      .nth(1)
      .locator('p')
      .evaluate((paragraph) => {
        const doc = paragraph.ownerDocument;
        const range = doc.createRange();
        const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const offset = node.textContent.lastIndexOf(
            'new snapshot highlight 421',
          );
          if (offset >= 0) {
            range.setStart(node, offset);
            range.setEnd(node, offset + 'new snapshot highlight 421'.length);
            break;
          }
        }
        const selection = doc.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });

    await viewer.waitForTimeout(300);
    await expect(frame.locator('mark')).toHaveCount(0);

    const helper = await openHelperPage(extContext, extensionId);
    await viewer.bringToFront();
    const commandResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'triggerCommandForTest',
        command: 'highlight-selection',
      }),
    );
    expect(commandResp).toEqual({ success: true });
    await expect(frame.locator('section').nth(0).locator('mark')).toHaveCount(
      0,
    );
    const secondMark = frame.locator('section').nth(1).locator('mark');
    await expect(secondMark).toHaveText(highlightText);
    await expect
      .poll(() =>
        secondMark.evaluate((mark) => mark.previousSibling?.textContent || ''),
      )
      .toContain('Same block second: ');

    let notesResp = await helper.evaluate((pageSlug) => {
      return chrome.runtime.sendMessage({
        action: 'loadPageNotes',
        slug: pageSlug,
      });
    }, slug);
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toEqual([highlightText]);
    expect(notesResp.notes[0].cssPath).toEqual([
      `browser-recall-text-anchor:v1:${JSON.stringify({
        selector: 'body > main > section:nth-of-type(2) > p',
        start: selectedStart,
        end: selectedStart + highlightText.length,
      })}`,
    ]);

    await secondMark.evaluate((mark) => {
      const doc = mark.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(mark);
      const selection = doc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await viewer.bringToFront();
    const repeatResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'triggerCommandForTest',
        command: 'highlight-selection',
      }),
    );
    expect(repeatResp).toMatchObject({
      success: false,
      error: expect.stringMatching(/already highlighted/i),
    });

    notesResp = await helper.evaluate((pageSlug) => {
      return chrome.runtime.sendMessage({
        action: 'loadPageNotes',
        slug: pageSlug,
      });
    }, slug);
    expect(notesResp.notes).toHaveLength(1);

    await viewer.reload();
    await expect(frame.locator('section').nth(0).locator('mark')).toHaveCount(
      0,
    );
    await expect(frame.locator('section').nth(1).locator('mark')).toHaveText(
      highlightText,
    );
    await expect
      .poll(() =>
        frame
          .locator('section')
          .nth(1)
          .locator('mark')
          .evaluate((mark) => mark.previousSibling?.textContent || ''),
      )
      .toContain('Same block second: ');

    await helper.close();
    await viewer.close();
  });

  test('snapshot highlight persists and reloads inside nested shadow roots', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    void setupDir;
    const caseSeed = 619;
    const originalUrl = `https://example.com/snapshot-shadow-highlight-${caseSeed}`;
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const highlightText = `shadow highlight ${caseSeed}`;
    const paragraphText = `first ${highlightText} middle ${highlightText}`;
    const selectedStart = paragraphText.lastIndexOf(highlightText);

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot Shadow Highlight',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Snapshot Shadow Highlight</title></head><body>
          <outer-card id="shadow-highlight-outer"><template data-savepage-shadowroot="">
            <inner-card id="shadow-highlight-inner"><template data-savepage-shadowroot="">
              <p id="shadow-highlight-copy">${paragraphText}</p>
            </template></inner-card>
          </template></outer-card>
        </body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: paragraphText,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    const paragraph = frame.locator('#shadow-highlight-copy');
    await expect(paragraph).toHaveText(paragraphText);
    await paragraph.evaluate(
      (element, { start, length }) => {
        const doc = element.ownerDocument;
        const range = doc.createRange();
        range.setStart(element.firstChild, start);
        range.setEnd(element.firstChild, start + length);
        const selection = doc.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
      { start: selectedStart, length: highlightText.length },
    );

    const helper = await openHelperPage(extContext, extensionId);
    await viewer.bringToFront();
    const commandResponse = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'triggerCommandForTest',
        command: 'highlight-selection',
      }),
    );
    expect(commandResponse).toEqual({ success: true });

    const mark = paragraph.locator('mark.browser-recall-highlight');
    await expect(mark).toHaveText(highlightText);
    await expect
      .poll(() => mark.evaluate((node) => node.previousSibling?.textContent))
      .toContain(`first ${highlightText} middle `);

    const notesResponse = await helper.evaluate((pageSlug) => {
      return chrome.runtime.sendMessage({
        action: 'loadPageNotes',
        slug: pageSlug,
      });
    }, slug);
    expect(notesResponse.success).toBe(true);
    expect(notesResponse.notes).toHaveLength(1);
    expect(notesResponse.notes[0].cssPath).toEqual([
      `browser-recall-text-anchor:v2:${JSON.stringify({
        selectors: [
          'outer-card#shadow-highlight-outer',
          'inner-card#shadow-highlight-inner',
          'p#shadow-highlight-copy',
        ],
        start: selectedStart,
        end: selectedStart + highlightText.length,
      })}`,
    ]);

    await viewer.reload();
    await expect(
      frame.locator('#shadow-highlight-copy mark.browser-recall-highlight'),
    ).toHaveText(highlightText);

    await helper.close();
    await viewer.close();
  });

  test('snapshot and live-page highlight editors render from the same surface', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    const caseSeed = 173;
    const path = `/highlight-editor-parity-${caseSeed}`;
    const originalUrl = localServer.url(path);
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const noteSlug = `highlight-editor-parity-${caseSeed}`;
    const highlightText = `shared highlight editor excerpt ${caseSeed}`;
    const noteText = `shared editor note ${caseSeed}`;
    // Relative spacing exposes the different default page fonts in live pages
    // and extension frames, placing the editors at different fractional origins.
    const pageBody = `<main style="padding: 0.13em"><p>${highlightText}</p></main>`;
    const captureEditor = async (editor, filename) => {
      // Playwright cannot hide a caret inside this closed shadow root. Compare
      // the editor surfaces with the document body focused so caret blink timing
      // cannot change the captured pixels. Keep the complete image comparison.
      const bodyFocused = await editor.evaluate((host) => {
        const body = host.ownerDocument.body;
        body.tabIndex = -1;
        body.focus({ preventScroll: true });
        return host.ownerDocument.activeElement === body;
      });
      expect(bodyFocused).toBe(true);
      // Match pixel origins so clipping and subpixel rasterization do not turn
      // different page typography into an editor-surface difference.
      return editor.screenshot({
        path: test.info().outputPath(filename),
        style:
          '#browser-recall-highlight-overlay { left: 16px !important; top: 80px !important; }',
      });
    };

    localServer.addPage(path, {
      title: 'Highlight Editor Parity',
      body: pageBody,
    });
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Highlight Editor Parity',
          parentIds: [],
          childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: noteText,
          cssPath: ['body > main:nth-of-type(1) > p:nth-of-type(1)'],
          url: originalUrl,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Highlight Editor Parity</title></head><body>${pageBody}</body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: highlightText,
      },
    ]);

    const livePage = await extContext.newPage();
    await livePage.goto(originalUrl);
    const liveMark = livePage.locator('mark.browser-recall-highlight');
    await expect(liveMark).toHaveText(highlightText);
    await liveMark.click();
    const liveEditor = livePage.locator('#browser-recall-highlight-overlay');
    await expect(liveEditor).toBeVisible();
    const liveEditorPixels = await captureEditor(liveEditor, 'live-editor.png');

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    const snapshotMark = frame.locator('mark.browser-recall-highlight');
    await expect(snapshotMark).toHaveText(highlightText);
    await snapshotMark.click();
    const snapshotEditor = frame.locator('#browser-recall-highlight-overlay');
    await expect(snapshotEditor).toBeVisible();
    const snapshotEditorPixels = await captureEditor(
      snapshotEditor,
      'snapshot-editor.png',
    );

    expect(snapshotEditorPixels.equals(liveEditorPixels)).toBe(true);

    await viewer.close();
    await livePage.close();
  });

  test('highlight text fallback uses the first occurrence on live pages and snapshots', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    const excerpts = {
      missing: 'Repeated passage found by text search',
      shifted: 'A passage with shifted text offsets',
      legacy: 'Legacy path with changed whitespace',
      shadow: 'A passage inside a relocated shadow root',
      partial: 'An already restored part of a highlight',
      late: 'A highlight part inserted after loading',
      hidden: 'Visible passage after hidden duplicates',
      reserved: 'A passage reserved by a valid anchor',
      lines: 'First fallback line\nSecond fallback line',
      slotted: 'A passage shown by the first visible slot',
    };
    const anchor = (selector, text) =>
      `browser-recall-text-anchor:v1:${JSON.stringify({ selector, start: 0, end: text.length })}`;
    const notes = [
      {
        slug: 'fallback-missing',
        excerpt: [excerpts.missing],
        cssPath: [anchor('#missing', excerpts.missing)],
      },
      {
        slug: 'fallback-shifted',
        excerpt: [excerpts.shifted],
        cssPath: [anchor('#shifted', excerpts.shifted)],
      },
      {
        slug: 'fallback-legacy',
        excerpt: [excerpts.legacy],
        cssPath: ['#old-layout > p'],
      },
      {
        slug: 'fallback-shadow',
        excerpt: [excerpts.shadow],
        cssPath: [
          `browser-recall-text-anchor:v2:${JSON.stringify({ selectors: ['#old-shadow-host', 'p'], start: 0, end: excerpts.shadow.length })}`,
        ],
      },
      {
        slug: 'fallback-reserved',
        excerpt: [excerpts.reserved],
        cssPath: [anchor('#missing-reserved', excerpts.reserved)],
      },
      {
        slug: 'valid-reserved',
        excerpt: [excerpts.reserved],
        cssPath: [anchor('#reserved', excerpts.reserved)],
      },
      {
        slug: 'fallback-hidden',
        excerpt: [excerpts.hidden],
        cssPath: [anchor('#missing-hidden', excerpts.hidden)],
      },
      {
        slug: 'fallback-slotted',
        excerpt: [excerpts.slotted],
        cssPath: [anchor('#missing-slotted', excerpts.slotted)],
      },
      {
        slug: 'fallback-lines',
        excerpt: [excerpts.lines],
        cssPath: [anchor('#missing-lines', excerpts.lines)],
      },
      {
        slug: 'fallback-partial',
        excerpt: [excerpts.partial, excerpts.late],
        cssPath: [
          anchor('#partial', excerpts.partial),
          anchor('#old-late', excerpts.late),
        ],
      },
    ];
    const body = `<aside id="browser-recall-highlights-panel">${Object.values(excerpts).join(' ')}</aside>
      <main><p id="first">${excerpts.missing}</p><p id="second">${excerpts.missing}</p>
      <p id="shifted">New prefix: ${excerpts.shifted}</p>
      <p id="legacy">Legacy path with\n changed whitespace</p>
      <p id="legacy-later">${excerpts.legacy}</p>
      <p id="partial">${excerpts.partial}</p><p id="partial-copy">${excerpts.partial}</p>
      <div id="shadow-host"><template shadowrootmode="open"><p>${excerpts.shadow}</p></template><p id="unassigned-shadow-copy">${excerpts.shadow}</p></div>
      <p id="shadow-later">${excerpts.shadow}</p>
      <div id="slot-host"><template shadowrootmode="open"><slot name="first"></slot><slot name="last"></slot></template><p slot="last">${excerpts.slotted}</p><p slot="first">${excerpts.slotted}</p></div>
      <p id="reserved">${excerpts.reserved}</p><p id="spare">${excerpts.reserved}</p>
      <p hidden>${excerpts.hidden}</p><p style="display:none">${excerpts.hidden}</p><p style="visibility:hidden">${excerpts.hidden}</p>
      <script type="application/json">${JSON.stringify(excerpts.hidden)}</script>
      <p id="visible-copy">${excerpts.hidden}</p>
      <p id="lines">First fallback line<br>Second fallback line</p></main>`;
    localServer.addPage('/highlight-text-fallback', {
      title: 'Highlight text fallback',
      body,
    });
    const url = localServer.url('/highlight-text-fallback');
    const slug = getSlugForUrl(url);
    const timestamp = Date.now();
    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Highlight text fallback',
          parentIds: [],
          childIds: [
            ...notes.map((note) => `note:${note.slug}`),
            `snapshot:${slug}-${timestamp}`,
          ],
          timestamps: { 'test-device': timestamp },
        }),
      },
      ...notes.map((note) => ({
        path: `objects/notes/${note.slug}.json`,
        data: noteEntityFixture({ ...note, note: '', url }),
      })),
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url,
          html: `<!doctype html><html><head><title>Highlight text fallback</title></head><body>${body}<p id="late">${excerpts.late}</p></body></html>`,
        }),
      },
    ]);
    const page = await extContext.newPage();
    let viewer;
    try {
      await page.goto(url);
      await expect(page.locator('#first mark')).toHaveText(excerpts.missing);
      await expect(page.locator('#second mark')).toHaveCount(0);
      await expect(page.locator('#shifted mark')).toHaveText(excerpts.shifted);
      await expect(page.locator('#legacy mark')).toHaveAttribute(
        'data-highlight-text',
        excerpts.legacy,
      );
      await expect(page.locator('#shadow-host mark')).toHaveText(
        excerpts.shadow,
      );
      await expect(
        page.locator(
          '#shadow-later mark, #unassigned-shadow-copy mark, #legacy-later mark',
        ),
      ).toHaveCount(0);
      await expect(page.locator('#reserved mark')).toHaveAttribute(
        'data-note-slug',
        'valid-reserved',
      );
      await expect(page.locator('#spare mark')).toHaveAttribute(
        'data-note-slug',
        'fallback-reserved',
      );
      await expect(page.locator('#visible-copy mark')).toHaveText(
        excerpts.hidden,
      );
      await expect(
        page.locator('[hidden] mark, [style] mark, script mark'),
      ).toHaveCount(0);
      await expect(page.locator('#lines mark')).toHaveAttribute(
        'data-highlight-text',
        excerpts.lines,
      );
      await expect(page.locator('#lines mark br')).toHaveCount(1);
      await expect(page.locator('#slot-host [slot="first"] mark')).toHaveText(
        excerpts.slotted,
      );
      await expect(page.locator('#slot-host [slot="last"] mark')).toHaveCount(
        0,
      );
      await page.evaluate((text) => {
        const paragraph = document.createElement('p');
        paragraph.id = 'late';
        paragraph.textContent = text;
        document.querySelector('main').appendChild(paragraph);
      }, excerpts.late);
      await expect(page.locator('#late mark')).toHaveText(excerpts.late);
      await expect(
        page.locator('[data-note-slug="fallback-partial"]'),
      ).toHaveCount(2);
      await expect(page.locator('#partial-copy mark')).toHaveCount(0);
      await expect(
        page.locator('#browser-recall-highlights-panel mark'),
      ).toHaveCount(0);

      viewer = await extContext.newPage();
      await viewer.goto(
        `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${slug}&ts=${timestamp}`,
      );
      const frame = viewer.frameLocator('#frame');
      for (const id of ['first', 'shifted', 'partial', 'late']) {
        await expect(frame.locator(`#${id} mark`)).toHaveCount(1);
      }
      await expect(frame.locator('#legacy mark')).toHaveAttribute(
        'data-highlight-text',
        excerpts.legacy,
      );
      await expect(frame.locator('#shadow-host mark')).toHaveText(
        excerpts.shadow,
      );
      await expect(
        frame.locator(
          '#shadow-later mark, #unassigned-shadow-copy mark, #legacy-later mark',
        ),
      ).toHaveCount(0);
      await expect(frame.locator('#reserved mark')).toHaveAttribute(
        'data-note-slug',
        'valid-reserved',
      );
      await expect(frame.locator('#spare mark')).toHaveAttribute(
        'data-note-slug',
        'fallback-reserved',
      );
      await expect(frame.locator('#visible-copy mark')).toHaveText(
        excerpts.hidden,
      );
      await expect(
        frame.locator('[hidden] mark, [style] mark, script mark'),
      ).toHaveCount(0);
      await expect(frame.locator('#lines mark')).toHaveAttribute(
        'data-highlight-text',
        excerpts.lines,
      );
      await expect(frame.locator('#slot-host [slot="first"] mark')).toHaveText(
        excerpts.slotted,
      );
      await expect(frame.locator('#slot-host [slot="last"] mark')).toHaveCount(
        0,
      );
      await expect(
        frame.locator(
          '#second mark, #partial-copy mark, #browser-recall-highlights-panel mark',
        ),
      ).toHaveCount(0);
    } finally {
      await viewer?.close();
      await page.close();
    }
  });

  test('captured snapshots preserve highlight anchors across removed hidden siblings', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    const highlightText = 'The saved passage stays in its original location';
    localServer.addPage('/snapshot-hidden-siblings', {
      title: 'Snapshot hidden siblings',
      body: `<article id="story"><section>
        <div style="display:none">Hidden advertisement one</div>
        <div><p>${highlightText}</p></div>
        <div style="display:none">Hidden advertisement two</div>
        <div><p>First: ${highlightText}. Second: ${highlightText}.</p></div>
        <div><p>${highlightText}</p></div>
      </section></article>`,
    });
    const url = localServer.url('/snapshot-hidden-siblings');
    const slug = getSlugForUrl(url);
    const selector = 'article#story > section > div:nth-of-type(4) > p';
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
    const page = await extContext.newPage();
    const helper = await openHelperPage(extContext, extensionId);
    let viewer;
    let savedPage;
    try {
      await page.goto(url);
      await page.locator(selector).evaluate((paragraph, text) => {
        const start = paragraph.textContent.lastIndexOf(text);
        const range = document.createRange();
        range.setStart(paragraph.firstChild, start);
        range.setEnd(paragraph.firstChild, start + text.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, highlightText);
      await page.bringToFront();
      const highlighted = await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'triggerCommandForTest',
          command: 'highlight-selection',
        }),
      );
      expect(highlighted).toEqual({ success: true });
      await expect(page.locator('mark.browser-recall-highlight')).toHaveText(
        highlightText,
      );
      const notes = await helper.evaluate(
        (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
        slug,
      );
      expect(notes.success).toBe(true);
      expect(notes.notes).toHaveLength(1);
      const anchor = JSON.parse(
        notes.notes[0].cssPath[0].slice(
          'browser-recall-text-anchor:v1:'.length,
        ),
      );
      expect(anchor.selector).toBe(selector);

      await page.bringToFront();
      const capture = await helper.evaluate(() =>
        chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
      );
      expect(capture).toMatchObject({ success: true });
      const snapshot = await helper.evaluate(
        ({ slug, timestamp }) =>
          chrome.runtime.sendMessage({
            action: 'getSnapshotHtml',
            slug,
            timestamp,
          }),
        { slug, timestamp: capture.timestamp },
      );
      expect(snapshot.success).toBe(true);
      expect(snapshot.html.match(/<!--savepage-div-remove-->/g)).toHaveLength(
        2,
      );
      expect(snapshot.html).not.toContain('Hidden advertisement');

      viewer = await extContext.newPage();
      await viewer.goto(
        `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${slug}&ts=${capture.timestamp}`,
      );
      const frame = viewer.frameLocator('#frame');
      await expect(frame.locator('mark.browser-recall-highlight')).toHaveCount(
        1,
      );
      const mark = frame.locator(selector).locator('mark');
      await expect(mark).toHaveText(highlightText);
      expect(
        await mark.evaluate((mark) => mark.previousSibling.textContent),
      ).toContain('Second: ');
      await expect(frame.locator('#story > section > div[hidden]')).toHaveCount(
        2,
      );
      await viewer.reload();
      await expect(frame.locator(selector).locator('mark')).toHaveText(
        highlightText,
      );
      await expect(frame.locator('#story > section > div[hidden]')).toHaveCount(
        2,
      );

      // Direct saved HTML uses the generated content script rather than the viewer adapter.
      localServer.addRawPage('/snapshot-hidden-siblings-saved', snapshot.html);
      savedPage = await extContext.newPage();
      await savedPage.goto(localServer.url('/snapshot-hidden-siblings-saved'));
      await expect(
        savedPage.locator('mark.browser-recall-highlight'),
      ).toHaveCount(1);
      await expect(savedPage.locator(selector).locator('mark')).toHaveText(
        highlightText,
      );
    } finally {
      await savedPage?.close();
      await viewer?.close();
      await helper.close();
      await page.close();
    }
  });

  test('snapshot viewer reapplies highlights within stored css path scope', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const originalUrl = 'https://example.com/snapshot-scoped-highlight';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'snapshot-scoped-highlight-note';
    const timestamp = Date.now();
    const highlightText = 'duplicate highlight text';

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot Scoped Highlight',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`, `note:${noteSlug}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: '',
          cssPath: ['body > section:nth-of-type(2) > p:nth-of-type(1)'],
          url: originalUrl,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Snapshot Scoped Highlight</title></head><body><section><p>${highlightText}</p></section><section><p>${highlightText}</p></section></body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: `${highlightText}\n\n${highlightText}`,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('mark')).toHaveCount(1);
    await expect(frame.locator('section').nth(0).locator('mark')).toHaveCount(
      0,
    );
    await expect(frame.locator('section').nth(1).locator('mark')).toHaveText(
      highlightText,
    );

    await viewer.close();
  });

  test('snapshot viewer never reapplies highlights inside Browser Recall UI markup', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const originalUrl = 'https://example.com/snapshot-highlight-ui-exclusion';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'snapshot-highlight-ui-exclusion-note';
    const timestamp = Date.now();
    const highlightText = 'saved excerpt outside Browser Recall UI';

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot Highlight UI Exclusion',
          parentIds: [],
          childIds: [`snapshot:${slug}-${timestamp}`, `note:${noteSlug}`],
          timestamps: { 'test-device': timestamp },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: [highlightText],
          note: '',
          cssPath: [''],
          url: originalUrl,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: currentSnapshotHtml({
          slug,
          url: originalUrl,
          html: `<!doctype html><html><head><title>Snapshot Highlight UI Exclusion</title></head><body><aside id="browser-recall-highlights-panel">${highlightText}</aside><main><p>${highlightText}</p></main></body></html>`,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: highlightText,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    const frame = viewer.frameLocator('iframe');

    await expect(frame.locator('mark.browser-recall-highlight')).toHaveCount(1);
    await expect(
      frame.locator(
        '#browser-recall-highlights-panel mark.browser-recall-highlight',
      ),
    ).toHaveCount(0);
    await expect(
      frame.locator('main mark.browser-recall-highlight'),
    ).toHaveText(highlightText);

    await viewer.close();
  });

  // captureSnapshot strips browser-recall highlight marks from captured HTML
  test('captureSnapshot strips highlight marks from HTML', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/with-highlights', {
      title: 'Highlighted Page',
      body: '<p>Some <mark class="browser-recall-highlight" style="background:#fff3b0" data-highlight-text="important">important</mark> text here.</p>',
    });
    const pageUrl = localServer.url('/with-highlights');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp).toMatchObject({ success: true });

    const urlResp = await helper.evaluate(
      ({ slug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotUrl',
          slug,
          timestamp,
        }),
      { slug, timestamp: captureResp.timestamp },
    );
    expect(urlResp.success).toBe(true);

    const html = decodeURIComponent(
      urlResp.url.replace(/^data:text\/html;charset=utf-8,/, ''),
    );

    // Should not contain browser-recall highlight marks, but text should be preserved
    expect(html).not.toContain('browser-recall-highlight');
    expect(html).not.toMatch(/<mark\b[^>]*>\s*important\s*<\/mark>/i);
    expect(html).toContain('important');

    await helper.close();
    await page.close();
  });

  test('captureSnapshot produces complete, structured searchable Markdown', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const longArticle = `${'substantive article text '.repeat(500)}end-of-article-marker`;
    localServer.addPage('/structured-markdown', {
      title: 'Structured Markdown',
      body: `
        <style>.stylesheet-hidden-search-content { display: none; }</style>
        <main>
          <h1>Psychosis &amp; Care</h1>
          <p>Read <a href="/care">the care guide</a> today.</p>
          <blockquote><p>First line<br>Second line</p></blockquote>
          <ol start="3"><li>Third item<ul><li>Nested item</li></ul></li></ol>
          <pre><code class="language-js">const x = 1;\n  x += 2;</code></pre>
          <table><thead><tr><th>Term</th><th>Meaning</th></tr></thead><tbody><tr><td>care</td><td>support</td></tr></tbody></table>
          <img alt="inline image description" src="data:image/svg+xml;base64,PHN2Zy8+">
          <p>${longArticle}</p>
        </main>
        <button>non-content-control</button>
        <p hidden>hidden-search-noise</p>
        <p class="stylesheet-hidden-search-content">stylesheet-hidden-search-noise</p>
        <script>window.unsearchableScriptToken = 'script-search-noise';</script>
      `,
    });
    const pageUrl = localServer.url('/structured-markdown');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');
    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp).toMatchObject({ success: true });

    const markdown = readFileSync(
      join(setupDir, snapshotSidecarPath(slug, captureResp.timestamp, 'md')),
      'utf8',
    );
    expect(markdown).toContain('# Psychosis & Care');
    expect(markdown).toContain(
      `Read [the care guide](${localServer.url('/care')}) today.`,
    );
    expect(markdown).toContain('> First line\n> Second line');
    expect(markdown).toContain('3. Third item\n   - Nested item');
    expect(markdown).toContain('```js\nconst x = 1;\n  x += 2;\n```');
    expect(markdown).toContain('| Term | Meaning |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| care | support |');
    expect(markdown).toContain('inline image description');
    expect(markdown).toContain('end-of-article-marker');
    expect(markdown).not.toContain('data:image');
    expect(markdown).not.toContain('non-content-control');
    expect(markdown).not.toContain('hidden-search-noise');
    expect(markdown).not.toContain('stylesheet-hidden-search-noise');
    expect(markdown).not.toContain('script-search-noise');

    await helper.close();
    await page.close();
  });

  // captureSnapshot embeds x-browser-recall-slug meta tag in stored HTML
  test('captureSnapshot embeds x-browser-recall-slug meta tag in HTML', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/capture-meta', {
      title: 'Capture Meta Test',
      body: '<p>Page to capture</p>',
    });
    const pageUrl = localServer.url('/capture-meta');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    // Navigate to the page so content script is available for capture
    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    // Open helper, but bring the target page back to foreground before capturing
    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp).toMatchObject({ success: true });
    const timestamp = captureResp.timestamp;

    // Get generated snapshot HTML URL and decode its content.
    const urlResp = await helper.evaluate(
      ({ slug, timestamp }) =>
        chrome.runtime.sendMessage({
          action: 'getSnapshotUrl',
          slug,
          timestamp,
        }),
      { slug, timestamp },
    );
    expect(urlResp.success).toBe(true);

    const html = decodeURIComponent(
      urlResp.url.replace(/^data:text\/html;charset=utf-8,/, ''),
    );
    expect(html).toContain(
      `<meta name="x-browser-recall-slug" content="${slug}">`,
    );

    await helper.close();
    await page.close();
  });
});
