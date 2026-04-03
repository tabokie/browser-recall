import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Accessibility', () => {
  test.beforeEach(async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);
  });

  test('focus-visible outline exists for interactive elements', async ({ extContext, extensionId }) => {
    const page = await openOptionsPage(extContext, extensionId);

    // Verify that :focus-visible styles produce a visible outline on buttons
    const hasOutline = await page.evaluate(() => {
      const btn = document.querySelector('.settings-btn');
      btn.focus();
      const style = getComputedStyle(btn);
      // Should have a non-none outline when focused
      return style.outlineStyle !== 'none' && style.outlineStyle !== '';
    });
    expect(hasOutline).toBe(true);

    await page.close();
  });

  test('settings modal has role="dialog"', async ({ extContext, extensionId }) => {
    const page = await openOptionsPage(extContext, extensionId);

    const role = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      return modal?.getAttribute('role');
    });
    expect(role).toBe('dialog');

    await page.close();
  });

  test('icon-only buttons have accessible labels', async ({ extContext, extensionId }) => {
    const page = await openOptionsPage(extContext, extensionId);

    // confirmTitleBtn (checkmark icon) should have a title or aria-label
    const confirmLabel = await page.evaluate(() => {
      const btn = document.getElementById('confirmTitleBtn');
      return btn?.getAttribute('title') || btn?.getAttribute('aria-label') || '';
    });
    expect(confirmLabel).toBeTruthy();

    // modal close button should have a title or aria-label
    const closeLabel = await page.evaluate(() => {
      const btn = document.getElementById('settingsClose');
      return btn?.getAttribute('title') || btn?.getAttribute('aria-label') || '';
    });
    expect(closeLabel).toBeTruthy();

    await page.close();
  });

  test('clickable sidebar items have button role', async ({ extContext, extensionId }) => {
    const page = await openOptionsPage(extContext, extensionId);

    // Recycle bin (static HTML clickable div) should have role=button
    const recycleRole = await page.evaluate(() => {
      const el = document.getElementById('recycleBinBtn');
      return el?.tagName === 'BUTTON' || el?.getAttribute('role') === 'button';
    });
    expect(recycleRole).toBe(true);

    await page.close();
  });
});
