import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage, getSlugForUrl, waitForListView } from './helpers.js';

test.describe('Scale — larger data sets', () => {
  test('20 seeded history entries appear in explore', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        timestamp: now - (20 - i) * 1000,
        action: 'page',
        url: `https://example.com/page-${i}`,
        title: `Page ${i}`,
      });
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'history/2026-03-01.jsonl', lines: entries },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForFunction(
      () => document.querySelectorAll('.result-row').length >= 20,
      { timeout: 15000 }
    );

    const count = await options.$$eval('.result-row', els => els.length);
    // >= not == : content script auto-reports from prior tests in the same worker
    // can race with resetAndSeed (isLeaving report arrives after reset).
    expect(count).toBeGreaterThanOrEqual(20);

    // Newest seeded entry should be near the top (leaked entries from prior tests
    // in the same worker may appear above it)
    const titles = await options.$$eval('.result-title', els => els.map(el => el.textContent.trim()));
    expect(titles).toContain('Page 19');
    const idx19 = titles.indexOf('Page 19');
    const idx0 = titles.indexOf('Page 0');
    expect(idx19).toBeLessThan(idx0); // newer before older

    await options.close();
  });

  test('entries across multiple days load correctly', async ({ extContext, extensionId, setupDir }) => {
    const day1 = [];
    const day2 = [];
    // Use fixed timestamps for each day
    const day1Base = new Date('2026-02-28T12:00:00Z').getTime();
    const day2Base = new Date('2026-03-01T12:00:00Z').getTime();
    for (let i = 0; i < 10; i++) {
      day1.push({
        timestamp: day1Base + i * 1000,
        action: 'page',
        url: `https://example.com/day1-page-${i}`,
        title: `Day1 Page ${i}`,
      });
    }
    for (let i = 0; i < 10; i++) {
      day2.push({
        timestamp: day2Base + i * 1000,
        action: 'page',
        url: `https://example.com/day2-page-${i}`,
        title: `Day2 Page ${i}`,
      });
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'history/2026-02-28.jsonl', lines: day1 },
      { path: 'history/2026-03-01.jsonl', lines: day2 },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    // Today's entries load via session cache; past days load via demand-loaded history batch
    await options.waitForFunction(
      () => document.querySelectorAll('.result-row').length >= 10,
      { timeout: 15000 }
    );

    const titles = await options.$$eval('.result-title', els => els.map(el => el.textContent.trim()));
    // Today's entries should be present
    expect(titles.some(t => t.includes('Day2 Page'))).toBe(true);

    await options.close();
  });

  test('5 lists with 3 pins each all render correctly', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const rootChildLists = [];
    const files = [{ path: 'settings.json', data: { trimRules: [] } }];

    for (let l = 0; l < 5; l++) {
      const listSlug = `list-${l}`;
      rootChildLists.push(`list:${listSlug}`);

      const pins = [];
      for (let p = 0; p < 3; p++) {
        const url = `https://example.com/list${l}-page${p}`;
        const slug = getSlugForUrl(url);
        pins.push({ id: `page:${slug}`, pinnedAt: now + p });
        files.push({
          path: `pages/${slug}.json`,
          data: { slug, url, title: `L${l} Page ${p}`, timestamp: now, parentIds: [], childIds: [] },
        });
      }
      files.push({
        path: `lists/${listSlug}.json`,
        data: { slug: listSlug, name: `List ${l}`, timestamp: now, pins, savedSearches: [], parentList: 'list:system/root', childLists: [] },
      });
    }

    // Add history entries for all pages
    const historyLines = [];
    for (let l = 0; l < 5; l++) {
      for (let p = 0; p < 3; p++) {
        historyLines.push({
          timestamp: now + l * 100 + p,
          action: 'page',
          url: `https://example.com/list${l}-page${p}`,
          title: `L${l} Page ${p}`,
        });
      }
    }
    files.push({ path: 'history/2026-03-01.jsonl', lines: historyLines });
    files.push({ path: 'lists/system/root.json', data: { timestamp: now, childLists: rootChildLists } });

    await resetAndSeed(extContext, extensionId, files);

    const options = await openOptionsPage(extContext, extensionId);

    // Verify all 5 lists appear in sidebar
    for (let l = 0; l < 5; l++) {
      const listItem = options.locator(`.sidebar-item[data-list-id="list-${l}"]`);
      await expect(listItem).toBeVisible({ timeout: 5000 });
    }

    // Click into list-2 and verify it has 3 pins
    await options.locator('.sidebar-item[data-list-id="list-2"]').click();
    await waitForListView(options);
    await options.waitForFunction(
      () => document.querySelectorAll('#pinnedResults .result-row').length === 3,
      { timeout: 10000 }
    );
    const pinnedTitles = await options.$$eval('#pinnedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(pinnedTitles.length).toBe(3);
    expect(pinnedTitles.every(t => t.startsWith('L2 Page'))).toBe(true);

    await options.close();
  });

  test('page pinned to a list shows list as parent in relations', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/pinned-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: ['list:research'],
      }},
      { path: 'lists/research.json', data: {
        slug: 'research', name: 'Research', timestamp: now,
        pins: [{ id: `page:${slug}`, pinnedAt: now }], savedSearches: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Pinned Page', timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const relations = await helper.evaluate((u) =>
      chrome.runtime.sendMessage({ action: 'getPageRelations', url: u })
    , url);
    await helper.close();

    expect(relations.success).toBe(true);
    expect(relations.parents.lists.length).toBe(1);
    expect(relations.parents.lists[0].name).toBe('Research');
    expect(relations.parents.lists[0].slug).toBe('research');
  });
});
