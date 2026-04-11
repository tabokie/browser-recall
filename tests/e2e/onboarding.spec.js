import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage } from './helpers.js';

test.describe('Onboarding', () => {
  // Helper: clear directory handle to simulate fresh install, restore after test
  async function withoutDirectory(extContext, extensionId, fn) {
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'clearDirectoryHandleForTest' }),
    );
    await helper.close();

    try {
      await fn();
    } finally {
      // Restore directory handle so subsequent tests work
      const restore = await openHelperPage(extContext, extensionId);
      await restore.evaluate(() =>
        chrome.runtime.sendMessage({ action: 'setTestDirectory' }),
      );
      await restore.close();
    }
  }

  test('existing install skips onboarding and shows normal UI', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Onboarding should NOT be visible
    const onboarding = options.locator('#onboarding');
    await expect(onboarding).not.toBeVisible();

    // Sidebar should be visible (normal UI)
    const sidebar = options.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    await options.close();
  });

  test('onboarding screen appears when no directory is configured', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    await withoutDirectory(extContext, extensionId, async () => {
      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.waitForFunction(
        () => document.body.dataset.ready === 'true',
        { timeout: 10000 },
      );

      // Onboarding should be visible
      await expect(options.locator('#onboarding')).toBeVisible();
      // Sidebar should be hidden
      await expect(options.locator('.sidebar')).not.toBeVisible();
      // "Get Started" button should be disabled
      await expect(options.locator('#onboardingStartBtn')).toBeDisabled();
      // "Choose Directory" button should be visible
      await expect(options.locator('#onboardingDirBtn')).toBeVisible();
      // Features section should be hidden until directory is chosen
      await expect(options.locator('#onboardingFeatures')).not.toBeVisible();

      await options.close();
    });
  });

  test('onboarding card is scrollable on small viewport', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    await withoutDirectory(extContext, extensionId, async () => {
      const options = await extContext.newPage();
      await options.setViewportSize({ width: 800, height: 400 });
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.waitForFunction(
        () => document.body.dataset.ready === 'true',
        { timeout: 10000 },
      );

      // Simulate directory selection by showing the features section
      await options.evaluate(() => {
        document.getElementById('onboardingFeatures').style.display = 'block';
        const rows = document.querySelectorAll('.onboarding-feature');
        rows.forEach((r) => r.classList.add('fade-in'));
        const btn = document.getElementById('onboardingStartBtn');
        btn.style.display = 'block';
        btn.disabled = false;
        btn.classList.add('fade-in');
      });

      // The Get Started button should be reachable by scrolling
      const btn = options.locator('#onboardingStartBtn');
      await btn.scrollIntoViewIfNeeded();
      await expect(btn).toBeInViewport();

      // The onboarding container should be scrollable
      const canScroll = await options.evaluate(() => {
        const el = document.getElementById('onboarding');
        el.scrollTop = 100;
        return el.scrollTop > 0;
      });
      expect(canScroll).toBe(true);

      await options.close();
    });
  });

  test('onboarding card shows expected content', async ({
    extContext,
    extensionId,
    setupDir,
  }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    await withoutDirectory(extContext, extensionId, async () => {
      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.waitForFunction(
        () => document.body.dataset.ready === 'true',
        { timeout: 10000 },
      );

      await expect(options.locator('.onboarding-card h1')).toContainText(
        'browser-recall',
      );
      await expect(options.locator('.onboarding-desc')).toContainText(
        'locally in plain text',
      );
      // Device name input hidden (in optional section which is not visible yet)
      await expect(options.locator('#onboardingDeviceName')).not.toBeVisible();

      await options.close();
    });
  });
});
