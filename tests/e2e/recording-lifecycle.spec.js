import { test, expect } from './fixtures.js';
import { resetAndSeed, settingsCheckpoint, openHelperPage } from './helpers.js';

async function setPaused(helper, paused) {
  const response = await helper.evaluate(
    (paused) =>
      chrome.runtime.sendMessage({ action: 'setRecordingPaused', paused }),
    paused,
  );
  if (!response?.success)
    throw new Error(response?.error || 'Could not change recording state');
}
async function identity(helper, url) {
  return helper.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    try {
      return await chrome.tabs.sendMessage(tab.id, {
        action: 'getPageIdentity',
      });
    } catch (error) {
      if (error.message.includes('Receiving end does not exist')) return null;
      throw error;
    }
  }, url);
}
async function history(helper) {
  return helper.evaluate(async () => {
    const flush = await chrome.runtime.sendMessage({
      action: 'flushDesktopQueue',
    });
    if (!flush?.success) throw new Error(flush?.error || 'Flush failed');
    const now = new Date();
    const day = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const response = await chrome.runtime.sendMessage({
      action: 'readDesktopValue',
      key: `log:${day}`,
    });
    if (!response?.success || !Array.isArray(response.value))
      throw new Error(response?.error || 'History failed');
    return response.value;
  });
}

test('slow tab opened while paused remains excluded when recording resumes during loading', async ({
  extContext,
  extensionId,
  localServer,
}) => {
  await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
  localServer.addPage('/gap-paused-slow-load', {
    title: 'Slow paused document',
    body: '<main>Slow document</main>',
  });
  const url = localServer.url('/gap-paused-slow-load');
  const helper = await openHelperPage(extContext, extensionId);
  const page = await extContext.newPage();
  let release, arrived;
  const gate = new Promise((resolve) => (release = resolve));
  const seen = new Promise((resolve) => (arrived = resolve));
  await page.route(url, async (route) => {
    arrived();
    await gate;
    await route.continue();
  });
  let navigation;
  try {
    await setPaused(helper, true);
    navigation = page.goto(url);
    await seen;
    await setPaused(helper, false);
    release();
    await navigation;
    await expect
      .poll(() => identity(helper, url))
      .toMatchObject({ success: true });
    const current = await identity(helper, url);
    const entries = (await history(helper)).filter(
      (entry) => entry.url === url,
    );
    console.log(
      'Slow-load recording evidence:',
      JSON.stringify({ current, entries }),
    );
    expect(current.recordingEligible).toBe(false);
    expect(entries).toEqual([]);
    // Force the automatic-report path even though the excluded content script
    // normally suppresses it. The background must enforce eligibility itself.
    const forced = await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      const { recordingRuntime } = await chrome.storage.session.get([
        'recordingRuntime',
      ]);
      const token = recordingRuntime.current[tab.id];
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        args: [token, url],
        func: (token, url) =>
          chrome.runtime.sendMessage({
            action: 'recordPageActivity',
            recordingDocumentToken: token,
            url,
            title: 'Forced excluded visit',
            isInitialLoad: true,
          }),
      });
      return execution.result;
    }, url);
    expect(forced).toMatchObject({ success: true });
    expect(
      (await history(helper)).filter((entry) => entry.url === url),
    ).toEqual([]);
  } finally {
    release();
    await navigation?.catch(() => {});
    await setPaused(helper, false);
    await page.close();
    await helper.close();
  }
});

