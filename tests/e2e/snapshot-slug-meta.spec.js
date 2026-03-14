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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: originalUrl, title: 'Example Article', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: highlightText, note: '', timestamp: now,
        parentIds: [`page:${slug}`],
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

  // captureSnapshot embeds x-portal-slug meta tag in stored HTML
  test('captureSnapshot embeds x-portal-slug meta tag in HTML', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/capture-meta', {
      title: 'Capture Meta Test',
      body: '<p>Page to capture</p>',
    });
    const pageUrl = localServer.url('/capture-meta');
    const slug = getSlugForUrl(pageUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
