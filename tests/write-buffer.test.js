/**
 * Write buffer tests.
 *
 * Verifies that the background's write buffer correctly merges with
 * persisted entries in chrome.storage.local, even after service worker
 * idle restart (where module-scope variables reset to defaults).
 *
 * The write buffer contract:
 *   - pendingWrites is the in-memory ground truth during SW lifetime
 *   - It is backed up to storage.local['writeBuffer'] on every mutation
 *   - On SW restart (idle wake-up), it must be restored before first use
 *   - Failing to restore causes overwrite of unflushed entries → data loss
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
      // Fire onChanged listeners asynchronously
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
// Extract write buffer logic from background.js for unit testing.
// This mirrors the module-scope state and functions exactly.
// ---------------------------------------------------------------------------

function createWriteBuffer(storageLocal) {
  let pendingWrites = null; // null = not yet restored
  let writeSeq = 0;

  async function ensureWriteBuffer() {
    if (pendingWrites !== null) return;
    const { writeBuffer = [] } = await storageLocal.get(['writeBuffer']);
    pendingWrites = writeBuffer;
    writeSeq = pendingWrites.reduce((max, e) => Math.max(max, e.id || 0), writeSeq);
  }

  async function enqueueInteraction(entry) {
    await ensureWriteBuffer();
    const url = entry.interaction.url;
    const idx = pendingWrites.findIndex(
      e => e.type === 'interaction' && e.entry?.interaction?.url === url
    );
    if (idx !== -1) {
      pendingWrites[idx] = { ...pendingWrites[idx], entry };
    } else {
      pendingWrites.push({ id: ++writeSeq, type: 'interaction', entry });
    }
    storageLocal.set({ writeBuffer: pendingWrites });
  }

  async function bufferWrite(entry) {
    await ensureWriteBuffer();
    entry.id = ++writeSeq;
    if (entry.type === 'json') {
      const idx = pendingWrites.findIndex(e => e.type === 'json' && e.path === entry.path);
      if (idx !== -1) pendingWrites[idx] = entry;
      else pendingWrites.push(entry);
    } else {
      pendingWrites.push(entry);
    }
    await storageLocal.set({ writeBuffer: pendingWrites });
  }

  async function handleWatermark(watermark) {
    await ensureWriteBuffer();
    pendingWrites = pendingWrites.filter(e => e.id > watermark);
    storageLocal.set({ writeBuffer: pendingWrites });
  }

  return {
    ensureWriteBuffer,
    enqueueInteraction,
    bufferWrite,
    handleWatermark,
    get pendingWrites() { return pendingWrites; },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInteractionEntry(url, timestamp) {
  return {
    interaction: { url, title: url, timestamp, slug: url.replace(/\W/g, '-'), intent: '', attention: '' },
    markdown: '',
    html: '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Write buffer', () => {
  let storage;

  beforeEach(() => {
    storage = makeChromeStorageMock();
  });

  describe('normal operation', () => {
    it('enqueueInteraction adds entry and persists to storage.local', async () => {
      const wb = createWriteBuffer(storage);

      await wb.enqueueInteraction(makeInteractionEntry('https://a.com', 1000));

      const { writeBuffer } = await storage.get(['writeBuffer']);
      expect(writeBuffer).toHaveLength(1);
      expect(writeBuffer[0].type).toBe('interaction');
      expect(writeBuffer[0].entry.interaction.url).toBe('https://a.com');
    });

    it('enqueueInteraction deduplicates by URL (updates existing)', async () => {
      const wb = createWriteBuffer(storage);

      await wb.enqueueInteraction(makeInteractionEntry('https://a.com', 1000));
      await wb.enqueueInteraction(makeInteractionEntry('https://a.com', 2000));

      const { writeBuffer } = await storage.get(['writeBuffer']);
      expect(writeBuffer).toHaveLength(1);
      expect(writeBuffer[0].entry.interaction.timestamp).toBe(2000);
    });

    it('ensureWriteBuffer loads existing entries and continues sequence', async () => {
      storage._seed({
        writeBuffer: [
          { id: 5, type: 'interaction', entry: makeInteractionEntry('https://old.com', 500) },
          { id: 8, type: 'interaction', entry: makeInteractionEntry('https://older.com', 300) },
        ],
      });

      const wb = createWriteBuffer(storage);
      await wb.ensureWriteBuffer();

      expect(wb.pendingWrites).toHaveLength(2);

      // New entry should get id > 8
      await wb.enqueueInteraction(makeInteractionEntry('https://new.com', 1000));
      expect(wb.pendingWrites).toHaveLength(3);
      expect(wb.pendingWrites[2].id).toBeGreaterThan(8);
    });

    it('handleWatermark removes flushed entries', async () => {
      const wb = createWriteBuffer(storage);
      await wb.enqueueInteraction(makeInteractionEntry('https://a.com', 1000));
      await wb.enqueueInteraction(makeInteractionEntry('https://b.com', 2000));
      await wb.enqueueInteraction(makeInteractionEntry('https://c.com', 3000));

      // Flush entries with id <= 2
      await wb.handleWatermark(2);

      expect(wb.pendingWrites).toHaveLength(1);
      expect(wb.pendingWrites[0].entry.interaction.url).toBe('https://c.com');
    });
  });

  describe('SW idle restart (regression)', () => {
    it('enqueueInteraction merges with persisted buffer on first call after wake-up', async () => {
      // Previous SW lifetime accumulated 3 entries in storage.local
      storage._seed({
        writeBuffer: [
          { id: 1, type: 'interaction', entry: makeInteractionEntry('https://a.com', 1000) },
          { id: 2, type: 'interaction', entry: makeInteractionEntry('https://b.com', 2000) },
          { id: 3, type: 'interaction', entry: makeInteractionEntry('https://c.com', 3000) },
        ],
      });

      // Idle wake-up: new module scope, no explicit restore needed (lazy init)
      const wb = createWriteBuffer(storage);

      // First enqueueInteraction after wake-up — must not overwrite old entries
      await wb.enqueueInteraction(makeInteractionEntry('https://new.com', 4000));

      const { writeBuffer } = await storage.get(['writeBuffer']);

      // Must have 4 entries (3 old + 1 new)
      expect(writeBuffer).toHaveLength(4);
      expect(writeBuffer.map(e => e.entry.interaction.url)).toEqual(
        expect.arrayContaining([
          'https://a.com',
          'https://b.com',
          'https://c.com',
          'https://new.com',
        ])
      );
    });

    it('bufferWrite merges with persisted buffer on first call after wake-up', async () => {
      // Previous SW lifetime had a json write and interaction pending
      storage._seed({
        writeBuffer: [
          { id: 1, type: 'json', path: 'atoms/page1.json', data: { highlights: ['h1'] } },
          { id: 2, type: 'interaction', entry: makeInteractionEntry('https://a.com', 1000) },
        ],
      });

      // Idle wake-up: no explicit restore needed
      const wb = createWriteBuffer(storage);

      await wb.bufferWrite({ type: 'snapshot', slug: 'test', timestamp: 5000, markdown: '# hi', html: '<h1>hi</h1>' });

      const { writeBuffer } = await storage.get(['writeBuffer']);

      // Must preserve old entries + add new one
      expect(writeBuffer).toHaveLength(3);
      expect(writeBuffer.some(e => e.type === 'json')).toBe(true);
      expect(writeBuffer.some(e => e.type === 'interaction')).toBe(true);
      expect(writeBuffer.some(e => e.type === 'snapshot')).toBe(true);
    });

    it('writeSeq continues from persisted max id after wake-up', async () => {
      // Previous session used ids up to 5
      storage._seed({
        writeBuffer: [
          { id: 4, type: 'interaction', entry: makeInteractionEntry('https://d.com', 4000) },
          { id: 5, type: 'interaction', entry: makeInteractionEntry('https://e.com', 5000) },
        ],
      });

      // Idle wake-up: lazy init restores writeSeq from max id
      const wb = createWriteBuffer(storage);

      await wb.enqueueInteraction(makeInteractionEntry('https://new1.com', 6000));
      await wb.enqueueInteraction(makeInteractionEntry('https://new2.com', 7000));

      const allIds = wb.pendingWrites.map(e => e.id);
      const newIds = wb.pendingWrites
        .filter(e => e.entry.interaction.url.startsWith('https://new'))
        .map(e => e.id);

      // All ids should be unique
      expect(new Set(allIds).size).toBe(allIds.length);
      // New entry ids must be > 5 (max of persisted entries)
      expect(newIds).toHaveLength(2);
      for (const id of newIds) {
        expect(id).toBeGreaterThan(5);
      }
    });
  });
});
