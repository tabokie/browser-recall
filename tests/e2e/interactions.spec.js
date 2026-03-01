import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Interactions — likes, notes, attention', () => {
  test('seeded page with likes returns correct value via getPageInfo', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain',
        timestamp: now, likes: 3, scrollDepth: 80, timeOnPage: 45000,
        parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);

    const info = await page.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url })
    , TEST_URL);

    expect(info.success).toBe(true);
    expect(info.interaction).toBeTruthy();
    expect(info.interaction.likes).toBe(3);
    expect(info.interaction.scrollDepth).toBe(80);
    expect(info.interaction.timeOnPage).toBe(45000);
    expect(info.interaction.title).toBe('Example Domain');

    await page.close();
  });

  // Bug 2: getPageInfo should return notes from session cache without needing
  // flushLogBuffer. Notes created via createNote are in session cache but
  // loadPageNotes reads from disk. Fix: use readCacheable for notes.
  test('createNote via message, then getPageInfo returns the note WITHOUT flush', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain',
        timestamp: now, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);

    const noteResult = await page.evaluate((s) =>
      chrome.runtime.sendMessage({
        action: 'createNote', pageSlug: s,
        excerpt: 'highlighted text', note: 'my annotation', cssPath: 'body > p',
      })
    , TEST_SLUG);
    expect(noteResult.success).toBe(true);
    expect(noteResult.noteSlug).toBeTruthy();

    // NO flushLogBuffer — note should be visible from session cache alone
    const info = await page.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url })
    , TEST_URL);

    expect(info.success).toBe(true);
    expect(info.notes.length).toBeGreaterThanOrEqual(1);
    const note = info.notes.find(n => n.excerpt === 'highlighted text');
    expect(note).toBeTruthy();
    expect(note.note).toBe('my annotation');

    await page.close();
  });

  test('seeded page with attention data displays in explore view', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain',
          timeOnPage: 120000, scrollDepth: 95 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForSelector('.result-row', { timeout: 15000 });
    const rowUrl = await options.$eval('.result-row', el => el.dataset.url);
    expect(rowUrl).toBe(TEST_URL);

    await options.close();
  });

  test('like delta accumulates via addLog replay', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain',
        timestamp: now - 3000, likes: 0, parentIds: [], childIds: [],
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/test-helper.html`);
    await page.waitForFunction(() => typeof chrome !== 'undefined' && chrome.runtime);

    const info = await page.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'getPageInfo', url })
    , TEST_URL);

    expect(info.success).toBe(true);
    expect(info.interaction).toBeTruthy();
    expect(info.interaction.likes).toBe(0);

    await page.close();
  });
});
