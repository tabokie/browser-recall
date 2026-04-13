import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

const LOCAL_DEVICE = 'test-dev';
const REMOTE_DEVICE = 'remote-1';
const REMOTE_DEVICE_2 = 'remote-2';

function baseSeed(now) {
  return [
    { path: 'CURRENT', content: LOCAL_DEVICE },
    { path: 'manifest/settings.json', data: { trimRules: [] } },
    { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
    {
      path: 'manifest/list-name-to-id.json',
      data: { timestamp: now, paths: {} },
    },
  ];
}

// Seed an import directory (OPFS) with test files and store its handle in IndexedDB.
async function seedImportDir(helper, files) {
  const resp = await helper.evaluate(
    (f) =>
      chrome.runtime.sendMessage({ action: 'seedImportDirectory', files: f }),
    files,
  );
  if (!resp?.success)
    throw new Error('seedImportDirectory failed: ' + JSON.stringify(resp));
}

// Trigger import via port channel from the helper page.
// Returns the final 'done' or 'error' message.
async function importViaPort(helper) {
  return helper.evaluate(() => {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'import-directory' });
      port.onMessage.addListener((msg) => {
        if (msg.type === 'done' || msg.type === 'error') {
          resolve(msg);
        }
      });
      port.postMessage({ action: 'importDirectory' });
      setTimeout(() => reject(new Error('Import timed out')), 15000);
    });
  });
}

// Read a session-cached entity via background readCacheable.
async function readEntity(helper, key) {
  const resp = await helper.evaluate(
    (k) => chrome.runtime.sendMessage({ action: 'readCacheable', key: k }),
    key,
  );
  return resp?.value;
}

