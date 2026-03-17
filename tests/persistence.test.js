/**
 * Persistence round-trip tests.
 *
 * Simulates: fresh extension install → write data → "reload" (clear cache,
 * re-hydrate from files) → verify data unchanged.
 *
 * Uses an in-memory mock of the File System Access API so that
 * FileSystemStorage methods operate against a virtual directory tree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// In-memory File System Access API mock
// ---------------------------------------------------------------------------

class MockWritable {
  constructor(fileNode) { this._file = fileNode; this._chunks = []; }
  async write(data) { this._chunks.push(typeof data === 'string' ? data : String(data)); }
  async close() { this._file.content = this._chunks.join(''); }
}

class MockFileHandle {
  constructor(node) { this._node = node; this.kind = 'file'; this.name = node.name; }
  async getFile() {
    return { text: async () => this._node.content, name: this._node.name };
  }
  async createWritable() { return new MockWritable(this._node); }
}

class MockDirectoryHandle {
  constructor(name, children) {
    this.kind = 'directory';
    this.name = name;
    this._children = children || new Map();          // name → { type, ... }
  }

  async getFileHandle(name, opts) {
    let node = this._children.get(name);
    if (!node || node.type !== 'file') {
      if (opts && opts.create) {
        node = { type: 'file', name, content: '' };
        this._children.set(name, node);
      } else {
        throw new DOMException('File not found', 'NotFoundError');
      }
    }
    return new MockFileHandle(node);
  }

  async getDirectoryHandle(name, opts) {
    let node = this._children.get(name);
    if (!node || node.type !== 'directory') {
      if (opts && opts.create) {
        node = { type: 'directory', name, handle: new MockDirectoryHandle(name) };
        this._children.set(name, node);
      } else {
        throw new DOMException('Directory not found', 'NotFoundError');
      }
    }
    return node.handle;
  }

  async removeEntry(name) {
    if (!this._children.has(name)) throw new DOMException('Entry not found', 'NotFoundError');
    this._children.delete(name);
  }

  async *values() {
    for (const node of this._children.values()) {
      if (node.type === 'file') yield new MockFileHandle(node);
      else yield node.handle;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers: import FileSystemStorage with mocked dependencies
// ---------------------------------------------------------------------------

// Stub out the module-level import of generateSlugFromUrl that
// filesystem-storage.js uses, so we don't need to resolve utils.js.
vi.mock('../extension/utils.js', () => ({
  generateSlugFromUrl(url) {
    try {
      const parsed = new URL(url);
      const base = (parsed.hostname + parsed.pathname)
        .toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
      let hash = 0;
      for (let i = 0; i < url.length; i++) hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
      return `${base}-${Math.abs(hash).toString(36)}`.substring(0, 80);
    } catch { throw new Error('generateSlugFromUrl: invalid URL'); }
  },
}));

const { FileSystemStorage } = await import('../extension/filesystem-storage.js');

function makeFsStorage(dirHandle) {
  const fs = new FileSystemStorage();
  fs.directoryHandle = dirHandle;
  // Bypass IndexedDB / permission checks
  fs.verifyPermission = async () => true;
  fs.loadDirectoryHandle = async () => dirHandle;
  return fs;
}

// ---------------------------------------------------------------------------
// Chrome storage mock
// ---------------------------------------------------------------------------

function makeChromeStorageMock() {
  let store = {};
  return {
    get(keys) {
      if (!keys) return Promise.resolve({ ...store });
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    },
    set(obj) {
      Object.assign(store, obj);
      return Promise.resolve();
    },
    remove(keys) {
      for (const k of keys) delete store[k];
      return Promise.resolve();
    },
    clear() {
      store = {};
      return Promise.resolve();
    },
    _raw() { return store; },
  };
}

function pinFromUrl(url, pinnedAt) {
  return { id: 'page:' + generateSlugFromUrl(url), pinnedAt };
}

// ---------------------------------------------------------------------------
// Test-level wiring: simulates background.js hydrateCache flow
// ---------------------------------------------------------------------------

async function hydrateCache(fsStorage, chromeStorage) {
  const settings = await fsStorage.loadSettings();
  const cacheUpdate = {};
  if (Object.keys(settings).length > 0) cacheUpdate['manifest:settings'] = settings;

  // Load lists from self-describing files
  const lists = await fsStorage.loadAllListMetadata();
  cacheUpdate.lists = lists;

  if (Object.keys(cacheUpdate).length > 0) await chromeStorage.set(cacheUpdate);

  // Load gateway origins from entity file
  const gwData = await fsStorage.loadListPinsEntity('auto/gateways');
  if (gwData) await chromeStorage.set({ 'list:auto/gateways': gwData });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Persistence round-trip', () => {
  let rootDir;
  let fs;
  let chromeStorage;

  beforeEach(() => {
    rootDir = new MockDirectoryHandle('portal-data');
    fs = makeFsStorage(rootDir);
    chromeStorage = makeChromeStorageMock();
  });

  // ---- settings.json round-trip ----

  it('saveSettings → loadSettings round-trips correctly', async () => {
    const data = {
      workspace: { mode: 'workspace', listIds: ['list:c1'], autoSnapshot: true },
      urlBlacklist: ['chrome://', 'edge://'],
      titleTrimRules: [{ urlPrefix: 'https://github.com', action: 'remove_after_pipe' }],
      permanentDeletes: ['https://gone.com'],
      settings: { captureContent: true, captureAttention: false, archiveQuality: 'high' },
    };

    await fs.saveSettings(data);
    const loaded = await fs.loadSettings();

    expect(loaded).toEqual(data);
  });

  it('loadSettings returns {} when file is missing', async () => {
    const loaded = await fs.loadSettings();
    expect(loaded).toEqual({});
  });

  it('saveSettings overwrites previous data', async () => {
    await fs.saveSettings({ workspace: { mode: 'default' } });
    await fs.saveSettings({ workspace: { mode: 'private' } });
    const loaded = await fs.loadSettings();
    expect(loaded.workspace.mode).toBe('private');
  });

  // ---- saveSettingsKey (read-modify-write) ----

  it('read-modify-write preserves unrelated keys', async () => {
    await fs.saveSettings({
      workspace: { mode: 'default', listIds: [], autoSnapshot: false },
      urlBlacklist: ['chrome://'],
    });

    // Simulate saveSettingsKey for urlBlacklist
    const current = await fs.loadSettings();
    current.urlBlacklist = ['chrome://', 'edge://'];
    await fs.saveSettings(current);

    const loaded = await fs.loadSettings();
    expect(loaded.workspace.mode).toBe('default');
    expect(loaded.urlBlacklist).toEqual(['chrome://', 'edge://']);
  });

  // ---- Full reload scenario ----

  describe('simulated extension reload', () => {
    const initialSettings = {
      workspace: { mode: 'workspace', listIds: ['list:c1', 'list:c2'], autoSnapshot: true },
      urlBlacklist: ['chrome://', 'edge://', 'https://private.example.com/'],
      titleTrimRules: [
        { urlPrefix: 'https://github.com', action: 'remove_after_pipe' },
        { urlPrefix: 'https://zhihu.com', action: 'remove_parens' },
      ],
      permanentDeletes: ['https://gone.com', 'https://alsoGone.com'],
      settings: { captureContent: true, captureAttention: true, archiveQuality: 'medium' },
    };

    // List metadata in self-describing files
    const listMeta = [
      { slug: 'c1', name: 'AI', pins: [], rules: [], parentList: null, childLists: [] },
      { slug: 'c2', name: 'Rust Lang', pins: [], rules: [], parentList: null, childLists: [] },
    ];

    it('data survives chrome.storage.local.clear() + hydrateCache', async () => {
      // 1. Persist settings + list files
      await fs.saveSettings(initialSettings);
      for (const col of listMeta) {
        await fs.saveListMeta(col.slug, col);
      }

      // 2. Hydrate chrome cache (simulates startup)
      await hydrateCache(fs, chromeStorage);

      // Snapshot the cache
      const cacheBefore = { ...(await chromeStorage.get(null)) };
      delete cacheBefore['list:auto/gateways']; // auto lists tested separately

      // 3. Simulate reload: nuke chrome.storage.local
      await chromeStorage.clear();
      expect(await chromeStorage.get(null)).toEqual({});

      // 4. Re-hydrate
      await hydrateCache(fs, chromeStorage);

      const cacheAfter = { ...(await chromeStorage.get(null)) };
      delete cacheAfter['list:auto/gateways'];

      expect(cacheAfter).toEqual(cacheBefore);
    });

    it('individual cache keys match after reload', async () => {
      await fs.saveSettings(initialSettings);
      for (const col of listMeta) {
        await fs.saveListMeta(col.slug, col);
      }
      await hydrateCache(fs, chromeStorage);

      // Clear + re-hydrate
      await chromeStorage.clear();
      await hydrateCache(fs, chromeStorage);

      const cached = await chromeStorage.get([
        'manifest:settings', 'lists',
      ]);

      expect(cached['manifest:settings']).toEqual(initialSettings);
      expect(cached.lists).toEqual(listMeta);
    });

    it('logBuffer is not populated by hydrateCache (it is transient)', async () => {
      await fs.saveSettings(initialSettings);
      await hydrateCache(fs, chromeStorage);

      const { logBuffer } = await chromeStorage.get(['logBuffer']);
      expect(logBuffer).toBeUndefined();
    });
  });

  // ---- List pins are independent of settings.json ----

  it('list files are separate from settings', async () => {
    // Save list with metadata + pins
    await fs.saveListMeta('c1', { slug: 'c1', name: 'Test' });
    await fs.saveListPinsById('c1', [pinFromUrl('https://a.com', 100)]);

    // Save settings
    await fs.saveSettings({ trimRules: ['rule1'] });

    // Both round-trip independently
    const loadedPins = await fs.loadListPinsById('c1');
    const loadedSettings = await fs.loadSettings();
    const meta = await fs.loadAllListMetadata();

    expect(loadedPins).toEqual([pinFromUrl('https://a.com', 100)]);
    expect(loadedSettings.trimRules).toEqual(['rule1']);
    expect(meta).toEqual([{ slug: 'c1', name: 'Test', pins: [pinFromUrl('https://a.com', 100)], rules: [], parentList: null, childLists: [] }]);
  });

  // ---- Per-list pin isolation (regression: lazy pins + bulk save deleted other files) ----

  describe('per-list pin operations', () => {
    const PINS_C1 = [
      pinFromUrl('https://a.com', 100),
      pinFromUrl('https://b.com', 200),
    ];
    const PINS_C2 = [
      pinFromUrl('https://x.com', 300),
    ];
    const PINS_C3 = [
      pinFromUrl('https://y.com', 400),
      pinFromUrl('https://z.com', 500),
      pinFromUrl('https://w.com', 600),
    ];

    async function seedAllPins() {
      await fs.saveListPins({ c1: PINS_C1, c2: PINS_C2, c3: PINS_C3 });
    }

    it('saveListPinsById writes only one file, leaves others intact', async () => {
      await seedAllPins();

      // Update c1 only
      const updated = [...PINS_C1, pinFromUrl('https://new.com', 700)];
      await fs.saveListPinsById('c1', updated);

      // c1 updated
      const c1 = await fs.loadListPinsById('c1');
      expect(c1).toEqual(updated);

      // c2 and c3 untouched
      const c2 = await fs.loadListPinsById('c2');
      expect(c2).toEqual(PINS_C2);
      const c3 = await fs.loadListPinsById('c3');
      expect(c3).toEqual(PINS_C3);
    });

    it('saveListPinsById creates new file for unknown list', async () => {
      await seedAllPins();

      const newPins = [pinFromUrl('https://brand-new.com', 800)];
      await fs.saveListPinsById('c4', newPins);

      // New list saved
      const c4 = await fs.loadListPinsById('c4');
      expect(c4).toEqual(newPins);

      // Existing lists untouched
      const all = await fs.loadListPins();
      expect(all.c1).toEqual(PINS_C1);
      expect(all.c2).toEqual(PINS_C2);
      expect(all.c3).toEqual(PINS_C3);
    });

    it('loadListPinsById returns [] for missing list', async () => {
      await seedAllPins();
      const pins = await fs.loadListPinsById('nonexistent');
      expect(pins).toEqual([]);
    });

    it('loadListPinsEntity returns null for non-existent list', async () => {
      const entity = await fs.loadListPinsEntity('nonexistent');
      expect(entity).toBeNull();
    });

    it('loadListPinsEntity returns entity with slug for existing list', async () => {
      await fs.saveListMeta('c1', { slug: 'c1', name: 'Test' });
      await fs.saveListPinsById('c1', [pinFromUrl('https://a.com', 100)]);
      const entity = await fs.loadListPinsEntity('c1');
      expect(entity).not.toBeNull();
      expect(entity.slug).toBe('c1');
      expect(entity.pins).toEqual([pinFromUrl('https://a.com', 100)]);
    });

    it('loadListPinsById round-trips with saveListPinsById', async () => {
      const pins = [pinFromUrl('https://solo.com', 999)];
      await fs.saveListPinsById('solo', pins);
      const loaded = await fs.loadListPinsById('solo');
      expect(loaded).toEqual(pins);
    });

    it('saving empty pins for deleted list does not affect others', async () => {
      await seedAllPins();

      // Simulate delete-list: save empty pins for c2
      await fs.saveListPinsById('c2', []);

      // c2 is now empty
      const c2 = await fs.loadListPinsById('c2');
      expect(c2).toEqual([]);

      // c1 and c3 untouched
      const c1 = await fs.loadListPinsById('c1');
      expect(c1).toEqual(PINS_C1);
      const c3 = await fs.loadListPinsById('c3');
      expect(c3).toEqual(PINS_C3);
    });

    it('concurrent per-list saves do not interfere', async () => {
      await seedAllPins();

      const updatedC1 = [pinFromUrl('https://c1-new.com', 900)];
      const updatedC3 = [pinFromUrl('https://c3-new.com', 1000)];

      // Save c1 and c3 concurrently
      await Promise.all([
        fs.saveListPinsById('c1', updatedC1),
        fs.saveListPinsById('c3', updatedC3),
      ]);

      expect(await fs.loadListPinsById('c1')).toEqual(updatedC1);
      expect(await fs.loadListPinsById('c2')).toEqual(PINS_C2);
      expect(await fs.loadListPinsById('c3')).toEqual(updatedC3);
    });
  });
});
