import { test, expect } from './fixtures.js';
import {
  measurePopupNoteSpacing,
  popupNoteSpacing,
} from '../fixtures/popup-layout.mjs';

const featureIds = ['find', 'highlight', 'ownership'];

test('each demo has its own section and stacks naturally on phones', async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  expect(
    await page
      .locator('.feature-section')
      .evaluateAll((sections) => sections.map((section) => section.id)),
  ).toEqual(featureIds);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(
    page.locator('#find .feature-copy, .demo-caption, .finder-demo figcaption'),
  ).toHaveCount(0);
  await expect(
    page.locator('.screenshot-grid, .detail-previews, .demo-panel'),
  ).toHaveCount(0);
  await expect(page.locator('.demo-window > iframe')).toHaveCount(2);
  await expect(
    page.frameLocator('.timeline-frame').locator('#mainTitle'),
  ).toHaveText('Timeline');
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    for (const id of featureIds) {
      const section = page.locator('#' + id);
      await section.scrollIntoViewIfNeeded();
      const media = section.locator(
        ':scope > .feature-demo:not([hidden]), :scope > .finder-demo',
      );
      await expect(media).toHaveCount(1);
      const copy = await (
        id === 'find' ? page.locator('.hero') : section.locator('.feature-copy')
      ).boundingBox();
      const bounds = await media.boundingBox();
      expect(bounds.y).toBeGreaterThan(copy.y + copy.height);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      if (id === 'find')
        expect(await media.evaluate((el) => el.clientHeight)).toBe(510);
      for (const iframe of await media.locator('iframe').all()) {
        const frameBounds = await iframe.boundingBox();
        expect(frameBounds.y + frameBounds.height).toBeLessThanOrEqual(
          bounds.y + bounds.height + 0.5,
        );
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page
      .locator('#highlight')
      .screenshot({ path: testInfo.outputPath('browser-' + width + '.png') });
  }
  expect(errors).toEqual([]);
});
test('select Timeline pages, read the fixed-height Book sample, and return to Timeline', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  const timeline = page.frameLocator('.timeline-frame');
  await expect(timeline.locator('.result-item')).toHaveCount(5);
  await expect(timeline.locator('.result-item').first()).toContainText(
    'Small web',
  );
  const lists = timeline.locator('#listsList');
  const nestedLists = lists.locator('.sidebar-children');
  await expect(lists.locator(':scope > .sidebar-item .label')).toHaveText([
    'Small web',
    'Design',
    'Cinema',
    'Writing',
    'Music',
    'Cooking',
  ]);
  await expect(nestedLists.locator('.label')).toHaveText(['Font', 'Drumming']);
  for (const name of ['Design', 'Music']) {
    const parent = lists.locator(
      `.sidebar-item[data-list-id="reading-list-${name.toLowerCase()}"]`,
    );
    const children = lists.locator(
      `.sidebar-children[data-parent-slug="reading-list-${name.toLowerCase()}"]`,
    );
    await expect(children).toBeVisible();
    const parentInset = await parent.evaluate((item) =>
      parseFloat(getComputedStyle(item).paddingLeft),
    );
    const childInset = await children
      .locator('.sidebar-item')
      .evaluate((item) => parseFloat(getComputedStyle(item).paddingLeft));
    expect(childInset - parentInset).toBe(16);
    await parent.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(children).toBeHidden();
    await parent.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(children).toBeVisible();
  }
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
  const mono = page.getByRole('radio', { name: 'Mono', exact: true });
  const amber = page.getByRole('radio', { name: 'Amber', exact: true });
  await expect(amber).toBeChecked();
  const swatch = page.locator('.style-swatch-mono');
  // Enlarge the rendered swatch to sample inside the border without subpixel
  // rounding hiding a repeated stripe at either edge.
  await swatch.evaluate((element) => {
    element.style.transform = 'scale(10)';
  });
  let pixels;
  try {
    pixels = await swatch.screenshot({ scale: 'css', animations: 'disabled' });
  } finally {
    await swatch.evaluate((element) =>
      element.style.removeProperty('transform'),
    );
  }
  const dark = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [0.04, 0.25, 0.75, 0.96].map(
      (fraction) =>
        context.getImageData(
          Math.floor(image.width * fraction),
          Math.floor(image.height / 2),
          1,
          1,
        ).data[0] < 140,
    );
  }, pixels.toString('base64'));
  expect(dark).toEqual([true, true, false, false]);
  await mono.check();
  await expect(timeline.locator('html')).toHaveAttribute(
    'data-color-scheme',
    'mono',
  );
  await expect(timeline.locator('body')).toHaveCSS('background-image', 'none');
  await expect(timeline.locator('#exploreBtn')).toHaveCSS(
    'background-color',
    'rgb(26, 26, 26)',
  );
  await expect(selected).toHaveCount(3);
  await page
    .locator('#find .demo-window')
    .screenshot({ path: testInfo.outputPath('desktop-preview-before.png') });
  if (await timeline.locator('.sidebar').isHidden()) {
    await timeline.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
  await timeline.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(timeline.locator('#mainTitle')).toHaveText('Book');
  await amber.check();
  await expect(timeline.locator('html')).not.toHaveAttribute(
    'data-color-scheme',
  );
  await expect(timeline.locator('#mainTitle')).toHaveText('Book');
  await amber.press('ArrowRight');
  await expect(mono).toBeChecked();
  await expect(timeline.locator('html')).toHaveAttribute(
    'data-color-scheme',
    'mono',
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
    await page.locator('#find .demo-window').screenshot({
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

test('desktop sidebar lists open matching pages and keep navigation state consistent', async ({
  page,
}) => {
  await page.goto('./');
  const desktop = page.frameLocator('.timeline-frame');
  const list = (name) =>
    desktop.locator('#listsList .sidebar-item').filter({
      has: desktop.locator('.label', { hasText: new RegExp(`^${name}$`) }),
    });
  await desktop.locator('.result-item').first().click();
  for (const [name, title, count] of [
    ['Small web', 'A smaller, slower web', 5],
    ['Design', 'Good tools leave room for you', 3],
    ['Font', 'Type that feels like a conversation', 4],
    ['Cinema', 'Film notes: Perfect Days', 2],
    ['Writing', 'A smaller, slower web', 5],
    ['Music', 'An evening of piano music', 3],
    ['Drumming', 'Practice a relaxed single-stroke roll', 2],
    ['Cooking', 'Lemon and white bean soup', 5],
  ]) {
    if (await desktop.locator('.sidebar').isHidden())
      await desktop.getByRole('button', { name: 'Toggle sidebar' }).click();
    await list(name).locator('.label').click();
    await expect(desktop.locator('#mainTitle')).toHaveText(name);
    await expect(list(name)).toHaveClass(/active/);
    await expect(desktop.locator('#exploreBtn')).not.toHaveClass(/active/);
    await expect(desktop.locator('#highlightsHistoryBtn')).not.toHaveClass(
      /active/,
    );
    await expect(desktop.locator('.result-item:visible')).toHaveCount(count);
    await expect(
      desktop.locator('.result-item:visible .result-title').first(),
    ).toHaveText(title);
    await expect(list(name).locator('.pin-count')).toHaveText(String(count));
    await expect(desktop.locator('#demoBook')).toBeHidden();
  }
  if (await desktop.locator('.sidebar').isHidden())
    await desktop.getByRole('button', { name: 'Toggle sidebar' }).click();
  await desktop.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(desktop.locator('#mainTitle')).toHaveText('Book');
  await expect(desktop.locator('#listsList .sidebar-item.active')).toHaveCount(
    0,
  );
  await expect(desktop.locator('#demoBook')).toBeVisible();
  if (await desktop.locator('.sidebar').isHidden())
    await desktop.getByRole('button', { name: 'Toggle sidebar' }).click();
  await desktop.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(desktop.locator('.result-item:visible')).toHaveCount(5);
  await expect(desktop.locator('#results .result-row.selected')).toHaveCount(1);
  const smallWeb = list('Small web').locator('.label');
  await smallWeb.focus();
  await smallWeb.press('Enter');
  await expect(desktop.locator('#mainTitle')).toHaveText('Small web');
  await expect(
    desktop.locator('.result-item:visible .result-title').first(),
  ).toHaveText('A smaller, slower web');
  await expect(desktop.locator('.result-item:visible')).toHaveCount(5);
  await page.setViewportSize({ width: 320, height: 760 });
  await desktop.getByRole('button', { name: 'Toggle sidebar' }).click();
  await list('Font').locator('.label').press(' ');
  await expect(desktop.locator('#mainTitle')).toHaveText('Font');
  await expect(desktop.locator('.sidebar')).toBeHidden();
  await expect(
    desktop.locator('.result-item:visible .result-title').first(),
  ).toHaveText('Type that feels like a conversation');
  await expect(desktop.locator('.result-item:visible')).toHaveCount(4);
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
  for (const [selector, openBook] of [
    ['.timeline-frame', false],
    ['.timeline-frame', true],
    ['.browser-frame', false],
    ['.popup-frame', false],
  ]) {
    const frame =
      selector === '.popup-frame'
        ? page.frameLocator('.browser-frame').locator(selector)
        : page.locator(selector);
    await frame.scrollIntoViewIfNeeded();
    if (openBook) {
      const desktop = page.frameLocator(selector);
      if (await desktop.locator('.sidebar').isHidden())
        await desktop.getByRole('button', { name: 'Toggle sidebar' }).click();
      await desktop.getByRole('button', { name: 'Book', exact: true }).click();
      await expect(desktop.locator('#mainTitle')).toHaveText('Book');
    }
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
    if (selector === '.timeline-frame')
      expect(
        await frame
          .contentFrame()
          .locator('.main')
          .evaluate((el) => el.scrollTop),
      ).toBe(0);
  }
  const finder = page.locator('.finder-window');
  await finder.scrollIntoViewIfNeeded();
  const bounds = await finder.boundingBox();
  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.wheel(0, 280);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(before + 120);
  if (browserName === 'chromium' && isMobile) {
    const frame = page.frameLocator('.browser-frame').locator('.popup-frame');
    await frame.scrollIntoViewIfNeeded();
    const bounds = await frame.boundingBox();
    const before = await page.evaluate(() => window.scrollY);
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height - 20;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    });
    for (const offset of [30, 60, 90, 120])
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y - offset }],
      });
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
  const timeline = page.frameLocator('.timeline-frame');
  const highlight = page.frameLocator('.browser-frame');
  const organize = highlight.frameLocator('.popup-frame');
  await expect(timeline.locator('#searchDraftInput')).toHaveJSProperty(
    'readOnly',
    true,
  );
  await expect(timeline.locator('#demoSearch')).toHaveJSProperty('inert', true);
  await expect(timeline.locator('.result-item')).toHaveCount(5);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'for your browser',
  );
  await page.locator('#highlight').scrollIntoViewIfNeeded();
  await highlight
    .getByRole('button', { name: 'Browser Recall popup' })
    .press('Escape');
  await expect(highlight.locator('.highlight-note-text')).toHaveText(
    'Leave a little room for curiosity.',
  );
  await expect(
    highlight.locator('#browser-recall-highlight-overlay .highlight-item'),
  ).toHaveCSS('border-top-width', '0px');
  await expect(
    highlight.getByRole('button', { name: 'Edit note', exact: true }),
  ).toBeDisabled();
  await expect(
    highlight.getByRole('button', { name: 'Delete highlight', exact: true }),
  ).toBeDisabled();
  await highlight.locator('.browser-recall-highlight').click();
  await expect(highlight.locator('[contenteditable]')).toHaveCount(0);
  await page
    .locator('#highlight')
    .screenshot({ path: testInfo.outputPath('highlights.png') });
  await page.locator('#highlight').scrollIntoViewIfNeeded();
  await highlight.getByRole('button', { name: 'Browser Recall popup' }).click();
  const popupNote = organize.locator('#highlightList .highlight-item');
  await expect(popupNote).toBeVisible();
  expect(
    await organize.locator('#notesSection').evaluate(measurePopupNoteSpacing),
  ).toEqual(popupNoteSpacing);
  await expect(popupNote.locator('.highlight-excerpt')).toHaveText(
    'Leave room for the unfinished things.',
  );
  await expect(popupNote.locator('.highlight-note-text')).toHaveText(
    'Leave a little room for curiosity.',
  );
  await expect(
    popupNote.getByRole('button', { name: 'Edit note' }),
  ).toBeDisabled();
  await expect(
    popupNote.getByRole('button', { name: 'Delete highlight' }),
  ).toBeDisabled();
  await organize.getByRole('button', { name: 'Music', exact: true }).click();
  await expect(organize.locator('#listCount')).toHaveText('03');
  await expect(highlight.locator('#browser-status')).toHaveText(
    'Recording on. One page, at home in 3 lists.',
  );
  for (const name of ['Small web', 'Writing', 'Music'])
    await organize.getByRole('button', { name, exact: true }).click();
  await expect(highlight.locator('#browser-status')).toHaveText(
    'Recording on. No lists selected. The page remains in your history.',
  );
  await page
    .locator('#highlight')
    .screenshot({ path: testInfo.outputPath('lists.png') });
  await page.screenshot({
    path: testInfo.outputPath('homepage.png'),
    fullPage: true,
  });
  await expect(
    page.getByRole('link', { name: 'All GitHub releases' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/tabokie/browser-recall/releases',
  );
  expect(errors).toEqual([]);
});

