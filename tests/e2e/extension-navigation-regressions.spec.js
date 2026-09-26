import { test, expect } from './fixtures.js';
import {
  resetAndSeed,
  settingsCheckpoint,
  openHelperPage,
  getExtensionMessage,
  getSlugForUrl,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
  waitForVisitRecorded,
  seededRandom,
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
  let lastEntries = [];
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
      if (resp?.success !== true || !Array.isArray(resp.value)) {
        throw new Error(`History read failed: ${JSON.stringify(resp)}`);
      }
      return resp.value;
    });
    lastEntries = entries;
    const match = entries.find(predicate);
    if (match) return match;
    await helper.evaluate(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
  }
  throw new Error(
    `Timed out waiting for history entry: ${JSON.stringify(lastEntries)}`,
  );
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

async function countReloadWarnings(page, reloadMessage) {
  return page
    .getByLabel(reloadMessage, { exact: true })
    .count()
    .catch(() => 0);
}

test.describe('extension navigation regressions', () => {
  test('reconciles navigation before content capture is ready without replaying superseded DOM', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addRawPage(
      '/early-navigation',
      `<!doctype html>
      <title>Early Navigation</title><main>Initial document</main>
      <script src="/hold-navigation-parser.js"></script>`,
    );
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    let releaseParser;
    let resolveParserBlocked;
    const parserBlocked = new Promise((resolve) => {
      resolveParserBlocked = resolve;
    });
    await page.route('**/hold-navigation-parser.js', (route) => {
      releaseParser = () =>
        route.fulfill({ contentType: 'text/javascript', body: '' });
      resolveParserBlocked();
    });
    await page.goto(localServer.url('/early-navigation'), {
      waitUntil: 'commit',
    });
    await parserBlocked;
    try {
      await page.waitForFunction(
        () => window.__browserRecallSpaNavigationObserverInstalled,
      );
      await page.evaluate(() =>
        history.pushState({}, '', '/early-intermediate'),
      );
      await page.evaluate(() => {
        History.prototype.pushState.call(history, {}, '', '/early-final');
        document.title = 'Final Early Destination';
      });
    } finally {
      await releaseParser();
    }
    await page.waitForLoadState('load');
    const destinationUrl = localServer.url('/early-final');
    await expect
      .poll(() => readPageEntity(helper, destinationUrl))
      .toMatchObject({
        title: 'Final Early Destination',
      });
    const intermediate = await readPageEntity(
      helper,
      localServer.url('/early-intermediate'),
    );
    expect(intermediate).toBeNull();
    await page.close();
    await helper.close();
  });

  // Exhaust quick retries without a popup identity read rescuing capture. Cover
  // diagnostic cleanup on ordinary pages and pages with saved-note markers.
  for (const [deliveryFailures, recovery] of [
    [1, 'retry'],
    [3, 'retry'],
    [3, 'new navigation'],
  ]) {
    test(`recovers browser navigation after ${deliveryFailures} failed deliveries via ${recovery}`, async ({
      extContext,
      extensionId,
      setupDir,
      localServer,
    }) => {
      localServer.addPage('/navigation-delivery', {
        title: 'Navigation Delivery',
        body: '<main>Navigation delivery recovery</main>',
      });
      const markedUrl = localServer.url('/superseding-destination');
      const markedSlug = getSlugForUrl(markedUrl);
      await resetAndSeed(extContext, extensionId, [
        settingsCheckpoint(),
        ...(recovery === 'new navigation'
          ? [
              {
                path: pageCheckpointPath(markedSlug),
                data: pageEntityFixture({
                  slug: markedSlug,
                  url: markedUrl,
                  title: 'Recovered Destination',
                  childIds: ['note:navigation-recovery-note'],
                }),
              },
              {
                path: 'objects/notes/navigation-recovery-note.json',
                data: noteEntityFixture({
                  slug: 'navigation-recovery-note',
                  url: markedUrl,
                  excerpt: ['Navigation delivery recovery'],
                  cssPath: ['main'],
                  note: '',
                }),
              },
            ]
          : []),
      ]);
      const helper = await openHelperPage(extContext, extensionId);
      const page = await extContext.newPage();
      const sourceUrl = localServer.url('/navigation-delivery');
      const destinationUrl = localServer.url('/delivery-recovered');
      let recoveredUrl = destinationUrl;
      await page.goto(sourceUrl);
      await waitForContentScript(helper, page, sourceUrl);
      await expect.poll(() => readPageEntity(helper, sourceUrl)).not.toBeNull();
      const worker = extContext.serviceWorkers()[0];
      await worker.evaluate(
        ({ url, deliveryFailures }) => {
          const original = chrome.tabs.sendMessage;
          globalThis.navigationDeliveryAttempts = 0;
          globalThis.navigationDeliveryBlocked = deliveryFailures === 3;
          globalThis.restoreNavigationDelivery = () => {
            chrome.tabs.sendMessage = original;
          };
          chrome.tabs.sendMessage = function (tabId, message, ...args) {
            if (
              message.action === 'sameDocumentNavigation' &&
              message.url === url
            ) {
              globalThis.navigationDeliveryAttempts += 1;
              if (
                globalThis.navigationDeliveryBlocked ||
                globalThis.navigationDeliveryAttempts <= deliveryFailures
              ) {
                return Promise.reject(
                  new Error('Forced missing navigation receiver'),
                );
              }
            }
            return original.call(this, tabId, message, ...args);
          };
        },
        { url: destinationUrl, deliveryFailures },
      );
      try {
        await page.evaluate((url) => {
          History.prototype.pushState.call(history, {}, '', url);
          document.title = 'Recovered Destination';
        }, destinationUrl);
        if (deliveryFailures === 3) {
          await expect
            .poll(() =>
              worker.evaluate(() => globalThis.navigationDeliveryAttempts),
            )
            .toBeGreaterThanOrEqual(3);
          await expect
            .poll(() => getBadgeForUrl(helper, destinationUrl))
            .toMatchObject({ text: '!' });
          const title = await helper.evaluate(async (url) => {
            const [tab] = await chrome.tabs.query({ url });
            return chrome.action.getTitle({ tabId: tab.id });
          }, destinationUrl);
          expect(title).toContain('Forced missing navigation receiver');
          if (recovery === 'retry') {
            // Recover without opening the popup or sending another navigation.
            await worker.evaluate(() => {
              globalThis.navigationDeliveryBlocked = false;
            });
          } else {
            const prepared = await helper.evaluate(async (url) => {
              const [tab] = await chrome.tabs.query({ url });
              return chrome.runtime.sendMessage({
                action: 'preparePopupBootstrapForTest',
                tabId: tab.id,
              });
            }, destinationUrl);
            expect(prepared.success).toBe(true);
            const popup = await extContext.newPage();
            try {
              await popup.goto(
                `chrome-extension://${extensionId}/${prepared.popupPath}`,
              );
              await expect(
                popup.locator('#pageDiagnosticMessage'),
              ).toContainText('Page navigation capture is delayed');
              await expect(
                popup.locator('#pageDiagnosticDetail'),
              ).toContainText('navigation-delivery-failed');
            } finally {
              await popup.close();
            }
            const connector = await helper.evaluate(() =>
              chrome.runtime.sendMessage({
                action: 'getDesktopConnectorState',
              }),
            );
            expect(connector.state).toBe('connected');
            // A newer URL must replace the failed observation even while the old
            // receiver remains blocked, and must clear the old tab diagnostic.
            recoveredUrl = localServer.url('/superseding-destination');
            await page.evaluate((url) => {
              History.prototype.pushState.call(history, {}, '', url);
              document.title = 'Recovered Destination';
            }, recoveredUrl);
          }
        }
        await expect
          .poll(() => readPageEntity(helper, recoveredUrl), {
            timeout: 10000,
          })
          .toMatchObject({
            title: 'Recovered Destination',
          });
        const sourceLeave = await waitForHistoryEntry(
          helper,
          (entry) => entry.url === sourceUrl && entry.action === 'leave_page',
        );
        expect(sourceLeave.title).toBe('Navigation Delivery');
        const attempts = await worker.evaluate(
          () => globalThis.navigationDeliveryAttempts,
        );
        if (deliveryFailures === 1) expect(attempts).toBe(2);
        else
          expect(attempts).toBeGreaterThanOrEqual(recovery === 'retry' ? 4 : 3);
        await expect
          .poll(() => getBadgeForUrl(helper, recoveredUrl))
          .toMatchObject({ text: '' });
        const recoveredTitle = await helper.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          return chrome.action.getTitle({ tabId: tab.id });
        }, recoveredUrl);
        expect(recoveredTitle).not.toContain(
          'Forced missing navigation receiver',
        );
      } finally {
        await worker.evaluate(() => globalThis.restoreNavigationDelivery());
        await page.close();
        await helper.close();
      }
    });
  }

  test('records a YouTube-style navigation that bypasses injected history wrappers', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    const navigationSeed = 'youtube-navigation-20260908';
    const random = seededRandom(navigationSeed);
    const videoPath = `/watch?v=${Math.floor(random() * 0xffffffff).toString(36)}`;
    console.log(`[navigation seed] ${navigationSeed}`);
    localServer.addRawPage(
      '/youtube-results',
      `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>YouTube Search Results</title>
          <script>
            window.addEventListener('DOMContentLoaded', () => {
              document.getElementById('open-video').addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('yt-navigate-start'));
                History.prototype.pushState.call(
                  history,
                  {},
                  '',
                  '${videoPath}',
                );
              });
            });
          </script>
        </head>
        <body><button id="open-video">Open video</button></body>
      </html>`,
    );

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const searchUrl = localServer.url('/youtube-results');
    const videoUrl = localServer.url(videoPath);
    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(searchUrl);
    await waitForContentScript(helper, page, searchUrl);
    await expect.poll(() => readPageEntity(helper, searchUrl)).not.toBeNull();

    const worker = extContext.serviceWorkers()[0];
    await worker.evaluate((url) => {
      const original = chrome.tabs.sendMessage;
      globalThis.navigationDelivered = false;
      chrome.tabs.sendMessage = async function (tabId, message, ...args) {
        const response = await original.call(this, tabId, message, ...args);
        if (
          message.action === 'sameDocumentNavigation' &&
          message.url === url
        ) {
          globalThis.navigationDelivered = true;
          chrome.tabs.sendMessage = original;
        }
        return response;
      };
    }, videoUrl);
    await page.click('#open-video');
    await expect(page).toHaveURL(videoUrl);
    // Hold the destination DOM until the real browser event has crossed into
    // the isolated content script. A synchronous title change hides this race.
    await expect
      .poll(() => worker.evaluate(() => globalThis.navigationDelivered))
      .toBe(true);
    await page.evaluate(() => {
      document.title = 'Browser Recall Video - YouTube';
      document.body.innerHTML = '<main>Browser Recall Video content</main>';
      document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
    });
    await expect
      .poll(async () => {
        const tabs = await helper.evaluate(() => chrome.tabs.query({}));
        const tab = tabs.find((candidate) => candidate.url === videoUrl);
        if (!tab?.id) return null;
        const response = await helper.evaluate(
          (tabId) =>
            chrome.runtime.sendMessage({ action: 'getReportedUrl', tabId }),
          tab.id,
        );
        return response.url;
      })
      .toBe(videoUrl);

    const videoVisit = await waitForHistoryEntry(
      helper,
      (entry) => entry.url === videoUrl && entry.action === 'visit_page',
    );
    expect(videoVisit).toMatchObject({
      title: 'Browser Recall Video - YouTube',
      referrerUrl: searchUrl,
    });

    const prepared = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.runtime.sendMessage({
        action: 'preparePopupBootstrapForTest',
        tabId: tab.id,
      });
    }, videoUrl);
    expect(prepared.success).toBe(true);
    const popup = await extContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/${prepared.popupPath}`);
    await expect(popup.locator('#dashboard')).toBeVisible();
    await expect(popup.locator('#pageTitle')).toHaveText(
      'Browser Recall Video - YouTube',
    );
    await expect(popup.locator('#pageUrl')).toHaveText(videoUrl);

    await popup.close();
    await page.close();
    await helper.close();
  });

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

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

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
    const flushResponse = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushDesktopQueue' }),
    );
    expect(flushResponse).toMatchObject({ success: true });

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

  test('keeps page summary available after opening a destination in a new tab', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/new-tab-source', {
      title: 'New Tab Source',
      body: '<a id="open-destination" href="/new-tab-destination" target="_blank">Open destination</a>',
    });
    localServer.addPage('/new-tab-destination', {
      title: 'New Tab Destination',
      body: '<main>Destination</main>',
    });

    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const sourceUrl = localServer.url('/new-tab-source');
    const destinationUrl = localServer.url('/new-tab-destination');
    const helper = await openHelperPage(extContext, extensionId);
    const sourcePage = await extContext.newPage();
    await sourcePage.goto(sourceUrl);
    await waitForVisitRecorded(helper, sourcePage, sourceUrl, null);

    const destinationPagePromise = extContext.waitForEvent('page');
    await sourcePage.click('#open-destination');
    const destinationPage = await destinationPagePromise;
    await destinationPage.waitForLoadState('domcontentloaded');
    await waitForVisitRecorded(
      helper,
      destinationPage,
      destinationUrl,
      sourceUrl,
    );

    const sourceEntity = await readPageEntity(helper, sourceUrl);
    expect(sourceEntity.childIds).toContain(
      `page:${getSlugForUrl(destinationUrl)}`,
    );

    const summary = await helper.evaluate(
      ({ url, title }) =>
        chrome.runtime.sendMessage({
          action: 'getPageSummary',
          url,
          title,
        }),
      { url: sourceUrl, title: 'New Tab Source' },
    );
    expect(summary.success, JSON.stringify(summary)).toBe(true);
    expect(summary.url).toBe(sourceUrl);

    await destinationPage.close();
    await sourcePage.close();
    await helper.close();
  });

  test('resets reapplied highlights after same-tab history navigation', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/spa-highlight-a', {
      title: 'SPA Highlight A',
      body: `
        <main>
          <button id="go">Go</button>
          <section id="route-a">
            <p id="alpha">Alpha route highlighted text.</p>
          </section>
          <section id="route-b" hidden>
            <p id="beta">Beta route highlighted text.</p>
          </section>
        </main>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/spa-highlight-b');
            document.title = 'SPA Highlight B';
            document.getElementById('route-a').hidden = true;
            document.getElementById('route-b').hidden = false;
          });
        </script>
      `,
    });

    const firstUrl = localServer.url('/spa-highlight-a');
    const secondUrl = localServer.url('/spa-highlight-b');
    const firstSlug = getSlugForUrl(firstUrl);
    const secondSlug = getSlugForUrl(secondUrl);
    const firstNoteSlug = 'note-spa-highlight-a';
    const secondNoteSlug = 'note-spa-highlight-b';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(firstSlug),
        data: pageEntityFixture({
          slug: firstSlug,
          url: firstUrl,
          title: 'SPA Highlight A',
          childIds: [`note:${firstNoteSlug}`],
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
        path: `objects/notes/${firstNoteSlug}.json`,
        data: noteEntityFixture({
          slug: firstNoteSlug,
          excerpt: ['Alpha route highlighted text.'],
          note: '',
          cssPath: ['p#alpha'],
          url: firstUrl,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: pageCheckpointPath(secondSlug),
        data: pageEntityFixture({
          slug: secondSlug,
          url: secondUrl,
          title: 'SPA Highlight B',
          childIds: [`note:${secondNoteSlug}`],
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
        path: `objects/notes/${secondNoteSlug}.json`,
        data: noteEntityFixture({
          slug: secondNoteSlug,
          excerpt: ['Beta route highlighted text.'],
          note: '',
          cssPath: ['p#beta'],
          url: secondUrl,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(firstUrl);
    await waitForContentScript(helper, page, firstUrl);

    await expect(
      page.locator('#alpha mark.browser-recall-highlight'),
    ).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(
      page.locator('#beta mark.browser-recall-highlight'),
    ).toHaveCount(0);

    await page.click('#go');
    await expect(page).toHaveURL(secondUrl);

    await expect(
      page.locator('#alpha mark.browser-recall-highlight'),
    ).toHaveCount(0);
    await expect(
      page.locator('#beta mark.browser-recall-highlight'),
    ).toHaveCount(1, {
      timeout: 5000,
    });
    await expect(
      page.locator('#beta mark.browser-recall-highlight'),
    ).toHaveAttribute('data-note-slug', secondNoteSlug);

    await page.close();
    await helper.close();
  });

  test('clears reapplied highlights before same-tab navigation enters a pdf url', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/spa-highlight-pdf', {
      title: 'SPA Highlight PDF',
      body: `
        <main>
          <button id="go">Go</button>
          <p id="alpha">Alpha route highlighted text.</p>
        </main>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/spa-highlight-pdf-view.pdf');
            document.title = 'SPA Highlight PDF View';
          });
        </script>
      `,
    });

    const pageUrl = localServer.url('/spa-highlight-pdf');
    const pdfUrl = localServer.url('/spa-highlight-pdf-view.pdf');
    const slug = getSlugForUrl(pageUrl);
    const noteSlug = 'note-spa-highlight-pdf';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: pageUrl,
          title: 'SPA Highlight PDF',
          childIds: [`note:${noteSlug}`],
          parentIds: [],
          timestamps: { 'test-device': now },
        }),
      },
      {
        path: `objects/notes/${noteSlug}.json`,
        data: noteEntityFixture({
          slug: noteSlug,
          excerpt: ['Alpha route highlighted text.'],
          note: '',
          cssPath: ['p#alpha'],
          url: pageUrl,
        }),
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(pageUrl);
    await waitForContentScript(helper, page, pageUrl);

    await expect(
      page.locator('#alpha mark.browser-recall-highlight'),
    ).toHaveCount(1, {
      timeout: 5000,
    });

    await page.click('#go');
    await expect(page).toHaveURL(pdfUrl);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(0);

    await page.close();
    await helper.close();
  });

  test('ignores stale highlight note loads after rapid same-tab history navigation', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    localServer.addPage('/spa-stale-highlight-a', {
      title: 'SPA Stale Highlight A',
      body: `
        <main>
          <button id="go">Go</button>
          <p id="shared">Initial route text.</p>
        </main>
        <script>
          document.getElementById('go').addEventListener('click', () => {
            history.pushState({}, '', '/spa-stale-highlight-b');
            document.title = 'SPA Stale Highlight B';
            document.getElementById('shared').textContent = 'Shared stale highlighted text.';
            setTimeout(() => {
              history.pushState({}, '', '/spa-stale-highlight-c');
              document.title = 'SPA Stale Highlight C';
              document.getElementById('shared').textContent = 'Shared stale highlighted text.';
            }, 0);
          });
        </script>
      `,
    });

    const firstUrl = localServer.url('/spa-stale-highlight-a');
    const secondUrl = localServer.url('/spa-stale-highlight-b');
    const thirdUrl = localServer.url('/spa-stale-highlight-c');
    const secondSlug = getSlugForUrl(secondUrl);
    const thirdSlug = getSlugForUrl(thirdUrl);
    const staleNoteSlug = 'note-spa-stale-highlight-b';
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(secondSlug),
        data: pageEntityFixture({
          slug: secondSlug,
          url: secondUrl,
          title: 'SPA Stale Highlight B',
          childIds: [`note:${staleNoteSlug}`],
          parentIds: [],
          timestamps: { 'test-device': now },
        }),
      },
      {
        path: `objects/notes/${staleNoteSlug}.json`,
        data: noteEntityFixture({
          slug: staleNoteSlug,
          excerpt: ['Shared stale highlighted text.'],
          note: '',
          cssPath: ['p#shared'],
          url: secondUrl,
        }),
      },
      {
        path: pageCheckpointPath(thirdSlug),
        data: pageEntityFixture({
          slug: thirdSlug,
          url: thirdUrl,
          title: 'SPA Stale Highlight C',
          childIds: [],
          parentIds: [],
          timestamps: { 'test-device': now },
        }),
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const page = await extContext.newPage();
    await page.goto(firstUrl);
    await waitForContentScript(helper, page, firstUrl);
    await helper.evaluate(
      async ({ pageUrl, delayedSlug }) => {
        const [tab] = await chrome.tabs.query({ url: pageUrl });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          args: [delayedSlug],
          func: (slugToDelay) => {
            const originalSendMessage = chrome.runtime.sendMessage.bind(
              chrome.runtime,
            );
            chrome.runtime.sendMessage = (message, ...rest) => {
              if (
                message?.action === 'loadPageNotes' &&
                message.slug === slugToDelay
              ) {
                return new Promise((resolve, reject) => {
                  setTimeout(() => {
                    originalSendMessage(message, ...rest).then(resolve, reject);
                  }, 350);
                });
              }
              return originalSendMessage(message, ...rest);
            };
          },
        });
      },
      { pageUrl: firstUrl, delayedSlug: secondSlug },
    );

    await page.click('#go');
    await expect(page).toHaveURL(thirdUrl);
    await page.waitForTimeout(500);
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(0);

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
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(listedSlug),
        data: pageEntityFixture({
          slug: listedSlug,
          url: listedUrl,
          title: 'Listed SPA',
          childIds: [],
          parentIds: ['list:reading'],
          timestamps: { 'test-device': Date.now() },
        }),
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
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(originalSlug),
        data: pageEntityFixture({
          slug: originalSlug,
          url: originalUrl,
          title: 'Query SPA',
          childIds: [],
          parentIds: ['list:reading'],
          timestamps: { 'test-device': Date.now() },
        }),
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

    await expect
      .poll(() =>
        helper.evaluate(
          (id) =>
            chrome.runtime.sendMessage({ action: 'getReportedUrl', tabId: id }),
          tabId,
        ),
      )
      .toMatchObject({ success: true, url: originalUrl });
    // The browser URL and empty badge can settle before the visit report.
    // Hold that report until the first read to exercise this ordering on every host.
    await helper.evaluate(
      ({ tabId, updatedUrl }) =>
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          args: [updatedUrl],
          func: (url) => {
            const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
            const ready = new Promise((resolve) => {
              globalThis.releaseQueryVisitForTest = () => {
                chrome.runtime.sendMessage = sendMessage;
                resolve();
              };
            });
            chrome.runtime.sendMessage = (message, ...args) => {
              if (
                message.action === 'recordPageActivity' &&
                message.isInitialLoad &&
                message.url === url
              ) {
                return ready.then(() => sendMessage(message, ...args));
              }
              return sendMessage(message, ...args);
            };
          },
        }),
      { tabId, updatedUrl },
    );

    await page.click('#go');
    await expect(page).toHaveURL(updatedUrl);

    await expect
      .poll(() => getActiveTabBadge(helper))
      .toMatchObject({
        url: updatedUrl,
        text: '',
      });

    await expect
      .poll(() =>
        helper.evaluate(async (id) => {
          const response = await chrome.runtime.sendMessage({
            action: 'getReportedUrl',
            tabId: id,
          });
          await chrome.scripting.executeScript({
            target: { tabId: id },
            world: 'ISOLATED',
            func: () => globalThis.releaseQueryVisitForTest(),
          });
          return response;
        }, tabId),
      )
      .toMatchObject({ success: true, url: updatedUrl });
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
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const helper = await openHelperPage(extContext, extensionId);
    const reloadMessage = await getExtensionMessage(
      helper,
      'extensionReloaded',
    );
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

    await expect(page.getByLabel(reloadMessage, { exact: true })).toBeVisible();

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
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const helper = await openHelperPage(extContext, extensionId);
    const reloadMessage = await getExtensionMessage(
      helper,
      'extensionReloaded',
    );
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

    await expect(page.getByLabel(reloadMessage, { exact: true })).toBeVisible();
    await expect(page.locator('mark.browser-recall-highlight')).toHaveCount(0);

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
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const helper = await openHelperPage(extContext, extensionId);
    const reloadMessage = await getExtensionMessage(
      helper,
      'extensionReloaded',
    );
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

    expect(await countReloadWarnings(page, reloadMessage)).toBe(0);

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
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);

    const helper = await openHelperPage(extContext, extensionId);
    const reloadMessage = await getExtensionMessage(
      helper,
      'extensionReloaded',
    );
    const likedMessage = await getExtensionMessage(helper, 'extensionLiked');
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

    await expect(page.getByLabel(likedMessage, { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await countReloadWarnings(page, reloadMessage)).toBe(0);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(300);
    expect(await countReloadWarnings(page, reloadMessage)).toBe(0);

    const pageEntity = await helper.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
      `page:${slug}`,
    );
    expect(pageEntity?.value?.likes || 0).toBe(1);

    await page.close();
    await helper.close();
  });
});
