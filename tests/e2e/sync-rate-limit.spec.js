import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage } from './helpers.js';

test.describe('Sync rate limit backoff', () => {
  test('syncNow skips when rate-limited', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncRepoUrl: 'https://github.com/user/repo',
        syncToken: 'ghp_test',
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Simulate rate limit until 1 hour from now
    const until = Date.now() + 60 * 60 * 1000;
    await helper.evaluate(async (ms) => {
      return chrome.runtime.sendMessage({ action: 'setRateLimitForTest', until: ms });
    }, until);

    // syncNow should skip and report rate-limited
    const result = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ action: 'syncNow' });
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.error).toMatch(/rate limited/i);

    await helper.close();
  });

  test('getSyncStatus reports rateLimitedUntil', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncRepoUrl: 'https://github.com/user/repo',
        syncToken: 'ghp_test',
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    const until = Date.now() + 60 * 60 * 1000;
    await helper.evaluate(async (ms) => {
      return chrome.runtime.sendMessage({ action: 'setRateLimitForTest', until: ms });
    }, until);

    const status = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ action: 'getSyncStatus' });
    });

    expect(status.success).toBe(true);
    expect(status.lastSyncResult).toBeTruthy();
    expect(status.lastSyncResult.rateLimitedUntil).toBe(until);
    expect(status.lastSyncResult.error).toMatch(/rate limited/i);

    await helper.close();
  });

  test('syncNow proceeds after rate limit expires', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
        syncEnabled: true,
        syncRepoUrl: 'https://github.com/user/repo',
        syncToken: 'ghp_test',
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Set rate limit to the past — should be expired
    const pastTime = Date.now() - 1000;
    await helper.evaluate(async (ms) => {
      return chrome.runtime.sendMessage({ action: 'setRateLimitForTest', until: ms });
    }, pastTime);

    // syncNow should NOT skip (rate limit expired). It will fail because
    // the GitHub token is fake, but it should attempt the sync, not skip.
    const result = await helper.evaluate(async () => {
      return chrome.runtime.sendMessage({ action: 'syncNow' });
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeFalsy();

    await helper.close();
  });
});
