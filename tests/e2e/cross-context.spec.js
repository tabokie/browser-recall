import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Cross-context consistency', () => {
  test('pin from helper page reflects in already-open options list view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:research'],
      }},
      { path: 'lists/research.json', data: {
        slug: 'research', name: 'Research', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain',
        timestamp: now, parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const optionsA = await openOptionsPage(extContext, extensionId);
    const listItem = optionsA.locator('.sidebar-item[data-list-id="research"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(optionsA);

    let pinnedRows = await optionsA.$$('#pinnedResults .result-row');
    expect(pinnedRows.length).toBe(0);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'research', url })
    , TEST_URL);
    await helper.close();

    const pinnedRow = optionsA.locator('#pinnedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 10000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');
    await optionsA.close();
  });

  test('new page visit notification updates explore view in already-open options', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    let rows = await options.$$('.result-row');
    expect(rows.length).toBe(0);

    // Visit a page — content script reports, mutation notification updates explore
    const page = await extContext.newPage();
    await page.goto('https://example.com');

    const resultRow = options.locator('.result-row');
    await expect(resultRow).toBeVisible({ timeout: 15000 });
    const title = await resultRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');

    await page.close();
    await options.close();
  });
});
