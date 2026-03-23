import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('Settings persistence', () => {
  test('seeded settings values display in settings modal', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        trimRules: [], deviceName: 'test-device', relatedPagesLimit: 25, historyFileBatch: 5,
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    const relatedLimit = await options.inputValue('#relatedPagesLimit');
    expect(relatedLimit).toBe('25');
    const historyBatch = await options.inputValue('#historyFileBatch');
    expect(historyBatch).toBe('5');
    await options.close();
  });

  test('changed setting persists after page reload', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        trimRules: [], deviceName: 'test-device', relatedPagesLimit: 50, historyFileBatch: 10,
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    const input = options.locator('#relatedPagesLimit');
    await input.fill('30');
    await input.dispatchEvent('change');
    // Poll until the status message confirms save
    await options.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('saved'),
      { timeout: 5000 }
    );
    await options.close();

    const options2 = await openOptionsPage(extContext, extensionId);

    await options2.click('#settingsBtn');
    await options2.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    const savedValue = await options2.inputValue('#relatedPagesLimit');
    expect(savedValue).toBe('30');
    await options2.close();
  });

  // First-run default list: when no user lists exist, hydrateCache creates a "Hubs" list with a function rule.
  test('first-run creates Hubs default list with function rule', async ({ extContext, extensionId, setupDir }) => {
    // Seed only system files — no user lists
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [], deviceName: 'test-device' } },
      { path: 'manifest/list-order.json', data: { timestamp: 1, tree: [] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for Hubs list to appear (created by first-run logic in hydrateCache)
    await helper.waitForFunction(async () => {
      const root = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:list-order' });
      return root.value?.tree?.length > 0;
    }, null, { timeout: 5000 });

    // Get root and find the Hubs list key
    const root = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:list-order' })
    );
    expect(root.value.tree.length).toBe(1);

    const hubsKey = root.value.tree[0].id;
    const hubs = await helper.evaluate((key) =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key })
    , hubsKey);
    await helper.close();

    expect(hubs.value).toBeTruthy();
    expect(hubs.value.name).toBe('Hubs');
    expect(hubs.value.rules).toHaveLength(1);
    expect(hubs.value.rules[0].type).toBe('smart');
    expect(hubs.value.rules[0].config.fnSource).toContain('pathname');
  });
});
