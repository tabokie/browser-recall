import { test, expect } from './fixtures.js';
import { resetAndSeed, getSlugForUrl, openHelperPage, openOptionsPage, waitForListView } from './helpers.js';

const TEST_URL = 'https://example.com/';
const TEST_SLUG = getSlugForUrl(TEST_URL);

test.describe('Rule operations', () => {
  test('addRule adds keyword rule to list entity', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'addRule',
        listId: 'reading',
        rule: { type: 'keyword', config: { pattern: 'github', fields: ['url'] } },
      })
    );
    expect(result.success).toBe(true);

    // Verify entity updated via readCacheable
    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(1);
    expect(entity.value.rules[0].type).toBe('keyword');
    expect(entity.value.rules[0].config.pattern).toBe('github');
    expect(entity.value.rules[0].id).toMatch(/^rule-k-/);
    await page.close();
  });

  test('removeRule removes rule from list entity', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const ruleId = 'rule-k-test-1234';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [],
        rules: [{ id: ruleId, type: 'keyword', config: { pattern: 'test' }, createdAt: now }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);
    const result = await page.evaluate((rid) =>
      chrome.runtime.sendMessage({ action: 'removeRule', listId: 'reading', ruleId: rid }),
      ruleId
    );
    expect(result.success).toBe(true);

    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(0);
    await page.close();
  });

  test('rules survive flush + rehydrate round-trip', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);

    // Add rule
    await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'addRule',
        listId: 'reading',
        rule: { type: 'keyword', config: { pattern: 'test', fields: ['title'] } },
      })
    );

    // Flush to disk
    await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'flushLogBuffer' })
    );

    // Rehydrate from disk
    await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'rehydrateForTest' })
    );

    // Verify rule survived
    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(1);
    expect(entity.value.rules[0].config.pattern).toBe('test');
    await page.close();
  });

  test('runRuleBatch with keyword rule auto-pins matching pages', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [],
        rules: [{ id: 'rule-k-test-0001', type: 'keyword', config: { pattern: 'github', fields: ['url'], threshold: 0.5 }, createdAt: now }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);

    // Run batch with visit_page entries
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'runRuleBatch',
        listIds: ['reading'],
        entries: [
          { timestamp: Date.now(), action: 'visit_page', url: 'https://github.com/foo', title: 'Foo Repo' },
          { timestamp: Date.now(), action: 'visit_page', url: 'https://example.com/', title: 'Example' },
        ],
      })
    );
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://github.com/foo');

    // Verify auto-pin
    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.pins).toHaveLength(1);
    expect(entity.value.pins[0].id).toContain('page:');
    await page.close();
  });

  test('addRule rejects smart rule with banned globals in fnSource', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'addRule',
        listId: 'reading',
        rule: {
          type: 'smart',
          config: {
            description: 'evil rule',
            fnSource: 'fetch("http://evil.com"); return 1;',
          },
        },
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('fetch');
    await page.close();
  });

  test('addRule stores smart rule with valid fnSource', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'addRule',
        listId: 'reading',
        rule: {
          type: 'smart',
          config: {
            description: 'pages with long titles',
            fnSource: 'return page.title.length > 10 ? 1 : 0;',
          },
        },
      })
    );
    expect(result.success).toBe(true);

    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(1);
    expect(entity.value.rules[0].type).toBe('smart');
    expect(entity.value.rules[0].config.fnSource).toBe('return page.title.length > 10 ? 1 : 0;');
    expect(entity.value.rules[0].id).toMatch(/^rule-s-/);
    await page.close();
  });

  test('runRuleBatch with smart rule executes sandbox and auto-pins', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [],
        rules: [{
          id: 'rule-s-test-0001', type: 'smart',
          config: {
            description: 'pages with long titles',
            fnSource: 'return page.title.length > 15 ? 1 : 0;',
            threshold: 0.5,
          },
          createdAt: now,
        }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const page = await openHelperPage(extContext, extensionId);

    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        action: 'runRuleBatch',
        listIds: ['reading'],
        entries: [
          { timestamp: Date.now(), action: 'visit_page', url: 'https://example.com/long', title: 'This Is A Very Long Title For Testing' },
          { timestamp: Date.now(), action: 'visit_page', url: 'https://example.com/short', title: 'Short' },
        ],
      })
    );
    expect(result.success).toBe(true);
    // Only the long-titled page should match (title.length > 15)
    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe('https://example.com/long');

    // Verify auto-pin
    const entity = await page.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.pins).toHaveLength(1);
    await page.close();
  });
});

