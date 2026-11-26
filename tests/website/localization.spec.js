import { test, expect } from './fixtures.js';
import { SUPPORTED_LOCALES } from '../../packages/core/i18n.js';

test.use({ locale: 'zh-CN' });

test('Chinese browser preferences translate the website and switching languages preserves the demos', async ({
  page,
}) => {
  await page.goto('./');
  const language = page.getByRole('combobox');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(language).toHaveAccessibleName('语言');
  await expect(language).toHaveValue('zh-CN');
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
    await expect(language).toBeInViewport();
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
  await language.selectOption('en');
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
  await language.selectOption('zh-CN');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
});

test('locale detection skips bare English and unsupported browser languages', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en', 'sv-SE', 'fr-FR', 'zh-TW'],
    }),
  );
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#get-started-title')).toHaveText(
    'Installer Browser Recall',
  );
});

test('a regional English browser language takes precedence over later languages', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en', 'en-US', 'zh-CN'],
    }),
  );
  await page.goto('./');
  await expect(page.getByRole('combobox')).toHaveValue('en');
});

test('the desktop language picker resizes to fit the selected language', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 650 });
  await page.goto('./?lang=zh-CN');
  await page.evaluate(() => document.fonts.ready);
  const language = page.getByRole('combobox');
  const { width: chineseWidth } = await language.boundingBox();
  await language.selectOption('pt-PT');
  await page.evaluate(() => document.fonts.ready);
  const { width: portugueseWidth } = await language.boundingBox();
  expect(portugueseWidth).toBeGreaterThan(chineseWidth + 20);
  await expect(language).toHaveCSS('border-top-width', '0px');
});

test('an explicit language link takes precedence over the saved and browser languages', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en', 'zh-CN', 'en-US'],
    }),
  );
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const language = page.getByRole('combobox');
  await language.selectOption('pt-BR');
  await page.goto('./?lang=zh-Hant-HK#highlight');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('#get-started-title')).toHaveText(
    '安裝 Browser Recall',
  );
  await language.selectOption('pt-PT');
  await expect(page).toHaveURL(/lang=pt-PT#highlight$/);
  await expect(page.locator('.hero-actions a')).toHaveText(
    'Descarregar Browser Recall',
  );
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-PT');
});

test('unsupported languages fall back to English and switching works without local storage', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['sv-SE', 'nl-NL'],
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
  await page.getByRole('combobox').selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('#ownership-title')).toHaveText(
    '把资料放在你选的文件夹里。',
  );
  expect(errors).toEqual([]);
});

test('every product locale translates the website and fits the language picker at phone width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('./?lang=en');
  const language = page.getByRole('combobox');
  await expect(language.locator('option')).toHaveText(
    SUPPORTED_LOCALES.map(({ nativeName }) => nativeName),
  );
  await expect(page.locator('.finder-tree')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  for (const { code, nativeName } of SUPPORTED_LOCALES) {
    await test.step(nativeName, async () => {
      await language.selectOption(code);
      await expect(language.locator('option:checked')).toHaveAttribute(
        'lang',
        code,
      );
      await expect(page.locator('html')).toHaveAttribute('lang', code);
      await expect(page.locator('html')).toHaveAttribute(
        'dir',
        code === 'ar' ? 'rtl' : 'ltr',
      );
      await expect(page.locator('#hero-title em')).toBeVisible();
      if (code !== 'en') {
        await expect(page.locator('#highlight-title')).not.toHaveText(
          'Leave yourself a note.',
        );
        await expect(page.locator('.finder-status')).not.toHaveText(
          '4 items, 1 selected',
        );
      }
      await expect(language).toBeInViewport();
      if (code.startsWith('pt-')) {
        await expect(page.locator('.language-compact-label')).toHaveText(
          code.toUpperCase(),
        );
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(320);
    });
  }
});
