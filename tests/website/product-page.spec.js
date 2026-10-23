import { test, expect } from '@playwright/test';

test('explore the collection, write a note, and organize one page into several lists', async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(
    page.frameLocator('.timeline-frame').locator('.result-item'),
  ).toHaveCount(5);
  for (const frame of page.frames())
    await frame.evaluate(() => document.fonts.ready);
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

  const timeline = page.frameLocator('.timeline-frame');
  const highlight = page.frameLocator('.highlight-frame');
  const organize = page.frameLocator('.organize-frame');
  const search = timeline.getByRole('searchbox');
  await search.fill('GARDEN');
  await search.press('Enter');
  await expect(timeline.locator('.result-item:visible')).toHaveCount(1);
  await expect(timeline.locator('.result-item:visible')).toContainText(
    'A garden that grows with you',
  );
  // Search a sample note that does not appear in the page title.
  await search.fill('unfinished');
  await search.press('Enter');
  await expect(timeline.locator('.result-item:visible')).toHaveCount(1);
  await expect(timeline.locator('.result-item:visible')).toContainText(
    'A smaller, slower web',
  );
  await search.fill('not in the collection');
  await search.press('Enter');
  await expect(
    timeline.getByText('No pages found in this sample.', { exact: false }),
  ).toBeVisible();
  await search.fill('');
  await expect(timeline.locator('.result-item:visible')).toHaveCount(5);

  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await highlight
    .getByRole('button', { name: 'Edit highlighted passage' })
    .click();
  // The actual extension editor uses a closed shadow root. Exercise its
  // focused contenteditable with the keyboard, as a user does.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Keep some room for a personal website.');
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('highlights.png') });
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#note-status')).toContainText(
    'Note saved in this demo',
  );
  await page.getByRole('tab', { name: 'Organize', exact: true }).click();
  await organize.getByRole('button', { name: 'Design details' }).click();
  await expect(organize.locator('#listCount')).toHaveText('03');
  await expect(
    page.getByText('One page, at home in 3 lists.', { exact: true }),
  ).toBeVisible();
  for (const name of ['Small web', 'Design details', 'Weekend reading']) {
    await organize.getByRole('button', { name, exact: true }).click();
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
  await highlight
    .getByRole('button', { name: 'Edit highlighted passage' })
    .click();
  await page.keyboard.press('ControlOrMeta+A');
  await expect
    .poll(() =>
      highlight
        .locator('body')
        .evaluate(() => window.getSelection().toString()),
    )
    .toBe('Keep some room for a personal website.');
  await page.keyboard.press('Control+Enter');

  await page.getByRole('tab', { name: 'Find again' }).click();
  await expect(timeline.locator('.result-item:visible')).toHaveCount(5);
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
