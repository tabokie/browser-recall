import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, getSlugForUrl } from './helpers.js';

const PAGE_URL = 'https://example.com/timeline-test';
const PAGE_TITLE = 'Timeline Test Page';

test.describe('Event dot timeline in page detail modal', () => {
  test('shows timeline with visits, notes, and snapshots', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260301-highlight';
    const snapshotTs = new Date('2026-03-15T10:30:00').getTime();

    // 3 visit dates (YYYYMMDD ints), 1 highlight note, 1 snapshot
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [],
        childIds: [`note:${noteSlug}`, `snapshot:${slug}-${snapshotTs}`],
        timestamps: { 'test-device': Date.now() },
        visitDates: [20260310, 20260315, 20260320],
        timeOnPage: 120000,
        scrollDepth: 80,
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug,
        excerpt: 'Important finding about performance',
        note: 'This section is key',
        cssPath: 'p',
        url: PAGE_URL,
        timestamps: { 'test-device': new Date('2026-03-15T14:00:00').getTime() },
      }},
      { path: `data/snapshots/${slug}-${snapshotTs}.html`, content: '<html><body>snapshot</body></html>' },
      { path: 'data/logs/test-device/2026-03-10.jsonl', lines: [
        { timestamp: new Date('2026-03-10T09:00:00').getTime(), action: 'visit_page', url: PAGE_URL, title: PAGE_TITLE },
        { timestamp: new Date('2026-03-10T09:05:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 30000, scrollDepth: 40 },
      ]},
      { path: 'data/logs/test-device/2026-03-15.jsonl', lines: [
        { timestamp: new Date('2026-03-15T10:00:00').getTime(), action: 'visit_page', url: PAGE_URL, title: PAGE_TITLE },
        { timestamp: new Date('2026-03-15T10:30:00').getTime(), action: 'create_snapshot', url: PAGE_URL, path: `snapshots/${slug}-${snapshotTs}` },
        { timestamp: new Date('2026-03-15T14:00:00').getTime(), action: 'create_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
      { path: 'data/logs/test-device/2026-03-20.jsonl', lines: [
        { timestamp: new Date('2026-03-20T11:00:00').getTime(), action: 'visit_page', url: PAGE_URL, title: PAGE_TITLE },
        { timestamp: new Date('2026-03-20T11:10:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 90000, scrollDepth: 80 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    // Open page detail modal
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');

    // Wait for timeline to render (loaded async via loadExtraDetail)
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // Should have 5 events: 3 visits + 1 note + 1 snapshot
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(5);

    // Events should be ordered newest-first
    // Mar 20 visit, Mar 15 note, Mar 15 snapshot, Mar 15 visit, Mar 10 visit
    const firstEvent = events.first();
    await expect(firstEvent.locator('.timeline-dot.visit')).toBeVisible();

    // Verify note and snapshot events exist
    await expect(options.locator('.timeline-dot.note')).toHaveCount(1);
    await expect(options.locator('.timeline-dot.snapshot')).toHaveCount(1);
    await expect(options.locator('.timeline-dot.visit')).toHaveCount(3);

    // Note event should contain truncated excerpt
    const noteEvent = options.locator('.timeline-event:has(.timeline-dot.note)');
    await expect(noteEvent).toContainText('Important finding');

    await options.close();
  });

  test('show-more button expands truncated timeline', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    // Create 35 visit dates to exceed the 30-event cap
    const visitDates = [];
    for (let i = 1; i <= 35; i++) {
      const day = String(i).padStart(2, '0');
      // Use Jan + Feb 2026 to get 35 dates
      if (i <= 28) visitDates.push(20260100 + i);
      else visitDates.push(20260200 + (i - 28));
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: { 'test-device': Date.now() },
        visitDates,
        timeOnPage: 5000,
        scrollDepth: 20,
      }},
      { path: 'data/logs/test-device/2026-01-01.jsonl', lines: [
        { timestamp: new Date('2026-01-01T09:00:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // Should initially show 30 events
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(30);

    // Should have a "Show more" button
    const showMore = options.locator('.timeline-show-more');
    await expect(showMore).toBeVisible();
    await expect(showMore).toContainText('5 more');

    // Click it to expand
    await showMore.click();
    await expect(events).toHaveCount(35);

    // Button should be gone
    await expect(showMore).not.toBeVisible();

    await options.close();
  });

  test('empty timeline when page has no events', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: { 'test-device': Date.now() },
        visitDates: [],
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: Date.now(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 10 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-extra', { timeout: 5000 });

    // No timeline section when there are no events
    const timeline = options.locator('.detail-timeline');
    await expect(timeline).toHaveCount(0);

    await options.close();
  });
});
