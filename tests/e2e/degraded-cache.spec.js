/**
 * Degraded session cache E2E tests.
 *
 * Verifies that the options page renders correctly when chrome.storage.session
 * is empty — simulating SW restart, LRU eviction, or disable/re-enable.
 * Data is seeded to disk via resetAndSeed, then session is cleared before
 * opening the options page, forcing all readCacheable calls through the
 * sendMessage → background → disk fallback path.
 */
import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  openHelperPage,
  openOptionsPage,
  getSlugForUrl,
  waitForListView,
} from './helpers.js';

// Clear chrome.storage.session to simulate degraded cache.
async function clearSessionCache(extContext, extensionId) {
  const page = await openHelperPage(extContext, extensionId);
  await page.evaluate(() => chrome.storage.session.clear());
  await page.close();
}

test.describe('Degraded session cache', () => {
  test('sidebar lists render after session cache clear', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Reading List': 'reading' },
        },
      },
    ]);

    await clearSessionCache(extContext, extensionId);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Reading List');
    await options.close();
  });

  test('list pin shows title after session cache clear', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const TEST_URL = 'https://example.com/pinned-article';
    const TEST_SLUG = getSlugForUrl(TEST_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading List',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }],
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Pinned Article',
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
            title: 'Pinned Article',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Reading List': 'reading' },
        },
      },
    ]);

    await clearSessionCache(extContext, extensionId);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Pin should show title from disk-loaded page entity, not "Untitled"
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Pinned Article');
    await options.close();
  });

  test('explore view renders history after session cache clear', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], blacklist: [] },
      },
      {
        path: `data/logs/test-device/${todayStr}.jsonl`,
        lines: [
          {
            timestamp: now - 3000,
            action: 'visit_page',
            url: 'https://example.com/page1',
            title: 'Page One',
          },
          {
            timestamp: now - 2000,
            action: 'visit_page',
            url: 'https://example.com/page2',
            title: 'Page Two',
          },
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: 'https://example.com/page3',
            title: 'Page Three',
          },
        ],
      },
    ]);

    await clearSessionCache(extContext, extensionId);

    const options = await openOptionsPage(extContext, extensionId);

    // Explore view should show history entries loaded from disk
    const results = options.locator('#relatedResults .result-item');
    await expect(results.first()).toBeVisible({ timeout: 10000 });

    // All 3 history entries should be visible
    const content = await options.locator('#relatedResults').textContent();
    expect(content).toContain('Page One');
    expect(content).toContain('Page Two');
    expect(content).toContain('Page Three');
    await options.close();
  });
});
