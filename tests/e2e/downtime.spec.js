import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('Downtime infrastructure', () => {
  async function seed(extContext, extensionId) {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);
  }

  test('error banner hidden when service is healthy', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).not.toBeVisible();
    await options.close();
  });

  test('error banner shows session_quota message', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'session_quota',
        message: 'Session storage full',
      }),
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Session storage full');
    const reloadBtn = options.locator('#serviceErrorReloadBtn');
    await expect(reloadBtn).toBeVisible();
    await options.close();
  });

  test('error banner shows local_quota message', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'local_quota',
        message: 'Local storage full',
      }),
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Local storage full');
    await expect(options.locator('#serviceErrorReloadBtn')).toBeVisible();
    await options.close();
  });

  test('error banner shows offscreen_crash message', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'offscreen_crash',
        message: 'Storage worker crashed',
      }),
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Storage worker crashed');
    await expect(options.locator('#serviceErrorReloadBtn')).toBeVisible();
    await options.close();
  });

  test('error banner shows fs_permission message with Re-grant Access button', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'fs_permission',
        message: 'Storage access was revoked',
      }),
    );
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Storage access was revoked');
    const regrantBtn = options.locator('#serviceErrorRegrantBtn');
    await expect(regrantBtn).toBeVisible();
    await options.close();
  });

  test('resumeService clears the error state', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    // Pause first
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'local_quota',
        message: 'Local storage full',
      }),
    );

    // Then resume
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resumeService' }),
    );

    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    const banner = options.locator('#serviceErrorBanner');
    await expect(banner).not.toBeVisible();
    await options.close();
  });

  test('mutation handler returns error when service is paused (addLog throw path)', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    const url = 'https://example.com/paused-page';
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      {
        path: 'pages/example-com-paused-page-a1b2c3.json',
        data: {
          slug: 'example-com-paused-page-a1b2c3',
          url,
          title: 'Test',
          timestamp: Date.now(),
          parentIds: [],
          childIds: [],
        },
      },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'session_quota',
        message: 'Session storage full',
      }),
    );

    // createNote has no isServicePaused guard — relies on addLog throwing
    const result = await helper.evaluate(
      (u) =>
        chrome.runtime.sendMessage({
          action: 'createNote',
          pageSlug: 'example-com-paused-page-a1b2c3',
          url: u,
          excerpt: 'test text',
        }),
      url,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service paused/i);

    await helper.close();
  });

  test('addLog is blocked when service is paused', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'session_quota',
        message: 'Session storage full',
      }),
    );

    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'reportPage',
        url: 'https://example.com',
        title: 'Test',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service paused/i);

    await helper.close();
  });

  // Gap fixes

  test('syncNow is blocked when service is paused', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'local_quota',
        message: 'Local storage full',
      }),
    );

    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'syncNow' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service paused/i);

    await helper.close();
  });

  test('permanentDelete is blocked when service is paused', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'fs_permission',
        message: 'FS revoked',
      }),
    );

    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'permanentDelete',
        key: 'note:some-note',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service paused/i);

    await helper.close();
  });

  test('error banner appears when service pauses while options page is open', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);

    // Open options page FIRST (service healthy at this point)
    const options = await openOptionsPage(extContext, extensionId);
    await expect(options.locator('#serviceErrorBanner')).not.toBeVisible();

    // Now pause service in a separate tab
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'pauseServiceForTest',
        code: 'session_quota',
        message: 'Session storage full',
      }),
    );
    await helper.close();

    // Banner should appear in the already-open options page (via storage.onChanged)
    await expect(options.locator('#serviceErrorBanner')).toBeVisible({
      timeout: 5000,
    });
    await expect(options.locator('#serviceErrorBanner')).toContainText(
      'Session storage full',
    );

    await options.close();
  });

  test('extension recovers from a single offscreen crash', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    // Verify data is accessible before the crash
    const before = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:settings',
      }),
    );
    expect(before.success).toBe(true);

    // Kill the offscreen document
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'killOffscreenForTest' }),
    );

    // Service should NOT be paused (single crash, not a crash loop)
    const serviceError = await helper.evaluate(() =>
      chrome.storage.session.get('serviceError').then((r) => r.serviceError),
    );
    expect(serviceError).toBeFalsy();

    // Next action should work — ensureOffscreenPort reconnects automatically
    const after = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readCacheable',
        key: 'manifest:settings',
      }),
    );
    expect(after.success).toBe(true);

    await helper.close();
  });

  test('drain failure threshold triggers service pause and recovery resumes', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await seed(extContext, extensionId);
    const helper = await openHelperPage(extContext, extensionId);

    // Kill offscreen so drain will fail
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'killOffscreenForTest' }),
    );

    // Set drain failure count to threshold - 1 (11 out of 12)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'setDrainFailureCountForTest',
        count: 11,
      }),
    );

    // Add a log entry — this triggers scheduleDrainNotify
    // The entry itself goes through addLog (which uses ensureOffscreenPort → reconnects offscreen).
    // But the drain (drainNow) fires on a 5s timer and will find offscreen reconnected.
    // To ensure the drain fails, we need offscreen to be dead when drainNow fires.

    // Instead: directly trigger drainNow by calling flushLogBuffer which calls drainNow.
    // First add an entry so the buffer isn't empty.
    // We need to inject a buffer entry and then trigger drain manually.
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'setLogBufferForTest',
        entries: [
          {
            timestamp: Date.now(),
            action: 'visit_page',
            url: 'https://example.com/drain-test',
            title: 'Drain Test',
          },
        ],
      }),
    );

    // Kill offscreen again (setLogBufferForTest may have reconnected it)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'killOffscreenForTest' }),
    );

    // Now trigger drain — it should fail (offscreen dead) and push counter to 12 >= threshold
    // flushLogBuffer calls drainNow which increments consecutiveDrainFailures
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' }).catch(() => {}),
    );

    // Wait briefly for the drain failure to propagate
    await helper.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    // Service should be paused with fs_permission code
    const serviceError = await helper.evaluate(() =>
      chrome.storage.session.get('serviceError').then((r) => r.serviceError),
    );
    expect(serviceError).toBeTruthy();
    expect(serviceError.code).toBe('fs_permission');

    // reportPage should fail when service is paused
    const result = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'reportPage',
        url: 'https://example.com/blocked',
        title: 'Blocked',
        isInitialLoad: true,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/service paused/i);

    // Resume service
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resumeService' }),
    );

    // Service should be healthy again
    const afterResume = await helper.evaluate(() =>
      chrome.storage.session.get('serviceError').then((r) => r.serviceError),
    );
    expect(afterResume).toBeFalsy();

    await helper.close();
  });
});