test('browser popup hides and restores article markup while keeping the saved note', async ({
  page,
}) => {
  await page.goto('./#highlight');
  const browser = page.frameLocator('.browser-frame');
  const popup = browser.frameLocator('.popup-frame');
  const hideMarkup = popup.getByRole('button', { name: /^hide markup$/i });
  const showMarkup = popup.getByRole('button', { name: /^show markup$/i });
  const articleMark = browser.locator('.browser-recall-highlight');
  const articleNote = browser.getByRole('group', {
    name: 'Saved highlight and note',
  });
  const savedNote = popup.locator('#highlightList .highlight-item');

  await expect(hideMarkup).toHaveAttribute('aria-pressed', 'false');
  await expect(articleMark).toBeVisible();
  await hideMarkup.click();
  await expect(showMarkup).toHaveAttribute('aria-pressed', 'true');
  await expect(articleMark).toHaveCount(0);
  await expect(articleNote).toBeHidden();
  await expect(savedNote).toBeVisible();

  await showMarkup.press('Escape');
  await expect(browser.locator('#extensionPopup')).toBeHidden();
  await browser.getByRole('button', { name: 'Browser Recall popup' }).click();
  await expect(showMarkup).toHaveAttribute('aria-pressed', 'true');
  await showMarkup.click();
  await expect(hideMarkup).toHaveAttribute('aria-pressed', 'false');
  await expect(articleMark).toHaveText('Leave room for the unfinished things.');
  await expect(articleNote).toBeVisible();
});

