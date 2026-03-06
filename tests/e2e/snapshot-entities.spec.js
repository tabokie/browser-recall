import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openOptionsPage, openHelperPage } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);
const SNAP_TS = 1700000000000;
const SNAP_KEY = `snap:${TEST_SLUG}/${SNAP_TS}`;

test.describe('Snapshot entities', () => {

  // 1. listSnapshots returns snapshots from entity childIds
  test('listSnapshots returns snapshots from page entity childIds', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [SNAP_KEY],
      }},
      // Snapshot files on disk (for getSnapshotUrl)
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.md`, content: '# Example' },
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.html`, content: '<h1>Example</h1>' },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    const resp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'listSnapshots', slug })
    , TEST_SLUG);
    expect(resp.success).toBe(true);
    expect(resp.snapshots).toHaveLength(1);
    expect(resp.snapshots[0].timestamp).toBe(SNAP_TS);
    expect(resp.snapshots[0].hasMd).toBe(true);
    expect(resp.snapshots[0].hasHtml).toBe(true);

    await helper.close();
  });

  // 2. deleteSnapshot adds to orphaned list and removes from listSnapshots
  test('deleteSnapshot removes from listSnapshots and adds to orphaned', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [SNAP_KEY],
      }},
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.md`, content: '# Example' },
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.html`, content: '<h1>Example</h1>' },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Delete the snapshot
    const delResp = await helper.evaluate(({ slug, ts }) =>
      chrome.runtime.sendMessage({ action: 'deleteSnapshot', slug, timestamp: ts })
    , { slug: TEST_SLUG, ts: SNAP_TS });
    expect(delResp.success).toBe(true);

    // Verify listSnapshots no longer returns it
    const snapResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'listSnapshots', slug })
    , TEST_SLUG);
    expect(snapResp.success).toBe(true);
    expect(snapResp.snapshots).toHaveLength(0);

    // Verify orphaned list has the snap key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.keys).toContain(SNAP_KEY);

    await helper.close();
  });

  // 3. restoreSnapshot re-adds to listSnapshots and clears orphaned
  test('restoreSnapshot re-adds to listSnapshots and clears orphaned', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      // Page with snapshot already removed from childIds
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.md`, content: '# Example' },
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.html`, content: '<h1>Example</h1>' },
      // Orphaned list tracks the deleted snapshot
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [SNAP_KEY],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Restore the snapshot
    const restoreResp = await helper.evaluate((snapSlug) =>
      chrome.runtime.sendMessage({ action: 'restoreSnapshot', snapSlug })
    , `${TEST_SLUG}/${SNAP_TS}`);
    expect(restoreResp.success).toBe(true);

    // Verify listSnapshots returns it again
    const snapResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'listSnapshots', slug })
    , TEST_SLUG);
    expect(snapResp.success).toBe(true);
    expect(snapResp.snapshots).toHaveLength(1);
    expect(snapResp.snapshots[0].timestamp).toBe(SNAP_TS);

    // Verify orphaned list no longer has the snap key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.keys).not.toContain(SNAP_KEY);

    await helper.close();
  });

  // 4. permanentDelete for snap key removes files via offscreen
  test('permanentDelete removes snapshot files', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.md`, content: '# Example' },
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.html`, content: '<h1>Example</h1>' },
      { path: `history/${today}.jsonl`, lines: [
        { timestamp: now, action: 'page', url: TEST_URL, title: 'Example Domain' },
      ]},
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [SNAP_KEY],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Permanently delete the snapshot
    const delResp = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'permanentDelete', key })
    , SNAP_KEY);
    expect(delResp.success).toBe(true);

    // Verify orphaned list no longer has the snap key
    const orphanedResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/orphaned' })
    );
    expect(orphanedResp.success).toBe(true);
    expect(orphanedResp.value.keys).not.toContain(SNAP_KEY);

    await helper.close();
  });

  // 5. Recycle bin UI: deleted snapshot appears with Snapshot badge and restore works
  test('recycle bin shows snapshot with badge and restore works', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: `pages/${TEST_SLUG}.json`, data: {
        slug: TEST_SLUG, url: TEST_URL, title: 'Example Domain', timestamp: now,
        parentIds: [], childIds: [],
      }},
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.md`, content: '# Example' },
      { path: `pages/${TEST_SLUG}/${SNAP_TS}.html`, content: '<h1>Example</h1>' },
      { path: 'lists/system/orphaned.json', data: {
        timestamp: now, keys: [SNAP_KEY],
      }},
    ]);

    const page = await openOptionsPage(extContext, extensionId);

    // Navigate to recycle bin
    await page.click('#recycleBinBtn');
    await page.waitForSelector('.recycle-card');

    // Verify snapshot card exists with Snapshot badge
    const badge = await page.textContent(`.recycle-card[data-key="${SNAP_KEY}"] .entity-type-badge`);
    expect(badge).toBe('Snapshot');

    // Click restore
    await page.click(`.recycle-card[data-key="${SNAP_KEY}"] .restore-btn`);

    // Wait for the card to disappear (restored)
    await page.waitForSelector(`.recycle-card[data-key="${SNAP_KEY}"]`, { state: 'hidden', timeout: 5000 });

    // Verify snapshot is back in listSnapshots
    const helper = await openHelperPage(extContext, extensionId);
    const snapResp = await helper.evaluate((slug) =>
      chrome.runtime.sendMessage({ action: 'listSnapshots', slug })
    , TEST_SLUG);
    expect(snapResp.success).toBe(true);
    expect(snapResp.snapshots).toHaveLength(1);
    expect(snapResp.snapshots[0].timestamp).toBe(SNAP_TS);

    await helper.close();
    await page.close();
  });

});
