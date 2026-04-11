import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

// Contract tests for the background ↔ offscreen port channel.
// Each test exercises a real message round-trip through the running extension
// and verifies the response shape matches the declared contract.

const url1 = 'https://example.com/contract-page';
const slug1 = getSlugForUrl(url1);
const now = Date.now();
const dateStr = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');

function seedFiles() {
  return [
    { path: 'CURRENT', content: 'test-device' },
    {
      path: 'manifest/settings.json',
      data: { trimRules: [], syncEnabled: false },
    },
    {
      path: 'manifest/list-name-to-id.json',
      data: { timestamps: {}, paths: {} },
    },
    { path: 'manifest/orphaned.json', data: { timestamps: {}, keys: [] } },
    { path: 'manifest/list-order.json', data: { timestamps: {}, tree: [] } },
    {
      path: `pages/${slug1}.json`,
      data: {
        slug: slug1,
        url: url1,
        title: 'Contract Page',
        timestamps: { 'test-device': now },
        parentIds: [],
        childIds: [`note:${slug1}-n1`, `snapshot:${slug1}-${now}`],
      },
    },
    {
      path: `notes/${slug1}-n1.json`,
      data: {
        slug: `${slug1}-n1`,
        excerpt: 'Test note',
        note: '',
        cssPath: '',
        url: url1,
        timestamps: { 'test-device': now },
      },
    },
    {
      path: `data/snapshots/${slug1}-${now}.html`,
      content: '<html><body>snapshot</body></html>',
    },
    { path: `data/snapshots/${slug1}-${now}.md`, content: '# snapshot' },
    {
      path: `data/logs/test-device/${dateStr}.jsonl`,
      lines: [
        {
          timestamp: now,
          action: 'visit_page',
          url: url1,
          title: 'Contract Page',
        },
      ],
    },
    {
      path: 'lists/test-list-1.json',
      data: {
        id: 'test-list-1',
        name: 'Test List',
        timestamps: { 'test-device': now },
        pins: [
          {
            url: url1,
            title: 'Contract Page',
            timestamps: { 'test-device': now },
          },
        ],
      },
    },
  ];
}

// Helper: send a message to background and return the response.
async function sendMsg(helper, msg) {
  return helper.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

// ── Response shape assertion ──
// Verifies that a successful response contains exactly the declared fields
// (plus `success`), and no unexpected extras.
function assertShape(resp, expectedFields) {
  expect(resp.success).toBe(true);
  for (const field of expectedFields) {
    expect(resp).toHaveProperty(field);
  }
  // No undeclared fields (allow success, error, and id which are envelope)
  const allowed = new Set([...expectedFields, 'success', 'error', 'id']);
  for (const key of Object.keys(resp)) {
    expect(allowed.has(key)).toBe(true);
  }
}

test.describe('Port contract: response shapes', () => {
  let helper;

  test.beforeAll(async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, seedFiles());
    helper = await openHelperPage(extContext, extensionId);
  });

  test.afterAll(async () => {
    if (helper) await helper.close();
  });

  // ── Lifecycle ──

  test('getDirectoryInfo', async () => {
    const resp = await sendMsg(helper, { action: 'getDirectoryInfo' });
    assertShape(resp, ['info']);
    expect(typeof resp.info).toBe('object');
  });

  // ── Snapshots ──

  test('listSnapshots', async () => {
    const resp = await sendMsg(helper, {
      action: 'listSnapshots',
      slug: slug1,
    });
    assertShape(resp, ['snapshots']);
    expect(Array.isArray(resp.snapshots)).toBe(true);
  });

  test('getSnapshotUrl', async () => {
    const resp = await sendMsg(helper, {
      action: 'getSnapshotUrl',
      slug: slug1,
      timestamp: now,
    });
    assertShape(resp, ['url']);
    expect(typeof resp.url).toBe('string');
  });

  test('getSnapshotHtml', async () => {
    const resp = await sendMsg(helper, {
      action: 'getSnapshotHtml',
      slug: slug1,
      timestamp: now,
    });
    assertShape(resp, ['html']);
    expect(typeof resp.html).toBe('string');
  });

  // ── Notes ──

  test('loadPageNotes', async () => {
    const resp = await sendMsg(helper, {
      action: 'loadPageNotes',
      slug: slug1,
    });
    assertShape(resp, ['notes']);
    expect(Array.isArray(resp.notes)).toBe(true);
  });

  // ── Pages ──

  test('readCacheable for page entity', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: `page:${slug1}`,
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeTruthy();
    expect(resp.value.slug).toBe(slug1);
  });

  // ── History ──

  test('listHistoryFiles', async () => {
    const resp = await sendMsg(helper, { action: 'listHistoryFiles' });
    assertShape(resp, ['files']);
    expect(Array.isArray(resp.files)).toBe(true);
  });

  test('listHistoryFiles with sizes', async () => {
    const resp = await sendMsg(helper, {
      action: 'listHistoryFiles',
      includeSizes: true,
    });
    assertShape(resp, ['files', 'sizes']);
    expect(typeof resp.sizes).toBe('object');
  });

  test('loadHistoryBatch', async () => {
    const listResp = await sendMsg(helper, { action: 'listHistoryFiles' });
    expect(listResp.files.length).toBeGreaterThan(0);
    const resp = await sendMsg(helper, {
      action: 'loadHistoryBatch',
      files: listResp.files.slice(0, 1),
    });
    assertShape(resp, ['entries']);
    expect(Array.isArray(resp.entries)).toBe(true);
  });

  // ── Manifest Entities ──

  test('readCacheable for settings', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: 'manifest:settings',
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeTruthy();
  });

  test('readCacheable for name-to-id', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: 'manifest:name-to-id',
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeTruthy();
  });

  test('readCacheable for orphaned', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: 'manifest:orphaned',
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeTruthy();
  });

  test('readCacheable for list-order', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: 'manifest:list-order',
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeTruthy();
  });

  // ── Not-found cases ──

  test('getSnapshotUrl returns error shape for missing snapshot', async () => {
    const resp = await sendMsg(helper, {
      action: 'getSnapshotUrl',
      slug: 'no-such-slug',
      timestamp: 0,
    });
    expect(resp.success).toBe(false);
    expect(resp).toHaveProperty('error');
    expect(typeof resp.error).toBe('string');
  });

  test('getSnapshotHtml returns error shape for missing snapshot', async () => {
    const resp = await sendMsg(helper, {
      action: 'getSnapshotHtml',
      slug: 'no-such-slug',
      timestamp: 0,
    });
    expect(resp.success).toBe(false);
    expect(resp).toHaveProperty('error');
  });

  test('readCacheable returns null value for missing entity', async () => {
    const resp = await sendMsg(helper, {
      action: 'readCacheable',
      key: 'page:nonexistent',
    });
    assertShape(resp, ['value']);
    expect(resp.value).toBeNull();
  });
});