test.describe('Rules UI', () => {
  test('rules section visible when viewing a list with rules', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [],
        rules: [{ id: 'rule-k-test-0001', type: 'keyword', config: { pattern: 'github', fields: ['url'] }, createdAt: now }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Rules section should be visible with count badge
    const rulesSection = options.locator('#rulesSection');
    await expect(rulesSection).toBeVisible({ timeout: 5000 });
    const countBadge = options.locator('#rulesCount');
    await expect(countBadge).toBeVisible();
    await expect(countBadge).toHaveText('1');

    // Expand rules section
    await options.locator('#rulesHeader').click();
    const rulesBody = options.locator('#rulesBody');
    await expect(rulesBody).toBeVisible();

    // Rule entry should be visible
    const ruleEntry = options.locator('.rule-entry');
    await expect(ruleEntry).toBeVisible();
    await expect(ruleEntry.locator('.rule-type-badge')).toHaveText('keyword');
    await options.close();
  });

  test('add keyword rule via UI form', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Expand rules section
    await options.locator('#rulesHeader').click();
    await expect(options.locator('#rulesBody')).toBeVisible();

    // Click add button
    await options.locator('#rulesAddBtn').click();
    await expect(options.locator('#rulesAddForm')).toBeVisible();

    // Fill in keyword pattern
    await options.locator('#rulePatternInput').fill('github');

    // Click save
    await options.locator('#rulesSaveBtn').click();

    // Form should close and rule should appear
    await expect(options.locator('#rulesAddForm')).toBeHidden();
    const ruleEntry = options.locator('.rule-entry');
    await expect(ruleEntry).toBeVisible({ timeout: 5000 });
    await expect(ruleEntry.locator('.rule-type-badge')).toHaveText('keyword');

    // Verify via background
    const helperPage = await openHelperPage(extContext, extensionId);
    const entity = await helperPage.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(1);
    expect(entity.value.rules[0].type).toBe('keyword');
    await helperPage.close();
    await options.close();
  });

  test('remove rule via UI click', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const ruleId = 'rule-k-test-0001';
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [],
        rules: [{ id: ruleId, type: 'keyword', config: { pattern: 'test' }, createdAt: now }],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Expand rules section
    await options.locator('#rulesHeader').click();
    await expect(options.locator('#rulesBody')).toBeVisible();

    // Should have one rule entry
    await expect(options.locator('.rule-entry')).toHaveCount(1);

    // Click remove button
    await options.locator('.rule-remove').click();

    // Rule entry should disappear
    await expect(options.locator('.rule-entry')).toHaveCount(0, { timeout: 5000 });

    // Verify via background
    const helperPage = await openHelperPage(extContext, extensionId);
    const entity = await helperPage.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'readCacheable', key: 'list:reading' })
    );
    expect(entity.value.rules).toHaveLength(0);
    await helperPage.close();
    await options.close();
  });

  test('rules section hidden for system lists', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:system/gateways'] } },
      { path: 'lists/system/gateways.json', data: {
        slug: 'system/gateways', name: 'Gateways', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: {} } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    // Navigate to gateways system list via sidebar
    const gwItem = options.locator('.sidebar-item[data-list-id="system/gateways"]');
    await expect(gwItem).toBeVisible({ timeout: 5000 });
    await gwItem.click();
    await waitForListView(options);

    // Rules section should be hidden for system lists
    const rulesSection = options.locator('#rulesSection');
    await expect(rulesSection).toBeHidden();
    await options.close();
  });

  test('type toggle switches form panels', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    const listItem = options.locator('.sidebar-item[data-list-id="reading"]');
    await expect(listItem).toBeVisible({ timeout: 5000 });
    await listItem.click();
    await waitForListView(options);

    // Expand and open add form
    await options.locator('#rulesHeader').click();
    await options.locator('#rulesAddBtn').click();

    // Default: keyword form visible
    await expect(options.locator('#rulesFormKeyword')).toBeVisible();
    await expect(options.locator('#rulesFormSemantic')).toBeHidden();
    await expect(options.locator('#rulesFormSmart')).toBeHidden();

    // Switch to semantic
    await options.locator('#ruleTypeToggle [data-type="semantic"]').click();
    await expect(options.locator('#rulesFormKeyword')).toBeHidden();
    await expect(options.locator('#rulesFormSemantic')).toBeVisible();
    await expect(options.locator('#rulesFormSmart')).toBeHidden();

    // Switch to smart
    await options.locator('#ruleTypeToggle [data-type="smart"]').click();
    await expect(options.locator('#rulesFormKeyword')).toBeHidden();
    await expect(options.locator('#rulesFormSemantic')).toBeHidden();
    await expect(options.locator('#rulesFormSmart')).toBeVisible();

    await options.close();
  });

  test('preview shows matching pages for keyword rule', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
      { path: `data/logs/${todayKey}.jsonl`, lines: [
        { timestamp: now - 3000, action: 'visit_page', url: 'https://github.com/foo', title: 'Foo Repo', bodyPreview: 'GitHub is where people build software foo repo readme' },
        { timestamp: now - 2000, action: 'visit_page', url: 'https://example.com/', title: 'Example', bodyPreview: 'This domain is for use in illustrative examples' },
        { timestamp: now - 1000, action: 'visit_page', url: 'https://github.com/bar', title: 'Bar Repo', bodyPreview: 'GitHub is where people build software bar repo readme' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.locator('.sidebar-item[data-list-id="reading"]').click();
    await waitForListView(options);

    // Expand and open add form
    await options.locator('#rulesHeader').click();
    await options.locator('#rulesAddBtn').click();

    // Type a pattern that matches 2 of 3 entries (matches in bodyPreview)
    await options.locator('#rulePatternInput').fill('github');
    await options.locator('#rulesPreviewBtn').click();

    // Preview should appear with all 3 pages, 2 matches
    await expect(options.locator('#rulesPreview')).toBeVisible({ timeout: 5000 });
    await expect(options.locator('#rulesPreviewCount')).toContainText('2 matches');
    await expect(options.locator('.rules-preview-item')).toHaveCount(3);
    // Matches have green scores, non-matches have red
    await expect(options.locator('.rules-preview-score-match')).toHaveCount(2);
    await expect(options.locator('.rules-preview-score-miss')).toHaveCount(1);

    await options.close();
  });

  test('preview shows error for smart rule with syntax error', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now, pins: [], rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
      { path: `data/logs/${todayKey}.jsonl`, lines: [
        { timestamp: now - 1000, action: 'visit_page', url: 'https://example.com/', title: 'Example', bodyPreview: 'This domain is for use in illustrative examples' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.locator('.sidebar-item[data-list-id="reading"]').click();
    await waitForListView(options);

    // Open form, switch to smart
    await options.locator('#rulesHeader').click();
    await options.locator('#rulesAddBtn').click();
    await options.locator('#ruleTypeToggle [data-type="smart"]').click();

    // Enter invalid JS
    await options.locator('#ruleSmartDescInput').fill('bad rule');
    await options.locator('#ruleSmartFnInput').fill('return {{{;');
    await options.locator('#rulesPreviewBtn').click();

    // Error should appear
    await expect(options.locator('#rulesFormError')).toBeVisible({ timeout: 5000 });

    // Preview area should NOT appear
    await expect(options.locator('#rulesPreview')).toBeHidden();

    await options.close();
  });

  test('preview shows pinned pages section', async ({ extContext, extensionId, setupDir, localServer }) => {
    // Set up local pages that fetchPageBody can reach
    localServer.addPage('/pinned1', { title: 'Pinned GitHub Page', body: 'GitHub is where people build software repositories and collaborate' });
    localServer.addPage('/pinned2', { title: 'Pinned Example Page', body: 'This is an example domain for documentation purposes' });
    const url1 = localServer.url('/pinned1');
    const url2 = localServer.url('/pinned2');
    const slug1 = getSlugForUrl(url1);
    const slug2 = getSlugForUrl(url2);

    const now = Date.now();
    const todayKey = new Date().toISOString().slice(0, 10);
    await resetAndSeed(extContext, extensionId, [
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'lists/system/root.json', data: { timestamp: now, childLists: ['list:reading'] } },
      { path: 'lists/reading.json', data: {
        slug: 'reading', name: 'Reading List', timestamp: now,
        pins: [
          { id: `page:${slug1}`, pinnedAt: now - 2000 },
          { id: `page:${slug2}`, pinnedAt: now - 1000 },
        ],
        rules: [],
        parentList: 'list:system/root', childLists: [],
      }},
      { path: 'manifest/list-name-to-id.json', data: { timestamp: now, paths: { 'root/Reading List': 'reading' } } },
      { path: `pages/${slug1}.json`, data: {
        slug: slug1, url: url1, title: 'Pinned GitHub Page',
        timestamp: now, parentIds: ['list:reading'], childIds: [],
      }},
      { path: `pages/${slug2}.json`, data: {
        slug: slug2, url: url2, title: 'Pinned Example Page',
        timestamp: now, parentIds: ['list:reading'], childIds: [],
      }},
      { path: `data/logs/${todayKey}.jsonl`, lines: [
        { timestamp: now - 1000, action: 'visit_page', url: 'https://other.com/', title: 'Other Page', bodyPreview: 'some other content' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.locator('.sidebar-item[data-list-id="reading"]').click();
    await waitForListView(options);

    // Expand and open add form
    await options.locator('#rulesHeader').click();
    await options.locator('#rulesAddBtn').click();

    // Type a pattern that matches the GitHub pin (in body text)
    await options.locator('#rulePatternInput').fill('GitHub');
    await options.locator('#rulesPreviewBtn').click();

    // Pinned pages section should appear with both pages checked, 1 match
    await expect(options.locator('#rulesPinsPreview')).toBeVisible({ timeout: 10000 });
    await expect(options.locator('#rulesPinsPreviewCount')).toContainText('1 matches (2 checked)', { timeout: 10000 });

    await options.close();
  });
});
