import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  getSlugForUrl,
  openHelperPage,
  openOptionsPage,
  waitForListView,
  waitForVisitRecorded,
} from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

// Category 1: Round-trip persistence — action → verify in UI
// Tests that mutations via message actions are visible in the options page UI.
// This is a true integration test: action via helper → open options → verify DOM.
test.describe('Round-trip persistence', () => {
  test('pin via helper page visible in options list view', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:reading' }] },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: TEST_URL,
            title: 'Example',
          },
        ],
      },
    ]);

    // Pin via helper page (simulates popup action)
    const helper = await openHelperPage(extContext, extensionId);
    const r = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url: u,
        }),
      TEST_URL,
    );
    expect(r.pinned).toBe(true);
    await helper.close();

    // Open options and verify pin is visible in the list view
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example');
    await options.close();
  });

  test('new list via helper page visible in options sidebar', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'Brand New' }),
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item .label', {
      hasText: 'Brand New',
    });
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await options.close();
  });

  test('note created via helper page visible in getPageInfo', async ({
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
          title: 'Example',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const noteResult = await helper.evaluate(
      ({ slug }) =>
        chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug: slug,
          excerpt: 'Test highlight',
          note: 'A note',
          cssPath: 'p',
        }),
      { slug: TEST_SLUG },
    );
    expect(noteResult.success).toBe(true);

    // Verify note is accessible via getPageInfo
    const info = await helper.evaluate(
      (u) => chrome.runtime.sendMessage({ action: 'getPageInfo', url: u }),
      TEST_URL,
    );
    await helper.close();

    expect(info.notes.length).toBe(1);
    expect(info.notes[0].excerpt).toBe('Test highlight');
  });
});

