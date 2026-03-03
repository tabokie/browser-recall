import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage, getSlugForUrl } from './helpers.js';

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

  // Bug 855b175: self-referential referrer guard.
  // Original trigger was YouTube SPA navigations where document.referrer equals
  // the current URL. This test uses a regular same-page link click, which also
  // sets document.referrer to the same URL. The guard compares slugs, so both
  // SPA and regular navigation are covered by the same code path.
  test('self-referential navigation does not create self-parent', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/self-link', {
      title: 'Self Link',
      body: '<a href="/self-link" id="self">Self</a>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/self-link'));
    await page.waitForSelector('#self');
    await page.click('#self');
    await page.waitForSelector('#self');

    // Poll until the page visit has been recorded
    const helper = await openHelperPage(extContext, extensionId);
    await helper.waitForFunction(
      async (url) => {
        const resp = await chrome.runtime.sendMessage({ action: 'getPageInfo', url });
        return resp?.interaction != null;
      },
      localServer.url('/self-link'),
      { timeout: 10000 }
    );

    const relations = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , localServer.url('/self-link'));
    await helper.close();

    expect(relations.success).toBe(true);
    // Self-referrer guard: page should NOT list itself as its own parent
    expect(relations.parents.referrers).not.toContain(localServer.url('/self-link'));

    await page.close();
  });

  // Bug: parent-index absorption on checkpoint — shallow page parents preserved (8985127)
  test('parent refs absorbed from SPI when page is checkpointed', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/parent-page', {
      title: 'Parent Page',
      body: '<a href="/child-page" id="go-child">Go Child</a>',
    });
    localServer.addPage('/child-page', {
      title: 'Child Page',
      body: '<p>Child content</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    // Navigate parent → child to establish referrer relationship (child is shallow)
    const page = await extContext.newPage();
    await page.goto(localServer.url('/parent-page'));
    await page.waitForSelector('#go-child');
    await page.click('#go-child');
    await page.waitForSelector('p');

    // Wait for child page to be recorded
    const helper = await openHelperPage(extContext, extensionId);
    await helper.waitForFunction(
      async (url) => {
        const resp = await chrome.runtime.sendMessage({ action: 'getPageInfo', url });
        return resp?.interaction != null;
      },
      localServer.url('/child-page'),
      { timeout: 10000 }
    );

    // Now checkpoint the child page — this triggers page_checkpoint + SPI absorption
    await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url })
    , localServer.url('/child-page'));

    // Verify parent refs were absorbed from SPI into the checkpointed page
    const relations = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , localServer.url('/child-page'));
    await helper.close();

    expect(relations.success).toBe(true);
    expect(relations.parents.referrers).toContain(localServer.url('/parent-page'));

    await page.close();
  });

  // Bug 20260227: gateway promotion should create ONE synthetic root visit
  // at promotion time, but NOT on subsequent child visits.
  test('gateway promotion creates synthetic root visit only once', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/gw-a', { title: 'GW Child A', body: '<p>a</p>' });
    localServer.addPage('/gw-b', { title: 'GW Child B', body: '<p>b</p>' });
    localServer.addPage('/gw-c', { title: 'GW Child C', body: '<p>c</p>' });

    // Start with NO gateways — the origin will be auto-promoted after 2 child visits
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [], listOrder: [] } },
    ]);

    const origin = `http://127.0.0.1:${localServer.port}`;
    const rootUrl = origin + '/';
    const page = await extContext.newPage();

    // Visit 2 child pages → triggers gateway promotion (childCount >= 2)
    await page.goto(localServer.url('/gw-a'));
    await page.waitForTimeout(300);
    await page.goto(localServer.url('/gw-b'));
    await page.waitForTimeout(300);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for promotion: origin should appear in gateways
    await helper.waitForFunction((o) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/gateways' })
        .then(r => r.value?.origins && r.value.origins.includes(o))
    , origin, { timeout: 5000 });

    // Visit a 3rd child page — should NOT create another synthetic root visit
    await page.goto(localServer.url('/gw-c'));
    await page.waitForTimeout(500);

    // Count root URL entries in today's history
    const today = new Date().toISOString().slice(0, 10);
    const hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'history:' + dateKey })
    , { dateKey: today });
    await helper.close();
    await page.close();

    const rootEntries = (hist.value || []).filter(e => e.url === rootUrl);
    // At most 1 synthetic root visit (from promotion), not repeated
    expect(rootEntries.length).toBeLessThanOrEqual(1);
  });

  // Bug 20260301: ensurePageCheckpoint without title should search SPI and
  // history cache to enrich the checkpoint with the correct title.
  test('ensurePageCheckpoint enriches title from history when not provided', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/enrich-title-test';
    const slug = getSlugForUrl(url);
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      // Page visited with title in history, but no checkpoint
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url, title: 'Enriched Title' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create checkpoint WITHOUT title — should search history
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u })
    , url);

    // Check the page entity has the title from history
    const page = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${slug}`);
    await helper.close();

    expect(page.value).toBeTruthy();
    expect(page.value.title).toBe('Enriched Title');
  });
});
