import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage, getSlugForUrl, waitForListView } from './helpers.js';

test.describe('Auto-pin tag', () => {
  test.beforeAll(({ localServer }) => {
    localServer.addPage('/cat-article', {
      title: 'All About Cats',
      body: '<h1>Cats</h1><p>Cats are great pets.</p>',
    });
  });

  test('pages pinned by smart rules show auto tag', async ({ extContext, extensionId, setupDir, localServer }) => {
    const url = localServer.url('/cat-article');
    const slug = getSlugForUrl(url);

    // Seed a list with a keyword rule that matches "cat"
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { tree: [{ id: 'list:my-list', children: [] }] } },
      { path: 'manifest/list-name-to-id.json', data: { paths: { 'test-device/Cat List': 'my-list' } } },
      { path: 'lists/my-list.json', data: {
        name: 'Cat List',
        slug: 'my-list',
        owner: 'test-device',
        pins: [],
        timestamps: { 'test-device': Date.now() },
        rules: [{ id: 'r1', type: 'keyword', config: { pattern: 'cat', fields: ['title'] } }],
      }},
    ]);

    // Report page visit from helper — triggers evaluateSmartRulesForVisit
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async ({ url, title }) => {
      await chrome.runtime.sendMessage({
        action: 'reportPage', url, title, isInitialLoad: true
      });
    }, { url, title: 'All About Cats' });

    // Wait for the rule pin to appear on the list entity
    await helper.evaluate(async (key) => {
      for (let i = 0; i < 40; i++) {
        const r = await chrome.runtime.sendMessage({ action: 'readCacheable', key });
        if (r?.value?.pins?.length > 0) return;
        await new Promise(r => setTimeout(r, 200));
      }
    }, 'list:my-list');

    await helper.close();

    // Open options page, navigate to the list
    const options = await openOptionsPage(extContext, extensionId);
    await options.click('.sidebar-item[data-list-id="my-list"]');
    await waitForListView(options);

    // Wait for pins to render
    await options.waitForFunction(() => {
      return document.querySelectorAll('.result-item').length > 0;
    }, { timeout: 5000 });

    // The auto-pinned page should show an "auto" tag
    const autoTag = await options.evaluate(() => {
      const tags = document.querySelectorAll('.card-tag-auto');
      return tags.length;
    });
    expect(autoTag).toBeGreaterThan(0);

    await options.close();
  });

  test('manually pinned pages do not show auto tag', async ({ extContext, extensionId, setupDir, localServer }) => {
    const url = localServer.url('/cat-article');
    const slug = getSlugForUrl(url);

    // Seed a list with a manual pin (no source field)
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { tree: [{ id: 'list:my-list', children: [] }] } },
      { path: 'manifest/list-name-to-id.json', data: { paths: { 'test-device/My List': 'my-list' } } },
      { path: 'lists/my-list.json', data: {
        name: 'My List',
        slug: 'my-list',
        pins: [{ id: 'page:' + slug, pinnedAt: Date.now() }],
        timestamps: { 'test-device': Date.now() },
      }},
      { path: `pages/${slug}/page.json`, data: {
        url, title: 'All About Cats', slug,
        timestamps: { 'test-device': Date.now() },
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('.sidebar-item[data-list-id="my-list"]');
    await waitForListView(options);

    await options.waitForFunction(() => {
      return document.querySelectorAll('.result-item').length > 0;
    }, { timeout: 5000 });

    // Manual pin should NOT have auto tag
    const autoTag = await options.evaluate(() => {
      return document.querySelectorAll('.card-tag-auto').length;
    });
    expect(autoTag).toBe(0);

    await options.close();
  });
});
