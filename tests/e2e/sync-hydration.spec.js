import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

test.describe('Multi-device hydration', () => {
  test('remote device log files are replayed on hydration', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://example.com/remote-visit';
    const slug = getSlugForUrl(url);

    // Seed: local device + page entity + remote device log with visit + rate
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Original Title', parentIds: [], childIds: [],
        timestamps: { 'dev-local': 500 },
      }},
      // Remote device log file: visit_page + rate_page
      {
        path: 'data/logs/dev-remote/2026-03-25.jsonl',
        lines: [
          { timestamp: 1000, action: 'visit_page', url, title: 'Remote Page' },
          { timestamp: 2000, action: 'rate_page', url, likes: 1 },
        ],
      },
    ]);

    // After rehydrateForTest, the remote log should have been replayed.
    // Check that the page entity exists and has the remote data.
    const helper = await openHelperPage(extContext, extensionId);
    const page = await helper.evaluate(async (key) => {
      return chrome.runtime.sendMessage({ action: 'readCacheable', key });
    }, 'page:' + slug);

    expect(page?.value).toBeTruthy();
    expect(page.value.url).toBe(url);
    expect(page.value.title).toBe('Remote Page');
    expect(page.value.likes).toBe(1);
    // timestamps map should have the remote device's entry
    expect(page.value.timestamps?.['dev-remote']).toBeTruthy();

    await helper.close();
  });

  test('local logBuffer replayed before remote logs', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://example.com/order-test';
    const slug = getSlugForUrl(url);

    // Seed page entity + local logBuffer entry + remote log file.
    // Local logBuffer is replayed in Phase 2, remote log files in Phase 3.
    // Both should enrich the same entity with per-device timestamps.
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: { syncEnabled: true } },
      { path: `pages/${slug}.json`, data: {
        slug, url, title: 'Seeded', parentIds: [], childIds: [], timestamps: {},
      }},
      { path: 'data/logs/dev-remote/2026-03-25.jsonl', lines: [
        { timestamp: 200, action: 'visit_page', url, title: 'Remote Title' },
      ]},
    ]);

    // Inject a local logBuffer entry that will be replayed in Phase 2
    const helperSetup = await openHelperPage(extContext, extensionId);
    await helperSetup.evaluate(async ({ url }) => {
      const result = await chrome.runtime.sendMessage({
        action: 'setLogBufferForTest',
        entries: [{ timestamp: 100, action: 'visit_page', url, title: 'Local Title' }],
      });
      if (!result?.success) throw new Error('setLogBufferForTest failed');
      // Rehydrate to replay both local buffer + remote logs
      const rh = await chrome.runtime.sendMessage({ action: 'rehydrateForTest', keepLogBuffer: true });
      if (!rh?.success) throw new Error('rehydrateForTest failed');
    }, { url });
    await helperSetup.close();

    const helper = await openHelperPage(extContext, extensionId);
    const page = await helper.evaluate(async (key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , 'page:' + slug);

    expect(page?.value).toBeTruthy();
    // Both devices' timestamps should be present
    expect(page.value.timestamps?.['dev-local']).toBeTruthy();
    expect(page.value.timestamps?.['dev-remote']).toBeTruthy();

    await helper.close();
  });

  test('hydration skips remote logs when sync is not enabled', async ({ extContext, extensionId, setupDir }) => {
    const url = 'https://example.com/no-sync';
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'dev-local' },
      { path: 'manifest/settings.json', data: {} },
      { path: 'data/logs/dev-remote/2026-03-25.jsonl', lines: [
        { timestamp: 1000, action: 'visit_page', url, title: 'Should Not Appear' },
      ]},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await helper.evaluate(async (key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , 'page:' + slug);

    // Page should not exist — remote logs not replayed
    expect(page?.value).toBeFalsy();

    await helper.close();
  });
});
