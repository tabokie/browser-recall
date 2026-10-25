import { test, expect } from '@playwright/test';

test('all feature demos keep the same viewport height on phones', async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    for (const name of ['Find again', 'Highlight', 'Organize', 'Keep a copy']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await expect
        .poll(() =>
          page
            .locator('.demo-window')
            .evaluate((element) => element.clientHeight),
        )
        .toBe(510);
      await expect(page.locator('[role="tabpanel"]:visible')).toBeInViewport();
      const bottom = await page
        .locator('.demo-window')
        .evaluate((element) => element.getBoundingClientRect().bottom);
      for (const content of await page
        .locator(
          '[role="tabpanel"]:visible .feature-copy, [role="tabpanel"]:visible .product-viewport',
        )
        .all()) {
        await expect
          .poll(() =>
            content.evaluate(
              (element) => element.getBoundingClientRect().bottom,
            ),
          )
          .toBeLessThanOrEqual(bottom);
      }
      await page.locator('.demo-window').screenshot({
        path: testInfo.outputPath(`${width}-${name.replaceAll(' ', '-')}.png`),
      });
    }
  }
  expect(errors).toEqual([]);
});

test('select Timeline pages, read the fixed-height Book sample, and return to Timeline', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  const timeline = page.frameLocator('.timeline-frame');
  await expect(timeline.locator('.result-item')).toHaveCount(5);
  const rows = timeline.locator('.result-row');
  const selected = timeline.locator('.result-row.selected');
  await rows.nth(0).click();
  await expect(selected).toHaveCount(1);
  await expect(rows.nth(0)).toHaveClass(/selected/);
  const selectedFill = await rows
    .nth(0)
    .evaluate(
      (row) => getComputedStyle(row.closest('.result-item')).backgroundColor,
    );
  const unselectedFill = await rows
    .nth(1)
    .evaluate(
      (row) => getComputedStyle(row.closest('.result-item')).backgroundColor,
    );
  expect(selectedFill).not.toBe(unselectedFill);
  await rows.nth(1).click();
  await expect(selected).toHaveCount(1);
  await expect(rows.nth(0)).not.toHaveClass(/selected/);
  await rows.nth(1).click();
  await expect(selected).toHaveCount(0);
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ['ControlOrMeta'] });
  await expect(selected).toHaveCount(2);
  await rows.nth(4).click({ modifiers: ['Shift'] });
  await expect(selected).toHaveCount(3);
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('desktop-preview-before.png') });
  if (await timeline.locator('.sidebar').isHidden()) {
    await timeline.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
  await timeline.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Find again' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(timeline.locator('#mainTitle')).toHaveText('Book');
  await expect(timeline.locator('.highlight-history-list')).toBeVisible();
  await expect(timeline.locator('.highlight-history-list')).toContainText(
    'Leave the unfinished bits in.',
  );
  await expect(timeline.locator('.highlight-history-date-label')).toHaveText([
    '260916',
    '260915',
    '260913',
  ]);
  await expect(timeline.locator('.highlight-history-entry')).toHaveCount(9);
  await expect(
    timeline.locator('#demoBook button, #demoBook [role="link"]'),
  ).toHaveCount(0);
  // Justif keeps passages that fit on one line in their native layout.
  await expect(
    timeline.locator('.detail-note-excerpt').first(),
  ).toHaveAttribute('data-justif', '');
  await expect(timeline.locator('.detail-note-content').last()).toHaveAttribute(
    'data-justif',
    '',
  );
  await expect(timeline.locator('.detail-note-excerpt').last()).toContainText(
    'Some ideas need to be met twice.',
  );
  const originalViewport = page.viewportSize();
  for (const width of [originalViewport.width, 320]) {
    await page.setViewportSize({ ...originalViewport, width });
    await timeline.locator('body').evaluate(() => document.fonts.ready);
    await expect(
      timeline.locator('.detail-note-excerpt .justif-seg').first(),
    ).toBeVisible();
    const frameHeight = await page
      .locator('.timeline-frame')
      .evaluate((frame) => frame.clientHeight);
    expect(frameHeight).toBe(510);
    const bookBottom = await timeline
      .locator('.highlight-history-list')
      .evaluate((element) => element.getBoundingClientRect().bottom);
    expect(bookBottom).toBeGreaterThan(frameHeight);
    await expect(
      timeline.locator('.detail-note-excerpt').last(),
    ).not.toBeInViewport();
    expect(
      await timeline.locator('.main').evaluate((main) => main.scrollTop),
    ).toBe(0);
    await page.locator('.demo-window').screenshot({
      path: testInfo.outputPath(width === 320 ? 'book-narrow.png' : 'book.png'),
    });
  }
  await page.setViewportSize(originalViewport);
  if (await timeline.locator('.sidebar').isHidden()) {
    await timeline.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
  await timeline.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(timeline.locator('#mainTitle')).toHaveText('Timeline');
  await expect(timeline.locator('.result-item:visible')).toHaveCount(5);
  await expect(selected).toHaveCount(3);
  await expect
    .poll(() =>
      page.locator('.timeline-frame').evaluate((frame) => frame.clientHeight),
    )
    .toBe(510);
});

