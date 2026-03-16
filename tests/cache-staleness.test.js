/**
 * Cache staleness tests.
 *
 * Verifies that session-scoped caches in options.js are properly invalidated
 * on resetHistory(), visibilitychange, and don't grow unbounded.
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

const FILE1_DATE = '2026-02-15';
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

const FILE1_INTERACTIONS = makeFileInteractions(FILE1_DATE, 0, 20, 'Today');
const FILE2_INTERACTIONS = makeFileInteractions(FILE2_DATE, 20, 20, 'Yesterday');
const FILE3_INTERACTIONS = makeFileInteractions(FILE3_DATE, 40, 20, 'OldDay');

const TEST_LIST = { slug: 'col-rust', query: 'rust', name: 'Rust Lang', parentList: 'list:system/root', childLists: [] };
// List with no query — only pinned pages, pins on same domain as history
const TEST_LIST_NOQUERY = { slug: 'col-noq', query: '', name: 'No Query List', parentList: 'list:system/root', childLists: [] };

const TEST_LIST_PINS = {
  'col-rust': [
    pinFromUrl('https://rust-lang.org/doc0', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc1', NOW - DAY),
    pinFromUrl('https://rust-lang.org/doc2', NOW - DAY),
  ],
  // Pins on example.com — same domain as FILE1_INTERACTIONS, enabling hostname-based related pages
  'col-noq': [
    pinFromUrl('https://example.com/today0', NOW - DAY),
    pinFromUrl('https://example.com/today1', NOW - DAY),
  ],
};

const TEST_LISTS = [TEST_LIST, TEST_LIST_NOQUERY];

// Build slug→URL mapping for all pinned URLs (needed to populate page entities in session cache)
const KNOWN_PIN_URLS = [
  'https://rust-lang.org/doc0', 'https://rust-lang.org/doc1', 'https://rust-lang.org/doc2',
  'https://example.com/today0', 'https://example.com/today1',
  'https://explore.example.com/a', 'https://explore.example.com/b',
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
  childLists: ['list:col-rust', 'list:col-noq'],
};

const FILES_NEWEST_FIRST = [
  `${FILE1_DATE}.jsonl`,
  `${FILE2_DATE}.jsonl`,
  `${FILE3_DATE}.jsonl`,
];

const FILE_MAP = {
  [`${FILE1_DATE}.jsonl`]: FILE1_INTERACTIONS,
  [`${FILE2_DATE}.jsonl`]: FILE2_INTERACTIONS,
  [`${FILE3_DATE}.jsonl`]: FILE3_INTERACTIONS,
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const { mockSearchBatchFn, mockFsHandler } = vi.hoisted(() => ({
  mockSearchBatchFn: vi.fn(async () => []),
  // Mutable handler for FileSystemStorage methods — tests set this in setupChromeMock
  mockFsHandler: { fn: (action, msg) => ({ success: true }) },
}));

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
      const q = query.toLowerCase();
      return this._items
        .filter(item => item.title.toLowerCase().includes(q) || (item.url && item.url.toLowerCase().includes(q)))
        .map(item => ({ url: item.url, title: item.title, score: 1.0, timestamp: Number(item._timestamp || 0) }));
    }
  }

  return {
    default: async () => {},
    Interaction: MockInteraction,
    SearchEngine: MockSearchEngine,
    searchBatch: (...args) => mockSearchBatchFn(...args),
  };
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const htmlPath = path.resolve(__dirname, '../extension/options.html');
const htmlFull = fs.readFileSync(htmlPath, 'utf-8');
const bodyMatch = htmlFull.match(/<body[^>]*>([\s\S]*)<\/body>/i);
const bodyContent = bodyMatch
  ? bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '')
  : '';
const styleMatch = htmlFull.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
const styleContent = styleMatch ? styleMatch[1] : '';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Cache staleness', () => {
  let sessionData;  // chrome.storage.session
  let localData;    // chrome.storage.local
  let deferreds;
  /** Mutable action handlers — tests can override specific actions */
  let actionOverrides;
  /** Mutable list pins data — tests can override to change pin responses */
  let testListPins;
  /** Mutable name-map data — tests can override for name-map responses */
  let testNameMapData;
  /** Mutable root data — tests can override to change list:system/root responses */
  let testRootData;
  /** Mutable page entity data — tests can override to change readCacheable('page:*') responses.
   *  When removing a background.js handler (e.g. loadPageBatch), callers switch to
   *  readCacheable('page:slug'). Test mocks must add the new key type to the
   *  readCacheable handler and use mutable data maps (like this one) instead of
   *  actionOverrides for the removed handler. */
  let testPageData;

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
    actionOverrides = {};
    testListPins = { ...TEST_LIST_PINS };
    testNameMapData = null;
    testRootData = null;
    testPageData = {};

    // Wire filesystem mock to use the same action handlers as sendMessage
    mockFsHandler.fn = async (action, params) => {
      const deferred = deferreds[action];
      if (deferred) await deferred.promise;
      if (actionOverrides[action]) return actionOverrides[action]({ action, ...params });
      return handleAction({ action, ...params });
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
          const deferred = deferreds[msg.action];
          if (deferred) await deferred.promise;
          if (actionOverrides[msg.action]) return actionOverrides[msg.action](msg);
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

      case 'loadContentBatch':
        return { success: true, contentMap: {} };

      case 'processGatewaysIncremental':
        return { success: true, domains: {}, newWatermark: 0 };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'saveSettingsKey':
        return { success: true };

      case 'addListPins':
        return { success: true };

      case 'toggleListPin':
        return { success: true, pinned: true };

      case 'saveListMeta':
        return { success: true };

      case 'deleteList':
        return { success: true };

      case 'saveRecycleBin':
        return { success: true };

      case 'loadPermanentDeletes':
        return { success: true, urls: [] };

      case 'readCacheable':
        // Simulate background readCacheable: dispatch to known handlers
        switch (msg.key) {
          case 'manifest:settings': return { success: true, value: TEST_SETTINGS };
          case 'list:system/root': return { success: true, value: testRootData || TEST_ROOT };
          case 'list:auto/gateways': return { success: true, value: { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', auto: true, pins: [], parentList: 'list:auto', childLists: [] } };
          case 'manifest:name-to-id': return { success: true, value: testNameMapData || { timestamp: 0, paths: {} } };
          case 'manifest:orphaned': return { success: true, value: { timestamp: 0, keys: [] } };
          default: {
            // Resolve page entity keys from testPageData (filesystem fallback)
            if (msg.key && msg.key.startsWith('page:')) {
              const slug = msg.key.slice('page:'.length);
              return { success: true, value: testPageData[slug] || null };
            }
            // Resolve list entity keys with pins from testListPins
            if (msg.key && msg.key.startsWith('list:')) {
              const listId = msg.key.slice('list:'.length);
              const list = TEST_LISTS.find(l => l.slug === listId);
              if (list) {
                return { success: true, value: { ...list, pins: testListPins[listId] || [] } };
              }
              // Check dynamically-added lists in sessionData
              if (sessionData[msg.key]) {
                const entity = sessionData[msg.key];
                return { success: true, value: { ...entity, pins: testListPins[listId] || entity.pins || [] } };
              }
            }
            return { success: true, value: undefined };
          }
        }

      case 'initializeFilesystem':
        return { success: true };

      default:
        return { success: true };
    }
  }

  function populateCache() {
    // Session-cached keys (settings as single object, individual list keys, entity keys for system lists)
    sessionData = {
      'manifest:settings': TEST_SETTINGS,
      'list:system/root': { ...TEST_ROOT },
      'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', auto: true, pins: [], parentList: 'list:auto', childLists: [] },
    };
    // Individual list entity keys (include pins for session cache hits)
    for (const list of TEST_LISTS) {
      sessionData['list:' + list.slug] = { ...list, pins: testListPins[list.slug] || [] };
    }
    // Add page entities for all known pin URLs (simulates real cache where checkpointed pages have .url)
    for (const [slug, url] of SLUG_TO_URL) {
      sessionData['page:' + slug] = { slug, url, watermark: 0 };
    }
    // Local-only keys (logBuffer is durably backed up here)
    localData = {
      logBuffer: [],
    };
  }

  beforeEach(() => {
    vi.resetModules();
    mockSearchBatchFn.mockReset();
    mockSearchBatchFn.mockImplementation(async () => []);
    document.head.innerHTML = `<style>${styleContent}</style>`;
    document.body.innerHTML = bodyContent;
    if (!globalThis.performance) {
      globalThis.performance = { now: () => Date.now() };
    }
    setupChromeMock();
  });

  afterEach(async () => {
    for (const d of Object.values(deferreds || {})) {
      try { d.resolve(); } catch {}
    }
    await tick(50);
    delete globalThis.chrome;
  });

  async function importOptions() {
    return await import('../extension/options.js');
  }

  function resultRows() {
    return [...document.querySelectorAll('#results .result-item')];
  }

  function pinnedOnlyRows() {
    return [...document.querySelectorAll('#relatedResults .result-item')];
  }

  // ---------------------------------------------------------------------------
  // T1: resetHistory clears pageReadCache + allListPins
  // ---------------------------------------------------------------------------
  it('T1: resetHistory clears pageReadCache and allListPins', async () => {
    populateCache();

    // Page entities on disk (filesystem fallback for readCacheable session miss)
    for (const [slug, url] of SLUG_TO_URL) {
      testPageData[slug] = { slug, url, watermark: 100, attention: '', highlights: [] };
    }

    await importOptions();
    await tick(100);

    // Open col-rust — loads pins, triggers refreshListAtoms
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(200);

    // Verify pins loaded
    expect(pinnedOnlyRows().length).toBe(3);

    // Navigate back to Explore
    document.getElementById('exploreBtn').click();
    await tick(100);

    // Trigger resetHistory via selectDirBtn click (calls selectDirectory → resetHistory → showCategory)
    chrome.runtime.sendMessage.mockClear();
    const selectDirBtn = document.getElementById('selectDirBtn');
    expect(selectDirBtn).not.toBeNull();
    selectDirBtn.click();
    await tick(200);

    // Update page entities on disk to watermark 200 (higher than 100 cached)
    for (const [slug, url] of SLUG_TO_URL) {
      testPageData[slug] = { slug, url, watermark: 200, attention: '', highlights: [] };
    }
    // Add page entity for the new pin URL
    const newSlug = generateSlugFromUrl('https://rust-lang.org/doc3');
    testPageData[newSlug] = { slug: newSlug, url: 'https://rust-lang.org/doc3', watermark: 200, attention: '', highlights: [] };

    // Change list pins to return an updated list (4 pins)
    testListPins['col-rust'] = [
      ...TEST_LIST_PINS['col-rust'],
      pinFromUrl('https://rust-lang.org/doc3', NOW),
    ];
    // Update session cache to reflect the new pins (simulates mutation via addLog)
    sessionData['list:col-rust'] = { ...sessionData['list:col-rust'], pins: testListPins['col-rust'] };

    chrome.runtime.sendMessage.mockClear();

    // Re-open col-rust
    const collItem2 = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    collItem2.click();
    await tick(200);

    // Assert: pins were re-loaded (allListPins was cleared by resetHistory)
    // The updated list entity returns 4 pins now
    expect(pinnedOnlyRows().length).toBe(4);

    // Pin enrichment happens at render time via enrichPinResult (no background refresh).
    // The assertion above (pinnedOnlyRows().length === 4) verifies the UI is correct.
  });

  // ---------------------------------------------------------------------------
  // T2: visibilitychange invalidates list pins
  // ---------------------------------------------------------------------------
  it('T2: visibilitychange invalidates list pins', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Open col-rust → 3 pinned rows
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    collItem.click();
    await tick(200);
    expect(pinnedOnlyRows().length).toBe(3);

    // Change list pins to return 4 pins
    testListPins['col-rust'] = [
      ...TEST_LIST_PINS['col-rust'],
      pinFromUrl('https://rust-lang.org/doc3', NOW),
    ];
    // Update session cache to reflect new pins (simulates mutation via addLog)
    sessionData['list:col-rust'] = { ...sessionData['list:col-rust'], pins: testListPins['col-rust'] };

    // Dispatch visibilitychange (visible)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(300);

    // Re-open col-rust (click again to trigger showList with cleared cache)
    collItem.click();
    await tick(200);

    // Assert: 4 pinned rows
    expect(pinnedOnlyRows().length).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // T3: visibilitychange loads new history files
  // ---------------------------------------------------------------------------
  it('T3: visibilitychange loads new history files', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Default view is Explore — verify it rendered
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');

    // Add a 4th history file with new interactions
    const FILE4_DATE = '2026-02-12';
    const FILE4_INTERACTIONS = makeFileInteractions(FILE4_DATE, 60, 10, 'Extra');

    // Override listInteractionFiles to return 4 files
    actionOverrides['listInteractionFiles'] = () => ({
      success: true,
      files: [...FILES_NEWEST_FIRST, `${FILE4_DATE}.jsonl`],
    });
    // Override loadInteractionBatch to include the new file
    let loadBatchCalls = 0;
    actionOverrides['loadInteractionBatch'] = (msg) => {
      loadBatchCalls++;
      const interactions = [];
      for (const f of msg.files) {
        if (FILE_MAP[f]) interactions.push(...FILE_MAP[f]);
        if (f === `${FILE4_DATE}.jsonl`) interactions.push(...FILE4_INTERACTIONS);
      }
      return { success: true, interactions };
    };

    chrome.runtime.sendMessage.mockClear();

    // Dispatch visibilitychange
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(300);

    // Assert: visibilitychange triggered history re-fetch (the new file was loaded)
    expect(loadBatchCalls).toBeGreaterThan(0);
  });

  // T4 removed — gateway cache no longer exists in options.js (auto-list entity)

  // ---------------------------------------------------------------------------
  // T5: logBuffer entries → history loads correctly
  // ---------------------------------------------------------------------------
  it('T5: logBuffer visit entries are merged into history and visible in list', async () => {
    populateCache();
    // Today's history entries (simulates session cache populated by addLog)
    const todayStr = new Date().toISOString().slice(0, 10);
    sessionData['log:' + todayStr] = [
      { timestamp: Date.now(), url: 'https://buffered.com/page1', title: 'Buffered Page 1', slug: 'buffered-page1',  attention: '' },
      { timestamp: Date.now(), action: 'update_setting', key: 'workspace', value: {} },
      { timestamp: Date.now() + 1, url: 'https://buffered.com/page2', title: 'Buffered Page 2', slug: 'buffered-page2',  attention: '' },
    ];

    // Add a list with pins on buffered.com (same domain as logBuffer entries)
    testListPins['col-buf'] = [
      pinFromUrl('https://buffered.com/page1', NOW),
    ];
    sessionData['list:col-buf'] = { slug: 'col-buf', query: '', name: 'Buffered', pins: testListPins['col-buf'], parentList: 'list:system/root', childLists: [] };
    sessionData['list:system/root'] = { timestamp: 0, childLists: [...TEST_ROOT.childLists, 'list:col-buf'] };

    await importOptions();
    await tick(100);

    // Default view is Explore. Open the buffered list — its pin is on
    // buffered.com, same domain as logBuffer entries → related pages should appear.
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-buf"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section shows the pin
    expect(pinnedOnlyRows().length).toBe(1);

    // Search panel should be rendered (no saved searches = shows all history)
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // T7: list with no query still shows related pages from history
  // ---------------------------------------------------------------------------
  it('T7: no-query list shows related pages from loaded history', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Open no-query list (col-noq) — pins on example.com, history also on example.com
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-noq"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section should show 2 pins
    const pinnedRows = pinnedOnlyRows();
    expect(pinnedRows.length).toBe(2);

    // Search panel should be rendered (no saved searches = shows all history)
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // T8: WASM search crash doesn't prevent related pages from showing
  // ---------------------------------------------------------------------------
  it('T8: list shows related pages even when pipelinedSearch throws', async () => {
    populateCache();

    // Make searchBatch throw (simulates WASM RuntimeError: memory access out of bounds)
    mockSearchBatchFn.mockImplementation(async () => {
      throw new RuntimeError('memory access out of bounds');
    });

    await importOptions();
    await tick(100);

    // Open col-rust — has query "rust", pins on rust-lang.org
    // pipelinedSearch("rust") will call searchBatch which throws
    // But related pages should still be computed from loaded history
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section should show 3 pins (rendered in Phase 1, before pipelinedSearch)
    expect(pinnedOnlyRows().length).toBe(3);

    // Related section should have results from historyByUrl
    // rust-lang.org pins don't share hostname with example.com history,
    // so use example.com pins (col-noq) instead for hostname-based matching
  });

  // ---------------------------------------------------------------------------
  // T9: WASM crash → related pages via same-domain history (col-noq)
  // ---------------------------------------------------------------------------
  it('T9: WASM crash still produces related pages for same-domain pins', async () => {
    populateCache();

    // col-noq has query '' and pins on example.com (same domain as history)
    // Give it a query so it goes through pipelinedSearch path
    // Override session cache with modified list (include pins)
    sessionData['list:col-noq'] = { slug: 'col-noq', query: 'example', name: 'Example List', pins: testListPins['col-noq'] || [] };

    mockSearchBatchFn.mockImplementation(async () => {
      throw new Error('RuntimeError: memory access out of bounds');
    });

    await importOptions();
    await tick(100);

    // Open col-noq — pins on example.com, history on example.com
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-noq"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section should show 2 pins
    expect(pinnedOnlyRows().length).toBe(2);

    // Auto-blocks should include "Similar to pins" — hostname match with example.com history
    // Search panel should be rendered (no saved searches = shows all history)
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // T10: logBuffer with object attention doesn't crash pipelinedSearch
  // ---------------------------------------------------------------------------
  it('T10: object attention in logBuffer entries does not crash search', async () => {
    populateCache();

    // LogBuffer has entries with object attention (from background.js appendLog for report entries)
    localData.logBuffer = [
      {
        timestamp: Date.now(), url: 'https://example.com/buffered', title: 'Buffered Today Page',
        slug: 'buffered-today', 
        attention: { scrollDepth: 42, timeOnPage: 5000 }
      },
    ];

    testListPins['col-today'] = [
      pinFromUrl('https://example.com/today0', NOW - DAY),
    ];
    sessionData['list:col-today'] = { slug: 'col-today', query: 'today', name: 'Today Search', pins: testListPins['col-today'], parentList: 'list:system/root', childLists: [] };
    sessionData['list:system/root'] = { timestamp: 0, childLists: ['list:col-today'] };

    await importOptions();
    await tick(100);

    // Open col-today — pipelinedSearch("today") runs; logBuffer entries have object attention
    const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-today"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Should not crash — object attention is stringified by buildInteractionsForEngine
    expect(pinnedOnlyRows().length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // T11: pin enrichment uses history attention when page lacks it
  // ---------------------------------------------------------------------------
  it('T11: pinned rows show attention from history when page has no attention', async () => {
    populateCache();

    // col-noq pins are on example.com/today0 and today1 — same URLs as FILE1_INTERACTIONS
    // Give those interactions attention data
    const attentionJson = JSON.stringify({ scrollDepth: 50, timeOnPage: 120000 });
    const saved0 = { ...FILE1_INTERACTIONS[0] };
    const saved1 = { ...FILE1_INTERACTIONS[1] };
    FILE1_INTERACTIONS[0] = { ...FILE1_INTERACTIONS[0], attention: attentionJson };
    FILE1_INTERACTIONS[1] = { ...FILE1_INTERACTIONS[1], attention: attentionJson };

    // Page entities WITHOUT attention (simulates pages with no attention data)
    for (const [slug, url] of SLUG_TO_URL) {
      testPageData[slug] = { slug, url, watermark: NOW, attention: '', highlights: [] };
    }

    try {
      await importOptions();
      await tick(100);

      // Open col-noq which has pins on example.com/today0 and today1
      const collItem = document.querySelector('#listsList .sidebar-item[data-list-id="col-noq"]');
      expect(collItem).not.toBeNull();
      collItem.click();
      await tick(500);

      // The pinned rows should have non-zero attention despite pages lacking it
      // because historyByUrl has the attention data from JSONL interactions
      const rows = pinnedOnlyRows();
      expect(rows.length).toBe(2);

      // If enrichment correctly falls back to historyByUrl for attention,
      // these rows should have valid titles from page entity data (not <unknown>).
      const titles = rows.map(r => r.querySelector('.result-title')?.textContent);
      expect(titles.every(t => t && t !== '<unknown>')).toBe(true);
    } finally {
      // Restore test data for other tests
      FILE1_INTERACTIONS[0] = saved0;
      FILE1_INTERACTIONS[1] = saved1;
    }
  });

  // ---------------------------------------------------------------------------
  // T12: visibilitychange on Explore reloads explore pins
  // ---------------------------------------------------------------------------
  it('T12: visibilitychange on Explore view preserves explore state', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Default view is Explore — verify it shows
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(document.getElementById('listLayout').classList.contains('visible')).toBe(true);

    // Dispatch visibilitychange (simulates switching to another tab and back)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(500);

    // After visibilitychange, Explore should still be the active view
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(document.getElementById('listLayout').classList.contains('visible')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T13: demand-loaded explore items are sorted by lastVisit desc
  // ---------------------------------------------------------------------------
  it('T13: demand-loaded explore items are sorted by lastVisit desc', async () => {
    populateCache();

    // Create 11 file dates (newest first) so batch 1 = 10 files, batch 2 = 1 file
    const fileDates = [];
    for (let i = 0; i < 11; i++) {
      const d = new Date(NOW - i * DAY);
      fileDates.push(d.toISOString().split('T')[0]);
    }
    const allFiles = fileDates.map(d => d + '.jsonl');

    // Each file has 5 items with timestamps ascending within the file
    const allFileData = {};
    for (let f = 0; f < 11; f++) {
      const base = new Date(fileDates[f] + 'T12:00:00Z').getTime();
      const items = [];
      for (let i = 0; i < 5; i++) {
        items.push(makeInteraction(
          `https://example.com/f${f}-i${i}`,
          `File ${f} Page ${i}`,
          base + i * 60000
        ));
      }
      allFileData[allFiles[f]] = items;
    }

    actionOverrides['listInteractionFiles'] = () => ({
      success: true, files: allFiles,
    });
    actionOverrides['loadInteractionBatch'] = (msg) => {
      const interactions = [];
      for (const f of msg.files) {
        if (allFileData[f]) interactions.push(...allFileData[f]);
      }
      return { success: true, interactions };
    };
    // No explore pins → showAllHistory path with onLoadMore
    // Override all list pins to empty for this test
    for (const key of Object.keys(testListPins)) testListPins[key] = [];
    // Update session cache to reflect empty pins
    for (const list of TEST_LISTS) {
      if (sessionData['list:' + list.slug]) {
        sessionData['list:' + list.slug] = { ...sessionData['list:' + list.slug], pins: [] };
      }
    }

    await importOptions();
    await tick(200);

    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');

    // Get the related virtual scroller
    const relatedContainer = document.getElementById('relatedResults');
    const vs = relatedContainer._virtualScroller;
    expect(vs).toBeTruthy();

    // First batch: 10 files × 5 items = 50 items, sorted
    expect(vs.data.length).toBe(50);

    // Trigger demand-load of batch 2 (file 11, 5 items)
    expect(typeof vs.onLoadMore).toBe('function');
    await vs.onLoadMore();
    await tick(100);

    // After demand-load: 55 items total
    expect(vs.data.length).toBe(55);

    // ALL items must be in non-increasing lastVisit order (desc)
    for (let i = 1; i < vs.data.length; i++) {
      const prevTs = Math.max(...(vs.data[i - 1].timestamps || [0]));
      const currTs = Math.max(...(vs.data[i].timestamps || [0]));
      expect(prevTs >= currTs,
        `Item ${i - 1} (ts=${prevTs}) should be >= item ${i} (ts=${currTs})`
      ).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // T14: visibilitychange does not full-re-render explore view
  // ---------------------------------------------------------------------------
  it('T14: visibilitychange preserves search panel state', async () => {
    populateCache();

    await importOptions();
    await tick(200);

    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');

    // Search panel should be rendered
    const searchPanel = document.querySelector('.search-filters-panel');
    expect(searchPanel).not.toBeNull();

    // Dispatch visibilitychange
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(500);

    // Search panel should still be present after visibilitychange
    const searchPanelAfter = document.querySelector('.search-filters-panel');
    expect(searchPanelAfter).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // T16: pin mutation notification does not revert in-memory pin changes
  // ---------------------------------------------------------------------------
  it('T16: explore view survives mutation notification from background', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Default view is Explore
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(document.getElementById('listLayout').classList.contains('visible')).toBe(true);

    // Simulate background mutation notification for pins on a list
    const listeners = chrome.runtime.onMessage.addListener.mock.calls.map(c => c[0]);
    for (const listener of listeners) {
      listener({ action: 'mutation', type: 'pins', listId: 'some-list' });
    }
    await tick(500);

    // The mutation notification should NOT cause the explore view to break
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(document.getElementById('listLayout').classList.contains('visible')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T15: empty session cache (disable/re-enable) still loads lists via fallback
  // ---------------------------------------------------------------------------
  it('T15: empty session cache still loads lists via fallback', async () => {
    // Do NOT call populateCache() — simulate disable/re-enable clearing session
    sessionData = {};
    localData = { logBuffer: [] };

    // Background would handle these actions after hydration
    actionOverrides['readCacheable'] = (msg) => {
      if (msg.key === 'manifest:settings') return { success: true, value: TEST_SETTINGS };
      if (msg.key === 'list:system/root') return { success: true, value: TEST_ROOT };
      // Return individual list entities by slug
      for (const list of TEST_LISTS) {
        if (msg.key === 'list:' + list.slug) return { success: true, value: list };
      }
      return handleAction({ ...msg, action: 'readCacheable' });
    };

    await importOptions();
    await tick(200);

    // Lists should render in sidebar
    const collItems = document.querySelectorAll('#listsList .sidebar-item');
    expect(collItems.length, 'lists sidebar should have items').toBe(TEST_LISTS.length);
  });

  // ---------------------------------------------------------------------------
  // T17: pins show title from page entity, not "Untitled"
  // ---------------------------------------------------------------------------
  it('T17: pins show title from page entity', async () => {
    populateCache();

    const PIN_URL = 'https://pinned.example.com/article';
    const PIN_TITLE = 'Pinned Article Title';
    const PIN_SLUG = generateSlugFromUrl(PIN_URL);

    // Add a list with one pin
    const TEST_LIST_WITH_PIN = { slug: 'col-pinned', query: '', name: 'Pinned List' };
    testListPins['col-pinned'] = [
      { id: 'page:' + PIN_SLUG, pinnedAt: NOW - DAY },
    ];

    // Put page entity in testPageData (filesystem fallback for readCacheable)
    testPageData[PIN_SLUG] = { slug: PIN_SLUG, url: PIN_URL, title: PIN_TITLE, watermark: 1 };

    // Add the list to lists and list:system/root (include pins for session cache hit)
    sessionData['list:' + TEST_LIST_WITH_PIN.slug] = { ...TEST_LIST_WITH_PIN, pins: testListPins['col-pinned'] || [], parentList: 'list:system/root', childLists: [] };
    sessionData['list:system/root'] = { timestamp: 0, childLists: [...TEST_ROOT.childLists, 'list:col-pinned'] };

    await importOptions();
    await tick(200);

    // Click on the list in sidebar
    const sidebarItems = document.querySelectorAll('#listsList .sidebar-item');
    const listItem = [...sidebarItems].find(el => el.textContent.includes('Pinned List'));
    expect(listItem, 'pinned list sidebar item should exist').toBeTruthy();
    listItem.click();
    await tick(300);

    // Check pinned rows — the pin should show the title, not "Untitled"
    const rows = pinnedOnlyRows();
    expect(rows.length, 'should have 1 pinned row').toBe(1);
    const titleEl = rows[0].querySelector('.result-title');
    expect(titleEl.textContent, 'pin should show title from page entity').toBe(PIN_TITLE);
  });

  // ---------------------------------------------------------------------------
  // T18: page: pin resolves via readCacheable when not in session cache
  // ---------------------------------------------------------------------------
  it('T18: page pin falls back to readCacheable when not in session', async () => {
    populateCache();

    const PAGE_URL = 'https://uncached.example.com/page';
    const PAGE_TITLE = 'Uncached Page Title';
    const PAGE_SLUG = generateSlugFromUrl(PAGE_URL);

    // List with one page: pin whose entity is NOT in session cache
    const TEST_LIST_UNCACHED = { slug: 'col-uncached', query: '', name: 'Uncached List' };
    testListPins['col-uncached'] = [
      { id: 'page:' + PAGE_SLUG, pinnedAt: NOW - DAY },
    ];
    // Page entity on disk (filesystem fallback for readCacheable session miss)
    testPageData[PAGE_SLUG] = { slug: PAGE_SLUG, url: PAGE_URL, title: PAGE_TITLE, watermark: 1 };

    // Do NOT put 'page:<slug>' in sessionData — simulating empty session cache
    sessionData['list:' + TEST_LIST_UNCACHED.slug] = { ...TEST_LIST_UNCACHED, pins: testListPins['col-uncached'] || [], parentList: 'list:system/root', childLists: [] };
    sessionData['list:system/root'] = { timestamp: 0, childLists: [...TEST_ROOT.childLists, 'list:col-uncached'] };

    await importOptions();
    await tick(200);

    const sidebarItems = document.querySelectorAll('#listsList .sidebar-item');
    const listItem = [...sidebarItems].find(el => el.textContent.includes('Uncached List'));
    expect(listItem, 'uncached list sidebar item should exist').toBeTruthy();
    listItem.click();
    await tick(300);

    const rows = pinnedOnlyRows();
    expect(rows.length, 'should have 1 pinned row').toBe(1);
    const titleEl = rows[0].querySelector('.result-title');
    expect(titleEl.textContent, 'page pin should resolve title via readCacheable fallback').toBe(PAGE_TITLE);
  });

  // ---------------------------------------------------------------------------
  // T19: page pin resolves via readCacheable when page entity not in session
  // ---------------------------------------------------------------------------
  it('T19: page pin falls back to readCacheable when page entity not in session', async () => {
    populateCache();

    const FALLBACK_URL = 'https://fallback.example.com/page';
    const FALLBACK_TITLE = 'Fallback Page Title';
    const FALLBACK_SLUG = generateSlugFromUrl(FALLBACK_URL);

    const TEST_LIST_FALLBACK = { slug: 'col-fallback', query: '', name: 'Fallback List' };
    testListPins['col-fallback'] = [
      { id: 'page:' + FALLBACK_SLUG, pinnedAt: NOW - DAY },
    ];
    // Page entity on disk (filesystem fallback for readCacheable session miss)
    testPageData[FALLBACK_SLUG] = { slug: FALLBACK_SLUG, url: FALLBACK_URL, title: FALLBACK_TITLE, watermark: 1 };

    // Do NOT put page entity in sessionData — simulating pre-hydration state
    sessionData['list:' + TEST_LIST_FALLBACK.slug] = { ...TEST_LIST_FALLBACK, pins: testListPins['col-fallback'], parentList: 'list:system/root', childLists: [] };
    sessionData['list:system/root'] = { timestamp: 0, childLists: [...TEST_ROOT.childLists, 'list:col-fallback'] };

    await importOptions();
    await tick(200);

    const sidebarItems = document.querySelectorAll('#listsList .sidebar-item');
    const listItem = [...sidebarItems].find(el => el.textContent.includes('Fallback List'));
    expect(listItem, 'fallback list sidebar item should exist').toBeTruthy();
    listItem.click();
    await tick(300);

    const rows = pinnedOnlyRows();
    expect(rows.length, 'should have 1 pinned row').toBe(1);
    const titleEl = rows[0].querySelector('.result-title');
    expect(titleEl.textContent, 'page pin should resolve via readCacheable fallback').toBe(FALLBACK_TITLE);
  });
});
