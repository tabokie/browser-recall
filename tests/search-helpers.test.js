import { describe, it, expect, vi } from 'vitest';
import {
  mergeBufferIntoInteractions,
  buildInteractionsForEngine,
} from '../extension/search-helpers.js';

describe('mergeBufferIntoInteractions', () => {
  it('appends new buffer entries', () => {
    const interactions = [
      { url: 'https://a.com', timestamp: 1, slug: 'a' },
    ];
    const buffer = [
      { interaction: { url: 'https://b.com', timestamp: 2, slug: 'b' }, markdown: '# B' },
    ];
    const contentMap = {};

    mergeBufferIntoInteractions(interactions, buffer, contentMap);

    expect(interactions).toHaveLength(2);
    expect(interactions[1].url).toBe('https://b.com');
    expect(contentMap['b']).toBe('# B');
  });

  it('deduplicates by URL (last-write-wins)', () => {
    const interactions = [
      { url: 'https://a.com', timestamp: 1, title: 'old', slug: 'a' },
    ];
    const buffer = [
      { interaction: { url: 'https://a.com', timestamp: 3, title: 'new', slug: 'a' } },
    ];
    const contentMap = {};

    mergeBufferIntoInteractions(interactions, buffer, contentMap);

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
    const contentMap = {};

    mergeBufferIntoInteractions(interactions, buffer, contentMap);

    expect(interactions.map(i => i.url)).toEqual([
      'https://a.com',
      'https://b.com',
      'https://c.com',
    ]);
  });

  it('handles old-format buffer entries (no .interaction wrapper)', () => {
    const interactions = [];
    const buffer = [{ url: 'https://x.com', timestamp: 1, slug: 'x' }];
    const contentMap = {};

    mergeBufferIntoInteractions(interactions, buffer, contentMap);

    expect(interactions).toHaveLength(1);
    expect(interactions[0].url).toBe('https://x.com');
  });
});

describe('buildInteractionsForEngine', () => {
  function makeMockInteractionClass() {
    return vi.fn().mockImplementation((url, title) => ({
      url,
      title,
      id: undefined,
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
      { url: 'https://a.com', title: 'A', id: 'id-a', timestamp: 100, intent: 'test', slug: 'a', attention: '{}' },
    ];
    const contentMap = { a: '# A content' };

    buildInteractionsForEngine(MockInteraction, engine, dataList, contentMap);

    expect(MockInteraction).toHaveBeenCalledWith('https://a.com', 'A');
    expect(engine.addInteraction).toHaveBeenCalledTimes(1);

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.id).toBe('id-a');
    expect(obj.timestamp).toBe(BigInt(100));
    expect(obj.setIntent).toHaveBeenCalledWith('test');
    expect(obj.setContent).toHaveBeenCalledWith('# A content');
    expect(obj.setAttention).toHaveBeenCalledWith('{}');
  });

  it('converts timestamp to BigInt', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://b.com', title: 'B', id: 'id-b', timestamp: 1770700063620 },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.timestamp).toBe(BigInt(1770700063620));
  });

  it('falls back to inline content when contentMap has no entry', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://c.com', title: 'C', id: 'id-c', timestamp: 1, content: 'inline' },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.setContent).toHaveBeenCalledWith('inline');
  });

  it('defaults missing optional fields to empty strings', () => {
    const MockInteraction = makeMockInteractionClass();
    const engine = { addInteraction: vi.fn() };
    const dataList = [
      { url: 'https://d.com', title: 'D', id: 'id-d', timestamp: 1 },
    ];

    buildInteractionsForEngine(MockInteraction, engine, dataList, {});

    const obj = engine.addInteraction.mock.calls[0][0];
    expect(obj.setIntent).toHaveBeenCalledWith('');
    expect(obj.setContent).toHaveBeenCalledWith('');
    expect(obj.setAttention).toHaveBeenCalledWith('');
  });
});
