import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, getSlugForUrl } from './helpers.js';

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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${listedSlug}.json`,
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
      .toMatchObject({ text: ' ', color: [76, 175, 80, 255] });

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
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: `pages/${originalSlug}.json`,
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
      .toMatchObject({ text: ' ', color: [76, 175, 80, 255] });

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
});
