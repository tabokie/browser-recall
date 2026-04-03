/**
 * Drain permission loss tests.
 *
 * Verifies that drainQueue() preserves entries when filesystem writes fail,
 * and that per-entity flush failures don't prevent other entities from saving.
 *
 * Key bugs tested:
 *   - pendingDrainEntries must not be cleared before successful JSONL write
 *   - verifyPermission() returning false must preserve entries
 *   - Individual entity flush failures must not block other entities
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock filesystem and effectOf
// ---------------------------------------------------------------------------

function createMockFs({ verifyResult = true, failJsonlWrite = false, failSavePage = null } = {}) {
  const savedPages = new Map();
  const jsonlWrites = [];

  // Mock directory handle for JSONL writes
  function createMockWritable(fail = false) {
    const chunks = [];
    return {
      seek: vi.fn(),
      write(data) {
        if (fail) throw new DOMException('Permission denied', 'NotAllowedError');
        chunks.push(data);
      },
      close: vi.fn(),
      _chunks: chunks,
    };
  }

  function createMockFileHandle(name, { failWritable = false } = {}) {
    let content = '';
    return {
      name,
      getFile: vi.fn(async () => ({ size: content.length, text: async () => content })),
      createWritable: vi.fn(async () => {
        if (failWritable) throw new DOMException('Permission denied', 'NotAllowedError');
        const w = createMockWritable(false);
        // On close, update content
        const origClose = w.close;
        w.close = async () => {
          content += w._chunks.join('');
          jsonlWrites.push({ name, data: w._chunks.join('') });
          origClose();
        };
        return w;
      }),
    };
  }

  const fileHandles = new Map();

  function createMockDirHandle() {
    return {
      getDirectoryHandle: vi.fn(async () => createMockDirHandle()),
      getFileHandle: vi.fn(async (name) => {
        if (failJsonlWrite) {
          return createMockFileHandle(name, { failWritable: true });
        }
        if (!fileHandles.has(name)) fileHandles.set(name, createMockFileHandle(name));
        return fileHandles.get(name);
      }),
    };
  }

  return {
    verifyPermission: vi.fn(async () => verifyResult),
    resolveDir: vi.fn(async () => createMockDirHandle()),
    resolveFile: vi.fn(async () => ({})),
    readJson: vi.fn(async () => ({})),
    writeJson: vi.fn(),
    pageExists: vi.fn(async () => false),
    loadPage: vi.fn(async () => null),
    loadSettings: vi.fn(async () => ({})),
    savePage: vi.fn(async (slug, entity) => {
      if (failSavePage === slug) throw new Error('savePage failed for ' + slug);
      savedPages.set(slug, entity);
    }),
    saveNote: vi.fn(),
    saveSettings: vi.fn(),
    saveListMeta: vi.fn(),
    deletePage: vi.fn(),
    loadNote: vi.fn(async () => null),
    loadListPinsEntity: vi.fn(async () => null),
    // Test accessors
    _savedPages: savedPages,
    _jsonlWrites: jsonlWrites,
  };
}

// ---------------------------------------------------------------------------
// Extract drain logic from offscreen.js for testing.
// Simplified: only handles visit_page entries (no effectOf replay complexity).
// ---------------------------------------------------------------------------

function createDrainEngine(fsStorage, { effectOfFn } = {}) {
  let draining = false;
  let pendingDrainEntries = null;
  let pendingDeviceId = null;
  let lastDrainedTimestamp = 0;
  let retryScheduled = false;
  const bgPort = { postMessage: vi.fn() };

  // Minimal withLock — no-op for tests
  async function withLock(key, fn) { return fn(); }

  // Default effectOf: returns page entity for visit_page
  const defaultEffectOf = async (entry, load) => {
    if (entry.action === 'visit_page') {
      const slug = entry.url.replace(/[^a-z0-9]/gi, '-');
      const key = 'page:' + slug;
      const existing = await load(key) || { slug, timestamps: {} };
      existing.timestamps = { ...existing.timestamps, dev: entry.timestamp };
      if (entry.title) existing.title = entry.title;
      return { [key]: existing };
    }
    return {};
  };

  const effectOf = effectOfFn || defaultEffectOf;

  function dateKeyFromTimestamp(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function defaultEntity(key) {
    if (key.startsWith('page:')) return { slug: key.slice(5), timestamps: {} };
    return {};
  }

  function setPendingEntries(entries, deviceId = 'test-device') {
    pendingDrainEntries = entries;
    pendingDeviceId = deviceId;
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;

    try {
      if (!(await fsStorage.verifyPermission())) {
        console.warn('Drain: no filesystem permission, retrying in 30s');
        retryScheduled = true;
        draining = false;
        return;
      }

      if (pendingDrainEntries === null) {
        draining = false;
        return;
      }
      let logBuffer = pendingDrainEntries;
      // Don't clear pendingDrainEntries yet — clear only after successful JSONL write
      logBuffer = logBuffer.filter(e => e.timestamp > lastDrainedTimestamp);
      if (logBuffer.length === 0) {
        draining = false;
        return;
      }

      let lastTimestamp = 0;
      const entriesByDate = new Map();
      const roundCache = new Map();
      const dirtyKeys = new Set();

      const ensureLoaded = async (key) => {
        if (roundCache.has(key)) return;
        if (key.startsWith('page:')) {
          const slug = key.slice(5);
          const exists = await fsStorage.pageExists(slug);
          if (exists) {
            roundCache.set(key, (await fsStorage.loadPage(slug)) || defaultEntity(key));
          } else {
            roundCache.set(key, null);
          }
        }
      };

      const load = async (key, opts) => {
        await ensureLoaded(key);
        return roundCache.get(key) ?? null;
      };

      for (const entry of logBuffer) {
        const dateKey = dateKeyFromTimestamp(entry.timestamp);
        if (!entriesByDate.has(dateKey)) entriesByDate.set(dateKey, []);
        entriesByDate.get(dateKey).push(entry);
        const updated = await effectOf(entry, load, { deviceId: pendingDeviceId });
        for (const [key, entity] of Object.entries(updated)) {
          const prev = roundCache.get(key);
          if (entity !== prev) {
            roundCache.set(key, entity);
            dirtyKeys.add(key);
          }
        }
        lastTimestamp = entry.timestamp;
      }

      // 1. JSONL append
      const logsDir = await fsStorage.resolveDir('data/logs');
      const historyDir = await logsDir.getDirectoryHandle(pendingDeviceId, { create: true });
      for (const [dateKey, entries] of entriesByDate) {
        try {
          const fh = await historyDir.getFileHandle(`${dateKey}.jsonl`, { create: true });
          const file = await fh.getFile();
          const writable = await fh.createWritable({ keepExistingData: true });
          await writable.seek(file.size);
          for (const entry of entries) {
            await writable.write(JSON.stringify(entry) + '\n');
          }
          await writable.close();
        } catch (e) {
          console.error('JSONL append failed:', e);
          retryScheduled = true;
          draining = false;
          return;
        }
      }

      // JSONL writes succeeded — safe to clear pending entries
      pendingDrainEntries = null;

      // 2. Entity flush (per-entity try/catch so one failure doesn't block others)
      for (const key of dirtyKeys) {
        const entity = roundCache.get(key);
        if (entity === null || entity === undefined) continue;
        try {
          if (key.startsWith('page:')) {
            const slug = key.slice(5);
            await withLock('pages/' + slug + '.json', () => fsStorage.savePage(slug, entity));
          }
        } catch (e) {
          console.error(`Entity flush failed for ${key}:`, e);
        }
      }

      if (lastTimestamp > 0) {
        lastDrainedTimestamp = lastTimestamp;
      }
      if (lastTimestamp > 0) {
        bgPort.postMessage({ action: 'persisted', watermark: lastTimestamp });
      }
    } catch (e) {
      console.error('drainQueue error:', e);
      retryScheduled = true;
    }

    draining = false;
  }

  return {
    drainQueue,
    setPendingEntries,
    get pendingDrainEntries() { return pendingDrainEntries; },
    get lastDrainedTimestamp() { return lastDrainedTimestamp; },
    get retryScheduled() { return retryScheduled; },
    get bgPort() { return bgPort; },
    resetRetryFlag() { retryScheduled = false; },
  };
}

function makeEntry(ts, url) {
  return { timestamp: ts, action: 'visit_page', url: url || `https://example.com/${ts}`, title: 'Page ' + ts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Drain permission loss', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('entries preserved when JSONL write fails with NotAllowedError', async () => {
    const fs = createMockFs({ failJsonlWrite: true });
    const engine = createDrainEngine(fs);

    const entries = [makeEntry(1000), makeEntry(2000), makeEntry(3000)];
    engine.setPendingEntries(entries);

    await engine.drainQueue();

    // Entries must NOT be lost — they should be available for retry
    expect(engine.pendingDrainEntries).not.toBeNull();
    expect(engine.pendingDrainEntries.length).toBe(3);
    expect(engine.retryScheduled).toBe(true);
  });

  it('entries preserved when verifyPermission returns false', async () => {
    const fs = createMockFs({ verifyResult: false });
    const engine = createDrainEngine(fs);

    const entries = [makeEntry(1000), makeEntry(2000)];
    engine.setPendingEntries(entries);

    await engine.drainQueue();

    // Permission check happens BEFORE pendingDrainEntries is touched, so entries are safe
    expect(engine.pendingDrainEntries).toEqual(entries);
    expect(engine.retryScheduled).toBe(true);
  });

  it('successful drain after permission restored', async () => {
    // First attempt: permission denied
    const fs = createMockFs({ verifyResult: false });
    const engine = createDrainEngine(fs);

    const entries = [makeEntry(1000), makeEntry(2000)];
    engine.setPendingEntries(entries);
    await engine.drainQueue();
    expect(engine.pendingDrainEntries).toEqual(entries);

    // Restore permission
    fs.verifyPermission.mockResolvedValue(true);
    engine.resetRetryFlag();
    await engine.drainQueue();

    // Entries should be drained
    expect(engine.pendingDrainEntries).toBeNull();
    expect(engine.lastDrainedTimestamp).toBe(2000);
    expect(engine.bgPort.postMessage).toHaveBeenCalledWith({ action: 'persisted', watermark: 2000 });
  });

  it('single entity flush failure does not prevent other entities from saving', async () => {
    // failSavePage='https---example-com-2000' will make savePage throw for that slug
    const failSlug = 'https---example-com-2000';
    const fs = createMockFs({ failSavePage: failSlug });
    const engine = createDrainEngine(fs);

    const entries = [
      makeEntry(1000, 'https://example.com/1000'),
      makeEntry(2000, 'https://example.com/2000'), // This entity's save will fail
      makeEntry(3000, 'https://example.com/3000'),
    ];
    engine.setPendingEntries(entries);

    await engine.drainQueue();

    // Entity save for slug 2000 failed, but JSONL writes succeeded
    // and other entities should still be saved.
    const savedSlugs = [...fs._savedPages.keys()];
    // Entity 1 saved before the failure
    expect(savedSlugs).toContain('https---example-com-1000');
    // Entity 3 should also be saved (not blocked by entity 2 failure)
    expect(savedSlugs).toContain('https---example-com-3000');
    // Entity 2 was NOT saved (its savePage threw)
    expect(savedSlugs).not.toContain(failSlug);
  });
});
