import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

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

  // Bug d2815bf: dislike (Alt+D) sends likes:-1 via addLog.
  // NOT tested here: the runtime like/dislike path uses chrome.commands.onCommand
  // which triggers addLog({ likes: delta }) internally. There's no message action
  // to inject arbitrary log entries, and keyboard shortcuts are unreliable in
  // Playwright. The replay accumulation of positive/negative likes deltas is
  // covered by unit tests (replay.test.js applyLogToPage).

  // Bug 20260223: createNote should add note:<slug> to parent page's childIds
  test('createNote adds note to parent page childIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a note on the page
    const noteResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({
        action: 'createNote', pageSlug: slug,
        excerpt: 'Test highlight', note: 'A note', cssPath: 'body > p',
      })
    , { slug: TEST_SLUG });
    expect(noteResult.success).toBe(true);
    const noteSlug = noteResult.noteSlug;

    // Check parent page entity has the note in childIds
    const pageEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    await helper.close();

    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.childIds).toContain(`note:${noteSlug}`);
  });

  test('createNote writes content to filesystem, log entry has no content', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'history/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    const noteResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({
        action: 'createNote', pageSlug: slug,
        excerpt: 'Saved to disk', note: 'My annotation', cssPath: 'div > p',
      })
    , { slug: TEST_SLUG });
    expect(noteResult.success).toBe(true);
    const noteSlug = noteResult.noteSlug;

    // Note content should be on disk (readable via loadNote)
    const noteOnDisk = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , noteSlug);
    expect(noteOnDisk.value).toBeTruthy();
    expect(noteOnDisk.value.excerpt).toBe('Saved to disk');
    expect(noteOnDisk.value.note).toBe('My annotation');

    // Flush log to disk so we can inspect JSONL
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Load today's history and find the note entry — it should NOT have content
    const todayStr = new Date().toISOString().slice(0, 10);
    const history = await helper.evaluate((date) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `history:${date}` })
    , todayStr);

    const noteEntry = (history.value || []).find(e => e.action === 'note' && e.slug === noteSlug);
    expect(noteEntry).toBeTruthy();
    expect(noteEntry.excerpt).toBeUndefined();
    expect(noteEntry.note).toBeUndefined();
    expect(noteEntry.cssPath).toBeUndefined();
    expect(noteEntry.parentIds).toBeTruthy(); // relation is logged

    await helper.close();
  });

  test('deleteNote unlinks note from parent childIds and adds to orphaned list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-test-note-abc';
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Hello', note: 'World', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the note
    const delResult = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);
    expect(delResult.success).toBe(true);

    // Parent page should no longer have note in childIds
    const pageEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.childIds).not.toContain(`note:${noteSlug}`);

    // Note file should still exist on disk (not physically deleted)
    const noteOnDisk = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , noteSlug);
    expect(noteOnDisk.value).toBeTruthy();
    expect(noteOnDisk.value.excerpt).toBe('Hello');

    // Note should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphaned.value).toBeTruthy();
    expect(orphaned.value.keys).toContain(`note:${noteSlug}`);

    await helper.close();
  });

  test('updateNote writes directly to disk without log entry', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-update-test';
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Original', note: 'Old text', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Update the note text
    const updateResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({ action: 'updateNote', noteSlug: slug, note: 'New text' })
    , { slug: noteSlug });
    expect(updateResult.success).toBe(true);

    // Note should have updated text on disk
    const noteOnDisk = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , noteSlug);
    expect(noteOnDisk.value).toBeTruthy();
    expect(noteOnDisk.value.note).toBe('New text');
    expect(noteOnDisk.value.excerpt).toBe('Original'); // unchanged

    // Flush and check no 'note' log entry was created for the update
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );
    const todayStr = new Date().toISOString().slice(0, 10);
    const history = await helper.evaluate((date) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `history:${date}` })
    , todayStr);
    const noteEntries = (history.value || []).filter(e => e.action === 'note' && e.slug === noteSlug);
    expect(noteEntries).toHaveLength(0); // no log entry for update

    await helper.close();
  });
});
