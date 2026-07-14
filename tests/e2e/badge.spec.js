import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  settingsCheckpoint,
  openHelperPage,
  getSlugForUrl,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
  listEntityFixture,
  listOrderFixture,
  listNameToIdFixture,
} from './helpers.js';

async function getBadgeForUrl(helper, url) {
  return helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (!tabs.length) return { text: '', color: '' };
    const tabId = tabs[0].id;
    const text = await chrome.action.getBadgeText({ tabId });
    const color = await chrome.action.getBadgeBackgroundColor({ tabId });
    return { text, color };
  }, url);
}

async function getActionIconForUrl(helper, url) {
  return helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (!tabs.length) return null;
    const response = await chrome.runtime.sendMessage({
      action: 'getActionIconForTest',
      tabId: tabs[0].id,
    });
    if (!response?.success) {
      throw new Error(response?.error || 'getActionIconForTest failed');
    }
    return response.path;
  }, url);
}

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const helper = await openHelperPage(extContext, extensionId);
  const tabId = await helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (tabs.length !== 1 || !Number.isFinite(tabs[0].id)) {
      throw new Error(`Expected one source tab for ${pageUrl}`);
    }
    return tabs[0].id;
  }, url);
  await helper.close();
  const popup = await extContext.newPage();
  const diagnostics = [];
  popup.on('pageerror', (error) => diagnostics.push(error.message));
  popup.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  await popup.addInitScript(
    ({ tabId, url, title }) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: tabId, url, title }];
          }
          return originalQuery(queryInfo);
        };
      };
      patchTabsQuery();
    },
    { tabId, url, title },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  try {
    await expect(popup.locator('#pageUrl')).toHaveText(url);
  } catch (error) {
    throw new Error(
      `Popup did not load ${url}: ${JSON.stringify({ diagnostics, body: await popup.locator('body').innerText() })}`,
      { cause: error },
    );
  }
  return popup;
}

