import { test, expect } from './fixtures.js';
import {
  getExtensionMessage,
  getSlugForUrl,
  pageCheckpointPath,
  pageEntityFixture,
  noteEntityFixture,
  openHelperPage,
  resetAndSeed,
  settingsCheckpoint,
} from './helpers.js';
import crypto from 'crypto';
import { setSnapshotIdentity } from '../../packages/core/snapshot-html.js';
import { withCleanup } from '../smoke/desktop-test-cleanup.mjs';

function snapshotSidecarPath(slug, timestamp, ext) {
  const stem = `${slug}-${timestamp}`;
  const shard = crypto
    .createHash('sha256')
    .update(stem)
    .digest()
    .subarray(0, 1)
    .toString('hex');
  return `objects/snapshots/${shard}/${stem}.${ext}`;
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
  await expect(popup.locator('#pageUrl')).toHaveText(url);
  await expect(popup.locator('#captureBtn')).toBeVisible();
  return popup;
}

for (const route of ['content receiver', 'injected fallback']) {
  test(`page errors remain copyable without a popup: ${route}`, async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }, testInfo) => {
    void setupDir;
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
    localServer.addPage('/persistent-error', {
      title: 'Persistent error',
      body: '<main>Page remains usable.</main>',
    });
    const page = await extContext.newPage();
    const helper = await openHelperPage(extContext, extensionId);
    const message =
      'Selection failed. <Diagnostic details>\n' + 'Original-error-'.repeat(60);
    await withCleanup(async () => {
      await page.goto(localServer.url('/persistent-error'));
      const tabId = await helper.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return tab.id;
      }, page.url());
      await expect
        .poll(() =>
          helper.evaluate(async (tabId) => {
            try {
              return (
                await chrome.tabs.sendMessage(tabId, {
                  action: 'getPageIdentity',
                })
              ).success;
            } catch {
              return false;
            }
          }, tabId),
        )
        .toBe(true);
      await helper.evaluate(async (tabId) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const set = globalThis.setTimeout;
            globalThis.__errorNotificationTimers = [];
            globalThis.setTimeout = (callback, delay, ...args) => {
              const id = set(callback, delay, ...args);
              if (delay > 0 && delay <= 60_000)
                globalThis.__errorNotificationTimers.push({
                  id,
                  callback: () => callback(...args),
                });
              return id;
            };
            Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: {
                writeText: async (text) => {
                  if (globalThis.__failErrorCopy)
                    throw new Error('Clipboard unavailable');
                  globalThis.__copiedErrorDetails = text;
                },
              },
            });
          },
        });
      }, tabId);
      for (const messageAction of [
        'highlightSelection',
        ...(route === 'injected fallback' ? ['showErrorNotification'] : []),
      ]) {
        expect(
          await helper.evaluate(
            (fault) =>
              chrome.runtime.sendMessage({
                action: 'failNextTabMessageForTest',
                ...fault,
              }),
            {
              tabId,
              messageAction,
              error: message,
            },
          ),
        ).toMatchObject({ success: true });
      }
      await page.bringToFront();
      expect(
        await helper.evaluate(() =>
          chrome.runtime.sendMessage({
            action: 'triggerCommandForTest',
            command: 'highlight-selection',
          }),
        ),
      ).toMatchObject({ success: false });
      await expect(page.getByLabel(message, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('page-error.png') });
      const inspect = (action) =>
        helper.evaluate(
          async ({ tabId, action }) => {
            const [result] = await chrome.scripting.executeScript({
              target: { tabId },
              func: (action) => {
                const host = document.getElementById(
                  'browser-recall-user-action-error',
                );
                const root = host && chrome.dom.openOrClosedShadowRoot(host);
                if (action === 'expire') {
                  for (const timer of globalThis.__errorNotificationTimers.splice(
                    0,
                  )) {
                    clearTimeout(timer.id);
                    timer.callback();
                  }
                }
                if (action === 'fail-copy') globalThis.__failErrorCopy = true;
                const button = root?.querySelector(
                  action === 'close'
                    ? '#dismissErrorBtn'
                    : '#copyErrorDetailsBtn',
                );
                const rect = button?.getBoundingClientRect();
                const bubble = root?.querySelector('.error-bubble');
                const text = root?.querySelector('#errorBubbleMessage');
                return {
                  connected: host?.isConnected === true,
                  copy: Boolean(root?.querySelector('#copyErrorDetailsBtn')),
                  message: text?.textContent,
                  scrollable: text && text.scrollHeight > text.clientHeight,
                  color: bubble && getComputedStyle(bubble).color,
                  background:
                    bubble && getComputedStyle(bubble).backgroundColor,
                  selection:
                    root?.getSelection?.()?.toString() ||
                    window.getSelection().toString(),
                  copied: globalThis.__copiedErrorDetails,
                  status: root?.querySelector('#errorCopyStatus')?.textContent,
                  point: rect && {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                  },
                };
              },
              args: [action],
            });
            return result.result;
          },
          { tabId, action },
        );
      expect(await inspect('read')).toMatchObject({
        copy: true,
        message,
        scrollable: true,
        color: 'rgb(255, 45, 32)',
        background: 'rgb(247, 244, 234)',
      });
      expect(await inspect('expire')).toMatchObject({ connected: true });
      const copy = (await inspect('copy')).point;
      await page.mouse.click(copy.x, copy.y);
      await expect
        .poll(async () => (await inspect('read')).copied)
        .toContain(message);
      expect((await inspect('read')).copied).toContain(page.url());
      expect((await inspect('read')).copied).toContain('Browser Recall');
      const fail = (await inspect('fail-copy')).point;
      await page.mouse.click(fail.x, fail.y);
      await expect
        .poll(async () => (await inspect('read')).status)
        .not.toBe('');
      expect((await inspect('read')).selection).toBe(message);
      if (route === 'injected fallback') {
        const capture = await helper.evaluate(() =>
          chrome.runtime.sendMessage({ action: 'captureCurrentPageFromPopup' }),
        );
        expect(capture).toMatchObject({ success: true });
        const snapshot = await helper.evaluate(
          ({ slug, timestamp }) =>
            chrome.runtime.sendMessage({
              action: 'getSnapshotHtml',
              slug,
              timestamp,
            }),
          { slug: getSlugForUrl(page.url()), timestamp: capture.timestamp },
        );
        expect(snapshot).toMatchObject({ success: true });
        expect(snapshot.html).not.toContain('browser-recall-user-action-error');
      }
      const close = (await inspect('close')).point;
      await page.mouse.click(close.x, close.y);
      await expect(page.getByLabel(message, { exact: true })).toHaveCount(0);
      expect(
        await helper.evaluate(
          () => chrome.extension.getViews({ type: 'popup' }).length,
        ),
      ).toBe(0);
    }, [() => page.close(), () => helper.close()]);
  });
}

