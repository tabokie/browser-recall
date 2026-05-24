import { test, expect } from './fixtures.js';
import crypto from 'crypto';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

function pagePath(slug) {
  const shard = crypto
    .createHash('sha256')
    .update(slug)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `views/pages/${shard}/${slug}.json`;
}

function listPath(slug) {
  return `views/lists/${slug}.json`;
}

function notePath(slug) {
  return `objects/notes/${slug}.json`;
}

function logPath(device, date = '2026-03-25') {
  return `logs/${device}/${date}.jsonl`;
}

// Helper: read entity through the background's Desktop-backed read facade.
async function readEntity(helper, key) {
  const resp = await helper.evaluate(
    async (k) =>
      chrome.runtime.sendMessage({ action: 'readDesktopValue', key: k }),
    key,
  );
  return resp?.value;
}

test.describe('Sync conflicts — multi-device hydration', () => {
  const PAGE_URL = 'https://example.com/sync-conflict-page';

  // --- Additive fields (per-device timestamp guard) ---

  test('two devices rate same page — both likes counted', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { syncEnabled: true } },
      {
        path: pagePath(slug),
        data: {
          slug,
          url: PAGE_URL,
          title: 'Conflict Page',
          parentIds: [],
          childIds: [],
          timestamps: {},
          likes: 0,
        },
      },
      {
        path: logPath('dev-a'),
        lines: [
          {
            timestamp: 1774406400100,
            action: 'rate_page',
            url: PAGE_URL,
            likes: 1,
          },
        ],
      },
      {
        path: logPath('dev-b'),
        lines: [
          {
            timestamp: 1774406400200,
            action: 'rate_page',
            url: PAGE_URL,
            likes: 1,
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await readEntity(helper, `page:${slug}`);

    expect(page).toBeTruthy();
    expect(page.likes).toBe(2);
    expect(page.timestamps['dev-a']).toBeTruthy();
    expect(page.timestamps['dev-b']).toBeTruthy();

    await helper.close();
  });

  // --- Note delete/restore LWW ---

  // --- Pin to deleted list ---

  test('pin to deleted list — pin preserved, visible after restore', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const slug = getSlugForUrl(PAGE_URL);
    const listId = 'deleted-pin-list';
    const listName = 'Pin Target';

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { syncEnabled: true } },
      {
        path: pagePath(slug),
        data: {
          slug,
          url: PAGE_URL,
          title: 'Pinned Page',
          parentIds: [],
          childIds: [],
          timestamps: {},
        },
      },
      {
        path: listPath(listId),
        data: {
          slug: listId,
          name: listName,
          owner: 'dev-local',
          timestamps: {},
          pins: [],
          deleted: true,
          deletedTs: 1774406400050,
        },
      },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamps: {}, tree: [] },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamps: {},
          paths: { [`dev-local/${listName}`]: listId },
        },
      },
      {
        path: 'views/manifest/orphaned.json',
        data: {
          timestamps: {},
          entries: [{ key: `list:${listId}` }],
        },
      },
      // Remote device: pin a page (ts=200), then restore the list (ts=300)
      {
        path: logPath('dev-remote'),
        lines: [
          {
            timestamp: 1774406400200,
            action: 'pin_to_list',
            name: listName,
            listOwner: 'dev-local',
            urls: [PAGE_URL],
          },
          {
            timestamp: 1774406400300,
            action: 'restore_list',
            name: listName,
            listOwner: 'dev-local',
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // After restore, list should be readable (no longer deleted)
    const list = await readEntity(helper, `list:${listId}`);
    expect(list).toBeTruthy();
    expect(list.deleted).toBeFalsy();

    // Pin should be preserved through the delete+pin+restore cycle
    const pinIds = (list.pins || []).map((p) => p.id);
    expect(pinIds).toContain(`page:${slug}`);

    await helper.close();
  });
});