test('attention reports exclude paused time without resetting active time', async ({
  extContext,
  extensionId,
  localServer,
}) => {
  await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
  localServer.addPage('/gap-paused-attention', {
    title: 'Paused attention',
    body: '<main>Attention</main>',
  });
  const url = localServer.url('/gap-paused-attention');
  const helper = await openHelperPage(extContext, extensionId);
  const page = await extContext.newPage();
  try {
    await page.goto(url);
    await expect
      .poll(() => identity(helper, url))
      .toMatchObject({ success: true });
    await expect
      .poll(
        async () =>
          (await history(helper)).filter(
            (entry) => entry.url === url && entry.action === 'visit_page',
          ).length,
      )
      .toBe(1);
    const worker = extContext.serviceWorkers()[0];
    await worker.evaluate(() => {
      globalThis.restoreRecordingClock = Date.now;
      globalThis.recordingClockOffset = 1000;
      Date.now = () =>
        globalThis.restoreRecordingClock() + globalThis.recordingClockOffset;
    });
    await setPaused(helper, true);
    await worker.evaluate(() => {
      globalThis.recordingClockOffset += 60000;
    });
    await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          const realNow = Date.now.bind(Date);
          Date.now = () => realNow() + 60000;
        },
      });
    }, url);
    await setPaused(helper, false);
    await worker.evaluate(() => {
      globalThis.recordingClockOffset += 2000;
    });
    await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await expect
      .poll(
        async () =>
          (await history(helper)).filter(
            (entry) => entry.url === url && entry.action === 'leave_page',
          ).length,
      )
      .toBeGreaterThan(0);
    const entries = (await history(helper)).filter(
      (entry) => entry.url === url && entry.action === 'leave_page',
    );
    console.log('Paused-time recording evidence:', JSON.stringify(entries));
    expect(entries.at(-1).timeOnPage).toBeGreaterThanOrEqual(3000);
    expect(entries.at(-1).timeOnPage).toBeLessThan(5000);
  } finally {
    const worker = extContext.serviceWorkers()[0];
    await worker.evaluate(() => {
      if (globalThis.restoreRecordingClock)
        Date.now = globalThis.restoreRecordingClock;
    });
    await setPaused(helper, false);
    await page.close();
    await helper.close();
  }
});

async function restartBackgroundWorker(context, helper, extensionId) {
  const session = await context.newCDPSession(helper);
  const sentinel = `recording-restart-${Date.now()}`;
  await context.serviceWorkers()[0].evaluate((value) => {
    globalThis.recordingRestartSentinel = value;
  }, sentinel);
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    const target = targetInfos.find(
      (target) =>
        target.type === 'service_worker' && target.url.includes(extensionId),
    );
    expect(target).toBeTruthy();
    let versions = [];
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
      versions = event.versions;
    });
    await session.send('ServiceWorker.enable');
    await expect
      .poll(
        () =>
          versions.find((version) => version.scriptURL === target.url)
            ?.versionId,
      )
      .toBeTruthy();
    const version = versions.find(
      (version) => version.scriptURL === target.url,
    );
    await session.send('ServiceWorker.stopWorker', {
      versionId: version.versionId,
    });
    await expect
      .poll(async () => {
        try {
          return await helper.evaluate(() =>
            chrome.runtime.sendMessage({ action: 'getRecordingState' }),
          );
        } catch {
          return null;
        }
      })
      .toMatchObject({ success: true });
    await expect
      .poll(async () => {
        try {
          return await context
            .serviceWorkers()[0]
            .evaluate(() => globalThis.recordingRestartSentinel);
        } catch {
          return sentinel;
        }
      })
      .not.toBe(sentinel);
  } finally {
    await session.detach();
  }
}

test('background restart retains paused navigation eligibility and active attention', async ({
  extContext,
  extensionId,
  localServer,
}) => {
  await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
  localServer.addPage('/recording-active-restart', {
    title: 'Active restart',
    body: '<main>Active document</main>',
  });
  localServer.addPage('/recording-paused-restart', {
    title: 'Paused restart',
    body: '<main>Paused document</main>',
  });
  const helper = await openHelperPage(extContext, extensionId);
  const active = await extContext.newPage();
  const paused = await extContext.newPage();
  const activeUrl = localServer.url('/recording-active-restart');
  const pausedUrl = localServer.url('/recording-paused-restart');
  let release, arrived;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    arrived = resolve;
  });
  await paused.route(pausedUrl, async (route) => {
    arrived();
    await gate;
    await route.continue();
  });
  let navigation;
  try {
    await active.goto(activeUrl);
    await expect
      .poll(() => identity(helper, activeUrl))
      .toMatchObject({ success: true, recordingEligible: true });
    await setPaused(helper, true);
    navigation = paused.goto(pausedUrl);
    await seen;
    await restartBackgroundWorker(extContext, helper, extensionId);
    await setPaused(helper, false);
    release();
    await navigation;
    await expect
      .poll(() => identity(helper, pausedUrl))
      .toMatchObject({ success: true, recordingEligible: false });
    expect(
      (await history(helper)).filter((entry) => entry.url === pausedUrl),
    ).toEqual([]);
    await active.bringToFront();
    await active.evaluate(() => document.dispatchEvent(new Event('resume')));
    await active.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await expect
      .poll(
        async () =>
          (await history(helper)).filter(
            (entry) => entry.url === activeUrl && entry.action === 'leave_page',
          ).length,
      )
      .toBeGreaterThan(0);
    await paused.reload();
    await expect
      .poll(() => identity(helper, pausedUrl))
      .toMatchObject({ success: true, recordingEligible: true });
    await expect
      .poll(
        async () =>
          (await history(helper)).filter(
            (entry) => entry.url === pausedUrl && entry.action === 'visit_page',
          ).length,
      )
      .toBe(1);
  } finally {
    release();
    await navigation?.catch(() => {});
    await setPaused(helper, false);
    await active.close();
    await paused.close();
    await helper.close();
  }
});

