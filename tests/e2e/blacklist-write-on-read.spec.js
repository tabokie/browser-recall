import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('Blacklist write-on-read bug', () => {
  test('opening options page without urlBlacklist does not write defaults to settings', async ({ extContext, extensionId, setupDir }) => {
    // Seed settings WITHOUT urlBlacklist — simulates post-migration state
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        trimRules: [], relatedPagesLimit: 50,
      }},
    ]);

    // Open options page — this triggers renderBlacklist() → loadBlacklist()
    const options = await openOptionsPage(extContext, extensionId);

    // Open settings modal to trigger renderBlacklist() again
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Blacklist UI should show defaults
    const entries = await options.$$eval('.blacklist-entries .blacklist-entry span', els =>
      els.map(el => el.textContent)
    );
    expect(entries).toEqual(['chrome://', 'edge://']);

    await options.close();

    // Verify that settings in backend still do NOT have urlBlacklist
    // (loadBlacklist should be read-only, not write defaults back)
    const helper = await openHelperPage(extContext, extensionId);
    const settings = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:settings' })
    );
    expect(settings.value).not.toHaveProperty('urlBlacklist');

    await helper.close();
  });

  test('custom blacklist is preserved through options page open', async ({ extContext, extensionId, setupDir }) => {
    // Seed settings WITH custom urlBlacklist
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: {
        trimRules: [], relatedPagesLimit: 50,
        urlBlacklist: ['https://private.corp.example.com/', 'edge://'],
      }},
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Custom blacklist should display
    const entries = await options.$$eval('.blacklist-entries .blacklist-entry span', els =>
      els.map(el => el.textContent)
    );
    expect(entries).toEqual(['https://private.corp.example.com/', 'edge://']);

    await options.close();

    // Verify settings still have the custom list
    const helper = await openHelperPage(extContext, extensionId);
    const settings = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'manifest:settings' })
    );
    expect(settings.value.urlBlacklist).toEqual(['https://private.corp.example.com/', 'edge://']);

    await helper.close();
  });
});
