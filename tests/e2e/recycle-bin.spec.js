import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Recycle bin', () => {

  // 1. restoreNote re-links note to parent page
  test('restoreNote re-links note to parent page', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260304-restore-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Page with empty childIds (note was unlinked by del_note)
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      // Note file still on disk (deletion doesn't remove files)
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Orphaned note', note: 'Still here', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
      // Orphaned list tracks the deleted note
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the note
    const restoreResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'restoreNote', noteSlug: slug })
    , noteSlug);
    expect(restoreResp.success).toBe(true);

    // Verify page.childIds now contains the note
    const pageResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(pageResp.success).toBe(true);
    expect(pageResp.value.childIds).toContain(`note:${noteSlug}`);

    // Verify orphaned list no longer has the note key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.entries.map(e => e.key)).not.toContain(`note:${noteSlug}`);

    await helper.close();
  });

  // 2. restoreList re-adds to root childLists and restores page parentIds
  test('restoreList re-adds to root childLists and restores page parentIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const listId = 'restore-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: [],  // list was removed from root by del_list
      }},
      // Deleted list entity still on disk with deleted: true
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'My List', timestamp: now,
        pins: [
          { id: `page:${TEST_SLUG}`, pinnedAt: now },
        ],
        deleted: true,
        parentList: 'list:system/root', childLists: [],
      }},
      // Page that lost the list from parentIds
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      // Orphaned list tracks the deleted list
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `list:${listId}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the list
    const restoreResp = await helper.evaluate((id) =>
      chrome.runtime.sendMessage({ action: 'restoreList', listId: id })
    , listId);
    expect(restoreResp.success).toBe(true);

    // Verify root's childLists has the entry back
    const rootResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/root' })
    );
    expect(rootResp.success).toBe(true);
    expect(rootResp.value.childLists).toContain(`list:${listId}`);

    // Verify page parentIds has the list back
    const pageResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(pageResp.success).toBe(true);
    expect(pageResp.value.parentIds).toContain(`list:${listId}`);

    // Verify orphaned list no longer has the list key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.entries.map(e => e.key)).not.toContain(`list:${listId}`);

    // Verify the list entity itself is accessible and no longer deleted
    const listResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `list:${listId}`);
    expect(listResp.success).toBe(true);
    expect(listResp.value).not.toBeNull();
    expect(listResp.value.deleted).toBeFalsy();

    await helper.close();
  });

  // 2b. restoreNote preserves original entity fields (content, childIds, etc.)
  test('restoreNote preserves original entity fields after restore', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260310-restore-fields';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      // Note on disk with original fields + deleted: true
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'My excerpt', note: 'Important content', cssPath: 'div.main > p',
        url: TEST_URL, timestamp: now, deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the note
    const restoreResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'restoreNote', noteSlug: slug })
    , noteSlug);
    expect(restoreResp.success).toBe(true);

    // Verify original fields are preserved (not replaced with blank defaults)
    const noteResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `note:${noteSlug}`);
    expect(noteResp.success).toBe(true);
    expect(noteResp.value.deleted).toBeFalsy();
    expect(noteResp.value.excerpt).toBe('My excerpt');
    expect(noteResp.value.note).toBe('Important content');
    expect(noteResp.value.cssPath).toBe('div.main > p');

    await helper.close();
  });

  // 2c. restoreList preserves original entity fields (childLists, etc.)
  test('restoreList preserves original entity fields after restore', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const listId = 'restore-fields-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: {
        timestamp: now, childLists: [],
      }},
      // Deleted list with rich fields on disk
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'Rich List', timestamp: now,
        pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now }],
        deleted: true,
        parentList: 'list:system/root', childLists: ['list:sub-child'],
      }},
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `list:${listId}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the list
    const restoreResp = await helper.evaluate((id) =>
      chrome.runtime.sendMessage({ action: 'restoreList', listId: id })
    , listId);
    expect(restoreResp.success).toBe(true);

    // Verify original fields are preserved
    const listResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `list:${listId}`);
    expect(listResp.success).toBe(true);
    expect(listResp.value.deleted).toBeFalsy();
    expect(listResp.value.childLists).toContain('list:sub-child');

    await helper.close();
  });

  // 3. permanentDelete removes note file after drain
  test('permanentDelete removes note file after drain', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const noteSlug = '260304-perm-del-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      // Note file on disk
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'To be destroyed', note: 'Gone forever', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
      // A pending log entry to ensure drain is needed
      { path: `data/logs/${today}.jsonl`, lines: [
        { timestamp: now, action: 'visit_page', url: TEST_URL, title: 'Example Domain' },
      ]},
      // Orphaned list tracks the note
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Permanently delete the note
    const delResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'permanentDelete', key })
    , `note:${noteSlug}`);
    expect(delResp.success).toBe(true);

    // Verify note is gone (readCacheable returns null after file deletion)
    const noteResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted: true })
    , `note:${noteSlug}`);
    expect(noteResp.success).toBe(true);
    expect(noteResp.value).toBeNull();

    // Verify orphaned list no longer has the key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.entries.map(e => e.key)).not.toContain(`note:${noteSlug}`);

    await helper.close();
  });

  // 4. permanentDelete removes list file
  test('permanentDelete removes list file', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const listId = 'perm-del-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Deleted list entity on disk
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'Doomed List', timestamp: now,
        pins: [], deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `list:${listId}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Permanently delete the list
    const delResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'permanentDelete', key })
    , `list:${listId}`);
    expect(delResp.success).toBe(true);

    // Verify list entity is gone
    const listResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted: true })
    , `list:${listId}`);
    expect(listResp.success).toBe(true);
    expect(listResp.value).toBeNull();

    // Verify orphaned list no longer has the key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.entries.map(e => e.key)).not.toContain(`list:${listId}`);

    await helper.close();
  });

  // 5. permanentDeleteAll clears all orphaned items
  test('permanentDeleteAll clears all orphaned items', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260304-bulk-note';
    const listId = 'bulk-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Bulk delete', note: 'Gone', cssPath: 'p',
        url: '', timestamp: now,
      }},
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'Bulk List', timestamp: now,
        pins: [], deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }, { key: `list:${listId}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete all orphaned items
    const delResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'permanentDeleteAll' })
    );
    expect(delResp.success).toBe(true);

    // Verify orphaned list is empty
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.entries).toHaveLength(0);

    // Verify files are gone
    const noteResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted: true })
    , `note:${noteSlug}`);
    expect(noteResp.value).toBeNull();

    const listResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key, includeDeleted: true })
    , `list:${listId}`);
    expect(listResp.value).toBeNull();

    await helper.close();
  });

  // 6. Recycle bin UI shows orphaned items with types
  test('recycle bin UI shows orphaned items with type labels', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260304-ui-note';
    const listId = 'ui-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'UI test note', note: 'Visible', cssPath: 'p',
        url: '', timestamp: now,
      }},
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'UI List', timestamp: now,
        pins: [], deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }, { key: `list:${listId}` }],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Click recycle bin sidebar item
    await options.click('#recycleBinBtn');

    // Verify recycle bin layout is visible
    await expect(options.locator('#recycleBinLayout')).toBeVisible({ timeout: 5000 });

    // Verify cards are shown with type labels
    const cards = options.locator('.recycle-card');
    await expect(cards).toHaveCount(2, { timeout: 5000 });

    // Verify type badges
    const badges = options.locator('.entity-type-badge');
    const badgeTexts = await badges.allTextContents();
    expect(badgeTexts.sort()).toEqual(['List', 'Note']);

    await options.close();
  });

  // 7. Restore button in UI removes card
  test('restore button in recycle bin UI removes card and re-links entity', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260304-restore-ui-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Restore me', note: 'Content', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Navigate to recycle bin
    await options.click('#recycleBinBtn');
    await expect(options.locator('#recycleBinLayout')).toBeVisible({ timeout: 5000 });

    // Click restore on the note card
    const restoreBtn = options.locator('.restore-btn').first();
    await expect(restoreBtn).toBeVisible({ timeout: 5000 });
    await restoreBtn.click();

    // Card should disappear
    await expect(options.locator('.recycle-card')).toHaveCount(0, { timeout: 5000 });

    // Verify note is re-linked (via background)
    const pageResp = await options.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    expect(pageResp.value.childIds).toContain(`note:${noteSlug}`);

    await options.close();
  });

  // 8. "Empty Recycle Bin" button clears all
  test('Empty Recycle Bin button clears all cards', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260304-empty-note';
    const listId = 'empty-list';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Empty me', note: 'Gone', cssPath: 'p',
        url: '', timestamp: now,
      }},
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: 'Empty List', timestamp: now,
        pins: [], deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }, { key: `list:${listId}` }],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Navigate to recycle bin
    await options.click('#recycleBinBtn');
    await expect(options.locator('#recycleBinLayout')).toBeVisible({ timeout: 5000 });
    await expect(options.locator('.recycle-card')).toHaveCount(2, { timeout: 5000 });

    // Click "Empty Recycle Bin"
    await options.click('.empty-bin-btn');

    // All cards should disappear
    await expect(options.locator('.recycle-card')).toHaveCount(0, { timeout: 5000 });

    // Verify orphaned list is empty
    const orphanedResp = await options.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    expect(orphanedResp.value.entries).toHaveLength(0);

    await options.close();
  });

  // Noop guard: deleting an already-deleted note does not duplicate orphaned key
  test('deleteNote on already-deleted note is noop — no duplicate orphaned key', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260312-noop-del';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      // Note already deleted (deleted: true on disk)
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Already gone', note: 'Gone', cssPath: 'p',
        url: TEST_URL, timestamp: now, deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the already-deleted note again
    await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);

    // Orphaned list should still have exactly 1 entry (not duplicated)
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:orphaned' })
    );
    const noteKeys = orphanedResp.value.entries.map(e => e.key).filter(k => k === `note:${noteSlug}`);
    expect(noteKeys).toHaveLength(1);

    await helper.close();
  });

  // Dedup: restoring a note whose parent page already has it in childIds should not duplicate
  test('restoreNote does not duplicate note in parent childIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260312-dedup-restore';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Page that already has the note in childIds (simulates inconsistent state)
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      // Note deleted on disk
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Dedup test', note: 'Content', cssPath: 'p',
        url: TEST_URL, timestamp: now, deleted: true,
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: `note:${noteSlug}` }],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the note — linkChild should not duplicate it in parent's childIds
    const restoreResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'restoreNote', noteSlug: slug })
    , noteSlug);
    expect(restoreResp.success).toBe(true);

    // Verify parent page has exactly 1 note ref (not 2)
    const pageResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , `page:${TEST_SLUG}`);
    const noteRefs = pageResp.value.childIds.filter(id => id === `note:${noteSlug}`);
    expect(noteRefs).toHaveLength(1);

    await helper.close();
  });
});
