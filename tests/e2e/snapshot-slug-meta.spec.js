import { test, expect } from './fixtures.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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
  test('repairs legacy snapshot HTML when it is read for replay', async ({
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
        content: `<!doctype html><html><head>
          <link rel="stylesheet" href="https://unavailable.example/legacy.css">
          <script id="savepage-shadowloader">savepage_ShadowLoader(5);</script>
        </head><body><p>Legacy snapshot body</p>
          <legacy-outer-card id="legacy-outer-card">
            <template data-savepage-shadowroot="">
              <iframe id="legacy-nested-shadow-frame" srcdoc="${escapedNestedLegacyHtml}"></iframe>
            </template>
          </legacy-outer-card>
        </body></html>`,
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
    await helper.evaluate(() =>
      chrome.storage.local.set({ connectorState: 'offline' }),
    );
    await page.bringToFront();

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
        content: `<!doctype html><html><head><title>Snapshot Create Highlight</title></head><body>${repeatedBody}</body></html>`,
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
        content: `<!doctype html><html><head><title>Snapshot Shadow Highlight</title></head><body>
          <outer-card id="shadow-highlight-outer"><template data-savepage-shadowroot="">
            <inner-card id="shadow-highlight-inner"><template data-savepage-shadowroot="">
              <p id="shadow-highlight-copy">${paragraphText}</p>
            </template></inner-card>
          </template></outer-card>
        </body></html>`,
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
    const pageBody = `<main><p>${highlightText}</p></main>`;

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
        content: `<!doctype html><html><head><title>Highlight Editor Parity</title></head><body>${pageBody}</body></html>`,
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
    const liveEditorPixels = await liveEditor.screenshot();

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
    const snapshotEditorPixels = await snapshotEditor.screenshot();

    expect(snapshotEditorPixels.equals(liveEditorPixels)).toBe(true);

    await viewer.close();
    await livePage.close();
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
        content: `<!doctype html><html><head><title>Snapshot Scoped Highlight</title></head><body><section><p>${highlightText}</p></section><section><p>${highlightText}</p></section></body></html>`,
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
        content: `<!doctype html><html><head><title>Snapshot Highlight UI Exclusion</title></head><body><aside id="browser-recall-highlights-panel">${highlightText}</aside><main><p>${highlightText}</p></main></body></html>`,
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
    expect(captureResp.success).toBe(true);

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
    expect(html).toContain(
      `<meta name="x-browser-recall-slug" content="${slug}">`,
    );

    await helper.close();
    await page.close();
  });
});
