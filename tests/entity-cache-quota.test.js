/**
 * Entity cache quota tests.
 *
 * Verifies that cacheSet() handles QuotaExceededError from
 * chrome.storage.session.set() by performing emergency eviction
 * of unpinned keys, then retrying.
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
  let cacheGet, cacheSet, cacheRemove, cachePin, cacheUnpin, setEntityCacheWatermark, cacheClear;

  beforeEach(async () => {
    session = makeSessionMock();
    globalThis.chrome = {
      storage: {
        session,
        local: { get: vi.fn(), set: vi.fn(), onChanged: { addListener: vi.fn() } },
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
  });

  afterEach(() => {
    delete globalThis.chrome;
    vi.resetModules();
  });

  // Helper: populate cache with unpinned page entries
  async function seedUnpinnedEntries(count, { timestampBase = 1000, pinned = false } = {}) {
    for (let i = 0; i < count; i++) {
      const key = `page:seed-${i}`;
      await cacheSet(key, { slug: `seed-${i}`, timestamps: { dev: timestampBase + i } }, { timestamp: timestampBase + i });
      if (pinned) cachePin(key);
    }
  }

  it('catches QuotaExceededError, emergency-evicts, retries successfully', async () => {
    // Set watermark so entries are considered flushed (safe to evict)
    setEntityCacheWatermark(5000);
    // Seed 10 unpinned entries with timestamps below watermark
    await seedUnpinnedEntries(10, { timestampBase: 1000 });

    // Next set() call will fail once, then succeed on retry
    session._failNextSets(1);

    // This should not throw — emergency eviction should free space
    await cacheSet('page:new-big', { slug: 'new-big', data: 'x'.repeat(100) });

    // Verify the new entry is in cache
    const result = await cacheGet('page:new-big');
    expect(result).not.toBeNull();
    expect(result.slug).toBe('new-big');

    // Verify some entries were evicted (store should have fewer keys)
    const store = session._raw();
    const remainingKeys = Object.keys(store);
    expect(remainingKeys).toContain('page:new-big');
    // At least some seed entries should have been evicted
    const seedKeys = remainingKeys.filter(k => k.startsWith('page:seed-'));
    expect(seedKeys.length).toBeLessThan(10);
  });

  it('evicts unflushed entries as last resort when flushed entries exhausted', async () => {
    // Watermark at 500 — entries 1000+ are unflushed
    setEntityCacheWatermark(500);
    // Seed 5 entries with timestamps ABOVE watermark (unflushed)
    await seedUnpinnedEntries(5, { timestampBase: 1000 });

    // Fail twice: first retry after flushed eviction (no flushed entries), second after unflushed eviction
    session._failNextSets(2);

    await cacheSet('page:desperate', { slug: 'desperate' });
    const result = await cacheGet('page:desperate');
    expect(result).not.toBeNull();
    expect(result.slug).toBe('desperate');
  });

  it('never evicts pinned keys during emergency eviction', async () => {
    setEntityCacheWatermark(5000);
    // Seed pinned entries
    await seedUnpinnedEntries(5, { timestampBase: 1000, pinned: true });
    // Also seed some unpinned entries
    for (let i = 0; i < 3; i++) {
      await cacheSet(`page:unpinned-${i}`, { slug: `unpinned-${i}` }, { timestamp: 2000 + i });
    }

    session._failNextSets(1);
    await cacheSet('page:new', { slug: 'new' });

    // All pinned entries should still be in cache
    for (let i = 0; i < 5; i++) {
      const val = await cacheGet(`page:seed-${i}`);
      expect(val).not.toBeNull();
    }
  });

  it('throws meaningful error when eviction is exhausted', async () => {
    setEntityCacheWatermark(5000);
    // Only pinned keys — nothing to evict
    await seedUnpinnedEntries(3, { timestampBase: 1000, pinned: true });

    // Always fail
    session._failNextSets(100);

    await expect(
      cacheSet('page:hopeless', { slug: 'hopeless' })
    ).rejects.toThrow(/quota/i);
  });
});
