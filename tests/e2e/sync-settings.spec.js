import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('Sync settings UI', () => {
  test('sync toggle shows and hides config fields', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Initially unchecked — config fields hidden
    const toggle = options.locator('#syncEnabled');
    const configFields = options.locator('#syncConfigFields');
    await expect(toggle).not.toBeChecked();
    await expect(configFields).toBeHidden();

    // Check toggle — config fields shown
    await toggle.check();
    await expect(configFields).toBeVisible();

    // Uncheck toggle — config fields hidden again
    await toggle.uncheck();
    await expect(configFields).toBeHidden();

    await options.close();
  });

  test('save validates required fields when enabled', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Enable sync but leave repo URL and token empty
    await options.locator('#syncEnabled').check();
    await options.click('#syncSaveBtn');

    // Should show error status (not "saved")
    await options.waitForFunction(
      () => {
        const status = document.querySelector('.status');
        return status?.textContent?.includes('required');
      },
      { timeout: 5000 }
    );

    await options.close();
  });

  test('sync settings persist after reload', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncRepoUrl: 'https://github.com/user/repo',
        syncToken: 'ghp_testtoken123',
        syncIntervalMinutes: 10,
        syncRetentionDays: 14,
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Verify all fields are populated from seeded settings
    await expect(options.locator('#syncEnabled')).toBeChecked();
    await expect(options.locator('#syncConfigFields')).toBeVisible();

    const repoUrl = await options.inputValue('#syncRepoUrl');
    expect(repoUrl).toBe('https://github.com/user/repo');

    const token = await options.inputValue('#syncToken');
    expect(token).toBe('ghp_testtoken123');

    const interval = await options.inputValue('#syncIntervalMinutes');
    expect(interval).toBe('10');

    const retention = await options.inputValue('#syncRetentionDays');
    expect(retention).toBe('14');

    await options.close();
  });

  test('syncNow returns skipped when not configured', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    // Send syncNow directly via helper (button is hidden when sync disabled)
    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ action: 'syncNow' });
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);

    await helper.close();
  });

  test('getSyncStatus returns initial state', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const status = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ action: 'getSyncStatus' });
    });

    expect(status.success).toBe(true);
    expect(status.syncInProgress).toBe(false);
    expect(status.lastSyncResult).toBeNull();

    await helper.close();
  });
});