// Category 2: Accumulation — multiple sequential operations build correct state
test.describe('Accumulation correctness', () => {
  test('5 sequential pins all present in list', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const urls = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/accum-${i}`,
    );
    const slugs = urls.map((u) => getSlugForUrl(u));

    const files = [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:bulk' }] },
      },
      {
        path: 'lists/bulk.json',
        data: {
          slug: 'bulk',
          name: 'Bulk',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Bulk': 'bulk' } },
      },
      ...slugs.map((slug, i) => ({
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: urls[i],
          title: `Page ${i}`,
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      })),
    ];
    await resetAndSeed(extContext, extensionId, files);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin all 5 one-by-one
    for (const url of urls) {
      const r = await helper.evaluate(
        (u) =>
          chrome.runtime.sendMessage({
            action: 'toggleListPin',
            listId: 'bulk',
            url: u,
          }),
        url,
      );
      expect(r.pinned).toBe(true);
    }

    const listResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:bulk' }),
    );
    await helper.close();

    expect((listResult.value?.pins || []).length).toBe(5);
  });

  // Scroll depth: only the max scroll depth is logged (deduped by processPageReport).
  // First visit: no scroll. Second visit: scroll deep. Only the deeper value is logged.
  test('only max scroll depth is recorded across visits', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/tall-page', {
      title: 'Tall Page',
      body: '<div style="height:10000px"><p>Top</p></div><p>Bottom</p>',
    });
    localServer.addPage('/bounce', { title: 'Bounce', body: '<p>Bounce</p>' });

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
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
    await helper.waitForFunction(
      ({ u, dateKey }) =>
        chrome.runtime
          .sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
          .then(
            (r) =>
              r.value && r.value.some((e) => e.url === u && e.scrollDepth > 50),
          ),
      { u: url, dateKey: today },
      { timeout: 5000 },
    );

    const hist = await helper.evaluate(
      ({ dateKey }) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key: 'log:' + dateKey,
        }),
      { dateKey: today },
    );
    await helper.close();
    await page.close();

    // The max scroll depth should be near 100% (scrolled to bottom)
    const scrollEntries = hist.value.filter(
      (e) => e.url === url && e.scrollDepth > 0,
    );
    expect(scrollEntries.length).toBeGreaterThanOrEqual(1);
    const maxDepth = Math.max(...scrollEntries.map((e) => e.scrollDepth));
    expect(maxDepth).toBeGreaterThan(50);
  });
});

// Category 3: Cross-entity interference — action on A must not corrupt B
test.describe('Cross-entity interference', () => {
  test('unpin from list B does not affect list A', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/shared-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:alpha' }, { id: 'list:beta' }],
        },
      },
      {
        path: 'lists/alpha.json',
        data: {
          slug: 'alpha',
          name: 'Alpha',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'lists/beta.json',
        data: {
          slug: 'beta',
          name: 'Beta',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Alpha': 'alpha', 'test-device/Beta': 'beta' },
        },
      },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url,
          title: 'Shared',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin from Beta only
    const r = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'beta',
          url: u,
        }),
      url,
    );
    expect(r.pinned).toBe(false);

    // Alpha pin should be untouched
    const alphaResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:alpha',
      }),
    );
    const betaResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:beta' }),
    );
    await helper.close();

    expect((alphaResult.value?.pins || []).length).toBe(1);
    expect((betaResult.value?.pins || []).length).toBe(0);
  });

  test('deleting list A leaves list B intact', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/keep-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:doomed' }, { id: 'list:safe' }],
        },
      },
      {
        path: 'lists/doomed.json',
        data: {
          slug: 'doomed',
          name: 'Doomed',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'lists/safe.json',
        data: {
          slug: 'safe',
          name: 'Safe',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Doomed': 'doomed', 'test-device/Safe': 'safe' },
        },
      },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url,
          title: 'Shared Page',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' }),
    );

    // Safe list should be unaffected
    const safeResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:safe' }),
    );
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();

    expect((safeResult.value?.pins || []).length).toBe(1);
    expect(root.value.tree.map((n) => n.id)).toContain('list:safe');
    expect(root.value.tree.map((n) => n.id)).not.toContain('list:doomed');
  });

  test('two child pages sharing a parent via navigation — each shows parent independently', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/shared-parent', {
      title: 'Shared Parent',
      body: '<a href="/child-a">Child A</a> <a href="/child-b">Child B</a>',
    });
    localServer.addPage('/child-a', { title: 'Child A', body: '<p>A</p>' });
    localServer.addPage('/child-b', { title: 'Child B', body: '<p>B</p>' });

    const parentUrl = localServer.url('/shared-parent');
    const childAUrl = localServer.url('/child-a');
    const childBUrl = localServer.url('/child-b');
    const parentSlug = getSlugForUrl(parentUrl);
    const childASlug = getSlugForUrl(childAUrl);
    const childBSlug = getSlugForUrl(childBUrl);
    const now = Date.now();

    // Seed page entities so visit_page can enrich them with referrer relations
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
      {
        path: `pages/${parentSlug}.json`,
        data: {
          slug: parentSlug,
          url: parentUrl,
          title: 'Shared Parent',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${childASlug}.json`,
        data: {
          slug: childASlug,
          url: childAUrl,
          title: 'Child A',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${childBSlug}.json`,
        data: {
          slug: childBSlug,
          url: childBUrl,
          title: 'Child B',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    // Navigate parent → child-a via link click
    const page = await extContext.newPage();
    await page.goto(parentUrl);
    await page.waitForSelector('a[href="/child-a"]');
    await page.click('a[href="/child-a"]');
    await page.waitForURL('**/child-a');

    const helper = await openHelperPage(extContext, extensionId);
    await waitForVisitRecorded(helper, page, childAUrl, parentUrl);

    // Navigate back to parent, then to child-b
    await page.goto(parentUrl);
    await page.waitForSelector('a[href="/child-b"]');
    await page.click('a[href="/child-b"]');
    await page.waitForURL('**/child-b');
    await waitForVisitRecorded(helper, page, childBUrl, parentUrl);

    const relA = await helper.evaluate(
      (u) => chrome.runtime.sendMessage({ action: 'getPageRelations', url: u }),
      childAUrl,
    );
    const relB = await helper.evaluate(
      (u) => chrome.runtime.sendMessage({ action: 'getPageRelations', url: u }),
      childBUrl,
    );
    await helper.close();
    await page.close();

    // Both children should independently show the shared parent
    expect(relA.parents.referrers).toContain(parentUrl);
    expect(relB.parents.referrers).toContain(parentUrl);
  });
});

test.describe('Missing CURRENT file', () => {
  test('options page shows fatal error when device ID is unavailable', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Simulate missing CURRENT: clears in-memory ID + deletes file
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'clearDeviceIdForTest' }),
    );

    // Open options page — should show fatal error, not the normal UI
    const options = await extContext.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    // Fatal error overlay should appear with informative message
    const errorOverlay = options.locator('text=Device identity unavailable');
    await expect(errorOverlay).toBeVisible({ timeout: 5000 });

    // Reload button should be present
    const reloadBtn = options.locator('#fatalReloadBtn');
    await expect(reloadBtn).toBeVisible();

    await options.close();
    await helper.close();
  });

  test('popup shows fatal error when device ID is unavailable', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Simulate missing CURRENT
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'clearDeviceIdForTest' }),
    );

    // Open popup — should show fatal error
    const popup = await extContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const errorOverlay = popup.locator('text=Device identity unavailable');
    await expect(errorOverlay).toBeVisible({ timeout: 5000 });

    await popup.close();
    await helper.close();
  });
});

// Category 5: Log buffer resilience
test.describe('Log buffer resilience', () => {
  test('log buffer dedup removes already-flushed entries on rehydrate', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // T1-T3: entries already on disk
    const diskEntries = [
      {
        timestamp: now - 3000,
        action: 'visit_page',
        url: 'https://example.com/d1',
        title: 'D1',
      },
      {
        timestamp: now - 2000,
        action: 'visit_page',
        url: 'https://example.com/d2',
        title: 'D2',
      },
      {
        timestamp: now - 1000,
        action: 'visit_page',
        url: 'https://example.com/d3',
        title: 'D3',
      },
    ];
    // Buffer: T2, T3 (overlap), T4-T6 (new)
    const bufferEntries = [
      {
        timestamp: now - 2000,
        action: 'visit_page',
        url: 'https://example.com/d2',
        title: 'D2',
      },
      {
        timestamp: now - 1000,
        action: 'visit_page',
        url: 'https://example.com/d3',
        title: 'D3',
      },
      {
        timestamp: now + 1000,
        action: 'visit_page',
        url: 'https://example.com/n4',
        title: 'N4',
      },
      {
        timestamp: now + 2000,
        action: 'visit_page',
        url: 'https://example.com/n5',
        title: 'N5',
      },
      {
        timestamp: now + 3000,
        action: 'visit_page',
        url: 'https://example.com/n6',
        title: 'N6',
      },
    ];

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:reading' }] },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
      { path: `data/logs/test-device/${today}.jsonl`, lines: diskEntries },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Inject overlapping logBuffer and rehydrate with keepLogBuffer
    await helper.evaluate(
      (entries) =>
        chrome.runtime.sendMessage({ action: 'setLogBufferForTest', entries }),
      bufferEntries,
    );

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'rehydrateForTest',
        keepLogBuffer: true,
      }),
    );

    // Check buffer: should have only the 3 new entries (overlap deduped)
    const buf = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getLogBufferForTest' }),
    );
    expect(buf.length).toBe(3);

    // Check history cache: should have all 6 unique entries
    const hist = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
      `log:${today}`,
    );
    expect(hist.value.length).toBe(6);

    await helper.close();
  });

  test('log buffer cap enforcement keeps buffer within LOG_BUFFER_MAX_SIZE', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Fill buffer to 1999 entries
    const baseTs = Date.now() - 10000;
    const entries = Array.from({ length: 1999 }, (_, i) => ({
      timestamp: baseTs + i,
      action: 'visit_page',
      url: `https://example.com/buf-${i}`,
      title: `B${i}`,
    }));
    await helper.evaluate(
      (e) =>
        chrome.runtime.sendMessage({
          action: 'setLogBufferForTest',
          entries: e,
        }),
      entries,
    );

    // Add one entry via reportPage (should make it 2000, at the cap)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'reportPage',
        url: 'https://example.com/cap-test-1',
        title: 'Cap Test 1',
        isInitialLoad: true,
      }),
    );

    let buf = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getLogBufferForTest' }),
    );
    expect(buf.length).toBeLessThanOrEqual(2000);

    // Add another — should still be capped
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'reportPage',
        url: 'https://example.com/cap-test-2',
        title: 'Cap Test 2',
        isInitialLoad: true,
      }),
    );

    buf = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getLogBufferForTest' }),
    );
    expect(buf.length).toBeLessThanOrEqual(2000);

    // The newest entries should be preserved
    const hist = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
      `log:${new Date().toISOString().slice(0, 10)}`,
    );
    const urls = (hist.value || []).map((e) => e.url);
    expect(urls).toContain('https://example.com/cap-test-2');

    await helper.close();
  });

  test('concurrent addLog calls are serialized without data loss', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Fire 5 reportPage calls in parallel
    const urls = Array.from(
      { length: 5 },
      (_, i) => `https://example.com/concurrent-${i}`,
    );
    const results = await helper.evaluate(
      (urls) =>
        Promise.all(
          urls.map((url) =>
            chrome.runtime.sendMessage({
              action: 'reportPage',
              url,
              title: `C${url.slice(-1)}`,
              isInitialLoad: true,
            }),
          ),
        ),
      urls,
    );

    // All should succeed
    for (const r of results) {
      expect(r.success).toBe(true);
    }

    // All 5 entries should be in today's history
    const today = new Date().toISOString().slice(0, 10);
    const hist = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
      `log:${today}`,
    );
    const entryUrls = (hist.value || [])
      .filter((e) => e.url?.startsWith('https://example.com/concurrent-'))
      .map((e) => e.url);
    expect(entryUrls.length).toBe(5);
    for (const url of urls) {
      expect(entryUrls).toContain(url);
    }

    // No service error
    const serviceError = await helper.evaluate(() =>
      chrome.storage.session.get('serviceError').then((r) => r.serviceError),
    );
    expect(serviceError).toBeFalsy();

    await helper.close();
  });

  test('GC tombstone cleared during rehydration when entity is restored', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const noteUrl = 'https://example.com/tombstone-page';
    const noteSlug = getSlugForUrl(noteUrl);
    const pageSlug = noteSlug;

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/orphaned.json', data: { entries: [] } },
      {
        path: `pages/${pageSlug}.json`,
        data: {
          slug: pageSlug,
          url: noteUrl,
          title: 'Tombstone Page',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          url: noteUrl,
          excerpt: 'Test note',
          note: '',
          timestamp: now,
          deleted: false,
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Inject logBuffer: delete_note (GCs the page) then restore_note (restores it)
    const deleteTs = now + 1000;
    const restoreTs = now + 2000;
    const bufferEntries = [
      {
        timestamp: deleteTs,
        action: 'delete_note',
        url: noteUrl,
        path: `notes/${noteSlug}.json`,
      },
      {
        timestamp: restoreTs,
        action: 'restore_note',
        url: noteUrl,
        path: `notes/${noteSlug}.json`,
      },
    ];
    await helper.evaluate(
      (e) =>
        chrome.runtime.sendMessage({
          action: 'setLogBufferForTest',
          entries: e,
        }),
      bufferEntries,
    );

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'rehydrateForTest',
        keepLogBuffer: true,
      }),
    );

    // Page entity should be visible (not null/tombstoned)
    const page = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
      `page:${pageSlug}`,
    );
    expect(page.value).not.toBeNull();
    expect(page.value?.slug).toBe(pageSlug);

    // Note should be restored (not deleted)
    const note = await helper.evaluate(
      (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
      `note:${noteSlug}`,
    );
    expect(note.value).not.toBeNull();
    expect(note.value?.deleted).toBe(false);

    await helper.close();
  });
});
