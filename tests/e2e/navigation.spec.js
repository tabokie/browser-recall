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
    const homeUrl = localServer.url('/');
    const pageAUrl = localServer.url('/page-a');
    const homeSlug = getSlugForUrl(homeUrl);
    const pageASlug = getSlugForUrl(pageAUrl);
    const now = Date.now();

    // Seed page entities so visit_page can enrich them with referrer relations
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
      { path: `pages/${homeSlug}.json`, data: {
        slug: homeSlug, url: homeUrl, title: 'Home Page', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: `pages/${pageASlug}.json`, data: {
        slug: pageASlug, url: pageAUrl, title: 'Page A', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(homeUrl);
    await page.waitForSelector('#link-a');
    await page.click('#link-a');
    await page.waitForSelector('#link-b');

    // Wait for visit_page to process and enrich the page entity
    const helper = await openHelperPage(extContext, extensionId);
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
        .then(r => r.success && r.parents.referrers.length > 0)
    , pageAUrl, { timeout: 5000 });

    const relations = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , pageAUrl);
    await helper.close();

    expect(relations.success).toBe(true);
    expect(relations.parents.referrers).toContain(homeUrl);

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

    const chainAUrl = localServer.url('/chain-a');
    const chainBUrl = localServer.url('/chain-b');
    const chainCUrl = localServer.url('/chain-c');
    const now = Date.now();

    // Seed page entities so visit_page can enrich them with referrer relations
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
      { path: `pages/${getSlugForUrl(chainAUrl)}.json`, data: {
        slug: getSlugForUrl(chainAUrl), url: chainAUrl, title: 'Chain A', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: `pages/${getSlugForUrl(chainBUrl)}.json`, data: {
        slug: getSlugForUrl(chainBUrl), url: chainBUrl, title: 'Chain B', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: `pages/${getSlugForUrl(chainCUrl)}.json`, data: {
        slug: getSlugForUrl(chainCUrl), url: chainCUrl, title: 'Chain C', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(chainAUrl);
    await page.waitForSelector('#next');
    await page.click('#next');
    await page.waitForSelector('#next');
    await page.click('#next');
    await page.waitForSelector('p');

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for chain-c visit to process
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
        .then(r => r.success && r.parents.referrers.length > 0)
    , chainCUrl, { timeout: 5000 });

    const relB = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , chainBUrl);
    expect(relB.success).toBe(true);
    expect(relB.parents.referrers).toContain(chainAUrl);

    const relC = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , chainCUrl);
    expect(relC.success).toBe(true);
    expect(relC.parents.referrers).toContain(chainBUrl);

    await helper.close();
    await page.close();
  });

  test('multiple pages visited appear in explore with correct titles', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
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
      { path: 'manifest/settings.json', data: {
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

  test('blacklisted URL: "Capture It" overrides blacklist, revisit is tracked', async ({ extContext, extensionId, setupDir, localServer }) => {
    const url = localServer.url('/page-c');
    const slug = getSlugForUrl(url);
    const now = Date.now();

    // Seed page entity so visit_page can enrich it when blacklist is bypassed
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        trimRules: [],
        urlBlacklist: [url],
      }},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Page C', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();

    // Step 1: Visit blacklisted URL — should NOT create history entries
    await page.goto(localServer.url('/'));
    await page.waitForTimeout(500);
    await page.goto(url);
    await page.waitForTimeout(500);

    let helper = await openHelperPage(extContext, extensionId);
    const today = new Date().toISOString().slice(0, 10);
    let hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
    , { dateKey: today });
    const blacklistedEntries = (hist.value || []).filter(e => e.url === url);
    // The initial blacklisted visit should not be recorded (URL not yet in DB)
    // but once in DB subsequent visits ARE tracked
    expect(blacklistedEntries.length).toBe(0);

    // Step 2: "Capture It" — simulates popup's bypassBlacklist reportPage
    const captureResult = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({
        action: 'reportPage',
        url: u,
        title: 'Page C',
        isInitialLoad: true,
        bypassBlacklist: true,
      })
    , url);
    expect(captureResult.success).toBe(true);

    // Verify the page now has visit_page entry in history
    hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
    , { dateKey: today });
    const bypassEntries = (hist.value || []).filter(e => e.url === url);
    expect(bypassEntries.length).toBeGreaterThanOrEqual(1);

    // Verify getPageInfo returns the page (entity was seeded)
    let info = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url: u })
    , url);
    expect(info.interaction).not.toBeNull();
    expect(info.interaction.url).toBe(url);
    await helper.close();

    // Step 3: Navigate away and revisit — should still be tracked (already in DB)
    await page.goto(localServer.url('/'));
    await page.waitForTimeout(500);
    await page.goto(url);
    await page.waitForTimeout(1000);

    helper = await openHelperPage(extContext, extensionId);
    info = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url: u })
    , url);
    expect(info.interaction).not.toBeNull();
    expect(info.interaction.url).toBe(url);
    await helper.close();

    await page.close();
  });

  test('scroll depth and time on page recorded after navigation away', async ({ extContext, extensionId, setupDir, localServer }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
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
      const data = await chrome.storage.session.get(['log:' + today]);
      const entries = data['log:' + today] || [];
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
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
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

  // visit_page enriches existing page entity with referrer parentIds
  test('parent refs set on page entity via visit_page referrer', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/parent-page', {
      title: 'Parent Page',
      body: '<a href="/child-page" id="go-child">Go Child</a>',
    });
    localServer.addPage('/child-page', {
      title: 'Child Page',
      body: '<p>Child content</p>',
    });

    const parentUrl = localServer.url('/parent-page');
    const childUrl = localServer.url('/child-page');
    const parentSlug = getSlugForUrl(parentUrl);
    const childSlug = getSlugForUrl(childUrl);
    const now = Date.now();

    // Seed page entities so visit_page can enrich them
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
      { path: `pages/${parentSlug}.json`, data: {
        slug: parentSlug, url: parentUrl, title: 'Parent Page', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: `pages/${childSlug}.json`, data: {
        slug: childSlug, url: childUrl, title: 'Child Page', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    // Navigate parent → child to establish referrer relationship
    const page = await extContext.newPage();
    await page.goto(parentUrl);
    await page.waitForSelector('#go-child');
    await page.click('#go-child');
    await page.waitForSelector('p');

    // Wait for referrer to be processed into child entity
    const helper = await openHelperPage(extContext, extensionId);
    await helper.waitForFunction(
      (url) => chrome.runtime.sendMessage({ action: 'getPageRelations', url })
        .then(r => r.success && r.parents.referrers.length > 0),
      childUrl,
      { timeout: 5000 }
    );

    const relations = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url })
    , childUrl);
    await helper.close();

    expect(relations.success).toBe(true);
    expect(relations.parents.referrers).toContain(parentUrl);

    await page.close();
  });

  // page entity title enrichment: pin_to_list on a URL with prior history
  // should create a page entity with the title from that history.
  test('page entity title enriched from history when created by pin action', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/enrich-title-test';
    const slug = getSlugForUrl(url);
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [{ id: 'list:reading' }] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'Reading': 'reading' } } },
      // Page visited with title in history, but no page entity yet
      { path: `data/logs/${today}.jsonl`, lines: [
        { timestamp: now, action: 'visit_page', url, title: 'Enriched Title' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin the page — pin_to_list effectOf creates page entity via ensurePageEntity
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);

    // Check the page entity was created with the correct URL
    const page = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${slug}`);
    await helper.close();

    expect(page.value).toBeTruthy();
    expect(page.value.url).toBe(url);
  });

  // Idempotency: navigating parent→child twice should not duplicate referrer parentIds.
  test('repeated referrer navigation does not duplicate parentIds', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/idem-parent', {
      title: 'Idem Parent',
      body: '<a href="/idem-child" id="go">Go</a>',
    });
    localServer.addPage('/idem-child', {
      title: 'Idem Child',
      body: '<a href="/idem-parent" id="back">Back</a>',
    });

    const parentUrl = localServer.url('/idem-parent');
    const childUrl = localServer.url('/idem-child');
    const parentSlug = getSlugForUrl(parentUrl);
    const childSlug = getSlugForUrl(childUrl);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
      { path: `pages/${parentSlug}.json`, data: {
        slug: parentSlug, url: parentUrl, title: 'Idem Parent', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: `pages/${childSlug}.json`, data: {
        slug: childSlug, url: childUrl, title: 'Idem Child', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();

    // First navigation: parent → child
    await page.goto(parentUrl);
    await page.waitForSelector('#go');
    await page.click('#go');
    await page.waitForSelector('#back');

    // Wait for referrer to be recorded
    const helper = await openHelperPage(extContext, extensionId);
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
        .then(r => r.success && r.parents.referrers.length > 0)
    , childUrl, { timeout: 5000 });

    // Second navigation: back to parent → child again
    await page.click('#back');
    await page.waitForSelector('#go');
    await page.click('#go');
    await page.waitForSelector('#back');
    await page.waitForTimeout(500);

    // Check child's parentIds — should have exactly 1 referrer (not 2)
    const childEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${childSlug}`);

    // Check parent's childIds — should have exactly 1 child ref (not 2)
    const parentEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${parentSlug}`);
    await helper.close();
    await page.close();

    const parentRef = `page:${parentSlug}`;
    const childRef = `page:${childSlug}`;
    expect(childEntity.value.parentIds.filter(id => id === parentRef)).toHaveLength(1);
    expect(parentEntity.value.childIds.filter(id => id === childRef)).toHaveLength(1);
  });

  // Bug: when a page starts without <title> and gets one via JS,
  // leave_page should include the dynamically added title.
  test('leave_page includes title added after initial load', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/no-title', {
      title: null,
      body: '<h1>No Title</h1><script>setTimeout(() => { const t = document.createElement("title"); t.textContent = "Dynamic Title"; document.head.appendChild(t); }, 50);</script>',
    });
    localServer.addPage('/other', {
      title: 'Other Page',
      body: '<p>Other</p>',
    });

    const noTitleUrl = localServer.url('/no-title');
    const otherUrl = localServer.url('/other');
    const slug = getSlugForUrl(noTitleUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Pre-create page entity so visit_page enriches it and leave_page title is stored
      { path: `pages/${slug}.json`, data: {
        slug, url: noTitleUrl, timestamp: 1, parentIds: [], childIds: [], user_title: 'Kept',
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(noTitleUrl);
    // Wait for the dynamic title to be set
    await page.waitForFunction(() => document.title === 'Dynamic Title');
    // Navigate away to trigger leave_page
    await page.goto(otherUrl);
    await page.waitForLoadState('domcontentloaded');

    // Flush drain to disk
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Read the page entity — leave_page should have updated the title
    const entity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${slug}`);
    await helper.close();
    await page.close();

    expect(entity.value).toBeTruthy();
    expect(entity.value.title).toBe('Dynamic Title');
  });
});
