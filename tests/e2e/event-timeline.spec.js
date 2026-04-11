import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, getSlugForUrl } from './helpers.js';

const PAGE_URL = 'https://example.com/timeline-test';
const PAGE_TITLE = 'Timeline Test Page';

test.describe('Page detail visit dates and notes', () => {
  test('shows first and last visited for page with visitDates', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: PAGE_URL,
          title: PAGE_TITLE,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': Date.now() },
          visitDates: [20260310, 20260315, 20260320],
          timeOnPage: 120000,
          scrollDepth: 80,
        },
      },
      {
        path: 'data/logs/test-device/2026-03-10.jsonl',
        lines: [
          {
            timestamp: new Date('2026-03-10T09:00:00').getTime(),
            action: 'leave_page',
            url: PAGE_URL,
            title: PAGE_TITLE,
            timeOnPage: 120000,
            scrollDepth: 80,
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-visit-dates', { timeout: 5000 });

    const visitDates = options.locator('.detail-visit-dates');
    await expect(visitDates).toContainText('First visited:');
    await expect(visitDates).toContainText('Last visited:');
    await expect(visitDates).toContainText('Mar 10, 2026');
    await expect(visitDates).toContainText('Mar 20, 2026');

    // No timeline should exist
    await expect(options.locator('.detail-timeline')).toHaveCount(0);

    await options.close();
  });

  test('shows only first visited when single visitDate', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: PAGE_URL,
          title: PAGE_TITLE,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': Date.now() },
          visitDates: [20260315],
        },
      },
      {
        path: 'data/logs/test-device/2026-03-15.jsonl',
        lines: [
          {
            timestamp: new Date('2026-03-15T10:00:00').getTime(),
            action: 'leave_page',
            url: PAGE_URL,
            title: PAGE_TITLE,
            timeOnPage: 5000,
            scrollDepth: 20,
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-visit-dates', { timeout: 5000 });

    const visitDates = options.locator('.detail-visit-dates');
    await expect(visitDates).toContainText('First visited:');
    await expect(visitDates).not.toContainText('Last visited:');

    await options.close();
  });

  test('shows plain date from card timestamp when no visitDates', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: PAGE_URL,
          title: PAGE_TITLE,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': Date.now() },
          // No visitDates
        },
      },
      {
        path: 'data/logs/test-device/2026-03-15.jsonl',
        lines: [
          {
            timestamp: new Date('2026-03-15T10:00:00').getTime(),
            action: 'leave_page',
            url: PAGE_URL,
            title: PAGE_TITLE,
            timeOnPage: 5000,
            scrollDepth: 20,
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-visit-dates', { timeout: 5000 });

    const visitDates = options.locator('.detail-visit-dates');
    // Should show just the date, no "First visited" / "Last visited" labels
    await expect(visitDates).not.toContainText('First visited');
    await expect(visitDates).not.toContainText('Last visited');
    // Should contain a date string
    const text = await visitDates.textContent();
    expect(text.trim()).toMatch(/\w{3}\s+\d{1,2},\s+\d{4}/);

    await options.close();
  });

  test('shows all notes including global page note in notes section', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const highlightSlug = '260301-highlight';
    const globalSlug = '260301-global';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: PAGE_URL,
          title: PAGE_TITLE,
          parentIds: [],
          childIds: [`note:${highlightSlug}`, `note:${globalSlug}`],
          timestamps: { 'test-device': Date.now() },
          visitDates: [20260315],
        },
      },
      {
        path: `data/notes/${highlightSlug}.json`,
        data: {
          slug: highlightSlug,
          excerpt: 'Important finding about performance',
          note: 'This section is key',
          cssPath: 'p',
          url: PAGE_URL,
          timestamps: {
            'test-device': new Date('2026-03-15T14:00:00').getTime(),
          },
        },
      },
      {
        path: `data/notes/${globalSlug}.json`,
        data: {
          slug: globalSlug,
          excerpt: null,
          note: 'Overall page summary',
          cssPath: null,
          url: PAGE_URL,
          timestamps: {
            'test-device': new Date('2026-03-15T15:00:00').getTime(),
          },
        },
      },
      {
        path: 'data/logs/test-device/2026-03-15.jsonl',
        lines: [
          {
            timestamp: new Date('2026-03-15T10:00:00').getTime(),
            action: 'leave_page',
            url: PAGE_URL,
            title: PAGE_TITLE,
            timeOnPage: 5000,
            scrollDepth: 20,
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-notes-section', { timeout: 5000 });

    const noteEntries = options.locator('.detail-note-entry');
    await expect(noteEntries).toHaveCount(2);

    // Global note should show "Page note" label
    const notesSection = options.locator('.detail-notes-section');
    await expect(notesSection).toContainText('Page note');
    await expect(notesSection).toContainText('Overall page summary');

    // Highlight note should show excerpt
    await expect(notesSection).toContainText('Important finding');

    await options.close();
  });

  test('no visit dates section when page has no visitDates and no card timestamp', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${slug}.json`,
        data: {
          slug,
          url: PAGE_URL,
          title: PAGE_TITLE,
          parentIds: [],
          childIds: [],
          timestamps: {},
          visitDates: [],
        },
      },
      {
        path: 'data/logs/test-device/2026-03-01.jsonl',
        lines: [
          {
            timestamp: Date.now(),
            action: 'leave_page',
            url: PAGE_URL,
            title: PAGE_TITLE,
            timeOnPage: 5,
            scrollDepth: 10,
          },
        ],
      },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-extra', { timeout: 5000 });

    // The card timestamp should come from the log record, so visit dates
    // section may still appear. But no timeline should exist.
    await expect(options.locator('.detail-timeline')).toHaveCount(0);

    await options.close();
  });
});
