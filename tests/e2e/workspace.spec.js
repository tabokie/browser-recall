import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage } from './helpers.js';

test.describe('Workspace mode persistence', () => {
  test('workspace mode survives opening options page', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
    ]);

    // Simulate popup setting workspace mode via chrome.storage.session
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(() =>
      chrome.storage.session.set({ workspace: { mode: 'workspace', listIds: ['list:research'], autoSnapshot: true } })
    );

    // Verify it's set
    const before = await helper.evaluate(() =>
      chrome.storage.session.get(['workspace']).then(d => d.workspace)
    );
    expect(before.mode).toBe('workspace');
    expect(before.listIds).toEqual(['list:research']);
    expect(before.autoSnapshot).toBe(true);
    await helper.close();

    // Open options page (the action the user says causes workspace state loss)
    const options = await openOptionsPage(extContext, extensionId);
    await options.close();

    // Verify workspace mode is still set
    const helper2 = await openHelperPage(extContext, extensionId);
    const after = await helper2.evaluate(() =>
      chrome.storage.session.get(['workspace']).then(d => d.workspace)
    );
    expect(after).toBeTruthy();
    expect(after.mode).toBe('workspace');
    expect(after.listIds).toEqual(['list:research']);
    expect(after.autoSnapshot).toBe(true);
    await helper2.close();
  });
});
