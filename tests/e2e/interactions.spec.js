import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('History — likes, notes, attention', () => {
  test('seeded page with likes returns correct value via getPageInfo', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
    expect(info.entry).toBeTruthy();
    expect(info.entry.likes).toBe(3);
    expect(info.entry.scrollDepth).toBe(80);
    expect(info.entry.timeOnPage).toBe(45000);
    expect(info.entry.title).toBe('Example Domain');

    await page.close();
  });

  // Bug 2: getPageInfo should return notes from session cache without needing
  // flushLogBuffer. Notes created via createNote are in session cache but
  // loadPageNotes reads from disk. Fix: use readCacheable for notes.
  test('createNote via message, then getPageInfo returns the note WITHOUT flush', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: TEST_URL, title: 'Example Domain',
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
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
    expect(info.entry).toBeTruthy();
    expect(info.entry.likes).toBe(0);

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
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url: TEST_URL, title: 'Example Domain' },
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
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'visit_page', url: TEST_URL, title: 'Example Domain' },
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
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `log:${date}` })
    , todayStr);

    const noteEntry = (history.value || []).find(e => e.action === 'create_note' && e.path === `notes/${noteSlug}.json`);
    expect(noteEntry).toBeTruthy();
    expect(noteEntry.excerpt).toBeUndefined();
    expect(noteEntry.note).toBeUndefined();
    expect(noteEntry.cssPath).toBeUndefined();
    expect(noteEntry.url).toBeTruthy(); // relation is logged

    await helper.close();
  });

  test('deleteNote unlinks note from parent childIds and adds to orphaned list', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-test-note-abc';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`], user_title: 'Kept',
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Hello', note: 'World', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the note
    const delResult = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);
    expect(delResult.success).toBe(true);

    // Parent page should no longer have note in childIds (page survives due to user_title)
    const pageEntity = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(pageEntity.value).toBeTruthy();
    expect(pageEntity.value.childIds).not.toContain(`note:${noteSlug}`);

    // Note entity should still exist with deleted:true (not physically deleted)
    const noteOnDisk = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}`, includeDeleted: true })
    , noteSlug);
    expect(noteOnDisk.value).toBeTruthy();
    expect(noteOnDisk.value.excerpt).toBe('Hello');
    expect(noteOnDisk.value.deleted).toBe(true);

    // Note should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphaned.value).toBeTruthy();
    expect(orphaned.value.entries.map(e => e.key)).toContain(`note:${noteSlug}`);

    await helper.close();
  });

  test('updateNote creates new note entity and orphans old one (immutable edit)', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-update-test';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`], user_title: 'Kept',
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Original', note: 'Old text', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Update the note text
    const updateResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({ action: 'updateNote', noteSlug: slug, note: 'New text' })
    , { slug: noteSlug });
    expect(updateResult.success).toBe(true);
    expect(updateResult.noteSlug).toBeTruthy();
    expect(updateResult.noteSlug).not.toBe(noteSlug); // new slug generated

    const newNoteSlug = updateResult.noteSlug;

    // New note should exist with updated text
    const newNote = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , newNoteSlug);
    expect(newNote.value).toBeTruthy();
    expect(newNote.value.note).toBe('New text');
    expect(newNote.value.excerpt).toBe('Original'); // inherited from old

    // Old note should be deleted with reason
    const oldNote = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}`, includeDeleted: true })
    , noteSlug);
    expect(oldNote.value).toBeTruthy();
    expect(oldNote.value.deleted).toBe(true);
    expect(oldNote.value.deletionReason).toBe('replaced');
    expect(oldNote.value.replacedBy).toBe(`note:${newNoteSlug}`);

    // Old note should be in orphaned list
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphaned.value.entries.map(e => e.key)).toContain(`note:${noteSlug}`);

    // Parent page's childIds should have new note, not old
    const page = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(page.value.childIds).toContain(`note:${newNoteSlug}`);
    expect(page.value.childIds).not.toContain(`note:${noteSlug}`);

    // replace_note log entry should exist
    const todayStr = new Date().toISOString().slice(0, 10);
    const history = await helper.evaluate((date) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `log:${date}` })
    , todayStr);
    const replaceEntries = (history.value || []).filter(e => e.action === 'replace_note');
    expect(replaceEntries).toHaveLength(1);
    expect(replaceEntries[0].oldPath).toBe(`notes/${noteSlug}.json`);
    expect(replaceEntries[0].path).toBe(`notes/${newNoteSlug}.json`);

    await helper.close();
  });

  test('updateNote transfers list pins from old note to new note', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-pinned-note';
    const listId = 'test-list-abc';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/TestList': listId } } },
      { path: 'list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/TestList': listId } } },
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'TestList', owner: 'test-device', timestamp: now,
        pins: [{ id: `note:${noteSlug}`, pinnedAt: now }],
        rules: [],
      }},
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [{ id: `list:${listId}` }] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`], user_title: 'Kept',
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Pinned highlight', note: 'Note text', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    const updateResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({ action: 'updateNote', noteSlug: slug, note: 'Updated text' })
    , { slug: noteSlug });
    expect(updateResult.success).toBe(true);
    const newNoteSlug = updateResult.noteSlug;

    // List should now pin the new note, not the old one
    const list = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `list:${listId}`);
    expect(list.value).toBeTruthy();
    const pinIds = list.value.pins.map(p => p.id);
    expect(pinIds).toContain(`note:${newNoteSlug}`);
    expect(pinIds).not.toContain(`note:${noteSlug}`);

    // New note should inherit url from old note
    const newNote = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , newNoteSlug);
    expect(newNote.value.url).toBe(TEST_URL);

    await helper.close();
  });

  test('updateNote survives drain→rehydrate round-trip', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-roundtrip-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`], user_title: 'Kept',
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Roundtrip', note: 'Before edit', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Update the note
    const updateResult = await helper.evaluate(({ slug }) =>
      chrome.runtime.sendMessage({ action: 'updateNote', noteSlug: slug, note: 'After edit' })
    , { slug: noteSlug });
    const newNoteSlug = updateResult.noteSlug;

    // Flush to disk, then rehydrate from scratch
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    // After rehydrate, new note should still be linked to page
    const page = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(page.value.childIds).toContain(`note:${newNoteSlug}`);
    expect(page.value.childIds).not.toContain(`note:${noteSlug}`);

    // New note content should survive round-trip
    const newNote = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: `note:${slug}` })
    , newNoteSlug);
    expect(newNote.value).toBeTruthy();
    expect(newNote.value.note).toBe('After edit');
    expect(newNote.value.excerpt).toBe('Roundtrip');

    // Old note should be orphaned after rehydrate
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphaned.value.entries.map(e => e.key)).toContain(`note:${noteSlug}`);

    await helper.close();
  });
});

test.describe('Select-all keyboard shortcut (Ctrl/Cmd+A)', () => {
  test('list view: Ctrl+A selects all pinned rows', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const listId = 'sel-list-001';
    const pins = [];
    const seedFiles = [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/SelectList': listId } } },
      { path: 'list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/SelectList': listId } } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [{ id: `list:${listId}` }] } },
    ];

    // Seed 5 pages and pin them to the list
    for (let i = 0; i < 5; i++) {
      const url = `https://sel-test.com/page${i}`;
      const slug = getSlugForUrl(url);
      pins.push({ id: `page:${slug}`, pinnedAt: now - i * 1000 });
      seedFiles.push({
        path: `pages/${slug}.json`,
        data: { slug, url, title: `Select Page ${i}`, timestamp: now, parentIds: [], childIds: [] },
      });
    }
    seedFiles.push({
      path: `lists/${listId}.json`,
      data: { slug: listId, name: 'SelectList', owner: 'test-device', timestamp: now, pins, rules: [] },
    });

    await resetAndSeed(extContext, extensionId, seedFiles);
    const options = await openOptionsPage(extContext, extensionId);

    // Navigate to the list
    await options.click(`[data-list-id="${listId}"]`);
    await waitForListView(options);
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 5,
      { timeout: 10000 }
    );

    // Press Ctrl+A (Meta on Mac)
    await options.keyboard.press('Meta+a');

    // All 5 rows should be selected
    const selectedCount = await options.$$eval('#relatedResults .result-row.selected', els => els.length);
    expect(selectedCount).toBe(5);

    await options.close();
  });

  test('non-list/non-search view: Ctrl+A shows blocked toast', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    // Options page opens in explore view with no search — Ctrl+A should be blocked

    await options.keyboard.press('Meta+a');

    // Blocked bubble should appear
    await options.waitForFunction(
      () => {
        const bubble = document.getElementById('blockedBubble');
        return bubble && bubble.style.opacity === '1';
      },
      { timeout: 3000 }
    );

    await options.close();
  });

  test('search results: Ctrl+A selects all when <=100 results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const logLines = [];
    // 5 matching pages
    for (let i = 0; i < 5; i++) {
      logLines.push({
        timestamp: now - i * 1000,
        action: 'visit_page',
        url: `https://searchsel.com/p${i}`,
        title: `SearchSel Page ${i}`,
      });
    }
    // 5 non-matching pages (so initial explore shows 10, search shows 5)
    for (let i = 0; i < 5; i++) {
      logLines.push({
        timestamp: now - (5 + i) * 1000,
        action: 'visit_page',
        url: `https://other.com/x${i}`,
        title: `Other Page ${i}`,
      });
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: logLines },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for initial explore to load all 10
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 10,
      { timeout: 10000 }
    );

    // Type a search that matches only 5
    const searchInput = options.locator('#searchDraftInput');
    await searchInput.fill('searchsel');

    // Wait for search to filter down to 5 results
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 5,
      { timeout: 10000 }
    );

    // Blur the search input so Ctrl+A isn't intercepted by the INPUT guard
    await options.evaluate(() => document.activeElement?.blur());
    await options.keyboard.press('Meta+a');

    const selectedCount = await options.$$eval('#relatedResults .result-row.selected', els => els.length);
    expect(selectedCount).toBe(5);

    await options.close();
  });

  test('search results: Ctrl+A shows error when >100 results', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const logLines = [];
    // 110 matching pages
    for (let i = 0; i < 110; i++) {
      logLines.push({
        timestamp: now - i * 1000,
        action: 'visit_page',
        url: `https://bigsel.com/p${i}`,
        title: `BigSel Page ${i}`,
      });
    }
    // 5 non-matching (so we can detect search is active vs initial explore)
    for (let i = 0; i < 5; i++) {
      logLines.push({
        timestamp: now - (110 + i) * 1000,
        action: 'visit_page',
        url: `https://nomatch.com/x${i}`,
        title: `NoMatch Page ${i}`,
      });
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: logLines },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for initial explore to show some results
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length > 0,
      { timeout: 15000 }
    );

    // Search that matches 110 pages
    const searchInput = options.locator('#searchDraftInput');
    await searchInput.fill('bigsel');

    // Wait for search to produce >100 results via data-search-count attribute
    // (set by renderProgressiveResults on the #relatedResults container)
    await options.waitForFunction(
      () => {
        const container = document.getElementById('relatedResults');
        return parseInt(container?.dataset.searchCount || '0', 10) > 100;
      },
      { timeout: 30000 }
    );

    // Blur + dispatch Ctrl+A in a single evaluate to avoid mutation race
    // (background may re-trigger search which resets searchResults between awaits)
    await options.evaluate(() => {
      document.activeElement?.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true,
      }));
    });

    // Error bubble should appear
    await options.waitForFunction(
      () => {
        const bubble = document.getElementById('errorBubble');
        return bubble && bubble.style.opacity === '1';
      },
      { timeout: 5000 }
    );

    await options.close();
  });

  test('single click after Ctrl+A clears select-all', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const listId = 'sel-clear-001';
    const pins = [];
    const seedFiles = [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/ClearList': listId } } },
      { path: 'list-name-to-id.json', data: { timestamp: now, paths: { 'test-device/ClearList': listId } } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [{ id: `list:${listId}` }] } },
    ];

    for (let i = 0; i < 3; i++) {
      const url = `https://clearsel.com/page${i}`;
      const slug = getSlugForUrl(url);
      pins.push({ id: `page:${slug}`, pinnedAt: now - i * 1000 });
      seedFiles.push({
        path: `pages/${slug}.json`,
        data: { slug, url, title: `ClearSel Page ${i}`, timestamp: now, parentIds: [], childIds: [] },
      });
    }
    seedFiles.push({
      path: `lists/${listId}.json`,
      data: { slug: listId, name: 'ClearList', owner: 'test-device', timestamp: now, pins, rules: [] },
    });

    await resetAndSeed(extContext, extensionId, seedFiles);
    const options = await openOptionsPage(extContext, extensionId);

    await options.click(`[data-list-id="${listId}"]`);
    await waitForListView(options);
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );

    // Select all
    await options.keyboard.press('Meta+a');
    let selectedCount = await options.$$eval('#relatedResults .result-row.selected', els => els.length);
    expect(selectedCount).toBe(3);

    // Single click on the first row (no modifier)
    await options.click('#relatedResults .result-row');

    selectedCount = await options.$$eval('#relatedResults .result-row.selected', els => els.length);
    expect(selectedCount).toBe(1);

    await options.close();
  });

  test('fuzzy search: typo in query still matches pages', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const logLines = [];
    // 3 pages with "React" in title — these should fuzzy-match "raect"
    for (let i = 0; i < 3; i++) {
      logLines.push({
        timestamp: now - i * 1000,
        action: 'visit_page',
        url: `https://reactjs.org/docs/page${i}`,
        title: `React Tutorial Part ${i}`,
      });
    }
    // 3 non-matching pages
    for (let i = 0; i < 3; i++) {
      logLines.push({
        timestamp: now - (3 + i) * 1000,
        action: 'visit_page',
        url: `https://other.com/page${i}`,
        title: `Python Guide ${i}`,
      });
    }

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: logLines },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for explore view to show all 6 pages
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 6,
      { timeout: 10000 }
    );

    // Type a fuzzy query — "raect" is a transposition typo for "react"
    const searchInput = options.locator('#searchDraftInput');
    await searchInput.fill('raect');

    // Should find the 3 React pages via fuzzy matching
    await options.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#relatedResults .result-row');
        return rows.length >= 1 && rows.length <= 3;
      },
      { timeout: 15000 }
    );

    const titles = await options.$$eval(
      '#relatedResults .result-row .result-title',
      els => els.map(e => e.textContent.trim())
    );
    expect(titles.length).toBeGreaterThanOrEqual(1);
    for (const t of titles) {
      expect(t).toMatch(/React/);
    }

    // Exact substring search should still work — "React" matches all 3
    await searchInput.fill('React');
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 3,
      { timeout: 10000 }
    );

    // Quoted exact search unchanged — "React" as exact word boundary
    await searchInput.fill('"React"');
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 3,
      { timeout: 10000 }
    );

    await options.close();
  });

  test('search order is stable across repeated queries', async ({ extContext, extensionId }) => {
    const now = Date.now();
    const logLines = [];
    // 3 pages with "Stable" in title, different timestamps.
    // p0 was visited most recently but created earliest — under relevance+createdAt
    // sort, the order should be deterministic and not change when re-searching.
    for (let i = 0; i < 3; i++) {
      logLines.push({
        timestamp: now - (2 - i) * 86400000, // p0 oldest, p2 newest
        action: 'visit_page',
        url: `https://stable-test.com/p${i}`,
        title: `Stable Page ${i}`,
        checkpoint: true,
      });
    }
    // A second very recent visit for p0 — would have pushed it to top under lastVisit sort
    logLines.push({
      timestamp: now - 1000,
      action: 'visit_page',
      url: 'https://stable-test.com/p0',
      title: 'Stable Page 0',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: logLines },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for explore view
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );

    // First search
    const searchInput = options.locator('#searchDraftInput');
    await searchInput.fill('Stable');

    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 3,
      { timeout: 10000 }
    );

    const orderBefore = await options.$$eval(
      '#relatedResults .result-row',
      els => els.map(e => e.querySelector('.result-url')?.textContent?.trim())
    );
    expect(orderBefore.length).toBe(3);

    // Clear and re-search — order must be identical
    await searchInput.fill('');
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );

    await searchInput.fill('Stable');
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 3,
      { timeout: 10000 }
    );

    const orderAfter = await options.$$eval(
      '#relatedResults .result-row',
      els => els.map(e => e.querySelector('.result-url')?.textContent?.trim())
    );

    expect(orderAfter).toEqual(orderBefore);

    await options.close();
  });
});
