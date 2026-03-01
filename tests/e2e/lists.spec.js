import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('List operations', () => {
  test('seeded list appears in sidebar', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading List' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: Date.now(), pins: [], qbTrees: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Reading List');
    await options.close();
  });

  test('list with seeded pin shows page in pinned section', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading List' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const pinnedRow = options.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');
    await options.close();
  });

  test('pin a page via toggleListPin, appears in already-open list view via mutation notification', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading List' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], qbTrees: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const helper = await openHelperPage(extContext, extensionId);
    const pinResult = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url })
    , TEST_URL);
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);
    await helper.close();

    const pinnedRow = options.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 10000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');
    await options.close();
  });

  test('unpin a page via toggleListPin, disappears from already-open list view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading List' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    const pinnedRow = options.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });

    const helper = await openHelperPage(extContext, extensionId);
    const unpinResult = await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url })
    , TEST_URL);
    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);
    await helper.close();

    await expect(pinnedRow).toBeHidden({ timeout: 10000 });
    await options.close();
  });

  test('create a new list via saveListMeta alone, appears in sidebar', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'new-list', name: 'New List' })
    );
    expect(result.success).toBe(true);
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const newListItem = options.locator('.sidebar-item[data-list-id="new-list"]');
    await expect(newListItem).toBeVisible({ timeout: 5000 });
    await expect(newListItem.locator('.label')).toHaveText('New List');
    await options.close();
  });
});
