import { describe, it, expect, vi } from 'vitest';
import {
  mergeBufferIntoHistory,
  getBufferContentMap,
  buildHistoryForEngine,
  extractHistoryBuffer,
} from '../extension/search-helpers.js';

describe('mergeBufferIntoHistory', () => {
  it('appends new buffer entries', () => {
    const entries = [{ url: 'https://a.com', timestamp: 1, slug: 'a' }];
    const buffer = [
      { url: 'https://b.com', title: 'B', timestamp: 2, slug: 'b' },
    ];

    mergeBufferIntoHistory(entries, buffer);

    expect(entries).toHaveLength(2);
    expect(entries[1].url).toBe('https://b.com');
  });

  it('deduplicates by URL (last-write-wins)', () => {
    const entries = [
      { url: 'https://a.com', timestamp: 1, title: 'old', slug: 'a' },
    ];
    const buffer = [
      { url: 'https://a.com', timestamp: 3, title: 'new', slug: 'a' },
    ];

    mergeBufferIntoHistory(entries, buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('new');
  });

  it('sorts merged result by timestamp', () => {
    const entries = [{ url: 'https://c.com', timestamp: 10, slug: 'c' }];
    const buffer = [
      { url: 'https://a.com', timestamp: 1, slug: 'a' },
      { url: 'https://b.com', timestamp: 5, slug: 'b' },
    ];

    mergeBufferIntoHistory(entries, buffer);

    expect(entries.map((i) => i.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });
});

describe('extractHistoryBuffer (logBuffer format)', () => {
  it('extracts visit entries (no action field) from logBuffer', () => {
    const logBuffer = [
      { timestamp: 1, url: 'https://a.com', title: 'A', slug: 'a' },
      { timestamp: 2, action: 'list_meta', id: 'test', name: 'Test' },
      { timestamp: 3, url: 'https://b.com', title: 'B', slug: 'b' },
      {
        timestamp: 4,
        action: 'highlight',
        slug: 'a',
        highlight: { text: 'hi' },
      },
    ];

    const result = extractHistoryBuffer(logBuffer);

    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://a.com');
    expect(result[1].url).toBe('https://b.com');
  });

  it('returns empty array for buffer with no visit entries', () => {
    const logBuffer = [
      { timestamp: 1, action: 'list_meta', id: 'test', name: 'Test' },
      { timestamp: 2, action: 'highlight', slug: 'x', highlight: {} },
    ];

    const result = extractHistoryBuffer(logBuffer);
    expect(result).toHaveLength(0);
  });

  it('works with mergeBufferIntoHistory after extraction', () => {
    const entries = [{ url: 'https://old.com', timestamp: 1, slug: 'old' }];
    const logBuffer = [
      { timestamp: 2, url: 'https://new.com', title: 'New', slug: 'new' },
      { timestamp: 3, action: 'list_meta', id: 'test', name: 'Test' },
    ];

    const extracted = extractHistoryBuffer(logBuffer);
    mergeBufferIntoHistory(entries, extracted);

    expect(entries).toHaveLength(2);
    expect(entries.map((i) => i.url)).toContain('https://new.com');
  });

  it('returns empty array for empty buffer', () => {
    const result = extractHistoryBuffer([]);
    expect(result).toHaveLength(0);
  });
});

describe('getBufferContentMap', () => {
  it('returns empty map (content is on disk in event-sourced model)', () => {
    const buffer = [
      { timestamp: 1, url: 'https://a.com', title: 'A', slug: 'a' },
    ];
    const contentMap = getBufferContentMap(buffer);
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
