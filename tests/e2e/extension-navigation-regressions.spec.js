import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  openHelperPage,
  getSlugForUrl,
  pageCheckpointPath,
} from './helpers.js';

async function readPageEntity(helper, url) {
  const slug = getSlugForUrl(url);
  const response = await helper.evaluate(
    (key) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
    `page:${slug}`,
  );
  return response?.value || null;
}

async function waitForPageEntity(helper, url, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entity = await readPageEntity(helper, url);
    if (entity?.timestamps) return entity;
    await helper.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
  }
  return null;
}

async function waitForHistoryEntry(helper, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await helper.evaluate(async () => {
      await chrome.runtime.sendMessage({ action: 'flushDesktopQueue' });
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
        2,
        '0',
      )}-${String(now.getDate()).padStart(2, '0')}`;
      const resp = await chrome.runtime.sendMessage({
        action: 'readDesktopValue',
        key: `log:${today}`,
      });
      return resp?.value || [];
    });
    const match = entries.find(predicate);
    if (match) return match;
    await helper.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
  }
  return null;
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

async function getActiveTabBadge(helper) {
  return helper.evaluate(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id) return { url: null, text: '', color: null };
    return {
      url: tab.url,
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
    };
  });
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

async function countReloadWarnings(page) {
  return page
    .locator('[aria-label*="reload the page"]')
    .count()
    .catch(() => 0);
}

test.describe('extension same-tab navigation regressions', () => {
  test('records a new page visit after same-tab history navigation', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/spa-entry', {
      title: 'SPA Entry',
      body: `
        <a id="to-spa" href="/spa-a">Open SPA</a>
      `,
    });
    localServer.addPage('/spa-a', {
      title: 'SPA A',
      body: `
        <h1>SPA A</h1>
        <button id="go">Go</button>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/spa-b');
            document.title = 'SPA B';
            document.body.insertAdjacentHTML('beforeend', '<h2>SPA B</h2>');
          });
        </script>
      `,
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const entryUrl = localServer.url('/spa-entry');
    const firstUrl = localServer.url('/spa-a');
    const secondUrl = localServer.url('/spa-b');
    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(entryUrl);
    await page.click('#to-spa');
    await expect(page).toHaveURL(firstUrl);
    await waitForContentScript(helper, page, firstUrl);
    await expect.poll(() => readPageEntity(helper, firstUrl)).not.toBeNull();
    await page.waitForTimeout(100);

    await page.click('#go');
    await expect(page).toHaveURL(secondUrl);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueue' }),
    );

    const secondEntity = await waitForPageEntity(helper, secondUrl);
    expect(secondEntity).toMatchObject({
      url: secondUrl,
      title: 'SPA B',
    });

    const secondVisit = await waitForHistoryEntry(
      helper,
      (entry) => entry.url === secondUrl && entry.action === 'visit_page',
    );
    expect(secondVisit).toMatchObject({
      url: secondUrl,
      action: 'visit_page',
      referrerUrl: firstUrl,
    });

    const firstLeave = await waitForHistoryEntry(
      helper,
      (entry) =>
        entry.url === firstUrl &&
        entry.action === 'leave_page' &&
        Number.isFinite(entry.timeOnPage),
    );
    expect(firstLeave).toMatchObject({
      url: firstUrl,
      action: 'leave_page',
    });

    await page.close();
    await helper.close();
  });

  test('clears a page marker badge when same-tab history navigation leaves a listed page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/listed-spa', {
      title: 'Listed SPA',
      body: `
        <h1>Listed SPA</h1>
        <button id="go">Go</button>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/normal-spa');
            document.title = 'Normal SPA';
          });
        </script>
      `,
    });

    const listedUrl = localServer.url('/listed-spa');
    const normalUrl = localServer.url('/normal-spa');
    const listedSlug = getSlugForUrl(listedUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(listedSlug),
        data: {
          slug: listedSlug,
          url: listedUrl,
          title: 'Listed SPA',
          childIds: [],
          parentIds: ['list:reading'],
          timestamps: { 'test-device': Date.now() },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(listedUrl);
    await page.waitForLoadState('domcontentloaded');
    await waitForContentScript(helper, page, listedUrl);

    await expect
      .poll(() => getBadgeForUrl(helper, listedUrl))
      .toMatchObject({ text: '' });

    await page.click('#go');
    await expect(page).toHaveURL(normalUrl);

    await expect
      .poll(() => getActiveTabBadge(helper))
      .toMatchObject({
        url: normalUrl,
        text: '',
      });

    await page.close();
    await helper.close();
  });

  test('records query-only same-tab history updates as new visits while keeping hash anchors attached', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/query-spa', {
      title: 'Query SPA',
      body: `
        <h1>Query SPA</h1>
        <button id="go">Go</button>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/query-spa?extra=1&pp=abc');
            document.title = 'Query SPA Updated';
          });
        </script>
      `,
    });

    const originalUrl = localServer.url('/query-spa');
    const updatedUrl = localServer.url('/query-spa?extra=1&pp=abc');
    const hashUrl = localServer.url('/query-spa?extra=1&pp=abc#section');
    const originalSlug = getSlugForUrl(originalUrl);
    const updatedSlug = getSlugForUrl(updatedUrl);

    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
      {
        path: pageCheckpointPath(originalSlug),
        data: {
          slug: originalSlug,
          url: originalUrl,
          title: 'Query SPA',
          childIds: [],
          parentIds: ['list:reading'],
          timestamps: { 'test-device': Date.now() },
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(originalUrl);
    await waitForContentScript(helper, page, originalUrl);

    await expect
      .poll(() => getBadgeForUrl(helper, originalUrl))
      .toMatchObject({ text: '' });

    const tabId = await helper.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl });
      return tabs[0]?.id || null;
    }, originalUrl);
    expect(tabId).toBeTruthy();

    await page.click('#go');
    await expect(page).toHaveURL(updatedUrl);

    await expect
      .poll(() => getActiveTabBadge(helper))
      .toMatchObject({
        url: updatedUrl,
        text: '',
      });

    const reportedResp = await helper.evaluate((id) => {
      return chrome.runtime.sendMessage({
        action: 'getReportedUrl',
        tabId: id,
      });
    }, tabId);
    expect(reportedResp).toMatchObject({ success: true, url: updatedUrl });
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueue' }),
    );
    await expect
      .poll(async () => await readPageEntity(helper, updatedUrl))
      .toMatchObject({
        slug: updatedSlug,
        url: updatedUrl,
        title: 'Query SPA Updated',
      });

    await page.evaluate(() => {
      history.pushState({}, '', '/query-spa?extra=1&pp=abc#section');
      document.title = 'Query SPA Hash';
    });
    await expect(page).toHaveURL(hashUrl);
    await expect
      .poll(() => getActiveTabBadge(helper))
      .toMatchObject({
        url: hashUrl,
        text: '',
      });
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueue' }),
    );
    expect(await readPageEntity(helper, hashUrl)).toBeNull();

    await page.close();
    await helper.close();
  });

  test('content script surfaces runtime reload failures to the page', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/runtime-invalidated', {
      title: 'Runtime Invalidated',
      body: '<main><p id="target">Runtime reload highlighted text</p></main>',
    });
    const url = localServer.url('/runtime-invalidated');
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    await waitForContentScript(helper, page, url);
    await page.evaluate(() => {
      const target = document.getElementById('target');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          chrome.runtime.sendMessage = () =>
            Promise.reject(
              new Error('requestStorageAccessFor: Permission denied.'),
            );
        },
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, url);

    await expect(page.locator('[aria-label*="reload the page"]')).toBeVisible();

    await page.close();
    await helper.close();
  });

  test('content script shows reload hint when highlight save returns a port failure', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/runtime-failed-response-highlight', {
      title: 'Runtime Failed Response Highlight',
      body: '<main><p id="target">Port failure highlighted text</p></main>',
    });
    const url = localServer.url('/runtime-failed-response-highlight');
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    await waitForContentScript(helper, page, url);
    await page.evaluate(() => {
      const target = document.getElementById('target');
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          chrome.runtime.sendMessage = () =>
            Promise.resolve({
              success: false,
              error:
                'Could not establish connection. Receiving end does not exist.',
            });
        },
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, url);

    await expect(page.locator('[aria-label*="reload the page"]')).toBeVisible();
    await expect(page.locator('mark.portal-highlight')).toHaveCount(0);

    await page.close();
    await helper.close();
  });

  test('content script shows reload hint when page note cannot load after runtime reload', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/runtime-invalidated-page-note', {
      title: 'Runtime Invalidated Page Note',
      body: '<main><p>No selected text opens a page note.</p></main>',
    });
    const url = localServer.url('/runtime-invalidated-page-note');
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    await waitForContentScript(helper, page, url);
    await page.evaluate(() => getSelection().removeAllRanges());
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          chrome.runtime.sendMessage = () =>
            Promise.reject(
              new Error(
                "The service worker navigation preload request was cancelled before 'preloadResponse' settled.",
              ),
            );
        },
      });
      await chrome.tabs.sendMessage(tab.id, { action: 'highlightSelection' });
    }, url);

    await expect(page.locator('[aria-label*="reload the page"]')).toBeVisible();
    await expect(page.locator('#portal-highlight-overlay')).toHaveCount(0);

    await page.close();
    await helper.close();
  });

  test('passive page activity failure after extension reload does not show reload warning', async ({
    extContext,
    extensionId,
    localServer,
  }) => {
    localServer.addPage('/passive-runtime-failure', {
      title: 'Passive Runtime Failure',
      body: '<main><p>Passive runtime failure page</p></main>',
    });
    const url = localServer.url('/passive-runtime-failure');
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    await waitForContentScript(helper, page, url);
    await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          chrome.runtime.sendMessage = () =>
            Promise.reject(
              new Error('Extension context invalidated. Please refresh.'),
            );
        },
      });
    }, url);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);

    expect(await countReloadWarnings(page)).toBe(0);

    await page.close();
    await helper.close();
  });

  test('successful like command after extension reload does not warn on stale page channel or refresh', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/like-runtime-failure', {
      title: 'Like Runtime Failure',
      body: '<main><p>Like runtime failure page</p></main>',
    });
    const url = localServer.url('/like-runtime-failure');
    const slug = getSlugForUrl(url);
    await resetAndSeed(extContext, extensionId, [
      { path: 'views/manifest/settings.json', data: { trimRules: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(url);
    await waitForContentScript(helper, page, url);
    const tabId = await helper.evaluate(async (pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          chrome.runtime.sendMessage = () =>
            Promise.reject(
              new Error('Extension context invalidated. Please refresh.'),
            );
        },
      });
      return tab.id;
    }, url);
    const failResp = await helper.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          action: 'failNextTabMessageForTest',
          tabId: id,
          messageAction: 'showLikeNotification',
          error: 'Injected showLikeNotification failure',
        }),
      tabId,
    );
    expect(failResp.success).toBe(true);
    await page.bringToFront();

    const commandResp = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'triggerCommandForTest',
        command: 'like-page',
      }),
    );
    expect(commandResp.success).toBe(true);

    await expect(page.locator('[aria-label="Liked"]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await countReloadWarnings(page)).toBe(0);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    expect(await countReloadWarnings(page)).toBe(0);

    const pageEntity = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
      `page:${slug}`,
    );
    expect(pageEntity?.value?.likes || 0).toBe(1);

    await page.close();
    await helper.close();
  });
});
