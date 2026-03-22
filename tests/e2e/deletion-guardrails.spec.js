import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Deletion guardrails', () => {

  // loadPageNotes reads from session cache (where del_note replay removes note refs).
  // After deleteNote action, the page entity in session cache has updated childIds
  // and loadPageNotes should not return the deleted note.
  //
  // NOTE: We call the real deleteNote handler rather than seeding a del_note log
  // entry. Seeding in history files doesn't trigger hydration replay (only logBuffer
  // entries are replayed), and seeding in logBuffer is impractical (cleared by
  // rehydrateForTest). The correct E2E pattern: seed the entity, then call the
  // action handler via sendMessage.
  test('deleted note does not appear in loadPageNotes after deleteNote', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const noteSlug = '260301-guardrail-note';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'To be deleted', note: 'Gone', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the note via the real handler (triggers del_note log + effectOf replay)
    await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);

    // loadPageNotes reads from session cache — del_note replay removed the note ref
    const notesResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'loadPageNotes', slug })
    , TEST_SLUG);
    expect(notesResp.success).toBe(true);
    expect(notesResp.notes.filter(n => n.slug === noteSlug)).toHaveLength(0);

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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Visible note', note: 'Annotation', cssPath: 'p',
        url: TEST_URL, timestamp: now,
      }},
      { path: `data/logs/${today}.jsonl`, lines: [
        { timestamp: now, action: 'visit_page', url: TEST_URL, title: 'Example Domain' },
      ]},
    ]);

    // Open options page — the page should appear in explore
    const options = await openOptionsPage(extContext, extensionId);

    // The page should have a "note" tag in card-extras (from childIds containing note:)
    const noteTag = options.locator('.card-tag-note').first();
    await expect(noteTag).toBeVisible({ timeout: 5000 });

    // Delete the note via background message (simulates deletion from another context)
    await options.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug: slug })
    , noteSlug);

    // The note tag should disappear after the mutation handler refreshes the view.
    await expect(noteTag).toBeHidden({ timeout: 5000 });

    await options.close();
  });

  // Deleted list entity should return null from readCacheable, not stale disk data.
  // Currently sessionWrite calls cacheRemove for deleted entities, so readCacheable
  // falls through to readFs and loads the pre-deletion disk checkpoint.
  test('deleted list entity returns null from readCacheable', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [{ id: 'list:to-delete' }] } },
      { path: 'lists/to-delete.json', data: {
        slug: 'to-delete', name: 'To Delete', timestamp: now, pins: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'To Delete': 'to-delete' } } },
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      // Disk checkpoint already has deleted: true (written by previous drain)
      { path: 'lists/rehydrate-del.json', data: {
        slug: 'rehydrate-del', name: 'Rehydrate Del', timestamp: now,
        pins: [], deleted: true,
      }},
      // Orphaned list tracks it
      { path: 'manifest/orphaned.json', data: {
        timestamp: now, entries: [{ key: 'list:rehydrate-del' }],
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
  // entity or re-add it to the tree manifest via effectOf replay.
  test('pinning to a deleted list does not resurrect it', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const pageUrl = 'https://example.com/pinme';
    const pageSlug = getSlugForUrl(pageUrl);
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: {
        timestamp: now, tree: [{ id: 'list:doomed' }],
      }},
      { path: 'lists/doomed.json', data: {
        slug: 'doomed', name: 'Doomed', timestamp: now, pins: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'Doomed': 'doomed' } } },
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

    // Verify list is removed from tree manifest
    let root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:list-order' })
    );
    expect(root.value.tree.map(n => n.id)).not.toContain('list:doomed');

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

    // tree manifest should still not contain the deleted list
    root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:list-order' })
    );
    expect(root.value.tree.map(n => n.id)).not.toContain('list:doomed');

    await helper.close();
  });
});
