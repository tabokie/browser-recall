/**
 * History title enrichment tests.
 *
 * Verifies:
 * - enrichFromEntityStorage fills missing titles from page checkpoints
 *   (when no log entry in the loaded batch has a title for that URL)
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

// Second checkpointed page: title only in page entity, not in today's log entries
const SECOND_URL = 'https://shallow-example.com/page';
const SECOND_SLUG = generateSlugFromUrl(SECOND_URL);
const SECOND_TITLE = 'Second Page Title from Entity';

const base = new Date(`${FILE1_DATE}T12:00:00Z`).getTime();

// Checkpointed page entries — NO title in any entry (simulates revisit on a new day)
const CHECKPOINT_ENTRIES = [
  { url: CHECKPOINTED_URL, timestamp: base, action: 'visit_page', scrollDepth: 0, timeOnPage: 1078 },
  { url: CHECKPOINTED_URL, timestamp: base + 60000, action: 'visit_page', timeOnPage: 287 },
];

// Second page entries — NO title in any entry
const SECOND_ENTRIES = [
  { url: SECOND_URL, timestamp: base + 200000, action: 'visit_page', scrollDepth: 0, timeOnPage: 500 },
  { url: SECOND_URL, timestamp: base + 260000, action: 'visit_page', timeOnPage: 100 },
];

// Normal entries with titles (filler)
const NORMAL_ENTRIES = [];
for (let i = 0; i < 5; i++) {
  NORMAL_ENTRIES.push({
    url: `https://example.com/page${i}`,
    title: `Example Page ${i}`,
    timestamp: base + 300000 + i * 60000,
    action: 'visit_page',
  });
}

const ALL_ENTRIES = [...CHECKPOINT_ENTRIES, ...SECOND_ENTRIES, ...NORMAL_ENTRIES];

const FILES_NEWEST_FIRST = [`${FILE1_DATE}.jsonl`];
const FILE_MAP = {
  [`${FILE1_DATE}.jsonl`]: ALL_ENTRIES,
};

const TEST_SETTINGS = {
  trimRules: [],
  captureContent: true,
  captureAttention: true,
  archiveQuality: 'medium',
  urlBlacklist: [],
  titleTrimRules: [],
};

// Page checkpoints returned by readCacheable('page:*')
const PAGE_CHECKPOINTS = {
  [CHECKPOINTED_SLUG]: {
    slug: CHECKPOINTED_SLUG,
    url: CHECKPOINTED_URL,
    title: CHECKPOINTED_TITLE,
    timestamp: base - 86400000, // checkpointed yesterday
    parentIds: [],
    childIds: [],
  },
  [SECOND_SLUG]: {
    slug: SECOND_SLUG,
    url: SECOND_URL,
    title: SECOND_TITLE,
    timestamp: base - 86400000,
    parentIds: [],
    childIds: [],
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
    async loadAllContent() { return {}; }
    async loadSettings() { return (await mockFsHandler.fn('loadSettings', {})).settings || {}; }
    async listHistoryFiles() { return (await mockFsHandler.fn('listHistoryFiles', {})).files || []; }
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
    async search(query) { return []; }
  }

  return {
    default: async () => {},
    HistoryEntry: MockHistoryEntry,
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
      case 'getDeviceId':
        return { success: true, deviceId: 'test-device' };

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
        return { success: true, contentMap: {} };

      case 'loadAllHighlights':
        return { success: true, highlightsMap: {} };

      case 'saveSettingsKey':
        return { success: true };

      case 'readCacheable':
        switch (msg.key) {
          case 'manifest:settings': return { success: true, value: TEST_SETTINGS };
          case 'manifest:name-to-id': return { success: true, value: { timestamp: 0, paths: {} } };
          case 'manifest:orphaned': return { success: true, value: { timestamp: 0, entries: [] } };
          default: {
            if (msg.key.startsWith('page:')) {
              const slug = msg.key.slice('page:'.length);
              return { success: true, value: PAGE_CHECKPOINTS[slug] || null };
            }
            return { success: true, value: undefined };
          }
        }

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
      'manifest:settings': TEST_SETTINGS,
      'manifest:name-to-id': { timestamp: 0, paths: {} },
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

  it('enriches second page title from page entity when log entries have no title', async () => {
    // Scenario: a page was checkpointed on a prior day. Today's log entries
    // have no title field. enrichFromEntityStorage should fill from page entity.
    populateCache();

    const importDone = importOptions();
    await importDone;
    await tick(200);

    const title = findRowTitle(SECOND_URL);
    expect(title).toBe(SECOND_TITLE);
  });
});
