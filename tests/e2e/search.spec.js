import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Exact (quoted) search uses word-boundary matching', () => {
  test('quoted search excludes substring matches', async ({
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
            timestamp: now - 3000,
            action: 'visit_page',
            url: 'https://a.com/concat',
            title: 'concatenation tips',
          },
          {
            timestamp: now - 2000,
            action: 'visit_page',
            url: 'https://b.com/cat',
            title: 'the cat sleeps',
          },
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: 'https://c.com/catalog',
            title: 'product catalog',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for all 3 results to load in Explore view
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 },
    );

    // Type quoted search — should use word-boundary matching
    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('"cat"');

    // "cat" as word boundary should only match "the cat sleeps" — not
    // "concatenation" (cat is embedded) or "catalog" (cat is prefix)
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length === 1,
      { timeout: 5000 },
    );
    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toEqual(['the cat sleeps']);

    await options.close();
  });

  test('quoted search respects word boundaries in URLs', async ({
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
            url: 'https://github.com/foo',
            title: 'Foo Repo',
          },
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: 'https://fakegithub.com/bar',
            title: 'Fake Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('"github.com"');

    // "github.com" in https://github.com/foo is word-bounded (preceded by /)
    // "github.com" in https://fakegithub.com/bar is NOT bounded (preceded by 'e')
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length === 1,
      { timeout: 5000 },
    );
    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toEqual(['Foo Repo']);

    await options.close();
  });

  test('unquoted search still uses case-insensitive substring', async ({
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
            timestamp: now - 3000,
            action: 'visit_page',
            url: 'https://a.com/',
            title: 'Concatenation Tips',
          },
          {
            timestamp: now - 2000,
            action: 'visit_page',
            url: 'https://b.com/',
            title: 'The Cat Sleeps',
          },
          {
            timestamp: now - 1000,
            action: 'visit_page',
            url: 'https://c.com/',
            title: 'Lovely Dogs',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 },
    );

    // Unquoted search — should still match substrings case-insensitively
    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('cat');

    // "cat" substring matches "Concatenation Tips" and "The Cat Sleeps"
    // but NOT "Lovely Dogs"
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length === 2,
      { timeout: 5000 },
    );
    const titles = await options.$$eval(
      '#relatedResults .result-title',
      (els) => els.map((el) => el.textContent.trim()),
    );
    expect(titles).toContain('Concatenation Tips');
    expect(titles).toContain('The Cat Sleeps');
    expect(titles).not.toContain('Lovely Dogs');

    await options.close();
  });
});

