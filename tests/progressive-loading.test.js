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
import { generateSlugFromUrl } from '../extension/utils.js';

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

function pinFromUrl(url, pinnedAt) {
  return { id: 'page:' + generateSlugFromUrl(url), pinnedAt };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
function makeInteraction(url, title, timestamp, opts = {}) {
  const slug = url.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
  return { id: `${timestamp}-${slug}`, url, title, timestamp, slug, intent: opts.intent || '' };
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

// Rust-related pages (will match list query)
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

const TEST_LIST = {
  slug: 'col-rust',
  query: 'rust',
  name: 'Rust Lang',
  parentList: 'list:system/root',
  childLists: [],
};

// List whose query matches NO interactions in metadata (like "AI Core")
// but whose pins share hostname with loaded history → related pages should still appear
const TEST_LIST_NOHIT = {
  slug: 'col-nohit',
  query: 'xyzzy nonexistent query',
  name: 'No-Hit Query',
  parentList: 'list:system/root',
  childLists: [],
};

const TEST_LIST_PINS = {
  'col-rust': [
    pinFromUrl('https://rust-lang.org/doc0', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc1', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc2', NOW - DAY),
  ],
  'col-nohit': [
    // Pin from example.com — shares hostname with FILE1_INTERACTIONS (Today Page 0..19)
    pinFromUrl('https://example.com/today0', NOW - DAY),
  ],
};

const TEST_LISTS = [TEST_LIST, TEST_LIST_NOHIT];

// Build slug→URL mapping for all pinned URLs (needed to populate page entities in session cache)
const KNOWN_PIN_URLS = [
  'https://rust-lang.org/doc0', 'https://rust-lang.org/doc1', 'https://rust-lang.org/doc2',
  'https://example.com/today0',
];
const SLUG_TO_URL = new Map(KNOWN_PIN_URLS.map(url => [generateSlugFromUrl(url), url]));

const TEST_SETTINGS = {
  captureContent: true,
  captureAttention: true,
  archiveQuality: 'medium',
  urlBlacklist: [],
  titleTrimRules: [],
};

const TEST_ROOT = {
  timestamp: 0,
  childLists: ['list:col-rust', 'list:col-nohit'],
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

// Hoisted mock for searchBatch — configurable per-test
const { mockSearchBatchFn, mockFsHandler } = vi.hoisted(() => ({
  mockSearchBatchFn: vi.fn(async () => []),
  mockFsHandler: { fn: (action, msg) => ({ success: true }) },
}));

// Mock directory handle for FileSystem Access API
function mockDirectoryHandle() {
  return { getDirectoryHandle: async () => mockDirectoryHandle() };
}

vi.mock('../extension/filesystem-storage.js', () => ({
  FileSystemStorage: class {
    constructor() { this.directoryHandle = mockDirectoryHandle(); }
    async getDirectoryInfo() { return { name: 'test-portal-data', hasPermission: true }; }
    async verifyPermission() { return true; }
    async loadDirectoryHandle() { return this.directoryHandle; }
    async selectDirectory() { return { success: true, name: 'test' }; }
    async loadAllInteractions() { return []; }
    async loadAllContent() { return {}; }
    async loadSettings() { return (await mockFsHandler.fn('loadSettings', {})).settings || {}; }
    async listInteractionFiles() { return (await mockFsHandler.fn('listInteractionFiles', {})).files || []; }
    async loadInteractionFiles(files) { return (await mockFsHandler.fn('loadInteractionBatch', { files })).interactions || []; }
    async loadListPins() { return (await mockFsHandler.fn('loadListPins', {})).pins || {}; }
    async loadListPinsById(id) { return (await mockFsHandler.fn('loadListPinsById', { listId: id })).pins || []; }
    async loadPermanentDeletes() { return (await mockFsHandler.fn('loadPermanentDeletes', {})).urls || []; }
    async loadHighlights() { return []; }
    async loadAllHighlights() { return {}; }
    async loadPageBatch(slugs) { return (await mockFsHandler.fn('loadPageBatch', { slugs })).pages || {}; }
    async listSnapshots() { return []; }
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
    searchBatch: (...args) => mockSearchBatchFn(...args),
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
  let sessionData;  // chrome.storage.session
  let localData;    // chrome.storage.local
  let initPromise;

  function makeStorageMock(dataRef) {
    return {
      get: vi.fn(async (keys) => {
        const data = dataRef();
        if (!keys) return { ...data };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) {
          if (k in data) result[k] = data[k];
        }
        return result;
      }),
      set: vi.fn(async (obj) => { Object.assign(dataRef(), obj); }),
      remove: vi.fn(async (keys) => { const d = dataRef(); for (const k of keys) delete d[k]; }),
      clear: vi.fn(async () => { const d = dataRef(); for (const k of Object.keys(d)) delete d[k]; }),
    };
  }

  function setupChromeMock() {
    sessionData = {};
    localData = {};
    deferreds = {};

    mockFsHandler.fn = async (action, params) => {
      const deferred = deferreds[action];
      if (deferred) await deferred.promise;
      return handleAction({ action, ...params });
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          const deferred = deferreds[msg.action];
          if (deferred) await deferred.promise;
          return handleAction(msg);
        }),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        session: makeStorageMock(() => sessionData),
        local: makeStorageMock(() => localData),
      },
    };
    globalThis.chrome = chromeMock;
  }

  function handleAction(msg) {
    switch (msg.action) {
      case 'listInteractionFiles':
        return { success: true, files: FILES_NEWEST_FIRST };

      case 'loadInteractionBatch': {
        const interactions = [];
        for (const f of msg.files) {
          if (FILE_MAP[f]) interactions.push(...FILE_MAP[f]);
        }
        return { success: true, interactions };
      }

      case 'loadPermanentDeletes':
        return { success: true, urls: [] };

      case 'loadContentBatch':
        // Return empty content — search still works via title matching
        return { success: true, contentMap: {} };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'saveSettingsKey':
        return { success: true };

      case 'readCacheable':
        switch (msg.key) {
          case 'manifest:settings': return { success: true, value: TEST_SETTINGS };
          case 'list:system/root': return { success: true, value: TEST_ROOT };
          case 'manifest:name-to-id': return { success: true, value: { timestamp: 0, paths: {} } };
          case 'manifest:orphaned': return { success: true, value: { timestamp: 0, entries: [] } };
          default: {
            // Return individual list entities by slug with pins
            for (const list of TEST_LISTS) {
              if (msg.key === 'list:' + list.slug) {
                return { success: true, value: { ...list, pins: TEST_LIST_PINS[list.slug] || [] } };
              }
            }
            return { success: true, value: undefined };
          }
        }

      default:
        return { success: true };
    }
  }

  // Populate cache with all settings so loadSettingsValue hits fast path
  function populateCache() {
    sessionData = {
      'manifest:settings': TEST_SETTINGS,
      'list:system/root': { ...TEST_ROOT },
    };
    // Individual list entity keys (include pins for session cache hits)
    for (const list of TEST_LISTS) {
      sessionData['list:' + list.slug] = { ...list, pins: TEST_LIST_PINS[list.slug] || [] };
    }
    // Add page entities for all known pin URLs (simulates real cache where checkpointed pages have .url)
    for (const [slug, url] of SLUG_TO_URL) {
      sessionData['page:' + slug] = { slug, url, watermark: 0 };
    }
    localData = {
      logBuffer: [],
    };
  }

  function clearCache() {
    sessionData = {};
    localData = {};
  }

  beforeEach(() => {
    vi.resetModules();
    mockSearchBatchFn.mockReset();
    mockSearchBatchFn.mockImplementation(async () => []);
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

  function sidebarLists() {
    return [...document.querySelectorAll('#listsList .sidebar-item')]
      .map(el => el.dataset.listId);
  }

  function mainTitle() {
    return document.getElementById('mainTitle').textContent.trim();
  }

  function chartFrameVisible() {
    return document.getElementById('timeChart').classList.contains('visible');
  }

  function columnHeaders() {
    const row = document.querySelector('#results .column-header-row');
    return row ? [...row.querySelectorAll('.col-header')].map(el => el.textContent.trim()) : [];
  }

  function resultRows() {
    return [...document.querySelectorAll('#results .result-item')];
  }

  function listLayoutVisible() {
    return document.getElementById('listLayout').classList.contains('visible');
  }

  function pinnedOnlyRows() {
    // Pins now render in #relatedResults (unified single-section layout)
    return [...document.querySelectorAll('#relatedResults .result-item')];
  }

  function pinnedResultRows() {
    return [...document.querySelectorAll('#relatedResults .result-item')];
  }

  function relatedResultsContent() {
    return document.getElementById('relatedResults').textContent.trim();
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('Test 1: clear cache, pause sidebar lists & interaction list → frames only', async () => {
    clearCache();

    // Pause: readCacheable (blocks renderLists + loadSettingsValue)
    // AND interaction file listing
    deferreds['readCacheable'] = createDeferred();
    deferreds['listInteractionFiles'] = createDeferred();

    // Import triggers initialize() — it blocks at readCacheable('manifest:settings') cache miss
    // and at initHistoryFiles() (listInteractionFiles paused)
    const importDone = importOptions();
    await tick(50);

    // Frames should be rendered from static HTML
    expect(document.getElementById('exploreBtn')).not.toBeNull();
    expect(mainTitle()).toBe('Explore'); // static HTML default
    // sort toggle removed — results use default sort (lastVisit desc)

    // No list items (readCacheable blocked → renderLists hasn't completed)
    expect(sidebarLists()).toEqual([]);

    // No result rows (initialize stuck before initHistoryFiles → showCategory hasn't run)
    expect(resultRows()).toEqual([]);

    // Clean up: resolve deferreds so initialize can finish
    deferreds['readCacheable'].resolve();
    deferreds['listInteractionFiles'].resolve();
    await importDone;
    await tick(50);
  });

  it('Test 2: sidebar lists render from list:system/root even when individual entity keys are absent from session', async () => {
    // Cache list:system/root but NOT individual list:<slug> keys in session.
    // loadListTree() reads list:system/root, then readCacheable falls back to
    // the message handler for each child entity key.
    sessionData = {
      'manifest:settings': TEST_SETTINGS,
      'list:system/root': { ...TEST_ROOT },
      // individual list:<slug> keys intentionally missing from session
    };
    localData = { logBuffer: [] };

    const importDone = importOptions();
    await tick(200);

    // Frames visible
    expect(document.getElementById('exploreBtn')).not.toBeNull();

    // Explore view rendered
    expect(mainTitle()).toBe('Explore');

    // Sidebar lists render via readCacheable fallback (session miss → message handler)
    expect(sidebarLists()).toContain('col-rust');

    await importDone;
    await tick(100);
  });

  it('Test 3: pause interaction list only → frames + sidebar lists visible', async () => {
    populateCache();

    // Pause interaction file listing → loadData() blocks
    deferreds['listInteractionFiles'] = createDeferred();

    const importDone = importOptions();
    await tick(100);

    // Sidebar lists rendered (loadLists cache hit, fire-and-forget)
    expect(sidebarLists()).toContain('col-rust');

    // Frames visible
    expect(document.getElementById('exploreBtn')).not.toBeNull();

    // initHistoryFiles blocked → Promise.all blocked → showExplore hasn't run yet
    expect(listLayoutVisible()).toBe(false);

    // Unblock
    deferreds['listInteractionFiles'].resolve();
    await importDone;
    await tick(100);

    // Now Explore view should render (list layout visible)
    expect(listLayoutVisible()).toBe(true);
    expect(mainTitle()).toBe('Explore');
  });

  it('Test 4: cache populated, pause pinned results + search → list shows frames + sidebar', async () => {
    populateCache();

    // First: let initialize() complete fully (no pauses)
    const importDone = importOptions();
    await importDone;
    await tick(100);

    // Verify initial state: Explore view rendered
    expect(mainTitle()).toBe('Explore');
    expect(listLayoutVisible()).toBe(true);
    expect(sidebarLists()).toContain('col-rust');

    // Now inject pauses and open a list
    // Block searchBatch (Rust-side search) so Phase 2 is deferred while Phase 1 renders instantly
    const searchDeferred = createDeferred();
    mockSearchBatchFn.mockImplementation(async () => {
      await searchDeferred.promise;
      return [];
    });

    // Simulate clicking on the list — call showList via its sidebar click handler
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(50);

    // List layout should be visible
    expect(listLayoutVisible()).toBe(true);

    // Sidebar should still show lists (already rendered, not re-fetched)
    expect(sidebarLists()).toContain('col-rust');

    // Sidebar categories still visible
    expect(document.getElementById('exploreBtn')).not.toBeNull();

    // Main title should reflect list
    expect(mainTitle()).toBe('Rust Lang');

    // Phase 1: pinned section renders immediately (lazy-loaded pins enriched
    // from cached fields + pageReadCache, no blocking I/O).
    expect(pinnedOnlyRows().length).toBe(3);

    // Explore section renders immediately (no saved searches = shows all history)
    // Search panel should be visible
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();

    // Clean up
    searchDeferred.resolve();
    await tick(200);
  });

  it('Test 5: load list fully, then reopen with search paused → pinned section renders from cache', async () => {
    populateCache();

    // Configure searchBatch to return rust interactions (matching "rust" query)
    const rustResults = RUST_INTERACTIONS.map(i => ({
      url: i.url, title: i.title, score: 1.0, timestamp: i.timestamp,
    }));
    mockSearchBatchFn.mockImplementation(async () => rustResults);

    // Let initialize() complete
    const importDone = importOptions();
    await importDone;
    await tick(100);

    // Open list normally (no pauses)
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    collItem.click();
    await tick(200);

    // Verify full list rendered
    expect(listLayoutVisible()).toBe(true);
    expect(pinnedOnlyRows().length).toBe(3);

    // Phase 2 completed — pinned section is re-rendered from fetchListResults
    // and explore section shows blocks (no loading hint)
    expect(relatedResultsContent()).not.toContain('Computing related pages');

    // Now block searchBatch and reopen — cache should serve immediately
    const searchDeferred = createDeferred();
    mockSearchBatchFn.mockImplementation(async () => {
      await searchDeferred.promise;
      return [];
    });

    // Click the list again to reopen
    collItem.click();
    await tick(100);

    // List layout visible
    expect(listLayoutVisible()).toBe(true);
    expect(mainTitle()).toBe('Rust Lang');

    // Phase 1 renders from listResultsCache — full pinned, no loading state
    expect(pinnedOnlyRows().length).toBe(3);
    expect(relatedResultsContent()).not.toContain('Computing related pages');

    // Sidebar still shows lists
    expect(sidebarLists()).toContain('col-rust');

    // Clean up
    searchDeferred.resolve();
    await tick(200);
  });

  it('Test 6: title-changing page shows latest title from history, not "Untitled"', async () => {
    // Simulate a page whose title changes after initial load:
    //   entry 1 (oldest): title = "Untitled"
    //   entry 2: title = "Real Title"
    //   entry 3 (newest): no title field (attention update, title unchanged)
    // The explore view should display "Real Title", not "Untitled".
    const TITLE_CHANGE_URL = 'https://example.com/title-change-page';
    const base = new Date('2026-02-15T14:00:00Z').getTime();
    const slug = TITLE_CHANGE_URL.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
    const titleEntries = [
      { id: `${base}-${slug}`, url: TITLE_CHANGE_URL, title: 'Untitled', timestamp: base, slug, action: 'visit_page' },
      { id: `${base + 60000}-${slug}`, url: TITLE_CHANGE_URL, title: 'Real Title', timestamp: base + 60000, slug, action: 'visit_page' },
      { id: `${base + 120000}-${slug}`, url: TITLE_CHANGE_URL, timestamp: base + 120000, slug, action: 'leave_page' },
    ];

    // Inject title-change entries into FILE1 data
    const origFile1 = FILE_MAP[`${FILE1_DATE}.jsonl`];
    FILE_MAP[`${FILE1_DATE}.jsonl`] = [...origFile1, ...titleEntries];

    populateCache();
    const importDone = importOptions();
    await importDone;
    await tick(200);

    // Verify explore view rendered
    expect(mainTitle()).toBe('Explore');
    expect(listLayoutVisible()).toBe(true);

    // Find the result row for our title-change page
    const rows = [...document.querySelectorAll('#relatedResults .result-item, #results .result-item')];
    const matchingRow = rows.find(el => el.innerHTML.includes(TITLE_CHANGE_URL));
    expect(matchingRow).toBeTruthy();
    // The displayed title should be "Real Title", not "Untitled"
    expect(matchingRow.textContent).toContain('Real Title');
    expect(matchingRow.textContent).not.toContain('Untitled');

    // Restore original FILE_MAP
    FILE_MAP[`${FILE1_DATE}.jsonl`] = origFile1;
  });

  it('Test 7: list with zero-hit query still shows related pages from loaded history', async () => {
    populateCache();

    // searchBatch returns [] (query matches nothing in metadata)
    mockSearchBatchFn.mockImplementation(async () => []);

    // Let initialize() complete
    const importDone = importOptions();
    await importDone;
    await tick(100);

    // Default view is Explore — verify it rendered
    expect(listLayoutVisible()).toBe(true);
    expect(mainTitle()).toBe('Explore');

    // Open the no-hit list
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-nohit"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // List layout visible with correct title
    expect(listLayoutVisible()).toBe(true);
    expect(mainTitle()).toBe('No-Hit Query');

    // Phase 1: the single pin should render
    expect(pinnedOnlyRows().length).toBe(1);

    // Search panel should be rendered (no saved searches = shows all history)
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();
  });
});
