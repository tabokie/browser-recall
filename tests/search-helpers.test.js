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
      { interaction: { url: 'https://b.com', timestamp: 2, slug: 'b' }, markdown: '# B' },
    ];

    mergeBufferIntoInteractions(interactions, buffer);

    expect(interactions).toHaveLength(2);
    expect(interactions[1].url).toBe('https://b.com');

    // Buffer content is now extracted separately via getBufferContentMap
    const bufferContent = getBufferContentMap(buffer);
    expect(bufferContent['b']).toBe('# B');
  });

  it('deduplicates by URL (last-write-wins)', () => {
    const interactions = [
      { url: 'https://a.com', timestamp: 1, title: 'old', slug: 'a' },
    ];
    const buffer = [
      { interaction: { url: 'https://a.com', timestamp: 3, title: 'new', slug: 'a' } },
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
      { interaction: { url: 'https://a.com', timestamp: 1, slug: 'a' } },
      { interaction: { url: 'https://b.com', timestamp: 5, slug: 'b' } },
    ];

    mergeBufferIntoInteractions(interactions, buffer);

    expect(interactions.map(i => i.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

});

describe('extractInteractionBuffer (new writeBuffer format)', () => {
  it('extracts interaction entries from typed writeBuffer', () => {
    const writeBuffer = [
      { id: 1, type: 'interaction', entry: { interaction: { url: 'https://a.com', timestamp: 1, slug: 'a' }, markdown: '# A', html: '' } },
      { id: 2, type: 'json', path: 'settings.json', data: { workspace: {} } },
      { id: 3, type: 'interaction', entry: { interaction: { url: 'https://b.com', timestamp: 2, slug: 'b' }, markdown: '', html: '' } },
      { id: 4, type: 'snapshot', slug: 'c', timestamp: 3, markdown: '# C', html: '<p>C</p>' },
    ];

    const result = extractInteractionBuffer(writeBuffer);

    expect(result).toHaveLength(2);
    expect(result[0].interaction.url).toBe('https://a.com');
    expect(result[0].markdown).toBe('# A');
    expect(result[1].interaction.url).toBe('https://b.com');
  });

  it('returns empty array for buffer with no interaction entries', () => {
    const writeBuffer = [
      { id: 1, type: 'json', path: 'settings.json', data: {} },
      { id: 2, type: 'snapshot', slug: 'x', timestamp: 1, markdown: '', html: '' },
    ];

    const result = extractInteractionBuffer(writeBuffer);
    expect(result).toHaveLength(0);
  });

  it('works with mergeBufferIntoInteractions after extraction', () => {
    const interactions = [
      { url: 'https://old.com', timestamp: 1, slug: 'old' },
    ];
    const writeBuffer = [
      { id: 1, type: 'interaction', entry: { interaction: { url: 'https://new.com', timestamp: 2, slug: 'new' }, markdown: '# New', html: '' } },
      { id: 2, type: 'json', path: 'atoms/x.json', data: { highlights: [] } },
    ];

    const extracted = extractInteractionBuffer(writeBuffer);
    mergeBufferIntoInteractions(interactions, extracted);

    expect(interactions).toHaveLength(2);
    expect(interactions.map(i => i.url)).toContain('https://new.com');
  });

  it('handles legacy (pre-migration) buffer entries without type field', () => {
    const writeBuffer = [
      // Legacy format: no type field, interaction at top level
      { interaction: { url: 'https://legacy.com', timestamp: 1, slug: 'legacy' }, markdown: '# Legacy', html: '' },
      // New format
      { id: 2, type: 'interaction', entry: { interaction: { url: 'https://new.com', timestamp: 2, slug: 'new' }, markdown: '# New', html: '' } },
      // Non-interaction new format
      { id: 3, type: 'json', path: 'settings.json', data: {} },
    ];

    const result = extractInteractionBuffer(writeBuffer);

    expect(result).toHaveLength(2);
    expect(result[0].interaction.url).toBe('https://legacy.com');
    expect(result[0].markdown).toBe('# Legacy');
    expect(result[1].interaction.url).toBe('https://new.com');
  });

  it('works with getBufferContentMap after extraction', () => {
    const writeBuffer = [
      { id: 1, type: 'interaction', entry: { interaction: { url: 'https://a.com', timestamp: 1, slug: 'a' }, markdown: '# A content', html: '' } },
      { id: 2, type: 'json', path: 'settings.json', data: {} },
    ];

    const extracted = extractInteractionBuffer(writeBuffer);
    const contentMap = getBufferContentMap(extracted);

    expect(contentMap['a']).toBe('# A content');
  });
});

describe('buildInteractionsForEngine', () => {
  function makeMockInteractionClass() {
    return vi.fn().mockImplementation((url, title) => ({
      url,
      title,
      timestamp: undefined,
      setIntent: vi.fn(),
      setContent: vi.fn(),
      setAttention: vi.fn(),
    }));
  }

  it('creates Interaction objects and adds them to the engine', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://a.com', title: 'A', timestamp: 100, intent: 'test', slug: 'a', attention: '{}' },
    ];
    const contentMap = { a: '# A content' };

    buildInteractionsForEngine(MockInteraction, engine, dataList, contentMap);

    expect(MockInteraction).toHaveBeenCalledWith('https://a.com', 'A');
    expect(engine.addInteraction).toHaveBeenCalledTimes(1);

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(100));
    expect(obj.setIntent).toHaveBeenCalledWith('test');
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
    expect(obj.setIntent).toHaveBeenCalledWith('');
    expect(obj.setContent).toHaveBeenCalledWith('');
    expect(obj.setAttention).toHaveBeenCalledWith('');
  });

  it('stringifies object attention field (writeBuffer entries have raw objects)', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      {
        url: 'https://e.com', title: 'E', timestamp: 1, slug: 'e',
        intent: '', attention: { scrollDepth: 42, timeOnPage: 5000, clicks: 3, highlights: [] }
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