test('browser popup stays under its toolbar icon without covering the highlight or note', async ({
  page,
}) => {
  await page.goto('./');
  const browser = page.frameLocator('.browser-frame');
  await browser
    .frameLocator('.popup-frame')
    .getByRole('button', { name: 'CAPTURE FRAME', exact: true })
    .waitFor();
  for (const width of [900, 760, 640, 375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expect
      .poll(() =>
        browser.locator('body').evaluate(() => {
          const highlight = document
            .querySelector('.browser-recall-highlight')
            .getBoundingClientRect();
          const note = document
            .querySelector('#browser-recall-highlight-overlay')
            .shadowRoot.querySelector('.overlay')
            .getBoundingClientRect();
          const popup = document
            .querySelector('#extensionPopup')
            .getBoundingClientRect();
          const icon = document
            .querySelector('#extensionToggle')
            .getBoundingClientRect();
          const separate = (first, second) =>
            first.bottom <= second.top ||
            first.top >= second.bottom ||
            first.right <= second.left ||
            first.left >= second.right;
          return (
            popup.top >= icon.bottom &&
            popup.top <= icon.bottom + 8 &&
            Math.abs(popup.right - Math.min(innerWidth - 12, icon.right)) <=
              1 &&
            separate(highlight, popup) &&
            separate(note, popup) &&
            note.left >= 0 &&
            note.right <= innerWidth &&
            note.bottom <= innerHeight &&
            popup.bottom <= innerHeight
          );
        }),
      )
      .toBe(true);
    await expect(browser.locator('#extensionPopup')).toBeVisible();
  }
});

test('browser popup captures frames and preserves snapshots and list choices through recording changes', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  const browser = page.frameLocator('.browser-frame');
  const popup = browser.frameLocator('.popup-frame');
  const toggle = browser.getByRole('button', { name: 'Browser Recall popup' });
  const icon = toggle.locator('img');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(browser.locator('#extensionPopup')).toBeVisible();
  await browser.locator('.browser-chrome').click({ position: { x: 4, y: 4 } });
  await expect(browser.locator('#extensionPopup')).toBeVisible();
  await popup.getByRole('button', { name: 'Cinema', exact: true }).click();
  await expect(popup.locator('#listCount')).toHaveText('03');
  const snapshots = popup.locator('.snapshot-row');
  const capture = popup.getByRole('button', {
    name: 'CAPTURE FRAME',
    exact: true,
  });
  await expect(snapshots).toHaveCount(0);
  for (let index = 0; index < 8; index++) await capture.click();
  await expect(snapshots).toHaveCount(8);
  // Intl uses different date/time separators in Chromium and WebKit.
  await expect(snapshots.first().locator('.snapshot-time')).toHaveText(
    /^Sep 16(?:,| at) 10:08 AM$/,
  );
  await expect(snapshots.first().locator('.badge')).toHaveText([
    'Markdown',
    'HTML',
  ]);
  await expect
    .poll(async () => {
      const windowBounds = await page.locator('.browser-frame').boundingBox();
      const popupBounds = await browser
        .locator('#extensionPopup')
        .boundingBox();
      return (
        windowBounds.y +
        windowBounds.height -
        popupBounds.y -
        popupBounds.height
      );
    })
    .toBeGreaterThanOrEqual(23);
  await popup
    .getByRole('button', { name: 'Pause recording', exact: true })
    .click();
  await expect(popup.locator('#dashboardContent')).toBeHidden();
  await expect(
    popup.getByRole('button', { name: 'Resume recording' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(icon).toHaveAttribute('src', /extension-paused\.svg$/);
  await expect(icon).toHaveAttribute('alt', 'Recording paused');
  await expect
    .poll(() =>
      browser.locator('#extensionPopup').evaluate((el) => el.clientHeight),
    )
    .toBeLessThan(50);
  await page
    .locator('.browser-demo')
    .screenshot({ path: testInfo.outputPath('browser-paused.png') });
  await toggle.click();
  await expect(browser.locator('#extensionPopup')).toBeVisible();
  await popup.getByRole('button', { name: 'Resume recording' }).press('Escape');
  await expect(browser.locator('#extensionPopup')).toBeHidden();
  await toggle.press('Enter');
  await expect(
    popup.getByRole('button', { name: 'Resume recording' }),
  ).toBeVisible();
  await popup.getByRole('button', { name: 'Resume recording' }).click();
  await expect(icon).toHaveAttribute('src', /extension-recording\.svg$/);
  await expect(
    popup.getByRole('button', { name: 'Cinema', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(popup.locator('#listCount')).toHaveText('03');
  await expect(snapshots).toHaveCount(8);
  await popup.getByRole('button', { name: 'Pause recording' }).press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await page.setViewportSize({ width: 320, height: 760 });
  await toggle.press(' ');
  await expect(
    popup.getByRole('button', { name: 'Pause recording' }),
  ).toBeVisible();
  const windowBounds = await page.locator('.browser-frame').boundingBox();
  const popupBounds = await browser.locator('#extensionPopup').boundingBox();
  expect(popupBounds.x).toBeGreaterThan(windowBounds.x);
  expect(popupBounds.x + popupBounds.width).toBeLessThan(
    windowBounds.x + windowBounds.width,
  );
  await popup.getByRole('button', { name: 'Pause recording' }).click();
  await expect(icon).toHaveAttribute('alt', 'Recording paused');
  await popup.getByRole('button', { name: 'Resume recording' }).click();
  await expect(popup.locator('#listCount')).toHaveText('03');
  await expect(snapshots).toHaveCount(8);
  for (let index = 0; index < 8; index++)
    await popup
      .getByRole('button', { name: 'Delete snapshot', exact: true })
      .first()
      .click();
  await expect(snapshots).toHaveCount(0);
  await expect(popup.locator('#snapshotSection')).toHaveClass(/is-empty/);
  await capture.press('Enter');
  await expect(snapshots).toHaveCount(1);
  await page
    .locator('.browser-demo')
    .screenshot({ path: testInfo.outputPath('browser-phone.png') });
});

test('product navigation stays usable on narrow screens', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto('./');
  await page.setViewportSize({ width: 375, height: 812 });
  const timeline = page.frameLocator('.timeline-frame');
  await page.locator('#find .demo-window').screenshot({
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
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
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
  await expect(page.locator('.finder-filename')).toHaveText([
    'AGENTS.md',
    'logs',
    'objects',
    'views',
  ]);
  await expect(page.locator('.interactive-demo:visible')).toHaveCount(0);
  await expect(page.locator('.demo-still')).toHaveCount(2);
  for (const img of await page.locator('.demo-still img').all()) {
    await img.scrollIntoViewIfNeeded();
    await expect
      .poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0))
      .toBe(true);
  }
  await page
    .getByRole('link', { name: 'Get Browser Recall', exact: false })
    .first()
    .click();
  await expect(page).toHaveURL(/#get-started$/);
  await expect(
    page.getByRole('link', { name: 'Firefox', exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Chrome and others' }),
  ).toHaveAttribute(
    'href',
    'https://chromewebstore.google.com/detail/bgghgkobpfgcinpjjeeconciefclpdgp',
  );
  await expect(
    page.getByRole('button', { name: 'Mac App Store Coming soon' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: 'Windows installer' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/tabokie/browser-recall/releases/latest',
  );
  await context.close();
});
