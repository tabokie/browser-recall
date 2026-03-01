import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('History recording', () => {
  test('seeded history entry appears in options explore view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: 'https://example.com/', title: 'Example Domain', timeOnPage: 5, scrollDepth: 50 },
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
      { path: 'settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    // Page is ready (initialize + showExplore completed) — check for empty state
    const rows = await options.$$('.result-row');
    expect(rows.length).toBe(0);
    await options.close();
  });

  test('content script auto-reports page visit', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], blacklist: [] } },
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
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: base - 2000, action: 'page', url: 'https://older.example.com/', title: 'Older Page' },
        { timestamp: base - 1000, action: 'page', url: 'https://middle.example.com/', title: 'Middle Page' },
        { timestamp: base, action: 'page', url: 'https://newest.example.com/', title: 'Newest Page' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    const titles = await options.$$eval('.result-title', els => els.map(el => el.textContent.trim()));
    expect(titles.length).toBe(3);
    expect(titles[0]).toContain('Newest Page');
    expect(titles[2]).toContain('Older Page');
    await options.close();
  });
});
