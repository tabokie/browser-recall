import { test, expect } from '@playwright/test';

test('local previews never load GoatCounter', async ({ page }) => {
  const trackerRequests = [];
  await page.route(
    /https:\/\/(gc\.zgo\.at|tabokie\.goatcounter\.com)\//,
    (route) => {
      trackerRequests.push(route.request().url());
      return route.abort();
    },
  );
  await page.goto('./');
  await expect(page.getByRole('tab', { name: 'Find again' })).toBeVisible();
  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await expect(
    page.frameLocator('.highlight-frame').locator('.highlight-note-text'),
  ).toBeVisible();
  for (const frame of page.frames()) {
    await expect(frame.locator('script[data-goatcounter]')).toHaveCount(0);
  }
  expect(trackerRequests).toEqual([]);
});

test('the HTTPS page configures one tracker and works when the tracker is blocked', async ({
  page,
}) => {
  const errors = [];
  const trackerRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Exercise an isolated HTTPS origin entirely from the local preview. Block
  // GoatCounter so this scenario never adds visits to the real dashboard.
  await page.route('https://browser-recall.test/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:4173${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  await page.route(
    /https:\/\/(gc\.zgo\.at|tabokie\.goatcounter\.com)\//,
    (route) => {
      trackerRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  await page.goto(
    'https://browser-recall.test/browser-recall/?source=sample#explore',
  );
  const script = page.locator('script[data-goatcounter]');
  await expect(script).toHaveCount(1);
  await expect(script).toHaveAttribute('src', 'https://gc.zgo.at/count.js');
  await expect(script).toHaveAttribute(
    'data-goatcounter',
    'https://tabokie.goatcounter.com/count',
  );
  expect(
    await script.evaluate((element) =>
      JSON.parse(element.dataset.goatcounterSettings),
    ),
  ).toEqual({ path: '/browser-recall/', no_events: true });
  await expect(script).toHaveJSProperty('async', true);

  await page.getByRole('tab', { name: 'Organize', exact: true }).click();
  const organize = page.frameLocator('.organize-frame');
  await organize.getByRole('button', { name: 'Design details' }).click();
  await expect(organize.locator('#listCount')).toHaveText('03');
  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await expect(
    page.frameLocator('.highlight-frame').locator('.highlight-note-text'),
  ).toBeVisible();
  for (const frame of page
    .frames()
    .filter((frame) => frame !== page.mainFrame())) {
    await expect(frame.locator('script[data-goatcounter]')).toHaveCount(0);
  }
  expect(trackerRequests).toEqual(['https://gc.zgo.at/count.js']);
  expect(errors).toEqual([]);
});
