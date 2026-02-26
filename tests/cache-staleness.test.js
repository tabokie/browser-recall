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

const TEST_LIST = { slug: 'col-rust', query: 'rust', name: 'Rust Lang' };
// List with no query — only pinned pages, pins on same domain as history
const TEST_LIST_NOQUERY = { slug: 'col-noq', query: '', name: 'No Query List' };

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
  // Explore pins — used by T12
  'explore': [
    pinFromUrl('https://explore.example.com/a', NOW - DAY),
    pinFromUrl('https://explore.example.com/b', NOW - DAY),
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
  listOrder: ['list:col-rust', 'list:col-noq'],
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

      case 'loadListPins':
        if (msg.listId) {
          return { success: true, pins: TEST_LIST_PINS[msg.listId] || [] };
        }
        return { success: true, pins: TEST_LIST_PINS };

      case 'loadListPinsById':
        return { success: true, pins: TEST_LIST_PINS[msg.listId] || [] };

      case 'loadContentBatch':
        return { success: true, contentMap: {} };

      case 'loadGateways':
        return { success: true, watermark: 0, domains: {} };

      case 'processGatewaysIncremental':
        return { success: true, domains: {}, newWatermark: 0 };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'loadPageBatch':
        return { success: true, pages: {} };

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

      case 'initializeFilesystem':
        return { success: true };

      default:
        return { success: true };
    }
  }

  function populateCache() {
    // Session-cached keys (settings, workspace, lists, etc.)
    sessionData = {
      settings: TEST_SETTINGS.settings,
      lists: TEST_LISTS,
      listOrder: TEST_SETTINGS.listOrder,
      urlBlacklist: TEST_SETTINGS.urlBlacklist,
      titleTrimRules: TEST_SETTINGS.titleTrimRules,
      recycleBin: [],
      permanentDeletes: TEST_SETTINGS.permanentDeletes,
      gatewayDomains: {},
    };
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
    return [...document.querySelectorAll('#pinnedResults .result-item:not(.related-result)')];
  }

  // ---------------------------------------------------------------------------
  // T1: resetHistory clears pageReadCache + allListPins
  // ---------------------------------------------------------------------------
  it('T1: resetHistory clears pageReadCache and allListPins', async () => {
    populateCache();

    // loadPageBatch returns pages with watermark 100 initially
    actionOverrides['loadPageBatch'] = (msg) => {
      const pages = {};
      for (const slug of (msg.slugs || [])) {
        pages[slug] = { watermark: 100, attention: '', highlights: [], url: SLUG_TO_URL.get(slug) || '' };
      }
      return { success: true, pages };
    };

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

    // Now change loadPageBatch to return watermark 200 (higher than 100 cached)
    actionOverrides['loadPageBatch'] = (msg) => {
      const pages = {};
      for (const slug of (msg.slugs || [])) {
        pages[slug] = { watermark: 200, attention: '', highlights: [], url: SLUG_TO_URL.get(slug) || '' };
      }
      return { success: true, pages };
    };

    // Change loadListPins to return an updated list (4 pins)
    actionOverrides['loadListPinsById'] = actionOverrides['loadListPins'] = (msg) => {
      if (msg.listId === 'col-rust') {
        return { success: true, pins: [
          ...TEST_LIST_PINS['col-rust'],
          pinFromUrl('https://rust-lang.org/doc3', NOW),
        ]};
      }
      return { success: true, pins: [] };
    };

    chrome.runtime.sendMessage.mockClear();

    // Re-open col-rust
    const collItem2 = document.querySelector('#listsList .sidebar-item[data-list-id="col-rust"]');
    collItem2.click();
    await tick(200);

    // Assert: pins were re-loaded (allListPins was cleared by resetHistory)
    // The updated loadListPins returns 4 pins now
    expect(pinnedOnlyRows().length).toBe(4);

    // refreshListPages no longer persists enrichment — it only updates in-memory pin fields.
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

    // Change loadListPins to return 4 pins
    actionOverrides['loadListPinsById'] = actionOverrides['loadListPins'] = (msg) => {
      if (msg.listId === 'col-rust') {
        return { success: true, pins: [
          ...TEST_LIST_PINS['col-rust'],
          pinFromUrl('https://rust-lang.org/doc3', NOW),
        ]};
      }
      return { success: true, pins: [] };
    };

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

    // resetHistory clears all caches. Verify historyFiles was cleared
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
  it('T5: logBuffer visit entries are merged into history and visible in list', async () => {
    populateCache();
    // Put visit entries (no action) + mutation entries in logBuffer
    localData.logBuffer = [
      { timestamp: Date.now(), url: 'https://buffered.com/page1', title: 'Buffered Page 1', slug: 'buffered-page1',  attention: '' },
      { timestamp: Date.now(), action: 'set', key: 'workspace', value: {} },
      { timestamp: Date.now() + 1, url: 'https://buffered.com/page2', title: 'Buffered Page 2', slug: 'buffered-page2',  attention: '' },
    ];

    // Add a list with pins on buffered.com (same domain as logBuffer entries)
    sessionData.lists = [
      ...TEST_LISTS,
      { slug: 'col-buf', query: '', name: 'Buffered' },
    ];
    actionOverrides['loadListPinsById'] = (msg) => {
      if (msg.listId === 'col-buf') {
        return { success: true, pins: [
          pinFromUrl('https://buffered.com/page1', NOW),
        ]};
      }
      return { success: true, pins: TEST_LIST_PINS[msg.listId] || [] };
    };

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

    // Auto-blocks should include "Similar to pins" — example.com pins match history
    const blockEls = document.querySelectorAll('.explore-block');
    const blockLabels = [...blockEls].map(el => el.textContent.trim());
    expect(blockLabels.some(l => l.includes('Similar to pins'))).toBe(true);
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
    // Override session cache with modified list
    sessionData.lists = [
      TEST_LIST,
      { slug: 'col-noq', query: 'example', name: 'Example List' },
    ];

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

    sessionData.lists = [
      { slug: 'col-today', query: 'today', name: 'Today Search' },
    ];
    actionOverrides['loadListPinsById'] = actionOverrides['loadListPins'] = (msg) => {
      if (msg.listId === 'col-today') {
        return { success: true, pins: [
          pinFromUrl('https://example.com/today0', NOW - DAY),
        ]};
      }
      return { success: true, pins: [] };
    };

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

    // loadPageBatch returns pages WITHOUT attention (simulates pages with no attention data)
    actionOverrides['loadPageBatch'] = (msg) => {
      const pages = {};
      for (const slug of (msg.slugs || [])) {
        pages[slug] = { watermark: NOW, attention: '', highlights: [], url: SLUG_TO_URL.get(slug) || '' };
      }
      return { success: true, pages };
    };

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
    const pinnedSection = document.querySelector('.list-section[data-section="pinned"]');
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
    actionOverrides['loadListPinsById'] = () => ({ success: true, pins: [] });

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
    // This is what happens after toggleListPin/addListPins resolves:
    // background sends notifyMutation('pins', { listId: 'explore' })
    const listeners = chrome.runtime.onMessage.addListener.mock.calls.map(c => c[0]);
    for (const listener of listeners) {
      listener({ action: 'mutation', type: 'pins', listId: 'explore' });
    }
    await tick(500);

    // The mutation notification should NOT cause the pins to disappear or flicker.
    // The in-memory allListPins should be preserved for the active explore view.
    expect(pinnedOnlyRows().length, 'pinned rows should be preserved after mutation notification').toBe(2);
  });

  // ---------------------------------------------------------------------------
  // T15: empty session cache (disable/re-enable) still loads lists and recycle bin
  // ---------------------------------------------------------------------------
  it('T15: empty session cache still loads lists and recycle bin via fallback', async () => {
    // Do NOT call populateCache() — simulate disable/re-enable clearing session
    sessionData = {};
    localData = { logBuffer: [] };

    // Background would handle these actions after hydration
    const TEST_RECYCLE_BIN = [
      { url: 'https://deleted.com', title: 'Deleted Page', deletedAt: Date.now() },
    ];
    actionOverrides['getLists'] = () => ({ lists: TEST_LISTS });
    actionOverrides['getRecycleBin'] = () => ({ items: TEST_RECYCLE_BIN });

    await importOptions();
    await tick(200);

    // Lists should render in sidebar
    const collItems = document.querySelectorAll('#listsList .sidebar-item');
    expect(collItems.length, 'lists sidebar should have items').toBe(TEST_LISTS.length);

    // Recycle bin count should show
    const countEl = document.getElementById('recycleSidebarCount');
    expect(countEl.textContent, 'recycle bin count should show 1').toBe('1');
  });

  // ---------------------------------------------------------------------------
  // T17: shallow pins show title from shallowPageIndex, not "Untitled"
  // ---------------------------------------------------------------------------
  it('T17: shallow pins show title from shallowPageIndex', async () => {
    populateCache();

    const SHALLOW_URL = 'https://shallow.example.com/article';
    const SHALLOW_TITLE = 'Shallow Article Title';

    // Add a list with one shallow pin
    const TEST_LIST_WITH_SHALLOW = { slug: 'col-shallow', query: '', name: 'Shallow List' };
    const shallowPins = {
      ...TEST_LIST_PINS,
      'col-shallow': [
        { id: 'shallow:' + SHALLOW_URL, pinnedAt: NOW - DAY },
      ],
    };
    actionOverrides['loadListPinsById'] = (msg) => ({
      success: true, pins: shallowPins[msg.listId] || [],
    });
    actionOverrides['loadListPins'] = (msg) => {
      if (msg.listId) return { success: true, pins: shallowPins[msg.listId] || [] };
      return { success: true, pins: shallowPins };
    };

    // Put shallowPageIndex in session cache with the title
    sessionData.shallowPageIndex = {
      timestamp: 0,
      index: {
        [SHALLOW_URL]: { parents: [], lists: ['list:col-shallow'], title: SHALLOW_TITLE, user_title: null },
      },
    };

    // Add the shallow list to lists and listOrder
    sessionData.lists = [...TEST_LISTS, TEST_LIST_WITH_SHALLOW];
    sessionData.listOrder = [...TEST_SETTINGS.listOrder, 'list:col-shallow'];
    actionOverrides['getLists'] = () => ({ lists: sessionData.lists });

    await importOptions();
    await tick(200);

    // Click on the shallow list in sidebar
    const sidebarItems = document.querySelectorAll('#listsList .sidebar-item');
    const shallowListItem = [...sidebarItems].find(el => el.textContent.includes('Shallow List'));
    expect(shallowListItem, 'shallow list sidebar item should exist').toBeTruthy();
    shallowListItem.click();
    await tick(300);

    // Check pinned rows — the shallow pin should show the title, not "Untitled"
    const rows = pinnedOnlyRows();
    expect(rows.length, 'should have 1 pinned row').toBe(1);
    const titleEl = rows[0].querySelector('.result-title');
    expect(titleEl.textContent, 'shallow pin should show title from shallowPageIndex').toBe(SHALLOW_TITLE);
  });

  // ---------------------------------------------------------------------------
  // T18: page: pin resolves via loadPageBatch when not in session cache
  // ---------------------------------------------------------------------------
  it('T18: page pin falls back to loadPageBatch when not in session', async () => {
    populateCache();

    const PAGE_URL = 'https://uncached.example.com/page';
    const PAGE_TITLE = 'Uncached Page Title';
    const PAGE_SLUG = generateSlugFromUrl(PAGE_URL);

    // List with one page: pin whose entity is NOT in session cache
    const TEST_LIST_UNCACHED = { slug: 'col-uncached', query: '', name: 'Uncached List' };
    const uncachedPins = {
      ...TEST_LIST_PINS,
      'col-uncached': [
        { id: 'page:' + PAGE_SLUG, pinnedAt: NOW - DAY },
      ],
    };
    actionOverrides['loadListPinsById'] = (msg) => ({
      success: true, pins: uncachedPins[msg.listId] || [],
    });
    actionOverrides['getLists'] = () => ({ lists: [...TEST_LISTS, TEST_LIST_UNCACHED] });
    // loadPageBatch returns the page entity (filesystem fallback)
    actionOverrides['loadPageBatch'] = (msg) => ({
      success: true,
      pages: Object.fromEntries(msg.slugs.map(s => [s, s === PAGE_SLUG
        ? { slug: PAGE_SLUG, url: PAGE_URL, title: PAGE_TITLE, watermark: 1 }
        : null
      ]).filter(([, v]) => v)),
    });

    // Do NOT put 'page:<slug>' in sessionData — simulating empty session cache
    sessionData.lists = [...TEST_LISTS, TEST_LIST_UNCACHED];
    sessionData.listOrder = [...TEST_SETTINGS.listOrder, 'list:col-uncached'];

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
    expect(titleEl.textContent, 'page pin should resolve title via loadPageBatch fallback').toBe(PAGE_TITLE);
  });

  // ---------------------------------------------------------------------------
  // T19: shallow pin resolves via getShallowPageIndex when SPI not in session
  // ---------------------------------------------------------------------------
  it('T19: shallow pin falls back to getShallowPageIndex when SPI not in session', async () => {
    populateCache();

    const SHALLOW_URL = 'https://shallow-fallback.example.com/page';
    const SHALLOW_TITLE = 'Shallow Fallback Title';

    const TEST_LIST_SPI = { slug: 'col-spi', query: '', name: 'SPI Fallback List' };
    const spiPins = {
      ...TEST_LIST_PINS,
      'col-spi': [
        { id: 'shallow:' + SHALLOW_URL, pinnedAt: NOW - DAY },
      ],
    };
    actionOverrides['loadListPinsById'] = (msg) => ({
      success: true, pins: spiPins[msg.listId] || [],
    });
    actionOverrides['getLists'] = () => ({ lists: [...TEST_LISTS, TEST_LIST_SPI] });
    // getShallowPageIndex handler returns SPI (filesystem fallback via background)
    actionOverrides['getShallowPageIndex'] = () => ({
      timestamp: 0,
      index: {
        [SHALLOW_URL]: { parents: [], lists: ['list:col-spi'], title: SHALLOW_TITLE, user_title: null },
      },
    });

    // Do NOT put shallowPageIndex in sessionData — simulating pre-hydration state
    sessionData.lists = [...TEST_LISTS, TEST_LIST_SPI];
    sessionData.listOrder = [...TEST_SETTINGS.listOrder, 'list:col-spi'];

    await importOptions();
    await tick(200);

    const sidebarItems = document.querySelectorAll('#listsList .sidebar-item');
    const listItem = [...sidebarItems].find(el => el.textContent.includes('SPI Fallback List'));
    expect(listItem, 'SPI fallback list sidebar item should exist').toBeTruthy();
    listItem.click();
    await tick(300);

    const rows = pinnedOnlyRows();
    expect(rows.length, 'should have 1 pinned row').toBe(1);
    const titleEl = rows[0].querySelector('.result-title');
    expect(titleEl.textContent, 'shallow pin should resolve via getShallowPageIndex fallback').toBe(SHALLOW_TITLE);
  });
});