test.describe('Extension badge', () => {
  test('clears badge text for page with notes because the icon carries state', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/noted', {
      title: 'Noted Page',
      body: '<p>Has a note</p>',
    });
    const url = localServer.url('/noted');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Noted Page',
          childIds: ['note:test-note'],
          parentIds: [],
          timestamps: { dev1: 1 },
        }),
      },
      {
        path: 'objects/notes/test-note.json',
        data: noteEntityFixture({
          slug: 'test-note',
          excerpt: ['hi'],
          note: 'hi',
          cssPath: [''],
          url,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    // Query badge state from a helper page (extension context has chrome.action access)
    const helper = await openHelperPage(extContext, extensionId);
    const tabId =
      (await page.evaluate(() => {
        // content scripts can't get tabId, query from helper
      }),
      null);

    // Use the helper page to get badge for the navigated tab
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('uses the snapshot marker icon after capturing a snapshot on the current page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/snapshot-capture-badge', {
      title: 'Snapshot Capture Badge',
      body: '<p>Capture this page</p>',
    });
    const url = localServer.url('/snapshot-capture-badge');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('load');

    const helper = await openHelperPage(extContext, extensionId);
    await page.bringToFront();

    const captureResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
    );
    expect(captureResp.success).toBe(true);

    await expect
      .poll(() =>
        helper.evaluate(
          (key) =>
            chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
          `page:${slug}`,
        ),
      )
      .toMatchObject({
        success: true,
        value: {
          childIds: [expect.stringMatching(/^snapshot:/)],
        },
      });

    await expect
      .poll(() => getActionIconForUrl(helper, url))
      .toMatchObject({
        16: 'icons/icon16-special-notes.png',
        48: 'icons/icon48-special-notes.png',
        128: 'icons/icon128-special-notes.png',
      });

    await page.close();
    await helper.close();
  });

  test('clears badge text for page pinned in lists because the icon carries state', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/listed', {
      title: 'Listed Page',
      body: '<p>In a list</p>',
    });
    const url = localServer.url('/listed');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Listed Page',
          childIds: [],
          parentIds: ['list:my-list'],
          timestamps: { dev1: 1 },
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('keeps the page marker after the content script records the initial visit', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/listed-after-report', {
      title: 'Listed After Report',
      body: '<p>In a list after visit report</p>',
    });
    const url = localServer.url('/listed-after-report');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Listed After Report',
          childIds: [],
          parentIds: ['list:my-list'],
          timestamps: { dev1: 1 },
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async (pageKey) => {
      for (let i = 0; i < 30; i++) {
        const resp = await chrome.runtime.sendMessage({
          action: 'readDesktopValue',
          key: pageKey,
        });
        if (
          resp?.value?.timestamps &&
          Object.keys(resp.value.timestamps).length > 1
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }, `page:${slug}`);

    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('clears badge text for page with both notes and lists because the icon carries state', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/both', { title: 'Both Page', body: '<p>Both</p>' });
    const url = localServer.url('/both');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Both Page',
          childIds: ['snapshot:test-snap-123'],
          parentIds: ['list:my-list'],
          timestamps: { dev1: 1 },
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('badge clears after deleting the only snapshot', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/snap-del', {
      title: 'Snap Delete Test',
      body: '<p>Content</p>',
    });
    const url = localServer.url('/snap-del');
    const slug = getSlugForUrl(url);
    const snapTs = Date.now() - 1000;

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Snap Delete Test',
          childIds: [`snapshot:${slug}-${snapTs}`],
          parentIds: [],
          timestamps: { dev1: 1 },
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);

    // Badge text stays empty because the state-colored icon background carries state.
    const badgeBefore = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      const color = await chrome.action.getBadgeBackgroundColor({ tabId });
      return { text, color };
    }, url);
    expect(badgeBefore.text).toBe('');

    // Delete the snapshot
    await helper.evaluate(
      ({ slug, ts }) =>
        chrome.runtime.sendMessage({
          action: 'deleteSnapshot',
          slug,
          timestamp: ts,
        }),
      { slug, ts: snapTs },
    );

    // Wait for badge update
    await page.waitForTimeout(300);

    // Badge should be cleared
    const badgeAfter = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '' };
      const tabId = tabs[0].id;
      return { text: await chrome.action.getBadgeText({ tabId }) };
    }, url);
    expect(badgeAfter.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('badge clears after deleting the only note', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/note-del', {
      title: 'Note Delete Test',
      body: '<p>Content with a note</p>',
    });
    const url = localServer.url('/note-del');
    const slug = getSlugForUrl(url);
    const noteSlug = 'delete-only-note';

    await resetAndSeed(extContext, extensionId, [
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Note Delete Test',
          childIds: [`note:${noteSlug}`],
          parentIds: [],
          timestamps: { dev1: 1 },
          createdAt: 1,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['Only note'],
          note: 'delete me',
          cssPath: [''],
          url,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({ text: '' });

    const deleteResp = await helper.evaluate(
      (slugToDelete) =>
        chrome.runtime.sendMessage({
          action: 'deleteNote',
          noteSlug: slugToDelete,
        }),
      noteSlug,
    );
    expect(deleteResp).toMatchObject({ success: true });

    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({
        text: '',
      });

    await page.close();
    await helper.close();
  });

  test('badge clears after deleting the only list that pinned the page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/list-del-badge', {
      title: 'List Delete Badge Test',
      body: '<p>Content pinned in one list</p>',
    });
    const url = localServer.url('/list-del-badge');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: 'views/manifest/list-order.json',
        data: listOrderFixture({
          timestamps: {},
          tree: [{ id: 'list:delete-badge-list', children: [] }],
        }),
      },
      {
        path: 'views/lists/delete-badge-list.json',
        data: listEntityFixture({
          slug: 'delete-badge-list',
          name: 'Delete Badge List',
          owner: 'test-device',
          pins: [{ id: `page:${slug}`, pinnedAt: Date.now(), source: null }],
          rules: [],
          timestamps: {},
          deleted: false,
          deletedTs: null,
        }),
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: listNameToIdFixture({
          timestamps: {},
          paths: {
            'test-device/Delete Badge List': 'delete-badge-list',
          },
        }),
      },
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'List Delete Badge Test',
          childIds: [],
          parentIds: ['list:delete-badge-list'],
          timestamps: { dev1: 1 },
          createdAt: 1,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({ text: '' });

    const deleteResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'deleteList',
        listId: 'delete-badge-list',
      }),
    );
    expect(deleteResp.success).toBe(true);
    expect(deleteResp.urls).toContain(url);
    await expect
      .poll(() =>
        helper.evaluate(
          (pageKeyValue) =>
            chrome.runtime.sendMessage({
              action: 'readDesktopValue',
              key: pageKeyValue,
            }),
          `page:${slug}`,
        ),
      )
      .toMatchObject({ success: true, value: null });

    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({
        text: '',
      });

    await page.close();
    await helper.close();
  });

  test('no badge for unknown page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/unknown', {
      title: 'Unknown Page',
      body: '<p>No data</p>',
    });
    const url = localServer.url('/unknown');

    await resetAndSeed(extContext, extensionId);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const helper = await openHelperPage(extContext, extensionId);
    const badge = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return { text: '', color: '' };
      const tabId = tabs[0].id;
      const text = await chrome.action.getBadgeText({ tabId });
      return { text };
    }, url);

    expect(badge.text).toBe('');

    await page.close();
    await helper.close();
  });

  test('popup shows notes for page with seeded excerpt notes', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/pdf-notes', {
      title: 'PDF Notes Test',
      body: '<p>Content</p>',
    });
    const url = localServer.url('/pdf-notes');
    const slug = getSlugForUrl(url);
    const noteSlug1 = 'note-excerpt-1';
    const noteSlug2 = 'note-excerpt-2';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'PDF Notes Test',
          childIds: [`note:${noteSlug1}`, `note:${noteSlug2}`],
          parentIds: [],
          timestamps: { 'test-device': now },
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
      {
        path: `objects/notes/${noteSlug1}.json`,
        data: noteEntityFixture({
          slug: noteSlug1,
          excerpt: ['First highlight'],
          note: 'note 1',
          cssPath: [''],
          url,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: `objects/notes/${noteSlug2}.json`,
        data: noteEntityFixture({
          slug: noteSlug2,
          excerpt: ['Second highlight'],
          note: 'note 2',
          cssPath: [''],
          url,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url,
            title: 'PDF Notes Test',
            referrerUrl: null,
          },
        ],
      },
    ]);

    // Navigate to the page to trigger badge + content script
    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    // Verify getPageInfo returns notes via helper page
    const helper = await openHelperPage(extContext, extensionId);
    const info = await helper.evaluate(async (testSlug) => {
      return await chrome.runtime.sendMessage({
        action: 'getPageInfo',
        slug: testSlug,
      });
    }, slug);

    expect(info.success).toBe(true);
    expect(info.notes).toHaveLength(2);
    expect(info.notes.map((n) => n.excerpt).sort()).toEqual([
      ['First highlight'],
      ['Second highlight'],
    ]);

    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Page With Highlights',
    });
    await expect(popup.locator('.highlight-item')).toHaveCount(2);
    await expect(popup.locator('.highlight-item')).toContainText([
      'First highlight',
      'Second highlight',
    ]);

    await page.close();
    await popup.close();
    await helper.close();
  });

  test('popup slug matches badge slug when content script reports same URL', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/slug-match', {
      title: 'Slug Match',
      body: '<p>Content</p>',
    });
    const url = localServer.url('/slug-match');
    const slug = getSlugForUrl(url);
    const noteSlug = 'slug-match-note';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Slug Match',
          childIds: [`note:${noteSlug}`],
          parentIds: [],
          timestamps: { 'test-device': now },
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['test excerpt'],
          note: 'test',
          cssPath: [''],
          url,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url,
            title: 'Slug Match',
            referrerUrl: null,
          },
        ],
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    // Wait for content script to report
    await page.waitForTimeout(500);

    const helper = await openHelperPage(extContext, extensionId);

    // Get the reported URL for this tab
    const tabInfo = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return null;
      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url;
      const reported = await chrome.runtime.sendMessage({
        action: 'getReportedUrl',
        tabId,
      });
      return { tabUrl, reportedUrl: reported?.url, tabId };
    }, url);

    expect(tabInfo).not.toBeNull();

    // The reported URL (from content script) should match the tab URL
    // If they differ, the popup will generate a wrong slug
    const { generateSlugFromUrl } =
      await import('../../apps/extension/utils.js');
    const effectiveUrl = tabInfo.reportedUrl || tabInfo.tabUrl;
    const popupSlug = generateSlugFromUrl(effectiveUrl);
    const badgeSlug = generateSlugFromUrl(tabInfo.tabUrl);

    // This tests the core issue: popup and badge should use the same slug
    expect(popupSlug).toBe(badgeSlug);
    expect(popupSlug).toBe(slug);

    await page.close();
    await helper.close();
  });
});
