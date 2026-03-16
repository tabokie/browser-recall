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
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${noteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: null, note: 'Existing page note', cssPath: null,
        parentIds: [`page:${slug}`], childIds: [], timestamp: now,
      }},
      { path: 'data/logs/2026-03-01.jsonl', lines: [
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
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [],
        timestamps: [now],
      }},
      { path: 'data/logs/2026-03-01.jsonl', lines: [
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

  test('updates existing page note when editing textarea', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = '260301-update-global';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${noteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: null, note: 'Old text', cssPath: null,
        parentIds: [`page:${slug}`], childIds: [], timestamp: now,
      }},
      { path: 'data/logs/2026-03-01.jsonl', lines: [
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

    // Wait for debounce (500ms) + async save to disk
    await options.waitForTimeout(1000);

    // updateNote writes to disk but doesn't update session cache.
    // Rehydrate to rebuild session cache from disk, then verify.
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );
    const notesResp = await helper.evaluate((s) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug: s })
    , slug);

    const globalNote = notesResp.notes.find(n => n.excerpt === null);
    expect(globalNote).toBeTruthy();
    expect(globalNote.note).toBe('Updated text');

    await helper.close();
    await options.close();
  });

  test('global note appears only in textarea, highlight notes in list', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const globalNoteSlug = '260301-global-only';
    const highlightNoteSlug = '260301-highlight-only';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: PAGE_TITLE,
        parentIds: [], childIds: [`note:${globalNoteSlug}`, `note:${highlightNoteSlug}`],
        timestamps: [now],
      }},
      { path: `data/notes/${globalNoteSlug}.json`, data: {
        slug: globalNoteSlug, excerpt: null, note: 'Global note text', cssPath: null,
        parentIds: [`page:${slug}`], childIds: [], timestamp: now,
      }},
      { path: `data/notes/${highlightNoteSlug}.json`, data: {
        slug: highlightNoteSlug, excerpt: 'Selected text', note: 'Highlight annotation', cssPath: 'p',
        parentIds: [`page:${slug}`], childIds: [], timestamp: now,
      }},
      { path: 'data/logs/2026-03-01.jsonl', lines: [
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
});
