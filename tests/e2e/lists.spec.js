import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('List operations', () => {
  test('seeded list appears in sidebar', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: Date.now(), childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: Date.now(), pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
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
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
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

  test('pinned page visited on multiple days shows exactly one pin row', async ({ extContext, extensionId, setupDir }) => {
    const day1 = new Date('2026-02-10').getTime();
    const day2 = new Date('2026-03-01').getTime();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: day2, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: day2,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: day1 }],
        savedSearches: [{ field: 'url', id: 1, predicateType: 'keyword', type: 'predicate', value: 'example' }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: day2,
        parentIds: [], childIds: [], visitDates: [20260210, 20260301],
      }},
      { path: 'history/2026-02-10.jsonl', lines: [
        { timestamp: day1, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: day2, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Wait for pinned row to appear, then verify exactly one
    const pinnedRows = options.locator('#pinnedResults .result-row');
    await expect(pinnedRows.first()).toBeVisible({ timeout: 5000 });
    await expect(pinnedRows).toHaveCount(1);
    await options.close();
  });

  test('pin a page via toggleListPin, appears in already-open list view via mutation notification', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
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
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
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
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: Date.now(), childLists: [],
      }},
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

  // savedSearches: list with saved search keywords shows filtered explore results
  test('list with savedSearches shows filtered explore results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const matchUrl = 'https://example.com/match-page';
    const noMatchUrl = 'https://other.com/no-match';

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:filtered'],
      }},
      { path: 'lists/filtered.json', data: {
        slug: 'filtered', name: 'Filtered', timestamp: now,
        pins: [], savedSearches: ['Match Page'],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now - 1000, action: 'page', url: noMatchUrl, title: 'No Match' },
        { timestamp: now, action: 'page', url: matchUrl, title: 'Match Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="filtered"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // The explore section should show only the matching result
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 1,
      { timeout: 10000 }
    );
    const titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Match Page');
    expect(titles).not.toContain('No Match');

    await options.close();
  });

  // Bug 177dedb: pin ID TOCTOU — UI computes shallow:<url> but page gets
  // checkpointed before background processes the toggle.
  // Limitation: this test runs the transition and toggle sequentially. The real
  // race (concurrent checkpoint during toggle) can't be reliably reproduced in
  // E2E. The fix (background re-resolves the ID from URL) is exercised here
  // because toggleListPin receives a URL and checks both ID forms internally.
  test('unpin works after page transitions from shallow to checkpointed', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/toctou-page';
    const slug = getSlugForUrl(url);

    // Seed with a SHALLOW pin (no page checkpoint file)
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:research'],
      }},
      { path: 'lists/research.json', data: {
        slug: 'research', name: 'Research', timestamp: now,
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/system/shallow-page.json', data: {
        timestamp: now,
        index: { [url]: { title: 'TOCTOU Page', parentIds: [], lists: ['list:research'] } },
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url, title: 'TOCTOU Page' },
      ]},
    ]);

    // Now checkpoint the page — transitions shallow→checkpointed, pin ID should upgrade
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'ensurePageCheckpoint', url: u, title: 'TOCTOU Page' })
    , url);

    // Toggle pin OFF — should work despite the shallow→page: ID transition
    const unpinResult = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'research', url: u })
    , url);
    await helper.close();

    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);

    // Verify pin is actually gone by opening the list
    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="research"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    const pinnedRows = await options.$$('#pinnedResults .result-row');
    expect(pinnedRows.length).toBe(0);
    await options.close();
  });

  // Bug: readCacheable list entity — undrained pin visible immediately (4c77b2c)
  test('newly pinned page visible via readCacheable without flush', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/immediate-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Immediate Pin', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin the page
    const pinResult = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // Immediately query pins WITHOUT flushing — should see the pin via session cache
    const pinsResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    await helper.close();

    expect(pinsResult.success).toBe(true);
    const pins = pinsResult.value?.pins || [];
    expect(pins.length).toBe(1);
    expect(pins[0].id).toBe(`page:${slug}`);
  });

  // Bug: createListAndPin in popup sent saveListMeta (whose effectOf already
  // adds to root's childLists) AND then manually appended — double entry.
  // Fix: popup now relies solely on saveListMeta's effectOf for root childLists.
  // This test verifies saveListMeta alone produces exactly one entry in root's childLists.
  test('saveListMeta adds to root childLists exactly once', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: Date.now(), childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // saveListMeta — effectOf should add to root's childLists
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'my-list', name: 'My List' })
    );

    const root = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' });
      return resp.value;
    });
    await helper.close();

    const matches = root.childLists.filter(id => id === 'list:my-list');
    expect(matches.length).toBe(1);
  });

  // Bug: pinning a shallow page to a list creates SPI entry with title=null
  // even when the page was previously visited with a title in history.
  // Fix: effectOf enriches new SPI entries from recent history.
  // The three tests below cover the three UI use cases that trigger this path.
  test('toggleListPin on shallow page populates SPI title from history', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/spi-title-test';
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url, title: 'SPI Title Test Page' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const pinResult = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url);
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    const spiResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/shallow-page' })
    );
    await helper.close();

    const entry = spiResult.value.index[url];
    expect(entry).toBeDefined();
    expect(entry.lists).toContain('list:reading');
    expect(entry.title).toBe('SPI Title Test Page');
  });

  test('addListPins on shallow pages populates SPI titles from history', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url1 = 'https://example.com/bulk-pin-1';
    const url2 = 'https://example.com/bulk-pin-2';
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now - 1000, action: 'page', url: url1, title: 'Bulk Page One' },
        { timestamp: now, action: 'page', url: url2, title: 'Bulk Page Two' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate((urls) =>
      chrome.runtime.sendMessage({ action: 'addListPins', listId: 'reading', urls })
    , [url1, url2]);
    expect(result.success).toBe(true);

    const spiResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/shallow-page' })
    );
    await helper.close();

    expect(spiResult.value.index[url1]?.title).toBe('Bulk Page One');
    expect(spiResult.value.index[url2]?.title).toBe('Bulk Page Two');
  });

  test('copyListPins with shallow pins enriches SPI title from history', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/copy-pin-page';
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:source', 'list:target'],
      }},
      { path: 'lists/source.json', data: {
        slug: 'source', name: 'Source', timestamp: now,
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/target.json', data: {
        slug: 'target', name: 'Target', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url, title: 'Copy Pin Page' },
      ]},
      // SPI entry with title=null — simulates the bug where pin was created without title
      { path: 'lists/system/shallow-page.json', data: {
        timestamp: now,
        index: { [url]: { parentIds: [], lists: ['list:source'], title: null, user_title: null } },
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'copyListPins', fromListId: 'source', toListId: 'target' })
    );
    expect(result.success).toBe(true);

    const spiResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/shallow-page' })
    );
    await helper.close();

    const entry = spiResult.value.index[url];
    expect(entry).toBeDefined();
    expect(entry.lists).toContain('list:target');
    // effectOf should have enriched the null title from history
    expect(entry.title).toBe('Copy Pin Page');
  });

  // Workspace auto-pin (background.js:1140-1156) also creates shallow SPI entries,
  // but requires content script navigation + workspace.listIds configuration.
  // The effectOf fix covers it via the same code path as the tests above.

  // Bug 20260228: list_meta rename should update list entity name via effectOf
  test('saveListMeta rename updates list entity name', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'reading', name: 'Research' })
    );

    const listEntity = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' });
      return resp.value;
    });
    await helper.close();

    expect(listEntity).toBeDefined();
    expect(listEntity.name).toBe('Research');
  });

  // Bug 20260220: del_list should remove entry from root's childLists via effectOf
  test('deleteList removes entry from root childLists', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:keep', 'list:remove'],
      }},
      { path: 'lists/keep.json', data: {
        slug: 'keep', name: 'Keep', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/remove.json', data: {
        slug: 'remove', name: 'Remove', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'remove' })
    );

    const root = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' });
      return resp.value;
    });
    await helper.close();

    expect(root.childLists.length).toBe(1);
    expect(root.childLists[0]).toBe('list:keep');
    expect(root.childLists).not.toContain('list:remove');
  });

  test('deleteList adds list key to orphaned list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:doomed'],
      }},
      { path: 'lists/doomed.json', data: {
        slug: 'doomed', name: 'Doomed', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' })
    );

    // List key should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphaned.value).toBeTruthy();
    expect(orphaned.value.keys).toContain('list:doomed');

    await helper.close();
  });

  // Bug 20260226: unpin should emit a single 'del' op, not 'clear' then 'add'.
  // Verify by checking that after unpin, the other pins remain intact.
  test('unpin one page leaves other pins intact', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url1 = 'https://example.com/pin-1';
    const url2 = 'https://example.com/pin-2';
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [
          { id: `page:${slug1}`, pinnedAt: now },
          { id: `page:${slug2}`, pinnedAt: now },
        ], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${slug1}.json`, data: {
        slug: slug1, url: url1, title: 'Pin One', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${slug2}.json`, data: {
        slug: slug2, url: url2, title: 'Pin Two', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin only pin-1
    const result = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url: u })
    , url1);
    expect(result.success).toBe(true);
    expect(result.pinned).toBe(false);

    // pin-2 should still be there
    const pinsResult = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    await helper.close();

    const pins = pinsResult.value?.pins || [];
    expect(pins.length).toBe(1);
    expect(pins[0].id).toBe(`page:${slug2}`);
  });

  test('pin adds list to page parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin a page to the list
    await helper.evaluate(({ url }) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url })
    , { url: TEST_URL });

    // Page should have list:reading in parentIds
    const pageEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    await helper.close();

    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.parentIds).toContain('list:reading');
  });

  test('unpin removes list from page parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: ['list:reading'], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin the page (toggle)
    await helper.evaluate(({ url }) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', url })
    , { url: TEST_URL });

    // Page should no longer have list:reading in parentIds
    const pageEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    await helper.close();

    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.parentIds).not.toContain('list:reading');
  });

  test('deleteList removes list from all pinned page parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url2 = 'https://example.com/page-2';
    const slug2 = getSlugForUrl(url2);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:doomed'],
      }},
      { path: 'lists/doomed.json', data: {
        slug: 'doomed', name: 'Doomed', timestamp: now,
        pins: [
          { id: `page:${TEST_SLUG}`, pinnedAt: now },
          { id: `page:${slug2}`, pinnedAt: now },
        ], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: ['list:doomed', 'page:other-ref'], childIds: [],
      }},
      { path: `pages/${slug2}.json`, data: {
        slug: slug2, url: url2, title: 'Page 2', timestamp: now,
        parentIds: ['list:doomed'], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' })
    );

    // Both pages should have list:doomed removed from parentIds
    const page1 = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    const page2 = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${slug2}`);
    await helper.close();

    expect(page1.value.parentIds).not.toContain('list:doomed');
    expect(page1.value.parentIds).toContain('page:other-ref'); // other refs preserved
    expect(page2.value.parentIds).not.toContain('list:doomed');
    expect(page2.value.parentIds).toEqual([]);
  });

  test('list restores savedSearches from entity', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }],
        savedSearches: ['example', 'domain'],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'lists/system/shallow-page.json', data: { timestamp: now, index: {} }},
      { path: `history/2026-03-06.jsonl`, data: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Saved search rows should be rendered
    await expect(options.locator('.search-row')).toHaveCount(2, { timeout: 5000 });
    const searchInputs = options.locator('.search-row input');
    await expect(searchInputs.nth(0)).toHaveValue('example');
    await expect(searchInputs.nth(1)).toHaveValue('domain');

    await options.close();
  });

  test('filter panel toggles visibility', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/system/shallow-page.json', data: { timestamp: now, index: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

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

  test('empty search shows all history', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now - 2000, action: 'page', url: 'https://a.com/', title: 'Page A' },
        { timestamp: now - 1000, action: 'page', url: 'https://b.com/', title: 'Page B' },
        { timestamp: now, action: 'page', url: 'https://c.com/', title: 'Page C' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // No savedSearches → all history should be shown
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );
    const titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Page A');
    expect(titles).toContain('Page B');
    expect(titles).toContain('Page C');

    await options.close();
  });

  test('adding search via UI persists across reload', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/system/shallow-page.json', data: { timestamp: now, index: {} } },
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: 'https://example.com/', title: 'Example' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Type a search and press Enter to save
    const draftInput = options.locator('#searchDraftInput');
    await expect(draftInput).toBeVisible({ timeout: 5000 });
    await draftInput.fill('example');
    await draftInput.press('Enter');

    // Saved search row should appear
    await expect(options.locator('.search-row')).toHaveCount(1, { timeout: 5000 });
    await expect(options.locator('.search-row input').first()).toHaveValue('example');

    // Reload — navigate away and back
    const exploreBtn = options.locator('#exploreBtn');
    await exploreBtn.click();
    await options.waitForFunction(
      () => document.getElementById('mainTitle')?.textContent?.trim() === 'Explore',
      { timeout: 5000 }
    );
    await listItem.click();
    await waitForListView(options);

    // Saved search should persist
    await expect(options.locator('.search-row')).toHaveCount(1, { timeout: 5000 });
    await expect(options.locator('.search-row input').first()).toHaveValue('example');

    await options.close();
  });

  test('last-seen range filter narrows results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const DAY = 86400000;
    const recentUrl = 'https://recent.com/';
    const oldUrl = 'https://old.com/';

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'history/2026-03-08.jsonl', lines: [
        { timestamp: now, action: 'page', url: recentUrl, title: 'Recent Page' },
      ]},
      { path: 'history/2026-02-06.jsonl', lines: [
        { timestamp: now - 30 * DAY, action: 'page', url: oldUrl, title: 'Old Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Both pages should appear initially
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
    );
    let titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Recent Page');
    expect(titles).toContain('Old Page');

    // Open filter panel
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();

    // Verify slider thumbs are visible and interactive inside the track
    const hiSlider = options.locator('.filter-range[data-key="lastSeen"] .filter-range-hi');
    await expect(hiSlider).toBeVisible();
    const loSlider = options.locator('.filter-range[data-key="lastSeen"] .filter-range-lo');
    await expect(loSlider).toBeVisible();

    // Use Playwright's fill() on the range input — fires native input event
    await hiSlider.fill('7');

    // Wait for debounced pipeline — "Old Page" (30d ago) should be excluded
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const t = [...rows].map(r => r.querySelector('.result-title')?.textContent?.trim());
        return t.length > 0 && !t.includes('Old Page');
      },
      { timeout: 10000 }
    );

    titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Recent Page');
    expect(titles).not.toContain('Old Page');

    // Verify the hi label updated
    const hiLabel = options.locator('.filter-range[data-key="lastSeen"] .qb-dual-range-hi-label');
    await expect(hiLabel).toHaveText('7d ago');

    await options.close();
  });

  test('has-highlights checkbox filter narrows results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const highlightUrl = 'https://highlighted.com/';
    const plainUrl = 'https://plain.com/';
    const highlightSlug = getSlugForUrl(highlightUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${highlightSlug}.json`, data: {
        slug: highlightSlug, url: highlightUrl, title: 'Highlighted Page', timestamp: now,
        parentIds: [], childIds: [],
        notes: [{ excerpt: 'some highlight text', note: '', createdAt: now }],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now - 1000, action: 'page', url: plainUrl, title: 'Plain Page' },
        { timestamp: now, action: 'page', url: highlightUrl, title: 'Highlighted Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Both pages should appear initially
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
    );
    let titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).toContain('Plain Page');

    // Open filter panel
    const filterBtn = options.locator('#filterToggleBtn');
    await filterBtn.click();
    await expect(options.locator('#filterPanel')).toBeVisible();

    // Check the "Has highlights" checkbox via Playwright click (real user interaction)
    const checkbox = options.locator('.filter-checkbox input[data-key="hasHighlights"]');
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Wait for debounced pipeline — "Plain Page" has no highlights, should be excluded
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        const t = [...rows].map(r => r.querySelector('.result-title')?.textContent?.trim());
        return t.length > 0 && !t.includes('Plain Page');
      },
      { timeout: 10000 }
    );

    titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).not.toContain('Plain Page');

    // Uncheck — both should reappear
    await checkbox.uncheck();
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
    );
    titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Highlighted Page');
    expect(titles).toContain('Plain Page');

    await options.close();
  });

  test('list bubble filter restricts results to enabled lists', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const rustUrl = 'https://rust-lang.org/';
    const goUrl = 'https://go.dev/';
    const rustSlug = getSlugForUrl(rustUrl);
    const goSlug = getSlugForUrl(goUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:rust', 'list:golang'] } },
      { path: 'lists/rust.json', data: {
        slug: 'rust', name: 'Rust', timestamp: now,
        pins: [{ id: `page:${rustSlug}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/golang.json', data: {
        slug: 'golang', name: 'Go', timestamp: now,
        pins: [{ id: `page:${goSlug}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${rustSlug}.json`, data: {
        slug: rustSlug, url: rustUrl, title: 'Rust Lang', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${goSlug}.json`, data: {
        slug: goSlug, url: goUrl, title: 'Go Dev', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'lists/system/shallow-page.json', data: { timestamp: now, index: {} } },
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now - 1000, action: 'page', url: rustUrl, title: 'Rust Lang' },
        { timestamp: now, action: 'page', url: goUrl, title: 'Go Dev' },
      ]},
    ]);

    // Open Explore view — both results shown (no bubbles active)
    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
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
        const t = [...rows].map(r => r.querySelector('.result-title')?.textContent?.trim());
        return t.length > 0 && !t.includes('Rust Lang');
      },
      { timeout: 10000 }
    );
    let titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Go Dev');
    expect(titles).not.toContain('Rust Lang');

    // Deactivate "Go" bubble → all results again
    await goBubble.click();
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
    );
    titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Rust Lang');
    expect(titles).toContain('Go Dev');

    await options.close();
  });

  // --- Hierarchical list tests ---

  test('nested list renders with indentation in sidebar', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:parent'],
      }},
      { path: 'lists/parent.json', data: {
        slug: 'parent', name: 'Parent List', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child List', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:parent', childLists: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const parentItem = options.locator('.sidebar-item[data-list-id="parent"]');
    const childItem = options.locator('.sidebar-item[data-list-id="child"]');
    await expect(parentItem).toBeVisible({ timeout: 5000 });
    await expect(childItem).toBeVisible({ timeout: 5000 });

    // Child should have more padding (indentation)
    const parentPadding = await parentItem.evaluate(el => parseInt(el.style.paddingLeft));
    const childPadding = await childItem.evaluate(el => parseInt(el.style.paddingLeft));
    expect(childPadding).toBeGreaterThan(parentPadding);
    await options.close();
  });

  test('fold toggle hides/shows nested children', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:parent'],
      }},
      { path: 'lists/parent.json', data: {
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:parent', childLists: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const childItem = options.locator('.sidebar-item[data-list-id="child"]');
    await expect(childItem).toBeVisible({ timeout: 5000 });

    // Click fold toggle on parent to collapse
    const foldBtn = options.locator('.sidebar-item[data-list-id="parent"] .fold-toggle');
    await foldBtn.click();
    await expect(childItem).toBeHidden();

    // Click again to expand
    await foldBtn.click();
    await expect(childItem).toBeVisible();
    await options.close();
  });

  test('reparentList moves list between parents', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:a', 'list:b'],
      }},
      { path: 'lists/a.json', data: {
        slug: 'a', name: 'List A', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/b.json', data: {
        slug: 'b', name: 'List B', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:a', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Reparent child from list:a to list:b at index 0
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'reparentList', listId: 'child', fromParent: 'a', toParent: 'b', index: 0 })
    );
    expect(result.success).toBe(true);

    // Verify: list:a should not have child in childLists, list:b should
    const entityA = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:a' })
    );
    const entityB = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:b' })
    );
    const childEntity = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:child' })
    );
    await helper.close();

    expect(entityA.value.childLists).not.toContain('list:child');
    expect(entityB.value.childLists).toContain('list:child');
    expect(childEntity.value.parentList).toBe('list:b');
  });

  test('deleteList with children soft-deletes entire subtree', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:parent'],
      }},
      { path: 'lists/parent.json', data: {
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:parent', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'parent' })
    );

    // Both parent and child should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphaned.value.keys).toContain('list:parent');
    expect(orphaned.value.keys).toContain('list:child');

    // Root should not contain parent
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    await helper.close();
    expect(root.value.childLists).not.toContain('list:parent');
  });

  test('restoreList with children restores entire subtree', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:parent'],
      }},
      { path: 'lists/parent.json', data: {
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:parent', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete first
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'parent' })
    );

    // Restore
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'restoreList', listId: 'parent' })
    );

    // Both should be unorphaned
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphaned.value.keys).not.toContain('list:parent');
    expect(orphaned.value.keys).not.toContain('list:child');

    // Root should contain parent again
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    await helper.close();
    expect(root.value.childLists).toContain('list:parent');
  });

  // --- Note-to-list pinning ---

  const NOTE_SLUG = 'test-note-abc';

  test('pin note via toggleListPin adds note to list and list to note parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `notes/${NOTE_SLUG}.json`, data: {
        slug: NOTE_SLUG, excerpt: 'Test note', note: 'Content', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${NOTE_SLUG}`],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Pin note to the list
    const pinResult = await helper.evaluate((noteId) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', id: noteId })
    , `note:${NOTE_SLUG}`);
    expect(pinResult.success).toBe(true);
    expect(pinResult.pinned).toBe(true);

    // List should have the note pin
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(list.value.pins.some(p => p.id === `note:${NOTE_SLUG}`)).toBe(true);

    // Note should have list:reading in parentIds
    const note = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `note:${NOTE_SLUG}`);
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.parentIds).toContain('list:reading');
  });

  test('unpin note via toggleListPin removes note from list and list from note parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [{ id: `note:${NOTE_SLUG}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `notes/${NOTE_SLUG}.json`, data: {
        slug: NOTE_SLUG, excerpt: 'Test note', note: 'Content', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`, 'list:reading'], childIds: [], timestamp: now,
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${NOTE_SLUG}`],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Unpin note from list (toggle)
    const unpinResult = await helper.evaluate((noteId) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'reading', id: noteId })
    , `note:${NOTE_SLUG}`);
    expect(unpinResult.success).toBe(true);
    expect(unpinResult.pinned).toBe(false);

    // List should no longer have the note pin
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(list.value.pins.some(p => p.id === `note:${NOTE_SLUG}`)).toBe(false);

    // Note should not have list:reading in parentIds
    const note = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `note:${NOTE_SLUG}`);
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.parentIds).not.toContain('list:reading');
  });

  test('deleteNote removes note pin from list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [{ id: `note:${NOTE_SLUG}`, pinnedAt: now }, { id: `page:${TEST_SLUG}`, pinnedAt: now }],
        savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `notes/${NOTE_SLUG}.json`, data: {
        slug: NOTE_SLUG, excerpt: 'Doomed note', note: 'Content', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`, 'list:reading'], childIds: [], timestamp: now,
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: ['list:reading'], childIds: [`note:${NOTE_SLUG}`],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the note
    await helper.evaluate((noteSlug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug })
    , NOTE_SLUG);

    // List should no longer have the note pin (page pin preserved)
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(list.value.pins.some(p => p.id === `note:${NOTE_SLUG}`)).toBe(false);
    expect(list.value.pins.some(p => p.id === `page:${TEST_SLUG}`)).toBe(true);

    // Note should be marked deleted
    const note = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted: true })
    , `note:${NOTE_SLUG}`);
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.deleted).toBe(true);
  });

  test('restoreNote re-adds note pin to list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:reading'],
      }},
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [`note:${NOTE_SLUG}`],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `notes/${NOTE_SLUG}.json`, data: {
        slug: NOTE_SLUG, excerpt: 'Restore me', note: 'Content', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`, 'list:reading'], childIds: [], timestamp: now,
        deleted: true,
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: ['list:reading'], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the note
    await helper.evaluate((noteSlug) =>
      chrome.runtime.sendMessage({ action: 'restoreNote', noteSlug })
    , NOTE_SLUG);

    // List should have note pin re-added
    const list = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(list.value.pins.some(p => p.id === `note:${NOTE_SLUG}`)).toBe(true);
    // Original page pin preserved
    expect(list.value.pins.some(p => p.id === `page:${TEST_SLUG}`)).toBe(true);

    // Note should no longer be deleted
    const note = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `note:${NOTE_SLUG}`);

    // Note should be un-orphaned
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    await helper.close();

    expect(note.value).toBeTruthy();
    expect(note.value.deleted).toBe(false);
    expect(orphaned.value.keys).not.toContain(`note:${NOTE_SLUG}`);
  });

  // Bug: root.json not persisted to disk after saveListMeta adds a new list.
  // The drain in offscreen.js was missing a case for list:system/root.
  test('new list creation persists root.json through drain + rehydrate', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: Date.now(), childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a new list via saveListMeta
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'persisted', name: 'Persisted' })
    );

    // Flush (drain dirty entities to disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Rehydrate (clears session cache, re-reads from disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    // root.json should have survived the round-trip
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    await helper.close();

    expect(root.value).toBeTruthy();
    expect(root.value.childLists).toContain('list:persisted');
  });

  // Bug: reparenting a child list to root updates root.json childLists, but
  // the drain was missing the list:system/root case so it never persisted.
  test('reparentList to root persists root.json through drain + rehydrate', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:parent'],
      }},
      { path: 'lists/parent.json', data: {
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:parent', childLists: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Reparent child from parent → root
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'reparentList', listId: 'child', fromParent: 'parent', toParent: 'system/root', index: 0 })
    );

    // Flush + rehydrate
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    const parent = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:parent' })
    );
    await helper.close();

    expect(root.value.childLists).toContain('list:child');
    expect(parent.value.childLists).not.toContain('list:child');
  });

  // Bug: explore list entity (list:system/explore) must not appear in sidebar tree.
  // The explore entity is a system entity — it should never leak into root's childLists.
  test('explore pins do not leak into root childLists or sidebar', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/system/explore.json', data: {
        slug: 'system/explore', name: '', timestamp: now, pins: [
          { id: `page:${TEST_SLUG}`, pinnedAt: now },
        ], savedSearches: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Verify root's childLists does NOT contain explore
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    expect(root.value.childLists).not.toContain('list:explore');
    expect(root.value.childLists).not.toContain('list:system/explore');

    // Verify explore entity is loadable as a system entity
    const explore = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/explore' })
    );
    await helper.close();
    expect(explore.value).toBeTruthy();
    expect(explore.value.pins.length).toBe(1);
  });
});
