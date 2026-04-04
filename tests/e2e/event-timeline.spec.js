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

    // 30 visits initially shown, but consecutive visits are collapsed (first + last visible)
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(2);
    const collapseBtn = options.locator('.timeline-collapse');
    await expect(collapseBtn).toBeVisible();

    // Should have a "Show more" button for the remaining 5
    const showMore = options.locator('.timeline-show-more');
    await expect(showMore).toBeVisible();
    await expect(showMore).toContainText('5 more');

    // Click show-more to load all 35 (still collapsed)
    await showMore.click();
    await expect(events).toHaveCount(2);
    await expect(showMore).not.toBeVisible();

    // Expand collapsed visits
    await collapseBtn.click();
    await expect(events).toHaveCount(35);

    await options.close();
  });

  test('empty timeline when page has no events and no timestamps', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: {},
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

    // No timeline section when there are no visit dates and no timestamps
    const timeline = options.locator('.detail-timeline');
    await expect(timeline).toHaveCount(0);

    await options.close();
  });

  test('timeline shows time on each event line and no last-visited line', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260301-time-note';
    const noteTs = new Date('2026-03-15T14:05:30').getTime();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [],
        childIds: [`note:${noteSlug}`],
        timestamps: { 'test-device': Date.now() },
        visitDates: [20260315],
        timeOnPage: 5000,
        scrollDepth: 20,
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Timed note', note: 'Has time',
        cssPath: 'p', url: PAGE_URL,
        timestamps: { 'test-device': noteTs },
      }},
      { path: 'data/logs/test-device/2026-03-15.jsonl', lines: [
        { timestamp: new Date('2026-03-15T10:00:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // No "Last visited" line
    const lastVisited = options.locator('.detail-visit-time');
    await expect(lastVisited).toHaveCount(0);

    // Each event line should show time
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(2); // 1 visit + 1 note

    // Note event should include seconds (e.g. "2:05:30")
    const noteEvent = options.locator('.timeline-event:has(.timeline-dot.note)');
    const noteText = await noteEvent.textContent();
    expect(noteText).toMatch(/\d{1,2}:\d{2}:\d{2}/);

    await options.close();
  });

  test('single visit page with no checkpoint shows one timeline dot', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: { 'test-device': now },
        visitDates: [20260315],
      }},
      { path: 'data/logs/test-device/2026-03-15.jsonl', lines: [
        { timestamp: new Date('2026-03-15T10:00:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(1);

    await options.close();
  });

  test('page with no visitDates but with timestamps still shows one timeline dot', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const visitTs = new Date('2026-03-15T14:30:45').getTime();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: { 'test-device': visitTs },
        // No visitDates — page was visited but visitDates not populated
      }},
      { path: 'data/logs/test-device/2026-03-15.jsonl', lines: [
        { timestamp: visitTs, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // Should show one visit dot with time (from page entity timestamps)
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(1);

    // Should show time with seconds since it's from a ms-precision timestamp
    const eventText = await events.first().textContent();
    expect(eventText).toMatch(/\d{1,2}:\d{2}:\d{2}/);

    await options.close();
  });

  test('consecutive visits collapsed with expand button', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    // 10 consecutive visit dates, no notes/snapshots
    const visitDates = [];
    for (let i = 1; i <= 10; i++) visitDates.push(20260300 + i);

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
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: new Date('2026-03-01T09:00:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // Should show first visit + collapse button + last visit = 2 visible events + 1 button
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(2);
    const collapseBtn = options.locator('.timeline-collapse');
    await expect(collapseBtn).toBeVisible();
    await expect(collapseBtn).toContainText('8');

    // Click to expand
    await collapseBtn.click();

    // All 10 visits should now be visible
    await expect(events).toHaveCount(10);
    await expect(collapseBtn).not.toBeVisible();

    await options.close();
  });

  test('visits interspersed with other events are not collapsed', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260305-interleave';
    const noteTs = new Date('2026-03-05T12:00:00').getTime();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [],
        childIds: [`note:${noteSlug}`],
        timestamps: { 'test-device': Date.now() },
        visitDates: [20260301, 20260304, 20260306, 20260308],
        timeOnPage: 5000,
        scrollDepth: 20,
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Interleaved', note: 'Between visits',
        cssPath: 'p', url: PAGE_URL,
        timestamps: { 'test-device': noteTs },
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: new Date('2026-03-01T09:00:00').getTime(), action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5000, scrollDepth: 20 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.detail-timeline', { timeout: 5000 });

    // 4 visits + 1 note = 5 events, no collapse (visits interspersed with note)
    const events = options.locator('.timeline-event');
    await expect(events).toHaveCount(5);
    const collapseBtn = options.locator('.timeline-collapse');
    await expect(collapseBtn).toHaveCount(0);

    await options.close();
  });
});
