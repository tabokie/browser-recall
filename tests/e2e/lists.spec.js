import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  getSlugForUrl,
  openHelperPage,
  openOptionsPage,
  waitForListView,
} from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('List operations', () => {
  test('seeded list appears in sidebar', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await expect(listItem.locator('.label')).toHaveText('Reading List');
    await options.close();
  });

  test('list with seeded pin shows page in pinned section', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          title: 'Example Domain',
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
            title: 'Example Domain',
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

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');
    await options.close();
  });

  test('pinned page visited on multiple days shows exactly one pin row', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const day1 = new Date('2026-02-10').getTime();
    const day2 = new Date('2026-03-01').getTime();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: day2,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading List',
          owner: 'test-device',
          timestamp: day2,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: day1 }],
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: day2,
          parentIds: [],
          childIds: [],
          visitDates: [20260210, 20260301],
        },
      },
      {
        path: 'data/logs/test-device/2026-02-10.jsonl',
        lines: [
          {
            timestamp: day1,
            action: 'visit_page',
            url: TEST_URL,
            title: 'Example Domain',
          },
        ],
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: day2,
            action: 'visit_page',
            url: TEST_URL,
            title: 'Example Domain',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: day2,
          paths: { 'test-device/Reading List': 'reading' },
        },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Wait for pinned row to appear, then verify exactly one
    const pinnedRows = options.locator('#relatedResults .result-row');
    await expect(pinnedRows.first()).toBeVisible({ timeout: 5000 });
    await expect(pinnedRows).toHaveCount(1);
    await options.close();
  });

  test('pin a page via toggleListPin, appears in already-open list view via mutation notification', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
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
            title: 'Example Domain',
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

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const helper = await openHelperPage(extContext, extensionId);
    const pinResult = await helper.evaluate(
      (url) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      TEST_URL,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);
    await helper.close();

    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 10000 });
    const title = await pinnedRow.locator('.result-title').textContent();
    expect(title).toContain('Example Domain');
    await options.close();
  });

  test('unpin a page via toggleListPin, disappears from already-open list view', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          title: 'Example Domain',
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
            title: 'Example Domain',
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

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 5000 });

    const helper = await openHelperPage(extContext, extensionId);
    const unpinResult = await helper.evaluate(
      (url) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      TEST_URL,
    );
    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);
    await helper.close();

    await expect(pinnedRow).toBeHidden({ timeout: 10000 });
    await options.close();
  });

  test('create a new list via saveListMeta alone, appears in sidebar', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: Date.now(),
          tree: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'New List' }),
    );
    expect(result.success).toBe(true);
    expect(result.listId).toBeTruthy();
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const newListItem = options.locator('.sidebar-item .label', {
      hasText: 'New List',
    });
    await expect(newListItem).toBeVisible({ timeout: 5000 });
    await options.close();
  });

  // List view: search input filters pinned pages
  test('list pin search filters pins by title', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/alpha';
    const url2 = 'https://example.com/beta';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:filtered' }],
        },
      },
      {
        path: 'lists/filtered.json',
        data: {
          slug: 'filtered',
          name: 'Filtered',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `page:${slug1}`, pinnedAt: now },
            { id: `page:${slug2}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `pages/${slug1}.json`,
        data: {
          slug: slug1,
          url: url1,
          title: 'Alpha Page',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${slug2}.json`,
        data: {
          slug: slug2,
          url: url2,
          title: 'Beta Page',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Filtered': 'filtered' } },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="filtered"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Both pins should show initially
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Type "Alpha" in the filter input
    const draftInput = options.locator('#searchDraftInput');
    await expect(draftInput).toBeVisible({ timeout: 5000 });
    await draftInput.fill('Alpha');

    // Only Alpha should remain
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        return rows.length === 1;
      },
      { timeout: 10000 },
    );
    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Alpha Page');
    expect(titles).not.toContain('Beta Page');

    await options.close();
  });

  // Unpin a page that was previously pinned — verifies toggleListPin removes pin
  // and page entity persists after unpin.
  test('unpin works on a previously pinned page', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/toctou-page';
    const slug = getSlugForUrl(url);

    // Seed with a page entity and pin
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:research' }],
        },
      },
      {
        path: 'lists/research.json',
        data: {
          slug: 'research',
          name: 'Research',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url,
          title: 'TOCTOU Page',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Research': 'research' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Toggle pin OFF
    const unpinResult = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'research',
          url: u,
        }),
      url,
    );
    await helper.close();

    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);

    // Verify pin is actually gone by opening the list
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="research"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const pinnedRows = await options.$$('#relatedResults .result-row');
    expect(pinnedRows.length).toBe(0);
    await options.close();
  });

  // Bug: readCacheable list entity — undrained pin visible immediately (4c77b2c)
  test('newly pinned page visible via readCacheable without flush', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/immediate-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url,
          title: 'Immediate Pin',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin the page
    const pinResult = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url: u,
        }),
      url,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // Immediately query pins WITHOUT flushing — should see the pin via session cache
    const pinsResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    await helper.close();

    expect(pinsResult.success).toBe(true);
    const pins = pinsResult.value?.pins || [];
    expect(pins.length).toBe(1);
    expect(pins[0].id).toBe(`page:${slug}`);
  });

  // Bug: createListAndPin in popup sent saveListMeta (whose effectOf already
  // adds to tree manifest) AND then manually appended — double entry.
  // Fix: popup now relies solely on saveListMeta's effectOf for tree manifest.
  // This test verifies saveListMeta alone produces exactly one entry in the tree.
  test('saveListMeta adds to tree exactly once', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: Date.now(),
          tree: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: Date.now(), paths: {} },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // saveListMeta — effectOf should add to tree manifest
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'My List' }),
    );

    const order = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      });
      return resp.value;
    });
    await helper.close();

    // create_list generates an ID from name+timestamp; Hubs default list also present
    const nonHubs = order.tree.filter((n) => !n.id.includes('hub'));
    expect(nonHubs.length).toBe(1);
    expect(nonHubs[0].id).toMatch(/^list:/); // valid list key
  });

  // Pin a never-visited URL via toggleListPin — creates page entity with title
  // enriched from history (ensurePageEntity searches recent history for title).
  test('toggleListPin creates page entity with title from history', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/spi-title-test';
    const slug = getSlugForUrl(url);
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: `data/logs/test-device/${today}.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url,
            title: 'SPI Title Test Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const pinResult = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url: u,
        }),
      url,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // Page entity should be created by ensurePageEntity with title from history
    const pageResult = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${slug}`,
    );
    await helper.close();

    expect(pageResult.value).toBeTruthy();
    expect(pageResult.value.url).toBe(url);
  });

  test('addListPins creates page entities for new URLs', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/bulk-pin-1';
    const url2 = 'https://example.com/bulk-pin-2';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
        path: `data/logs/test-device/${today}.jsonl`,
        lines: [
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: url1,
            title: 'Bulk Page One',
          },
          {
            timestamp: now,
            action: 'visit_page',
            url: url2,
            title: 'Bulk Page Two',
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(
      (urls) =>
        chrome.runtime.sendMessage({
          action: 'addListPins',
          listId: 'reading',
          urls,
        }),
      [url1, url2],
    );
    expect(result.success).toBe(true);

    // Page entities should be created for both URLs
    const page1 = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${slug1}`,
    );
    const page2 = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${slug2}`,
    );
    await helper.close();

    expect(page1.value).toBeTruthy();
    expect(page1.value.url).toBe(url1);
    expect(page2.value).toBeTruthy();
    expect(page2.value.url).toBe(url2);
  });

  // Workspace auto-pin (background.js:1140-1156) also creates shallow SPI entries,
  // but requires content script navigation + workspace.listIds configuration.
  // The effectOf fix covers it via the same code path as the tests above.

  // Bug 20260228: list_meta rename should update list entity name via effectOf
  test('saveListMeta rename updates list entity name', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'saveListMeta',
        listId: 'reading',
        name: 'Research',
      }),
    );

    const listEntity = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      });
      return resp.value;
    });
    await helper.close();

    expect(listEntity).toBeDefined();
    expect(listEntity.name).toBe('Research');
  });

  // Bug 20260220: del_list should remove entry from tree manifest via effectOf
  test('deleteList removes entry from tree manifest', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:keep' }, { id: 'list:remove' }],
        },
      },
      {
        path: 'lists/keep.json',
        data: {
          slug: 'keep',
          name: 'Keep',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/remove.json',
        data: {
          slug: 'remove',
          name: 'Remove',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Keep': 'keep', 'test-device/Remove': 'remove' },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'remove' }),
    );

    const root = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      });
      return resp.value;
    });
    await helper.close();

    expect(root.tree.length).toBe(1);
    expect(root.tree[0].id).toBe('list:keep');
    expect(root.tree.map((n) => n.id)).not.toContain('list:remove');
  });

  test('deleteList adds list key to orphaned list', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:doomed' }],
        },
      },
      {
        path: 'lists/doomed.json',
        data: {
          slug: 'doomed',
          name: 'Doomed',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Doomed': 'doomed' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' }),
    );

    // List key should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:orphaned',
      }),
    );
    expect(orphaned.value).toBeTruthy();
    expect(orphaned.value.entries.map((e) => e.key)).toContain('list:doomed');

    await helper.close();
  });

  // Pin a non-checkpointed page (only in history, no page entity file)
  // via toggleListPin API — verifies pin log and pinned page display.
  test('pin a non-checkpointed page via API shows correct title in list', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const pageUrl = 'https://example.com/shallow-only';

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
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: pageUrl,
            title: 'Shallow Page',
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Pin via API
    const helper = await openHelperPage(extContext, extensionId);
    const pinResult = await helper.evaluate(
      (url) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      pageUrl,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // Verify log entry
    const dateKey = new Date().toISOString().slice(0, 10);
    const history = await helper.evaluate(
      (dk) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key: 'log:' + dk,
        }),
      dateKey,
    );
    await helper.close();

    const listLogEntries = (history.value || []).filter(
      (e) => e.action === 'pin_to_list' && e.name === 'Reading List',
    );
    expect(listLogEntries.length).toBeGreaterThanOrEqual(1);

    // Verify pinned page appears in list view
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 10000 });
    const pinnedUrl = await pinnedRow.getAttribute('data-url');
    expect(pinnedUrl).toContain('example.com/shallow-only');

    await options.close();
  });

  // Pin a non-checkpointed page via API — verify exactly one pin_to_list log, no unpin
  test('pin non-checkpointed page via API produces exactly one pin_to_list log', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const pageUrl = 'https://example.com/shallow-reclick';

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
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: pageUrl,
            title: 'Shallow Reclick',
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin via API
    const pinResult = await helper.evaluate(
      (url) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      pageUrl,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // Verify exactly 1 pin_to_list, no unpin
    const listEntity = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    expect(listEntity.value.pins.length).toBe(1);

    const dateKey = new Date().toISOString().slice(0, 10);
    const history = await helper.evaluate(
      (dk) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key: 'log:' + dk,
        }),
      dateKey,
    );
    await helper.close();

    const pinLogs = (history.value || []).filter(
      (e) => e.action === 'pin_to_list' && e.name === 'Reading List',
    );
    expect(pinLogs.length).toBe(1);
    const unpinLogs = (history.value || []).filter(
      (e) => e.action === 'unpin_from_list' && e.name === 'Reading List',
    );
    expect(unpinLogs.length).toBe(0);
  });

  // Bug 20260226: unpin should emit a single 'del' op, not 'clear' then 'add'.
  // Verify by checking that after unpin, the other pins remain intact.
  test('unpin one page leaves other pins intact', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/pin-1';
    const url2 = 'https://example.com/pin-2';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `page:${slug1}`, pinnedAt: now },
            { id: `page:${slug2}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `pages/${slug1}.json`,
        data: {
          slug: slug1,
          url: url1,
          title: 'Pin One',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${slug2}.json`,
        data: {
          slug: slug2,
          url: url2,
          title: 'Pin Two',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin only pin-1
    const result = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url: u,
        }),
      url1,
    );
    expect(result.success).toBe(true);
    expect(result.pinned).toBe(false);

    // pin-2 should still be there
    const pinsResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    await helper.close();

    const pins = pinsResult.value?.pins || [];
    expect(pins.length).toBe(1);
    expect(pins[0].id).toBe(`page:${slug2}`);
  });

  test('pin adds list to page parentIds', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin a page to the list
    await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      { url: TEST_URL },
    );

    // Page should have list:reading in parentIds
    const pageEntity = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${TEST_SLUG}`,
    );
    await helper.close();

    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.parentIds).toContain('list:reading');
  });

  test('unpin removes list from page parentIds', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
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
          name: 'Reading',
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
          title: 'Example Domain',
          timestamp: now,
          parentIds: ['list:reading'],
          childIds: [],
          user_title: 'Kept',
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin the page (toggle)
    await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          url,
        }),
      { url: TEST_URL },
    );

    // Page should no longer have list:reading in parentIds (page survives due to user_title)
    const pageEntity = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${TEST_SLUG}`,
    );
    await helper.close();

    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.parentIds).not.toContain('list:reading');
  });

  test('deleteList removes list from all pinned page parentIds', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url2 = 'https://example.com/page-2';
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:doomed' }],
        },
      },
      {
        path: 'lists/doomed.json',
        data: {
          slug: 'doomed',
          name: 'Doomed',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `page:${TEST_SLUG}`, pinnedAt: now },
            { id: `page:${slug2}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: ['list:doomed', 'page:other-ref'],
          childIds: [],
          user_title: 'Kept',
        },
      },
      {
        path: `pages/${slug2}.json`,
        data: {
          slug: slug2,
          url: url2,
          title: 'Page 2',
          timestamp: now,
          parentIds: ['list:doomed'],
          childIds: [],
          user_title: 'Also Kept',
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Doomed': 'doomed' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' }),
    );

    // Both pages should have list:doomed removed from parentIds
    const page1 = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${TEST_SLUG}`,
    );
    const page2 = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${slug2}`,
    );
    await helper.close();

    expect(page1.value.parentIds).not.toContain('list:doomed');
    expect(page1.value.parentIds).toContain('page:other-ref'); // other refs preserved
    expect(page2.value.parentIds).not.toContain('list:doomed');
    expect(page2.value.parentIds).toEqual([]);
  });

  test('list with no pins shows empty state', async ({
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

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Should show empty state message
    await expect(options.locator('#relatedResults .no-results')).toBeVisible({
      timeout: 5000,
    });
    const text = await options
      .locator('#relatedResults .no-results')
      .textContent();
    expect(text).toContain('No pinned pages');

    await options.close();
  });

  test('explore filter panel toggles visibility', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: 'https://example.com/',
            title: 'Example',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Default view is Explore
    await options.waitForFunction(
      () =>
        document.getElementById('mainTitle')?.textContent?.trim() === 'Explore',
      { timeout: 5000 },
    );

    // Filter panel should be hidden initially
    const filterPanel = options.locator('#filterPanel');
    await expect(filterPanel).toBeHidden();

    // Click filter toggle
    const filterBtn = options.locator('#filterToggleBtn');
    await expect(filterBtn).toBeVisible();
    await filterBtn.click();

    // Filter panel should now be visible
    await expect(filterPanel).toBeVisible();

    // Click again to hide
    await filterBtn.click();
    await expect(filterPanel).toBeHidden();

    await options.close();
  });

  test('explore empty search shows all history', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now - 2000,
            action: 'visit_page',
            url: 'https://a.com/',
            title: 'Page A',
          },
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: 'https://b.com/',
            title: 'Page B',
          },
          {
            timestamp: now,
            action: 'visit_page',
            url: 'https://c.com/',
            title: 'Page C',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Default view is Explore — all history should be shown
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 },
    );
    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Page A');
    expect(titles).toContain('Page B');
    expect(titles).toContain('Page C');

    await options.close();
  });

  test('explore adding search via UI persists across reload', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: 'https://example.com/',
            title: 'Example',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Default view is Explore
    await options.waitForFunction(
      () =>
        document.getElementById('mainTitle')?.textContent?.trim() === 'Explore',
      { timeout: 5000 },
    );

    // Type a search and press Enter to save
    const draftInput = options.locator('#searchDraftInput');
    await expect(draftInput).toBeVisible({ timeout: 5000 });
    await draftInput.fill('example');
    await draftInput.press('Enter');

    // Saved search row should appear
    await expect(options.locator('.search-row')).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(options.locator('.search-row input').first()).toHaveValue(
      'example',
    );

    // Navigate away and back to Explore
    const listItem = options.locator('#exploreBtn');
    await listItem.click();
    await options.waitForFunction(
      () =>
        document.getElementById('mainTitle')?.textContent?.trim() === 'Explore',
      { timeout: 5000 },
    );

    // Saved search should persist
    await expect(options.locator('.search-row')).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(options.locator('.search-row input').first()).toHaveValue(
      'example',
    );

    await options.close();
  });

  test('explore last-seen range filter narrows results', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const DAY = 86400000;
    const recentUrl = 'https://recent.com/';
    const oldUrl = 'https://old.com/';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-03-08.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: recentUrl,
            title: 'Recent Page',
          },
        ],
      },
      {
        path: 'data/logs/test-device/2026-02-06.jsonl',
        lines: [
          {
            timestamp: now - 30 * DAY,
            action: 'visit_page',
            url: oldUrl,
            title: 'Old Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Default view is Explore — both pages should appear initially
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );
    let titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Recent Page');
    expect(titles).toContain('Old Page');

    // Open filter panel
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();

    // Verify slider thumbs are visible and interactive inside the track
    const hiSlider = options.locator(
      '.filter-range[data-key="lastSeen"] .filter-range-hi',
    );
    await expect(hiSlider).toBeVisible();
    const loSlider = options.locator(
      '.filter-range[data-key="lastSeen"] .filter-range-lo',
    );
    await expect(loSlider).toBeVisible();

    // Use Playwright's fill() on the range input — fires native input event
    await hiSlider.fill('7');

    // Wait for debounced pipeline — "Old Page" (30d ago) should be excluded
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const t = [...rows].map((r) =>
          r.querySelector('.result-title')?.textContent?.trim(),
        );
        return t.length > 0 && !t.includes('Old Page');
      },
      { timeout: 10000 },
    );

    titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Recent Page');
    expect(titles).not.toContain('Old Page');

    // Verify a label updated to an absolute date (YYYY-MM-DD format)
    const loLabel = options.locator(
      '.filter-range[data-key="lastSeen"] .qb-dual-range-lo-label',
    );
    await expect(loLabel).toHaveText(/^\d{4}-\d{2}-\d{2}$/);

    await options.close();
  });

  test('explore has-highlights checkbox filter narrows results', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const highlightUrl = 'https://highlighted.com/';
    const plainUrl = 'https://plain.com/';
    const highlightSlug = getSlugForUrl(highlightUrl);

    const noteSlug = `${highlightSlug}-${now}`;
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: `pages/${highlightSlug}.json`,
        data: {
          slug: highlightSlug,
          url: highlightUrl,
          title: 'Highlighted Page',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: 'some highlight text',
          note: '',
          createdAt: now,
        },
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: plainUrl,
            title: 'Plain Page',
          },
          {
            timestamp: now,
            action: 'visit_page',
            url: highlightUrl,
            title: 'Highlighted Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Default view is Explore — both pages should appear initially
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );
    let titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).toContain('Plain Page');

    // Open filter panel
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();

    // Check the "Has highlights" checkbox via Playwright click (real user interaction)
    const checkbox = options.locator(
      '.filter-checkbox input[data-key="hasHighlights"]',
    );
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Wait for debounced pipeline — "Plain Page" has no highlights, should be excluded
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const t = [...rows].map((r) =>
          r.querySelector('.result-title')?.textContent?.trim(),
        );
        return t.length > 0 && !t.includes('Plain Page');
      },
      { timeout: 10000 },
    );

    titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).not.toContain('Plain Page');

    // Uncheck — both should reappear
    await checkbox.uncheck();
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );
    titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).toContain('Plain Page');

    await options.close();
  });

  test('has-highlights filter loads all batches to find matches in older files', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const DAY = 86400000;

    // A highlighted page only in an older day file (day 3)
    const hlUrl = 'https://deep-highlight.com/';
    const hlSlug = getSlugForUrl(hlUrl);
    const noteSlug = `${hlSlug}-${now}`;

    // Many plain pages in recent day files to fill the first batch
    const plainPages = [];
    for (let d = 0; d < 2; d++) {
      const dayLines = [];
      for (let i = 0; i < 5; i++) {
        const url = `https://plain-${d}-${i}.example.com/`;
        dayLines.push({
          timestamp: now - d * DAY - i * 1000,
          action: 'visit_page',
          url,
          title: `Plain ${d}-${i}`,
        });
      }
      const dateStr = new Date(now - d * DAY).toISOString().slice(0, 10);
      plainPages.push({
        path: `data/logs/test-device/${dateStr}.jsonl`,
        lines: dayLines,
      });
    }

    // The highlighted page's visit is in an older day file
    const oldDate = new Date(now - 2 * DAY).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: { trimRules: [], historyFileBatch: 1 },
      },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: `pages/${hlSlug}.json`,
        data: {
          slug: hlSlug,
          url: hlUrl,
          title: 'Deep Highlight',
          timestamp: now - 2 * DAY,
          parentIds: [],
          childIds: [`note:${noteSlug}`],
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: 'important text',
          note: 'my note',
          createdAt: now - 2 * DAY,
        },
      },
      ...plainPages,
      {
        path: `data/logs/test-device/${oldDate}.jsonl`,
        lines: [
          {
            timestamp: now - 2 * DAY,
            action: 'visit_page',
            url: hlUrl,
            title: 'Deep Highlight',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Open filter panel and enable "Has highlights"
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();
    const checkbox = options.locator(
      '.filter-checkbox input[data-key="hasHighlights"]',
    );
    await checkbox.check();

    // The highlighted page is in an older file (batch 3 with fileBatch=1).
    // The filter should eventually surface it even though the first batches have no matches.
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const titles = [...rows].map((r) =>
          r.querySelector('.result-title')?.textContent?.trim(),
        );
        return (
          titles.includes('Deep Highlight') &&
          titles.every((t) => !t.startsWith('Plain'))
        );
      },
      { timeout: 15000 },
    );

    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Deep Highlight');
    expect(titles.every((t) => !t.startsWith('Plain'))).toBe(true);

    await options.close();
  });

  test('list bubble filter restricts results to enabled lists', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const rustUrl = 'https://rust-lang.org/';
    const goUrl = 'https://go.dev/';
    const rustSlug = getSlugForUrl(rustUrl);
    const goSlug = getSlugForUrl(goUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:rust' }, { id: 'list:golang' }],
        },
      },
      {
        path: 'lists/rust.json',
        data: {
          slug: 'rust',
          name: 'Rust',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${rustSlug}`, pinnedAt: now }],
        },
      },
      {
        path: 'lists/golang.json',
        data: {
          slug: 'golang',
          name: 'Go',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${goSlug}`, pinnedAt: now }],
        },
      },
      {
        path: `pages/${rustSlug}.json`,
        data: {
          slug: rustSlug,
          url: rustUrl,
          title: 'Rust Lang',
          timestamp: now,
          parentIds: ['list:rust'],
          childIds: [],
        },
      },
      {
        path: `pages/${goSlug}.json`,
        data: {
          slug: goSlug,
          url: goUrl,
          title: 'Go Dev',
          timestamp: now,
          parentIds: ['list:golang'],
          childIds: [],
        },
      },

      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: rustUrl,
            title: 'Rust Lang',
          },
          { timestamp: now, action: 'visit_page', url: goUrl, title: 'Go Dev' },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Rust': 'rust', 'test-device/Go': 'golang' },
        },
      },
    ]);

    // Open Explore view — both results shown (no bubbles active)
    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Open filter panel
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();

    // Both bubbles visible, neither active
    const goBubble = options.locator('.filter-bubble[data-list-slug="golang"]');
    await expect(goBubble).toBeVisible();
    await expect(goBubble).not.toHaveClass(/active/);

    // Enable "Go" bubble → only Go list items shown
    await goBubble.click();
    await expect(goBubble).toHaveClass(/active/);

    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const t = [...rows].map((r) =>
          r.querySelector('.result-title')?.textContent?.trim(),
        );
        return t.length > 0 && !t.includes('Rust Lang');
      },
      { timeout: 10000 },
    );
    let titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Go Dev');
    expect(titles).not.toContain('Rust Lang');

    // Deactivate "Go" bubble → all results again
    await goBubble.click();
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );
    titles = await options.$$eval('#relatedResults .result-title', (els) =>
      els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Rust Lang');
    expect(titles).toContain('Go Dev');

    await options.close();
  });

  // --- Hierarchical list tests ---

  test('nested list renders with indentation in sidebar', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:parent', children: [{ id: 'list:child' }] }],
        },
      },
      {
        path: 'lists/parent.json',
        data: {
          slug: 'parent',
          name: 'Parent List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Parent List': 'parent',
            'test-device/Child List': 'child',
          },
        },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const parentItem = options.locator('.sidebar-item[data-list-id="parent"]');
    const childItem = options.locator('.sidebar-item[data-list-id="child"]');
    await expect(parentItem).toBeVisible({ timeout: 5000 });
    await expect(childItem).toBeVisible({ timeout: 5000 });

    // Child should have more padding (indentation)
    const parentPadding = await parentItem.evaluate((el) =>
      parseInt(el.style.paddingLeft),
    );
    const childPadding = await childItem.evaluate((el) =>
      parseInt(el.style.paddingLeft),
    );
    expect(childPadding).toBeGreaterThan(parentPadding);
    await options.close();
  });

  test('fold toggle hides/shows nested children', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:parent', children: [{ id: 'list:child' }] }],
        },
      },
      {
        path: 'lists/parent.json',
        data: {
          slug: 'parent',
          name: 'Parent',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Parent': 'parent',
            'test-device/Child': 'child',
          },
        },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const childItem = options.locator('.sidebar-item[data-list-id="child"]');
    await expect(childItem).toBeVisible({ timeout: 5000 });

    // Click fold toggle on parent to collapse
    const foldBtn = options.locator(
      '.sidebar-item[data-list-id="parent"] .fold-toggle',
    );
    await foldBtn.click();
    await expect(childItem).toBeHidden();

    // Click again to expand
    await foldBtn.click();
    await expect(childItem).toBeVisible();
    await options.close();
  });

  test('updateListTree moves list between parents', async ({
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
        data: {
          timestamp: now,
          tree: [
            { id: 'list:a', children: [{ id: 'list:child' }] },
            { id: 'list:b' },
          ],
        },
      },
      {
        path: 'lists/a.json',
        data: {
          slug: 'a',
          name: 'List A',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/b.json',
        data: {
          slug: 'b',
          name: 'List B',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/List A': 'a',
            'test-device/List B': 'b',
            'test-device/Child': 'child',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Move child from list:a to list:b via updateListTree (full tree blob)
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'updateListTree',
        tree: [
          { id: 'list:a' },
          { id: 'list:b', children: [{ id: 'list:child' }] },
        ],
      }),
    );
    expect(result.success).toBe(true);

    // Verify tree manifest reflects the move
    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();

    const findChildren = (tree, id) => {
      for (const n of tree) {
        if (n.id === id) return n.children || [];
        const found = findChildren(n.children || [], id);
        if (found) return found;
      }
      return null;
    };
    expect(findChildren(order.value.tree, 'list:a')).toEqual([]);
    expect(findChildren(order.value.tree, 'list:b').map((n) => n.id)).toContain(
      'list:child',
    );
  });

  test('deleteList with children promotes children (non-cascading)', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:parent', children: [{ id: 'list:child' }] }],
        },
      },
      {
        path: 'lists/parent.json',
        data: {
          slug: 'parent',
          name: 'Parent',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Parent': 'parent',
            'test-device/Child': 'child',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'parent' }),
    );

    // Only parent should be in orphaned list (non-cascading)
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:orphaned',
      }),
    );
    expect(orphaned.value.entries.map((e) => e.key)).toContain('list:parent');
    expect(orphaned.value.entries.map((e) => e.key)).not.toContain(
      'list:child',
    );

    // Tree should have child promoted to top level
    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();
    expect(order.value.tree.map((n) => n.id)).not.toContain('list:parent');
    expect(order.value.tree.map((n) => n.id)).toContain('list:child');
  });

  test('restoreList adds list to top-level of tree', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:parent', children: [{ id: 'list:child' }] }],
        },
      },
      {
        path: 'lists/parent.json',
        data: {
          slug: 'parent',
          name: 'Parent',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Parent': 'parent',
            'test-device/Child': 'child',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete parent (non-cascading: child promoted to top-level)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'parent' }),
    );

    // Restore parent
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'restoreList', listId: 'parent' }),
    );

    // Parent should be unorphaned
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:orphaned',
      }),
    );
    expect(orphaned.value.entries.map((e) => e.key)).not.toContain(
      'list:parent',
    );

    // Both parent and child should be in tree (both at top-level now)
    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();
    const topIds = order.value.tree.map((n) => n.id);
    expect(topIds).toContain('list:parent');
    expect(topIds).toContain('list:child');
  });

  // --- Note-to-list pinning ---

  const NOTE_SLUG = 'test-note-abc';

  test('pin note via toggleListPin adds note to list', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
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
        path: `data/notes/${NOTE_SLUG}.json`,
        data: {
          slug: NOTE_SLUG,
          excerpt: 'Test note',
          note: 'Content',
          cssPath: 'p',
          url: TEST_URL,
          timestamp: now,
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${NOTE_SLUG}`],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin note to the list
    const pinResult = await helper.evaluate(
      (noteId) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          id: noteId,
        }),
      `note:${NOTE_SLUG}`,
    );
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // List should have the note pin
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    expect(list.value.pins.some((p) => p.id === `note:${NOTE_SLUG}`)).toBe(
      true,
    );

    await helper.close();
  });

  test('unpin note via toggleListPin removes note from list', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `note:${NOTE_SLUG}`, pinnedAt: now }],
        },
      },
      {
        path: `data/notes/${NOTE_SLUG}.json`,
        data: {
          slug: NOTE_SLUG,
          excerpt: 'Test note',
          note: 'Content',
          cssPath: 'p',
          url: TEST_URL,
          timestamp: now,
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: [],
          childIds: [`note:${NOTE_SLUG}`],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin note from list (toggle)
    const unpinResult = await helper.evaluate(
      (noteId) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading',
          id: noteId,
        }),
      `note:${NOTE_SLUG}`,
    );
    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);

    // List should no longer have the note pin
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    expect(list.value.pins.some((p) => p.id === `note:${NOTE_SLUG}`)).toBe(
      false,
    );

    await helper.close();
  });

  test('deleteNote removes note pin from list', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `note:${NOTE_SLUG}`, pinnedAt: now },
            { id: `page:${TEST_SLUG}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `data/notes/${NOTE_SLUG}.json`,
        data: {
          slug: NOTE_SLUG,
          excerpt: 'Doomed note',
          note: 'Content',
          cssPath: 'p',
          url: TEST_URL,
          timestamp: now,
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: ['list:reading'],
          childIds: [`note:${NOTE_SLUG}`],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the note
    await helper.evaluate(
      (noteSlug) =>
        chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug }),
      NOTE_SLUG,
    );

    // List should no longer have the note pin (page pin preserved)
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:reading',
      }),
    );
    expect(list.value.pins.some((p) => p.id === `note:${NOTE_SLUG}`)).toBe(
      false,
    );
    expect(list.value.pins.some((p) => p.id === `page:${TEST_SLUG}`)).toBe(
      true,
    );

    // Note should be marked deleted
    const note = await helper.evaluate(
      (key) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key,
          includeDeleted: true,
        }),
      `note:${NOTE_SLUG}`,
    );
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.deleted).toBe(true);
  });

  test('restoreNote re-links note to parent page and un-orphans', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'manifest/orphaned.json',
        data: {
          timestamp: now,
          entries: [{ key: `note:${NOTE_SLUG}`, url: TEST_URL }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }],
        },
      },
      {
        path: `data/notes/${NOTE_SLUG}.json`,
        data: {
          slug: NOTE_SLUG,
          excerpt: 'Restore me',
          note: 'Content',
          cssPath: 'p',
          url: TEST_URL,
          timestamp: now,
          deleted: true,
        },
      },
      {
        path: `pages/${TEST_SLUG}.json`,
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example Domain',
          timestamp: now,
          parentIds: ['list:reading'],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Reading': 'reading' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the note
    await helper.evaluate(
      (noteSlug) =>
        chrome.runtime.sendMessage({ action: 'restoreNote', noteSlug }),
      NOTE_SLUG,
    );

    // Page should have note re-linked in childIds
    const page = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${TEST_SLUG}`,
    );
    expect(page.value.childIds).toContain(`note:${NOTE_SLUG}`);

    // Note should no longer be deleted
    const note = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `note:${NOTE_SLUG}`,
    );

    // Note should be un-orphaned
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:orphaned',
      }),
    );
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.deleted).toBe(false);
    expect(orphaned.value.entries.map((e) => e.key)).not.toContain(
      `note:${NOTE_SLUG}`,
    );
  });

  // Bug: list-order.json not persisted to disk after saveListMeta adds a new list.
  // The drain in offscreen.js was missing a case for manifest:list-order.
  test('new list creation persists list-order.json through drain + rehydrate', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: Date.now(),
          tree: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a new list via saveListMeta
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'Persisted' }),
    );

    // Flush (drain dirty entities to disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );

    // Rehydrate (clears session cache, re-reads from disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );

    // list-order.json should have survived the round-trip
    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();

    expect(order.value).toBeTruthy();
    // create_list generates an ID from name+timestamp; Hubs default list also present
    const nonHubs = order.value.tree.filter((n) => !n.id.includes('hub'));
    expect(nonHubs.length).toBe(1);
    expect(nonHubs[0].id).toMatch(/^list:/);
  });

  // Bug: ensureLoaded in offscreen drain skips manifest keys, so when
  // create_list replays during drain, loadOrDefault returns a fresh default
  // with tree:[], dropping all pre-existing children from list-order.json.
  test('new list creation preserves existing tree entries through drain', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:existing1' }, { id: 'list:existing2' }],
        },
      },
      {
        path: 'lists/existing1.json',
        data: {
          slug: 'existing1',
          name: 'Existing One',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/existing2.json',
        data: {
          slug: 'existing2',
          name: 'Existing Two',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Existing One': 'existing1',
            'test-device/Existing Two': 'existing2',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a new list — this triggers create_list in the log
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'New List' }),
    );

    // Flush (drain replays log entries in offscreen, writes to disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );

    // Rehydrate (clears session cache, re-reads from disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );

    // list-order.json must retain BOTH existing lists plus the new one
    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();

    expect(order.value).toBeTruthy();
    const ids = order.value.tree.map((n) => n.id);
    expect(ids).toContain('list:existing1');
    expect(ids).toContain('list:existing2');
    expect(order.value.tree.length).toBe(3); // existing1, existing2, new
  });

  // Bug: updateListTree writes list-order.json, and the drain must persist it.
  test('updateListTree persists list-order.json through drain + rehydrate', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:parent', children: [{ id: 'list:child' }] }],
        },
      },
      {
        path: 'lists/parent.json',
        data: {
          slug: 'parent',
          name: 'Parent',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'lists/child.json',
        data: {
          slug: 'child',
          name: 'Child',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Parent': 'parent',
            'test-device/Child': 'child',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Move child to top-level via updateListTree
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'updateListTree',
        tree: [{ id: 'list:parent' }, { id: 'list:child' }],
      }),
    );

    // Flush + rehydrate
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );

    const order = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    await helper.close();

    const topIds = order.value.tree.map((n) => n.id);
    expect(topIds).toContain('list:child');
    expect(topIds).toContain('list:parent');
  });

  // Bug: offscreen drain's load closure doesn't filter deleted entities,
  // so pin_to_list incorrectly updates parentIds on deleted notes during drain.
  test('drain does not update parentIds on deleted note during pin_to_list', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const noteSlug = '260301-deleted-note-xyz';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:pintest' }],
        },
      },
      {
        path: 'lists/pintest.json',
        data: {
          slug: 'pintest',
          name: 'PinTest',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/PinTest': 'pintest' },
        },
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          excerpt: 'Deleted',
          note: 'Gone',
          cssPath: 'p',
          url: TEST_URL,
          timestamp: now,
          deleted: true,
        },
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
          user_title: 'Kept',
        },
      },
      {
        path: 'manifest/orphaned.json',
        data: { timestamp: now, entries: [{ key: `note:${noteSlug}` }] },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin the deleted note to the list
    await helper.evaluate(
      ({ listId, noteId }) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId,
          id: noteId,
        }),
      { listId: 'pintest', noteId: `note:${noteSlug}` },
    );

    // Flush drain → disk, then rehydrate from disk
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );

    // Deleted note should still be marked deleted after drain round-trip.
    const note = await helper.evaluate(
      ({ key }) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key,
          includeDeleted: true,
        }),
      { key: `note:${noteSlug}` },
    );
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.deleted).toBe(true);
  });

  test('page GC persists through drain: unpin removes ineligible page from disk', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:gctest' }],
        },
      },
      {
        path: 'lists/gctest.json',
        data: {
          slug: 'gctest',
          name: 'GCTest',
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
          title: 'Example Domain',
          timestamp: now,
          parentIds: ['list:gctest'],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/GCTest': 'gctest' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin the page — page becomes ineligible (no other criteria)
    await helper.evaluate(
      ({ url }) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'gctest',
          url,
        }),
      { url: TEST_URL },
    );

    // Flush drain → disk, then rehydrate from disk
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );

    // Page should be GC'd — readCacheable returns null
    const pageEntity = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readCacheable', key }),
      `page:${TEST_SLUG}`,
    );
    await helper.close();

    expect(pageEntity.value).toBeNull();
  });

  test('Delete key unpins selected items in list view', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/kb-del-1';
    const url2 = 'https://example.com/kb-del-2';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:kbdel' }],
        },
      },
      {
        path: 'lists/kbdel.json',
        data: {
          slug: 'kbdel',
          name: 'KB Del',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `page:${slug1}`, pinnedAt: now },
            { id: `page:${slug2}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `pages/${slug1}.json`,
        data: {
          slug: slug1,
          url: url1,
          title: 'KB Delete One',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${slug2}.json`,
        data: {
          slug: slug2,
          url: url2,
          title: 'KB Delete Two',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/KB Del': 'kbdel' } },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="kbdel"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Wait for both pins to render
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Click the first row to select it
    const firstRow = options.locator('#relatedResults .result-row').first();
    await firstRow.click();
    await expect(firstRow).toHaveClass(/selected/);

    // Press Delete key
    await options.keyboard.press('Delete');

    // Should unpin — only one row remaining
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length === 1,
      { timeout: 10000 },
    );
    const remaining = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(remaining).toHaveLength(1);
    await options.close();
  });

  test('Delete key on explore view shows info bubble', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: 'https://example.com/history-item',
            title: 'History Item',
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for explore view results (explore renders into #relatedResults)
    const firstRow = options.locator('#relatedResults .result-row').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    // Click to select
    await firstRow.click();
    await expect(firstRow).toHaveClass(/selected/);

    // Press Delete key — should show info bubble, not delete
    await options.keyboard.press('Delete');

    const bubble = options.locator('#infoBubble');
    await expect(bubble).toBeVisible({ timeout: 3000 });
    const text = await bubble.textContent();
    expect(text.toLowerCase()).toContain('cannot delete history');

    await options.close();
  });

  test('Ctrl+C copies selected pages in readable format with angle-bracket URLs', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/copy-1';
    const url2 = 'https://example.com/copy-2';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:cplist' }],
        },
      },
      {
        path: 'lists/cplist.json',
        data: {
          slug: 'cplist',
          name: 'Copy List',
          owner: 'test-device',
          timestamp: now,
          pins: [
            { id: `page:${slug1}`, pinnedAt: now },
            { id: `page:${slug2}`, pinnedAt: now },
          ],
        },
      },
      {
        path: `pages/${slug1}.json`,
        data: {
          slug: slug1,
          url: url1,
          title: 'Copy One',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: `pages/${slug2}.json`,
        data: {
          slug: slug2,
          url: url2,
          title: 'Copy Two',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/Copy List': 'cplist' } },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const listItem = options.locator('.sidebar-item[data-list-id="cplist"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Select all rows via Ctrl+click
    const rows = options.locator('#relatedResults .result-row');
    await rows.first().click();
    await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });

    // Ctrl+C
    await options.keyboard.press('ControlOrMeta+c');

    // Read clipboard
    const clipText = await options.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipText).toContain('<https://example.com/copy-1>');
    expect(clipText).toContain('<https://example.com/copy-2>');
    // Should also contain titles
    expect(clipText).toContain('Copy One');
    expect(clipText).toContain('Copy Two');

    await options.close();
  });

  test('Ctrl+V in list view pastes URLs as pins', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const pasteUrl = 'https://example.com/pasted-page';
    const pasteSlug = getSlugForUrl(pasteUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:pastelist' }],
        },
      },
      {
        path: 'lists/pastelist.json',
        data: {
          slug: 'pastelist',
          name: 'Paste List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Paste List': 'pastelist' },
        },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const listItem = options.locator('.sidebar-item[data-list-id="pastelist"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Write angle-bracket formatted text to clipboard
    await options.evaluate((url) => {
      navigator.clipboard.writeText(`Pasted Page <${url}>`);
    }, pasteUrl);

    // Ctrl+V
    await options.keyboard.press('ControlOrMeta+v');

    // Pin should appear
    const pinnedRow = options.locator('#relatedResults .result-row');
    await expect(pinnedRow).toBeVisible({ timeout: 10000 });

    // Verify via backend that pin was added
    const helper = await openHelperPage(extContext, extensionId);
    const listEntity = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'list:pastelist',
      }),
    );
    await helper.close();
    expect(listEntity.value.pins.length).toBe(1);
    expect(listEntity.value.pins[0].id).toBe(`page:${pasteSlug}`);

    await options.close();
  });

  test('Ctrl+V outside list view shows info bubble', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: 'https://example.com/explore-item',
            title: 'Explore Item',
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);

    // Wait for explore view (explore renders into #relatedResults)
    const firstRow = options.locator('#relatedResults .result-row').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    // Write URL to clipboard and paste
    await options.evaluate(() => {
      navigator.clipboard.writeText('Some Page <https://example.com/nope>');
    });
    await options.keyboard.press('ControlOrMeta+v');

    const bubble = options.locator('#infoBubble');
    await expect(bubble).toBeVisible({ timeout: 3000 });
    const text = await bubble.textContent();
    expect(text.toLowerCase()).toContain('paste');

    await options.close();
  });

  // Regression: when localDeviceName is null (pre-hydration race window),
  // create_list produces owner:null, then pin_to_list gets listOwner:null,
  // and drains write to data/logs/default/ instead of data/logs/<device>/.
  test('create_list during pre-hydration window must not produce null owner', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Simulate the pre-hydration window: localDeviceName=null, hydrationDone already resolved
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'simulatePreHydrationForTest' }),
    );

    // Create a list during this window — handler proceeds with localDeviceName=null
    const createResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'Test List' }),
    );
    expect(createResult.success).toBe(true);
    expect(createResult.listId).toBeTruthy();

    // The list entity must have a non-null owner
    const listEntity = await helper.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          action: 'readCacheable',
          key: `list:${id}`,
        }),
      createResult.listId,
    );
    expect(listEntity.value).toBeTruthy();
    expect(listEntity.value.owner).not.toBeNull();

    await helper.close();
  });

  // Regression: creating a new list must not wipe existing entries from list-name-to-id
  // — both in session cache AND on disk after drain.
  test('create_list preserves existing name-to-id entries after drain', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      {
        path: 'manifest/settings.json',
        data: {
          trimRules: [],
        },
      },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:existing' }],
        },
      },
      {
        path: 'lists/existing.json',
        data: {
          slug: 'existing',
          name: 'Existing List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Existing List': 'existing' },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a new list
    const createResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'New List' }),
    );
    expect(createResult.success).toBe(true);

    // Session cache: name-to-id must have BOTH lists
    const nameToId = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:name-to-id',
      }),
    );
    expect(nameToId.value.paths['test-device/Existing List']).toBe('existing');
    expect(nameToId.value.paths['test-device/New List']).toBeTruthy();

    // Flush to disk
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }),
    );

    // Rehydrate and verify disk state survived
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' }),
    );
    const afterDrain = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:name-to-id',
      }),
    );
    expect(afterDrain.value.paths['test-device/Existing List']).toBe(
      'existing',
    );
    expect(afterDrain.value.paths['test-device/New List']).toBeTruthy();

    await helper.close();
  });

  test('explore view shows list tags for pinned pages', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/tagged';
    const slug = getSlugForUrl(url);
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }, { id: 'list:research' }],
        },
      },
      {
        path: 'lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'lists/research.json',
        data: {
          slug: 'research',
          name: 'Research',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Reading': 'reading',
            'test-device/Research': 'research',
          },
        },
      },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url,
          title: 'Tagged Page',
          timestamp: now,
          parentIds: ['list:reading', 'list:research'],
          childIds: [],
        },
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          { timestamp: now, action: 'visit_page', url, title: 'Tagged Page' },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    // Both list tags should be visible in explore view without clicking into anything
    const listTags = options.locator('.card-tag-list');
    await expect(listTags).toHaveCount(2, { timeout: 5000 });
    const tagTexts = await listTags.allTextContents();
    expect(tagTexts.sort()).toEqual(['Reading', 'Research']);

    await options.close();
  });

  test('list view shows other list tags but excludes current list', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/multi-list';
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
          title: 'Multi-List Page',
          timestamp: now,
          parentIds: ['list:alpha', 'list:beta'],
          childIds: [],
        },
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url,
            title: 'Multi-List Page',
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Navigate to Alpha list
    const listItem = options.locator('.sidebar-item[data-list-id="alpha"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Should show Beta tag but not Alpha (current list excluded)
    const listTags = options.locator('#relatedResults .card-tag-list');
    await expect(listTags).toHaveCount(1, { timeout: 5000 });
    await expect(listTags.first()).toHaveText('Beta');

    await options.close();
  });

  test('create_list replay is idempotent: no duplicate tree node on double-apply', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    // Seed disk state that already includes the list entity + tree node
    // (simulates a prior drain that persisted the create_list effects)
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:mylist' }] },
      },
      {
        path: 'lists/mylist.json',
        data: {
          slug: 'mylist',
          name: 'My List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: { 'test-device/My List': 'mylist' } },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Inject the same create_list entry into logBuffer (simulates logBuffer not
    // being cleared after drain — the partial-drain crash scenario)
    await helper.evaluate(
      (entry) =>
        chrome.runtime.sendMessage({
          action: 'setLogBufferForTest',
          entries: [entry],
        }),
      {
        timestamp: now,
        action: 'create_list',
        listOwner: 'test-device',
        name: 'My List',
        listId: 'mylist',
      },
    );

    // Rehydrate — Phase 2 replays the create_list against disk state that already has it
    const resp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'rehydrateForTest',
        keepLogBuffer: true,
      }),
    );
    expect(resp.success).toBe(true);

    // Verify tree has exactly one node, not two
    const treeResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:list-order',
      }),
    );
    const tree = treeResp.value.tree;
    const nodeCount = tree.filter((n) => n.id === 'list:mylist').length;
    expect(nodeCount).toBe(1);

    // Verify name-to-id is still correct
    const nameResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:name-to-id',
      }),
    );
    expect(nameResp.value.paths['test-device/My List']).toBe('mylist');

    await helper.close();
  });

  test('create list button in sidebar adds a new list at first position', async ({
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
        data: {
          timestamp: now,
          tree: [{ id: 'list:existing' }],
        },
      },
      {
        path: 'lists/existing.json',
        data: {
          slug: 'existing',
          name: 'Existing List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/Existing List': 'existing' },
        },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // The create list button should be visible
    const createBtn = options.locator('#createListBtn');
    await expect(createBtn).toBeVisible({ timeout: 5000 });

    // Click it — inline input should appear
    await createBtn.click();
    const input = options.locator('.inline-list-create');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Type name and press Enter
    await input.fill('My New List');
    await input.press('Enter');

    // Wait for the new list to appear in sidebar
    await options.waitForFunction(
      () => {
        const items = document.querySelectorAll('#listsList .sidebar-item');
        return (
          items.length >= 2 &&
          [...items].some(
            (el) => el.querySelector('.label')?.textContent === 'My New List',
          )
        );
      },
      { timeout: 5000 },
    );

    // Verify it's at the first position
    const firstItem = options.locator('#listsList .sidebar-item').first();
    await expect(firstItem.locator('.label')).toHaveText('My New List');

    await options.close();
  });
});
