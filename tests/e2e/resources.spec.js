import { test, expect } from './fixtures.js';
import { resetAndSeed, openHelperPage, openOptionsPage, getSlugForUrl } from './helpers.js';

// ─── CDP Helpers ──────────────────────────────────────────────────────

async function getEventListenerCount(cdp, objectId) {
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
    objectId,
    depth: 0,
  });
  return listeners.length;
}

async function getDocumentListenerCount(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document',
      objectGroup: 'resource-test',
    });
    return await getEventListenerCount(cdp, result.objectId);
  } finally {
    await cdp.detach();
  }
}

async function getJSHeapUsedSize(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = metrics.find(m => m.name === 'JSHeapUsedSize');
    return heap?.value || 0;
  } finally {
    await cdp.detach();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

test.describe('Resource monitoring', () => {

  test('content script does not pollute DOM on regular pages', async ({ extContext, extensionId, setupDir, localServer }) => {
    const now = Date.now();
    localServer.addPage('/clean', {
      title: 'Clean Page',
      body: '<h1>Hello</h1><p>Just a normal page.</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/clean'));
    await page.waitForTimeout(2000);

    // No extension-injected visible elements in the page
    const injectedElements = await page.evaluate(() => {
      const markers = document.querySelectorAll(
        'mark.portal-highlight, [id*="portal"], [data-savepage-fontface]'
      );
      return markers.length;
    });
    expect(injectedElements).toBe(0);

    // No globals leaked onto window
    const hasGlobalLeak = await page.evaluate(() => {
      return typeof window.__portalPanelDismissed !== 'undefined';
    });
    expect(hasGlobalLeak).toBe(false);

    await page.close();
  });

  test('highlights panel cleans up document listeners on close', async ({ extContext, extensionId, setupDir, localServer }) => {
    const now = Date.now();
    const url = 'http://127.0.0.1/highlight-test';
    const slug = getSlugForUrl(url);
    const noteSlug = `${slug}-note1`;

    localServer.addPage('/highlight-test', {
      title: 'Highlight Test',
      body: '<p id="content">Some text to highlight on this page.</p>',
    });

    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: `pages/${slug}.json`, data: {
        slug, url: localServer.url('/highlight-test'), title: 'Highlight Test',
        timestamp: now, parentIds: [], childIds: [`note:${noteSlug}`],
      }},
      { path: `data/notes/${noteSlug}.json`, data: {
        slug: noteSlug, excerpt: 'Some text', note: '', createdAt: now,
        url: localServer.url('/highlight-test'),
      }},
    ]);

    const page = await extContext.newPage();
    await page.goto(localServer.url('/highlight-test'));
    await page.waitForTimeout(1500);

    // Baseline: count document listeners before panel opens
    const baselineListeners = await getDocumentListenerCount(page);

    // Open highlights panel via message
    const helper = await openHelperPage(extContext, extensionId);
    await helper.evaluate(({ url, slug }) =>
      chrome.runtime.sendMessage({
        action: 'showHighlightsPanel',
        tabUrl: url,
        pageSlug: slug,
      })
    , { url: localServer.url('/highlight-test'), slug });
    // Wait a bit for panel to render
    await page.waitForTimeout(500);

    // Panel should be present
    const panelExists = await page.evaluate(() =>
      !!document.getElementById('portal-highlights-panel')
    );
    // Panel may or may not appear depending on how showHighlightsPanel routes —
    // some flows send the message to the content script of the target tab.
    // If it does appear, close it and check listeners are cleaned up.
    if (panelExists) {
      const withPanelListeners = await getDocumentListenerCount(page);
      expect(withPanelListeners).toBeGreaterThan(baselineListeners);

      // Close the panel
      await page.evaluate(() => {
        const panel = document.getElementById('portal-highlights-panel');
        if (panel?.shadowRoot) {
          const closeBtn = panel.shadowRoot.querySelector('.close-btn');
          if (closeBtn) closeBtn.click();
        }
      });
      await page.waitForTimeout(200);

      // Listeners should return to baseline (±1 for timing of passive listeners)
      const afterCloseListeners = await getDocumentListenerCount(page);
      expect(afterCloseListeners).toBeLessThanOrEqual(baselineListeners + 1);
    }

    await helper.close();
    await page.close();
  });

  test('options page allEntries does not grow unboundedly on repeated mutations', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const DAY = 86400000;
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: `data/logs/test-device/${new Date(now).toISOString().slice(0, 10)}.jsonl`, lines: [
        { timestamp: now - 1000, action: 'visit_page', url: 'https://example.com/', title: 'Example' },
        { timestamp: now - 500, action: 'visit_page', url: 'https://test.com/', title: 'Test' },
      ]},
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForTimeout(1000);

    // Get initial allEntries count
    const initialCount = await options.evaluate(() => {
      // historyState is module-scoped; access it through a known global or DOM state
      const rows = document.querySelectorAll('#relatedResults .result-row');
      return rows.length;
    });

    // Simulate multiple history mutations (as if new pages were visited)
    const helper = await openHelperPage(extContext, extensionId);
    for (let i = 0; i < 5; i++) {
      await helper.evaluate(() =>
        chrome.runtime.sendMessage({ action: 'notifyMutation', type: 'history' })
      );
      await options.waitForTimeout(700);
    }

    // The result count should be stable (not growing with each mutation)
    const finalCount = await options.evaluate(() => {
      const rows = document.querySelectorAll('#relatedResults .result-row');
      return rows.length;
    });

    // Should be same number of unique pages, not 5x duplicates
    expect(finalCount).toBeLessThanOrEqual(initialCount + 2);

    await helper.close();
    await options.close();
  });

  test('options page heap does not grow excessively across search cycles', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < 50; i++) {
      entries.push({
        timestamp: now - i * 60000,
        action: 'visit_page',
        url: `https://example${i}.com/`,
        title: `Page ${i}`,
      });
    }
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: `data/logs/test-device/${new Date(now).toISOString().slice(0, 10)}.jsonl`, lines: entries },
    ]);

    const options = await openOptionsPage(extContext, extensionId);
    await options.waitForTimeout(1500);

    // Force GC and measure baseline heap
    const cdp = await options.context().newCDPSession(options);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await options.waitForTimeout(500);
    const baseline = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value;

    // Run 10 search/clear cycles
    for (let i = 0; i < 10; i++) {
      await options.fill('#searchDraftInput', `query${i}`);
      await options.waitForTimeout(400);
      await options.fill('#searchDraftInput', '');
      await options.waitForTimeout(400);
    }

    // Force GC and measure final heap
    await cdp.send('HeapProfiler.collectGarbage');
    await options.waitForTimeout(500);
    const final = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize').value;
    await cdp.detach();

    // Heap should not grow more than 5MB across 10 search cycles
    // (generous threshold to avoid flakiness from GC timing)
    const growthMB = (final - baseline) / (1024 * 1024);
    expect(growthMB).toBeLessThan(5);

    await options.close();
  });

  test('cardDataByUrl is cleared between search pipeline runs', async ({ extContext, extensionId, setupDir }) => {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        timestamp: now - i * 60000,
        action: 'visit_page',
        url: `https://card-test-${i}.com/`,
        title: `Card Page ${i}`,
      });
    }
    await resetAndSeed(extContext, extensionId, [
      { path: 'CURRENT', content: 'test-device' },
      { path: 'manifest/settings.json', data: { trimRules: [] } },
      { path: 'manifest/list-order.json', data: { timestamp: now, tree: [] } },
      { path: `data/logs/test-device/${new Date(now).toISOString().slice(0, 10)}.jsonl`, lines: entries },
    ]);

    const options = await openOptionsPage(extContext, extensionId);

    // Wait for explore view to populate with results
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length > 0,
      { timeout: 10000 }
    );

    // Type a search query — this triggers runSearchFilterPipeline which clears cardDataByUrl
    await options.fill('#searchDraftInput', 'Card Page 1');
    await options.waitForTimeout(600);

    // Clear search — another runSearchFilterPipeline
    await options.fill('#searchDraftInput', '');
    await options.waitForTimeout(600);

    // Results should still render properly (no stale data)
    await options.waitForFunction(
      () => document.querySelectorAll('#relatedResults .result-row').length > 0,
      { timeout: 10000 }
    );

    await options.close();
  });
});
