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

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
function makeInteraction(url, title, timestamp, opts = {}) {
  const slug = url.replace(/[^a-z0-9]/gi, '-').substring(0, 40);
  return { id: `${timestamp}-${slug}`, url, title, timestamp, slug, intent: opts.intent || '', attention: opts.attention || '' };
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

const TEST_COLLECTION = { id: 'col-rust', query: 'rust', name: 'Rust Lang' };
// Collection with no query — only pinned pages, pins on same domain as history
const TEST_COLLECTION_NOQUERY = { id: 'col-noq', query: '', name: 'No Query Collection' };

const TEST_COLLECTION_PINS = {
  'col-rust': [
    { url: 'https://rust-lang.org/doc0', title: 'Rust Documentation 0', pinnedAt: NOW - DAY },
    { url: 'https://rust-lang.org/doc1', title: 'Rust Documentation 1', pinnedAt: NOW - DAY },
    { url: 'https://rust-lang.org/doc2', title: 'Rust Documentation 2', pinnedAt: NOW - DAY },
  ],
  // Pins on example.com — same domain as FILE1_INTERACTIONS, enabling hostname-based related pages
  'col-noq': [
    { url: 'https://example.com/today0', title: 'Today Page 0', pinnedAt: NOW - DAY },
    { url: 'https://example.com/today1', title: 'Today Page 1', pinnedAt: NOW - DAY },
  ],
  // Explore pins — used by T12
  'explore': [
    { url: 'https://explore.example.com/a', title: 'Explore Pin A', pinnedAt: NOW - DAY },
    { url: 'https://explore.example.com/b', title: 'Explore Pin B', pinnedAt: NOW - DAY },
  ],
};

const TEST_COLLECTIONS = [TEST_COLLECTION, TEST_COLLECTION_NOQUERY];

const TEST_SETTINGS = {
  collectionOrder: ['col-rust', 'col-noq'],
  settings: { captureContent: true, captureAttention: true, archiveQuality: 'medium' },
  urlBlacklist: [],
  titleTrimRules: [],
  permanentDeletes: [],
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
    async loadCollectionPins() { return (await mockFsHandler.fn('loadCollectionPins', {})).pins || {}; }
    async loadCollectionPinsById(id) { return (await mockFsHandler.fn('loadCollectionPinsById', { collectionId: id })).pins || []; }
    async loadPermanentDeletes() { return (await mockFsHandler.fn('loadPermanentDeletes', {})).urls || []; }
    async loadHighlights() { return []; }
    async loadAllHighlights() { return {}; }
    async loadAtomBatch(slugs) { return (await mockFsHandler.fn('loadAtomBatch', { slugs })).atoms || {}; }
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
        if (msg.collectionId) {
          return { success: true, pins: TEST_COLLECTION_PINS[msg.collectionId] || [] };
        }
        return { success: true, pins: TEST_COLLECTION_PINS };

      case 'loadCollectionPinsById':
        return { success: true, pins: TEST_COLLECTION_PINS[msg.collectionId] || [] };

      case 'loadContentBatch':
        return { success: true, contentMap: {} };

      case 'loadGateways':
        return { success: true, watermark: 0, domains: {} };

      case 'processGatewaysIncremental':
        return { success: true, domains: {}, newWatermark: 0 };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'loadAtomBatch':
        return { success: true, atoms: {} };

      case 'saveSettingsKey':
        return { success: true };

      case 'saveCollectionPinsById':
        return { success: true };

      case 'saveCollectionMeta':
        return { success: true };

      case 'deleteCollection':
        return { success: true };

      case 'saveRecycleBin':
        return { success: true };

      case 'loadPermanentDeletes':
        return { success: true, urls: [] };

      case 'initializeFilesystem':
        return { success: true };

      default:
        return { success: true };
    }
  }

  function populateCache() {
    // Session-cached keys (settings, workspace, collections, etc.)
    sessionData = {
      settings: TEST_SETTINGS.settings,
      collections: TEST_COLLECTIONS,
      collectionOrder: TEST_SETTINGS.collectionOrder,
      urlBlacklist: TEST_SETTINGS.urlBlacklist,
      titleTrimRules: TEST_SETTINGS.titleTrimRules,
      recycleBin: [],
      permanentDeletes: TEST_SETTINGS.permanentDeletes,
      gatewayDomains: {},
    };
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
    return [...document.querySelectorAll('#pinnedResults .result-item:not(.related-result)')];
  }

  // ---------------------------------------------------------------------------
  // T1: resetHistory clears atomReadCache + allCollectionPins
  // ---------------------------------------------------------------------------
  it('T1: resetHistory clears atomReadCache and allCollectionPins', async () => {
    populateCache();

    // loadAtomBatch returns atoms with watermark 100 initially
    actionOverrides['loadAtomBatch'] = (msg) => {
      const atoms = {};
      for (const slug of (msg.slugs || [])) {
        atoms[slug] = { watermark: 100, attention: '', highlights: [] };
      }
      return { success: true, atoms };
    };

    await importOptions();
    await tick(100);

    // Open col-rust — loads pins, triggers refreshCollectionAtoms
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
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

    // Now change loadAtomBatch to return watermark 200 (higher than 100 cached)
    actionOverrides['loadAtomBatch'] = (msg) => {
      const atoms = {};
      for (const slug of (msg.slugs || [])) {
        atoms[slug] = { watermark: 200, attention: '', highlights: [] };
      }
      return { success: true, atoms };
    };

    // Change loadCollectionPins to return an updated list (4 pins)
    actionOverrides['loadCollectionPinsById'] = actionOverrides['loadCollectionPins'] = (msg) => {
      if (msg.collectionId === 'col-rust') {
        return { success: true, pins: [
          ...TEST_COLLECTION_PINS['col-rust'],
          { url: 'https://rust-lang.org/doc3', title: 'Rust Documentation 3', pinnedAt: NOW },
        ]};
      }
      return { success: true, pins: [] };
    };

    chrome.runtime.sendMessage.mockClear();

    // Re-open col-rust
    const collItem2 = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
    collItem2.click();
    await tick(200);

    // Assert: pins were re-loaded (allCollectionPins was cleared by resetHistory)
    // The updated loadCollectionPins returns 4 pins now
    expect(pinnedOnlyRows().length).toBe(4);

    // Assert: saveCollectionPinsById was called (fresh atoms with watermark 200 > pin watermark 0)
    const saveCalls = chrome.runtime.sendMessage.mock.calls
      .filter(c => c[0].action === 'saveCollectionPinsById');
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // T2: visibilitychange invalidates collection pins
  // ---------------------------------------------------------------------------
  it('T2: visibilitychange invalidates collection pins', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Open col-rust → 3 pinned rows
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
    collItem.click();
    await tick(200);
    expect(pinnedOnlyRows().length).toBe(3);

    // Change loadCollectionPins to return 4 pins
    actionOverrides['loadCollectionPinsById'] = actionOverrides['loadCollectionPins'] = (msg) => {
      if (msg.collectionId === 'col-rust') {
        return { success: true, pins: [
          ...TEST_COLLECTION_PINS['col-rust'],
          { url: 'https://rust-lang.org/doc3', title: 'Rust Documentation 3', pinnedAt: NOW },
        ]};
      }
      return { success: true, pins: [] };
    };

    // Dispatch visibilitychange (visible)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(300);

    // Re-open col-rust (click again to trigger showCollection with cleared cache)
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

  // ---------------------------------------------------------------------------
  // T4: resetHistory clears gateway cache
  // ---------------------------------------------------------------------------
  it('T4: resetHistory clears gateway cache', async () => {
    populateCache();
    sessionData.gatewayDomains = {
      'https://docs.rs': { rootUrl: 'https://docs.rs', childCount: 5, fetched: true },
    };

    await importOptions();
    await tick(100);

    // initialize() calls loadGatewayDomains → sets gatewayDomainsLoaded = true
    const initialGwCalls = chrome.storage.session.get.mock.calls
      .filter(c => c[0] && (c[0].includes?.('gatewayDomains') || c[0][0] === 'gatewayDomains'));
    expect(initialGwCalls.length).toBeGreaterThanOrEqual(1);

    // Trigger resetHistory via selectDirBtn (selectDirectory → resetHistory → showCategory)
    chrome.storage.local.get.mockClear();
    const selectDirBtn = document.getElementById('selectDirBtn');
    expect(selectDirBtn).not.toBeNull();
    selectDirBtn.click();
    await tick(200);

    // resetHistory clears all caches atomically. Verify historyFiles was cleared
    // by checking initHistoryFiles re-ran (reads logBuffer from storage.local).
    // Since all caches are cleared in the same function, this proves
    // gatewayDomainsLoaded was also reset.
    const logBufferCalls = chrome.storage.local.get.mock.calls
      .filter(c => {
        const keys = c[0];
        if (Array.isArray(keys)) return keys.includes('logBuffer');
        return keys === 'logBuffer';
      });
    expect(logBufferCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // T5: logBuffer entries → history loads correctly
  // ---------------------------------------------------------------------------
  it('T5: logBuffer visit entries are merged into history and visible in collection', async () => {
    populateCache();
    // Put visit entries (no action) + mutation entries in logBuffer
    localData.logBuffer = [
      { timestamp: Date.now(), url: 'https://buffered.com/page1', title: 'Buffered Page 1', slug: 'buffered-page1',  attention: '' },
      { timestamp: Date.now(), action: 'set', key: 'workspace', value: {} },
      { timestamp: Date.now() + 1, url: 'https://buffered.com/page2', title: 'Buffered Page 2', slug: 'buffered-page2',  attention: '' },
    ];

    // Add a collection with pins on buffered.com (same domain as logBuffer entries)
    sessionData.collections = [
      ...TEST_COLLECTIONS,
      { id: 'col-buf', query: '', name: 'Buffered' },
    ];
    actionOverrides['loadCollectionPinsById'] = (msg) => {
      if (msg.collectionId === 'col-buf') {
        return { success: true, pins: [
          { url: 'https://buffered.com/page1', title: 'Buffered Page 1', pinnedAt: NOW },
        ]};
      }
      return { success: true, pins: TEST_COLLECTION_PINS[msg.collectionId] || [] };
    };

    await importOptions();
    await tick(100);

    // Default view is Explore. Open the buffered collection — its pin is on
    // buffered.com, same domain as logBuffer entries → related pages should appear.
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-buf"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section shows the pin
    expect(pinnedOnlyRows().length).toBe(1);

    // Auto-blocks should include "Similar to pins" — the second buffered entry
    // shares hostname (buffered.com) with the pin, so findRelatedPages finds it
    const blockEls = document.querySelectorAll('.explore-block');
    const blockLabels = [...blockEls].map(el => el.textContent.trim());
    expect(blockLabels.some(l => l.includes('Similar to pins'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T6: logBuffer with mutation entries doesn't break recycle bin count
  // ---------------------------------------------------------------------------
  it('T6: recycle bin count renders with logBuffer mutation entries', async () => {
    populateCache();
    // Add some recycled items to session cache
    sessionData.recycleBin = [
      { url: 'https://deleted.com', title: 'Deleted', deletedAt: Date.now() },
      { url: 'https://alsogone.com', title: 'Also Gone', deletedAt: Date.now() },
    ];
    // Put mutation entries (non-visit) in logBuffer
    localData.logBuffer = [
      { timestamp: Date.now(), action: 'set', key: 'workspace', value: {} },
      { timestamp: Date.now(), action: 'highlight', slug: 'x', highlight: { text: 'hi' } },
    ];

    await importOptions();
    await tick(100);

    // Recycle bin sidebar count should show "2"
    const countEl = document.getElementById('recycleSidebarCount');
    expect(countEl).not.toBeNull();
    expect(countEl.textContent).toBe('2');
  });

  // ---------------------------------------------------------------------------
  // T7: collection with no query still shows related pages from history
  // ---------------------------------------------------------------------------
  it('T7: no-query collection shows related pages from loaded history', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Open no-query collection (col-noq) — pins on example.com, history also on example.com
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-noq"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section should show 2 pins
    const pinnedRows = pinnedOnlyRows();
    expect(pinnedRows.length).toBe(2);

    // Auto-blocks should include "Similar to pins" — example.com pins match history
    const blockEls = document.querySelectorAll('.explore-block');
    const blockLabels = [...blockEls].map(el => el.textContent.trim());
    expect(blockLabels.some(l => l.includes('Similar to pins'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T8: WASM search crash doesn't prevent related pages from showing
  // ---------------------------------------------------------------------------
  it('T8: collection shows related pages even when pipelinedSearch throws', async () => {
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
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-rust"]');
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
    // Override session cache with modified collection
    sessionData.collections = [
      TEST_COLLECTION,
      { id: 'col-noq', query: 'example', name: 'Example Collection' },
    ];

    mockSearchBatchFn.mockImplementation(async () => {
      throw new Error('RuntimeError: memory access out of bounds');
    });

    await importOptions();
    await tick(100);

    // Open col-noq — pins on example.com, history on example.com
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-noq"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Pinned section should show 2 pins
    expect(pinnedOnlyRows().length).toBe(2);

    // Auto-blocks should include "Similar to pins" — hostname match with example.com history
    const blockEls = document.querySelectorAll('.explore-block');
    const blockLabels = [...blockEls].map(el => el.textContent.trim());
    expect(blockLabels.some(l => l.includes('Similar to pins'))).toBe(true);
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

    sessionData.collections = [
      { id: 'col-today', query: 'today', name: 'Today Search' },
    ];
    actionOverrides['loadCollectionPinsById'] = actionOverrides['loadCollectionPins'] = (msg) => {
      if (msg.collectionId === 'col-today') {
        return { success: true, pins: [
          { url: 'https://example.com/today0', title: 'Today Page 0', pinnedAt: NOW - DAY },
        ]};
      }
      return { success: true, pins: [] };
    };

    await importOptions();
    await tick(100);

    // Open col-today — pipelinedSearch("today") runs; logBuffer entries have object attention
    const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-today"]');
    expect(collItem).not.toBeNull();
    collItem.click();
    await tick(300);

    // Should not crash — object attention is stringified by buildInteractionsForEngine
    expect(pinnedOnlyRows().length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // T11: pin enrichment uses history attention when atom lacks it
  // ---------------------------------------------------------------------------
  it('T11: pinned rows show attention from history when atom has no attention', async () => {
    populateCache();

    // col-noq pins are on example.com/today0 and today1 — same URLs as FILE1_INTERACTIONS
    // Give those interactions attention data
    const attentionJson = JSON.stringify({ scrollDepth: 50, timeOnPage: 120000 });
    const saved0 = { ...FILE1_INTERACTIONS[0] };
    const saved1 = { ...FILE1_INTERACTIONS[1] };
    FILE1_INTERACTIONS[0] = { ...FILE1_INTERACTIONS[0], attention: attentionJson };
    FILE1_INTERACTIONS[1] = { ...FILE1_INTERACTIONS[1], attention: attentionJson };

    // loadAtomBatch returns atoms WITHOUT attention (simulates old-format atoms)
    actionOverrides['loadAtomBatch'] = (msg) => {
      const atoms = {};
      for (const slug of (msg.slugs || [])) {
        atoms[slug] = { watermark: NOW, attention: '', highlights: [] };
      }
      return { success: true, atoms };
    };

    try {
      await importOptions();
      await tick(100);

      // Open col-noq which has pins on example.com/today0 and today1
      const collItem = document.querySelector('#collectionsList .sidebar-item[data-collection-id="col-noq"]');
      expect(collItem).not.toBeNull();
      collItem.click();
      await tick(500);

      // The pinned rows should have non-zero attention despite atoms lacking it
      // because historyByUrl has the attention data from JSONL interactions
      const rows = pinnedOnlyRows();
      expect(rows.length).toBe(2);

      // buildDetailHtml only creates .detail-metrics when attDetail is non-null.
      // If enrichment correctly falls back to historyByUrl for attention,
      // these rows should have .detail-metrics with "2m on page", "50% scrolled", "5 clicks".
      const metricsEls = rows.map(r => r.querySelector('.detail-metrics'));
      const hasMetrics = metricsEls.some(el => el !== null);
      expect(hasMetrics).toBe(true);
    } finally {
      // Restore test data for other tests
      FILE1_INTERACTIONS[0] = saved0;
      FILE1_INTERACTIONS[1] = saved1;
    }
  });

  // ---------------------------------------------------------------------------
  // T12: visibilitychange on Explore reloads explore pins
  // ---------------------------------------------------------------------------
  it('T12: visibilitychange on Explore view reloads explore pins', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Default view is Explore — verify pinned section is visible with 2 explore pins
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    const pinnedSection = document.querySelector('.collection-section[data-section="pinned"]');
    expect(pinnedSection.style.display).not.toBe('none');
    expect(pinnedOnlyRows().length).toBe(2);

    // Dispatch visibilitychange (simulates switching to another tab and back)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(500);

    // After visibilitychange, Explore should still show its pinned section with 2 rows
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(pinnedSection.style.display, 'pinned section should be visible').not.toBe('none');
    expect(pinnedOnlyRows().length).toBe(2);
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
    actionOverrides['loadCollectionPinsById'] = () => ({ success: true, pins: [] });

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
  it('T14: visibilitychange preserves explore block state', async () => {
    populateCache();
    // Add referrerIndex so auto-blocks "Children of pins" is non-empty
    sessionData.referrerIndex = {
      'https://explore.example.com/a': ['https://example.com/today0'],
    };

    await importOptions();
    await tick(200);

    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');

    // Verify auto-blocks were created (at least "Children of pins")
    const blockEls = document.querySelectorAll('.explore-block');
    expect(blockEls.length).toBeGreaterThan(0);

    // All blocks start disabled
    const toggleBtn = blockEls[0].querySelector('.explore-block-toggle');
    expect(toggleBtn.classList.contains('disabled')).toBe(true);

    // Enable the first block
    toggleBtn.click();
    await tick(200);

    // Verify block is now enabled
    const toggleAfterClick = document.querySelector('.explore-block .explore-block-toggle');
    expect(toggleAfterClick.classList.contains('enabled')).toBe(true);

    // Dispatch visibilitychange
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(500);

    // Block should still be enabled (not reset by full re-render)
    const toggleAfterVis = document.querySelector('.explore-block .explore-block-toggle');
    expect(toggleAfterVis).not.toBeNull();
    expect(toggleAfterVis.classList.contains('enabled'),
      'block should still be enabled after visibilitychange'
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // T16: pin mutation notification does not revert in-memory pin changes
  // ---------------------------------------------------------------------------
  it('T16: explore pin toggle survives mutation notification from background', async () => {
    populateCache();

    await importOptions();
    await tick(100);

    // Default view is Explore with 2 pins
    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');
    expect(pinnedOnlyRows().length).toBe(2);

    // Simulate background mutation notification for pins
    // This is what happens after saveCollectionPinsById resolves:
    // background sends notifyMutation('pins', { collectionId: 'explore' })
    const listeners = chrome.runtime.onMessage.addListener.mock.calls.map(c => c[0]);
    for (const listener of listeners) {
      listener({ action: 'mutation', type: 'pins', collectionId: 'explore' });
    }
    await tick(500);

    // The mutation notification should NOT cause the pins to disappear or flicker.
    // The in-memory allCollectionPins should be preserved for the active explore view.
    expect(pinnedOnlyRows().length, 'pinned rows should be preserved after mutation notification').toBe(2);
  });

  // ---------------------------------------------------------------------------
  // T15: empty session cache (disable/re-enable) still loads collections and recycle bin
  // ---------------------------------------------------------------------------
  it('T15: empty session cache still loads collections and recycle bin via fallback', async () => {
    // Do NOT call populateCache() — simulate disable/re-enable clearing session
    sessionData = {};
    localData = { logBuffer: [] };

    // Background would handle these actions after hydration
    const TEST_RECYCLE_BIN = [
      { url: 'https://deleted.com', title: 'Deleted Page', deletedAt: Date.now() },
    ];
    actionOverrides['getCollections'] = () => ({ collections: TEST_COLLECTIONS });
    actionOverrides['getRecycleBin'] = () => ({ items: TEST_RECYCLE_BIN });

    await importOptions();
    await tick(200);

    // Collections should render in sidebar
    const collItems = document.querySelectorAll('#collectionsList .sidebar-item');
    expect(collItems.length, 'collections sidebar should have items').toBe(TEST_COLLECTIONS.length);

    // Recycle bin count should show
    const countEl = document.getElementById('recycleSidebarCount');
    expect(countEl.textContent, 'recycle bin count should show 1').toBe('1');
  });
});
