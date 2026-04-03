/**
 * Log buffer overflow tests.
 *
 * Verifies that the log buffer is bounded and handles
 * chrome.storage.local.set() quota failures gracefully.
 *
 * The overflow contract:
 *   - logBuffer has a max size (LOG_BUFFER_MAX_SIZE)
 *   - When over limit, drained entries (ts <= watermark) are dropped first
 *   - If still over limit, oldest entries are dropped (bounded data loss)
 *   - storage.local.set() failures do not lose the in-memory entry
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome storage.local mock with controllable quota failure
// ---------------------------------------------------------------------------

function makeChromeStorageMock({ failOnLargePayload = false, maxEntries = Infinity } = {}) {
  let store = {};
  let failNext = 0;
  return {
    get(keys) {
      if (!keys) return Promise.resolve({ ...store });
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    },
    set(obj) {
      if (failNext > 0) {
        failNext--;
        return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
      }
      if (failOnLargePayload && obj.logBuffer && obj.logBuffer.length > maxEntries) {
        return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
      }
      for (const [k, v] of Object.entries(obj)) {
        store[k] = JSON.parse(JSON.stringify(v));
      }
      return Promise.resolve();
    },
    onChanged: { addListener: vi.fn() },
    _raw() { return store; },
    _seed(obj) { store = JSON.parse(JSON.stringify(obj)); },
    _failNextSets(n) { failNext = n; },
  };
}

// ---------------------------------------------------------------------------
// Extract log buffer logic with overflow handling.
// Mirrors background.js appendLog after the fix.
// ---------------------------------------------------------------------------

const LOG_BUFFER_MAX_SIZE = 2000;

function createLogBuffer(storageLocal) {
  let logBuffer = null;
  let persistWatermark = 0;

  async function ensureLogBuffer() {
    if (logBuffer !== null) return;
    const { logBuffer: stored = [] } = await storageLocal.get(['logBuffer']);
    logBuffer = stored;
  }

  async function appendLog(entry) {
    await ensureLogBuffer();
    logBuffer.push(entry);

    // Cap enforcement
    if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
      const before = logBuffer.length;
      // First pass: drop entries already persisted to disk
      logBuffer = logBuffer.filter(e => e.timestamp > persistWatermark);
      if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
        // Still over limit — drop oldest (bounded data loss)
        logBuffer = logBuffer.slice(logBuffer.length - LOG_BUFFER_MAX_SIZE);
      }
      console.warn(`logBuffer capped: ${before} → ${logBuffer.length}`);
    }

    try {
      await storageLocal.set({ logBuffer });
    } catch (e) {
      console.warn('logBuffer persist failed (quota?):', e.message);
      // In-memory buffer still has the entry
    }
  }

  function setWatermark(ts) {
    persistWatermark = ts;
  }

  async function handleWatermark(watermark) {
    await ensureLogBuffer();
    logBuffer = logBuffer.filter(e => e.timestamp > watermark);
    persistWatermark = watermark;
    storageLocal.set({ logBuffer });
  }

  return {
    ensureLogBuffer,
    appendLog,
    handleWatermark,
    setWatermark,
    get logBuffer() { return logBuffer; },
    LOG_BUFFER_MAX_SIZE,
  };
}

function makeEntry(timestamp) {
  return { timestamp, action: 'visit_page', url: `https://example.com/${timestamp}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Log buffer overflow', () => {
  let storage;

  beforeEach(() => {
    storage = makeChromeStorageMock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('logBuffer is bounded at LOG_BUFFER_MAX_SIZE', async () => {
    const lb = createLogBuffer(storage);

    // Pre-seed with MAX entries
    const seedEntries = [];
    for (let i = 0; i < LOG_BUFFER_MAX_SIZE; i++) {
      seedEntries.push(makeEntry(1000 + i));
    }
    storage._seed({ logBuffer: seedEntries });

    // Append 50 more without any drain
    for (let i = 0; i < 50; i++) {
      await lb.appendLog(makeEntry(5000 + i));
    }

    expect(lb.logBuffer.length).toBeLessThanOrEqual(LOG_BUFFER_MAX_SIZE);
  });

  it('drops drained entries (ts <= watermark) first', async () => {
    const lb = createLogBuffer(storage);

    // Seed: 1500 drained entries (ts 1-1500), 400 undrained (ts 2001-2400)
    const seedEntries = [];
    for (let i = 1; i <= 1500; i++) seedEntries.push(makeEntry(i));
    for (let i = 2001; i <= 2400; i++) seedEntries.push(makeEntry(i));
    storage._seed({ logBuffer: seedEntries });
    lb.setWatermark(1500); // entries ts<=1500 are on disk

    // Append enough to trigger cap
    for (let i = 0; i < 200; i++) {
      await lb.appendLog(makeEntry(3000 + i));
    }

    // All entries should have ts > 1500 (drained ones dropped)
    expect(lb.logBuffer.length).toBeLessThanOrEqual(LOG_BUFFER_MAX_SIZE);
    for (const e of lb.logBuffer) {
      expect(e.timestamp).toBeGreaterThan(1500);
    }
  });

  it('chrome.storage.local.set QuotaExceededError is caught gracefully', async () => {
    const lb = createLogBuffer(storage);

    // Seed some entries
    for (let i = 0; i < 5; i++) {
      await lb.appendLog(makeEntry(1000 + i));
    }

    // Next set will fail
    storage._failNextSets(1);

    // Should not throw
    await lb.appendLog(makeEntry(2000));

    // In-memory buffer still has the entry
    expect(lb.logBuffer.some(e => e.timestamp === 2000)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('persist failed'),
      expect.any(String)
    );
  });

  it('appendLog works normally after overflow recovery', async () => {
    const lb = createLogBuffer(storage);

    // Fill to cap with drained entries
    const seedEntries = [];
    for (let i = 0; i < LOG_BUFFER_MAX_SIZE; i++) {
      seedEntries.push(makeEntry(1000 + i));
    }
    storage._seed({ logBuffer: seedEntries });
    lb.setWatermark(LOG_BUFFER_MAX_SIZE + 1000); // all are drained

    // Trigger overflow + cap
    await lb.appendLog(makeEntry(9000));
    expect(lb.logBuffer.length).toBeLessThanOrEqual(LOG_BUFFER_MAX_SIZE);

    // Simulate drain clearing the buffer
    await lb.handleWatermark(9000);
    expect(lb.logBuffer.length).toBe(0);

    // Append normally
    await lb.appendLog(makeEntry(10000));
    expect(lb.logBuffer.length).toBe(1);
    expect(lb.logBuffer[0].timestamp).toBe(10000);

    // Verify persisted
    const { logBuffer } = await storage.get(['logBuffer']);
    expect(logBuffer).toHaveLength(1);
  });
});
