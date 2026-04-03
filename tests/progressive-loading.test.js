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
function makeEntry(url, title, timestamp, opts = {}) {
  const slug = url.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
  return { id: `${timestamp}-${slug}`, url, title, timestamp, slug, intent: opts.intent || '' };
}

const NOW = Date.now();
const DAY = 86400000;

// 60 history entries across 3 daily files, newest first
const FILE1_DATE = '2026-02-15'; // today — newest
const FILE2_DATE = '2026-02-14';
const FILE3_DATE = '2026-02-13';

function makeFileEntries(dateStr, startIdx, count, titlePrefix) {
  const base = new Date(dateStr + 'T12:00:00Z').getTime();
  const result = [];
  for (let i = 0; i < count; i++) {
    const ts = base + i * 60000;
    result.push(makeEntry(
      `https://example.com/${titlePrefix.toLowerCase()}${startIdx + i}`,
      `${titlePrefix} Page ${startIdx + i}`,
      ts,
      { intent: titlePrefix.toLowerCase() }
    ));
  }
  return result;
}

// Rust-related pages (will match list query)
function makeRustEntries() {
  const base = new Date('2026-02-15T10:00:00Z').getTime();
  const result = [];
  for (let i = 0; i < 25; i++) {
    result.push(makeEntry(
      `https://rust-lang.org/doc${i}`,
      `Rust Documentation ${i}`,
      base + i * 60000,
      { intent: 'rust programming' }
    ));
  }
  return result;
}

const FILE1_ENTRIES = makeFileEntries(FILE1_DATE, 0, 20, 'Today');
const FILE2_ENTRIES = makeFileEntries(FILE2_DATE, 20, 20, 'Yesterday');
const FILE3_ENTRIES = makeFileEntries(FILE3_DATE, 40, 20, 'OldDay');
const RUST_ENTRIES = makeRustEntries();
// Rust entries are in file1 (today)
const ALL_FILE1 = [...FILE1_ENTRIES, ...RUST_ENTRIES];

const ALL_ENTRIES = [...ALL_FILE1, ...FILE2_ENTRIES, ...FILE3_ENTRIES];

const TEST_LIST = {
  slug: 'col-rust',
  query: 'rust',
  name: 'Rust Lang',
};

// List whose query matches NO entries in metadata (like "AI Core")
// but whose pins share hostname with loaded history → related pages should still appear
const TEST_LIST_NOHIT = {
  slug: 'col-nohit',
  query: 'xyzzy nonexistent query',
  name: 'No-Hit Query',
};

const TEST_LIST_PINS = {
  'col-rust': [
    pinFromUrl('https://rust-lang.org/doc0', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc1', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc2', NOW - DAY),
  ],
  'col-nohit': [
    // Pin from example.com — shares hostname with FILE1_ENTRIES (Today Page 0..19)
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

const TEST_LIST_ORDER = {
  timestamp: 0,
  tree: [{ id: 'list:col-rust' }, { id: 'list:col-nohit' }],
};

const FILES_NEWEST_FIRST = [
  `${FILE1_DATE}.jsonl`,
  `${FILE2_DATE}.jsonl`,
  `${FILE3_DATE}.jsonl`,
];

// Map filename → entries for loadHistoryBatch mock
const FILE_MAP = {
  [`${FILE1_DATE}.jsonl`]: ALL_FILE1,
  [`${FILE2_DATE}.jsonl`]: FILE2_ENTRIES,
  [`${FILE3_DATE}.jsonl`]: FILE3_ENTRIES,
};

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We must set up mocks BEFORE dynamic import of options.js.
// vi.mock calls are hoisted above imports by vitest.

// Hoisted mock for searchBatch/searchNotes/searchSnapshots — configurable per-test
const { mockSearchBatchFn, mockSearchNotesFn, mockSearchSnapshotsFn, mockFsHandler, mockDirChildren } = vi.hoisted(() => ({
  mockSearchBatchFn: vi.fn(async () => []),
  mockSearchNotesFn: vi.fn(async () => []),
  mockSearchSnapshotsFn: vi.fn(async () => []),
  mockFsHandler: { fn: (action, msg) => ({ success: true }) },
  // Configurable per-test: path → [child entries]. Paths are slash-separated from root.
  mockDirChildren: { map: {} },
}));

// Mock directory handle for FileSystem Access API.
// Uses mockDirChildren.map to resolve children by path.
// Path format: 'data/logs/device1' → children of that directory.
function mockDirectoryHandle(currentPath = '') {
  const children = mockDirChildren.map[currentPath] || [];
  return {
    getDirectoryHandle: async (name) => {
      const childPath = currentPath ? `${currentPath}/${name}` : name;
      return mockDirectoryHandle(childPath);
    },
    getFileHandle: async (name) => {
      // Return a mock file handle (WASM searchBatch is mocked, won't actually read)
      return { getFile: async () => ({ text: async () => '' }) };
    },
    values: function() {
      let idx = 0;
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (idx >= children.length) return { done: true, value: undefined };
          return { done: false, value: children[idx++] };
        },
      };
    },
  };
}

