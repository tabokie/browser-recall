import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

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

  // Bug 20260224: gateways data should be available after rehydration.
  // After disable/re-enable, readCacheable should return gateway origins.
  test('seeded gateways available via readCacheable after rehydration', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
      { path: 'lists/system/gateways.json', data: {
        timestamp: Date.now(),
        origins: ['https://example.com', 'https://news.ycombinator.com'],
      }},
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const gateways = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/gateways' })
    );
    await helper.close();

    expect(gateways.value).toBeTruthy();
    expect(gateways.value.origins).toContain('https://example.com');
    expect(gateways.value.origins).toContain('https://news.ycombinator.com');
  });

  // Verifies that gateway promotion via page visits survives drain→disk→rehydrate.
  // Navigates to 2 child pages of the same origin (triggers gateway detection),
  // flushes, rehydrates, and checks that the gateway origin persists.
  test('gateway promotion persists through drain flush + rehydrate', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/gw-child-1', { title: 'Child 1', body: '<p>Page 1</p>' });
    localServer.addPage('/gw-child-2', { title: 'Child 2', body: '<p>Page 2</p>' });

    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [], listOrder: [] } },
    ]);

    // Visit 2 child pages of the same origin to trigger gateway promotion
    const page = await extContext.newPage();
    await page.goto(localServer.url('/gw-child-1'));
    await page.waitForSelector('p');
    await page.goto(localServer.url('/gw-child-2'));
    await page.waitForSelector('p');
    await page.waitForTimeout(1000);
    await page.close();

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for gateway to appear in session cache (content script → background is async)
    const baseUrl = localServer.baseUrl;
    await helper.waitForFunction(async (url) => {
      const r = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/gateways' });
      return Array.isArray(r.value?.origins) && r.value.origins.includes(url);
    }, baseUrl, { timeout: 5000 });

    // Flush (drain persists dirty entities to disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Rehydrate (clears session cache, re-reads from disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    // Gateway should survive — drain flushed it to gateways.json
    const after = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:system/gateways' })
    );
    await helper.close();

    expect(after.value).toBeTruthy();
    expect(after.value.origins).toContain(localServer.baseUrl);
  });
});