test.describe('Import from directory', () => {
  test('imports a single remote device', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/imported-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    await seedImportDir(helper, [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url,
            title: 'Imported Page',
            checkpoint: true,
          },
        ],
      },
    ]);

    const result = await importViaPort(helper);

    expect(result.type).toBe('done');
    expect(result.entriesReplayed).toBe(1);
    expect(result.deviceCount).toBe(1);
    expect(result.logFiles).toBe(1);

    const page = await readEntity(helper, `page:${slug}`);
    expect(page).toBeTruthy();
    expect(page.title).toBe('Imported Page');
    expect(page.timestamps?.[REMOTE_DEVICE]).toBeTruthy();

    await helper.close();
  });

  test('imports multiple remote devices', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url1 = 'https://example.com/page-from-dev1';
    const url2 = 'https://example.com/page-from-dev2';

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    await seedImportDir(helper, [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url: url1,
            title: 'Page from Dev1',
            checkpoint: true,
          },
        ],
      },
      {
        path: `data/logs/${REMOTE_DEVICE_2}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 2000,
            action: 'visit_page',
            url: url2,
            title: 'Page from Dev2',
            checkpoint: true,
          },
        ],
      },
    ]);

    const result = await importViaPort(helper);

    expect(result.type).toBe('done');
    expect(result.deviceCount).toBe(2);
    expect(result.entriesReplayed).toBe(2);

    const page1 = await readEntity(helper, `page:${getSlugForUrl(url1)}`);
    const page2 = await readEntity(helper, `page:${getSlugForUrl(url2)}`);
    expect(page1?.title).toBe('Page from Dev1');
    expect(page2?.title).toBe('Page from Dev2');

    await helper.close();
  });

  test('excludes local device logs from import', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const localUrl = 'https://example.com/local-only';
    const remoteUrl = 'https://example.com/remote-only';

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    // Import dir contains logs for both local device and a remote device.
    // Only the remote device's entries should be replayed.
    await seedImportDir(helper, [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${LOCAL_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url: localUrl,
            title: 'Local Page',
            checkpoint: true,
          },
        ],
      },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 2000,
            action: 'visit_page',
            url: remoteUrl,
            title: 'Remote Page',
            checkpoint: true,
          },
        ],
      },
    ]);

    const result = await importViaPort(helper);

    expect(result.type).toBe('done');
    expect(result.deviceCount).toBe(1);
    expect(result.entriesReplayed).toBe(1);
    expect(result.logFiles).toBe(1);

    // Remote page should exist
    const remotePage = await readEntity(
      helper,
      `page:${getSlugForUrl(remoteUrl)}`,
    );
    expect(remotePage?.title).toBe('Remote Page');

    // Local page should NOT have been imported (its log was filtered out)
    const localPage = await readEntity(
      helper,
      `page:${getSlugForUrl(localUrl)}`,
    );
    expect(localPage).toBeFalsy();

    await helper.close();
  });

  test('imports notes', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/noted-page';
    const slug = getSlugForUrl(url);
    const noteSlug = 'test-note-slug';

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    await seedImportDir(helper, [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url,
            title: 'Noted Page',
            checkpoint: true,
          },
          {
            timestamp: 2000,
            action: 'create_note',
            url,
            path: `notes/${noteSlug}.json`,
          },
        ],
      },
      {
        path: `data/notes/${noteSlug}.json`,
        data: {
          slug: noteSlug,
          url,
          text: 'A test highlight note',
          color: '#ffe066',
          anchor: { text: 'highlighted text' },
          createdAt: 2000,
        },
      },
    ]);

    const result = await importViaPort(helper);

    expect(result.type).toBe('done');
    expect(result.noteFiles).toBe(1);

    // Page should have the note in childIds
    const page = await readEntity(helper, `page:${slug}`);
    expect(page).toBeTruthy();
    expect(page.childIds).toContain(`note:${noteSlug}`);

    await helper.close();
  });

  test('imports snapshots', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const url = 'https://example.com/snapped-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    await seedImportDir(helper, [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url,
            title: 'Snapped Page',
            checkpoint: true,
          },
          {
            timestamp: 2000,
            action: 'create_snapshot',
            url,
            path: `snapshots/${slug}-2000`,
          },
        ],
      },
      {
        path: `data/snapshots/${slug}-2000.md`,
        content: '# Snapshot content',
      },
    ]);

    const result = await importViaPort(helper);

    expect(result.type).toBe('done');
    expect(result.snapshotFiles).toBe(1);

    // Page should reference the snapshot in childIds
    const page = await readEntity(helper, `page:${slug}`);
    expect(page).toBeTruthy();
    expect(page.childIds).toContain(`snapshot:${slug}-2000`);

    // Verify snapshot file exists via listSnapshots
    const snapsResp = await helper.evaluate(
      (s) => chrome.runtime.sendMessage({ action: 'listSnapshots', slug: s }),
      slug,
    );
    expect(snapsResp?.success).toBe(true);
    expect(snapsResp.snapshots.length).toBe(1);

    await helper.close();
  });

  test('idempotent re-import produces no duplication', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    const url = 'https://example.com/idem-page';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const helper = await openHelperPage(extContext, extensionId);

    const importFiles = [
      { path: 'CURRENT', content: REMOTE_DEVICE },
      {
        path: `data/logs/${REMOTE_DEVICE}/2026-01-01.jsonl`,
        lines: [
          {
            timestamp: 1000,
            action: 'visit_page',
            url,
            title: 'Idem Page',
            checkpoint: true,
          },
          { timestamp: 2000, action: 'rate_page', url, likes: 1 },
        ],
      },
    ];

    // First import
    await seedImportDir(helper, importFiles);
    const result1 = await importViaPort(helper);
    expect(result1.type).toBe('done');
    expect(result1.entriesReplayed).toBe(2);

    const pageAfter1 = await readEntity(helper, `page:${slug}`);
    expect(pageAfter1.likes).toBe(1);

    // Second import — same data
    await seedImportDir(helper, importFiles);
    const result2 = await importViaPort(helper);
    expect(result2.type).toBe('done');

    // Per-device timestamp guards make replay idempotent
    const pageAfter2 = await readEntity(helper, `page:${slug}`);
    expect(pageAfter2.likes).toBe(1); // still 1, not 2
    expect(pageAfter2.timestamps?.[REMOTE_DEVICE]).toBeTruthy();

    await helper.close();
  });
});
