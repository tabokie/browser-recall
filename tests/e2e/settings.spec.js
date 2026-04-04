import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage, openHelperPage } from './helpers.js';

test.describe('Settings persistence', () => {
  test('seeded settings values display in settings modal', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
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
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: {
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

  // First-run default list: when no user lists exist, hydrateCache creates a "Hubs" list with a function rule.
  test('first-run creates Hubs default list with function rule', async ({ extContext, extensionId, setupDir }) => {
    // Seed only system files — no user lists
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
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

  test('debug logging toggle writes to session storage', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Open settings and verify toggle is initially unchecked
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    const isCheckedBefore = await options.isChecked('#debugLoggingToggle');
    expect(isCheckedBefore).toBe(false);

    // Enable debug logging
    await options.check('#debugLoggingToggle');

    // Verify session storage was updated
    const afterEnable = await options.evaluate(() =>
      chrome.storage.session.get(['debugLogging'])
    );
    expect(afterEnable.debugLogging).toBe(true);

    // Disable debug logging
    await options.uncheck('#debugLoggingToggle');
    const afterDisable = await options.evaluate(() =>
      chrome.storage.session.get(['debugLogging'])
    );
    expect(afterDisable.debugLogging).toBe(false);
    await options.close();
  });

  test('debug logging toggle reflects saved state on reopen', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Enable debug logging
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.check('#debugLoggingToggle');

    // Close and reopen settings modal
    await options.click('#settingsClose');
    await options.waitForSelector('#settingsModal', { state: 'hidden', timeout: 3000 });
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    // Toggle should still be checked
    const isChecked = await options.isChecked('#debugLoggingToggle');
    expect(isChecked).toBe(true);
    await options.close();
  });

  test('storage status shows Connected when directory is configured', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

    const storageStatus = options.locator('#storageStatus');
    await expect(storageStatus).toHaveText('Connected', { timeout: 5000 });

    await options.close();
  });
});

test.describe('Clear Cache & Reload', () => {
  test('reloads the options page after clearing cache', async ({ extContext, extensionId }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Open settings modal
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal.open', { timeout: 5000 });

    // Click "Clear Cache & Reload" — expect page navigation (reload)
    await Promise.all([
      options.waitForNavigation({ timeout: 10000 }),
      options.click('#clearCacheBtn'),
    ]);

    // Wait for reload to complete
    await options.waitForSelector('[data-ready]', { timeout: 10000 });

    // After reload, the settings modal should be closed (page fresh)
    const modalOpen = await options.$eval('#settingsModal', el => el.classList.contains('open'));
    expect(modalOpen).toBe(false);

    await options.close();
  });
});

test.describe('Scrollbar styling', () => {
  test('all scrollable elements use transparent gutter', async ({ extContext, extensionId }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Check that the global scrollbar styling is applied via the * selector
    const hasThinScrollbar = await options.evaluate(() => {
      const style = getComputedStyle(document.body);
      return style.scrollbarWidth === 'thin';
    });
    expect(hasThinScrollbar).toBe(true);

    // Check sidebar scrollbar uses transparent track (via scrollbar-color)
    const sidebarScrollbarColor = await options.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-content');
      if (!sidebar) return '';
      return getComputedStyle(sidebar).scrollbarColor;
    });
    // scrollbar-color should resolve to "auto" (browser default) or contain both thumb and track colors
    // When set to "var(--scrollbar-thumb) transparent", it resolves to "<color> transparent"
    // or "<color> rgba(0, 0, 0, 0)" — just verify it's not the browser default "auto"
    expect(sidebarScrollbarColor).not.toBe('auto');

    await options.close();
  });
});
