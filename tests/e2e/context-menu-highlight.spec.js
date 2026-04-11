import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage } from './helpers.js';

const TEST_URL = 'https://example.com/article';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Context menu highlight', () => {
  test('contextMenuHighlight creates note for page', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Article',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const resp = await helper.evaluate(
      ({ url, text }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Example Article',
          selectionText: text,
        }),
      { url: TEST_URL, text: 'key finding from the paper' },
    );
    expect(resp.success).toBe(true);
    expect(resp.noteSlug).toBeTruthy();

    const notesResp = await helper.evaluate(
      (slug) => chrome.runtime.sendMessage({ action: 'loadPageNotes', slug }),
      TEST_SLUG,
    );
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes).toHaveLength(1);
    expect(notesResp.notes[0].excerpt).toBe('key finding from the paper');

    await helper.close();
  });

  test('highlights panel appears after context menu highlight', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/ctx-test', {
      title: 'Ctx Test',
      body: '<p>Content</p>',
    });
    const pageUrl = localServer.url('/ctx-test');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: pageUrl,
          title: 'Ctx Test',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(
      ({ url, text }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Ctx Test',
          selectionText: text,
        }),
      { url: pageUrl, text: 'important excerpt' },
    );

    await page.waitForSelector('#portal-highlights-panel', { timeout: 5000 });
    const panelText = await page.evaluate(() => {
      const panel = document.getElementById('portal-highlights-panel');
      return panel?.shadowRoot?.textContent || '';
    });
    expect(panelText).toContain('important excerpt');

    await page.close();
    await helper.close();
  });

  test('highlights panel lists all notes', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/ctx-multi', {
      title: 'Multi',
      body: '<p>Content</p>',
    });
    const pageUrl = localServer.url('/ctx-multi');
    const slug = getSlugForUrl(pageUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: pageUrl,
          title: 'Multi',
          timestamp: now,
          parentIds: [],
          childIds: ['note:note-a', 'note:note-b'],
        },
      },
      {
        path: 'data/notes/note-a.json',
        data: {
          slug: 'note-a',
          excerpt: 'first',
          note: 'my note',
          url: pageUrl,
        },
      },
      {
        path: 'data/notes/note-b.json',
        data: {
          slug: 'note-b',
          excerpt: 'second',
          note: '',
          url: pageUrl,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'contextMenuHighlight',
          url,
          title: 'Multi',
          selectionText: 'third',
        }),
      { url: pageUrl },
    );

    await page.waitForSelector('#portal-highlights-panel', { timeout: 5000 });
    const count = await page.evaluate(() => {
      const panel = document.getElementById('portal-highlights-panel');
      return panel?.shadowRoot?.querySelectorAll('.highlight-item').length || 0;
    });
    expect(count).toBe(3);

    await page.close();
    await helper.close();
  });
});
