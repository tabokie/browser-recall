import { test, expect } from './fixtures.js';
import { openHelperPage } from './helpers.js';
import { seedManualData } from '../../scripts/lib/manual-seed.mjs';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';

test('manual seed data is accepted by the daemon and flushes the connector', async ({
  setupDir,
  extContext,
  extensionId,
}) => {
  void setupDir;
  const page = await openHelperPage(extContext, extensionId);
  try {
    const reset = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'resetForTest' }),
    );
    expect(reset).toMatchObject({ success: true });

    const settings = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'readDesktopValue',
        key: 'manifest:settings',
      }),
    );
    expect(settings).toMatchObject({ success: true });

    const files = await seedManualData({
      events: [
        {
          action: 'rate_page',
          url: 'https://manual-seed.example/page',
          title: 'Manual seed page',
          timestamp: 1_710_000_000_000,
          likes: 1,
        },
        {
          action: 'update_setting',
          key: 'theme',
          value: 'dark',
          timestamp: 1_710_000_000_001,
        },
      ],
      deviceId: 'manual-seed-device',
      currentSettings: settings.value,
      sendMessage: (message) =>
        page.evaluate(
          (payload) => chrome.runtime.sendMessage(payload),
          message,
        ),
    });
    const settingsFile = files.find(
      (file) => file.path === 'views/manifest/settings.json',
    );
    expect(settingsFile?.data).toMatchObject({
      theme: 'dark',
      titleTrimRules: [],
    });
    expect(settingsFile?.data).not.toHaveProperty('trimRules');

    const pageKey = `page:${generateSlugFromUrl('https://manual-seed.example/page')}`;
    const pageState = await page.evaluate(
      (key) => chrome.runtime.sendMessage({ action: 'readDesktopValue', key }),
      pageKey,
    );
    expect(pageState).toMatchObject({ success: true });
    expect(pageState.value).toMatchObject({
      url: 'https://manual-seed.example/page',
    });
  } finally {
    await page.close();
  }
});
