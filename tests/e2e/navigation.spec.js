import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage } from './helpers.js';

test.describe('Navigation and referrer tracking', () => {
  test.beforeAll(({ localServer }) => {
    localServer.addPage('/', {
      title: 'Home Page',
      body: '<h1>Home</h1><a href="/page-a" id="link-a">Go to Page A</a>',
    });
    localServer.addPage('/page-a', {
      title: 'Page A',
      body: '<h1>Page A</h1><a href="/page-b" id="link-b">Go to Page B</a><a href="/" id="link-home">Home</a>',
    });
    localServer.addPage('/page-b', {
      title: 'Page B',
      body: '<h1>Page B</h1><a href="/page-a" id="link-a">Back to A</a>',
    });
    localServer.addPage('/page-c', {
      title: 'Page C',
      body: '<h1>Page C</h1><p>Dead end</p>',
    });
    localServer.addPage('/page-long', {
      title: 'Long Page',
      body: '<h1>Long Page</h1>' + '<p>Lorem ipsum dolor sit amet. </p>'.repeat(200),
    });
  });

  test('click navigation: getPageRelations resolves referrer URL', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/'));
    await page.waitForSelector('#link-a');
    await page.click('#link-a');
    await page.waitForSelector('#link-b');
    await page.waitForTimeout(1000);

    // getPageRelations should resolve the parent URL from session cache
    // (neither page is checkpointed to disk yet)
    const helper = await openHelperPage(extContext, extensionId);
    const relations = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , localServer.url('/page-a'));
    await helper.close();

    expect(relations.success).toBe(true);
    expect(relations.parents.referrers).toContain(localServer.url('/'));

    await page.close();
  });

  test('three-page chain: getPageRelations resolves full parent chain', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/chain-a', {
      title: 'Chain A',
      body: '<a href="/chain-b" id="next">Next</a>',
    });
    localServer.addPage('/chain-b', {
      title: 'Chain B',
      body: '<a href="/chain-c" id="next">Next</a>',
    });
    localServer.addPage('/chain-c', {
      title: 'Chain C',
      body: '<p>End</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/chain-a'));
    await page.waitForSelector('#next');
    await page.click('#next');
    await page.waitForSelector('#next');
    await page.click('#next');
    await page.waitForSelector('p');
    await page.waitForTimeout(1000);

    const helper = await openHelperPage(extContext, extensionId);

    const relB = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , localServer.url('/chain-b'));
    expect(relB.success).toBe(true);
    expect(relB.parents.referrers).toContain(localServer.url('/chain-a'));

    const relC = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , localServer.url('/chain-c'));
    expect(relC.success).toBe(true);
    expect(relC.parents.referrers).toContain(localServer.url('/chain-b'));

    await helper.close();
    await page.close();
  });

  test('multiple pages visited appear in explore with correct titles', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/'));
    await page.waitForSelector('#link-a');
    await page.click('#link-a');
    await page.waitForSelector('#link-b');
    await page.click('#link-b');
    await page.waitForSelector('#link-a');
    await page.waitForTimeout(500);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForFunction(
      () => document.querySelectorAll('.result-row').length >= 3,
      { timeout: 15000 }
    );

    const titles = await options.$$eval('.result-title', els => els.map(el => el.textContent.trim()));
    expect(titles).toContain('Home Page');
    expect(titles).toContain('Page A');
    expect(titles).toContain('Page B');

    await page.close();
    await options.close();
  });

  test('blacklisted URL is not recorded', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        urlBlacklist: [localServer.url('/page-c')],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/'));
    await page.waitForTimeout(500);
    await page.goto(localServer.url('/page-c'));
    await page.waitForTimeout(500);

    const helper = await openHelperPage(extContext, extensionId);
    const info = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url })
    , localServer.url('/page-c'));
    await helper.close();

    expect(info.success).toBe(true);
    expect(info.interaction).toBeNull();

    await page.close();
  });

  test('scroll depth and time on page recorded after navigation away', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/page-long'));
    await page.waitForSelector('h1');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1500);
    // Navigate away to trigger isLeaving report
    await page.goto(localServer.url('/'));
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000);

    // Check raw history entries in session cache for attention data
    const helper = await openHelperPage(extContext, extensionId);
    const historyEntries = await helper.evaluate(async (url) => {
      const today = new Date().toISOString().slice(0, 10);
      const data = await chrome.storage.session.get(['history:' + today]);
      const entries = data['history:' + today] || [];
      return entries.filter(e => e.url === url);
    }, localServer.url('/page-long'));
    await helper.close();

    expect(historyEntries.length).toBeGreaterThan(0);
    expect(historyEntries.some(e => e.scrollDepth > 0)).toBe(true);
    expect(historyEntries.some(e => e.timeOnPage > 0)).toBe(true);

    await page.close();
  });
});