test.describe('Search filter time range uses absolute dates', () => {
  test('time filter shows absolute dates with older end on left', async ({
    extContext,
    extensionId,
  }) => {
    const now = Date.now();
    const day1 = '2026-01-15';
    const day2 = '2026-03-20';
    const ts1 = new Date(day1 + 'T12:00:00Z').getTime();
    const ts2 = new Date(day2 + 'T12:00:00Z').getTime();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-01-15.jsonl',
        lines: [
          {
            timestamp: ts1,
            action: 'visit_page',
            url: 'https://a.com/',
            title: 'Old Page',
          },
        ],
      },
      {
        path: 'data/logs/test-device/2026-03-20.jsonl',
        lines: [
          {
            timestamp: ts2,
            action: 'visit_page',
            url: 'https://b.com/',
            title: 'New Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for results to load
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Open filter panel
    await options.click('#filterToggleBtn');
    await options.waitForSelector('.filter-range[data-key="lastSeen"]', {
      timeout: 3000,
    });

    // Check the labels on the "Last seen" dual range
    const labels = await options.$$eval(
      '.filter-range[data-key="lastSeen"] .qb-dual-range-label',
      (els) => els.map((el) => el.textContent.trim()),
    );

    // Should have 2 labels (lo on left, hi on right)
    expect(labels).toHaveLength(2);
    // Both labels should be absolute dates (YYYY-MM-DD format), not "Xd ago"
    for (const label of labels) {
      expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // Left label (index 0) should be older (earlier date) than right label (index 1)
    expect(labels[0] < labels[1]).toBe(true);

    await options.close();
  });
});

test.describe('Time chart shows full range on initial visit', () => {
  test('chart range extends to today even when latest visit is older', async ({
    extContext,
    extensionId,
  }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // Last visit was 10 days ago
    const ts = now - 10 * 86400000;
    const day = new Date(ts).toISOString().slice(0, 10);
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: `data/logs/test-device/${day}.jsonl`,
        lines: [
          {
            timestamp: ts,
            action: 'visit_page',
            url: 'https://a.com/',
            title: 'Old Visit',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForSelector('#relatedChart.visible', { timeout: 10000 });

    // The chart should have a bar-group for today (even though there's no data for today)
    const hasTodaySlot = await options.evaluate((todayStr) => {
      const groups = document.querySelectorAll(
        '#relatedChartBars .chart-bar-group',
      );
      return [...groups].some((g) => g.dataset.date === todayStr);
    }, today);
    expect(hasTodaySlot).toBe(true);

    await options.close();
  });

  test('oldest bars are reachable by scrolling left', async ({
    extContext,
    extensionId,
  }) => {
    const now = Date.now();
    // Spread visits across 6 months so the chart overflows
    const seedFiles = [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ];
    const byDay = {};
    for (let i = 0; i < 26; i++) {
      const ts = now - i * 7 * 86400000;
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push({
        timestamp: ts,
        action: 'visit_page',
        url: `https://site${i}.com/`,
        title: `Page ${i}`,
      });
    }
    for (const [day, lines] of Object.entries(byDay)) {
      seedFiles.push({ path: `data/logs/test-device/${day}.jsonl`, lines });
    }
    await resetAndSeed(extContext, extensionId, seedFiles);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('#relatedChart.visible', { timeout: 10000 });
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedChartBars .chart-bar-group.has-data')
          .length >= 10,
      { timeout: 5000 },
    );

    // Scroll all the way left
    await options.evaluate(() => {
      document.getElementById('relatedChartBars').scrollLeft = 0;
    });

    // The oldest (first) data bar should now be visible
    const oldestBarVisible = await options.evaluate(() => {
      const barsEl = document.getElementById('relatedChartBars');
      const groups = barsEl.querySelectorAll('.chart-bar-group.has-data');
      if (groups.length === 0) return false;
      const first = groups[0];
      const containerRect = barsEl.getBoundingClientRect();
      const barRect = first.getBoundingClientRect();
      return (
        barRect.left >= containerRect.left - 2 &&
        barRect.right <= containerRect.right + 2
      );
    });
    expect(oldestBarVisible).toBe(true);

    await options.close();
  });
});

test.describe('Chart highlight syncs with result selection', () => {
  test('single-click on result row highlights corresponding chart bar', async ({
    extContext,
    extensionId,
  }) => {
    const now = Date.now();
    const day1 = '2026-03-01';
    const day2 = '2026-03-02';
    const ts1 = new Date(day1 + 'T12:00:00Z').getTime();
    const ts2 = new Date(day2 + 'T12:00:00Z').getTime();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: ts1,
            action: 'visit_page',
            url: 'https://a.com/',
            title: 'Alpha Page',
          },
        ],
      },
      {
        path: 'data/logs/test-device/2026-03-02.jsonl',
        lines: [
          {
            timestamp: ts2,
            action: 'visit_page',
            url: 'https://b.com/',
            title: 'Beta Page',
          },
        ],
      },
      {
        path: 'manifest/list-name-to-id.json',
        data: { timestamp: now, paths: {} },
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for results to load in Explore view
    await options.waitForFunction(
      () =>
        document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 },
    );

    // Wait for chart to be visible
    await options.waitForSelector('#relatedChart.visible', { timeout: 5000 });

    // Single-click on the first result row
    const firstRow = options.locator('#relatedResults .result-item').first();
    await firstRow.click();

    // The clicked row should be selected
    const selectedCount = await options.$$eval(
      '#relatedResults .result-row.selected',
      (els) => els.length,
    );
    expect(selectedCount).toBe(1);

    // The chart bar for the matching date should be highlighted
    const highlightedBars = await options.$$eval(
      '#relatedChartBars .chart-bar.highlighted',
      (els) => els.length,
    );
    expect(highlightedBars).toBeGreaterThanOrEqual(1);

    await options.close();
  });
});
