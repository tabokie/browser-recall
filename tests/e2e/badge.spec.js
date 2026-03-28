import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

test.describe('Extension badge', () => {
  test('shows blue dot for page with notes', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/noted', { title: 'Noted Page', body: '<p>Has a note</p>' });
    const url = localServer.url('/noted');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: `pages/${slug}.json`, data: { slug, url, title: 'Noted Page', childIds: ['note:test-note'], parentIds: [], timestamps: { dev1: 1 } } },
      { path: 'notes/test-note.json', data: { slug: 'test-note', excerpt: 'hi', note: 'hi', cssPath: '', url } },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    // Query badge state from a helper page (extension context has chrome.action access)
    const helper = await openHelperPage(extContext, extensionId);
    const tabId = (await page.evaluate(() => {
      // content scripts can't get tabId, query from helper
    }), null);

    // Use the helper page to get badge for the navigated tab
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe(' ');
    // Blue: [74, 144, 217, 255] (#4A90D9)
    expect(badge.color).toEqual([74, 144, 217, 255]);

    await page.close();
    await helper.close();
  });

  test('shows green dot for page pinned in lists', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/listed', { title: 'Listed Page', body: '<p>In a list</p>' });
    const url = localServer.url('/listed');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: `pages/${slug}.json`, data: { slug, url, title: 'Listed Page', childIds: [], parentIds: ['list:my-list'], timestamps: { dev1: 1 } } },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe(' ');
    // Green: [76, 175, 80, 255] (#4CAF50)
    expect(badge.color).toEqual([76, 175, 80, 255]);

    await page.close();
    await helper.close();
  });

  test('shows purple dot for page with both notes and lists', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/both', { title: 'Both Page', body: '<p>Both</p>' });
    const url = localServer.url('/both');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: `pages/${slug}.json`, data: { slug, url, title: 'Both Page', childIds: ['snapshot:test-snap-123'], parentIds: ['list:my-list'], timestamps: { dev1: 1 } } },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe(' ');
    // Purple: [156, 39, 176, 255] (#9C27B0)
    expect(badge.color).toEqual([156, 39, 176, 255]);

    await page.close();
    await helper.close();
  });

  test('no badge for unknown page', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/unknown', { title: 'Unknown Page', body: '<p>No data</p>' });
    const url = localServer.url('/unknown');

    await resetAndSeed(extContext, extensionId);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      return { text };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });
});