for (const failure of ['resolved failure response', 'scripting forbidden']) {
  test(`action errors survive failed notification delivery: ${failure}`, async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
    localServer.addPage('/notification-review', {
      title: 'Notification review',
      body: '<main>Review</main>',
    });
    const page = await extContext.newPage();
    const helper = await openHelperPage(extContext, extensionId);
    const worker = extContext.serviceWorkers()[0];
    await withCleanup(async () => {
      await page.goto(localServer.url('/notification-review'));
      const tabId = await helper.evaluate(
        async (url) => (await chrome.tabs.query({ url }))[0].id,
        page.url(),
      );
      await worker.evaluate(
        ({ tabId, failure }) => {
          const send = chrome.tabs.sendMessage.bind(chrome.tabs);
          const execute = chrome.scripting.executeScript.bind(chrome.scripting);
          globalThis.errorDeliveryEvidence = {
            injections: 0,
            notifications: 0,
          };
          globalThis.restoreErrorDelivery = () => {
            chrome.tabs.sendMessage = send;
            chrome.scripting.executeScript = execute;
          };
          chrome.tabs.sendMessage = async (id, request, ...rest) => {
            if (id === tabId && request.action === 'highlightSelection')
              throw new Error(
                'Could not establish connection. Receiving end does not exist.',
              );
            if (id === tabId && request.action === 'showErrorNotification') {
              globalThis.errorDeliveryEvidence.notifications++;
              if (failure === 'resolved failure response')
                return {
                  success: false,
                  error: 'Content initialization failed',
                };
              throw new Error(
                'Could not establish connection. Receiving end does not exist.',
              );
            }
            return send(id, request, ...rest);
          };
          chrome.scripting.executeScript = async (details, ...rest) => {
            if (details.target?.tabId === tabId) {
              globalThis.errorDeliveryEvidence.injections++;
              if (failure === 'scripting forbidden')
                throw new Error('The extensions gallery cannot be scripted.');
            }
            return execute(details, ...rest);
          };
        },
        { tabId, failure },
      );
      await page.bringToFront();
      const result = await helper.evaluate(() =>
        chrome.runtime.sendMessage({
          action: 'triggerCommandForTest',
          command: 'highlight-selection',
        }),
      );
      const evidence = await worker.evaluate(
        () => globalThis.errorDeliveryEvidence,
      );

      console.log(
        'Error delivery evidence:',
        JSON.stringify({ failure, result, evidence }),
      );
      expect(evidence).toMatchObject({ notifications: 1, injections: 1 });
      if (failure === 'scripting forbidden') {
        await expect
          .poll(() =>
            helper.evaluate(() => {
              const view = chrome.extension.getViews({ type: 'popup' })[0];
              if (!view) return null;
              const doc = view.document;
              return {
                message: doc.getElementById('errorBubbleMessage')?.textContent,
                copyVisible:
                  (doc
                    .getElementById('copyErrorDetailsBtn')
                    ?.getBoundingClientRect().height || 0) > 0,
                pageUrl: doc.getElementById('pageUrl')?.textContent,
              };
            }),
          )
          .toMatchObject({
            message: expect.stringContaining(result.error),
            copyVisible: true,
            pageUrl: page.url(),
          });
        await helper.evaluate(() =>
          chrome.extension.getViews({ type: 'popup' })[0].close(),
        );
        await worker.evaluate(() => globalThis.restoreErrorDelivery());
        await page.bringToFront();
        expect(
          await helper.evaluate(() =>
            chrome.runtime.sendMessage({
              action: 'triggerCommandForTest',
              command: 'open-popup',
            }),
          ),
        ).toMatchObject({ success: true });
        await expect
          .poll(() =>
            helper.evaluate(() => {
              const doc = chrome.extension.getViews({ type: 'popup' })[0]
                ?.document;
              return (
                doc && {
                  pageUrl: doc.getElementById('pageUrl')?.textContent,
                  hasError: Boolean(doc.getElementById('errorBubble')),
                  revealed:
                    !doc.documentElement.hasAttribute('data-popup-hidden'),
                }
              );
            }),
          )
          .toMatchObject({
            pageUrl: page.url(),
            hasError: false,
            revealed: true,
          });
      } else {
        await expect(
          page.locator('#browser-recall-user-action-error'),
        ).toBeVisible();
        expect(
          await helper.evaluate(
            () => chrome.extension.getViews({ type: 'popup' }).length,
          ),
        ).toBe(0);
      }
    }, [
      () =>
        worker.evaluate(() => {
          globalThis.restoreErrorDelivery?.();
          delete globalThis.restoreErrorDelivery;
          delete globalThis.errorDeliveryEvidence;
        }),
      () =>
        helper.evaluate(() =>
          chrome.extension.getViews({ type: 'popup' })[0]?.close(),
        ),
      () => page.close(),
      () => helper.close(),
    ]);
  });
}

