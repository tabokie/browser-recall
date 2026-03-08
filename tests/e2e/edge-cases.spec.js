import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

// Category 4: Full user journeys — multi-step flows combining several actions
test.describe('User journeys', () => {
  test('create list → pin page → rename list → verify in options sidebar and list view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/journey-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Journey Page', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url, title: 'Journey Page' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Step 1: Create a new list
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'journey-list', name: 'My Journey' })
    );

    // Step 2: Pin the page to it
    const pinResult = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'journey-list', url: u })
    , url);
    expect(pinResult.pinned).toBe(true);

    // Step 3: Rename the list
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'journey-list', name: 'Renamed Journey' })
    );
    await helper.close();

    // Step 4: Verify in options page
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="journey-list"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Renamed Journey');

    // Click list and verify pin is visible
    await listItem.click();
    await waitForListView(options);
    const pinnedRow = options.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Journey Page');
    await options.close();
  });

  test('navigate parent → child → checkpoint child → bidirectional relations', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/j-parent', {
      title: 'Journey Parent',
      body: '<a href="/j-child">Go to child</a>',
    });
    localServer.addPage('/j-child', {
      title: 'Journey Child',
      body: '<p>Child content</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    // Navigate parent → child via link click
    const page = await extContext.newPage();
    await page.goto(localServer.url('/j-parent'));
    await page.waitForTimeout(300);
    await page.click('a[href="/j-child"]');
    await page.waitForURL('**/j-child');
    await page.waitForTimeout(500);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for child to be recorded
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url: u })
        .then(r => r.success && r.slug)
    , localServer.url('/j-child'), { timeout: 5000 });

    // Checkpoint the child page
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u, title: 'Journey Child' })
    , localServer.url('/j-child'));

    // Verify child → parent relation
    const childRels = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , localServer.url('/j-child'));

    // Verify parent → child relation
    // First checkpoint the parent so getPageRelations can find it
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u, title: 'Journey Parent' })
    , localServer.url('/j-parent'));

    const parentRels = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , localServer.url('/j-parent'));
    await helper.close();
    await page.close();

    expect(childRels.parents.referrers).toContain(localServer.url('/j-parent'));
    expect(parentRels.children).toContain(localServer.url('/j-child'));
  });
});

// Category 5: Empty/edge state resilience
test.describe('Empty and edge states', () => {
  test('fresh state — options explore renders without error', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Should render explore view with no results and no JS error
    const mainTitle = await options.textContent('#mainTitle');
    expect(mainTitle).toBeTruthy();

    // No result rows expected
    const rows = await options.$$('.result-row');
    expect(rows.length).toBe(0);

    await options.close();
  });

  test('pin a never-visited URL — creates SPI entry without crash', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/never-visited';

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [], parentList: 'list:system/root', childLists: [] } },
      // No history, no page checkpoint — the URL has never been seen
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin should succeed even with no prior data
    const r = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(r.success).toBe(true);
    expect(r.pinned).toBe(true);

    // SPI should have an entry (with null title since never visited)
    const spiResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/shallow-page' })
    );

    // Pin should be retrievable
    const listResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    await helper.close();

    expect(spiResult.value.index[url]).toBeDefined();
    expect(spiResult.value.index[url].lists).toContain('list:reading');
    expect((listResult.value?.pins || []).length).toBe(1);
  });

  test('empty list renders list view without error', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:empty'],
      }},
      { path: 'lists/empty.json', data: {
        slug: 'empty', name: 'Empty List', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="empty"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Should show list layout without error (no pinned rows)
    const layout = options.locator('#listLayout');
    await expect(layout).toBeVisible();
    const pinnedRows = await options.$$('#pinnedResults .result-row');
    expect(pinnedRows.length).toBe(0);
    await options.close();
  });

  test('URL with query params and fragment — pin and unpin round-trip', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/page?id=123&lang=en#section-2';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [], parentList: 'list:system/root', childLists: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Complex URL Page', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin
    const pin = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(pin.pinned).toBe(true);

    // Verify pinned
    let listResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect((listResult.value?.pins || []).length).toBe(1);

    // Unpin
    const unpin = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(unpin.pinned).toBe(false);

    // Verify unpinned
    listResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    await helper.close();
    expect((listResult.value?.pins || []).length).toBe(0);
  });
});

// Category 6: Unicode and special characters
test.describe('Unicode and special characters', () => {
  test('CJK title in history shows correctly in explore', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/cjk-page';
    const title = '这是一个中文标题 — テスト';
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url, title },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 10000 });
    const displayedTitle = await options.$eval('.result-title', el => el.textContent.trim());
    expect(displayedTitle).toBe(title);
    await options.close();
  });

  test('list with unicode name renders in sidebar', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const name = '阅读清单 📚';

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:unicode-list'],
      }},
      { path: 'lists/unicode-list.json', data: {
        slug: 'unicode-list', name, timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="unicode-list"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText(name);
    await options.close();
  });

  test('page visit via content script with CJK title is recorded correctly', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/cjk-live', {
      title: '知乎专栏 — 深度好文',
      body: '<p>Content</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/cjk-live'));

    const helper = await openHelperPage(extContext, extensionId);
    const url = localServer.url('/cjk-live');
    const today = new Date().toISOString().slice(0, 10);

    // Wait for the visit to be recorded
    await helper.waitForFunction(({ u, dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'history:' + dateKey })
        .then(r => r.value && r.value.some(e => e.url === u && e.title))
    , { u: url, dateKey: today }, { timeout: 5000 });

    const hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'history:' + dateKey })
    , { dateKey: today });
    await helper.close();
    await page.close();

    const entry = hist.value.find(e => e.url === url && e.title);
    expect(entry.title).toBe('知乎专栏 — 深度好文');
  });
});
