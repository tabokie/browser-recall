import { test as base, expect } from '@playwright/test';

export const releaseApi =
  'https://api.github.com/repos/tabokie/browser-recall/releases/latest';
export const windowsInstallerUrl =
  'https://github.com/tabokie/browser-recall/releases/download/v9.8.7/browser-recall-v9.8.7-windows-x64-setup.exe';

// Website scenarios must not depend on GitHub availability or the current release.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(releaseApi, (route) =>
      route.fulfill({
        json: {
          tag_name: 'v9.8.7',
          assets: [
            { name: 'browser-recall-v9.8.7-macos-arm64.dmg' },
            { name: 'browser-recall-v9.8.7-windows-x64-setup.exe.sig' },
            {
              name: 'browser-recall-v9.8.7-windows-x64-setup.exe',
              browser_download_url: windowsInstallerUrl,
            },
          ],
        },
      }),
    );
    await use(page);
  },
});

export { expect };