test('page error preserves typing focus', async ({
  extContext,
  extensionId,
  setupDir,
  localServer,
}) => {
  void setupDir;
  await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
  localServer.addPage('/notification-focus-review', {
    title: 'Focus review',
    body: '<input id="draft" aria-label="Draft">',
  });
  const page = await extContext.newPage();
  const helper = await openHelperPage(extContext, extensionId);
  await withCleanup(async () => {
    await page.goto(localServer.url('/notification-focus-review'));
    const tabId = await helper.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0].id,
      page.url(),
    );
    await expect
      .poll(() =>
        helper.evaluate(async (tabId) => {
          try {
            return (
              await chrome.tabs.sendMessage(tabId, {
                action: 'getPageIdentity',
              })
            ).success;
          } catch {
            return false;
          }
        }, tabId),
      )
      .toBe(true);
    await page.locator('#draft').fill('Draft in progress');
    expect(
      await helper.evaluate(
        (tabId) =>
          chrome.tabs.sendMessage(tabId, {
            action: 'showErrorNotification',
            message: 'Could not load saved notes.',
          }),
        tabId,
      ),
    ).toMatchObject({ success: true });
    console.log(
      'Error focus evidence:',
      await page.evaluate(() => ({
        activeId: document.activeElement.id,
        draft: document.getElementById('draft').value,
      })),
    );
    await expect(page.locator('#draft')).toBeFocused();
    await page.keyboard.type(' continues');
    await expect(page.locator('#draft')).toHaveValue(
      'Draft in progress continues',
    );
  }, [() => page.close(), () => helper.close()]);
});

