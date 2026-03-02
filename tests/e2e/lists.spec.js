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
        listOrder: [{ id: 'list:filtered', name: 'Filtered' }],
      }},
      { path: 'lists/filtered.json', data: {
        slug: 'filtered', name: 'Filtered', timestamp: now,
        pins: [], qbTrees: [qbTree],
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
        listOrder: [{ id: 'list:research', name: 'Research' }],
      }},
      { path: 'lists/research.json', data: {
        slug: 'research', name: 'Research', timestamp: now,
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], qbTrees: [],
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

  // Bug: loadListPinsById via readCacheable — undrained pin visible immediately (4c77b2c)
  test('newly pinned page visible via loadListPinsById without flush', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/immediate-pin';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'reading' })
    );
    await helper.close();

    expect(pinsResult.success).toBe(true);
    expect(pinsResult.pins.length).toBe(1);
    expect(pinsResult.pins[0].id).toBe(`page:${slug}`);
  });

  // Bug: createListAndPin in popup sent saveListMeta (whose effectOf already
  // appends to listOrder) AND then manually appended via saveSettingsKey — double entry.
  // Fix: popup now relies solely on saveListMeta's effectOf for listOrder.
  // This test verifies saveListMeta alone produces exactly one listOrder entry.
  test('saveListMeta appends exactly one listOrder entry', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // saveListMeta — effectOf should append to listOrder
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'my-list', name: 'My List' })
    );

    const order = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' });
      return resp.value.listOrder || [];
    });
    await helper.close();

    const matches = order.filter(e => e.id === 'list:my-list');
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('My List');
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
        listOrder: [{ id: 'list:reading', name: 'Reading' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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

    const spi = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getShallowPageIndex' })
    );
    await helper.close();

    const entry = spi.index[url];
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
        listOrder: [{ id: 'list:reading', name: 'Reading' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
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

    const spi = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getShallowPageIndex' })
    );
    await helper.close();

    expect(spi.index[url1]?.title).toBe('Bulk Page One');
    expect(spi.index[url2]?.title).toBe('Bulk Page Two');
  });

  test('copyListPins with shallow pins enriches SPI title from history', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/copy-pin-page';
    const today = new Date(now).toISOString().slice(0, 10);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [
          { id: 'list:source', name: 'Source' },
          { id: 'list:target', name: 'Target' },
        ],
      }},
      { path: 'lists/source.json', data: {
        slug: 'source', name: 'Source', timestamp: now,
        pins: [{ id: `shallow:${url}`, pinnedAt: now }], qbTrees: [],
      }},
      { path: 'lists/target.json', data: {
        slug: 'target', name: 'Target', timestamp: now, pins: [], qbTrees: [],
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

    const spi = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getShallowPageIndex' })
    );
    await helper.close();

    const entry = spi.index[url];
    expect(entry).toBeDefined();
    expect(entry.lists).toContain('list:target');
    // effectOf should have enriched the null title from history
    expect(entry.title).toBe('Copy Pin Page');
  });

  // Workspace auto-pin (background.js:1140-1156) also creates shallow SPI entries,
  // but requires content script navigation + workspace.listIds configuration.
  // The effectOf fix covers it via the same code path as the tests above.

  // Bug 20260228: list_meta rename should update listOrder entry name via effectOf
  test('saveListMeta rename updates listOrder name', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:reading', name: 'Reading' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now, pins: [], qbTrees: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', listId: 'reading', name: 'Research' })
    );

    const order = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' });
      return resp.value.listOrder || [];
    });
    await helper.close();

    const entry = order.find(e => e.id === 'list:reading');
    expect(entry).toBeDefined();
    expect(entry.name).toBe('Research');
  });

  // Bug 20260220: del_list should remove entry from listOrder via effectOf
  test('deleteList removes entry from listOrder', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [
          { id: 'list:keep', name: 'Keep' },
          { id: 'list:remove', name: 'Remove' },
        ],
      }},
      { path: 'lists/keep.json', data: {
        slug: 'keep', name: 'Keep', timestamp: now, pins: [], qbTrees: [],
      }},
      { path: 'lists/remove.json', data: {
        slug: 'remove', name: 'Remove', timestamp: now, pins: [], qbTrees: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'remove' })
    );

    const order = await helper.evaluate(async () => {
      const resp = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' });
      return resp.value.listOrder || [];
    });
    await helper.close();

    expect(order.length).toBe(1);
    expect(order[0].id).toBe('list:keep');
    expect(order.find(e => e.id === 'list:remove')).toBeUndefined();
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
        listOrder: [{ id: 'list:reading', name: 'Reading' }],
      }},
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading', timestamp: now,
        pins: [
          { id: `page:${slug1}`, pinnedAt: now },
          { id: `page:${slug2}`, pinnedAt: now },
        ], qbTrees: [],
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
      chrome.runtime.sendMessage({ action: 'loadListPinsById', listId: 'reading' })
    );
    await helper.close();

    expect(pinsResult.pins.length).toBe(1);
    expect(pinsResult.pins[0].id).toBe(`page:${slug2}`);
  });
});
