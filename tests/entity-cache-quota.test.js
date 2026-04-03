/**
 * Entity cache quota tests.
 *
 * Verifies that cacheSet() handles QuotaExceededError from
 * chrome.storage.session.set() by performing emergency eviction
 * (including pinned-but-clean keys), then retrying. If retry still
 * fails, fires the onQuotaExhausted callback instead of throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome storage.session mock with controllable quota failure
// ---------------------------------------------------------------------------

function makeSessionMock() {
  let store = {};
  let failNext = 0; // number of set() calls that will throw QuotaExceededError

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
        const err = new DOMException('Quota exceeded', 'QuotaExceededError');
        return Promise.reject(err);
      }
      for (const [k, v] of Object.entries(obj)) {
        store[k] = JSON.parse(JSON.stringify(v));
      }
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
    setAccessLevel() { return Promise.resolve(); },
    // Test helpers
    _raw() { return store; },
    _seed(obj) { store = JSON.parse(JSON.stringify(obj)); },
    _failNextSets(n) { failNext = n; },
  };
}

describe('entity-cache quota handling', () => {
  let session;
  let cacheGet, cacheSet, cacheRemove, cachePin, cacheUnpin,
      setEntityCacheWatermark, cacheClear, setQuotaExhaustedCallback;

  beforeEach(async () => {
    session = makeSessionMock();
    globalThis.chrome = {
      storage: {
        session,
        local: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } },
        onChanged: { addListener: vi.fn() },
      },
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
      },
    };
    vi.resetModules();
    const mod = await import('../extension/entity-cache.js');
    cacheGet = mod.cacheGet;
    cacheSet = mod.cacheSet;
    cacheRemove = mod.cacheRemove;
    cachePin = mod.cachePin;
    cacheUnpin = mod.cacheUnpin;
    setEntityCacheWatermark = mod.setEntityCacheWatermark;
    cacheClear = mod.cacheClear;
    setQuotaExhaustedCallback = mod.setQuotaExhaustedCallback;
  });

  afterEach(() => {
    delete globalThis.chrome;
    vi.resetModules();
  });

  // Helper: populate cache with entries
  async function seedEntries(count, { timestampBase = 1000, pinned = false } = {}) {
    for (let i = 0; i < count; i++) {
      const key = `page:seed-${i}`;
      await cacheSet(key, { slug: `seed-${i}`, timestamps: { dev: timestampBase + i } }, { timestamp: timestampBase + i });
      if (pinned) cachePin(key);
    }
  }

  it('catches QuotaExceededError, emergency-evicts, retries successfully', async () => {
    setEntityCacheWatermark(5000);
    await seedEntries(10, { timestampBase: 1000 });

    session._failNextSets(1);

    await cacheSet('page:new-big', { slug: 'new-big', data: 'x'.repeat(100) });

    const result = await cacheGet('page:new-big');
    expect(result).not.toBeNull();
    expect(result.slug).toBe('new-big');

    const store = session._raw();
    const seedKeys = Object.keys(store).filter(k => k.startsWith('page:seed-'));
    expect(seedKeys.length).toBeLessThan(10);
  });

  it('evicts pinned-but-clean keys during emergency eviction', async () => {
    setEntityCacheWatermark(5000);
    // Seed pinned entries with timestamps below watermark (clean/flushed)
    await seedEntries(5, { timestampBase: 1000, pinned: true });

    session._failNextSets(1);
    await cacheSet('page:new', { slug: 'new' });

    // Pinned-but-clean entries should have been evicted
    const store = session._raw();
    const seedKeys = Object.keys(store).filter(k => k.startsWith('page:seed-'));
    expect(seedKeys.length).toBe(0);

    // New entry should exist
    const result = await cacheGet('page:new');
    expect(result).not.toBeNull();
  });

  it('protects dirty entries (above watermark) even during emergency eviction', async () => {
    // Watermark at 500 — entries at 1000+ are dirty/unflushed
    setEntityCacheWatermark(500);
    await seedEntries(3, { timestampBase: 1000 });

    // Also add some flushed entries
    await seedEntries(3, { timestampBase: 100 });

    session._failNextSets(1);
    await cacheSet('page:new', { slug: 'new' });

    // Dirty entries (timestampBase 1000) should still be in cache
    // (flushed entries at 100 got evicted to make room)
    const result = await cacheGet('page:new');
    expect(result).not.toBeNull();
  });

  it('fires onQuotaExhausted callback when retry also fails', async () => {
    const callback = vi.fn();
    setQuotaExhaustedCallback(callback);

    setEntityCacheWatermark(500);
    // Only dirty entries — nothing to evict
    await seedEntries(3, { timestampBase: 1000 });

    // Always fail
    session._failNextSets(100);

    // Should NOT throw — should call callback instead
    await cacheSet('page:hopeless', { slug: 'hopeless' });

    expect(callback).toHaveBeenCalledTimes(1);

    // The failed write should not be in cache
    const result = await cacheGet('page:hopeless');
    expect(result).toBeNull();
  });

  it('does not fire callback when no callback is registered (silent return)', async () => {
    // No callback registered
    setEntityCacheWatermark(500);
    await seedEntries(3, { timestampBase: 1000 });

    session._failNextSets(100);

    // Should not throw even without callback
    await cacheSet('page:hopeless', { slug: 'hopeless' });

    const result = await cacheGet('page:hopeless');
    expect(result).toBeNull();
  });
});
