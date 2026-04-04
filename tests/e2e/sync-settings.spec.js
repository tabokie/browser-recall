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

    // Enable sync but leave repo URL empty and no token connected
    await options.locator('#syncEnabled').check();
    await options.click('#syncNowBtn');

    // Should show validation error in sync status area or toast
    await options.waitForFunction(
      () => {
        const syncStatus = document.getElementById('syncStatus');
        const toast = document.querySelector('.status');
        return (syncStatus?.textContent?.includes('Fix settings') ||
                toast?.textContent?.includes('required') ||
                toast?.textContent?.includes('not connected'));
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
        syncAuthMethod: 'pat',
        syncGitHubUser: 'testuser',
        syncRememberToken: true,
        syncToken: 'ghp_testtoken123',
        syncIntervalMinutes: 10,
        syncRetentionDays: 14,
      }},
    ]);

    // Seed the session token via background message
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async () => {
      await chrome.runtime.sendMessage({
        action: 'setSyncToken',
        token: 'ghp_testtoken123',
        remember: true,
        authMethod: 'pat',
        githubUser: 'testuser',
      });
    });
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Verify all fields are populated from seeded settings
    await expect(options.locator('#syncEnabled')).toBeChecked();
    await expect(options.locator('#syncConfigFields')).toBeVisible();

    const repoUrl = await options.inputValue('#syncRepoUrl');
    expect(repoUrl).toBe('https://github.com/user/repo');

    // Auth connected state should show
    await expect(options.locator('#syncAuthConnected')).toBeVisible();
    const authDetail = await options.textContent('#syncAuthDetail');
    expect(authDetail).toContain('testuser');

    // Remember checkbox should be checked
    await expect(options.locator('#syncRememberToken')).toBeChecked();

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

  test('auth UI shows disconnected by default', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { syncEnabled: true, syncMethod: 'github' } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Disconnected state should be visible, connected hidden
    await expect(options.locator('#syncAuthDisconnected')).toBeVisible();
    await expect(options.locator('#syncAuthConnected')).toBeHidden();

    await options.close();
  });

  test('setSyncToken + getSyncAuthState round-trip', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Initially no token
    const before = await helper.evaluate(async () =>
      chrome.runtime.sendMessage({ action: 'getSyncAuthState' })
    );
    expect(before.hasToken).toBe(false);
    expect(before.authMethod).toBeNull();

    // Set a token
    await helper.evaluate(async () =>
      chrome.runtime.sendMessage({
        action: 'setSyncToken',
        token: 'ghp_test123',
        remember: false,
        authMethod: 'pat',
        githubUser: 'octocat',
      })
    );

    // Now token should be present
    const after = await helper.evaluate(async () =>
      chrome.runtime.sendMessage({ action: 'getSyncAuthState' })
    );
    expect(after.hasToken).toBe(true);
    expect(after.authMethod).toBe('pat');
    expect(after.githubUser).toBe('octocat');
    expect(after.rememberToken).toBe(false);

    await helper.close();
  });

  test('clearSyncToken removes token and auth metadata', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {} },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Set then clear
    await helper.evaluate(async () => {
      await chrome.runtime.sendMessage({
        action: 'setSyncToken',
        token: 'ghp_test123',
        remember: true,
        authMethod: 'pat',
        githubUser: 'octocat',
      });
      await chrome.runtime.sendMessage({ action: 'clearSyncToken' });
    });

    const state = await helper.evaluate(async () =>
      chrome.runtime.sendMessage({ action: 'getSyncAuthState' })
    );
    expect(state.hasToken).toBe(false);
    expect(state.authMethod).toBeNull();
    expect(state.githubUser).toBeNull();
    expect(state.rememberToken).toBe(false);

    await helper.close();
  });

  test('PAT input is visible in disconnected state', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { syncEnabled: true, syncMethod: 'github' } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // PAT input should be visible when disconnected
    await expect(options.locator('#syncPatInput')).toBeVisible();
    await expect(options.locator('#syncPatSaveBtn')).toBeVisible();

    await options.close();
  });

  test('auth connected state shows after setSyncToken via background', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncMethod: 'github',
        syncAuthMethod: 'pat',
        syncGitHubUser: 'octocat',
      }},
    ]);

    // Seed the session token
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async () => {
      await chrome.runtime.sendMessage({
        action: 'setSyncToken',
        token: 'ghp_testtoken',
        remember: false,
        authMethod: 'pat',
        githubUser: 'octocat',
      });
    });
    await helper.close();

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Connected state should be visible
    await expect(options.locator('#syncAuthConnected')).toBeVisible();
    await expect(options.locator('#syncAuthDisconnected')).toBeHidden();
    const detail = await options.textContent('#syncAuthDetail');
    expect(detail).toContain('octocat');

    await options.close();
  });

  test('syncNow returns skipped when token missing', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncMethod: 'github',
        syncRepoUrl: 'https://github.com/user/repo',
        // No token set in session
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const result = await helper.evaluate(async () =>
      chrome.runtime.sendMessage({ action: 'syncNow' })
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain('not connected');

    await helper.close();
  });

  test('Sync Now button does not show Unknown action error', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true, syncMethod: 'github', syncRepoUrl: 'https://github.com/test/repo',
        syncGitHubUser: 'testuser',
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Click Sync Now button
    await options.click('#syncNowBtn');

    // Wait for sync status to update
    await options.waitForFunction(
      () => {
        const el = document.getElementById('syncStatus');
        return el && el.textContent && !el.textContent.includes('Syncing...');
      },
      { timeout: 10000 }
    );

    // Verify it does NOT say "Unknown action: undefined"
    const statusText = await options.$eval('#syncStatus', el => el.textContent);
    expect(statusText).not.toContain('Unknown action');

    await options.close();
  });
});
