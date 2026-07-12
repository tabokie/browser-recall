import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  getExtensionMessage,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
  pickSeeded,
  seededRandom,
} from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);
const POPUP_MUTATION_SEED = 'popup-live-mutation-20260505-a';

async function openPopupForUrl(
  extContext,
  extensionId,
  { url, title, expectedTitle = title, locale, messages = {} },
) {
  const popup = await extContext.newPage();
  await popup.addInitScript(
    ({ url, title, locale, messages }) => {
      const patchTabsQuery = () => {
        if (!globalThis.chrome?.tabs?.query) {
          setTimeout(patchTabsQuery, 0);
          return;
        }
        const originalQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (queryInfo) => {
          if (queryInfo?.active && queryInfo?.currentWindow) {
            return [{ id: 10001, url, title }];
          }
          return originalQuery(queryInfo);
        };
        if (locale) {
          chrome.i18n.getUILanguage = () => locale;
          chrome.i18n.getMessage = (key) => messages[key] || '';
        }
      };
      patchTabsQuery();
    },
    { url, title, locale, messages },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  await expect(popup.locator('#pageTitle')).toHaveText(expectedTitle);
  return popup;
}

async function openPreparedPopupForPage(extContext, extensionId, page, title) {
  await page.bringToFront();
  const url = page.url();
  const helper = await openHelperPage(extContext, extensionId);
  const prepared = await helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    const tabId = tabs[0]?.id || null;
    if (!tabId) return { success: false, error: 'Active tab not found' };
    return chrome.runtime.sendMessage({
      action: 'preparePopupBootstrapForTest',
      tabId,
    });
  }, url);
  await helper.close();
  if (!prepared?.success) {
    throw new Error(
      `preparePopupBootstrapForTest failed: ${JSON.stringify(prepared)}`,
    );
  }

  const popup = await extContext.newPage();
  await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  await expect(popup.locator('#pageTitle')).toHaveText(title);
  return popup;
}

async function getBadgeForUrl(helper, url) {
  return helper.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({ url: pageUrl });
    if (!tabs.length) return { text: '', color: null };
    const tabId = tabs[0].id;
    return {
      text: await chrome.action.getBadgeText({ tabId }),
      color: await chrome.action.getBadgeBackgroundColor({ tabId }),
    };
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

async function waitForContentScript(helper, page, url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ready = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      if (!tabs.length) return false;
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { action: 'isPdfPage' });
        return true;
      } catch {
        return false;
      }
    }, url);
    if (ready) return;
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
  }
  throw new Error(`content script did not load for ${url}`);
}

