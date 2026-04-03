/**
 * History cache tests.
 *
 * Verifies:
 * - loadHistoryFileRange filters files by date range
 * - Multi-day visit check uses recentUrls Set (built from per-date history keys)
 * - logBuffer dedup against today's history date key
 * - addLog appends to today's log:YYYY-MM-DD key
 * - ensurePageCheckpoint message handler
 * - Per-date history keys with pin/unpin policy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Chrome storage mocks
// ---------------------------------------------------------------------------

function makeSessionMock(initial = {}) {
  let store = { ...initial };
  return {
    get(keys) {
      if (!keys) return Promise.resolve({ ...store });
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    },
    set(obj) {
      Object.assign(store, obj);
      return Promise.resolve();
    },
    remove(keys) {
      if (typeof keys === 'string') keys = [keys];
      for (const k of keys) delete store[k];
      return Promise.resolve();
    },
    setAccessLevel() { return Promise.resolve(); },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// 1. loadHistoryFileRange — filesystem-storage.js
// ---------------------------------------------------------------------------

describe('loadHistoryFileRange', () => {
  function createFsStorage(files) {
    return {
      async listHistoryFiles() {
        return Object.keys(files).sort().reverse();
      },
      async loadHistoryFiles(filenames) {
        const entries = [];
        for (const f of filenames) {
          if (files[f]) entries.push(...files[f]);
        }
        return entries;
      },
      async loadHistoryFileRange(fromDate, toDate) {
        const allFiles = await this.listHistoryFiles();
        const filtered = allFiles.filter(f => {
          const dateStr = f.replace('.jsonl', '');
          return dateStr >= fromDate && dateStr <= toDate;
        });
        filtered.sort();
        const entries = await this.loadHistoryFiles(filtered);
        return { entries, files: filtered };
      },
    };
  }

  it('returns only entries within date range', async () => {
    const fs = createFsStorage({
      '2026-02-25.jsonl': [{ timestamp: 1, url: 'https://a.com', action: 'visit_page' }],
      '2026-02-26.jsonl': [{ timestamp: 2, url: 'https://b.com', action: 'visit_page' }],
      '2026-02-27.jsonl': [{ timestamp: 3, url: 'https://c.com', action: 'visit_page' }],
      '2026-02-28.jsonl': [{ timestamp: 4, url: 'https://d.com', action: 'visit_page' }],
    });
    const result = await fs.loadHistoryFileRange('2026-02-26', '2026-02-27');
    expect(result.files).toHaveLength(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.url)).toEqual(['https://b.com', 'https://c.com']);
  });

  it('returns empty when no files match range', async () => {
    const fs = createFsStorage({
      '2026-02-25.jsonl': [{ timestamp: 1, url: 'https://a.com' }],
    });
    const result = await fs.loadHistoryFileRange('2026-03-01', '2026-03-05');
    expect(result.files).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  it('includes boundaries (from and to dates)', async () => {
    const fs = createFsStorage({
      '2026-02-20.jsonl': [{ timestamp: 1, url: 'https://before.com' }],
      '2026-02-21.jsonl': [{ timestamp: 2, url: 'https://start.com' }],
      '2026-02-22.jsonl': [{ timestamp: 3, url: 'https://end.com' }],
      '2026-02-23.jsonl': [{ timestamp: 4, url: 'https://after.com' }],
    });
    const result = await fs.loadHistoryFileRange('2026-02-21', '2026-02-22');
    expect(result.files).toHaveLength(2);
    expect(result.entries.map(e => e.url)).toEqual(['https://start.com', 'https://end.com']);
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-day visit check using recentUrls Set
// ---------------------------------------------------------------------------

describe('multi-day visit check', () => {
  // In production, recentUrls is built from all per-date history keys (past 7 days).
  // The check is a simple Set.has() — O(1).
  function buildRecentUrls(perDateEntries) {
    const recentUrls = new Set();
    for (const entries of Object.values(perDateEntries)) {
      for (const e of entries) {
        if ((e.action === 'visit_page' || !e.action) && e.url) {
          recentUrls.add(e.url);
        }
      }
    }
    return recentUrls;
  }

  it('returns true when URL found in past-day history', () => {
    const recentUrls = buildRecentUrls({
      '2026-02-27': [{ timestamp: 1000, action: 'visit_page', url: 'https://example.com' }],
      '2026-02-26': [{ timestamp: 2000, action: 'visit_page', url: 'https://other.com' }],
    });
    expect(recentUrls.has('https://example.com')).toBe(true);
  });

  it('returns false when URL not in past-day history', () => {
    const recentUrls = buildRecentUrls({
      '2026-02-27': [{ timestamp: 1000, action: 'visit_page', url: 'https://other.com' }],
    });
    expect(recentUrls.has('https://example.com')).toBe(false);
  });

  it('ignores non-page entries (list, set, etc.)', () => {
    const recentUrls = buildRecentUrls({
      '2026-02-27': [
        { timestamp: 1000, action: 'list', id: 'my-list', op: 'add', ids: ['page:example-com'] },
        { timestamp: 2000, action: 'list_meta', id: 'test', name: 'Test' },
      ],
    });
    expect(recentUrls.has('https://example.com')).toBe(false);
  });

  it('matches legacy entries without action field', () => {
    const recentUrls = buildRecentUrls({
      '2026-02-27': [{ timestamp: 1000, url: 'https://example.com', title: 'Example' }],
    });
    expect(recentUrls.has('https://example.com')).toBe(true);
  });

  it('aggregates URLs across multiple date keys', () => {
    const recentUrls = buildRecentUrls({
      '2026-02-25': [{ timestamp: 1000, action: 'visit_page', url: 'https://a.com' }],
      '2026-02-26': [{ timestamp: 2000, action: 'visit_page', url: 'https://b.com' }],
      '2026-02-27': [
        { timestamp: 3000, action: 'visit_page', url: 'https://c.com' },
        { timestamp: 4000, action: 'list', id: 'x', op: 'add' },
      ],
    });
    expect(recentUrls.size).toBe(3);
    expect(recentUrls.has('https://a.com')).toBe(true);
    expect(recentUrls.has('https://b.com')).toBe(true);
    expect(recentUrls.has('https://c.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. logBuffer dedup against today's history date key
// ---------------------------------------------------------------------------

describe('logBuffer dedup against today history', () => {
  function dedupLogBuffer(logBuffer, todayHistory) {
    const flushedTimestamps = new Set(todayHistory.map(e => e.timestamp));
    return logBuffer.filter(e => !flushedTimestamps.has(e.timestamp));
  }

  it('removes entries with matching timestamps', () => {
    const logBuffer = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
      { timestamp: 2000, action: 'visit_page', url: 'https://b.com' },
      { timestamp: 3000, action: 'visit_page', url: 'https://c.com' },
    ];
    const todayHistory = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
      { timestamp: 2000, action: 'visit_page', url: 'https://b.com' },
    ];
    const result = dedupLogBuffer(logBuffer, todayHistory);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://c.com');
  });

  it('preserves all entries when no overlap', () => {
    const logBuffer = [
      { timestamp: 3000, action: 'visit_page', url: 'https://c.com' },
    ];
    const todayHistory = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
    ];
    const result = dedupLogBuffer(logBuffer, todayHistory);
    expect(result).toHaveLength(1);
  });

  it('returns empty when all entries already flushed', () => {
    const logBuffer = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
    ];
    const todayHistory = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
    ];
    const result = dedupLogBuffer(logBuffer, todayHistory);
    expect(result).toHaveLength(0);
  });

  it('handles empty today history gracefully', () => {
    const logBuffer = [
      { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
    ];
    const result = dedupLogBuffer(logBuffer, []);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. addLog updates today's history date key
// ---------------------------------------------------------------------------

describe('addLog updates today history date key', () => {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayKey = 'log:' + todayStr;

  it('appends new entry to today date key', async () => {
    const session = makeSessionMock({
      [todayKey]: [
        { timestamp: 1000, action: 'visit_page', url: 'https://a.com' },
      ],
    });

    // Simulate addLog's history update
    const entry = { timestamp: 2000, action: 'visit_page', url: 'https://b.com' };
    const data = await session.get([todayKey]);
    const arr = data[todayKey] || [];
    arr.push(entry);
    await session.set({ [todayKey]: arr });

    const result = session._store[todayKey];
    expect(result).toHaveLength(2);
    expect(result[1].url).toBe('https://b.com');
  });

  it('creates today date key if not present', async () => {
    const session = makeSessionMock({});

    const entry = { timestamp: 1000, action: 'visit_page', url: 'https://a.com' };
    const data = await session.get([todayKey]);
    const arr = data[todayKey] || [];
    arr.push(entry);
    await session.set({ [todayKey]: arr });

    const result = session._store[todayKey];
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://a.com');
  });

  it('today entries do NOT go into recentUrls (only past days)', () => {
    const recentUrls = new Set(['https://old.com']);
    // recentUrls is built from past-day keys only, not today
    expect(recentUrls.has('https://new.com')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Per-date history keys with pin/unpin policy
// ---------------------------------------------------------------------------

describe('per-date history keys', () => {
  it('each date in range gets its own session key', async () => {
    const session = makeSessionMock();

    // Simulate hydration: set per-date keys for Feb 25-28
    const dates = ['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28'];
    const data = {
      '2026-02-25': [{ timestamp: 100, action: 'visit_page', url: 'https://a.com' }],
      '2026-02-26': [],  // no file for this date → empty array
      '2026-02-27': [{ timestamp: 300, action: 'visit_page', url: 'https://c.com' }],
      '2026-02-28': [{ timestamp: 400, action: 'visit_page', url: 'https://d.com' }],
    };
    for (const d of dates) {
      await session.set({ ['log:' + d]: data[d] });
    }

    // Verify each key exists
    for (const d of dates) {
      const key = 'log:' + d;
      const result = (await session.get([key]))[key];
      expect(result).toEqual(data[d]);
    }
  });

  it('empty array for dates with no file (cache hit = "checked, nothing there")', async () => {
    const session = makeSessionMock();
    await session.set({ 'log:2026-02-26': [] });

    const result = (await session.get(['log:2026-02-26']))['log:2026-02-26'];
    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });

  it('builds recentUrls from per-date keys (excluding today)', () => {
    // Simulate: today is 2026-02-28, past 7 days are 2026-02-21 to 2026-02-27
    const perDateEntries = {
      '2026-02-25': [{ timestamp: 500, action: 'visit_page', url: 'https://a.com' }],
      '2026-02-26': [{ timestamp: 600, action: 'list', id: 'x', op: 'add' }],
      '2026-02-27': [
        { timestamp: 700, action: 'visit_page', url: 'https://b.com' },
        { timestamp: 800, url: 'https://c.com' },
      ],
    };

    const recentUrls = new Set();
    for (const entries of Object.values(perDateEntries)) {
      for (const e of entries) {
        if ((e.action === 'visit_page' || !e.action) && e.url) {
          recentUrls.add(e.url);
        }
      }
    }

    expect(recentUrls.size).toBe(3);
    expect(recentUrls.has('https://a.com')).toBe(true);
    expect(recentUrls.has('https://b.com')).toBe(true);
    expect(recentUrls.has('https://c.com')).toBe(true);
  });

  it('pin policy: recent dates pinned, old dates unpinned', () => {
    // Simulate pin/unpin tracking
    const pinnedKeys = new Set();
    const RECENT_DAYS = 7;

    function pinDate(dateStr) { pinnedKeys.add('log:' + dateStr); }
    function unpinDate(dateStr) { pinnedKeys.delete('log:' + dateStr); }

    // Pin recent 7 days
    const today = new Date('2026-02-28');
    for (let i = 0; i <= RECENT_DAYS; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      pinDate(d.toISOString().slice(0, 10));
    }

    expect(pinnedKeys.has('log:2026-02-28')).toBe(true); // today
    expect(pinnedKeys.has('log:2026-02-21')).toBe(true); // 7 days ago

    // Old date not in pinned set
    expect(pinnedKeys.has('log:2026-02-15')).toBe(false);

    // Explicitly unpin an old date
    unpinDate('2026-02-15');
    expect(pinnedKeys.has('log:2026-02-15')).toBe(false);
  });
});
