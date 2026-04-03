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
    await options.click('#syncSaveBtn');

    // Should show error about repo URL or token
    await options.waitForFunction(
      () => {
        const status = document.querySelector('.status');
        return status?.textContent?.includes('required') || status?.textContent?.includes('not connected');
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
    expect(authDetail).toContain('personal access token');

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
    await expect(options.locator('#syncAuthDeviceFlow')).toBeHidden();

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
        authMethod: 'oauth',
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

  test('PAT toggle shows and hides input field', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { syncEnabled: true, syncMethod: 'github' } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // PAT fields initially hidden
    await expect(options.locator('#syncPatFields')).toBeHidden();

    // Click toggle to show
    await options.click('#syncPatToggle');
    await expect(options.locator('#syncPatFields')).toBeVisible();

    // Click again to hide
    await options.click('#syncPatToggle');
    await expect(options.locator('#syncPatFields')).toBeHidden();

    await options.close();
  });

  test('auth connected state shows after setSyncToken via background', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncMethod: 'github',
        syncAuthMethod: 'oauth',
        syncGitHubUser: 'octocat',
      }},
    ]);

    // Seed the session token
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(async () => {
      await chrome.runtime.sendMessage({
        action: 'setSyncToken',
        token: 'gho_testtoken',
        remember: false,
        authMethod: 'oauth',
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
});
