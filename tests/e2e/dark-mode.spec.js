import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Dark mode', () => {
  test('theme defaults to system (no data-theme attribute)', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const theme = await options.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBeNull();
    await options.close();
  });

  test('setting theme to dark sets data-theme="dark"', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Open settings and change theme
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.selectOption('#themeSelect', 'dark');

    // Wait for the async theme handler to apply the attribute
    await options.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: 3000 }
    );
    await options.close();
  });

  test('setting theme to light sets data-theme="light"', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.selectOption('#themeSelect', 'light');

    await options.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      { timeout: 3000 }
    );
    await options.close();
  });

  test('theme persists across page loads within session', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Set to dark
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.selectOption('#themeSelect', 'dark');
    await options.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: 3000 }
    );
    await options.close();

    // Reopen — theme should still be dark
    const options2 = await openOptionsPage(extContext, extensionId);
    const theme = await options2.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    // Verify select reflects persisted value
    await options2.click('#settingsBtn');
    await options2.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    const selectVal = await options2.inputValue('#themeSelect');
    expect(selectVal).toBe('dark');
    await options2.close();
  });

  test('dark theme applies dark CSS variables', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Set dark theme
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.selectOption('#themeSelect', 'dark');
    await options.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      { timeout: 3000 }
    );

    // Check that --bg-base is dark (not the light #F8F0E6)
    const bgBase = await options.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    );
    expect(bgBase).not.toBe('#F8F0E6');
    expect(bgBase).toBe('#1a1412');
    await options.close();
  });

  test('system mode applies dark variables when OS prefers dark', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // No data-theme attribute (system mode)
    const attr = await options.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(attr).toBeNull();

    // Emulate OS dark preference
    await options.emulateMedia({ colorScheme: 'dark' });

    // The @media (prefers-color-scheme: dark) query should activate dark variables
    const bgBase = await options.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    );
    expect(bgBase).toBe('#1a1412');
    await options.close();
  });

  test('system mode keeps light variables when OS prefers light', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.emulateMedia({ colorScheme: 'light' });

    const bgBase = await options.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    );
    expect(bgBase).toBe('#F8F0E6');
    await options.close();
  });

  test('explicit light overrides OS dark preference', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Set theme to light explicitly
    await options.click('#settingsBtn');
    await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
    await options.selectOption('#themeSelect', 'light');
    await options.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
      { timeout: 3000 }
    );

    // Emulate OS dark
    await options.emulateMedia({ colorScheme: 'dark' });

    // data-theme="light" should block the media query
    const bgBase = await options.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    );
    expect(bgBase).toBe('#F8F0E6');
    await options.close();
  });
});
