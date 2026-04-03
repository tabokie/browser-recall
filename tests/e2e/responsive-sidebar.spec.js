import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Responsive sidebar', () => {
  test.beforeEach(async ({ extContext, extensionId, setupDir }) => {
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
    ]);
  });

  test('sidebar collapses below breakpoint and toggle button appears', async ({ extContext, extensionId }) => {
    const page = await openOptionsPage(extContext, extensionId);

    // At default (wide) width, sidebar should be visible, toggle hidden
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#sidebarToggle')).not.toBeVisible();

    // Resize to narrow viewport
    await page.setViewportSize({ width: 600, height: 800 });

    // Sidebar should be hidden, toggle button should appear
    await expect(page.locator('.sidebar')).not.toBeVisible();
    await expect(page.locator('#sidebarToggle')).toBeVisible();
    await expect(page.locator('.sidebar-resize-handle')).not.toBeVisible();

    // Click toggle — sidebar should appear as overlay
    await page.click('#sidebarToggle');
    await expect(page.locator('.sidebar')).toBeVisible();

    // Click overlay (covers the main area) — sidebar should close
    await page.click('#sidebarOverlay');
    await expect(page.locator('.sidebar')).not.toBeVisible();

    // Resize back to wide — sidebar should reappear, toggle should hide
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#sidebarToggle')).not.toBeVisible();

    await page.close();
  });
});
