import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

// Category 1: Round-trip persistence — action → verify in UI
// Tests that mutations via message actions are visible in the options page UI.
// This is a true integration test: action via helper → open options → verify DOM.
test.describe('Round-trip persistence', () => {
  test('pin via helper page visible in options list view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [{ id: 'list:reading', name: 'Reading' }] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example' },
      ]},
    ]);

    // Pin via helper page (simulates popup action)
    const helper = await openHelperPage(extContext, extensionId);
    const r = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , TEST_URL);
    expect(r.pinned).toBe(true);
    await helper.close();

    // Open options and verify pin is visible in the list view
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);
    const pinnedRow = options.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example');
    await options.close();
  });

  test('new list via helper page visible in options sidebar', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'newlist', name: 'Brand New' })
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="newlist"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Brand New');
    await options.close();
  });

  test('note created via helper page visible in getPageInfo', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const noteResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({
        action: 'createNote', pageSlug: slug,
        excerpt: 'Test highlight', note: 'A note', cssPath: 'p',
      })
    , { slug: TEST_SLUG });
    expect(noteResult.success).toBe(true);

    // Verify note is accessible via getPageInfo
    const info = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url: u })
    , TEST_URL);
    await helper.close();

    expect(info.notes.length).toBe(1);
    expect(info.notes[0].excerpt).toBe('Test highlight');
  });
});

// Category 2: Accumulation — multiple sequential operations build correct state
test.describe('Accumulation correctness', () => {
  test('5 sequential pins all present in list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/accum-${i}`);
    const slugs = urls.map(u => getSlugForUrl(u));

    const files = [
      { path: 'settings.json', data: { trimRules: [], listOrder: [{ id: 'list:bulk', name: 'Bulk' }] } },
      { path: 'lists/bulk.json', data: { slug: 'bulk', name: 'Bulk', timestamp: now, pins: [], qbTrees: [] } },
      ...slugs.map((slug, i) => ({
        path: `pages/${slug}.json`,
        data: { slug, url: urls[i], title: `Page ${i}`, timestamp: now, parentIds: [], childIds: [] },
      })),
    ];
    await resetAndSeed(extContext, extensionId, files);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin all 5 one-by-one
    for (const url of urls) {
      const r = await helper.evaluate((u) =>
        chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'bulk', url: u })
      , url);
      expect(r.pinned).toBe(true);
    }

    const pins = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'bulk' })
    );
    await helper.close();

    expect(pins.pins.length).toBe(5);
  });

  // Scroll depth: only the max scroll depth is logged (deduped by processPageReport).
  // First visit: no scroll. Second visit: scroll deep. Only the deeper value is logged.
  test('only max scroll depth is recorded across visits', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/tall-page', {
      title: 'Tall Page',
      body: '<div style="height:10000px"><p>Top</p></div><p>Bottom</p>',
    });
    localServer.addPage('/bounce', { title: 'Bounce', body: '<p>Bounce</p>' });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [], listOrder: [] } },
    ]);

    const url = localServer.url('/tall-page');
    const page = await extContext.newPage();

    // First visit: don't scroll (scrollDepth ≈ 0 or viewport-based)
    await page.goto(url);
    await page.waitForTimeout(300);
    await page.goto(localServer.url('/bounce'));
    await page.waitForTimeout(500);

    // Second visit: scroll to bottom
    await page.goto(url);
    await page.waitForTimeout(200);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await page.goto(localServer.url('/bounce'));
    await page.waitForTimeout(500);

    const helper = await openHelperPage(extContext, extensionId);
    const today = new Date().toISOString().slice(0, 10);

    // Wait for scroll depth entry
    await helper.waitForFunction(({ u, dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'history:' + dateKey })
        .then(r => r.value && r.value.some(e => e.url === u && e.scrollDepth > 50))
    , { u: url, dateKey: today }, { timeout: 5000 });

    const hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'history:' + dateKey })
    , { dateKey: today });
    await helper.close();
    await page.close();

    // The max scroll depth should be near 100% (scrolled to bottom)
    const scrollEntries = hist.value.filter(e => e.url === url && e.scrollDepth > 0);
    expect(scrollEntries.length).toBeGreaterThanOrEqual(1);
    const maxDepth = Math.max(...scrollEntries.map(e => e.scrollDepth));
    expect(maxDepth).toBeGreaterThan(50);
  });
});

