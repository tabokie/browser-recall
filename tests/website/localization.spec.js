import { test, expect } from './fixtures.js';

test.use({ locale: 'zh-CN' });

test('Chinese browser preferences translate the website and switching languages preserves the demos', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page).toHaveTitle('Browser Recall：给浏览器添一点记性');
  await expect(page.locator('#hero-title')).toHaveText('给浏览器添一点记性。');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /找回读过的网页/,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    'content',
    /网页快照/,
  );
  await expect(
    page.getByRole('link', { name: '下载 Browser Recall', exact: true }),
  ).toHaveAttribute('href', '#get-started');
  const viewport = page.viewportSize();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [viewport.width, 375, 320]) {
    await page.setViewportSize({ ...viewport, width });
    await expect(
      page.getByRole('button', { name: '切换为英文' }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const brand = await page.locator('.wordmark').boundingBox();
    const navigation = await page.locator('.site-header nav').boundingBox();
    expect(brand.x + brand.width).toBeLessThan(navigation.x);
  }
  await page.setViewportSize(viewport);
  await page.getByRole('radio', { name: '黑白', exact: true }).check();
  const desktop = page.frameLocator('.timeline-frame');
  await expect(desktop.locator('html')).toHaveAttribute(
    'data-color-scheme',
    'mono',
  );
  await expect(page.locator('.finder-tree')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(page.locator('.finder-status')).toHaveText('4 项，已选中 1 项');
  const selection = page.locator('.finder-row[aria-selected="true"]');
  const path = await selection.getAttribute('data-path');
  await expect(
    page.getByRole('button', { name: '折叠 logs', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '切换为英文' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#highlight-title')).toHaveText(
    'Leave yourself a note.',
  );
  await expect(
    page.getByRole('radio', { name: 'Mono', exact: true }),
  ).toBeChecked();
  await expect(desktop.locator('html')).toHaveAttribute(
    'data-color-scheme',
    'mono',
  );
  await expect(selection).toHaveAttribute('data-path', path);
  await expect(page.locator('.finder-status')).toHaveText(
    '4 items, 1 selected',
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('locale detection uses the first supported browser preference', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'languages', {
      get: () => ['fr-FR', 'zh-TW', 'en-US'],
    }),
  );
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#get-started-title')).toHaveText(
    '安装 Browser Recall',
  );
});

test('English preference and explicit language links choose the expected locale', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'zh-CN'],
    }),
  );
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.goto('./?lang=zh-CN#highlight');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.getByRole('button', { name: '切换为英文' }).click();
  await expect(page).toHaveURL(/lang=en#highlight$/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('unsupported languages fall back to English and switching works without local storage', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'fr-FR'],
    });
    Storage.prototype.getItem = () => {
      throw new Error('Storage blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('Storage blocked');
    };
  });
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#ownership-title')).toHaveText(
    '把资料放在你选的文件夹里。',
  );
  expect(errors).toEqual([]);
});
