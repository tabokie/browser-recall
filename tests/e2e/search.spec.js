import { test, expect } from './fixtures.js';
import { resetAndSeed, openOptionsPage } from './helpers.js';

test.describe('Exact (quoted) search uses word-boundary matching', () => {
  test('quoted search excludes substring matches', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now - 3000, action: 'visit_page', url: 'https://a.com/concat', title: 'concatenation tips' },
        { timestamp: now - 2000, action: 'visit_page', url: 'https://b.com/cat', title: 'the cat sleeps' },
        { timestamp: now - 1000, action: 'visit_page', url: 'https://c.com/catalog', title: 'product catalog' },
      ]},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for all 3 results to load in Explore view
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );

    // Type quoted search — should use word-boundary matching
    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('"cat"');

    // "cat" as word boundary should only match "the cat sleeps" — not
    // "concatenation" (cat is embedded) or "catalog" (cat is prefix)
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 1,
      { timeout: 5000 }
    );
    const titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toEqual(['the cat sleeps']);

    await options.close();
  });

  test('quoted search respects word boundaries in URLs', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now - 2000, action: 'visit_page', url: 'https://github.com/foo', title: 'Foo Repo' },
        { timestamp: now - 1000, action: 'visit_page', url: 'https://fakegithub.com/bar', title: 'Fake Page' },
      ]},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 2,
      { timeout: 10000 }
    );

    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('"github.com"');

    // "github.com" in https://github.com/foo is word-bounded (preceded by /)
    // "github.com" in https://fakegithub.com/bar is NOT bounded (preceded by 'e')
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 1,
      { timeout: 5000 }
    );
    const titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toEqual(['Foo Repo']);

    await options.close();
  });

  test('unquoted search still uses case-insensitive substring', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: 'data/logs/test-device/2026-03-01.jsonl', lines: [
        { timestamp: now - 3000, action: 'visit_page', url: 'https://a.com/', title: 'Concatenation Tips' },
        { timestamp: now - 2000, action: 'visit_page', url: 'https://b.com/', title: 'The Cat Sleeps' },
        { timestamp: now - 1000, action: 'visit_page', url: 'https://c.com/', title: 'Lovely Dogs' },
      ]},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length >= 3,
      { timeout: 10000 }
    );

    // Unquoted search — should still match substrings case-insensitively
    const draftInput = options.locator('#searchDraftInput');
    await draftInput.fill('cat');

    // "cat" substring matches "Concatenation Tips" and "The Cat Sleeps"
    // but NOT "Lovely Dogs"
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length === 2,
      { timeout: 5000 }
    );
    const titles = await options.$$eval('#relatedResults .result-title', els =>
      els.map(el => el.textContent.trim())
    );
    expect(titles).toContain('Concatenation Tips');
    expect(titles).toContain('The Cat Sleeps');
    expect(titles).not.toContain('Lovely Dogs');

    await options.close();
  });
});
