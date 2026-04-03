/**
 * Concurrent addLog tests.
 *
 * Verifies that concurrent addLog calls are properly serialized
 * via withLock and that a timeout prevents permanent deadlock.
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// withLock with timeout — extracted from background.js
// ---------------------------------------------------------------------------

function createLockManager(timeoutMs = 30000) {
  const rwLocks = new Map();

  function withLock(key, fn) {
    const prev = rwLocks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`withLock('${key}') timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        fn().then(
          (result) => { clearTimeout(timer); resolve(result); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });
    });
    rwLocks.set(key, next);
    next.catch(() => {}).then(() => {
      if (rwLocks.get(key) === next) rwLocks.delete(key);
    });
    return next;
  }

  return { withLock, _locks: rwLocks };
}

// ---------------------------------------------------------------------------
// Simplified addLog that exercises the lock + buffer + effectOf path
// ---------------------------------------------------------------------------

function createAddLogEngine({ effectOfDelay = 0, effectOfFn, lockTimeout } = {}) {
  const { withLock, _locks } = createLockManager(lockTimeout);
  const logBuffer = [];
  const sessionCache = new Map();
  const storageSets = [];

  async function defaultEffectOf(entry) {
    if (effectOfDelay > 0) await new Promise(r => setTimeout(r, effectOfDelay));
    const slug = entry.url.replace(/[^a-z0-9]/gi, '-');
    const key = 'page:' + slug;
    const existing = sessionCache.get(key) || { slug, visitCount: 0 };
    existing.visitCount++;
    if (entry.title) existing.title = entry.title;
    return { [key]: existing };
  }

  const effectOf = effectOfFn || defaultEffectOf;

  async function addLog(entry) {
    await withLock('logBuffer', async () => {
      logBuffer.push(entry);
      storageSets.push([...logBuffer]);
      const effects = await effectOf(entry);
      for (const [key, entity] of Object.entries(effects)) {
        sessionCache.set(key, entity);
      }
    });
  }

  return {
    addLog,
    get logBuffer() { return logBuffer; },
    get sessionCache() { return sessionCache; },
    get storageSets() { return storageSets; },
    _locks,
  };
}

function makeEntry(ts, url) {
  return { timestamp: ts, action: 'visit_page', url: url || `https://example.com/${ts}`, title: 'Page ' + ts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Concurrent addLog', () => {
  it('5 concurrent addLog calls for same URL all succeed', async () => {
    const engine = createAddLogEngine();
    const url = 'https://example.com/same';

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(engine.addLog(makeEntry(1000 + i, url)));
    }

    await Promise.all(promises);

    // All 5 entries in buffer
    expect(engine.logBuffer).toHaveLength(5);
    // Final page entity has visitCount = 5
    const slug = url.replace(/[^a-z0-9]/gi, '-');
    const page = engine.sessionCache.get('page:' + slug);
    expect(page.visitCount).toBe(5);
  });

  it('5 concurrent addLog calls for different URLs all succeed', async () => {
    const engine = createAddLogEngine();

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(engine.addLog(makeEntry(1000 + i, `https://site${i}.com`)));
    }

    await Promise.all(promises);

    expect(engine.logBuffer).toHaveLength(5);
    // Each URL has its own page entity
    for (let i = 0; i < 5; i++) {
      const slug = `https://site${i}.com`.replace(/[^a-z0-9]/gi, '-');
      const page = engine.sessionCache.get('page:' + slug);
      expect(page).not.toBeUndefined();
      expect(page.visitCount).toBe(1);
    }
  });

  it('serialization is maintained — each addLog sees previous writes', async () => {
    const engine = createAddLogEngine();
    const url = 'https://example.com/serial';

    // Issue 3 concurrent calls
    const promises = [
      engine.addLog(makeEntry(1000, url)),
      engine.addLog(makeEntry(2000, url)),
      engine.addLog(makeEntry(3000, url)),
    ];

    await Promise.all(promises);

    // Each storageSets call should have incrementally more entries
    // (proof that lock serializes — each call sees the prior push)
    expect(engine.storageSets[0]).toHaveLength(1);
    expect(engine.storageSets[1]).toHaveLength(2);
    expect(engine.storageSets[2]).toHaveLength(3);
  });

  it('lock timeout rejects stuck calls', async () => {
    vi.useRealTimers(); // real timers for this test — short timeout
    const SHORT_TIMEOUT = 100; // ms

    let stuckResolve;
    const engine = createAddLogEngine({
      lockTimeout: SHORT_TIMEOUT,
      effectOfFn: async (entry) => {
        if (entry.timestamp === 9999) {
          await new Promise(r => { stuckResolve = r; });
        }
        const slug = entry.url.replace(/[^a-z0-9]/gi, '-');
        return { ['page:' + slug]: { slug, visitCount: 1 } };
      },
    });

    // First call will hang (but pushes to buffer before effectOf hangs)
    const stuckPromise = engine.addLog(makeEntry(9999, 'https://stuck.com'));
    // Second call is queued behind it
    const normalPromise = engine.addLog(makeEntry(1000, 'https://ok.com'));

    // Stuck call should reject with timeout
    await expect(stuckPromise).rejects.toThrow(/timed out/);

    // Normal call should succeed after the stuck lock times out
    await expect(normalPromise).resolves.toBeUndefined();

    // Both entries are in the buffer: the stuck call pushed before hanging,
    // and the normal call pushed after the timeout freed the lock
    expect(engine.logBuffer).toHaveLength(2);
    expect(engine.logBuffer.some(e => e.timestamp === 1000)).toBe(true);

    // Clean up: resolve the hung promise and drain lock chain
    if (stuckResolve) stuckResolve();
    for (const p of engine._locks.values()) await p.catch(() => {});
  });
});