vi.mock('../extension/filesystem-storage.js', () => ({
  FileSystemStorage: class {
    constructor() { this.directoryHandle = mockDirectoryHandle(); }
    async getDirectoryInfo() { return { name: 'test-portal-data', hasPermission: true }; }
    async verifyPermission() { return true; }
    async loadDirectoryHandle() { return this.directoryHandle; }
    async selectDirectory() { return { success: true, name: 'test' }; }
    async loadAllContent() { return {}; }
    async loadSettings() { return (await mockFsHandler.fn('loadSettings', {})).settings || {}; }
    async listHistoryFiles() { return (await mockFsHandler.fn('listHistoryFiles', {})).files || []; }
    async listHistoryFileSizes() { return (await mockFsHandler.fn('listHistoryFiles', { includeSizes: true })).sizes || {}; }
    async loadHistoryFiles(files) { return (await mockFsHandler.fn('loadHistoryBatch', { files })).entries || []; }
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
  class MockHistoryEntry {
    constructor(url, title) { this.url = url; this.title = title; }
    set id(v) { this._id = v; }
    set timestamp(v) { this._timestamp = v; }
    setIntent() {}
    setContent() {}
    setAttention() {}
  }

  class MockSearchEngine {
    constructor() { this._items = []; }
    addEntry(item) { this._items.push(item); }
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
    HistoryEntry: MockHistoryEntry,
    SearchEngine: MockSearchEngine,
    searchBatch: (...args) => mockSearchBatchFn(...args),
    searchNotes: (...args) => mockSearchNotesFn(...args),
    searchSnapshots: (...args) => mockSearchSnapshotsFn(...args),
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
describe.each(['warm', 'degraded'])('Progressive loading (%s cache)', (cacheMode) => {
  const isDegraded = cacheMode === 'degraded';
  /** @type {Record<string, {promise: Promise, resolve: Function}>} */
  let deferreds;
  let sessionData;  // chrome.storage.session
  let localData;    // chrome.storage.local
  let initPromise;
  let actionOverrides = {};

  function makeStorageMock(dataRef) {
    return {
      get: vi.fn(async (keys) => {
        const data = dataRef();
        if (!keys) return isDegraded ? {} : { ...data };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) {
          if (isDegraded && /^(manifest:|list:|page:|note:)/.test(k)) continue;
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
    if (actionOverrides[msg.action]) return actionOverrides[msg.action](msg);
    switch (msg.action) {
      case 'getDeviceId':
        return { success: true, deviceId: 'test-device' };

      case 'hasDirectoryHandle':
        return { success: true, hasHandle: true };

      case 'listHistoryFiles':
        return { success: true, files: FILES_NEWEST_FIRST };

      case 'loadHistoryBatch': {
        const entries = [];
        for (const f of msg.files) {
          if (FILE_MAP[f]) entries.push(...FILE_MAP[f]);
        }
        return { success: true, entries };
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
          case 'manifest:list-order': return { success: true, value: sessionData['manifest:list-order'] || TEST_LIST_ORDER };
          case 'manifest:name-to-id': return { success: true, value: { timestamp: 0, paths: {} } };
          case 'manifest:orphaned': return { success: true, value: { timestamp: 0, entries: [] } };
          default: {
            // Check sessionData first (has test modifications and dynamically added entities)
            if (msg.key in sessionData) {
              return { success: true, value: sessionData[msg.key] };
            }
            // Fall back to static TEST_LISTS
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
      'manifest:list-order': { ...TEST_LIST_ORDER },
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

  beforeEach(async () => {
    vi.resetModules();
    mockSearchBatchFn.mockReset();
    mockSearchBatchFn.mockImplementation(async () => []);
    mockSearchNotesFn.mockReset();
    mockSearchNotesFn.mockImplementation(async () => []);
    mockSearchSnapshotsFn.mockReset();
    mockSearchSnapshotsFn.mockImplementation(async () => []);
    mockDirChildren.map = {};
    actionOverrides = {};
    // Set up minimal DOM
    document.head.innerHTML = `<style>${styleContent}</style>`;
    document.body.innerHTML = bodyContent;

    // performance.now may not exist in jsdom
    if (!globalThis.performance) {
      globalThis.performance = { now: () => Date.now() };
    }

    setupChromeMock();

    // Provide uFuzzy global for fuzzyMatchPhase0 (loaded via <script> in real extension)
    if (!globalThis.uFuzzy) {
      const { default: uFuzzyModule } = await import('@leeoniya/ufuzzy');
      globalThis.uFuzzy = uFuzzyModule;
    }
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

  it('Test 1: clear cache, pause sidebar lists & history list → frames only', async () => {
    clearCache();

    // Pause: readCacheable (blocks renderLists + loadSettingsValue)
    // AND history file listing
    deferreds['readCacheable'] = createDeferred();
    deferreds['listHistoryFiles'] = createDeferred();

    // Import triggers initialize() — it blocks at readCacheable('manifest:settings') cache miss
    // and at initHistoryFiles() (listHistoryFiles paused)
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
    deferreds['listHistoryFiles'].resolve();
    await importDone;
    await tick(50);
  });

  it('Test 2: sidebar lists render from manifest:list-order even when individual entity keys are absent from session', async () => {
    // Cache manifest:list-order but NOT individual list:<slug> keys in session.
    // loadListTree() reads manifest:list-order, then readCacheable falls back to
    // the message handler for each child entity key.
    sessionData = {
      'manifest:settings': TEST_SETTINGS,
      'manifest:list-order': { ...TEST_LIST_ORDER },
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

  it('Test 3: pause history list only → frames + sidebar lists visible', async () => {
    populateCache();

    // Pause history file listing → loadData() blocks
    deferreds['listHistoryFiles'] = createDeferred();

    const importDone = importOptions();
    await tick(100);

    // Sidebar lists rendered (loadLists cache hit, fire-and-forget)
    expect(sidebarLists()).toContain('col-rust');

    // Frames visible
    expect(document.getElementById('exploreBtn')).not.toBeNull();

    // initHistoryFiles blocked → Promise.all blocked → showExplore hasn't run yet
    expect(listLayoutVisible()).toBe(false);

    // Unblock
    deferreds['listHistoryFiles'].resolve();
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

    // Configure searchBatch to return rust entries (matching "rust" query)
    const rustResults = RUST_ENTRIES.map(i => ({
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

  // -------------------------------------------------------------------------
  // Estimated chart bars
  // -------------------------------------------------------------------------
  describe('Estimated chart bars', () => {
    // 100 files spanning Sep–Dec 2025, newest-first.
    // Using 100 files ensures that even after explore's onLoadMore chains
    // (historyFileBatch=10, HISTORY_MAX_FILES=100), some files remain unloaded
    // when showCategory('all') runs with only a few hundred ms of tick.
    const EST_FILES = [];
    const EST_SIZES = {};
    const EST_FILE_MAP = {};
    for (let i = 0; i < 100; i++) {
      const d = new Date(Date.UTC(2025, 8, 24 + i)); // Sep 24 2025 → Jan 1 2026
      const dateStr = d.toISOString().slice(0, 10);
      const filename = dateStr + '.jsonl';
      EST_FILES.push(filename);
      EST_SIZES[filename] = 2000 + (i % 20) * 200; // varying sizes
    }
    // Sort newest-first
    EST_FILES.sort().reverse();
    // Only create entries for the 10 newest files (the first batch)
    for (let i = 0; i < 10; i++) {
      const filename = EST_FILES[i];
      const dateStr = filename.replace('.jsonl', '');
      EST_FILE_MAP[filename] = makeFileEntries(dateStr, i * 5, 5, `Est${i}`);
    }

    it('Test 8: chart shows estimated bars for unloaded files', async () => {
      populateCache();

      actionOverrides['listHistoryFiles'] = (msg) => ({
        success: true,
        files: EST_FILES,
        sizes: msg.includeSizes ? EST_SIZES : undefined,
      });
      actionOverrides['loadHistoryBatch'] = (msg) => {
        const entries = [];
        for (const f of msg.files) {
          if (EST_FILE_MAP[f]) entries.push(...EST_FILE_MAP[f]);
        }
        return { success: true, entries };
      };

      // Inject a category button BEFORE importing so options.js binds its event listener
      const sidebarContent = document.querySelector('.sidebar-content');
      const allBtn = document.createElement('div');
      allBtn.className = 'sidebar-item';
      allBtn.dataset.category = 'all';
      sidebarContent.appendChild(allBtn);

      const importDone = importOptions();
      await importDone;
      await tick(200);

      // Click to navigate to All History (showCategory('all') renders the main time chart)
      allBtn.click();
      await tick(300);

      // Chart should be visible
      expect(chartFrameVisible()).toBe(true);

      // Should have estimated bars for unloaded dates
      const estimatedGroups = document.querySelectorAll('#chartBars .chart-bar-group.estimated');
      expect(estimatedGroups.length).toBeGreaterThan(0);

      // Should have real bars for loaded dates
      const realGroups = document.querySelectorAll('#chartBars .chart-bar-group.has-data:not(.estimated)');
      expect(realGroups.length).toBeGreaterThan(0);

      // Date range should start from Sep 1 (month boundary of Sep 24)
      const allGroups = document.querySelectorAll('#chartBars .chart-bar-group');
      const firstDate = allGroups[0]?.dataset.date;
      expect(firstDate).toBe('2025-09-01');
    });
  });

  // ---------------------------------------------------------------------------
  // Content search responsiveness tests
  // ---------------------------------------------------------------------------
  describe('Progressive content search', () => {
    // Configure mock filesystem tree so Phase 1 finds device dirs and Phase 2b finds snapshots
    function setupMockDirTree() {
      mockDirChildren.map = {
        // data/logs has one device subdirectory
        'data/logs': [{ kind: 'directory', name: 'test-device' }],
        // device subdir has one .jsonl file
        'data/logs/test-device': [{ kind: 'file', name: '2026-02-15.jsonl' }],
        // data/notes is empty (notes mock handles results)
        'data/notes': [],
        // data/snapshots is empty (snapshots mock handles results)
        'data/snapshots': [],
      };
    }

    // Helper: type a query into the Explore search draft input and trigger search
    async function typeSearchQuery(query) {
      const draftInput = document.querySelector('#searchDraftInput');
      expect(draftInput).not.toBeNull();
      draftInput.value = query;
      draftInput.dispatchEvent(new Event('input'));
      // Debounce is 300ms for explore
      await tick(350);
    }

    it('T-content-1: Phase 0 renders before Phase 1/2 complete', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Block all WASM phases
      const searchDeferred = createDeferred();
      const notesDeferred = createDeferred();
      const snapshotsDeferred = createDeferred();
      mockSearchBatchFn.mockImplementation(async () => {
        await searchDeferred.promise;
        return [];
      });
      mockSearchNotesFn.mockImplementation(async () => {
        await notesDeferred.promise;
        return [];
      });
      mockSearchSnapshotsFn.mockImplementation(async () => {
        await snapshotsDeferred.promise;
        return [];
      });

      // Type a query that matches a title in loaded history (Phase 0 match)
      await typeSearchQuery('Today');
      await tick(50);

      // Phase 0: in-memory title matches should be visible immediately
      const rows = pinnedOnlyRows(); // reads #relatedResults .result-item
      expect(rows.length).toBeGreaterThan(0);

      // Spinner should be visible (WASM phases still running)
      const spinner = document.getElementById('contentSearchSpinner');
      expect(spinner?.style.display).not.toBe('none');

      // Clean up
      searchDeferred.resolve();
      notesDeferred.resolve();
      snapshotsDeferred.resolve();
      await tick(200);
    });

    it('T-content-2: Phase 1 streaming — first chunk renders before second completes', async () => {
      populateCache();
      // Need 11+ files to trigger 2 chunks (CHUNK=10)
      const manyFiles = [];
      for (let i = 0; i < 15; i++) manyFiles.push({ kind: 'file', name: `2026-02-${String(i + 1).padStart(2, '0')}.jsonl` });
      mockDirChildren.map = {
        'data/logs': [{ kind: 'directory', name: 'test-device' }],
        'data/logs/test-device': manyFiles,
        'data/notes': [],
        'data/snapshots': [],
      };

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // First call returns results immediately, second blocks
      const secondChunkDeferred = createDeferred();
      let callCount = 0;
      mockSearchBatchFn.mockImplementation(async () => {
        callCount++;
        if (callCount > 1) {
          await secondChunkDeferred.promise;
          return [{ url: 'https://extra.com/late', title: 'Late Result', score: 1.0, timestamp: Date.now() }];
        }
        return [{ url: 'https://chunk1.com/first', title: 'First Chunk', score: 2.0, timestamp: Date.now() }];
      });
      // Notes and snapshots return empty immediately
      mockSearchNotesFn.mockImplementation(async () => []);
      mockSearchSnapshotsFn.mockImplementation(async () => []);

      await typeSearchQuery('chunk');
      await tick(100);

      // First chunk's results should be visible
      const html = document.getElementById('relatedResults').innerHTML;
      expect(html).toContain('First Chunk');

      // Resolve second chunk
      secondChunkDeferred.resolve();
      await tick(200);

      // Now both results should be present
      const html2 = document.getElementById('relatedResults').innerHTML;
      expect(html2).toContain('First Chunk');
      expect(html2).toContain('Late Result');
    });

    it('T-content-3: Phase 2 results merge without destroying Phase 0/1 results', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Phase 1 returns a result immediately
      mockSearchBatchFn.mockImplementation(async () => {
        return [{ url: 'https://phase1.com/hit', title: 'Phase1 Hit', score: 2.0, timestamp: Date.now() }];
      });

      // Phase 2a (notes) blocks
      const notesDeferred = createDeferred();
      mockSearchNotesFn.mockImplementation(async () => {
        await notesDeferred.promise;
        return [{ url: 'https://noteonly.com/special', noteSlug: 'note-special' }];
      });
      mockSearchSnapshotsFn.mockImplementation(async () => []);

      // Ensure page entity exists for the note URL so enrichment works
      const noteSlug = generateSlugFromUrl('https://noteonly.com/special');
      sessionData['page:' + noteSlug] = { slug: noteSlug, url: 'https://noteonly.com/special', title: 'Note Only Page' };

      await typeSearchQuery('special');
      await tick(200);

      // Phase 0/1 results should be visible
      const html = document.getElementById('relatedResults').innerHTML;
      expect(html).toContain('Phase1 Hit');
      const countBefore = pinnedOnlyRows().length;

      // Resolve notes phase — should add new result without destroying existing
      notesDeferred.resolve();
      await tick(200);

      const html2 = document.getElementById('relatedResults').innerHTML;
      // Original Phase 1 result still present
      expect(html2).toContain('Phase1 Hit');
      // New note result added
      expect(pinnedOnlyRows().length).toBeGreaterThanOrEqual(countBefore);
    });

    it('T-content-4: Stale generation results are discarded', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Block all WASM phases on deferreds
      const reactDeferred = createDeferred();
      const vueDeferred = createDeferred();

      mockSearchBatchFn.mockImplementation(async (...args) => {
        const query = args[2]; // searchBatch(dir, pagesDir, query, files)
        if (query.includes('react')) {
          await reactDeferred.promise;
          return [{ url: 'https://react.dev/docs', title: 'React Docs', score: 2.0, timestamp: Date.now() }];
        }
        if (query.includes('vue')) {
          await vueDeferred.promise;
          return [{ url: 'https://vuejs.org/docs', title: 'Vue Docs', score: 2.0, timestamp: Date.now() }];
        }
        return [];
      });
      mockSearchNotesFn.mockImplementation(async () => []);
      mockSearchSnapshotsFn.mockImplementation(async () => []);

      // Fire first search: "react"
      await typeSearchQuery('react');
      await tick(50);

      // Fire second search: "vue" (supersedes "react", increments generation)
      await typeSearchQuery('vue');
      await tick(50);

      // Resolve "react" results — should be discarded (stale generation)
      reactDeferred.resolve();
      await tick(200);

      const html = document.getElementById('relatedResults').innerHTML;
      expect(html).not.toContain('React Docs');

      // Resolve "vue" results — should appear
      vueDeferred.resolve();
      await tick(200);

      const html2 = document.getElementById('relatedResults').innerHTML;
      expect(html2).toContain('Vue Docs');
    });

    it('T-content-5: Phase 0 fuzzy matching finds typo queries via uFuzzy', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Block WASM phases so only Phase 0 results appear
      const searchDeferred = createDeferred();
      const notesDeferred = createDeferred();
      const snapshotsDeferred = createDeferred();
      mockSearchBatchFn.mockImplementation(async () => {
        await searchDeferred.promise;
        return [];
      });
      mockSearchNotesFn.mockImplementation(async () => {
        await notesDeferred.promise;
        return [];
      });
      mockSearchSnapshotsFn.mockImplementation(async () => {
        await snapshotsDeferred.promise;
        return [];
      });

      // "Todya" is a transposition typo for "Today" — should fuzzy-match "Today Page X"
      await typeSearchQuery('Todya');
      await tick(50);

      const rows = pinnedOnlyRows();
      expect(rows.length).toBeGreaterThan(0);

      // All results should be "Today" pages
      for (const row of rows) {
        const titleEl = row.querySelector('.result-title');
        expect(titleEl.textContent).toMatch(/Today/);
      }

      // Exact substring should also still work
      searchDeferred.resolve();
      notesDeferred.resolve();
      snapshotsDeferred.resolve();
      await tick(200);
    });

    it('T-content-6: Phase 0 exact substring still works when uFuzzy is loaded', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Block WASM phases
      mockSearchBatchFn.mockImplementation(async () => []);
      mockSearchNotesFn.mockImplementation(async () => []);
      mockSearchSnapshotsFn.mockImplementation(async () => []);

      // "Today" exact substring match — should work as before
      await typeSearchQuery('Today');
      await tick(50);

      const rows = pinnedOnlyRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const titleEl = row.querySelector('.result-title');
        expect(titleEl.textContent).toMatch(/Today/);
      }
    });

    it('T-content-7: Quoted exact match is unaffected by fuzzy matching', async () => {
      populateCache();
      setupMockDirTree();

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Block WASM phases
      mockSearchBatchFn.mockImplementation(async () => []);
      mockSearchNotesFn.mockImplementation(async () => []);
      mockSearchSnapshotsFn.mockImplementation(async () => []);

      // Quoted "Today" should still use word-boundary matching
      await typeSearchQuery('"Today"');
      await tick(50);

      const rows = pinnedOnlyRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const titleEl = row.querySelector('.result-title');
        expect(titleEl.textContent).toMatch(/Today/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Non-blocking enrichment tests
  // ---------------------------------------------------------------------------
  describe('Non-blocking enrichment', () => {
    // Page entities with extra fields (childIds, parentIds, likes) that only
    // appear after enrichment. These simulate the enrichment adding tags to rows.
    // Use the same slug format as makeEntry (url.replace(/[^a-z0-9]/gi, '-').substring(0, 40))
    const PAGE_ENTITIES = {};
    for (let i = 0; i < 20; i++) {
      const url = `https://example.com/today${i}`;
      const slug = url.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
      PAGE_ENTITIES[slug] = {
        slug,
        url,
        title: `Enriched Today ${i}`,
        childIds: ['note:n1'],        // triggers "note" tag
        parentIds: ['list:col-rust'],  // triggers list tag
        likes: 1,                      // triggers "liked" tag
      };
    }

    it('T-enrich-1: showCategory renders rows before enrichment completes', async () => {
      populateCache();

      // Defer all page: readCacheable lookups (enrichment path)
      const enrichDeferred = createDeferred();
      const originalHandler = (msg) => {
        switch (msg.key) {
          case 'manifest:settings': return { success: true, value: TEST_SETTINGS };
          case 'manifest:list-order': return { success: true, value: sessionData['manifest:list-order'] || TEST_LIST_ORDER };
          case 'manifest:name-to-id': return { success: true, value: { timestamp: 0, paths: {} } };
          case 'manifest:orphaned': return { success: true, value: { timestamp: 0, entries: [] } };
          default: {
            if (msg.key in sessionData) return { success: true, value: sessionData[msg.key] };
            for (const list of TEST_LISTS) {
              if (msg.key === 'list:' + list.slug) return { success: true, value: { ...list, pins: TEST_LIST_PINS[list.slug] || [] } };
            }
            return { success: true, value: undefined };
          }
        }
      };
      actionOverrides['readCacheable'] = async (msg) => {
        // Non-page keys resolve immediately
        if (!msg.key.startsWith('page:')) return originalHandler(msg);
        // Page keys wait for enrichDeferred
        await enrichDeferred.promise;
        const slug = msg.key.slice(5);
        const entity = PAGE_ENTITIES[slug];
        return { success: true, value: entity || undefined };
      };

      // Also make session.get miss for page: keys (forces readCacheable fallback)
      for (const key of Object.keys(sessionData)) {
        if (key.startsWith('page:')) delete sessionData[key];
      }

      // Inject category button BEFORE importing so options.js binds its event listener
      const sidebarContent = document.querySelector('.sidebar-content');
      const allBtn = document.createElement('div');
      allBtn.className = 'sidebar-item';
      allBtn.dataset.category = 'all';
      sidebarContent.appendChild(allBtn);

      // Let initialize() complete (renders Explore by default)
      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Click "All History"
      allBtn.click();
      await tick(200);

      // Key assertion: rows should be visible BEFORE enrichment resolves
      const rows = resultRows();
      expect(rows.length).toBeGreaterThan(0);

      // Enrichment tags should NOT be present yet (enrichment still pending)
      const likedTags = document.querySelectorAll('#results .card-tag-liked');
      expect(likedTags.length).toBe(0);

      // Now resolve enrichment
      enrichDeferred.resolve();
      await tick(200);

      // After enrichment, tags should appear on re-rendered rows
      const likedTagsAfter = document.querySelectorAll('#results .card-tag-liked');
      expect(likedTagsAfter.length).toBeGreaterThan(0);
    });

    it('T-enrich-2: onLoadMore appends rows before enrichment completes', async () => {
      populateCache();

      // Create many files so first batch doesn't load them all
      const MANY_FILES = [];
      const MANY_FILE_MAP = {};
      for (let i = 0; i < 20; i++) {
        const d = new Date(Date.UTC(2026, 1, 15 - i));
        const dateStr = d.toISOString().slice(0, 10);
        const filename = dateStr + '.jsonl';
        MANY_FILES.push(filename);
        MANY_FILE_MAP[filename] = makeFileEntries(dateStr, i * 5, 5, `Batch${i}`);
      }
      MANY_FILES.sort().reverse();

      actionOverrides['listHistoryFiles'] = () => ({
        success: true,
        files: MANY_FILES,
        sizes: {},
      });
      actionOverrides['loadHistoryBatch'] = (msg) => {
        const entries = [];
        for (const f of msg.files) {
          if (MANY_FILE_MAP[f]) entries.push(...MANY_FILE_MAP[f]);
        }
        return { success: true, entries };
      };

      // Defer page enrichment
      const enrichDeferred = createDeferred();
      actionOverrides['readCacheable'] = async (msg) => {
        if (!msg.key.startsWith('page:')) {
          // Fall through to default handling for non-page keys
          if (msg.key === 'manifest:settings') return { success: true, value: TEST_SETTINGS };
          if (msg.key === 'manifest:list-order') return { success: true, value: sessionData['manifest:list-order'] || TEST_LIST_ORDER };
          if (msg.key === 'manifest:name-to-id') return { success: true, value: { timestamp: 0, paths: {} } };
          if (msg.key === 'manifest:orphaned') return { success: true, value: { timestamp: 0, entries: [] } };
          if (msg.key in sessionData) return { success: true, value: sessionData[msg.key] };
          for (const list of TEST_LISTS) {
            if (msg.key === 'list:' + list.slug) return { success: true, value: { ...list, pins: TEST_LIST_PINS[list.slug] || [] } };
          }
          return { success: true, value: undefined };
        }
        await enrichDeferred.promise;
        return { success: true, value: undefined };
      };

      // Remove page: keys from session so readCacheable falls back
      for (const key of Object.keys(sessionData)) {
        if (key.startsWith('page:')) delete sessionData[key];
      }

      // Inject category button BEFORE importing so options.js binds its event listener
      const sidebarContent = document.querySelector('.sidebar-content');
      const allBtn = document.createElement('div');
      allBtn.className = 'sidebar-item';
      allBtn.dataset.category = 'all';
      sidebarContent.appendChild(allBtn);

      const importDone = importOptions();
      await importDone;
      await tick(100);

      // Navigate to All History
      allBtn.click();
      await tick(200);

      // Initial batch rows should be visible
      const initialRows = resultRows();
      expect(initialRows.length).toBeGreaterThan(0);
      const initialCount = initialRows.length;

      // Trigger onLoadMore (simulates scroll near end)
      const vs = document.getElementById('results')._virtualScroller;
      expect(vs).toBeDefined();
      expect(vs.onLoadMore).toBeTypeOf('function');
      vs.onLoadMore();
      await tick(200);

      // New rows should be appended WITHOUT waiting for enrichment
      const afterLoadMore = vs.data.length;
      expect(afterLoadMore).toBeGreaterThan(initialCount);

      // Clean up
      enrichDeferred.resolve();
      await tick(100);
    });
  });
});
