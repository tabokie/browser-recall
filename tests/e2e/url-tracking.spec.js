import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

test.describe('Tab reported URL tracking', () => {
  test.beforeAll(({ localServer }) => {
    localServer.addPage('/spa-page', {
      title: 'SPA Page',
      body: '<h1>SPA Page</h1><p>Content here</p>',
    });
  });

  test('getReportedUrl follows query-changing pushState reports', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const originalUrl = localServer.url('/spa-page');
    const slug = getSlugForUrl(originalUrl);
    const pageKey = 'page:' + slug;

    // Navigate to the page in a real tab
    const page = await extContext.newPage();
    await page.goto(originalUrl);

    // Wait for the visit to be recorded
    await helper.evaluate(async (key) => {
      for (let i = 0; i < 30; i++) {
        const r = await chrome.runtime.sendMessage({
          action: 'readDesktopValue',
          key,
        });
        if (r?.value?.timestamps) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, pageKey);

    // Find the tab ID from the helper page via chrome.tabs.query
    const tabId = await helper.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const match = tabs.find((t) => t.url && t.url.startsWith(url));
      return match?.id;
    }, originalUrl);
    expect(tabId).toBeTruthy();

    // getReportedUrl should return the original URL
    const reportedResp = await helper.evaluate(async (tid) => {
      return chrome.runtime.sendMessage({
        action: 'getReportedUrl',
        tabId: tid,
      });
    }, tabId);
    expect(reportedResp.success).toBe(true);
    expect(reportedResp.url).toBe(originalUrl);

    // Simulate SPA URL change via pushState (like YouTube changing watch/search params)
    const modifiedUrl = originalUrl + '?extra=param&pp=abc';
    await page.evaluate((newUrl) => {
      history.pushState({}, '', newUrl);
    }, modifiedUrl);

    await expect
      .poll(async () => {
        const response = await helper.evaluate(async (tid) => {
          return chrome.runtime.sendMessage({
            action: 'getReportedUrl',
            tabId: tid,
          });
        }, tabId);
        return response.url;
      })
      .toBe(modifiedUrl);

    await page.close();
    await helper.close();
  });
});
