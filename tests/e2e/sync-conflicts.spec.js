import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

// Helper: read entity from session cache via background readCacheable
async function readEntity(helper, key) {
  const resp = await helper.evaluate(async (k) =>
    chrome.runtime.sendMessage({ action: 'readCacheable', key: k })
  , key);
  return resp?.value;
}

test.describe('Sync conflicts — multi-device hydration', () => {
  const PAGE_URL = 'https://example.com/sync-conflict-page';

  // --- Additive fields (per-device timestamp guard) ---

  test('two devices rate same page — both likes counted', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Conflict Page', parentIds: [], childIds: [],
        timestamps: {}, likes: 0,
      }},
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'rate_page', url: PAGE_URL, likes: 1 },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'rate_page', url: PAGE_URL, likes: 1 },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    expect(page.likes).toBe(2);
    expect(page.timestamps['dev-a']).toBeTruthy();
    expect(page.timestamps['dev-b']).toBeTruthy();

    await helper.close();
  });

  test('same device rate_page replayed twice — idempotent (likes === 1)', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Idempotent Page', parentIds: [], childIds: [],
        timestamps: {}, likes: 0,
      }},
      // Same device, same timestamp — second entry should be a no-op
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'rate_page', url: PAGE_URL, likes: 1 },
        { timestamp: 100, action: 'rate_page', url: PAGE_URL, likes: 1 },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    expect(page.likes).toBe(1);

    await helper.close();
  });

  test('two devices add timeOnPage — both counted', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Time Page', parentIds: [], childIds: [],
        timestamps: {}, timeOnPage: 0,
      }},
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'leave_page', url: PAGE_URL, timeOnPage: 5000 },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'leave_page', url: PAGE_URL, timeOnPage: 3000 },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    expect(page.timeOnPage).toBe(8000);
    expect(page.timestamps['dev-a']).toBeTruthy();
    expect(page.timestamps['dev-b']).toBeTruthy();

    await helper.close();
  });

  // --- Note edit conflict (both survive) ---

  test('two devices edit same note — both new notes linked to page', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const oldNoteSlug = 'note-original';
    const newNoteA = 'note-edit-a';
    const newNoteB = 'note-edit-b';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Note Page', parentIds: [],
        childIds: [`note:${oldNoteSlug}`], timestamps: {},
      }},
      // Original note on disk
      { path: `data/notes/${oldNoteSlug}.json`, data: {
        slug: oldNoteSlug, excerpt: 'original', note: 'text', cssPath: 'p', url: PAGE_URL,
      }},
      // Two new note files (written by each device's sync push)
      { path: `data/notes/${newNoteA}.json`, data: {
        slug: newNoteA, excerpt: 'edit A', note: 'from device A', cssPath: 'p', url: PAGE_URL,
      }},
      { path: `data/notes/${newNoteB}.json`, data: {
        slug: newNoteB, excerpt: 'edit B', note: 'from device B', cssPath: 'p', url: PAGE_URL,
      }},
      // Device A replaces X→A, Device B replaces X→B
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'replace_note', url: PAGE_URL,
          oldPath: `notes/${oldNoteSlug}.json`, path: `notes/${newNoteA}.json` },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'replace_note', url: PAGE_URL,
          oldPath: `notes/${oldNoteSlug}.json`, path: `notes/${newNoteB}.json` },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    // Both new notes should be linked to the page
    expect(page.childIds).toContain(`note:${newNoteA}`);
    expect(page.childIds).toContain(`note:${newNoteB}`);
    // Old note should be unlinked
    expect(page.childIds).not.toContain(`note:${oldNoteSlug}`);

    // Old note should be orphaned
    const orphaned = await readEntity(helper, 'manifest:orphaned');
    const orphanKeys = (orphaned?.entries || []).map(e => e.key);
    expect(orphanKeys).toContain(`note:${oldNoteSlug}`);

    await helper.close();
  });

  // --- Note delete/restore LWW ---

  test('delete vs restore note — restore newer wins', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = 'note-lww-restore';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'LWW Page', parentIds: [],
        childIds: [`note:${noteSlug}`], timestamps: {},
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'keep me', note: '', cssPath: 'p', url: PAGE_URL,
      }},
      { path: 'manifest/orphaned.json', data: { timestamps: {}, entries: [] } },
      // Device A deletes (ts=100), Device B restores (ts=200) — restore wins
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'delete_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'restore_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const note = await readEntity(helper, `note:${noteSlug}`);

    expect(note).toBeTruthy();
    expect(note.deleted).toBe(false);
    expect(note.deletedTs).toBe(200);

    // Note should still be linked to page
    const page = await readEntity(helper, `page:${slug}`);
    expect(page.childIds).toContain(`note:${noteSlug}`);

    await helper.close();
  });

  test('delete vs restore note — delete newer wins', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const noteSlug = 'note-lww-delete';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'LWW Page', parentIds: [],
        childIds: [`note:${noteSlug}`], timestamps: {},
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'delete me', note: '', cssPath: 'p', url: PAGE_URL,
      }},
      { path: 'manifest/orphaned.json', data: { timestamps: {}, entries: [] } },
      // Device A restores (ts=100), Device B deletes (ts=200) — delete wins
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'restore_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'delete_note', url: PAGE_URL, path: `notes/${noteSlug}.json` },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // readCacheable filters deleted entities (returns null), so verify via side-effects:
    // 1. Note should NOT be readable (deleted)
    const note = await readEntity(helper, `note:${noteSlug}`);
    expect(note).toBeNull();

    // 2. Note should be unlinked from page childIds
    const page = await readEntity(helper, `page:${slug}`);
    expect(page?.childIds || []).not.toContain(`note:${noteSlug}`);

    // 3. Note should be in orphaned manifest
    const orphaned = await readEntity(helper, 'manifest:orphaned');
    const orphanKeys = (orphaned?.entries || []).map(e => e.key);
    expect(orphanKeys).toContain(`note:${noteSlug}`);

    await helper.close();
  });

  // --- List delete/restore LWW ---

  test('delete vs restore list — restore newer wins', async ({ extContext, extensionId, setupDir }) => {
    const listId = 'lww-restore-list';
    const listName = 'Restore List';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: listName, owner: 'dev-local', timestamps: {},
        pins: [], deleted: true, deletedTs: 50,
      }},
      { path: 'manifest/list-order.json', data: { timestamps: {}, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamps: {}, paths: {} } },
      { path: 'manifest/orphaned.json', data: {
        timestamps: {}, entries: [{ key: `list:${listId}` }],
      }},
      // Device A deletes (ts=100), Device B restores (ts=200) — restore wins
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'delete_list', name: listName, listOwner: 'dev-local' },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'restore_list', name: listName, listOwner: 'dev-local' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const list = await readEntity(helper, `list:${listId}`);

    expect(list).toBeTruthy();
    expect(list.deleted).toBe(false);
    expect(list.deletedTs).toBe(200);

    // List should be in tree manifest
    const tree = await readEntity(helper, 'manifest:list-order');
    const treeIds = JSON.stringify(tree?.tree || []);
    expect(treeIds).toContain(`list:${listId}`);

    await helper.close();
  });

  test('delete vs restore list — delete newer wins', async ({ extContext, extensionId, setupDir }) => {
    const listId = 'lww-delete-list';
    const listName = 'Delete List';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: listName, owner: 'dev-local', timestamps: {},
        pins: [],
      }},
      { path: 'manifest/list-order.json', data: {
        timestamps: {}, tree: [{ id: `list:${listId}` }],
      }},
      { path: 'manifest/list-name-to-id.json', data: {
        timestamps: {}, paths: { [`dev-local/${listName}`]: listId },
      }},
      { path: 'manifest/orphaned.json', data: { timestamps: {}, entries: [] } },
      // Device A restores (ts=100), Device B deletes (ts=200) — delete wins
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'restore_list', name: listName, listOwner: 'dev-local' },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'delete_list', name: listName, listOwner: 'dev-local' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // readCacheable filters deleted entities, so verify via side-effects:
    // 1. List should NOT be readable (deleted)
    const list = await readEntity(helper, `list:${listId}`);
    expect(list).toBeNull();

    // 2. List should NOT be in tree manifest
    const tree = await readEntity(helper, 'manifest:list-order');
    const treeJson = JSON.stringify(tree?.tree || []);
    expect(treeJson).not.toContain(`list:${listId}`);

    // 3. List should be in orphaned manifest
    const orphaned = await readEntity(helper, 'manifest:orphaned');
    const orphanKeys = (orphaned?.entries || []).map(e => e.key);
    expect(orphanKeys).toContain(`list:${listId}`);

    await helper.close();
  });

  // --- Pin to deleted list ---

  test('pin to deleted list — pin preserved, visible after restore', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const listId = 'deleted-pin-list';
    const listName = 'Pin Target';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Pinned Page', parentIds: [], childIds: [],
        timestamps: {},
      }},
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: listName, owner: 'dev-local', timestamps: {},
        pins: [], deleted: true, deletedTs: 50,
      }},
      { path: 'manifest/list-order.json', data: { timestamps: {}, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: {
        timestamps: {}, paths: { [`dev-local/${listName}`]: listId },
      }},
      { path: 'manifest/orphaned.json', data: {
        timestamps: {}, entries: [{ key: `list:${listId}` }],
      }},
      // Remote device: pin a page (ts=200), then restore the list (ts=300)
      { path: 'data/logs/dev-remote/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'pin_to_list', name: listName, listOwner: 'dev-local',
          items: [PAGE_URL] },
        { timestamp: 300, action: 'restore_list', name: listName, listOwner: 'dev-local' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // After restore, list should be readable (no longer deleted)
    const list = await readEntity(helper, `list:${listId}`);
    expect(list).toBeTruthy();
    expect(list.deleted).toBe(false);

    // Pin should be preserved through the delete+pin+restore cycle
    const pinIds = (list.pins || []).map(p => p.id);
    expect(pinIds).toContain(`page:${slug}`);

    await helper.close();
  });

  test('delete + pin + restore (three-way) — list alive with pin', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const listId = 'three-way-list';
    const listName = 'Three Way';

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Three Way Page', parentIds: [], childIds: [],
        timestamps: {},
      }},
      { path: `lists/${listId}.json`, data: {
        slug: listId, name: listName, owner: 'dev-local', timestamps: {},
        pins: [],
      }},
      { path: 'manifest/list-order.json', data: {
        timestamps: {}, tree: [{ id: `list:${listId}` }],
      }},
      { path: 'manifest/list-name-to-id.json', data: {
        timestamps: {}, paths: { [`dev-local/${listName}`]: listId },
      }},
      { path: 'manifest/orphaned.json', data: { timestamps: {}, entries: [] } },
      // Device A: delete (ts=100)
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'delete_list', name: listName, listOwner: 'dev-local' },
      ]},
      // Device B: pin page (ts=200)
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'pin_to_list', name: listName, listOwner: 'dev-local',
          items: [PAGE_URL] },
      ]},
      // Device C: restore (ts=300)
      { path: 'data/logs/dev-c/2026-03-25.jsonl', lines: [
        { timestamp: 300, action: 'restore_list', name: listName, listOwner: 'dev-local' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const list = await readEntity(helper, `list:${listId}`);

    expect(list).toBeTruthy();
    expect(list.deleted).toBe(false);
    expect(list.deletedTs).toBe(300);

    // Pin should survive the delete+restore round-trip
    const pinIds = (list.pins || []).map(p => p.id);
    expect(pinIds).toContain(`page:${slug}`);

    await helper.close();
  });

  // --- Two devices create different lists ---

  test('two devices create different lists — both exist', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: 'manifest/list-order.json', data: { timestamps: {}, tree: [] } },
      { path: 'manifest/list-name-to-id.json', data: { timestamps: {}, paths: {} } },
      // Device A creates "Alpha", Device B creates "Beta"
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'create_list', name: 'Alpha', listOwner: 'dev-a', listId: 'alpha-id' },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'create_list', name: 'Beta', listOwner: 'dev-b', listId: 'beta-id' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Both lists should exist
    const alpha = await readEntity(helper, 'list:alpha-id');
    expect(alpha).toBeTruthy();
    expect(alpha.name).toBe('Alpha');
    expect(alpha.owner).toBe('dev-a');

    const beta = await readEntity(helper, 'list:beta-id');
    expect(beta).toBeTruthy();
    expect(beta.name).toBe('Beta');
    expect(beta.owner).toBe('dev-b');

    // Both should be in the tree
    const tree = await readEntity(helper, 'manifest:list-order');
    const treeJson = JSON.stringify(tree?.tree || []);
    expect(treeJson).toContain('list:alpha-id');
    expect(treeJson).toContain('list:beta-id');

    // Both should be in name-to-id
    const nameToId = await readEntity(helper, 'manifest:name-to-id');
    expect(nameToId.paths['dev-a/Alpha']).toBe('alpha-id');
    expect(nameToId.paths['dev-b/Beta']).toBe('beta-id');

    await helper.close();
  });

  // --- Tree reorganization LWW ---

  test('tree reorganization — newer tree wins via per-device LWW', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: 'lists/aa.json', data: {
        slug: 'aa', name: 'A', owner: 'dev-local', timestamps: {}, pins: [],
      }},
      { path: 'lists/bb.json', data: {
        slug: 'bb', name: 'B', owner: 'dev-local', timestamps: {}, pins: [],
      }},
      { path: 'lists/cc.json', data: {
        slug: 'cc', name: 'C', owner: 'dev-local', timestamps: {}, pins: [],
      }},
      { path: 'manifest/list-order.json', data: {
        timestamps: {}, tree: [{ id: 'list:aa' }, { id: 'list:bb' }, { id: 'list:cc' }],
      }},
      { path: 'manifest/list-name-to-id.json', data: {
        timestamps: {}, paths: {
          'dev-local/A': 'aa', 'dev-local/B': 'bb', 'dev-local/C': 'cc',
        },
      }},
      // Same remote device: two sequential tree updates — second wins (per-device ts guard)
      { path: 'data/logs/dev-remote/2026-03-25.jsonl', lines: [
        // First: A has child B (ts=100)
        { timestamp: 100, action: 'update_list_tree',
          tree: [{ id: 'list:aa', children: [{ id: 'list:bb' }] }, { id: 'list:cc' }] },
        // Second: C has child A (ts=200) — wins
        { timestamp: 200, action: 'update_list_tree',
          tree: [{ id: 'list:cc', children: [{ id: 'list:aa' }] }, { id: 'list:bb' }] },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const tree = await readEntity(helper, 'manifest:list-order');

    // Second tree should win (newer timestamp, same device)
    expect(tree).toBeTruthy();
    const topIds = (tree.tree || []).map(n => n.id);
    expect(topIds).toContain('list:cc');
    expect(topIds).toContain('list:bb');
    // A should be nested under C
    const ccNode = (tree.tree || []).find(n => n.id === 'list:cc');
    expect(ccNode?.children?.map(c => c.id)).toContain('list:aa');

    await helper.close();
  });

  // --- Three peers enrich same page ---

  test('three peers enrich same page — all timestamps present, timeOnPage summed', async ({ extContext, extensionId, setupDir }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url: PAGE_URL, title: 'Multi Peer', parentIds: [], childIds: [],
        timestamps: {}, timeOnPage: 0,
      }},
      { path: 'data/logs/dev-a/2026-03-25.jsonl', lines: [
        { timestamp: 100, action: 'leave_page', url: PAGE_URL, timeOnPage: 2000 },
      ]},
      { path: 'data/logs/dev-b/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'leave_page', url: PAGE_URL, timeOnPage: 3000 },
      ]},
      { path: 'data/logs/dev-c/2026-03-25.jsonl', lines: [
        { timestamp: 300, action: 'leave_page', url: PAGE_URL, timeOnPage: 4000 },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    expect(page.timeOnPage).toBe(9000);
    expect(page.timestamps['dev-a']).toBeTruthy();
    expect(page.timestamps['dev-b']).toBeTruthy();
    expect(page.timestamps['dev-c']).toBeTruthy();

    await helper.close();
  });
});
