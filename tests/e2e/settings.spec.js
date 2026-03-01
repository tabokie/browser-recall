import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Settings persistence', () => {
  test('seeded settings values display in settings modal', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: {
        trimRules: [], relatedPagesLimit: 25, historyFileBatch: 5,
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
      { path: 'settings.json', data: {
        trimRules: [], relatedPagesLimit: 50, historyFileBatch: 10,
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
});
