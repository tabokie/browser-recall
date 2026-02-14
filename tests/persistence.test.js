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
        throw new DOMException('NotFoundError');
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
        throw new DOMException('NotFoundError');
      }
    }
    return node.handle;
  }

  async removeEntry(name) {
    if (!this._children.has(name)) throw new DOMException('NotFoundError');
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
    } catch { return 'untitled'; }
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

// ---------------------------------------------------------------------------
// Test-level wiring: simulates background.js hydrateCache flow
// ---------------------------------------------------------------------------

async function hydrateCache(fsStorage, chromeStorage) {
  const settings = await fsStorage.loadSettings();
  const cacheUpdate = {};
  if (settings.workspace !== undefined) cacheUpdate.workspace = settings.workspace;
  if (settings.collections !== undefined) cacheUpdate.pinnedCollections = settings.collections;
  if (settings.urlBlacklist !== undefined) cacheUpdate.urlBlacklist = settings.urlBlacklist;
  if (settings.titleTrimRules !== undefined) cacheUpdate.titleTrimRules = settings.titleTrimRules;
  if (settings.recycleBin !== undefined) cacheUpdate.recycleBin = settings.recycleBin;
  if (settings.permanentDeletes !== undefined) cacheUpdate.permanentDeletes = settings.permanentDeletes;
  if (settings.settings !== undefined) cacheUpdate.settings = settings.settings;
  if (Object.keys(cacheUpdate).length > 0) await chromeStorage.set(cacheUpdate);

  // Load and incrementally process gateway domains
  const gwData = await fsStorage.loadGateways();
  const { domains, newWatermark } = await fsStorage.processGatewaysAfterWatermark(
    gwData.watermark, gwData.domains
  );
  await chromeStorage.set({ gatewayDomains: domains });
  if (newWatermark > gwData.watermark) {
    await fsStorage.saveGateways({ watermark: newWatermark, domains });
  }
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
      workspace: { mode: 'workspace', collectionIds: ['c1'], autoSnapshot: true },
      collections: [{ id: 'c1', query: 'rust' }],
      urlBlacklist: ['chrome://', 'edge://'],
      titleTrimRules: [{ urlPrefix: 'https://github.com', action: 'remove_after_pipe' }],
      recycleBin: [{ url: 'https://old.com', title: 'Old', deletedAt: 1000 }],
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
      workspace: { mode: 'default', collectionIds: [], autoSnapshot: false },
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
      workspace: { mode: 'workspace', collectionIds: ['c1', 'c2'], autoSnapshot: true },
      collections: [
        { id: 'c1', query: 'AI' },
        { id: 'c2', query: 'Rust', name: 'Rust Lang' },
      ],
      urlBlacklist: ['chrome://', 'edge://', 'https://private.example.com/'],
      titleTrimRules: [
        { urlPrefix: 'https://github.com', action: 'remove_after_pipe' },
        { urlPrefix: 'https://zhihu.com', action: 'remove_parens' },
      ],
      recycleBin: [
        { url: 'https://old.com', title: 'Old page', deletedAt: 1000 },
      ],
      permanentDeletes: ['https://gone.com', 'https://alsoGone.com'],
      settings: { captureContent: true, captureAttention: true, archiveQuality: 'medium' },
    };

    it('data survives chrome.storage.local.clear() + hydrateCache', async () => {
      // 1. Persist settings to filesystem
      await fs.saveSettings(initialSettings);

      // 2. Hydrate chrome cache (simulates startup)
      await hydrateCache(fs, chromeStorage);

      // Snapshot the cache
      const cacheBefore = { ...(await chromeStorage.get(null)) };
      delete cacheBefore.gatewayDomains; // tested separately

      // 3. Simulate reload: nuke chrome.storage.local
      await chromeStorage.clear();
      expect(await chromeStorage.get(null)).toEqual({});

      // 4. Re-hydrate
      await hydrateCache(fs, chromeStorage);

      const cacheAfter = { ...(await chromeStorage.get(null)) };
      delete cacheAfter.gatewayDomains;

      expect(cacheAfter).toEqual(cacheBefore);
    });

    it('individual cache keys match settings.json after reload', async () => {
      await fs.saveSettings(initialSettings);
      await hydrateCache(fs, chromeStorage);

      // Clear + re-hydrate
      await chromeStorage.clear();
      await hydrateCache(fs, chromeStorage);

      const cached = await chromeStorage.get([
        'workspace', 'pinnedCollections', 'urlBlacklist',
        'titleTrimRules', 'recycleBin', 'permanentDeletes', 'settings',
      ]);

      expect(cached.workspace).toEqual(initialSettings.workspace);
      expect(cached.pinnedCollections).toEqual(initialSettings.collections);
      expect(cached.urlBlacklist).toEqual(initialSettings.urlBlacklist);
      expect(cached.titleTrimRules).toEqual(initialSettings.titleTrimRules);
      expect(cached.recycleBin).toEqual(initialSettings.recycleBin);
      expect(cached.permanentDeletes).toEqual(initialSettings.permanentDeletes);
      expect(cached.settings).toEqual(initialSettings.settings);
    });

    it('writeBuffer is not populated by hydrateCache (it is transient)', async () => {
      await fs.saveSettings(initialSettings);
      await hydrateCache(fs, chromeStorage);

      const { writeBuffer } = await chromeStorage.get(['writeBuffer']);
      expect(writeBuffer).toBeUndefined();
    });
  });

  // ---- Gateway domains rebuild ----

  describe('gateway persistence (incremental)', () => {
    async function writeJsonl(dir, filename, lines) {
      const fh = await dir.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(lines.map(l => JSON.stringify(l)).join('\n'));
      await w.close();
    }

    it('processes domains from JSONL interactions', async () => {
      await writeJsonl(rootDir, '2026-02-14.jsonl', [
        { url: 'https://example.com/', timestamp: 1 },
        { url: 'https://example.com/page1', timestamp: 2 },
        { url: 'https://example.com/page2', timestamp: 3 },
        { url: 'https://other.com/a', timestamp: 4 },
      ]);

      const { domains } = await fs.processGatewaysAfterWatermark(0, {});

      expect(domains['https://example.com'].rootUrl).toBe('https://example.com/');
      expect(domains['https://example.com'].childCount).toBe(2);
      expect(domains['https://other.com'].rootUrl).toBeNull();
      expect(domains['https://other.com'].childCount).toBe(1);
    });

    it('classifies search query URLs as children, not roots', async () => {
      await writeJsonl(rootDir, '2026-02-14.jsonl', [
        { url: 'https://google.com/?q=test', timestamp: 1 },
        { url: 'https://google.com/?q=other', timestamp: 2 },
      ]);

      const { domains } = await fs.processGatewaysAfterWatermark(0, {});

      expect(domains['https://google.com'].rootUrl).toBeNull();
      expect(domains['https://google.com'].childCount).toBe(2);
    });

    it('counts children without cap', async () => {
      const lines = [];
      for (let i = 0; i < 120; i++) {
        lines.push({ url: `https://big.com/page${i}`, timestamp: i + 1 });
      }
      await writeJsonl(rootDir, '2026-02-14.jsonl', lines);

      const { domains } = await fs.processGatewaysAfterWatermark(0, {});
      expect(domains['https://big.com'].childCount).toBe(120);
    });

    it('gateway domains survive reload via gateways.json', async () => {
      await writeJsonl(rootDir, '2026-02-14.jsonl', [
        { url: 'https://hub.com/', timestamp: 1 },
        { url: 'https://hub.com/a', timestamp: 2 },
        { url: 'https://hub.com/b', timestamp: 3 },
      ]);

      // Initial hydration
      await hydrateCache(fs, chromeStorage);
      const before = (await chromeStorage.get(['gatewayDomains'])).gatewayDomains;

      // Reload
      await chromeStorage.clear();
      await hydrateCache(fs, chromeStorage);
      const after = (await chromeStorage.get(['gatewayDomains'])).gatewayDomains;

      expect(after).toEqual(before);
      expect(after['https://hub.com'].rootUrl).toBe('https://hub.com/');
      expect(after['https://hub.com'].childCount).toBe(2);
    });

    it('incremental processing only processes new interactions', async () => {
      await writeJsonl(rootDir, '2026-02-14.jsonl', [
        { url: 'https://example.com/', timestamp: 1 },
        { url: 'https://example.com/page1', timestamp: 2 },
      ]);

      // First full scan
      const { domains, newWatermark } = await fs.processGatewaysAfterWatermark(0, {});
      expect(domains['https://example.com'].childCount).toBe(1);
      expect(newWatermark).toBe(2);

      // Incremental scan (no new data above watermark=2)
      const { domains: d2, newWatermark: w2 } = await fs.processGatewaysAfterWatermark(2, domains);
      expect(d2['https://example.com'].childCount).toBe(1);
      expect(w2).toBe(2);
    });

    it('loadGateways returns empty when file missing', async () => {
      const data = await fs.loadGateways();
      expect(data).toEqual({ watermark: 0, domains: {} });
    });

    it('saveGateways + loadGateways round-trips', async () => {
      const data = {
        watermark: 12345,
        domains: { 'https://foo.com': { rootUrl: 'https://foo.com/', childCount: 5, fetched: true } }
      };
      await fs.saveGateways(data);
      const loaded = await fs.loadGateways();
      expect(loaded).toEqual(data);
    });

    it('skips non-JSONL files and malformed lines', async () => {
      const readme = await rootDir.getFileHandle('README.md', { create: true });
      const w = await readme.createWritable();
      await w.write('# hello');
      await w.close();

      await writeJsonl(rootDir, '2026-02-14.jsonl', [
        { url: 'https://ok.com/page', timestamp: 1 },
      ]);
      const fh = await rootDir.getFileHandle('2026-02-14.jsonl');
      const file = await fh.getFile();
      const existing = await file.text();
      const fh2 = await rootDir.getFileHandle('2026-02-14.jsonl', { create: true });
      const w2 = await fh2.createWritable();
      await w2.write(existing + '\n{not valid json\n');
      await w2.close();

      const { domains } = await fs.processGatewaysAfterWatermark(0, {});
      expect(Object.keys(domains)).toEqual(['https://ok.com']);
    });
  });

  // ---- Collection pins are independent of settings.json ----

  it('collection pins (collections.json) are separate from settings', async () => {
    // Save pins
    const pins = { c1: [{ url: 'https://a.com', title: 'A', pinnedAt: 100 }] };
    await fs.saveCollectionPins(pins);

    // Save settings
    await fs.saveSettings({ collections: [{ id: 'c1', query: 'test' }] });

    // Both round-trip independently
    const loadedPins = await fs.loadCollectionPins();
    const loadedSettings = await fs.loadSettings();

    expect(loadedPins).toEqual(pins);
    expect(loadedSettings.collections).toEqual([{ id: 'c1', query: 'test' }]);
  });
});
