import { test, expect } from './fixtures.js';
import crypto from 'crypto';
import {
  resetAndSeed,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
} from './helpers.js';

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

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const popup = await extContext.newPage();
  await popup.addInitScript(
    ({ url, title }) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: 12001, url, title }];
          }
          return originalQuery(queryInfo);
        };
      };
      patchTabsQuery();
    },
    { url, title },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  return popup;
}

test.describe('Snapshot slug meta tag', () => {
  // Content script resolves slug from x-portal-slug meta tag and reapplies highlights.
  // Simulates the snapshot viewer scenario: the page URL doesn't match the original,
  // but the embedded meta tag tells content.js which page entity to load notes from.
  test('highlights reapplied on page with x-portal-slug meta tag', async ({
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
      body: `<meta name="x-portal-slug" content="${slug}"><p>This is an ${highlightText} in the document.</p>`,
    });

    // Seed: page entity with a note child, and the note entity with an excerpt
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: originalUrl,
          title: 'Example Article',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: highlightText,
          note: '',
          url: originalUrl,
        },
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

  test('popup resolves snapshot pages through the same embedded slug identity as highlights', async ({
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
      body: `<meta name="x-portal-slug" content="${slug}"><p>This page contains a ${highlightText}.</p>`,
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: originalUrl,
          title: 'Original Snapshot Page',
          parentIds: [],
          childIds: [`note:${noteSlug}`],
          timestamps: { 'test-device': now },
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: highlightText,
          note: 'snapshot popup note',
          url: originalUrl,
        },
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: originalUrl,
            title: 'Original Snapshot Page',
          },
        ],
      },
    ]);

    const snapshotUrl = localServer.url('/snapshot-popup-view');
    const snapshotPage = await extContext.newPage();
    await snapshotPage.goto(snapshotUrl);
    await snapshotPage.waitForSelector('mark', { timeout: 5000 });

    const helper = await openHelperPage(extContext, extensionId);
    const snapshotTab = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return tab ? { id: tab.id, url: tab.url, title: tab.title } : null;
    }, snapshotUrl);
    expect(snapshotTab).not.toBeNull();

    const popup = await extContext.newPage();
    await popup.addInitScript((tab) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) return [tab];
          return originalQuery(queryInfo);
        };
      };
      patchTabsQuery();
    }, snapshotTab);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

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
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url: originalUrl,
          title: 'Popup Open Snapshot',
          parentIds: [],
          childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
        },
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: highlightText,
          note: 'snapshot note',
          url: originalUrl,
        },
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: `<!doctype html><html><head><title>Popup Open Snapshot</title></head><body><p>A saved page with ${highlightText} inside.</p></body></html>`,
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
          },
        ],
      },
    ]);

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

    await viewerPopup.close();
    await viewer.close();
    await popup.close();
  });

  // captureSnapshot strips portal highlight marks from captured HTML
  test('captureSnapshot strips highlight marks from HTML', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/with-highlights', {
      title: 'Highlighted Page',
      body: '<p>Some <mark class="portal-highlight" style="background:#fff3b0" data-highlight-text="important">important</mark> text here.</p>',
    });
    const pageUrl = localServer.url('/with-highlights');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp.success).toBe(true);

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

    // Should not contain portal highlight marks, but text should be preserved
    expect(html).not.toContain('portal-highlight');
    expect(html).not.toMatch(/<mark\b[^>]*>\s*important\s*<\/mark>/i);
    expect(html).toContain('important');

    await helper.close();
    await page.close();
  });

  // captureSnapshot embeds x-portal-slug meta tag in stored HTML
  test('captureSnapshot embeds x-portal-slug meta tag in HTML', async ({
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

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

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
    expect(captureResp.success).toBe(true);
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
    expect(html).toContain(`<meta name="x-portal-slug" content="${slug}">`);

    await helper.close();
    await page.close();
  });
});
