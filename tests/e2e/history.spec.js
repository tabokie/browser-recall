import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('History recording', () => {
  test('seeded history entry appears in options explore view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: 'https://example.com/', title: 'Example Domain', timeOnPage: 5, scrollDepth: 50 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    const titleText = await options.textContent('.result-title');
    expect(titleText).toContain('Example Domain');
    await options.close();
  });

  test('clean state between tests — no leftover data', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    // Page is ready (initialize + showExplore completed) — check for empty state
    const rows = await options.$$('.result-row');
    expect(rows.length).toBe(0);
    await options.close();
  });

  test('content script auto-reports page visit', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], blacklist: [] } },
    ]);

    // Navigate to a real page — content script injects and sends reportPage
    const page = await extContext.newPage();
    await page.goto('https://example.com');

    // Open options — waitForSelector polls until the visit appears
    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 15000 });
    const titleText = await options.textContent('.result-title');
    expect(titleText).toContain('Example Domain');

    await page.close();
    await options.close();
  });

  test('multiple entries appear sorted by recency (newest first)', async ({ extContext, extensionId, setupDir }) => {
    const base = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: base - 2000, action: 'visit_page', url: 'https://older.example.com/', title: 'Older Page' },
        { timestamp: base - 1000, action: 'visit_page', url: 'https://middle.example.com/', title: 'Middle Page' },
        { timestamp: base, action: 'visit_page', url: 'https://newest.example.com/', title: 'Newest Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    const titles = await options.$$eval('.result-title', els => els.map(el => el.textContent.trim()));
    // >= not == : content script auto-reports from prior tests in the same worker
    // can race with resetAndSeed (isLeaving report arrives after reset).
    expect(titles.length).toBeGreaterThanOrEqual(3);
    // Newest-first ordering: first seeded entry should be "Newest Page"
    expect(titles[0]).toContain('Newest Page');
    // All three seeded pages present
    expect(titles).toContain('Newest Page');
    expect(titles).toContain('Middle Page');
    expect(titles).toContain('Older Page');
    await options.close();
  });

  // Bug: title-less history entries not enriched from page checkpoint (086e139)
  test('title-less history entry enriched from page checkpoint', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://example.com/enriched';
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Enriched Title',
        timestamp: now, parentIds: [], childIds: [],
      }},
      // History entry has NO title — enrichFromEntityStorage should fill it from checkpoint
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 10000 });
    const title = await options.$eval('.result-title', el => el.textContent.trim());
    expect(title).toBe('Enriched Title');
    await options.close();
  });

  // Title-less history entry enriched from page entity
  test('title-less history entry enriched from page entity', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://example.com/shallow-title';
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // History entry has no title, but page entity does
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url },
      ]},
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Entity Title', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 10000 });
    const title = await options.$eval('.result-title', el => el.textContent.trim());
    expect(title).toBe('Entity Title');
    await options.close();
  });

  // Bug bc19640: session cache empty after disable/re-enable.
  // NOT tested here: the real bug was that neither onInstalled nor onStartup fires
  // after disable/re-enable, leaving session cache empty. Reproducing that requires
  // toggling the extension at chrome://extensions which Playwright can't automate.
  // The fix (readCacheable fallback to disk) is exercised implicitly by every test
  // via resetAndSeed → rehydrateForTest.

  // When neither the log entry nor a page entity has a title, the card should
  // fall back to the URL hostname rather than showing <unknown>.
  test('title-less entry with no page entity falls back to hostname', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://titterfun.com/';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Log entry has NO title field; no page entity seeded
      { path: 'data/logs/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });
    const title = await options.$eval('.result-title', el => el.textContent.trim());
    expect(title).toBe('titterfun.com');
    await options.close();
  });

  // Bug 20260224: title trimming must apply consistently to all page reports.
  // Regression: first visit logged trimmed, subsequent visits logged untrimmed.
  // This test visits twice and verifies BOTH entries use the trimmed title.
  test('title trimming applies to both first and subsequent visits', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/trim-test', {
      title: 'Article Title | Site Name',
      body: '<p>Content</p>',
    });
    localServer.addPage('/other', { title: 'Other Page', body: '<p>Other</p>' });

    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        titleTrimRules: [{ urlPrefix: 'http://127.0.0.1', action: 'remove_after_pipe' }],
        blacklist: [],
      }},
    ]);

    const url = localServer.url('/trim-test');
    const today = new Date().toISOString().slice(0, 10);

    // First visit
    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForTimeout(300);

    // Navigate away and back for second visit (triggers new report)
    await page.goto(localServer.url('/other'));
    await page.waitForTimeout(300);
    await page.goto(url);
    await page.waitForTimeout(300);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for at least 2 entries with title
    await helper.waitForFunction(({ u, dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
        .then(r => r.value && r.value.filter(e => e.url === u && e.title).length >= 2)
    , { u: url, dateKey: today }, { timeout: 5000 });

    const hist = await helper.evaluate(({ dateKey }) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'log:' + dateKey })
    , { dateKey: today });
    await helper.close();
    await page.close();

    const entries = hist.value.filter(e => e.url === url && e.title);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Both entries should have the trimmed title
    for (const entry of entries) {
      expect(entry.title).toBe('Article Title');
    }
  });
});