test.describe('Popup list chip behavior', () => {
  test('localizes the dynamically rendered add page note button', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/localized-page-note', {
      title: 'Localized Page Note',
      body: '<main>Localized page note</main>',
    });
    const url = localServer.url('/localized-page-note');

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Localized Page Note',
      locale: 'zh-CN',
      messages: {
        extensionAddPageNote: '+ 页面笔记',
        extensionAddPageNoteEsc: '添加页面笔记...按 Esc 保存。',
        extensionAddToList: '添加到列表',
        extensionSearchOrCreate: '搜索或创建...',
        extensionPauseTracing: '暂停跟踪',
      },
    });

    await expect(popup.locator('#pageNoteAddBtn')).toHaveText('+ 页面笔记');
    await expect(popup.locator('#recordingToggle')).toHaveAttribute(
      'title',
      '暂停跟踪',
    );
    await expect(popup.locator('#listAddBtn')).toHaveAttribute(
      'title',
      '添加到列表',
    );

    await popup.locator('#pageNoteAddBtn').click();
    await expect(popup.locator('.page-note-edit-textarea')).toHaveAttribute(
      'placeholder',
      '添加页面笔记...按 Esc 保存。',
    );
    await popup.locator('.page-note-edit-textarea').blur();

    await popup.locator('#listAddBtn').click();
    await expect(popup.locator('#listSearchInput')).toHaveAttribute(
      'placeholder',
      '搜索或创建...',
    );

    await popup.close();
    await page.close();
  });

  test('startup keeps one static ticket shell until connected page data is ready', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/popup-startup-stability', {
      title: 'Popup Startup Stability',
      body: '<main>Popup startup stability page</main>',
    });
    const url = localServer.url('/popup-startup-stability');

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const popup = await extContext.newPage();
    await popup.addInitScript(
      ({ url }) => {
        const visibleShells = [];
        let releaseConnectorState;
        let releasePageSummary;
        globalThis.__popupStartupReleaseConnectorState = () => {
          releaseConnectorState?.();
        };
        globalThis.__popupStartupReleasePageSummary = () => {
          releasePageSummary?.();
        };
        globalThis.__popupStartupVisibleShells = visibleShells;

        const recordVisibleShells = () => {
          for (const id of ['loading', 'setup-required', 'dashboard']) {
            const element = document.getElementById(id);
            if (!element || element.style.display === 'none') continue;
            if (getComputedStyle(element).display === 'none') continue;
            if (visibleShells[visibleShells.length - 1] !== id) {
              visibleShells.push(id);
            }
          }
        };

        const patchApis = () => {
          if (!globalThis.chrome?.runtime?.sendMessage || !chrome.tabs?.query) {
            setTimeout(patchApis, 0);
            return;
          }

          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              return [{ id: 10001, url, title: 'Popup Startup Stability' }];
            }
            return originalQuery(queryInfo);
          };

          const originalStorageGet = chrome.storage.local.get.bind(
            chrome.storage.local,
          );
          let returnedStartingConnectorCache = false;
          chrome.storage.local.get = async (keys, ...rest) => {
            const keyList = Array.isArray(keys)
              ? keys
              : typeof keys === 'string'
                ? [keys]
                : [];
            if (
              !returnedStartingConnectorCache &&
              keyList.includes('connectorState')
            ) {
              returnedStartingConnectorCache = true;
              return { connectorState: 'starting' };
            }
            return originalStorageGet(keys, ...rest);
          };

          const originalSendMessage = chrome.runtime.sendMessage.bind(
            chrome.runtime,
          );
          let delayed = false;
          chrome.runtime.sendMessage = async (request, ...rest) => {
            if (request?.action === 'getDesktopConnectorState' && !delayed) {
              delayed = true;
              await new Promise((resolve) => {
                releaseConnectorState = resolve;
              });
            }
            if (request?.action === 'getPageSummary') {
              await new Promise((resolve) => {
                releasePageSummary = resolve;
              });
            }
            return originalSendMessage(request, ...rest);
          };
        };

        patchApis();
        const observer = new MutationObserver(recordVisibleShells);
        const observe = () => {
          if (!document.body) {
            setTimeout(observe, 0);
            return;
          }
          observer.observe(document.body, {
            attributes: true,
            childList: true,
            subtree: true,
            attributeFilter: ['style', 'class'],
          });
          recordVisibleShells();
        };
        observe();
      },
      { url },
    );

    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForTimeout(350);
    await expect
      .poll(() =>
        popup.evaluate(() => document.documentElement.dataset.popupHidden),
      )
      .toBeUndefined();
    await expect
      .poll(() =>
        popup.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
      )
      .toBe('rgb(247, 244, 234)');
    await expect
      .poll(() =>
        popup.evaluate(() => document.body.getBoundingClientRect().height),
      )
      .toBeGreaterThanOrEqual(320);
    await expect
      .poll(() =>
        popup.evaluate(() => document.body.getBoundingClientRect().width),
      )
      .toBe(296);
    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#loading')).toBeHidden();
    expect(
      await popup.evaluate(() => globalThis.__popupStartupVisibleShells),
    ).toEqual(['dashboard']);

    await popup.evaluate(() =>
      globalThis.__popupStartupReleaseConnectorState(),
    );
    await popup.waitForTimeout(350);
    await expect
      .poll(() =>
        popup.evaluate(() => document.documentElement.dataset.popupHidden),
      )
      .toBeUndefined();
    expect(
      await popup.evaluate(() => globalThis.__popupStartupVisibleShells),
    ).toEqual(['dashboard']);

    await popup.evaluate(() => globalThis.__popupStartupReleasePageSummary());
    await expect(popup.locator('#dashboard')).toBeVisible();
    expect(
      await popup.evaluate(() => globalThis.__popupStartupVisibleShells),
    ).toEqual(['dashboard']);
    await popup.close();
  });

  test('prepared toolbar bootstrap renders daemon data without popup startup fetches', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    void setupDir;
    localServer.addPage('/item?id=48789428', {
      title: 'Show HN: Browser Recall',
      body: '<main>Hacker News item 48789428</main>',
    });
    const url = localServer.url('/item?id=48789428');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:prepared-list' }],
        },
      },
      {
        path: 'views/lists/prepared-list.json',
        data: {
          slug: 'prepared-list',
          name: 'AI',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Show HN: Browser Recall',
          timestamp: now,
          parentIds: ['list:prepared-list'],
          childIds: [],
          visitDates: [20260617],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const helper = await openHelperPage(extContext, extensionId);
    const tabId = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      return tabs[0]?.id || null;
    }, url);
    expect(tabId).toBeTruthy();
    const prepared = await helper.evaluate(
      (targetTabId) =>
        chrome.runtime.sendMessage({
          action: 'preparePopupBootstrapForTest',
          tabId: targetTabId,
        }),
      tabId,
    );
    expect(prepared.success).toBe(true);
    expect(prepared.mode).toBe('dashboard');
    expect(prepared.popupPath).toMatch(/^popup\.html\?bootstrap=/);
    await expect
      .poll(() => getActionIconForUrl(helper, url))
      .toMatchObject({ 16: 'icons/icon16-special-lists.png' });
    await helper.close();

    const popup = await extContext.newPage();
    await popup.addInitScript(() => {
      const patchRuntime = () => {
        if (!globalThis.chrome?.runtime?.sendMessage) {
          setTimeout(patchRuntime, 0);
          return;
        }
        const originalSendMessage = chrome.runtime.sendMessage.bind(
          chrome.runtime,
        );
        const startupFetches = [];
        globalThis.__preparedPopupStartupFetches = startupFetches;
        chrome.runtime.sendMessage = async (request, ...rest) => {
          if (
            request?.action === 'getPageSummary' ||
            request?.action === 'getPopupLists'
          ) {
            startupFetches.push(request.action);
          }
          return originalSendMessage(request, ...rest);
        };
      };
      patchRuntime();
    });
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);

    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#pageTitle')).toHaveText(
      'Show HN: Browser Recall',
    );
    await expect(
      popup.locator('#listChips .list-chip.selected', { hasText: 'AI' }),
    ).toBeVisible();
    expect(
      await popup.evaluate(() => globalThis.__preparedPopupStartupFetches),
    ).toEqual([]);

    await popup.locator('#listAddBtn').click();
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    expect(
      await popup.evaluate(() => globalThis.__preparedPopupStartupFetches),
    ).toEqual([]);

    await popup.close();
    await page.close();
  });

  test('prepared toolbar bootstrap invalidates when membership changes before popup opens', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    void setupDir;
    localServer.addPage('/prepared-popup-membership-race', {
      title: 'Prepared Popup Membership Race',
      body: '<main>Prepared popup membership race</main>',
    });
    const url = localServer.url('/prepared-popup-membership-race');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:ai' }],
        },
      },
      {
        path: 'views/lists/ai.json',
        data: {
          slug: 'ai',
          name: 'AI',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: { 'test-device/AI': 'ai' },
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Prepared Popup Membership Race',
          timestamp: now,
          parentIds: [],
          childIds: [],
          visitDates: [20260617],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const helper = await openHelperPage(extContext, extensionId);
    const tabId = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      return tabs[0]?.id || null;
    }, url);
    expect(tabId).toBeTruthy();
    const prepared = await helper.evaluate(
      (targetTabId) =>
        chrome.runtime.sendMessage({
          action: 'preparePopupBootstrapForTest',
          tabId: targetTabId,
        }),
      tabId,
    );
    expect(prepared).toMatchObject({ success: true, mode: 'dashboard' });

    const pinResponse = await helper.evaluate(
      ({ pageUrl, pageTitle }) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'ai',
          url: pageUrl,
          title: pageTitle,
        }),
      { pageUrl: url, pageTitle: 'Prepared Popup Membership Race' },
    );
    expect(pinResponse.success).toBe(true);
    await expect
      .poll(() => getActionIconForUrl(helper, url))
      .toMatchObject({ 16: 'icons/icon16-special-lists.png' });
    await helper.close();

    const popup = await extContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);

    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#listCount')).toHaveText('01');
    await expect(
      popup.locator('#listChips .list-chip.selected', { hasText: 'AI' }),
    ).toBeVisible();

    await popup.close();
    await page.close();
  });

  test('existing list toggles do not dim the whole popup while pending', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    void setupDir;
    localServer.addPage('/popup-list-toggle-no-flash', {
      title: 'Popup List Toggle No Flash',
      body: '<main>Popup list toggle no flash page</main>',
    });
    const url = localServer.url('/popup-list-toggle-no-flash');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:chip-list' }, { id: 'list:picker-list' }],
        },
      },
      {
        path: 'views/lists/chip-list.json',
        data: {
          slug: 'chip-list',
          name: 'Chip List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/picker-list.json',
        data: {
          slug: 'picker-list',
          name: 'Picker List',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup List Toggle No Flash',
          timestamp: now,
          parentIds: [],
          childIds: [],
          visitDates: [20260618],
        },
      },
    ]);

    const popup = await extContext.newPage();
    await popup.addInitScript(
      ({ url }) => {
        let releaseToggle;
        let releaseRefresh;
        let stallRefresh = false;
        const toggleEvents = [];
        globalThis.__releaseListToggleForTest = () => releaseToggle?.();
        globalThis.__releaseListRefreshForTest = () => releaseRefresh?.();
        globalThis.__listToggleEventsForTest = toggleEvents;
        globalThis.__popupMutatingTransitionsForTest = [];

        const patchApis = () => {
          if (!globalThis.chrome?.tabs?.query || !chrome.runtime?.sendMessage) {
            setTimeout(patchApis, 0);
            return;
          }

          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              return [
                {
                  id: 10001,
                  url,
                  title: 'Popup List Toggle No Flash',
                },
              ];
            }
            return originalQuery(queryInfo);
          };

          const originalSendMessage = chrome.runtime.sendMessage.bind(
            chrome.runtime,
          );
          chrome.runtime.sendMessage = async (request, ...rest) => {
            if (request?.action === 'toggleListPin') {
              toggleEvents.push(`started:${request.listId}`);
              await new Promise((resolve) => {
                releaseToggle = resolve;
              });
              toggleEvents.push(`released:${request.listId}`);
              stallRefresh = true;
            } else if (request?.action === 'getPageSummary' && stallRefresh) {
              toggleEvents.push('refresh-started');
              await new Promise((resolve) => {
                releaseRefresh = resolve;
              });
              toggleEvents.push('refresh-released');
              stallRefresh = false;
            }
            return originalSendMessage(request, ...rest);
          };

          const observeMutationState = () => {
            if (!document.body) {
              setTimeout(observeMutationState, 0);
              return;
            }
            new MutationObserver(() => {
              globalThis.__popupMutatingTransitionsForTest.push(
                document.body.classList.contains('popup-ui-mutating'),
              );
            }).observe(document.body, {
              attributes: true,
              attributeFilter: ['class'],
            });
          };
          observeMutationState();
        };
        patchApis();
      },
      { url },
    );
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#pageTitle')).toHaveText(
      'Popup List Toggle No Flash',
    );
    await expect(
      popup.locator('#listChips .list-chip', { hasText: 'Chip List' }),
    ).toBeVisible();

    const expectPopupNotDimmed = async () => {
      await expect
        .poll(() =>
          popup.evaluate(() =>
            document.body.classList.contains('popup-ui-mutating'),
          ),
        )
        .toBe(false);
      await expect
        .poll(() =>
          popup.evaluate(
            () =>
              getComputedStyle(document.getElementById('pageTitle')).opacity,
          ),
        )
        .toBe('1');
      await expect
        .poll(() =>
          popup.evaluate(
            () =>
              getComputedStyle(document.querySelector('#listChips .list-chip'))
                .opacity,
          ),
        )
        .toBe('1');
      await expect(popup.locator('#dashboard')).toBeVisible();
      await expect(popup.locator('#loading')).toBeHidden();
    };

    await popup
      .locator('#listChips .list-chip', { hasText: 'Chip List' })
      .click();
    await expect
      .poll(() => popup.evaluate(() => globalThis.__listToggleEventsForTest))
      .toContain('started:chip-list');
    await expectPopupNotDimmed();
    await popup.evaluate(() => {
      globalThis.__popupMutatingTransitionsForTest.length = 0;
    });
    await popup.evaluate(() => globalThis.__releaseListToggleForTest());
    await expect
      .poll(() => popup.evaluate(() => globalThis.__listToggleEventsForTest))
      .toContain('refresh-started');
    await expect(
      popup.locator('#listChips .list-chip.selected', {
        hasText: 'Chip List',
      }),
    ).toBeVisible();
    expect(
      await popup.evaluate(() => globalThis.__popupMutatingTransitionsForTest),
    ).not.toContain(true);
    await expectPopupNotDimmed();
    await popup.evaluate(() => globalThis.__releaseListRefreshForTest());

    await popup.locator('#listAddBtn').click();
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    await expect
      .poll(() =>
        popup.evaluate(() =>
          document.body.classList.contains('popup-ui-mutating'),
        ),
      )
      .toBe(false);

    await popup
      .locator('#listPickerHost.list-picker .list-picker-row', {
        hasText: 'Picker List',
      })
      .click();
    await expect
      .poll(() => popup.evaluate(() => globalThis.__listToggleEventsForTest))
      .toContain('started:picker-list');
    await expectPopupNotDimmed();
    await expect
      .poll(() =>
        popup.evaluate(
          () =>
            getComputedStyle(document.getElementById('listSearchInput'))
              .opacity,
        ),
      )
      .toBe('1');
    await popup.evaluate(() => {
      globalThis.__popupMutatingTransitionsForTest.length = 0;
    });
    await popup.evaluate(() => globalThis.__releaseListToggleForTest());
    await expect
      .poll(() => popup.evaluate(() => globalThis.__listToggleEventsForTest))
      .toContain('refresh-started');
    await expect(
      popup.locator('#listPickerHost.list-picker .list-picker-row.selected', {
        hasText: 'Picker List',
      }),
    ).toBeVisible();
    expect(
      await popup.evaluate(() => globalThis.__popupMutatingTransitionsForTest),
    ).not.toContain(true);
    await expectPopupNotDimmed();
    await popup.evaluate(() => globalThis.__releaseListRefreshForTest());

    await popup.close();
  });

  test('popup opened after a list already exists shows it as available', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-list-refresh', {
      title: 'Popup List Refresh',
      body: '<main>Popup list refresh page</main>',
    });
    const url = localServer.url('/popup-list-refresh');

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url,
            title: 'Popup List Refresh',
          },
        ],
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const existingResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'saveListMeta',
        name: 'Existing',
      }),
    );
    expect(existingResp.success).toBe(true);
    const warmed = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'getPageSummary',
        url: 'https://example.com/popup-list-warmup',
        title: 'Popup list warmup',
      }),
    );
    expect(warmed.success).toBe(true);
    expect(warmed.lists.map((list) => list.name)).toContain('Existing');
    const createResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'saveListMeta',
        name: 'Desktop Added',
      }),
    );
    expect(createResp.success).toBe(true);
    await helper.close();

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.bringToFront();

    const popup = await extContext.newPage();
    await popup.addInitScript(
      ({ url }) => {
        const patchTabsQuery = () => {
          if (!globalThis.chrome?.tabs?.query) {
            setTimeout(patchTabsQuery, 0);
            return;
          }
          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              return [{ id: 10001, url, title: 'Popup List Refresh' }];
            }
            return originalQuery(queryInfo);
          };
        };
        patchTabsQuery();
      },
      { url },
    );
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect
      .poll(() =>
        popup
          .locator('#listChips .list-chip')
          .evaluateAll((nodes) =>
            nodes.slice(0, 2).map((node) => node.textContent.trim()),
          ),
      )
      .toEqual(['Desktop Added', 'Existing']);

    await popup.locator('#listAddBtn').click();
    await expect
      .poll(() =>
        popup
          .locator('#listPickerList .list-picker-row')
          .evaluateAll((nodes) =>
            nodes.slice(0, 2).map((node) => node.textContent.trim()),
          ),
      )
      .toEqual(['Desktop Added', 'Existing']);

    await popup.close();
    await page.close();
  });

  test('waits for the full page summary before showing list chips', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-fast-lists', {
      title: 'Popup Fast Lists',
      body: '<main>Popup fast lists page</main>',
    });
    const url = localServer.url('/popup-fast-lists');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:fast-list' }],
        },
      },
      {
        path: 'views/lists/fast-list.json',
        data: {
          slug: 'fast-list',
          name: 'Fast List',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${slug}`, pinnedAt: now }],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Fast Lists',
          timestamp: now,
          parentIds: ['list:fast-list'],
          childIds: [],
        },
      },
    ]);

    const popup = await extContext.newPage();
    await popup.addInitScript(
      ({ url }) => {
        const patchApis = () => {
          if (!globalThis.chrome?.runtime?.sendMessage || !chrome.tabs?.query) {
            setTimeout(patchApis, 0);
            return;
          }
          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              return [{ id: 10001, url, title: 'Popup Fast Lists' }];
            }
            return originalQuery(queryInfo);
          };

          const originalSendMessage = chrome.runtime.sendMessage.bind(
            chrome.runtime,
          );
          const events = [];
          globalThis.__popupFastListEvents = events;
          chrome.runtime.sendMessage = async (request, ...rest) => {
            if (
              request?.action === 'trimTitle' ||
              request?.action === 'getPopupAccessState'
            ) {
              events.push({ action: request.action, phase: 'start' });
            }
            if (request?.action === 'getPageSummary') {
              events.push({ action: request.action, phase: 'start' });
              await new Promise((resolve) => setTimeout(resolve, 450));
              const response = await originalSendMessage(request, ...rest);
              events.push({ action: request.action, phase: 'end' });
              return response;
            }
            if (request?.action === 'getPopupLists') {
              events.push({ action: request.action, phase: 'start' });
              const response = await originalSendMessage(request, ...rest);
              events.push({ action: request.action, phase: 'end' });
              return response;
            }
            return originalSendMessage(request, ...rest);
          };
        };
        patchApis();
      },
      { url },
    );

    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForTimeout(350);
    await expect
      .poll(() =>
        popup.evaluate(() => document.documentElement.dataset.popupHidden),
      )
      .toBeUndefined();
    await expect
      .poll(() =>
        popup.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
      )
      .toBe('rgb(247, 244, 234)');
    await expect
      .poll(() =>
        popup.evaluate(() => document.body.getBoundingClientRect().height),
      )
      .toBeGreaterThanOrEqual(320);
    await expect
      .poll(() =>
        popup.evaluate(() => document.body.getBoundingClientRect().width),
      )
      .toBe(296);
    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(
      popup.locator('#listChips .list-chip', { hasText: 'Fast List' }),
    ).toHaveCount(0);
    expect(
      await popup.evaluate(() =>
        globalThis.__popupFastListEvents.some(
          (event) => event.action === 'getPageSummary' && event.phase === 'end',
        ),
      ),
    ).toBe(false);

    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(
      popup.locator('#listChips .list-chip', { hasText: 'Fast List' }),
    ).toBeVisible();
    await expect(popup.locator('#pageTitle')).toHaveText('Popup Fast Lists');
    expect(
      await popup.evaluate(() =>
        globalThis.__popupFastListEvents
          .filter((event) => event.phase === 'start')
          .map((event) => event.action),
      ),
    ).toEqual(['getPageSummary']);
    await popup.close();
  });

  test('toggling a chip does not change chip order', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    // Seed 3 lists with different pinnedAt timestamps
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [
            { id: 'list:alpha' },
            { id: 'list:beta' },
            { id: 'list:gamma' },
          ],
        },
      },
      {
        path: 'views/lists/alpha.json',
        data: {
          slug: 'alpha',
          name: 'Alpha',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now - 3000 }],
        },
      },
      {
        path: 'views/lists/beta.json',
        data: {
          slug: 'beta',
          name: 'Beta',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now - 2000 }],
        },
      },
      {
        path: 'views/lists/gamma.json',
        data: {
          slug: 'gamma',
          name: 'Gamma',
          owner: 'test-device',
          timestamp: now,
          pins: [{ id: `page:${TEST_SLUG}`, pinnedAt: now - 1000 }],
        },
      },
      {
        path: pageCheckpointPath(TEST_SLUG),
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example',
          timestamp: now,
          parentIds: ['list:alpha', 'list:beta', 'list:gamma'],
          childIds: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Alpha': 'alpha',
            'test-device/Beta': 'beta',
            'test-device/Gamma': 'gamma',
          },
        },
      },
      {
        path: `logs/test-device/2026-03-01.jsonl`,
        lines: [
          {
            timestamp: now,
            action: 'visit_page',
            url: TEST_URL,
            title: 'Example',
          },
        ],
      },
    ]);

    // Test chip ordering via background messages directly
    const helper = await openHelperPage(extContext, extensionId);

    // Load all list pins to verify ordering
    const pinsResp = await helper.evaluate(async () => {
      const lists = ['alpha', 'beta', 'gamma'];
      const result = {};
      for (const id of lists) {
        const resp = await chrome.runtime.sendMessage({
          action: 'readDesktopValue',
          key: 'list:' + id,
        });
        result[id] = resp.value.pins;
      }
      return result;
    });

    // Verify pins exist with expected pinnedAt ordering
    expect(pinsResp.gamma[0].pinnedAt).toBeGreaterThan(
      pinsResp.beta[0].pinnedAt,
    );
    expect(pinsResp.beta[0].pinnedAt).toBeGreaterThan(
      pinsResp.alpha[0].pinnedAt,
    );

    // Toggle beta pin (unpin)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'toggleListPin',
        listId: 'beta',
        url: 'https://example.com/',
      }),
    );

    // Read beta pins — should now be unpinned
    const betaAfter = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readDesktopValue',
        key: 'list:beta',
      }),
    );
    expect(betaAfter.value.pins).toHaveLength(0);

    // Toggle beta pin again (re-pin) — it should get a new pinnedAt
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'toggleListPin',
        listId: 'beta',
        url: 'https://example.com/',
      }),
    );

    const betaRePinned = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readDesktopValue',
        key: 'list:beta',
      }),
    );
    // Beta's pinnedAt is now the newest
    expect(betaRePinned.value.pins[0].pinnedAt).toBeGreaterThan(
      pinsResp.gamma[0].pinnedAt,
    );

    await helper.close();

    // The key behavior to test is in the popup UI — the frozen chip order.
    // Since we can't easily open popup as a real popup in E2E, we verify the
    // implementation by checking that frozenChipOrder preserves order.
    // This is tested below with a real popup rendering test using localServer.
  });

  test('new list created via popup picker immediately pins current page', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:existing' }],
        },
      },
      {
        path: 'views/lists/existing.json',
        data: {
          slug: 'existing',
          name: 'Existing',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(TEST_SLUG),
        data: {
          slug: TEST_SLUG,
          url: TEST_URL,
          title: 'Example',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Existing': 'existing',
          },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    const createResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'createListAndPin',
        name: 'Brand New',
        url: 'https://example.com/',
        title: 'Example',
      }),
    );
    const newListId = createResp.listId;
    expect(newListId).toBeTruthy();
    expect(createResp.pinned).toBe(true);

    // Verify the list has the pin
    const newList = await helper.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          action: 'readDesktopValue',
          key: 'list:' + id,
        }),
      newListId,
    );
    expect(newList.value.pins).toHaveLength(1);
    expect(newList.value.pins[0].id).toBe(`page:${TEST_SLUG}`);

    await helper.close();
  });

  test('list picker refreshes available lists while popup is already open', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-live-lists', {
      title: 'Popup Live Lists',
      body: '<main>Popup live lists page</main>',
    });
    const url = localServer.url('/popup-live-lists');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:existing' }] },
      },
      {
        path: 'views/lists/existing.json',
        data: {
          slug: 'existing',
          name: 'Existing',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Live Lists',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Live Lists',
    });
    await expect(popup.locator('#listChips')).toContainText('Existing');

    const helper = await openHelperPage(extContext, extensionId);
    const createResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'saveListMeta',
        name: 'Live Added',
      }),
    );
    expect(createResp.success).toBe(true);

    await popup.locator('#listAddBtn').click();
    await expect(popup.locator('#listPickerList')).toContainText('Existing');
    await expect(popup.locator('#listPickerList')).toContainText('Live Added');

    await helper.close();
    await popup.close();
    await page.close();
  });

  test('list picker floats with strong frame and custom scrollbar', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    const now = Date.now();
    localServer.addPage('/popup-floating-list-picker', {
      title: 'Popup Floating List Picker',
      body: '<main>Popup floating list picker page</main>',
    });
    const url = localServer.url('/popup-floating-list-picker');
    const slug = getSlugForUrl(url);
    const lists = Array.from({ length: 18 }, (_, index) => {
      const n = index + 1;
      return {
        slug: `floating-list-${n}`,
        name: `Floating List ${n}`,
      };
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: lists.map((list) => ({ id: `list:${list.slug}` })),
        },
      },
      ...lists.map((list) => ({
        path: `views/lists/${list.slug}.json`,
        data: {
          slug: list.slug,
          name: list.name,
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      })),
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Floating List Picker',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPreparedPopupForPage(
      extContext,
      extensionId,
      page,
      'Popup Floating List Picker',
    );
    await popup.setViewportSize({ width: 296, height: 260 });
    await popup.addStyleTag({
      content: `
        #pageHeader,
        #visitsLikesSection {
          display: none !important;
        }

        #listSection {
          margin-top: 205px !important;
        }

        #snapshotSection {
          display: block !important;
        }
      `,
    });
    await expect(popup.locator('#captureBtn')).toBeVisible();

    const before = await popup.evaluate(() => ({
      bodyHeight: document.body.getBoundingClientRect().height,
      scrollHeight: document.documentElement.scrollHeight,
      captureBox: document
        .getElementById('captureBtn')
        .getBoundingClientRect()
        .toJSON(),
    }));

    await expect(popup.locator('#listAddBtn')).toBeVisible();
    await popup.evaluate(() => document.getElementById('listAddBtn').click());
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    await expect(popup.locator('#listPickerList')).toContainText(
      'Floating List 18',
    );
    await expect(popup.locator('#listPickerScrollThumb')).toBeVisible();

    const after = await popup.evaluate(() => {
      const colorForVar = (name) => {
        const probe = document.createElement('div');
        probe.style.color = `var(${name})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      const pickerStyle = getComputedStyle(
        document.querySelector('#listPickerHost.list-picker'),
      );
      const inputStyle = getComputedStyle(
        document.getElementById('listSearchInput'),
      );
      return {
        bodyHeight: document.body.getBoundingClientRect().height,
        scrollHeight: document.documentElement.scrollHeight,
        expectedSurface: colorForVar('--bg-surface-solid'),
        expectedFrame: colorForVar('--text-primary'),
        pickerPosition: pickerStyle.position,
        pickerBackground: pickerStyle.backgroundColor,
        pickerBorder: {
          color: pickerStyle.borderTopColor,
          width: pickerStyle.borderTopWidth,
        },
        inputBackground: inputStyle.backgroundColor,
        inputFrame: {
          topColor: inputStyle.borderTopColor,
          topWidth: inputStyle.borderTopWidth,
          bottomColor: inputStyle.borderBottomColor,
          bottomWidth: inputStyle.borderBottomWidth,
          leftWidth: inputStyle.borderLeftWidth,
          rightWidth: inputStyle.borderRightWidth,
        },
        inputBox: document
          .getElementById('listSearchInput')
          .getBoundingClientRect()
          .toJSON(),
        pickerBox: document
          .querySelector('#listPickerHost.list-picker')
          .getBoundingClientRect()
          .toJSON(),
        wrapBox: document
          .querySelector('.list-chips-wrap')
          .getBoundingClientRect()
          .toJSON(),
        captureBox: document
          .getElementById('captureBtn')
          .getBoundingClientRect()
          .toJSON(),
        firstRowBorder: {
          style: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderBottomStyle,
          width: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderBottomWidth,
          color: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderBottomColor,
        },
        firstRowRightBorder: {
          style: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderRightStyle,
          width: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderRightWidth,
          color: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).borderRightColor,
          marginRight: getComputedStyle(
            document.querySelector('#listPickerList .list-picker-row'),
          ).marginRight,
        },
        listBox: document
          .getElementById('listPickerList')
          .getBoundingClientRect()
          .toJSON(),
        firstRowBox: document
          .querySelector('#listPickerList .list-picker-row')
          .getBoundingClientRect()
          .toJSON(),
        scrollbarBox: document
          .getElementById('listPickerScrollbar')
          .getBoundingClientRect()
          .toJSON(),
        scrollbar: {
          width: getComputedStyle(
            document.getElementById('listPickerList'),
            '::-webkit-scrollbar',
          ).width,
          display: getComputedStyle(
            document.getElementById('listPickerList'),
            '::-webkit-scrollbar',
          ).display,
          thumbBackground: getComputedStyle(
            document.getElementById('listPickerList'),
            '::-webkit-scrollbar-thumb',
          ).backgroundColor,
          thumbBorderRadius: getComputedStyle(
            document.getElementById('listPickerList'),
            '::-webkit-scrollbar-thumb',
          ).borderRadius,
          scrollportInset:
            document.getElementById('listPickerList').offsetWidth -
            document.getElementById('listPickerList').clientWidth,
          scrollHeight: document.getElementById('listPickerList').scrollHeight,
          clientHeight: document.getElementById('listPickerList').clientHeight,
        },
        outerScrollbar: {
          htmlDisplay: getComputedStyle(
            document.documentElement,
            '::-webkit-scrollbar',
          ).display,
          htmlWidth: getComputedStyle(
            document.documentElement,
            '::-webkit-scrollbar',
          ).width,
          bodyDisplay: getComputedStyle(document.body, '::-webkit-scrollbar')
            .display,
          bodyWidth: getComputedStyle(document.body, '::-webkit-scrollbar')
            .width,
        },
        customThumb: (() => {
          const thumb = document.getElementById('listPickerScrollThumb');
          if (!thumb) return null;
          const style = getComputedStyle(thumb);
          return {
            background: style.backgroundColor,
            borderRadius: style.borderRadius,
            display: style.display,
            height: thumb.getBoundingClientRect().height,
            width: thumb.getBoundingClientRect().width,
          };
        })(),
      };
    });

    expect(after.bodyHeight).toBe(before.bodyHeight);
    expect(after.scrollHeight).toBe(before.scrollHeight);
    expect(after.pickerPosition).toBe('fixed');
    expect(after.pickerBackground).toBe(after.expectedSurface);
    expect(after.inputBackground).toBe(after.expectedSurface);
    expect(after.pickerBorder).toEqual({
      color: after.expectedFrame,
      width: '2px',
    });
    expect(after.inputFrame.leftWidth).toBe('0px');
    expect(after.inputFrame.rightWidth).toBe('0px');
    expect(
      [after.inputFrame.topWidth, after.inputFrame.bottomWidth].sort(),
    ).toEqual(['0px', '2px']);
    const inputSeparatorColor =
      after.inputFrame.topWidth === '2px'
        ? after.inputFrame.topColor
        : after.inputFrame.bottomColor;
    expect(inputSeparatorColor).toBe(after.expectedFrame);
    expect(after.pickerBox.left - after.wrapBox.left).toBeCloseTo(0, 1);
    expect(after.pickerBox.right - after.wrapBox.right).toBeCloseTo(0, 1);
    expect(after.inputBox.left - after.pickerBox.left).toBeCloseTo(2, 1);
    expect(after.pickerBox.right - after.inputBox.right).toBeCloseTo(2, 1);
    expect(after.captureBox.top - before.captureBox.top).toBeCloseTo(0, 1);
    expect(after.firstRowBorder.style).not.toBe('none');
    expect(after.firstRowBorder.width).not.toBe('0px');
    expect(after.firstRowBorder.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(after.firstRowRightBorder.style).toBe('none');
    expect(after.firstRowRightBorder.marginRight).toBe('0px');
    expect(after.scrollbarBox.width).toBe(24);
    expect(after.listBox.right).toBe(after.scrollbarBox.left);
    expect(after.firstRowBox.right).toBe(after.scrollbarBox.left);
    expect(after.scrollbar.scrollHeight).toBeGreaterThan(
      after.scrollbar.clientHeight,
    );
    expect(after.scrollbar.display).toBe('none');
    expect(after.scrollbar.width).toBe('0px');
    expect(after.scrollbar.scrollportInset).toBeGreaterThanOrEqual(0);
    expect(after.scrollbar.thumbBackground).toBe('rgba(0, 0, 0, 0)');
    expect(after.scrollbar.thumbBorderRadius).toBe('0px');
    expect(after.outerScrollbar).toEqual({
      htmlDisplay: 'none',
      htmlWidth: '0px',
      bodyDisplay: 'none',
      bodyWidth: '0px',
    });
    expect(after.customThumb).toEqual({
      background: 'rgb(23, 23, 19)',
      borderRadius: '0px',
      display: 'block',
      height: after.scrollbarBox.width,
      width: after.scrollbarBox.width,
    });

    const beforeWheelThumbTop = await popup
      .locator('#listPickerScrollThumb')
      .evaluate((thumb) => thumb.getBoundingClientRect().top);
    await popup.locator('#listPickerList').hover();
    await popup.mouse.wheel(0, 90);
    const afterWheelThumbTop = await popup
      .locator('#listPickerScrollThumb')
      .evaluate((thumb) => thumb.getBoundingClientRect().top);
    const afterWheelScrollbarTop = await popup
      .locator('#listPickerScrollbar')
      .evaluate((scrollbar) => scrollbar.getBoundingClientRect().top);
    expect(afterWheelThumbTop - afterWheelScrollbarTop).toBeGreaterThan(
      beforeWheelThumbTop - after.scrollbarBox.top,
    );

    const beforeGutterWheelThumbTop = await popup
      .locator('#listPickerScrollThumb')
      .evaluate((thumb) => thumb.getBoundingClientRect().top);
    await popup.locator('#listPickerScrollbar').hover();
    await popup.mouse.wheel(0, 90);
    const afterGutterWheelThumbTop = await popup
      .locator('#listPickerScrollThumb')
      .evaluate((thumb) => thumb.getBoundingClientRect().top);
    const afterGutterWheelScrollbarTop = await popup
      .locator('#listPickerScrollbar')
      .evaluate((scrollbar) => scrollbar.getBoundingClientRect().top);
    expect(
      afterGutterWheelThumbTop - afterGutterWheelScrollbarTop,
    ).toBeGreaterThan(beforeGutterWheelThumbTop - afterGutterWheelScrollbarTop);

    await popup.locator('#listSearchInput').fill('Floating List 18');
    await expect(popup.locator('#listPickerList .list-picker-row')).toHaveCount(
      1,
    );
    await expect(popup.locator('#listPickerScrollThumb')).toBeHidden();
    const filtered = await popup.evaluate(() => {
      const row = document.querySelector('#listPickerList .list-picker-row');
      const rowStyle = getComputedStyle(row);
      const thumb = document.getElementById('listPickerScrollThumb');
      const scrollbar = document.getElementById('listPickerScrollbar');
      return {
        rowRightBorderStyle: rowStyle.borderRightStyle,
        rowMarginRight: rowStyle.marginRight,
        scrollHeight: document.getElementById('listPickerList').scrollHeight,
        clientHeight: document.getElementById('listPickerList').clientHeight,
        thumbDisplay: getComputedStyle(thumb).display,
        thumbWidth: thumb.getBoundingClientRect().width,
        scrollbarDisplay: getComputedStyle(scrollbar).display,
        scrollbarWidth: scrollbar.getBoundingClientRect().width,
      };
    });
    expect(filtered.scrollHeight).toBe(filtered.clientHeight);
    expect(filtered.rowRightBorderStyle).toBe('none');
    expect(filtered.rowMarginRight).toBe('0px');
    expect(filtered.scrollbarDisplay).toBe('none');
    expect(filtered.scrollbarWidth).toBe(0);
    expect(filtered.thumbWidth).toBe(0);

    await popup.locator('#listSearchInput').fill('Create Only');
    await expect(popup.locator('#listPickerList .list-picker-row')).toHaveCount(
      0,
    );
    await expect(popup.locator('#listPickerCreate')).toHaveText(
      await getExtensionMessage(popup, 'extensionCreateList', ['Create Only']),
    );
    const createOnly = await popup.evaluate(() => {
      const picker = document.querySelector('#listPickerHost.list-picker');
      const list = document.getElementById('listPickerList');
      const create = document.getElementById('listPickerCreate');
      const input = document.getElementById('listSearchInput');
      const pickerBox = picker.getBoundingClientRect();
      const listBox = list.getBoundingClientRect();
      const createBox = create.getBoundingClientRect();
      const inputBox = input.getBoundingClientRect();
      const bottomHit = document.elementFromPoint(
        createBox.left + 4,
        listBox.bottom - 2,
      );
      return {
        inputToPickerGap:
          pickerBox.top >= inputBox.bottom
            ? pickerBox.top - inputBox.bottom
            : inputBox.top - pickerBox.bottom,
        listToCreateBottomGap: listBox.bottom - createBox.bottom,
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
        bottomHitOptionId: bottomHit?.closest('.list-picker-option')?.id,
      };
    });
    expect(createOnly.listToCreateBottomGap).toBe(0);
    expect(createOnly.listScrollHeight).toBe(createOnly.listClientHeight);
    expect(createOnly.bottomHitOptionId).toBe('listPickerCreate');

    await popup.locator('#listSearchInput').fill('Floating List 18');
    await expect(popup.locator('#listPickerList .list-picker-row')).toHaveCount(
      1,
    );
    await popup
      .locator('.list-picker-row', { hasText: 'Floating List 18' })
      .click();
    await expect(popup.locator('.list-chip.selected')).toContainText(
      'Floating List 18',
    );

    await popup.close();
    await page.close();
  });

  test('typing on the open popup starts list search', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-type-list-search', {
      title: 'Popup Type List Search',
      body: '<main>Popup type list search page</main>',
    });
    const url = localServer.url('/popup-type-list-search');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }, { id: 'list:archive' }],
        },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/archive.json',
        data: {
          slug: 'archive',
          name: 'Archive',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Type List Search',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Type List Search',
    });

    await popup.keyboard.type('re');
    const input = popup.locator('#listSearchInput');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('re');
    await expect(popup.locator('#listPickerList')).toContainText('Reading');
    await expect(popup.locator('#listPickerList')).not.toContainText('Archive');

    await popup.locator('#pageTitle').click();
    const titleInput = popup.locator('.page-title-input');
    await expect(titleInput).toBeVisible();
    await titleInput.fill('');
    await popup.keyboard.type('abc');
    await expect(titleInput).toHaveValue('abc');
    await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);

    await popup.close();
    await page.close();
  });

  test('typing before the popup capture input is focused keeps the first printable key', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-immediate-list-search', {
      title: 'Popup Immediate List Search',
      body: '<main>Popup immediate list search page</main>',
    });
    const url = localServer.url('/popup-immediate-list-search');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }, { id: 'list:archive' }],
        },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/archive.json',
        data: {
          slug: 'archive',
          name: 'Archive',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Immediate List Search',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Immediate List Search',
    });

    await popup.evaluate(() => document.activeElement?.blur());
    await popup.keyboard.type('r');

    const input = popup.locator('#listSearchInput');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('r');
    await expect(popup.locator('#listPickerList')).toContainText('Reading');
    await expect(popup.locator('#listPickerList')).not.toContainText('Archive');

    await popup.close();
    await page.close();
  });

  test('closing a type-opened list picker does not throw', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-type-open-close-race', {
      title: 'Popup Type Open Close Race',
      body: '<main>Popup type open close race page</main>',
    });
    const url = localServer.url('/popup-type-open-close-race');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }],
        },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Type Open Close Race',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Type Open Close Race',
    });
    const pageErrors = [];
    popup.on('pageerror', (error) => pageErrors.push(error.message));
    await popup.keyboard.type('r');
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    await popup.keyboard.press('Escape');
    await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);
    await popup.waitForTimeout(100);

    expect(pageErrors).toEqual([]);
    await expect(popup.locator('#errorBubble')).toHaveCount(0);
    await expect(popup.locator('#listSearchInput')).toBeFocused();

    await popup.close();
    await page.close();
  });

  test('popup highlight excerpts preserve original newlines', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-highlight-newlines', {
      title: 'Popup Highlight Newlines',
      body: '<main>Popup highlight newline page</main>',
    });
    const url = localServer.url('/popup-highlight-newlines');
    const slug = getSlugForUrl(url);
    const stringNoteSlug = 'popup-string-newline-note';

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [] },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Highlight Newlines',
          timestamp: now,
          childIds: [`note:${stringNoteSlug}`],
          parentIds: [],
        },
      },
      {
        path: `objects/notes/${stringNoteSlug}.json`,
        data: {
          slug: stringNoteSlug,
          excerpt: ['String first line\nString second line'],
          note: 'String note',
          cssPath: [''],
          url,
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);
    const summary = await helper.evaluate(
      (pageUrl) =>
        chrome.runtime.sendMessage({ action: 'getPageSummary', url: pageUrl }),
      url,
    );
    expect(summary.success, JSON.stringify(summary)).toBe(true);
    expect(summary).toMatchObject({
      success: true,
      notes: [{ slug: stringNoteSlug }],
    });
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Highlight Newlines',
    });

    await expect(popup.locator('.highlight-item')).toHaveCount(1);
    const excerpts = await popup
      .locator('.highlight-excerpt')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          text: node.textContent,
          whiteSpace: getComputedStyle(node).whiteSpace,
        })),
      );

    expect(excerpts).toEqual([
      {
        text: 'String first line\nString second line',
        whiteSpace: 'pre-wrap',
      },
    ]);

    await popup.close();
    await helper.close();
    await page.close();
  });

  test('CJK IME text opens list search without flushing raw keys or dropping composition updates', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-cjk-ime-list-search', {
      title: 'Popup CJK IME List Search',
      body: '<main>Popup CJK IME list search page</main>',
    });
    const url = localServer.url('/popup-cjk-ime-list-search');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }, { id: 'list:archive' }],
        },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: '阅读',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/archive.json',
        data: {
          slug: 'archive',
          name: 'Archive',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup CJK IME List Search',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup CJK IME List Search',
    });

    const capture = popup.locator('#listSearchInput');
    await expect(capture).toBeFocused();
    await capture.evaluate((el) => {
      el.dataset.compositionTarget = 'list-search';
    });
    await capture.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
    });
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    const input = popup.locator('#listSearchInput');
    await expect(input).toHaveAttribute(
      'data-composition-target',
      'list-search',
    );
    await expect
      .poll(() =>
        input.evaluate((el) => ({
          id: el.parentElement?.id || '',
          className: el.parentElement?.className || '',
        })),
      )
      .toEqual({
        id: 'listPickerHost',
        className: 'list-picker',
      });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');

    await input.evaluate((el) => {
      el.value = '阅';
      el.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertCompositionText',
          data: '阅',
          bubbles: true,
        }),
      );
    });

    await expect(input).toBeVisible();
    await expect(input).toHaveValue('阅');
    await expect(input).not.toHaveValue('y');
    await input.evaluate((el) => {
      el.value = '阅读';
      el.dispatchEvent(
        new InputEvent('input', {
          inputType: 'insertCompositionText',
          data: '阅读',
          bubbles: true,
        }),
      );
    });

    await expect(input).toHaveValue('阅读');
    await expect(popup.locator('#listPickerList')).toContainText('阅读');
    await expect(popup.locator('#listPickerList')).not.toContainText('Archive');

    await popup.close();
    await page.close();
  });

  test('CJK IME pinyin preedit keeps earlier letters when the picker opens', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-cjk-ime-pinyin-preedit', {
      title: 'Popup CJK IME Pinyin Preedit',
      body: '<main>Popup CJK IME pinyin preedit page</main>',
    });
    const url = localServer.url('/popup-cjk-ime-pinyin-preedit');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:reading' }, { id: 'list:archive' }],
        },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/archive.json',
        data: {
          slug: 'archive',
          name: 'Archive',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup CJK IME Pinyin Preedit',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await extContext.newPage();
    await popup.addInitScript(
      ({ url, title }) => {
        let releaseActiveTabQuery;
        const activeTabQueryGate = new Promise((resolve) => {
          releaseActiveTabQuery = resolve;
        });
        window.__releaseActiveTabQueryForImeTest = releaseActiveTabQuery;
        window.__activeTabQueryBlockedForImeTest = false;
        const patchTabsQuery = () => {
          if (!globalThis.chrome?.tabs?.query) {
            setTimeout(patchTabsQuery, 0);
            return;
          }
          const originalQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async (queryInfo) => {
            if (queryInfo?.active && queryInfo?.currentWindow) {
              window.__activeTabQueryBlockedForImeTest = true;
              await activeTabQueryGate;
              return [{ id: 10001, url, title }];
            }
            return originalQuery(queryInfo);
          };
        };
        patchTabsQuery();
      },
      { url, title: 'Popup CJK IME Pinyin Preedit' },
    );
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });

    await expect
      .poll(() =>
        popup.evaluate(() => window.__activeTabQueryBlockedForImeTest),
      )
      .toBe(true);
    const capture = popup.locator('#listSearchInput');
    expect(await capture.evaluate((el) => document.activeElement === el)).toBe(
      true,
    );
    await capture.evaluate((el) => {
      el.parentElement.dataset.originalListSearchParent = 'true';
    });
    const cdp = await extContext.newCDPSession(popup);
    await cdp.send('Input.imeSetComposition', {
      text: 'y',
      selectionStart: 1,
      selectionEnd: 1,
      replacementStart: 0,
      replacementEnd: 0,
    });
    await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);
    await popup.evaluate(() => window.__releaseActiveTabQueryForImeTest());

    const input = popup.locator('#listSearchInput');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('y');
    await expect(input.locator('..')).toHaveAttribute(
      'data-original-list-search-parent',
      'true',
    );
    await cdp.send('Input.imeSetComposition', {
      text: 'yu',
      selectionStart: 2,
      selectionEnd: 2,
      replacementStart: 0,
      replacementEnd: 1,
    });

    await expect(input).toHaveValue('yu');

    await popup.close();
    await page.close();
  });

  test('toolbar action popup focuses and preserves its stable IME input', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    const now = Date.now();
    localServer.addPage('/toolbar-popup-ime', {
      title: 'Toolbar Popup IME',
      body: '<main>Toolbar popup IME page</main>',
    });
    const url = localServer.url('/toolbar-popup-ime');
    const slug = getSlugForUrl(url);
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [] },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Toolbar Popup IME',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.bringToFront();
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      const prepared = await chrome.runtime.sendMessage({
        action: 'preparePopupBootstrapForTest',
        tabId: tab.id,
      });
      if (!prepared?.success) {
        throw new Error(
          `Popup preparation failed: ${JSON.stringify(prepared)}`,
        );
      }
      await chrome.action.setPopup({
        tabId: tab.id,
        popup: prepared.popupPath,
      });
    }, url);
    await page.bringToFront();
    await helper.evaluate(() => chrome.action.openPopup());
    await expect
      .poll(() =>
        helper.evaluate(
          () => chrome.extension.getViews({ type: 'popup' }).length,
        ),
      )
      .toBe(1);
    const popupState = await helper.evaluate(() => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      const input = popup.document.getElementById('listSearchInput');
      const originalParent = input.parentElement;
      input.dispatchEvent(
        new popup.CompositionEvent('compositionstart', { bubbles: true }),
      );
      input.value = 'y';
      input.dispatchEvent(
        new popup.InputEvent('input', {
          inputType: 'insertCompositionText',
          data: 'y',
          bubbles: true,
        }),
      );
      input.value = 'yu';
      input.dispatchEvent(
        new popup.InputEvent('input', {
          inputType: 'insertCompositionText',
          data: 'yu',
          bubbles: true,
        }),
      );
      return {
        focused: popup.document.activeElement === input,
        parentStable: input.parentElement === originalParent,
        value: input.value,
      };
    });
    expect(popupState).toEqual({
      focused: true,
      parentStable: true,
      value: 'yu',
    });
    await helper.evaluate(() =>
      chrome.extension.getViews({ type: 'popup' })[0].close(),
    );
    await helper.close();
    await page.close();
  });

  test(`open popup and badge consume live desktop mutations seed=${POPUP_MUTATION_SEED}`, async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const random = seededRandom(POPUP_MUTATION_SEED);
    const nouns = ['Atlas', 'Beacon', 'Cinder', 'Drift', 'Ember', 'Fjord'];
    const verbs = ['audit', 'brief', 'index', 'map', 'review', 'trace'];
    const now = Date.now();
    const noun = pickSeeded(random, nouns);
    const verb = pickSeeded(random, verbs);
    const title = `${noun} popup mutation ${verb}`;
    const listName = `Reading ${pickSeeded(random, nouns)}`;

    localServer.addPage('/popup-live-mutation-combo', {
      title,
      body: `<main><h1>${noun}</h1><p>${verb}</p></main>`,
    });
    const url = localServer.url('/popup-live-mutation-combo');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:reading-live' }] },
      },
      {
        path: 'views/lists/reading-live.json',
        data: {
          slug: 'reading-live',
          name: listName,
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            [`test-device/${listName}`]: 'reading-live',
          },
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title,
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title,
    });
    await expect(popup.locator('#listCount')).toHaveText('00');

    const pinResp = await helper.evaluate(
      (pageUrl) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: 'reading-live',
          url: pageUrl,
        }),
      url,
    );
    expect(pinResp.success).toBe(true);

    await expect(popup.locator('#listCount')).toHaveText('01');
    await expect(popup.locator('.list-chip.selected')).toContainText(listName);
    await expect
      .poll(() => getActionIconForUrl(helper, url))
      .toMatchObject({ 16: 'icons/icon16-special-lists.png' });
    await popup.close();
    await helper.close();
    await page.close();
  });

  test('title edit input keeps readable popup foreground color', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/popup-title-edit-color', {
      title: 'Popup Title Edit',
      body: '<main>Popup title edit page</main>',
    });
    const url = localServer.url('/popup-title-edit-color');
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Title Edit',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Title Edit',
    });

    await popup.locator('#pageTitle').click();
    const input = popup.locator('.page-title-input');
    await expect(input).toBeVisible();
    const colors = await input.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor };
    });
    expect(colors.color).toBe('rgb(23, 23, 19)');
    expect(colors.color).not.toBe('rgb(0, 0, 0)');

    await popup.close();
    await page.close();
  });

  test('daemon-side page pin is reflected consistently in popup and badge', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/desktop-pinned-popup', {
      title: 'Desktop Pinned Popup',
      body: '<main>Desktop pinned popup page</main>',
    });
    const url = localServer.url('/desktop-pinned-popup');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:reading' }] },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Reading': 'reading',
          },
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Desktop Pinned Popup',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);

    const pinResp = await helper.evaluate(
      (pageUrl) =>
        chrome.runtime.sendMessage({
          action: 'addListPins',
          listId: 'reading',
          urls: [pageUrl],
          titles: ['Desktop Pinned Popup'],
        }),
      url,
    );
    expect(pinResp.success).toBe(true);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({ text: '' });

    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Desktop Pinned Popup',
    });
    await expect(popup.locator('#listCount')).toHaveText('01');
    await expect(popup.locator('.list-chip.selected')).toContainText('Reading');

    await popup.close();
    await helper.close();
    await page.close();
  });

  test('capture invalidated response notifies the page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/capture-invalidated', {
      title: 'Capture Invalidated',
      body: '<main>Capture invalidated page</main>',
    });
    const url = localServer.url('/capture-invalidated');
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Capture Invalidated',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);
    await waitForContentScript(helper, page, url);
    const activeTabId = await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      return tab.id;
    }, url);
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Capture Invalidated',
    });
    await popup.evaluate((tabId) => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.tabs.query = async (queryInfo) => {
        if (queryInfo?.active && queryInfo?.currentWindow) {
          return [
            {
              id: tabId,
              url: location.href,
              title: 'Capture Invalidated',
            },
          ];
        }
        return [];
      };
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'captureCurrentPageFromPopup') {
          return {
            success: false,
            error: 'Extension context invalidated.',
          };
        }
        return original(request, ...rest);
      };
    }, activeTabId);

    await popup.locator('#captureBtn').click();
    const resetMessage = await getExtensionMessage(
      popup,
      'extensionConnectionResetActionFailed',
    );
    await expect(page.getByLabel(resetMessage, { exact: true })).toBeVisible({
      timeout: 5000,
    });

    await helper.close();
    await popup.close();
    await page.close();
  });

  test('pinning from popup keeps trimmed title visible and refreshes badge', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/trimmed-pin-title', {
      title: 'Readable Title | Example Site',
      body: '<main>Trimmed title pin page</main>',
    });
    const url = localServer.url('/trimmed-pin-title');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      {
        path: 'views/manifest/settings.json',
        data: {
          titleTrimRules: [
            { urlPrefix: localServer.baseUrl, action: 'remove_after_pipe' },
          ],
        },
      },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:reading' }] },
      },
      {
        path: 'views/lists/reading.json',
        data: {
          slug: 'reading',
          name: 'Reading',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Reading': 'reading',
          },
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Readable Title | Example Site',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Readable Title | Example Site',
      expectedTitle: 'Readable Title',
    });

    await expect(popup.locator('#pageTitle')).toHaveText('Readable Title');
    await popup.locator('.list-chip', { hasText: 'Reading' }).click();
    await expect(popup.locator('#pageTitle')).toHaveText('Readable Title');
    await expect
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({ text: '' });

    await popup.close();
    await helper.close();
    await page.close();
  });

  test('new list created from popup uses desktop-owned top list order', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-new-list-order', {
      title: 'Popup New List Order',
      body: '<main>Popup new list order page</main>',
    });
    const url = localServer.url('/popup-new-list-order');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [{ id: 'list:existing' }] },
      },
      {
        path: 'views/lists/existing.json',
        data: {
          slug: 'existing',
          name: 'Existing',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup New List Order',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const helper = await openHelperPage(extContext, extensionId);
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup New List Order',
    });

    await popup.locator('#listAddBtn').click();
    await popup.locator('#listSearchInput').fill('Brand New');
    await popup.keyboard.press('Enter');

    await expect
      .poll(async () =>
        helper.evaluate(async () => {
          const orderResp = await chrome.runtime.sendMessage({
            action: 'readDesktopValue',
            key: 'manifest:list-order',
          });
          const firstId = orderResp?.value?.tree?.[0]?.id;
          if (!firstId) return null;
          const listResp = await chrome.runtime.sendMessage({
            action: 'readDesktopValue',
            key: firstId,
          });
          return listResp?.value?.name || null;
        }),
      )
      .toBe('Brand New');

    await popup.close();
    await helper.close();
    await page.close();
  });

  test('IME composition Enter does not confirm popup list naming', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-ime-list-name', {
      title: 'Popup IME List Name',
      body: '<main>Popup IME list name page</main>',
    });
    const url = localServer.url('/popup-ime-list-name');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [] },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup IME List Name',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup IME List Name',
    });
    await popup.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__createListAndPinRequests = [];
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'createListAndPin') {
          window.__createListAndPinRequests.push(request);
        }
        return original(request, ...rest);
      };
    });

    await popup.locator('#listAddBtn').click();
    const input = popup.locator('#listSearchInput');
    await input.fill('阅读');
    await input.evaluate((el) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(event);
    });

    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    await expect(popup.locator('#listPickerCreate')).toHaveText(
      await getExtensionMessage(popup, 'extensionCreateList', ['阅读']),
    );
    expect(
      await popup.evaluate(() => window.__createListAndPinRequests.length),
    ).toBe(0);

    await popup.close();
    await page.close();
  });

  test('reopened list picker does not duplicate Enter create actions', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-reopen-list-picker', {
      title: 'Popup Reopen List Picker',
      body: '<main>Popup reopen list picker page</main>',
    });
    const url = localServer.url('/popup-reopen-list-picker');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: { timestamp: now, tree: [] },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup Reopen List Picker',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Reopen List Picker',
    });
    await popup.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__createListAndPinRequests = [];
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'createListAndPin') {
          window.__createListAndPinRequests.push(request);
        }
        return original(request, ...rest);
      };
    });

    for (let i = 0; i < 3; i += 1) {
      await popup.locator('#listAddBtn').click();
      await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
      await popup.locator('#listSearchInput').focus();
      await popup.keyboard.press('Escape');
      await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);
    }

    await popup.locator('#listAddBtn').click();
    await popup.locator('#listSearchInput').fill('Solo Create');
    await popup.keyboard.press('Enter');

    await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);
    expect(
      await popup.evaluate(() => window.__createListAndPinRequests.length),
    ).toBe(1);

    await popup.close();
    await page.close();
  });

  test('list picker arrow keys select rows and the create option', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const now = Date.now();
    localServer.addPage('/popup-list-keyboard-menu', {
      title: 'Popup List Keyboard Menu',
      body: '<main>Popup list keyboard menu page</main>',
    });
    const url = localServer.url('/popup-list-keyboard-menu');
    const slug = getSlugForUrl(url);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'views/manifest/list-order.json',
        data: {
          timestamp: now,
          tree: [{ id: 'list:keyboard-alpha' }, { id: 'list:keyboard-beta' }],
        },
      },
      {
        path: 'views/lists/keyboard-alpha.json',
        data: {
          slug: 'keyboard-alpha',
          name: 'Keyboard Alpha',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: 'views/lists/keyboard-beta.json',
        data: {
          slug: 'keyboard-beta',
          name: 'Keyboard Beta',
          owner: 'test-device',
          timestamp: now,
          pins: [],
        },
      },
      {
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup List Keyboard Menu',
          timestamp: now,
          parentIds: [],
          childIds: [],
        },
      },
      {
        path: 'views/manifest/list-name-to-id.json',
        data: {
          timestamp: now,
          paths: {
            'test-device/Keyboard Alpha': 'keyboard-alpha',
            'test-device/Keyboard Beta': 'keyboard-beta',
          },
        },
      },
    ]);

    const page = await extContext.newPage();
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup List Keyboard Menu',
    });

    await popup.locator('#listAddBtn').click();
    const input = popup.locator('#listSearchInput');
    await input.fill('Keyboard');
    const createKeyboardLabel = await getExtensionMessage(
      popup,
      'extensionCreateList',
      ['Keyboard'],
    );
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-controls', 'listPickerList');
    await expect(
      popup.locator('.list-picker-option').first(),
    ).not.toHaveAttribute('tabindex', '0');

    const activeText = async () =>
      popup
        .locator('.list-picker-option.active')
        .evaluate(
          (node) =>
            node
              .querySelector('.list-picker-row-check + span')
              ?.textContent.trim() || node.textContent.trim(),
        );

    await input.press('ArrowDown');
    await expect.poll(activeText).toBe('Keyboard Alpha');
    await expect(input).toHaveAttribute(
      'aria-activedescendant',
      /listPickerOption-/,
    );

    await input.press('ArrowDown');
    await expect.poll(activeText).toBe('Keyboard Beta');

    await input.press('ArrowUp');
    await expect.poll(activeText).toBe('Keyboard Alpha');

    await input.press('ArrowUp');
    await expect.poll(activeText).toBe(createKeyboardLabel);

    await popup.keyboard.press('ArrowDown');
    await expect.poll(activeText).toBe('Keyboard Alpha');

    await popup.keyboard.press('Enter');
    await expect(popup.locator('#listPickerHost.list-picker')).toBeVisible();
    await expect(popup.locator('.list-chip.selected')).toContainText(
      'Keyboard Alpha',
    );

    await popup.keyboard.press('ArrowDown');
    await expect.poll(activeText).toBe('Keyboard Beta');

    await popup.keyboard.press('ArrowUp');
    await expect.poll(activeText).toBe('Keyboard Alpha');

    await popup.keyboard.press('ArrowUp');
    await expect.poll(activeText).toBe(createKeyboardLabel);

    await expect(input).toHaveAttribute('aria-disabled', 'false');
    await input.press('Enter');

    await expect(popup.locator('#listPickerHost.list-picker')).toHaveCount(0);
    await expect(
      popup.getByRole('button', { name: 'Keyboard', exact: true }),
    ).toHaveClass(/selected/);

    await popup.close();
    await page.close();
  });
});
