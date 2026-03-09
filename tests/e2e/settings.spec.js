import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage, getSlugForUrl } from './helpers.js';

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

  // Bug 20260224: auto/gateways data should be available after rehydration.
  // After disable/re-enable, readCacheable should return gateway pins.
  test('seeded auto gateways available via readCacheable after rehydration', async ({ extContext, extensionId, setupDir }) => {
    const exSlug = getSlugForUrl('https://example.com/');
    const hnSlug = getSlugForUrl('https://news.ycombinator.com/');
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/auto.json', data: { slug: 'auto', name: 'Auto', auto: true, parentList: 'list:system/root', childLists: ['list:auto/gateways'], pins: [], savedSearches: [], timestamp: 1 } },
      { path: 'lists/auto/gateways.json', data: {
        slug: 'auto/gateways', name: 'Gateways', auto: true, parentList: 'list:auto', childLists: [],
        pins: [
          { id: `page:${exSlug}`, pinnedAt: Date.now() },
          { id: `page:${hnSlug}`, pinnedAt: Date.now() },
        ],
        savedSearches: [], timestamp: Date.now(),
      }},
      { path: 'lists/system/root.json', data: { timestamp: 1, childLists: ['list:auto'] } },
    ]);

    const helper = await openHelperPage(extContext, extensionId);
    const gateways = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:auto/gateways' })
    );
    await helper.close();

    expect(gateways.value).toBeTruthy();
    expect(gateways.value.pins).toHaveLength(2);
    expect(gateways.value.pins.map(p => p.id)).toContain(`page:${exSlug}`);
    expect(gateways.value.pins.map(p => p.id)).toContain(`page:${hnSlug}`);
  });

  // Verifies that gateway promotion via page visits survives drain→disk→rehydrate.
  // Visits child pages, then root (triggers promotion), flushes, rehydrates,
  // and checks that the gateway pin persists.
  test('gateway promotion persists through drain flush + rehydrate', async ({ extContext, extensionId, setupDir, localServer }) => {
    localServer.addPage('/gw-child-1', { title: 'Child 1', body: '<p>Page 1</p>' });
    localServer.addPage('/gw-child-2', { title: 'Child 2', body: '<p>Page 2</p>' });

    // Seed empty auto/gateways list so promotion has somewhere to write
    await resetAndSeed(extContext, extensionId, [
      { path: 'settings.json', data: { trimRules: [] } },
      { path: 'lists/auto.json', data: { slug: 'auto', name: 'Auto', auto: true, parentList: 'list:system/root', childLists: ['list:auto/gateways'], pins: [], savedSearches: [], timestamp: 1 } },
      { path: 'lists/auto/gateways.json', data: { slug: 'auto/gateways', name: 'Gateways', auto: true, parentList: 'list:auto', childLists: [], pins: [], savedSearches: [], timestamp: 1 } },
      { path: 'lists/system/root.json', data: { timestamp: 1, childLists: ['list:auto'] } },
    ]);

    // Visit child pages, then root to trigger gateway promotion
    const page = await extContext.newPage();
    await page.goto(localServer.url('/gw-child-1'));
    await page.waitForSelector('p');
    await page.goto(localServer.url('/gw-child-2'));
    await page.waitForSelector('p');
    await page.goto(localServer.url('/'));
    await page.waitForSelector('h1');
    await page.waitForTimeout(1000);
    await page.close();

    const helper = await openHelperPage(extContext, extensionId);

    // Wait for gateway pin to appear in auto/gateways
    await helper.waitForFunction(async () => {
      const r = await chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:auto/gateways' });
      return Array.isArray(r.value?.pins) && r.value.pins.length > 0;
    }, null, { timeout: 5000 });

    // Flush (drain persists dirty entities to disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Rehydrate (clears session cache, re-reads from disk)
    await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    // Gateway should survive — drain flushed it to auto/gateways.json
    const after = await helper.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:auto/gateways' })
    );
    await helper.close();

    expect(after.value).toBeTruthy();
    expect(after.value.pins.length).toBeGreaterThan(0);
  });
});
