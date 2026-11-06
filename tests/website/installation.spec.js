import { test, expect, releaseApi, windowsInstallerUrl } from './fixtures.js';

test('Windows opens the latest published installer independently of the website version', async ({
  page,
}, testInfo) => {
  // Check the website's navigation to the installer. WebKit cannot simulate an
  // attachment or redirect with route.fulfill; real HTTP downloads work normally.
  await page.route(windowsInstallerUrl, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Windows installer fixture</h1>',
    }),
  );
  await page.goto('./#get-started');
  const downloadLink = page.getByRole('link', { name: 'Windows installer' });
  await expect(downloadLink).toHaveAttribute('href', windowsInstallerUrl);
  await page.evaluate(() => document.fonts.ready);
  for (const width of [page.viewportSize().width, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#get-started').screenshot({
      path: testInfo.outputPath(`installation-${width}.png`),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
  await downloadLink.click();
  await expect(page).toHaveURL(windowsInstallerUrl);
});

test('Windows keeps the latest release page available when release lookup fails or lacks an installer', async ({
  page,
}) => {
  const latestReleaseUrl =
    'https://github.com/tabokie/browser-recall/releases/latest';
  await page.route(latestReleaseUrl, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Latest release</h1>',
    }),
  );
  for (const response of [
    { status: 429, json: { message: 'API rate limit exceeded' } },
    { json: { tag_name: 'v9.8.7', assets: [] } },
    {
      json: {
        tag_name: 'v9.8.7',
        assets: [
          {
            name: 'browser-recall-v9.8.7-windows-x64-setup.exe',
            browser_download_url: 'https://unrelated.example/installer.exe',
          },
        ],
      },
    },
  ]) {
    await page.route(releaseApi, (route) => route.fulfill(response));
    const completed = page.waitForResponse(releaseApi);
    await page.goto('./#get-started');
    await (await completed).finished();
    await expect(
      page.getByRole('link', { name: 'Windows installer' }),
    ).toHaveAttribute('href', latestReleaseUrl);
    await page.getByRole('link', { name: 'Windows installer' }).click();
    await expect(page).toHaveURL(latestReleaseUrl);
  }
});