test('scrolling over every product preview moves the main page', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(
    browserName === 'webkit' && isMobile,
    'Playwright does not support native swipe or wheel input in mobile WebKit; webkit-scroll covers wheel chaining.',
  );
  await page.goto('./');
  for (const [name, selector] of [
    ['Find again', '.timeline-frame'],
    ['Book', '.timeline-frame'],
    ['Highlight', '.highlight-frame'],
    ['Organize', '.organize-frame'],
  ]) {
    if (name === 'Book') {
      const timeline = page.frameLocator('.timeline-frame');
      if (await timeline.locator('.sidebar').isHidden()) {
        await timeline.getByRole('button', { name: 'Toggle sidebar' }).click();
      }
      await timeline.getByRole('button', { name: 'Book', exact: true }).click();
    } else {
      await page.getByRole('tab', { name, exact: true }).click();
    }
    const frame = page.locator(selector);
    await frame.scrollIntoViewIfNeeded();
    const bounds = await frame.boundingBox();
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.wheel(0, 280);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(before + 120);
    expect(
      await frame
        .contentFrame()
        .locator('body')
        .evaluate(() => window.scrollY),
    ).toBe(0);
  }
  expect(
    await page
      .frameLocator('.timeline-frame')
      .locator('.main')
      .evaluate((element) => element.scrollTop),
  ).toBe(0);

  if (browserName === 'chromium' && isMobile) {
    const frame = page.locator('.organize-frame');
    await frame.scrollIntoViewIfNeeded();
    const bounds = await frame.boundingBox();
    const before = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height - 20;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (const offset of [30, 60, 90, 120]) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - offset }],
      });
    }
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(before + 40);
    await session.detach();
  }
});

test('view the sample collection and saved note, then organize one page into several lists', async ({
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
  await expect(timeline.locator('#searchDraftInput')).toHaveJSProperty(
    'readOnly',
    true,
  );
  await expect(timeline.locator('#demoSearch')).toHaveJSProperty('inert', true);
  await expect(timeline.locator('.result-item')).toHaveCount(5);

  await page.getByRole('tab', { name: 'Highlight', exact: true }).click();
  await expect(highlight.locator('.highlight-note-text')).toHaveText(
    'Leave a little room for curiosity.',
  );
  await expect(
    highlight.getByRole('button', { name: 'Edit note', exact: true }),
  ).toBeDisabled();
  await expect(
    highlight.getByRole('button', { name: 'Delete highlight', exact: true }),
  ).toBeDisabled();
  await highlight.locator('.browser-recall-highlight').click();
  await expect(highlight.locator('[contenteditable]')).toHaveCount(0);
  await page
    .locator('.demo-window')
    .screenshot({ path: testInfo.outputPath('highlights.png') });
  await page.getByRole('tab', { name: 'Organize', exact: true }).click();
  await organize.getByRole('button', { name: 'Design details' }).click();
  await expect(organize.locator('#listCount')).toHaveText('03');
  await expect(
    page.getByText('One page, at home in 3 lists.', { exact: true }),
  ).toHaveText('One page, at home in 3 lists.');
  for (const name of ['Small web', 'Design details', 'Weekend reading']) {
    await organize.getByRole('button', { name, exact: true }).click();
  }
  await expect(
    page.getByText('No lists selected. The page remains in your history.'),
  ).toHaveText('No lists selected. The page remains in your history.');
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
  await expect(highlight.locator('.highlight-note-text')).toHaveText(
    'Leave a little room for curiosity.',
  );

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
  isMobile,
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

  await page.setViewportSize({ width: 375, height: 812 });
  const timeline = page.frameLocator('.timeline-frame');
  await page.locator('.demo-window').screenshot({
    path: testInfo.outputPath('phone-sidebar.png'),
  });
  await expect(timeline.locator('.sidebar')).toBeVisible();
  await expect(
    timeline.getByRole('button', { name: 'Toggle sidebar' }),
  ).toBeHidden();
  const book = timeline.getByRole('button', { name: 'Book', exact: true });
  if (isMobile) await book.tap();
  else await book.click();
  await expect(timeline.locator('#mainTitle')).toHaveText('Book');
  await timeline.getByRole('button', { name: 'Timeline', exact: true }).click();

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(timeline.locator('.sidebar')).toBeHidden();
  await timeline.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(timeline.locator('.sidebar')).toBeVisible();
  await timeline.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(timeline.locator('#mainTitle')).toHaveText('Book');
  await expect(timeline.locator('.sidebar')).toBeHidden();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
  }
  await page.getByRole('tab', { name: 'Find again' }).click();
  await expect(
    timeline.locator('.detail-note-excerpt .justif-seg').first(),
  ).toBeVisible();
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