test.describe('extension error popouts', () => {
  test('popup error bubble uses the paper surface', async ({
    extContext,
    extensionId,
    setupDir,
    localServer,
  }) => {
    void setupDir;
    localServer.addPage('/popup-error-paper', {
      title: 'Popup Error Paper',
      body: '<main>Popup error paper page</main>',
    });
    const url = localServer.url('/popup-error-paper');
    const slug = getSlugForUrl(url);
    const now = Date.now();

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url,
          title: 'Popup Error Paper',
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': now },
          createdAt: now,
          visitDates: [],
          scrollDepth: null,
          timeOnPage: null,
          user_title: null,
          likes: null,
        }),
      },
    ]);

    const sourcePage = await extContext.newPage();
    await sourcePage.goto(url);
    await sourcePage.waitForLoadState('load');
    const popup = await openPopupForUrl(extContext, extensionId, {
      url,
      title: 'Popup Error Paper',
    });
    await popup.evaluate(() => {
      const originalSendMessage = chrome.runtime.sendMessage.bind(
        chrome.runtime,
      );
      chrome.runtime.sendMessage = async (request, ...rest) => {
        if (request?.action === 'captureCurrentPageFromPopup') {
          return { success: false, error: 'Paper popout failure' };
        }
        return originalSendMessage(request, ...rest);
      };
      chrome.tabs.sendMessage = async () => {
        throw new Error('Receiving end does not exist.');
      };
    });

    await popup.locator('#captureBtn').click();
    const bubble = popup.locator('#errorBubble');
    await expect(bubble).toContainText('Paper popout failure');
    await expect(bubble).toHaveCSS('background-color', 'rgb(247, 244, 234)');
    await expect(bubble).toHaveCSS('color', 'rgb(255, 45, 32)');
    await expect(bubble).toHaveCSS('border-top-width', '2px');

    await popup.close();
    await sourcePage.close();
  });

  test('snapshot runtime error banner uses the paper surface', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    void setupDir;
    const originalUrl = 'https://example.com/snapshot-error-paper';
    const slug = getSlugForUrl(originalUrl);
    const timestamp = Date.now();
    const noteSlug = 'snapshot-error-paper-note';
    const highlightText = 'snapshot paper error highlight';

    await resetAndSeed(extContext, extensionId, [
      settingsCheckpoint(),
      {
        path: pageCheckpointPath(slug),
        data: pageEntityFixture({
          slug,
          url: originalUrl,
          title: 'Snapshot Error Paper',
          parentIds: [],
          childIds: [`note:${noteSlug}`, `snapshot:${slug}-${timestamp}`],
          timestamps: { 'test-device': timestamp },
          createdAt: timestamp,
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
          excerpt: [highlightText],
          note: 'snapshot note',
          cssPath: ['body > p'],
          url: originalUrl,
          deleted: false,
          deletedTs: null,
          deletionReason: null,
          replacedBy: null,
        }),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'html'),
        content: setSnapshotIdentity(
          `<!doctype html><html><head><title>Snapshot Error Paper</title></head><body><p>A saved page with ${highlightText} inside.</p></body></html>`,
          { slug, url: originalUrl },
        ),
      },
      {
        path: snapshotSidecarPath(slug, timestamp, 'md'),
        content: `A saved page with ${highlightText} inside.`,
      },
    ]);

    const viewer = await extContext.newPage();
    await viewer.goto(
      `chrome-extension://${extensionId}/snapshot-viewer.html?slug=${encodeURIComponent(slug)}&ts=${timestamp}`,
    );
    await expect(viewer.locator('iframe')).toBeVisible();
    const frame = viewer.frameLocator('iframe');
    await expect(frame.locator('mark')).toHaveText(highlightText);

    await viewer.evaluate(() => {
      chrome.runtime.sendMessage = async () => {
        throw new Error('Extension context invalidated.');
      };
    });
    await frame.locator('mark').click();

    const hint = await getExtensionMessage(viewer, 'extensionReloaded');
    await expect(viewer.locator('#snapshotRuntimeError')).toHaveAttribute(
      'aria-label',
      hint,
    );
    const surface = await viewer.evaluate(() => {
      const root = chrome.dom.openOrClosedShadowRoot(
        document.getElementById('snapshotRuntimeError'),
      );
      const bubble = root.querySelector('.error-bubble');
      const style = getComputedStyle(bubble);
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text) => {
            if (window.failSnapshotErrorCopy)
              throw new Error('Clipboard unavailable');
            window.copiedSnapshotError = text;
          },
        },
      });
      const rect = root
        .querySelector('#copyErrorDetailsBtn')
        .getBoundingClientRect();
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopWidth,
        point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      };
    });
    expect(surface).toMatchObject({
      background: 'rgb(247, 244, 234)',
      color: 'rgb(255, 45, 32)',
      border: '2px',
    });
    await viewer.mouse.click(surface.point.x, surface.point.y);
    await expect
      .poll(() => viewer.evaluate(() => window.copiedSnapshotError))
      .toContain('Extension context invalidated.');
    expect(await viewer.evaluate(() => window.copiedSnapshotError)).toContain(
      originalUrl,
    );
    await viewer.evaluate(() => {
      window.failSnapshotErrorCopy = true;
    });
    await viewer.mouse.click(surface.point.x, surface.point.y);
    expect(
      await viewer.evaluate(() => {
        const root = chrome.dom.openOrClosedShadowRoot(
          document.getElementById('snapshotRuntimeError'),
        );
        return root.getSelection().toString();
      }),
    ).toContain('Extension context invalidated.');

    await viewer.close();
  });
});