test('page identity and snapshot capture wait for document recording initialization', async ({
  extContext,
  extensionId,
  localServer,
}) => {
  await resetAndSeed(extContext, extensionId, [settingsCheckpoint()]);
  localServer.addPage('/recording-initialization', {
    title: 'Recording initialization',
    body: '<main>Startup capture</main><script defer src="/held-startup-script.js"></script>',
  });
  const helper = await openHelperPage(extContext, extensionId);
  const page = await extContext.newPage();
  let releaseScript, arrived;
  const gate = new Promise((resolve) => {
    releaseScript = resolve;
  });
  const seen = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route('**/held-startup-script.js', async (route) => {
    arrived();
    await gate;
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  let navigation;
  try {
    navigation = page.goto(localServer.url('/recording-initialization'));
    await seen;
    await helper.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      globalThis.recordingInitializationTabId = tab.id;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        injectImmediately: true,
        func: () => {
          const original = chrome.runtime.sendMessage.bind(chrome.runtime);
          const ready = new Promise((resolve) => {
            globalThis.releaseRecordingInitialization = resolve;
          });
          chrome.runtime.sendMessage = async (request, ...args) => {
            if (request.action === 'initializePageRecording') {
              globalThis.recordingInitializationWaiting = true;
              await ready;
            }
            return original(request, ...args);
          };
        },
      });
    }, localServer.url('/recording-initialization'));
    releaseScript();
    await navigation;
    await expect
      .poll(() =>
        helper.evaluate(async () => {
          const [execution] = await chrome.scripting.executeScript({
            target: { tabId: globalThis.recordingInitializationTabId },
            world: 'ISOLATED',
            func: () => globalThis.recordingInitializationWaiting,
          });
          return execution.result;
        }),
      )
      .toBe(true);
    await helper.evaluate(async () => {
      for (const messageAction of ['getPageIdentity', 'isPdfPage']) {
        const response = await chrome.runtime.sendMessage({
          action: 'failNextTabMessageForTest',
          tabId: globalThis.recordingInitializationTabId,
          messageAction,
          error:
            'Could not establish connection. Receiving end does not exist.',
        });
        if (!response?.success)
          throw new Error(
            response?.error || 'Could not hold receiver readiness',
          );
      }
    });
    await helper.evaluate(() => {
      globalThis.initializingIdentity = chrome.runtime
        .sendMessage({
          action: 'resolvePopupPageIdentity',
          tabId: globalThis.recordingInitializationTabId,
        })
        .catch((error) => ({ success: false, error: error.message }));
      globalThis.initializingCapture = chrome.runtime.sendMessage({
        action: 'captureCurrentPageFromPopup',
      });
    });
    await helper.evaluate(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: globalThis.recordingInitializationTabId },
        world: 'ISOLATED',
        func: () => globalThis.releaseRecordingInitialization(),
      });
    });
    expect(
      await helper.evaluate(() => globalThis.initializingIdentity),
    ).toMatchObject({
      success: true,
      identity: { url: localServer.url('/recording-initialization') },
    });
    expect(
      await helper.evaluate(() => globalThis.initializingCapture),
    ).toMatchObject({ success: true });
  } finally {
    releaseScript();
    await navigation?.catch(() => {});
    await page.close();
    await helper.close();
  }
});
