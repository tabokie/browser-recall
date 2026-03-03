import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Deletion guardrails', () => {

  // Fix 1a: loadPageNotes should filter out orphaned (deleted) notes.
  // Simulate stale disk checkpoint: page.childIds still references a note
  // that is already in the orphaned list. loadPageNotes reads from disk and
  // must filter against orphaned keys.
  test('deleted note does not appear in loadPageNotes even with stale disk', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-guardrail-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      // Page on disk still has note in childIds (stale checkpoint)
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      // Note file still on disk (deletion doesn't remove files)
      { path: `notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'To be deleted', note: 'Gone', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
      // Orphaned list already tracks the deleted note
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [`note:${noteSlug}`],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // loadPageNotes reads from disk (stale childIds) — must filter orphaned notes
    const notesResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug })
    , TEST_SLUG);
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes.filter(n => n.slug === noteSlug)).toHaveLength(0);

    await helper.close();
  });

  // Fix 1b: loadAllNotes (used by search) should filter out orphaned notes.
  // loadAllNotes scans all note files on disk and groups by parentIds.
  // Deleted notes still have parentIds on disk, so they appear in results
  // unless filtered against the orphaned list.
  test('deleted note does not appear in loadAllNotes', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-search-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Search target', note: 'Find me', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
      // Orphaned list already tracks the deleted note
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [`note:${noteSlug}`],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // loadAllNotes scans disk — must filter orphaned notes
    const allNotes = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'loadAllNotes' })
    );
    expect(allNotes.success).toBe(true);
    for (const [, notes] of Object.entries(allNotes.notesMap || {})) {
      expect(notes.filter(n => n.slug === noteSlug)).toHaveLength(0);
    }

    await helper.close();
  });

  // Fix 2: note mutation handler in options.js.
  // After deleteNote, the options page should refresh and remove the note
  // from the detail panel without requiring a manual page reload.
  test('deleted note disappears from options detail panel', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const noteSlug = '260301-ui-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Visible note', note: 'Annotation', cssPath: 'p',
        parentIds: [`page:${TEST_SLUG}`], childIds: [], timestamp: now,
      }},
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    // Open options page — the page should appear in explore
    const options = await openOptionsPage(extContext, extensionId);

    // Click the expand button on the result row to show notes
    const expandBtn = options.locator('.result-expand').first();
    await expect(expandBtn).toBeVisible({ timeout: 5000 });
    await expandBtn.click();

    // Note should be visible in the detail panel
    const noteEntry = options.locator(`.detail-note-entry[data-note-slug="${noteSlug}"]`);
    await expect(noteEntry).toBeVisible({ timeout: 5000 });

    // Delete the note via background message (simulates deletion from another context)
    await options.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);

    // The note should disappear from the detail panel without page reload.
    // The mutation handler should trigger refreshCurrentView().
    await expect(noteEntry).toBeHidden({ timeout: 5000 });

    await options.close();
  });

  // Deleted list entity should return null from readCacheable, not stale disk data.
  // Currently sessionWrite calls cacheRemove for deleted entities, so readCacheable
  // falls through to readFs and loads the pre-deletion disk checkpoint.
  test('deleted list entity returns null from readCacheable', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:to-delete', name: 'To Delete' }],
      }},
      { path: 'lists/to-delete.json', data: {
        slug: 'to-delete', name: 'To Delete', timestamp: now, pins: [], qbTrees: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the list
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'to-delete' })
    );

    // readCacheable should return null for the deleted list entity
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:to-delete' })
    );
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();

    await helper.close();
  });

  // Deleted list (deleted: true on disk) should return null from readCacheable
  // after hydration. This simulates extension restart where the disk checkpoint
  // was written with deleted: true by a previous drain.
  test('deleted list stays hidden after rehydration', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [],  // already removed by del_list effectOf
      }},
      // Disk checkpoint already has deleted: true (written by previous drain)
      { path: 'lists/rehydrate-del.json', data: {
        slug: 'rehydrate-del', name: 'Rehydrate Del', timestamp: now,
        pins: [], qbTrees: [], deleted: true,
      }},
      // Orphaned list tracks it
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: ['list:rehydrate-del'],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // readCacheable should return null for deleted entity loaded from disk
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:rehydrate-del' })
    );
    expect(result.success).toBe(true);
    expect(result.value).toBeNull();

    await helper.close();
  });

  // Fix 3: replay guard on orphaned list resurrection.
  // After del_list, a subsequent toggleListPin should NOT resurrect the list
  // entity or re-add it to listOrder via effectOf replay.
  test('pinning to a deleted list does not resurrect it', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const pageUrl = 'https://example.com/pinme';
    const pageSlug = getSlugForUrl(pageUrl);
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [],
        listOrder: [{ id: 'list:doomed', name: 'Doomed' }],
      }},
      { path: 'lists/doomed.json', data: {
        slug: 'doomed', name: 'Doomed', timestamp: now, pins: [], qbTrees: [],
      }},
      { path: `pages/${pageSlug}.json`, data: {
        slug: pageSlug, url: pageUrl, title: 'Pin Target', timestamp: now,
        parentIds: [], childIds: [],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the list
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'deleteList', listId: 'doomed' })
    );

    // Verify list is deleted from listOrder
    let settings = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' })
    );
    expect(settings.value.listOrder.find(e => e.id === 'list:doomed')).toBeUndefined();

    // Now try to pin a page to the deleted list
    await helper.evaluate((url) =>
      chrome.runtime.sendMessage({ action: 'toggleListPin', listId: 'doomed', url })
    , pageUrl);

    // After the pin attempt, the replay guard should have blocked the list action.
    // The list entity should NOT have acquired a pin (it may be loaded from disk
    // where it has the original pre-deletion content, since sessionWrite removes
    // deleted entities from session cache).
    const listEntity = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:doomed' })
    );
    const pins = listEntity.value?.pins || [];
    const pageId = `page:${pageSlug}`;
    const shallowId = `shallow:${pageUrl}`;
    expect(pins.some(p => p.id === pageId || p.id === shallowId)).toBe(false);

    // listOrder should still not contain the deleted list
    settings = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'settings' })
    );
    expect(settings.value.listOrder.find(e => e.id === 'list:doomed')).toBeUndefined();

    await helper.close();
  });
});
