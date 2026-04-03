import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '../fixtures/bookmarks.html');

function baseSeed(now) {
  return [
    { path: 'CURRENT', content: 'test-device' },
    { path: 'manifest/settings.json', data: { trimRules: [] } },
    { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
    { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
  ];
}

async function openSettingsAndLoadFile(options) {
  await options.click('#settingsBtn');
  await options.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });

  // Scroll to the import section
  await options.evaluate(() => {
    const section = document.getElementById('bookmarkFileInput');
    section?.scrollIntoView({ behavior: 'instant' });
  });

  // Load fixture file
  const fileInput = options.locator('#bookmarkFileInput');
  await fileInput.setInputFiles(FIXTURE_PATH);

  // Wait for tree to render
  await options.waitForFunction(
    () => document.querySelectorAll('.bookmark-tree-item').length > 0,
    { timeout: 5000 }
  );
}

test.describe('Import Bookmarks', () => {

  test('loading a bookmark file shows the folder tree with counts', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Should have 3 top-level folders: Bookmarks Bar, Other Bookmarks, Empty Folder
    const items = await options.$$eval('.bookmark-tree-container > div > .bookmark-tree-item', els =>
      els.map(el => ({
        label: el.querySelector('.bm-label')?.textContent,
        count: el.querySelector('.bm-count')?.textContent,
      }))
    );
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Bookmarks Bar' }),
      expect.objectContaining({ label: 'Other Bookmarks' }),
      expect.objectContaining({ label: 'Empty Folder' }),
    ]));

    // Bookmarks Bar should show 6 total bookmarks (3 direct + 2 in Dev Tools + 1 in News)
    const bbItem = items.find(i => i.label === 'Bookmarks Bar');
    expect(bbItem.count).toContain('6 bookmarks');
    expect(bbItem.count).toContain('2 subfolders');

    // Import button should be disabled (nothing checked)
    const importBtn = options.locator('#importBookmarksBtn');
    await expect(importBtn).toBeDisabled();

    await options.close();
  });

  test('tri-state checkboxes: checking parent checks all children', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Check "Bookmarks Bar" parent
    const parentCb = options.locator('.bookmark-tree-container > div:first-child > .bookmark-tree-item input[type="checkbox"]').first();
    await parentCb.check();

    // Expand Bookmarks Bar to see Dev Tools
    const toggle = options.locator('.bookmark-tree-container > div:first-child > .bookmark-tree-item .bm-toggle').first();
    // Bookmarks Bar should already be expanded (depth 0)

    // Dev Tools child checkbox should also be checked
    const childCb = await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
      // Find the Dev Tools checkbox (second level)
      for (const cb of items) {
        const label = cb.closest('.bookmark-tree-item')?.querySelector('.bm-label');
        if (label?.textContent === 'Dev Tools') return cb.checked;
      }
      return null;
    });
    expect(childCb).toBe(true);

    // Import button should be enabled
    const importBtn = options.locator('#importBookmarksBtn');
    await expect(importBtn).toBeEnabled();

    await options.close();
  });

  test('unchecking a child makes parent indeterminate', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Check Bookmarks Bar (checks all children)
    const parentCb = options.locator('.bookmark-tree-container > div:first-child > .bookmark-tree-item input[type="checkbox"]').first();
    await parentCb.check();

    // Uncheck Dev Tools child
    await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
      for (const cb of items) {
        const label = cb.closest('.bookmark-tree-item')?.querySelector('.bm-label');
        if (label?.textContent === 'Dev Tools') {
          cb.click();
          break;
        }
      }
    });

    // Parent should now be indeterminate
    const isIndeterminate = await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
      for (const cb of items) {
        const label = cb.closest('.bookmark-tree-item')?.querySelector('.bm-label');
        if (label?.textContent === 'Bookmarks Bar') return cb.indeterminate;
      }
      return null;
    });
    expect(isIndeterminate).toBe(true);

    await options.close();
  });

  test('collapse/expand toggles child visibility', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Bookmarks Bar children should be visible (depth 0, expanded by default)
    let devToolsVisible = await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item .bm-label');
      for (const el of items) {
        if (el.textContent === 'Dev Tools') return el.offsetParent !== null;
      }
      return false;
    });
    expect(devToolsVisible).toBe(true);

    // Click toggle to collapse Bookmarks Bar
    const toggle = options.locator('.bookmark-tree-container > div:first-child > .bookmark-tree-item .bm-toggle').first();
    await toggle.click();

    // Dev Tools should now be hidden
    devToolsVisible = await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item .bm-label');
      for (const el of items) {
        if (el.textContent === 'Dev Tools') {
          const children = el.closest('.bookmark-tree-item').parentElement.querySelector('.bookmark-tree-children');
          return children && !children.classList.contains('collapsed');
        }
      }
      return false;
    });
    // Dev Tools is inside Bookmarks Bar's children container, which is now collapsed
    // Check that the parent's children container is collapsed
    const isCollapsed = await options.evaluate(() => {
      const firstFolder = document.querySelector('.bookmark-tree-container > div:first-child');
      const childContainer = firstFolder?.querySelector('.bookmark-tree-children');
      return childContainer?.classList.contains('collapsed');
    });
    expect(isCollapsed).toBe(true);

    await options.close();
  });

  test('importing selected folders creates lists with pins', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Check only "Other Bookmarks" (1 valid bookmark + 1 javascript: skipped)
    await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
      for (const cb of items) {
        const label = cb.closest('.bookmark-tree-item')?.querySelector('.bm-label');
        if (label?.textContent === 'Other Bookmarks') {
          cb.click();
          break;
        }
      }
    });

    // Click import
    const importBtn = options.locator('#importBookmarksBtn');
    await importBtn.click();

    // Wait for completion message
    await options.waitForFunction(
      () => document.getElementById('importProgress')?.textContent?.includes('Done'),
      { timeout: 10000 }
    );

    const progressText = await options.textContent('#importProgress');
    expect(progressText).toContain('1 list');
    expect(progressText).toContain('1 bookmark');

    // Check failures include the javascript: bookmark
    const failuresText = await options.textContent('#importFailures');
    expect(failuresText).toContain('1 item');

    // Close settings and verify the list appears in sidebar
    await options.evaluate(() => {
      document.querySelector('.modal-close')?.click();
    });

    // Wait for sidebar to update
    await options.waitForFunction(
      () => {
        const items = document.querySelectorAll('.sidebar-item .label');
        return Array.from(items).some(el => el.textContent.includes('Imported Bookmarks'));
      },
      { timeout: 10000 }
    );

    // Verify "Other Bookmarks" sub-list exists
    const sidebarLabels = await options.$$eval('.sidebar-item .label', els =>
      els.map(el => el.textContent.trim())
    );
    expect(sidebarLabels).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Imported Bookmarks'),
        'Other Bookmarks',
      ])
    );

    await options.close();
  });

  test('importing nested folders creates nested lists', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, baseSeed(now));
    const options = await openOptionsPage(extContext, extensionId);
    await openSettingsAndLoadFile(options);

    // Check "Bookmarks Bar" (includes Dev Tools subfolder)
    await options.evaluate(() => {
      const items = document.querySelectorAll('.bookmark-tree-item input[type="checkbox"]');
      for (const cb of items) {
        const label = cb.closest('.bookmark-tree-item')?.querySelector('.bm-label');
        if (label?.textContent === 'Bookmarks Bar') {
          cb.click();
          break;
        }
      }
    });

    const importBtn = options.locator('#importBookmarksBtn');
    await importBtn.click();

    await options.waitForFunction(
      () => document.getElementById('importProgress')?.textContent?.includes('Done'),
      { timeout: 10000 }
    );

    const progressText = await options.textContent('#importProgress');
    // 3 lists: Bookmarks Bar + Dev Tools + News
    expect(progressText).toContain('3 lists');
    // 6 bookmarks total
    expect(progressText).toContain('6 bookmarks');

    // Close settings and check sidebar
    await options.evaluate(() => {
      document.querySelector('.modal-close')?.click();
    });

    await options.waitForFunction(
      () => {
        const items = document.querySelectorAll('.sidebar-item .label');
        return Array.from(items).some(el => el.textContent === 'Dev Tools');
      },
      { timeout: 10000 }
    );

    await options.close();
  });
});