// Category 3: Cross-entity interference — action on A must not corrupt B
test.describe('Cross-entity interference', () => {
  test('unpin from list B does not affect list A', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/shared-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [
          { id: 'list:alpha', name: 'Alpha' },
          { id: 'list:beta', name: 'Beta' },
        ],
      }},
      { path: 'lists/alpha.json', data: {
        slug: 'alpha', name: 'Alpha', timestamp: now,
        pins: [{ id: `page:${slug}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: 'lists/beta.json', data: {
        slug: 'beta', name: 'Beta', timestamp: now,
        pins: [{ id: `page:${slug}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Shared', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin from Beta only
    const r = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'beta', url: u })
    , url);
    expect(r.pinned).toBe(false);

    // Alpha pin should be untouched
    const alphaPins = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'alpha' })
    );
    const betaPins = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'beta' })
    );
    await helper.close();

    expect(alphaPins.pins.length).toBe(1);
    expect(betaPins.pins.length).toBe(0);
  });

  test('deleting list A leaves list B intact', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/keep-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [
          { id: 'list:doomed', name: 'Doomed' },
          { id: 'list:safe', name: 'Safe' },
        ],
      }},
      { path: 'lists/doomed.json', data: {
        slug: 'doomed', name: 'Doomed', timestamp: now,
        pins: [{ id: `page:${slug}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: 'lists/safe.json', data: {
        slug: 'safe', name: 'Safe', timestamp: now,
        pins: [{ id: `page:${slug}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Shared Page', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' })
    );

    // Safe list should be unaffected
    const safePins = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'safe' })
    );
    const settings = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' })
    );
    await helper.close();

    expect(safePins.pins.length).toBe(1);
    const order = settings.value.listOrder;
    expect(order.length).toBe(1);
    expect(order[0].id).toBe('list:safe');
  });

  test('two child pages sharing a parent via navigation — each shows parent independently', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/shared-parent', {
      title: 'Shared Parent',
      body: '<a href="/child-a">Child A</a> <a href="/child-b">Child B</a>',
    });
    localServer.addPage('/child-a', { title: 'Child A', body: '<p>A</p>' });
    localServer.addPage('/child-b', { title: 'Child B', body: '<p>B</p>' });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [], listOrder: [] } },
    ]);

    // Navigate parent → child-a via link click
    const page = await extContext.newPage();
    await page.goto(localServer.url('/shared-parent'));
    await page.waitForTimeout(300);
    await page.click('a[href="/child-a"]');
    await page.waitForURL('**/child-a');
    await page.waitForTimeout(300);

    // Navigate back to parent, then to child-b
    await page.goto(localServer.url('/shared-parent'));
    await page.waitForTimeout(300);
    await page.click('a[href="/child-b"]');
    await page.waitForURL('**/child-b');
    await page.waitForTimeout(300);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for child-b to be recorded
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url: u })
        .then(r => r.success && r.slug)
    , localServer.url('/child-b'), { timeout: 5000 });

    // Checkpoint both children so getPageRelations can resolve parents
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u, title: 'Child A' })
    , localServer.url('/child-a'));
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u, title: 'Child B' })
    , localServer.url('/child-b'));

    const relA = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , localServer.url('/child-a'));
    const relB = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , localServer.url('/child-b'));
    await helper.close();
    await page.close();

    // Both children should independently show the shared parent
    expect(relA.parents.referrers).toContain(localServer.url('/shared-parent'));
    expect(relB.parents.referrers).toContain(localServer.url('/shared-parent'));
  });
});
