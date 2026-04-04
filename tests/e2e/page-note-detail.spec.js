import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage, getSlugForUrl } from './helpers.js';

const PAGE_URL = 'https://example.com/page-note-test';
const PAGE_TITLE = 'Page Note Test';

test.describe('Page note textarea in detail card', () => {
  test('pre-fills textarea with existing global note', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260301-global-note';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${noteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: null, note: 'Existing page note', cssPath: null,
        url: PAGE_URL,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
        { timestamp: now + 1, action: 'create_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    // Click the "···" button to open detail card
    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');

    // Wait for extra detail to load (async)
    await options.waitForSelector('.detail-page-note');

    const textarea = options.locator('.detail-page-note');
    await expect(textarea).toHaveValue('Existing page note');
    expect(await textarea.getAttribute('data-note-slug')).toBe(noteSlug);

    await options.close();
  });

  test('creates a new page note when typing in empty textarea', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: [now],
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-page-note');

    const textarea = options.locator('.detail-page-note');
    await expect(textarea).toHaveValue('');

    // Type a new note
    await textarea.fill('Brand new note');
    // Trigger input event (fill doesn't always fire input)
    await textarea.dispatchEvent('input');

    // Wait for debounce (500ms) + processing — noteSlug should be set on textarea
    await options.waitForFunction(() => {
      const ta = document.querySelector('.detail-page-note');
      return ta && ta.dataset.noteSlug && ta.dataset.noteSlug.length > 0;
    }, { timeout: 5000 });

    // Verify the note was created via backend
    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);

    const globalNote = notesResp.notes.find(n => n.excerpt === null);
    expect(globalNote).toBeTruthy();
    expect(globalNote.note).toBe('Brand new note');

    await helper.close();
    await options.close();
  });

  test('updates existing page note when editing textarea (immutable: creates new note)', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260301-update-global';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${noteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: null, note: 'Old text', cssPath: null,
        url: PAGE_URL,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
        { timestamp: now + 1, action: 'create_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-page-note');

    const textarea = options.locator('.detail-page-note');
    await expect(textarea).toHaveValue('Old text');

    // Clear and type new text
    await textarea.fill('Updated text');
    await textarea.dispatchEvent('input');

    // Wait for debounce (500ms) + replace_note processing.
    // The textarea's data-note-slug should change to the new note slug.
    await options.waitForFunction((oldSlug) => {
      const ta = document.querySelector('.detail-page-note');
      return ta && ta.dataset.noteSlug && ta.dataset.noteSlug !== oldSlug;
    }, noteSlug, { timeout: 5000 });

    // Verify via backend: loadPageNotes should return the new note with updated text
    const helper = await openHelperPage(extContext, extensionId);
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);

    const globalNote = notesResp.notes.find(n => n.excerpt === null);
    expect(globalNote).toBeTruthy();
    expect(globalNote.note).toBe('Updated text');

    // Old note should be orphaned
    const orphaned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphaned.value.entries.map(e => e.key)).toContain(`note:${noteSlug}`);

    await helper.close();
    await options.close();
  });

  test('global note appears only in textarea, highlight notes in list', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const globalNoteSlug = '260301-global-only';
    const highlightNoteSlug = '260301-highlight-only';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${globalNoteSlug}`, `note:${highlightNoteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${globalNoteSlug}.json`, data: {
        slug: globalNoteSlug, excerpt: null, note: 'Global note text', cssPath: null,
        url: PAGE_URL,
      }},
      { path: `data/notes/${highlightNoteSlug}.json`, data: {
        slug: highlightNoteSlug, excerpt: 'Selected text', note: 'Highlight annotation', cssPath: 'p',
        url: PAGE_URL,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
        { timestamp: now + 1, action: 'create_note', url: PAGE_URL, path: `notes/${globalNoteSlug}.json` },
        { timestamp: now + 2, action: 'create_note', url: PAGE_URL, path: `notes/${highlightNoteSlug}.json` },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.click('.att-ctrl-btn', { force: true });
    await options.waitForSelector('.page-detail-card');
    await options.waitForSelector('.detail-page-note');

    // Textarea should have the global note
    const textarea = options.locator('.detail-page-note');
    await expect(textarea).toHaveValue('Global note text');

    // The notes list should only contain the highlight note, not the global one
    const noteEntries = options.locator('.detail-note-entry');
    await expect(noteEntries).toHaveCount(1);

    // The single entry should be the highlight (contains "Selected text")
    const entryText = await noteEntries.first().textContent();
    expect(entryText).toContain('Selected text');

    await options.close();
  });

  test('replace_note inherits content from old note when new note file is missing', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const oldNoteSlug = '260301-old-highlight';
    const newNoteSlug = '260301-new-highlight';
    const now = Date.now();

    // Seed old note file + page entity (reflecting create_note already applied).
    // Do NOT seed the new note file — simulates a missing file during replay.
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${oldNoteSlug}`],
        timestamp: now,
      }},
      { path: `data/notes/${oldNoteSlug}.json`, data: {
        slug: oldNoteSlug, excerpt: 'Important quote', note: 'Original annotation',
        cssPath: 'div > p:nth-of-type(3)', url: PAGE_URL,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
        { timestamp: now + 1, action: 'create_note', url: PAGE_URL, path: `notes/${oldNoteSlug}.json` },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Inject replace_note into logBuffer, then rehydrate with keepLogBuffer.
    // Phase 2 will replay the replace_note entry — new note file doesn't exist.
    await helper.evaluate((entry) =>
      chrome.runtime.sendMessage({ action: 'setLogBufferForTest', entries: [entry] })
    , { timestamp: now + 2, action: 'replace_note', url: PAGE_URL, oldPath: `notes/${oldNoteSlug}.json`, path: `notes/${newNoteSlug}.json` });

    const rehydrateResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest', keepLogBuffer: true })
    );
    expect(rehydrateResp.success).toBe(true);

    // Load notes — the new note should inherit content from old note
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);
    expect(notesResp.success).toBe(true);

    const note = notesResp.notes.find(n => n.slug === newNoteSlug);
    expect(note).toBeTruthy();
    // Key assertion: excerpt and cssPath must be inherited from old note
    expect(note.excerpt).toBe('Important quote');
    expect(note.cssPath).toBe('div > p:nth-of-type(3)');
    expect(note.url).toBe(PAGE_URL);

    // Old note should be orphaned (not in page's notes)
    const oldNote = notesResp.notes.find(n => n.slug === oldNoteSlug);
    expect(oldNote).toBeFalsy();

    await helper.close();
  });

  test('createNote then updateNote preserves excerpt/cssPath after flush+rehydrate', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const now = Date.now();

    // Seed only the page entity — note will be created dynamically
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamp: now,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Create a highlight note via createNote (simulates content script Alt+H)
    const createResp = await helper.evaluate(({ slug, url }) =>
      chrome.runtime.sendMessage({
        action: 'createNote', pageSlug: slug, url,
        excerpt: 'Important quote', note: '', cssPath: 'div > p:nth-of-type(3)',
      })
    , { slug, url: PAGE_URL });
    expect(createResp.success).toBe(true);
    const origNoteSlug = createResp.noteSlug;
    expect(origNoteSlug).toBeTruthy();

    // Update the note text (triggers replace_note)
    const updateResp = await helper.evaluate((noteSlug) =>
      chrome.runtime.sendMessage({ action: 'updateNote', noteSlug, note: 'My annotation' })
    , origNoteSlug);
    expect(updateResp.success).toBe(true);
    const newNoteSlug = updateResp.noteSlug;
    expect(newNoteSlug).toBeTruthy();
    expect(newNoteSlug).not.toBe(origNoteSlug);

    // Flush log buffer to disk (triggers drain)
    const flushResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );
    expect(flushResp.success).toBe(true);

    // Rehydrate from disk (simulates restart)
    const rehydrateResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );
    expect(rehydrateResp.success).toBe(true);

    // Load notes after rehydration — data should be preserved
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);
    expect(notesResp.success).toBe(true);

    const note = notesResp.notes.find(n => n.slug === newNoteSlug);
    expect(note).toBeTruthy();
    expect(note.excerpt).toBe('Important quote');
    expect(note.cssPath).toBe('div > p:nth-of-type(3)');
    expect(note.note).toBe('My annotation');
    expect(note.url).toBe(PAGE_URL);

    // Old note should NOT be in the notes list (orphaned)
    const oldNote = notesResp.notes.find(n => n.slug === origNoteSlug);
    expect(oldNote).toBeFalsy();

    await helper.close();
  });

  test('note badge hidden when page has only a global note', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const globalSlug = '260301-badge-global';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${globalSlug}`],
        timestamps: { 'test-device': now },
      }},
      { path: `data/notes/${globalSlug}.json`, data: {
        slug: globalSlug, excerpt: null, note: 'Page note only', cssPath: null,
        url: PAGE_URL,
      }},
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    // Wait for enrichment to complete (async background task)
    await options.waitForFunction(() => {
      const row = document.querySelector('.result-row');
      return row && row.closest('.result-item')?.querySelector('.card-extras') !== undefined;
    }, { timeout: 5000 });

    // The note badge should NOT be visible since the only note is global
    const noteBadge = options.locator('.card-tag-note');
    await expect(noteBadge).toHaveCount(0);

    await options.close();
  });

  test('note badge hidden when referenced note entity is missing', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: ['note:missing-note'],
        timestamps: { 'test-device': now },
      }},
      // Note entity file NOT seeded — simulates deleted/missing note
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now, action: 'leave_page', url: PAGE_URL, title: PAGE_TITLE, timeOnPage: 5, scrollDepth: 50 },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForSelector('.result-row', { timeout: 5000 });

    await options.waitForFunction(() => {
      const row = document.querySelector('.result-row');
      return row && row.closest('.result-item')?.querySelector('.card-extras') !== undefined;
    }, { timeout: 5000 });

    const noteBadge = options.locator('.card-tag-note');
    await expect(noteBadge).toHaveCount(0);

    await options.close();
  });
});
