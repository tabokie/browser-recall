/**
 * Progressive loading integration tests.
 *
 * Verifies that the options page renders correctly when different data sources
 * load at different speeds. Uses deferred promises to pause specific
 * chrome.runtime.sendMessage actions and then inspects DOM state.
 *
 * Environment: jsdom — options.html content is loaded into document.body,
 * Chrome APIs and WASM are mocked, then options.js is dynamically imported.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Deferred promise helper
// ---------------------------------------------------------------------------
function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Flush microtasks + one macrotask (for setTimeout(0) yields)
function tick(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
function makeInteraction(url, title, timestamp, opts = {}) {
  const slug = url.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
  return { id: `${timestamp}-${slug}`, url, title, timestamp, slug, intent: opts.intent || '', attention: opts.attention || '' };
}

const NOW = Date.now();
const DAY = 86400000;

// 60 interactions across 3 daily files, newest first
const FILE1_DATE = '2026-02-15'; // today — newest
const FILE2_DATE = '2026-02-14';
const FILE3_DATE = '2026-02-13';

function makeFileInteractions(dateStr, startIdx, count, titlePrefix) {
  const base = new Date(dateStr + 'T12:00:00Z').getTime();
  const result = [];
  for (let i = 0; i < count; i++) {
    const ts = base + i * 60000;
    result.push(makeInteraction(
      `https://example.com/${titlePrefix.toLowerCase()}${startIdx + i}`,
      `${titlePrefix} Page ${startIdx + i}`,
      ts,
      { intent: titlePrefix.toLowerCase() }
    ));
  }
  return result;
}

// Rust-related pages (will match collection query)
function makeRustInteractions() {
  const base = new Date('2026-02-15T10:00:00Z').getTime();
  const result = [];
  for (let i = 0; i < 25; i++) {
    result.push(makeInteraction(
      `https://rust-lang.org/doc${i}`,
      `Rust Documentation ${i}`,
      base + i * 60000,
      { intent: 'rust programming' }
    ));
  }
  return result;
}

const FILE1_INTERACTIONS = makeFileInteractions(FILE1_DATE, 0, 20, 'Today');
const FILE2_INTERACTIONS = makeFileInteractions(FILE2_DATE, 20, 20, 'Yesterday');
const FILE3_INTERACTIONS = makeFileInteractions(FILE3_DATE, 40, 20, 'OldDay');
const RUST_INTERACTIONS = makeRustInteractions();
// Rust interactions are in file1 (today)
const ALL_FILE1 = [...FILE1_INTERACTIONS, ...RUST_INTERACTIONS];

const ALL_INTERACTIONS = [...ALL_FILE1, ...FILE2_INTERACTIONS, ...FILE3_INTERACTIONS];

const TEST_COLLECTION = {
  id: 'col-rust',
  query: 'rust',
  name: 'Rust Lang',
};

const TEST_COLLECTION_PINS = {
  'col-rust': [
    { url: 'https://rust-lang.org/doc0', title: 'Rust Documentation 0', pinnedAt: NOW - DAY },
    { url: 'https://rust-lang.org/doc1', title: 'Rust Documentation 1', pinnedAt: NOW - DAY },
    { url: 'https://rust-lang.org/doc2', title: 'Rust Documentation 2', pinnedAt: NOW - DAY },
  ],
};

const TEST_SETTINGS = {
  collections: [TEST_COLLECTION],
  settings: { captureContent: true, captureAttention: true, archiveQuality: 'medium' },
  urlBlacklist: [],
  titleTrimRules: [],
  recycleBin: [],
  permanentDeletes: [],
};

const FILES_NEWEST_FIRST = [
  `${FILE1_DATE}.jsonl`,
  `${FILE2_DATE}.jsonl`,
  `${FILE3_DATE}.jsonl`,
];

// Map filename → interactions for loadInteractionBatch mock
const FILE_MAP = {
  [`${FILE1_DATE}.jsonl`]: ALL_FILE1,
  [`${FILE2_DATE}.jsonl`]: FILE2_INTERACTIONS,
  [`${FILE3_DATE}.jsonl`]: FILE3_INTERACTIONS,
};

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We must set up mocks BEFORE dynamic import of options.js.
// vi.mock calls are hoisted above imports by vitest.

vi.mock('../extension/filesystem-storage.js', () => ({
  FileSystemStorage: class {
    constructor() { this.directoryHandle = null; }
    async getDirectoryInfo() { return { name: 'test-portal-data', hasPermission: true }; }
    async verifyPermission() { return true; }
    async loadDirectoryHandle() { return {}; }
    async selectDirectory() { return { success: true, name: 'test' }; }
    async loadAllInteractions() { return []; }
    async loadAllContent() { return {}; }
  },
}));

vi.mock('../extension/pkg/portal_extension.js', () => {
  class MockInteraction {
    constructor(url, title) { this.url = url; this.title = title; }
    set id(v) { this._id = v; }
    set timestamp(v) { this._timestamp = v; }
    setIntent() {}
    setContent() {}
    setAttention() {}
  }

  class MockSearchEngine {
    constructor() { this._items = []; }
    addInteraction(item) { this._items.push(item); }
    async search(query) {
      // Simple substring match on title
      const q = query.toLowerCase();
      return this._items
        .filter(item => item.title.toLowerCase().includes(q) || (item.url && item.url.toLowerCase().includes(q)))
        .map(item => ({ url: item.url, title: item.title, score: 1.0, timestamp: Number(item._timestamp || 0) }));
    }
  }

  return {
    default: async () => {}, // init()
    Interaction: MockInteraction,
    SearchEngine: MockSearchEngine,
  };
});

// ---------------------------------------------------------------------------
// HTML content — extract <body> from options.html
// ---------------------------------------------------------------------------
const htmlPath = path.resolve(__dirname, '../extension/options.html');
const htmlFull = fs.readFileSync(htmlPath, 'utf-8');
// Extract body content (between <body> and </body>), excluding the <script> tag
const bodyMatch = htmlFull.match(/<body[^>]*>([\s\S]*)<\/body>/i);
const bodyContent = bodyMatch
  ? bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '')
  : '';
// Extract <style> content from <head> for CSS (so layout queries work minimally)
const styleMatch = htmlFull.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
const styleContent = styleMatch ? styleMatch[1] : '';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Progressive loading', () => {
  /** @type {Record<string, {promise: Promise, resolve: Function}>} */
  let deferreds;
  let storageData;
  let initPromise;

  function setupChromeMock() {
    storageData = {};
    deferreds = {};

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          // If there's a deferred for this action, wait for it
          const deferred = deferreds[msg.action];
          if (deferred) await deferred.promise;
          return handleAction(msg);
        }),
      },
      storage: {
        local: {
          get: vi.fn(async (keys) => {
            if (!keys) return { ...storageData };
            if (typeof keys === 'string') keys = [keys];
            const result = {};
            for (const k of keys) {
              if (k in storageData) result[k] = storageData[k];
            }
            return result;
          }),
          set: vi.fn(async (obj) => {
            Object.assign(storageData, obj);
          }),
          remove: vi.fn(async (keys) => {
            for (const k of keys) delete storageData[k];
          }),
          clear: vi.fn(async () => { storageData = {}; }),
        },
      },
    };
    globalThis.chrome = chromeMock;
  }

  function handleAction(msg) {
    switch (msg.action) {
      case 'loadSettings':
        return { success: true, settings: TEST_SETTINGS };

      case 'listInteractionFiles':
        return { success: true, files: FILES_NEWEST_FIRST };

      case 'loadInteractionBatch': {
        const interactions = [];
        for (const f of msg.files) {
          if (FILE_MAP[f]) interactions.push(...FILE_MAP[f]);
        }
        return { success: true, interactions };
      }

      case 'loadCollectionPins':
        return { success: true, pins: TEST_COLLECTION_PINS };

      case 'loadContentBatch':
        // Return empty content — search still works via title matching
        return { success: true, contentMap: {} };

      case 'loadGateways':
        return { success: true, watermark: 0, domains: {} };

      case 'processGatewaysIncremental':
        return { success: true, domains: {}, newWatermark: 0 };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'saveSettingsKey':
        return { success: true };

      default:
        return { success: true };
    }
  }

  // Populate cache with all settings so loadSettingsValue hits fast path
  function populateCache() {
    storageData = {
      settings: TEST_SETTINGS.settings,
      collections: TEST_SETTINGS.collections,
      urlBlacklist: TEST_SETTINGS.urlBlacklist,
      titleTrimRules: TEST_SETTINGS.titleTrimRules,
      recycleBin: TEST_SETTINGS.recycleBin,
      permanentDeletes: TEST_SETTINGS.permanentDeletes,
      gatewayDomains: {},
      writeBuffer: [],
    };
  }

  function clearCache() {
    storageData = {};
  }

  beforeEach(() => {
    vi.resetModules();
    // Set up minimal DOM
    document.head.innerHTML = `<style>${styleContent}</style>`;
    document.body.innerHTML = bodyContent;

    // performance.now may not exist in jsdom
    if (!globalThis.performance) {
      globalThis.performance = { now: () => Date.now() };
    }

    setupChromeMock();
  });

  afterEach(async () => {
    // Resolve any lingering deferreds so pending promises don't leak
    for (const d of Object.values(deferreds || {})) {
      try { d.resolve(); } catch {}
    }
    await tick(50);
    delete globalThis.chrome;
  });

  // Helper: dynamically import options.js (triggers initialize())
  async function importOptions() {
    const mod = await import('../extension/options.js');
    return mod;
  }

  // ---------------------------------------------------------------------------
  // DOM assertion helpers
  // ---------------------------------------------------------------------------

  function sidebarCategories() {
    return [...document.querySelectorAll('.sidebar-item[data-category]')]
      .map(el => el.dataset.category);
  }

  function sidebarCollections() {
    return [...document.querySelectorAll('#collectionsList .sidebar-item')]
      .map(el => el.dataset.collectionId);
  }

  function mainTitle() {
    return document.getElementById('mainTitle').textContent.trim();
  }

  function chartFrameVisible() {
    return document.getElementById('attentionChart').classList.contains('visible');
  }

  function columnHeaders() {
    const row = document.querySelector('#results .column-header-row');
    return row ? [...row.querySelectorAll('.col-header')].map(el => el.textContent.trim()) : [];
  }

  function resultRows() {
    return [...document.querySelectorAll('#results .result-item')];
  }

  function collectionLayoutVisible() {
    return document.getElementById('collectionLayout').classList.contains('visible');
  }

  function pinnedOnlyRows() {
    // Pinned rows only (exclude related-result items also rendered inside #pinnedResults)
    return [...document.querySelectorAll('#pinnedResults .result-item:not(.related-result)')];
  }

  function pinnedResultRows() {
    return [...document.querySelectorAll('#pinnedResults .result-item')];
  }

  function relatedResultsContent() {
    return document.getElementById('relatedResults').textContent.trim();
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('Test 1: clear cache, pause collection list & interaction list → frames only', async () => {
    clearCache();

    // Pause: collection list loading (loadSettings slow path blocks renderCollections
    // and all other cache-miss settings) AND interaction file listing
    deferreds['loadSettings'] = createDeferred();
    deferreds['listInteractionFiles'] = createDeferred();

    // Import triggers initialize() — it blocks at loadSettingsValue('settings') cache miss
    const importDone = importOptions();
    await tick(50);

    // Frames should be rendered from static HTML
    expect(sidebarCategories()).toContain('all');
    expect(sidebarCategories()).toContain('recycleBin');
    expect(mainTitle()).toBe('History'); // static HTML default
    expect(chartFrameVisible()).toBe(true); // chart has class="visible" in HTML
    expect(columnHeaders().length).toBeGreaterThan(0); // column headers in static HTML

    // No collection items (loadSettings blocked → renderCollections hasn't completed)
    expect(sidebarCollections()).toEqual([]);

    // No result rows (initialize stuck before loadData → showCategory hasn't run)
    expect(resultRows()).toEqual([]);

    // Clean up: resolve deferreds so initialize can finish
    deferreds['loadSettings'].resolve();
    deferreds['listInteractionFiles'].resolve();
    await importDone;
    await tick(50);
  });

  it('Test 2: pause collection list only → frames + history list visible', async () => {
    // Cache all settings EXCEPT 'collections' → renderCollections hits slow path
    storageData = {
      settings: TEST_SETTINGS.settings,
      urlBlacklist: TEST_SETTINGS.urlBlacklist,
      titleTrimRules: TEST_SETTINGS.titleTrimRules,
      recycleBin: TEST_SETTINGS.recycleBin,
      permanentDeletes: TEST_SETTINGS.permanentDeletes,
      gatewayDomains: {},
      writeBuffer: [],
      // 'collections' intentionally missing → loadSettings slow path
    };

    // Pause loadSettings → renderCollections() blocks on collection list
    // But since renderCollections is fire-and-forget, loadData() proceeds concurrently
    deferreds['loadSettings'] = createDeferred();

    const importDone = importOptions();
    await tick(100);

    // Frames visible
    expect(sidebarCategories()).toContain('all');
    expect(chartFrameVisible()).toBe(true);

    // History results visible (loadData + showCategory completed independently)
    expect(resultRows().length).toBeGreaterThan(0);

    // But collections still empty (renderCollections waiting for loadSettings)
    expect(sidebarCollections()).toEqual([]);

    // Resolve loadSettings → collections should appear
    deferreds['loadSettings'].resolve();
    await importDone;
    await tick(100);

    expect(sidebarCollections()).toContain('col-rust');
  });

  it('Test 3: pause interaction list only → frames + collection list visible', async () => {
    populateCache();

    // Pause interaction file listing → loadData() blocks
    deferreds['listInteractionFiles'] = createDeferred();

    const importDone = importOptions();
    await tick(100);

    // Sidebar collections rendered (loadCollections cache hit, fire-and-forget)
    expect(sidebarCollections()).toContain('col-rust');

    // Frames visible
    expect(sidebarCategories()).toContain('all');
    expect(chartFrameVisible()).toBe(true);

    // loadData blocked → Promise.all blocked → showCategory hasn't run → no result rows
    expect(resultRows()).toEqual([]);

    // Unblock
    deferreds['listInteractionFiles'].resolve();
    await importDone;
    await tick(100);

    // Now results should appear
    expect(resultRows().length).toBeGreaterThan(0);
  });

  it('Test 4: cache populated, pause pinned results + search → collection shows frames + sidebar', async () => {
    populateCache();

    // First: let initialize() complete fully (no pauses)
    const importDone = importOptions();
    await importDone;
    await tick(100);

    // Verify initial state: history view rendered
    expect(resultRows().length).toBeGreaterThan(0);
    expect(sidebarCollections()).toContain('col-rust');

    // Now inject pauses and open a collection
    deferreds['loadCollectionPins'] = createDeferred();
    deferreds['loadContentBatch'] = createDeferred(); // blocks pipelinedSearch

    // Simulate clicking on the collection — call showCollection via its sidebar click handler
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(50);

    // Collection layout should be visible
    expect(collectionLayoutVisible()).toBe(true);

    // Sidebar should still show collections (already rendered, not re-fetched)
    expect(sidebarCollections()).toContain('col-rust');

    // Frames: sidebar categories still visible
    expect(sidebarCategories()).toContain('all');

    // Main title should reflect collection
    expect(mainTitle()).toBe('Rust Lang');

    // Phase 1: pinned section renders immediately (allCollectionPins + cachedData
    // were loaded during initialize, and Phase 1 paints before Phase 2 via setTimeout(0)).
    expect(pinnedOnlyRows().length).toBe(3);

    // Explore section renders immediately (decoupled from pinned search)
    // Collection has no qbTree, so explore shows empty-state prompt
    expect(relatedResultsContent()).toContain('Add filters to start querying');

    // Clean up
    deferreds['loadCollectionPins'].resolve();
    deferreds['loadContentBatch'].resolve();
    await tick(200);
  });

  it('Test 5: load collection fully, then reopen with search paused → pinned section renders from cache', async () => {
    populateCache();

    // Let initialize() complete
    const importDone = importOptions();
    await importDone;
    await tick(100);

    // Open collection normally (no pauses)
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
    collItem.click();
    await tick(200);

    // Verify full collection rendered
    expect(collectionLayoutVisible()).toBe(true);
    expect(pinnedOnlyRows().length).toBe(3);
    // Phase 2 completed — related results no longer show loading hint
    // (renderPinnedWithRelated replaced Phase 1 content, and renderCollectionExplore
    // replaced the loading hint in #relatedResults)
    expect(relatedResultsContent()).not.toContain('Computing related pages');

    // Capture the pinned+related row count from the first full load
    const firstLoadPinnedCount = pinnedResultRows().length;
    expect(firstLoadPinnedCount).toBeGreaterThan(3); // 3 pinned + related items

    // Now inject pause on search and reopen
    deferreds['loadContentBatch'] = createDeferred();

    // Click the collection again to reopen
    collItem.click();
    await tick(100);

    // Collection layout visible
    expect(collectionLayoutVisible()).toBe(true);
    expect(mainTitle()).toBe('Rust Lang');

    // Phase 1 renders from collectionResultsCache — full pinned+related, no loading state
    expect(pinnedOnlyRows().length).toBe(3);
    expect(pinnedResultRows().length).toBe(firstLoadPinnedCount);
    expect(relatedResultsContent()).not.toContain('Computing related pages');

    // Sidebar still shows collections
    expect(sidebarCollections()).toContain('col-rust');

    // Clean up
    deferreds['loadContentBatch'].resolve();
    await tick(200);
  });
});
