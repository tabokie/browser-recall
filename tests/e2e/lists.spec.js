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
        slug: 'reading', name: 'Reading List', timestamp: Date.now(), pins: [], qbTrees: [],
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
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], qbTrees: [],
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
        qbTrees: [{ field: 'url', id: 1, predicateType: 'keyword', type: 'predicate', value: 'example' }],
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
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], qbTrees: [],
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
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], qbTrees: [],
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

  // Bug: list view missing qbTrees after loadLists migration (552c517)
  // showList() must load full entity via readCacheable to get qbTrees
  test('list with qbTrees shows filtered explore results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const matchUrl = 'https://example.com/match-page';
    const noMatchUrl = 'https://other.com/no-match';
    const matchSlug = getSlugForUrl(matchUrl);
    const noMatchSlug = getSlugForUrl(noMatchUrl);

    // qbTree: keyword predicate matching "match-page" in title
    const qbTree = {
      id: 1, type: 'predicate', predicateType: 'keyword',
      field: ['title'], value: 'Match Page',
    };

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
      }},
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:filtered'],
      }},
      { path: 'lists/filtered.json', data: {
        slug: 'filtered', name: 'Filtered', timestamp: now,
        pins: [], qbTrees: [qbTree],
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
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], qbTrees: [],
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
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], qbTrees: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/target.json', data: {
        slug: 'target', name: 'Target', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'keep', name: 'Keep', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/remove.json', data: {
        slug: 'remove', name: 'Remove', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'doomed', name: 'Doomed', timestamp: now, pins: [], qbTrees: [],
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
        ], qbTrees: [],
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
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }], qbTrees: [],
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
        ], qbTrees: [],
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

  test('list restores autoEnabled and qbTrees from entity', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const childUrl = 'https://child.example.com/';
    const childSlug = getSlugForUrl(childUrl);
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
        qbTrees: [{ field: 'url', id: 1, predicateType: 'keyword', type: 'predicate', value: 'example' }],
        autoEnabled: { 'Children of pins': true, 'Parents of pins': false, 'Similar to pins': false },
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`page:${childSlug}`],
      }},
      { path: `pages/${childSlug}.json`, data: {
        slug: childSlug, url: childUrl, title: 'Child Page', timestamp: now,
        parentIds: [`page:${TEST_SLUG}`], childIds: [],
      }},
      { path: 'lists/system/shallow-page.json', data: { timestamp: now, index: {} }},
      { path: `history/2026-03-06.jsonl`, data: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
        { timestamp: now + 1, action: 'page', url: childUrl, title: 'Child Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Wait for explore blocks to render
    await expect(options.locator('.explore-blocks')).toBeVisible({ timeout: 5000 });

    // Check auto-block enabled/disabled states
    const blocks = options.locator('.explore-block');
    const childrenBlock = blocks.filter({ hasText: 'Children of pins' });
    const parentsBlock = blocks.filter({ hasText: 'Parents of pins' });

    // Children of pins should be enabled (not have .disabled class)
    await expect(childrenBlock).not.toHaveClass(/disabled/);
    // Parents of pins should be disabled
    await expect(parentsBlock).toHaveClass(/disabled/);

    // Manual block (Saved query) should be present
    const manualBlock = blocks.filter({ hasText: 'Saved query' });
    await expect(manualBlock).toBeVisible();

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
        slug: 'parent', name: 'Parent List', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child List', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'a', name: 'List A', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/b.json', data: {
        slug: 'b', name: 'List B', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], qbTrees: [],
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
        slug: 'parent', name: 'Parent', timestamp: now, pins: [], qbTrees: [],
        parentList: 'list:system/root', childLists: ['list:child'],
      }},
      { path: 'lists/child.json', data: {
        slug: 'child', name: 'Child', timestamp: now, pins: [], qbTrees: [],
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
});
