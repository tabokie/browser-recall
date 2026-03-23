import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage } from './helpers.js';

test.describe('Snapshot slug meta tag', () => {

  // Content script resolves slug from x-portal-slug meta tag and reapplies highlights.
  // Simulates the snapshot viewer scenario: the page URL doesn't match the original,
  // but the embedded meta tag tells content.js which page entity to load notes from.
  test('highlights reapplied on page with x-portal-slug meta tag', async ({ extContext, extensionId, setupDir, localServer }) => {
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
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
      { path: `pages/${slug}.json`, data: {
        slug, url: originalUrl, title: 'Example Article', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: highlightText, note: '',
        url: originalUrl,
      }},
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

  // openSnapshot opens the snapshot-viewer.html extension page which renders the
  // snapshot in an iframe and applies highlights from the original page's notes.
  test('highlights applied on snapshot via openSnapshot viewer', async ({ extContext, extensionId, setupDir }) => {
    const originalUrl = 'https://example.com/article';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'test-note-blob';
    const highlightText = 'important sentence';
    const now = Date.now();
    const snapTs = now - 1000;

    const snapshotHtml = `<html><head><meta name="x-portal-slug" content="${slug}"></head>` +
      `<body><p>This is an ${highlightText} in the document.</p></body></html>`;

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
      { path: `pages/${slug}.json`, data: {
        slug, url: originalUrl, title: 'Example Article', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`, `snapshot:${slug}-${snapTs}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: highlightText, note: '',
        url: originalUrl,
      }},
      { path: `data/snapshots/${slug}-${snapTs}.html`, content: snapshotHtml },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Open snapshot via openSnapshot — background opens viewer page
    const resp = await helper.evaluate(({ slug, timestamp }) =>
      chrome.runtime.sendMessage({ action: 'openSnapshot', slug, timestamp })
    , { slug, timestamp: snapTs });
    expect(resp.success).toBe(true);

    // Wait for the viewer page to open and iframe to be populated
    const viewerPage = await extContext.waitForEvent('page');
    await viewerPage.waitForLoadState('domcontentloaded');
    await viewerPage.waitForFunction(() => {
      const frame = document.getElementById('frame');
      return frame && frame.srcdoc && frame.srcdoc.length > 0;
    }, { timeout: 5000 });

    // Viewer renders snapshot in an iframe; wait for highlights inside it
    const frame = viewerPage.frameLocator('#frame');
    await frame.locator('mark').waitFor({ timeout: 5000 });
    const markText = await frame.locator('mark').textContent();
    expect(markText).toBe(highlightText);

    await viewerPage.close();
    await helper.close();
  });

  // Popup resolves slug from snapshot-viewer.html URL params
  test('getPageInfo returns notes when called with slug from viewer URL', async ({ extContext, extensionId, setupDir }) => {
    const originalUrl = 'https://example.com/article';
    const slug = getSlugForUrl(originalUrl);
    const noteSlug = 'test-note-viewer';
    const now = Date.now();
    const snapTs = now - 1000;

    const snapshotHtml = `<html><head></head><body><p>Content.</p></body></html>`;

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
      { path: `pages/${slug}.json`, data: {
        slug, url: originalUrl, title: 'Example Article', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`, `snapshot:${slug}-${snapTs}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'some text', note: 'my note',
        url: originalUrl,
      }},
      { path: `data/snapshots/${slug}-${snapTs}.html`, content: snapshotHtml },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Simulate what popup does: extract slug from viewer URL and query getPageInfo
    const info = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', slug })
    , slug);

    expect(info.success).toBe(true);
    expect(info.notes.length).toBe(1);
    expect(info.notes[0].slug).toBe(noteSlug);

    await helper.close();
  });

  // captureSnapshot strips portal highlight marks from captured HTML
  test('captureSnapshot strips highlight marks from HTML', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/with-highlights', {
      title: 'Highlighted Page',
      body: '<p>Some <mark class="portal-highlight" style="background:#fff3b0" data-highlight-text="important">important</mark> text here.</p>',
    });
    const pageUrl = localServer.url('/with-highlights');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' })
    );
    expect(captureResp.success).toBe(true);

    // Fetch the captured HTML
    const htmlResp = await helper.evaluate(({ slug, timestamp }) =>
      chrome.runtime.sendMessage({ action: 'getSnapshotHtml', slug, timestamp })
    , { slug, timestamp: captureResp.timestamp });
    expect(htmlResp.success).toBe(true);

    // Should not contain portal highlight marks, but text should be preserved
    expect(htmlResp.html).not.toContain('portal-highlight');
    expect(htmlResp.html).toContain('important');

    await helper.close();
    await page.close();
  });

  // captureSnapshot embeds x-portal-slug meta tag in stored HTML
  test('captureSnapshot embeds x-portal-slug meta tag in HTML', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/capture-meta', {
      title: 'Capture Meta Test',
      body: '<p>Page to capture</p>',
    });
    const pageUrl = localServer.url('/capture-meta');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
    ]);

    // Navigate to the page so content script is available for capture
    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('load');

    // Open helper, but bring the target page back to foreground before capturing
    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();
    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' })
    );
    expect(captureResp.success).toBe(true);
    const timestamp = captureResp.timestamp;

    // Get blob URL for the snapshot and fetch its HTML content
    const urlResp = await helper.evaluate(({ slug, timestamp }) =>
      chrome.runtime.sendMessage({ action: 'getSnapshotUrl', slug, timestamp })
    , { slug, timestamp });
    expect(urlResp.success).toBe(true);

    // Fetch blob URL content from within the extension origin (same-origin as offscreen)
    const html = await helper.evaluate(async (url) => {
      const resp = await fetch(url);
      return resp.text();
    }, urlResp.url);
    expect(html).toContain(`<meta name="x-portal-slug" content="${slug}">`);

    await helper.close();
    await page.close();
  });

});
