/**
 * Log buffer tests.
 *
 * Verifies that the background's log buffer correctly merges with
 * persisted entries in chrome.storage.local, even after service worker
 * idle restart (where module-scope variables reset to defaults).
 *
 * The log buffer contract:
 *   - logBuffer is the in-memory ground truth during SW lifetime
 *   - It is backed up to storage.local['logBuffer'] on every mutation
 *   - On SW restart (idle wake-up), it must be restored before first use
 *   - Failing to restore causes overwrite of unflushed entries → data loss
 *   - Entries are immutable — no dedup, no sequence numbers
 *   - Watermark is timestamp-based (prune entries ≤ watermark)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome storage mock with onChanged support
// ---------------------------------------------------------------------------

function makeChromeStorageMock() {
  const changeListeners = [];
  let store = {};
  return {
    get(keys) {
      if (!keys) return Promise.resolve({ ...store });
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    },
    set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = JSON.parse(JSON.stringify(v)); // deep clone
      }
      for (const fn of changeListeners) {
        Promise.resolve().then(() => fn(changes, 'local'));
      }
      return Promise.resolve();
    },
    onChanged: {
      addListener(fn) { changeListeners.push(fn); },
    },
    _raw() { return store; },
    _seed(obj) { store = JSON.parse(JSON.stringify(obj)); },
  };
}

// ---------------------------------------------------------------------------
// Extract log buffer logic from background.js for unit testing.
// This mirrors the module-scope state and functions exactly.
// ---------------------------------------------------------------------------

function createLogBuffer(storageLocal) {
  let logBuffer = null; // null = not yet restored

  async function ensureLogBuffer() {
    if (logBuffer !== null) return;
    const { logBuffer: stored = [] } = await storageLocal.get(['logBuffer']);
    logBuffer = stored;
  }

  async function appendLog(entry) {
    await ensureLogBuffer();
    logBuffer.push(entry);
    await storageLocal.set({ logBuffer });
  }

  async function appendVisit(interaction) {
    const entry = {
      timestamp: interaction.timestamp,
      url: interaction.url,
      title: interaction.title,
      slug: interaction.slug,
      intent: interaction.intent || '',
    };
    if (interaction.referrer) entry.referrer = interaction.referrer;
    await appendLog(entry);
  }

  async function handleWatermark(watermark) {
    await ensureLogBuffer();
    logBuffer = logBuffer.filter(e => e.timestamp > watermark);
    storageLocal.set({ logBuffer });
  }

  return {
    ensureLogBuffer,
    appendLog,
    appendVisit,
    handleWatermark,
    get logBuffer() { return logBuffer; },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVisit(url, timestamp) {
  return {
    url,
    title: url,
    timestamp,
    slug: url.replace(/\W/g, '-'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Log buffer', () => {
  let storage;

  beforeEach(() => {
    storage = makeChromeStorageMock();
  });

  describe('normal operation', () => {
    it('appendVisit adds entry and persists to storage.local', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendVisit(makeVisit('https://a.com', 1000));

      const { logBuffer } = await storage.get(['logBuffer']);
      expect(logBuffer).toHaveLength(1);
      expect(logBuffer[0].url).toBe('https://a.com');
      expect(logBuffer[0].timestamp).toBe(1000);
      // No action field for visits
      expect(logBuffer[0].action).toBeUndefined();
    });

    it('appendVisit does NOT deduplicate — logs are immutable', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendVisit(makeVisit('https://a.com', 1000));
      await lb.appendVisit(makeVisit('https://a.com', 2000));

      const { logBuffer } = await storage.get(['logBuffer']);
      expect(logBuffer).toHaveLength(2);
      expect(logBuffer[0].timestamp).toBe(1000);
      expect(logBuffer[1].timestamp).toBe(2000);
    });

    it('appendLog works for mutation entries with action field', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendLog({ timestamp: 1000, action: 'list_meta', id: 'test', name: 'Test' });
      await lb.appendLog({ timestamp: 2000, action: 'highlight', slug: 'a', highlight: { text: 'hello' } });

      const { logBuffer } = await storage.get(['logBuffer']);
      expect(logBuffer).toHaveLength(2);
      expect(logBuffer[0].action).toBe('list_meta');
      expect(logBuffer[1].action).toBe('highlight');
    });

    it('handleWatermark removes entries at or before watermark timestamp', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendVisit(makeVisit('https://a.com', 1000));
      await lb.appendVisit(makeVisit('https://b.com', 2000));
      await lb.appendVisit(makeVisit('https://c.com', 3000));

      await lb.handleWatermark(2000);

      expect(lb.logBuffer).toHaveLength(1);
      expect(lb.logBuffer[0].url).toBe('https://c.com');
    });

    it('ensureLogBuffer loads existing entries on first call', async () => {
      storage._seed({
        logBuffer: [
          { timestamp: 500, url: 'https://old.com', title: 'Old', slug: 'old' },
          { timestamp: 800, url: 'https://older.com', title: 'Older', slug: 'older' },
        ],
      });

      const lb = createLogBuffer(storage);
      await lb.ensureLogBuffer();

      expect(lb.logBuffer).toHaveLength(2);

      // New entry appended after restore
      await lb.appendVisit(makeVisit('https://new.com', 1000));
      expect(lb.logBuffer).toHaveLength(3);
    });
  });

  describe('SW idle restart (regression)', () => {
    it('appendVisit merges with persisted buffer on first call after wake-up', async () => {
      // Previous SW lifetime accumulated 3 entries in storage.local
      storage._seed({
        logBuffer: [
          { timestamp: 1000, url: 'https://a.com', title: 'A', slug: 'a' },
          { timestamp: 2000, url: 'https://b.com', title: 'B', slug: 'b' },
          { timestamp: 3000, url: 'https://c.com', title: 'C', slug: 'c' },
        ],
      });

      // Idle wake-up: new module scope, no explicit restore needed (lazy init)
      const lb = createLogBuffer(storage);

      // First appendVisit after wake-up — must not overwrite old entries
      await lb.appendVisit(makeVisit('https://new.com', 4000));

      const { logBuffer } = await storage.get(['logBuffer']);

      // Must have 4 entries (3 old + 1 new)
      expect(logBuffer).toHaveLength(4);
      expect(logBuffer.map(e => e.url)).toEqual([
        'https://a.com',
        'https://b.com',
        'https://c.com',
        'https://new.com',
      ]);
    });

    it('appendLog merges with persisted buffer on first call after wake-up', async () => {
      storage._seed({
        logBuffer: [
          { timestamp: 1000, url: 'https://a.com', title: 'A', slug: 'a' },
          { timestamp: 2000, action: 'list_meta', id: 'test', name: 'Test' },
        ],
      });

      const lb = createLogBuffer(storage);

      await lb.appendLog({ timestamp: 3000, action: 'highlight', slug: 'a', highlight: { text: 'hi' } });

      const { logBuffer } = await storage.get(['logBuffer']);

      // Must preserve old entries + add new one
      expect(logBuffer).toHaveLength(3);
      expect(logBuffer[0].url).toBe('https://a.com');
      expect(logBuffer[1].action).toBe('list_meta');
      expect(logBuffer[2].action).toBe('highlight');
    });
  });

  describe('mixed entry types', () => {
    it('visit entries have no action field, mutation entries have action field', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendVisit(makeVisit('https://a.com', 1000));
      await lb.appendLog({ timestamp: 2000, action: 'list_meta', id: 'test', name: 'Test' });
      await lb.appendLog({ timestamp: 3000, action: 'highlight', slug: 'a', highlight: { text: 'hi' } });
      await lb.appendLog({ timestamp: 4000, action: 'list', id: 'user/c1', op: 'clear', urls: [] });
      await lb.appendLog({ timestamp: 5000, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://gone.com'] });

      const { logBuffer } = await storage.get(['logBuffer']);
      expect(logBuffer).toHaveLength(5);

      // Visit: no action
      expect(logBuffer[0].action).toBeUndefined();
      expect(logBuffer[0].url).toBe('https://a.com');

      // Mutations: have action
      expect(logBuffer[1].action).toBe('list_meta');
      expect(logBuffer[2].action).toBe('highlight');
      expect(logBuffer[3].action).toBe('list');
      expect(logBuffer[4].action).toBe('list');
    });

    it('appendVisit preserves referrer field', async () => {
      const lb = createLogBuffer(storage);

      await lb.appendVisit({
        ...makeVisit('https://a.com', 1000),
        referrer: 'https://google.com',
      });

      const { logBuffer } = await storage.get(['logBuffer']);
      expect(logBuffer[0].referrer).toBe('https://google.com');
    });
  });
});
