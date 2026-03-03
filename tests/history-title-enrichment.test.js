/**
 * History title enrichment tests.
 *
 * Verifies:
 * - enrichFromEntityStorage fills missing titles from page checkpoints
 *   (when no log entry in the loaded batch has a title for that URL)
 * - enrichFromEntityStorage fills missing titles from SPI for shallow pages
 * - Explore view (no enabled blocks) calls enrichFromEntityStorage
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tick(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const FILE1_DATE = '2026-02-15';

// Checkpointed page: revisited today, log entries have NO title
// (title was recorded in an older day file not loaded in this batch)
const CHECKPOINTED_URL = 'https://music.douban.com/';
const CHECKPOINTED_SLUG = generateSlugFromUrl(CHECKPOINTED_URL);
const CHECKPOINTED_TITLE = '豆瓣音乐';

// Shallow page: never checkpointed, title only in SPI
const SHALLOW_URL = 'https://shallow-example.com/page';
const SHALLOW_SLUG = generateSlugFromUrl(SHALLOW_URL);
const SHALLOW_TITLE = 'Shallow Page Title from SPI';

const base = new Date(`${FILE1_DATE}T12:00:00Z`).getTime();

// Checkpointed page entries — NO title in any entry (simulates revisit on a new day)
const CHECKPOINT_ENTRIES = [
  { url: CHECKPOINTED_URL, timestamp: base, action: 'page', scrollDepth: 0, timeOnPage: 1078 },
  { url: CHECKPOINTED_URL, timestamp: base + 60000, action: 'page', timeOnPage: 287 },
];

// Shallow page entries — NO title in any entry
const SHALLOW_ENTRIES = [
  { url: SHALLOW_URL, timestamp: base + 200000, action: 'page', scrollDepth: 0, timeOnPage: 500 },
  { url: SHALLOW_URL, timestamp: base + 260000, action: 'page', timeOnPage: 100 },
];

// Normal entries with titles (filler)
const NORMAL_ENTRIES = [];
for (let i = 0; i < 5; i++) {
  NORMAL_ENTRIES.push({
    url: `https://example.com/page${i}`,
    title: `Example Page ${i}`,
    timestamp: base + 300000 + i * 60000,
    action: 'page',
  });
}

const ALL_ENTRIES = [...CHECKPOINT_ENTRIES, ...SHALLOW_ENTRIES, ...NORMAL_ENTRIES];

const FILES_NEWEST_FIRST = [`${FILE1_DATE}.jsonl`];
const FILE_MAP = {
  [`${FILE1_DATE}.jsonl`]: ALL_ENTRIES,
};

const TEST_SETTINGS = {
  listOrder: [],
  captureContent: true,
  captureAttention: true,
  archiveQuality: 'medium',
  urlBlacklist: [],
  titleTrimRules: [],
};

// Page checkpoint returned by loadPageBatch
const PAGE_CHECKPOINTS = {
  [CHECKPOINTED_SLUG]: {
    slug: CHECKPOINTED_SLUG,
    url: CHECKPOINTED_URL,
    title: CHECKPOINTED_TITLE,
    timestamp: base - 86400000, // checkpointed yesterday
    parentIds: [],
    childIds: [],
  },
};

// Shallow Page Index
const SPI_DATA = {
  timestamp: base,
  index: {
    [SHALLOW_URL]: {
      title: SHALLOW_TITLE,
      parentIds: [],
      lists: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const { mockSearchBatchFn, mockFsHandler } = vi.hoisted(() => ({
  mockSearchBatchFn: vi.fn(async () => []),
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
    async search(query) { return []; }
  }

  return {
    default: async () => {},
    Interaction: MockInteraction,
    SearchEngine: MockSearchEngine,
    searchBatch: (...args) => mockSearchBatchFn(...args),
  };
});

// ---------------------------------------------------------------------------
// HTML content
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
describe('History title enrichment', () => {
  let sessionData;
  let localData;

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
        return { success: true, pins: {} };

      case 'loadListPinsById':
        return { success: true, pins: [] };

      case 'loadPermanentDeletes':
        return { success: true, urls: [] };

      case 'loadContentBatch':
        return { success: true, contentMap: {} };

      case 'loadGateways':
        return { success: true, watermark: 0, domains: {} };

      case 'processGatewaysIncremental':
        return { success: true, domains: {}, newWatermark: 0 };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'loadPageBatch': {
        const pages = {};
        for (const slug of msg.slugs) {
          if (PAGE_CHECKPOINTS[slug]) pages[slug] = PAGE_CHECKPOINTS[slug];
        }
        return { success: true, pages };
      }

      case 'saveSettingsKey':
        return { success: true };

      case 'readCacheable':
        switch (msg.key) {
          case 'settings': return { success: true, value: TEST_SETTINGS };
          case 'list:system/gateways': return { success: true, value: { timestamp: 0, origins: [] } };
          case 'list:system/shallow-page': return { success: true, value: SPI_DATA };
          default: return { success: true, value: undefined };
        }

      case 'getShallowPageIndex':
        return { success: true, ...SPI_DATA };

      default:
        return { success: true };
    }
  }

  function setupChromeMock() {
    sessionData = {};
    localData = {};

    mockFsHandler.fn = async (action, params) => {
      return handleAction({ action, ...params });
    };

    const chromeMock = {
      runtime: {
        sendMessage: vi.fn(async (msg) => {
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

  function populateCache() {
    sessionData = {
      settings: TEST_SETTINGS,
      'list:system/gateways': { timestamp: 0, origins: [] },
      'list:system/shallow-page': SPI_DATA,
    };
    localData = { logBuffer: [] };
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
    await tick(50);
    delete globalThis.chrome;
  });

  async function importOptions() {
    return await import('../extension/options.js');
  }

  // ---------------------------------------------------------------------------
  // Helper: find result row for a URL and return its displayed title
  // ---------------------------------------------------------------------------
  function findRowTitle(url) {
    const rows = [...document.querySelectorAll('.result-item')];
    const row = rows.find(el => {
      const resultRow = el.querySelector('.result-row');
      return resultRow && resultRow.dataset.url === url;
    });
    if (!row) return null;
    const titleEl = row.querySelector('.result-title');
    return titleEl ? titleEl.textContent.trim() : null;
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it('enriches checkpointed page title from checkpoint when log entries have no title', async () => {
    // Scenario: page was checkpointed on a prior day. Today's log entries
    // are attention-only (no title field). The Explore view should show
    // the title from the page checkpoint, not "Untitled".
    populateCache();

    const importDone = importOptions();
    await importDone;
    await tick(200);

    expect(document.getElementById('mainTitle').textContent.trim()).toBe('Explore');

    const title = findRowTitle(CHECKPOINTED_URL);
    expect(title).toBe(CHECKPOINTED_TITLE);
  });

  it('enriches shallow page title from SPI when log entries have no title', async () => {
    // Scenario: a shallow page (never checkpointed) has no title in any
    // log entry. The SPI has a title for it. enrichFromEntityStorage should
    // fall back to SPI.
    populateCache();

    const importDone = importOptions();
    await importDone;
    await tick(200);

    const title = findRowTitle(SHALLOW_URL);
    expect(title).toBe(SHALLOW_TITLE);
  });
});