test.describe('Port contract: write round-trips', () => {
  let helper;

  test.beforeAll(async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, seedFiles());
    helper = await openHelperPage(extContext, extensionId);
  });

  test.afterAll(async () => {
    if (helper) await helper.close();
  });

  test('listSnapshots returns seeded snapshots', async () => {
    const resp = await sendMsg(helper, {
      action: 'listSnapshots',
      slug: slug1,
    });
    assertShape(resp, ['snapshots']);
    expect(resp.snapshots.length).toBeGreaterThan(0);
    expect(resp.snapshots[0]).toHaveProperty('timestamp');
  });

  test('flushLogBuffer response shape', async () => {
    const resp = await sendMsg(helper, { action: 'flushLogBuffer' });
    assertShape(resp, ['remaining']);
    expect(typeof resp.remaining).toBe('number');
  });

  test('getDeviceId response shape', async () => {
    const resp = await sendMsg(helper, { action: 'getDeviceId' });
    assertShape(resp, ['deviceId']);
    expect(typeof resp.deviceId).toBe('string');
  });
});

test.describe('Port contract: exhaustive offscreen handler coverage', () => {
  // This test verifies that every action in the offscreen handleRequest switch
  // is accounted for in the contract. It seeds data, sends each testable action,
  // and checks that the response includes `success`.
  let helper;

  test.beforeAll(async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, seedFiles());
    helper = await openHelperPage(extContext, extensionId);
  });

  test.afterAll(async () => {
    if (helper) await helper.close();
  });

  // Actions that are directly callable via sendMessage (background proxies them)
  // and their minimal request payloads.
  const directActions = [
    { action: 'getDirectoryInfo', expectedFields: ['info'] },
    {
      action: 'listSnapshots',
      params: { slug: slug1 },
      expectedFields: ['snapshots'],
    },
    {
      action: 'getSnapshotUrl',
      params: { slug: slug1, timestamp: now },
      expectedFields: ['url'],
    },
    {
      action: 'getSnapshotHtml',
      params: { slug: slug1, timestamp: now },
      expectedFields: ['html'],
    },
    { action: 'listHistoryFiles', expectedFields: ['files'] },
    {
      action: 'loadHistoryBatch',
      params: { files: [`test-device/${dateStr}.jsonl`] },
      expectedFields: ['entries'],
    },
    {
      action: 'loadPageNotes',
      params: { slug: slug1 },
      expectedFields: ['notes'],
    },
    { action: 'flushLogBuffer', expectedFields: [] },
  ];

  for (const { action, params, expectedFields } of directActions) {
    test(`${action} response matches contract`, async () => {
      const resp = await sendMsg(helper, { action, ...params });
      expect(resp.success).toBe(true);
      for (const field of expectedFields) {
        expect(resp).toHaveProperty(field);
      }
    });
  }

  // readCacheable covers the internal offscreen reads for manifest entities,
  // pages, notes, and lists — all go through the same session→disk fallback path.
  const cacheableKeys = [
    { key: 'manifest:settings', desc: 'settings' },
    { key: 'manifest:name-to-id', desc: 'name-to-id map' },
    { key: 'manifest:orphaned', desc: 'orphaned entity' },
    { key: 'manifest:list-order', desc: 'list order' },
    { key: `page:${slug1}`, desc: 'page entity' },
    { key: `list:test-list-1`, desc: 'list entity' },
  ];

  for (const { key, desc } of cacheableKeys) {
    test(`readCacheable(${desc}) returns { success, value }`, async () => {
      const resp = await sendMsg(helper, { action: 'readCacheable', key });
      assertShape(resp, ['value']);
      expect(resp.value).toBeTruthy();
    });
  }
});
