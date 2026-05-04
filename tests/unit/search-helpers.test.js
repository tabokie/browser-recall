import { describe, it, expect, vi } from 'vitest';
import {
  mergeQueueIntoHistory,
  getQueueContentMap,
  buildHistoryForEngine,
  extractHistoryQueue,
} from '../../apps/extension/search-helpers.js';

describe('mergeQueueIntoHistory', () => {
  it('appends new queue entries', () => {
    const entries = [{ url: 'https://a.com', timestamp: 1, slug: 'a' }];
    const queueEntries = [
      { url: 'https://b.com', title: 'B', timestamp: 2, slug: 'b' },
    ];

    mergeQueueIntoHistory(entries, queueEntries);

    expect(entries).toHaveLength(2);
    expect(entries[1].url).toBe('https://b.com');
  });

  it('deduplicates by URL (last-write-wins)', () => {
    const entries = [
      { url: 'https://a.com', timestamp: 1, title: 'old', slug: 'a' },
    ];
    const queueEntries = [
      { url: 'https://a.com', timestamp: 3, title: 'new', slug: 'a' },
    ];

    mergeQueueIntoHistory(entries, queueEntries);

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('new');
  });

  it('sorts merged result by timestamp', () => {
    const entries = [{ url: 'https://c.com', timestamp: 10, slug: 'c' }];
    const queueEntries = [
      { url: 'https://a.com', timestamp: 1, slug: 'a' },
      { url: 'https://b.com', timestamp: 5, slug: 'b' },
    ];

    mergeQueueIntoHistory(entries, queueEntries);

    expect(entries.map((i) => i.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });
});

describe('extractHistoryQueue (Desktop command queue format)', () => {
  it('extracts visit entries from connector queue command items', () => {
    const desktopCommandQueue = [
      {
        kind: 'command',
        action: 'reportVisit',
        request: {
          timestamp: 1,
          url: 'https://a.com',
          title: 'A',
        },
      },
      { kind: 'note', slug: 'note', url: 'https://a.com' },
      {
        kind: 'command',
        action: 'reportLeave',
        request: { timestamp: 2, url: 'https://a.com' },
      },
    ];

    const result = extractHistoryQueue(desktopCommandQueue);

    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.action)).toEqual([
      'visit_page',
      'leave_page',
    ]);
  });

  it('returns empty array for buffer with no visit entries', () => {
    const desktopCommandQueue = [
      { timestamp: 1, action: 'list_meta', id: 'test', name: 'Test' },
      { timestamp: 2, action: 'highlight', slug: 'x', highlight: {} },
    ];

    const result = extractHistoryQueue(desktopCommandQueue);
    expect(result).toHaveLength(0);
  });

  it('works with mergeQueueIntoHistory after extraction', () => {
    const entries = [{ url: 'https://old.com', timestamp: 1, slug: 'old' }];
    const desktopCommandQueue = [
      {
        kind: 'command',
        action: 'reportVisit',
        request: {
          timestamp: 2,
          url: 'https://new.com',
          title: 'New',
          slug: 'new',
        },
      },
      {
        kind: 'command',
        action: 'reportLeave',
        request: { timestamp: 3, url: 'https://new.com' },
      },
      { kind: 'note', slug: 'note', url: 'https://new.com' },
    ];

    const extracted = extractHistoryQueue(desktopCommandQueue);
    mergeQueueIntoHistory(entries, extracted);

    expect(entries).toHaveLength(2);
    expect(entries.map((i) => i.url)).toContain('https://new.com');
  });

  it('returns empty array for empty buffer', () => {
    const result = extractHistoryQueue([]);
    expect(result).toHaveLength(0);
  });
});

describe('getQueueContentMap', () => {
  it('returns empty map (content is on disk in event-sourced model)', () => {
    const buffer = [
      { timestamp: 1, url: 'https://a.com', title: 'A', slug: 'a' },
    ];
    const contentMap = getQueueContentMap(buffer);
    expect(contentMap).toEqual({});
  });
});

describe('buildHistoryForEngine', () => {
  function makeMockHistoryEntryClass() {
    return vi.fn().mockImplementation((url, title) => ({
      url,
      title,
      timestamp: undefined,
      setContent: vi.fn(),
    }));
  }

  it('creates HistoryEntry objects and adds them to the engine', () => {
    const MockHistoryEntry = makeMockHistoryEntryClass();
    const engine = { addEntry: vi.fn() };
    const dataList = [
      { url: 'https://a.com', title: 'A', timestamp: 100, slug: 'a' },
    ];
    const contentMap = { a: '# A content' };

    buildHistoryForEngine(MockHistoryEntry, engine, dataList, contentMap);

    expect(MockHistoryEntry).toHaveBeenCalledWith('https://a.com', 'A');
    expect(engine.addEntry).toHaveBeenCalledTimes(1);

    const obj = engine.addEntry.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(100));
    expect(obj.setContent).toHaveBeenCalledWith('# A content');
  });

  it('converts timestamp to BigInt', () => {
    const MockHistoryEntry = makeMockHistoryEntryClass();
    const engine = { addEntry: vi.fn() };
    const dataList = [
      { url: 'https://b.com', title: 'B', timestamp: 1770700063620 },
    ];

    buildHistoryForEngine(MockHistoryEntry, engine, dataList, {});

    const obj = engine.addEntry.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(1770700063620));
  });

  it('uses empty string when contentMap has no entry for slug', () => {
    const MockHistoryEntry = makeMockHistoryEntryClass();
    const engine = { addEntry: vi.fn() };
    const dataList = [
      { url: 'https://c.com', title: 'C', timestamp: 1, slug: 'c' },
    ];

    buildHistoryForEngine(MockHistoryEntry, engine, dataList, {});

    const obj = engine.addEntry.mock.calls[0][0];
    expect(obj.setContent).toHaveBeenCalledWith('');
  });

  it('defaults missing optional fields to empty strings', () => {
    const MockHistoryEntry = makeMockHistoryEntryClass();
    const engine = { addEntry: vi.fn() };
    const dataList = [{ url: 'https://d.com', title: 'D', timestamp: 1 }];

    buildHistoryForEngine(MockHistoryEntry, engine, dataList, {});

    const obj = engine.addEntry.mock.calls[0][0];
    expect(obj.setContent).toHaveBeenCalledWith('');
  });
});
