import { test, expect } from '@playwright/test';

test('explore the collection, write a note, and organize one page into several lists', async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.evaluate(() => document.fonts.ready);
  const windowBottom = await page
    .locator('.demo-window')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  for (const content of await page.locator('#panel-find > :visible').all()) {
    expect(
      await content.evaluate(
        (element) => element.getBoundingClientRect().bottom,
      ),
    ).toBeLessThanOrEqual(windowBottom);
  }
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'for your browser',
  );
  await page.screenshot({
    path: testInfo.outputPath('homepage.png'),
    fullPage: true,
  });

  const search = page.getByRole('searchbox');
  await search.fill('GARDEN');
  await search.press('Enter');
  await expect(page.locator('.history-row:visible')).toHaveCount(1);
  await expect(page.locator('.history-row:visible')).toContainText(
    'A garden that grows with you',
  );
  // Search a sample note that does not appear in the page title.
  await search.fill('unfinished');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('.history-row:visible')).toHaveCount(1);
  await expect(page.locator('.history-row:visible')).toContainText(
    'A smaller, slower web',
  );
  await search.fill('not in the collection');
  await search.press('Enter');
  await expect(
    page.getByText('No pages found in this sample.', { exact: false }),
  ).toBeVisible();
  await search.fill('');
  await expect(page.locator('.history-row:visible')).toHaveCount(5);

  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await page
    .getByLabel('Your note', { exact: true })
    .fill('Keep some room for a personal website.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(
    page.getByText('Note saved in this demo', { exact: true }),
  ).toBeVisible();
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('highlights.png') });

  await page.getByRole('tab', { name: 'Organize', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Design details' }).check();
  await expect(
    page.getByText('One page, at home in 3 lists.', { exact: true }),
  ).toBeVisible();
  for (const name of ['Small web', 'Design details', 'Weekend reading']) {
    await page.getByRole('checkbox', { name }).uncheck();
  }
  await expect(
    page.getByText('No lists selected. The page remains in your history.'),
  ).toBeVisible();
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('lists.png') });
  await page.getByRole('tab', { name: 'Keep a copy' }).click();
  await expect(page.locator('.snapshot-toolbar')).toContainText(
    'Saved snapshot',
  );
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('snapshot.png') });
  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await expect(page.getByLabel('Your note', { exact: true })).toHaveValue(
    'Keep some room for a personal website.',
  );
  await expect(
    page.getByText('Note saved in this demo', { exact: true }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Find again' }).click();
  await expect(page.locator('.history-row:visible')).toHaveCount(5);
  await page.getByText('See Browser Recall in use', { exact: false }).click();
  for (const image of await page.locator('.screenshot-grid img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate(
          (element) => element.complete && element.naturalWidth > 0,
        ),
      )
      .toBe(true);
  }
  await expect(
    page.getByRole('link', { name: 'Desktop releases' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/tabokie/browser-recall/releases',
  );
  expect(errors).toEqual([]);
});

test('feature tabs support keyboard navigation and fit narrow screens', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  const first = page.getByRole('tab', { name: 'Find again' });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Highlight', exact: true }),
  ).toBeFocused();
  await expect(page.locator('#panel-highlight')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Keep a copy' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Keep a copy' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();

  await page.setViewportSize({ width: 320, height: 760 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  }
  await page.getByRole('tab', { name: 'Find again' }).click();
  await page.screenshot({
    path: testInfo.outputPath('narrow-homepage.png'),
    fullPage: true,
  });
});

test('product information, screenshots, and installation links work without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/browser-recall/');
  await expect(
    page.getByText('Enable JavaScript to try the interactive illustration.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByText('See Browser Recall in use', { exact: false }).click();
  await expect(page.locator('.screenshot-grid')).toBeVisible();
  await page
    .getByRole('link', { name: 'Get Browser Recall', exact: false })
    .first()
    .click();
  await expect(page).toHaveURL(/#get-started$/);
  await expect(
    page.getByRole('link', { name: 'Firefox', exact: false }),
  ).toBeVisible();
  await context.close();
});
