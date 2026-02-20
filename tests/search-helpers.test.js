import { describe, it, expect, vi } from 'vitest';
import {
  mergeBufferIntoInteractions,
  getBufferContentMap,
  buildInteractionsForEngine,
  extractInteractionBuffer,
} from '../extension/search-helpers.js';

describe('mergeBufferIntoInteractions', () => {
  it('appends new buffer entries', () => {
    const interactions = [
      { url: 'https://a.com', timestamp: 1, slug: 'a' },
    ];
    const buffer = [
      { url: 'https://b.com', title: 'B', timestamp: 2, slug: 'b' },
    ];

    mergeBufferIntoInteractions(interactions, buffer);

    expect(interactions).toHaveLength(2);
    expect(interactions[1].url).toBe('https://b.com');
  });

  it('deduplicates by URL (last-write-wins)', () => {
    const interactions = [
      { url: 'https://a.com', timestamp: 1, title: 'old', slug: 'a' },
    ];
    const buffer = [
      { url: 'https://a.com', timestamp: 3, title: 'new', slug: 'a' },
    ];

    mergeBufferIntoInteractions(interactions, buffer);

    expect(interactions).toHaveLength(1);
    expect(interactions[0].title).toBe('new');
  });

  it('sorts merged result by timestamp', () => {
    const interactions = [
      { url: 'https://c.com', timestamp: 10, slug: 'c' },
    ];
    const buffer = [
      { url: 'https://a.com', timestamp: 1, slug: 'a' },
      { url: 'https://b.com', timestamp: 5, slug: 'b' },
    ];

    mergeBufferIntoInteractions(interactions, buffer);

    expect(interactions.map(i => i.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });
});

describe('extractInteractionBuffer (logBuffer format)', () => {
  it('extracts visit entries (no action field) from logBuffer', () => {
    const logBuffer = [
      { timestamp: 1, url: 'https://a.com', title: 'A', slug: 'a',  attention: '' },
      { timestamp: 2, action: 'set', key: 'workspace', value: {} },
      { timestamp: 3, url: 'https://b.com', title: 'B', slug: 'b',  attention: '' },
      { timestamp: 4, action: 'highlight', slug: 'a', highlight: { text: 'hi' } },
    ];

    const result = extractInteractionBuffer(logBuffer);

    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://a.com');
    expect(result[1].url).toBe('https://b.com');
  });

  it('returns empty array for buffer with no visit entries', () => {
    const logBuffer = [
      { timestamp: 1, action: 'set', key: 'workspace', value: {} },
      { timestamp: 2, action: 'highlight', slug: 'x', highlight: {} },
    ];

    const result = extractInteractionBuffer(logBuffer);
    expect(result).toHaveLength(0);
  });

  it('works with mergeBufferIntoInteractions after extraction', () => {
    const interactions = [
      { url: 'https://old.com', timestamp: 1, slug: 'old' },
    ];
    const logBuffer = [
      { timestamp: 2, url: 'https://new.com', title: 'New', slug: 'new',  attention: '' },
      { timestamp: 3, action: 'set', key: 'workspace', value: {} },
    ];

    const extracted = extractInteractionBuffer(logBuffer);
    mergeBufferIntoInteractions(interactions, extracted);

    expect(interactions).toHaveLength(2);
    expect(interactions.map(i => i.url)).toContain('https://new.com');
  });

  it('returns empty array for empty buffer', () => {
    const result = extractInteractionBuffer([]);
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

describe('buildInteractionsForEngine', () => {
  function makeMockInteractionClass() {
    return vi.fn().mockImplementation((url, title) => ({
      url,
      title,
      timestamp: undefined,
      setContent: vi.fn(),
      setAttention: vi.fn(),
    }));
  }

  it('creates Interaction objects and adds them to the engine', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://a.com', title: 'A', timestamp: 100,  slug: 'a', attention: '{}' },
    ];
    const contentMap = { a: '# A content' };

    buildInteractionsForEngine(MockInteraction, engine, dataList, contentMap);

    expect(MockInteraction).toHaveBeenCalledWith('https://a.com', 'A');
    expect(engine.addInteraction).toHaveBeenCalledTimes(1);

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(100));
    expect(obj.setContent).toHaveBeenCalledWith('# A content');
    expect(obj.setAttention).toHaveBeenCalledWith('{}');
  });

  it('converts timestamp to BigInt', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://b.com', title: 'B', timestamp: 1770700063620 },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(1770700063620));
  });

  it('uses empty string when contentMap has no entry for slug', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://c.com', title: 'C', timestamp: 1, slug: 'c' },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.setContent).toHaveBeenCalledWith('');
  });

  it('defaults missing optional fields to empty strings', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://d.com', title: 'D', timestamp: 1 },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.setContent).toHaveBeenCalledWith('');
    expect(obj.setAttention).toHaveBeenCalledWith('');
  });

  it('stringifies object attention field (log entries may have raw objects)', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      {
        url: 'https://e.com', title: 'E', timestamp: 1, slug: 'e',
         attention: { scrollDepth: 42, timeOnPage: 5000 }
      },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    // Must be a string, not an object — WASM passStringToWasm0 rejects objects
    expect(typeof obj.setAttention.mock.calls[0][0]).toBe('string');
    const parsed = JSON.parse(obj.setAttention.mock.calls[0][0]);
    expect(parsed.scrollDepth).toBe(42);
  });
});
