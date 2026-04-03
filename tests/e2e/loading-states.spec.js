import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Loading states', () => {
  test('options page uses spinner instead of Loading... text', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const page = await openOptionsPage(extContext, extensionId);

    // The cache table should use a spinner, not "Loading..." text
    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.modal-overlay.open', { timeout: 3000 });

    // Cache table should not contain plain "Loading..." text.
    // It should either have loaded data or have a spinner element.
    const cacheBody = page.locator('#cacheTableBody');
    await expect(cacheBody).not.toHaveText(/^Loading\.\.\.$/);

    await page.close();
  });

  test('page detail loading uses spinner element', async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);

    const page = await openOptionsPage(extContext, extensionId);

    // Verify that the page-detail-loading class uses a spinner
    // The .spinner CSS class should exist in the page
    const hasSpinnerKeyframes = await page.evaluate(() => {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'spin') {
              return true;
            }
          }
        } catch {}
      }
      return false;
    });
    expect(hasSpinnerKeyframes).toBe(true);

    // Verify .spinner class exists and has animation
    const spinnerStyle = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'spinner';
      document.body.appendChild(el);
      const style = getComputedStyle(el);
      const hasAnimation = style.animationName !== 'none' && style.animationName !== '';
      document.body.removeChild(el);
      return hasAnimation;
    });
    expect(spinnerStyle).toBe(true);

    await page.close();
  });
});
