import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

// Category 4: Full user journeys — multi-step flows combining several actions
test.describe('User journeys', () => {
  test('create list → pin page → rename list → verify in options sidebar and list view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/journey-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Journey Page', timestamp: now, parentIds: [], childIds: [],
      }},
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url, title: 'Journey Page' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Step 1: Create a new list (returns generated listId)
    const createResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'My Journey' })
    );
    const listId = createResult.listId;
    expect(listId).toBeTruthy();

    // Step 2: Pin the page to it
    const pinResult = await helper.evaluate(({ lid, u }) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: lid, url: u })
    , { lid: listId, u: url });
    expect(pinResult.pinned).toBe(true);

    // Step 3: Rename the list
    await helper.evaluate((lid) =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: lid, name: 'Renamed Journey' })
    , listId);
    await helper.close();

    // Step 4: Verify in options page
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator(`.sidebar-item[data-list-id="${listId}"]`);
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Renamed Journey');

    // Click list and verify pin is visible
    await listItem.click();
    await waitForListView(options);
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Journey Page');
    await options.close();
  });

  test('navigate parent → child → pin child → bidirectional relations', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/j-parent', {
      title: 'Journey Parent',
      body: '<a href="/j-child">Go to child</a>',
    });
    localServer.addPage('/j-child', {
      title: 'Journey Child',
      body: '<p>Child content</p>',
    });

    const parentUrl = localServer.url('/j-parent');
    const childUrl = localServer.url('/j-child');
    const parentSlug = getSlugForUrl(parentUrl);
    const childSlug = getSlugForUrl(childUrl);
    const now = Date.now();

    // Seed page entities so visit_page can enrich them with referrer relations
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
      { path: `pages/${parentSlug}.json`, data: {
        slug: parentSlug, url: parentUrl, title: 'Journey Parent', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${childSlug}.json`, data: {
        slug: childSlug, url: childUrl, title: 'Journey Child', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    // Navigate parent → child via link click
    const page = await extContext.newPage();
    await page.goto(parentUrl);
    await page.waitForTimeout(300);
    await page.click('a[href="/j-child"]');
    await page.waitForURL('**/j-child');
    await page.waitForTimeout(500);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for child visit to be recorded with referrer
    await helper.waitForFunction((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
        .then(r => r.success && r.parents.referrers.length > 0)
    , childUrl, { timeout: 5000 });

    // Verify child → parent relation
    const childRels = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , childUrl);

    // Verify parent → child relation
    const parentRels = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , parentUrl);
    await helper.close();
    await page.close();

    expect(childRels.parents.referrers).toContain(parentUrl);
    expect(parentRels.children).toContain(childUrl);
  });
});

// Category 5: Empty/edge state resilience
test.describe('Empty and edge states', () => {
  test('fresh state — options explore renders without error', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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

  test('pin a never-visited URL — creates page entity without crash', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/never-visited';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [], parentList: 'list:system/root', childLists: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading': 'reading' } } },
      // No history, no page checkpoint — the URL has never been seen
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin should succeed even with no prior data
    const r = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(r.success).toBe(true);
    expect(r.pinned).toBe(true);

    // Page entity should have been created by pin_to_list effectOf
    const pageResult = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${slug}`);

    // Pin should be retrievable
    const listResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    await helper.close();

    expect(pageResult.value).toBeTruthy();
    expect(pageResult.value.url).toBe(url);
    expect((listResult.value?.pins || []).length).toBe(1);
  });

  test('empty list renders list view without error', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:empty'],
      }},
      { path: 'lists/empty.json', data: {
        slug: 'empty', name: 'Empty List', timestamp: now, pins: [],
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
    const pinnedRows = await options.$$('#relatedResults .result-row');
    expect(pinnedRows.length).toBe(0);
    await options.close();
  });

  test('URL with query params and fragment — pin and unpin round-trip', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/page?id=123&lang=en#section-2';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: { slug: 'reading', name: 'Reading', timestamp: now, pins: [], parentList: 'list:system/root', childLists: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading': 'reading' } } },
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `data/logs/${today}.jsonl`, lines: [
        { timestamp: now, action: 'visit_page', url, title },
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:unicode-list'],
      }},
      { path: 'lists/unicode-list.json', data: {
        slug: 'unicode-list', name, timestamp: now, pins: [],
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
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/cjk-live'));

    const helper = await openHelperPage(extContext, extensionId);
    const url = localServer.url('/cjk-live');
    const today = new Date().toISOString().slice(0, 10);

    // Wait for the visit to be recorded
    await helper.waitForFunction(({ u, dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
        .then(r => r.value && r.value.some(e => e.url === u && e.title))
    , { u: url, dateKey: today }, { timeout: 5000 });

    const hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
    , { dateKey: today });
    await helper.close();
    await page.close();

    const entry = hist.value.find(e => e.url === url && e.title);
    expect(entry.title).toBe('知乎专栏 — 深度好文');
  });
});
