import { describe, expect, it } from 'vitest';

import {
  HistoryEntry,
  SearchEngine,
} from '../../apps/extension/search-runtime.js';

describe('search runtime', () => {
  it('searches in-memory history entries by title, user title, and URL', async () => {
    const engine = new SearchEngine();

    const exact = new HistoryEntry(
      'https://example.com/react-hooks',
      'React Hooks Guide',
    );
    exact.timestamp = BigInt(10);
    exact.setContent('Learn useEffectEvent patterns');

    const fuzzy = new HistoryEntry(
      'https://example.com/react-patterns',
      'React Patterns',
    );
    fuzzy.timestamp = BigInt(5);
    fuzzy.setContent('A typo-tolerant search target');

    const renamed = new HistoryEntry(
      'https://example.com/custom-research',
      'Original title',
    );
    renamed.timestamp = BigInt(20);
    renamed.userTitle = 'Custom title';

    engine.addEntry(exact);
    engine.addEntry(fuzzy);
    engine.addEntry(renamed);

    const exactResults = await engine.search('"react hooks"');
    expect(exactResults).toHaveLength(1);
    expect(exactResults[0].url).toBe('https://example.com/react-hooks');

    const fuzzyResults = await engine.search('raect');
    expect(fuzzyResults.map((result) => result.url)).toContain(
      'https://example.com/react-patterns',
    );

    const userTitleResults = await engine.search('custom');
    expect(userTitleResults.map((result) => result.url)).toEqual([
      'https://example.com/custom-research',
    ]);

    const urlResults = await engine.search('custom-research');
    expect(urlResults.map((result) => result.url)).toEqual([
      'https://example.com/custom-research',
    ]);

    const contentResults = await engine.search('useEffectEvent');
    expect(contentResults).toEqual([]);
  });

  it('sorts equal-score search results by timestamp descending', async () => {
    const engine = new SearchEngine();

    const older = new HistoryEntry('https://example.com/older', 'Needle');
    older.timestamp = BigInt(10);
    older.setContent('');

    const newer = new HistoryEntry('https://example.com/newer', 'Needle');
    newer.timestamp = BigInt(20);
    newer.setContent('');

    engine.addEntry(older);
    engine.addEntry(newer);

    const results = await engine.search('"needle"');
    expect(results.map((result) => result.url)).toEqual([
      'https://example.com/newer',
      'https://example.com/older',
    ]);
  });

  it('rejects malformed search inputs instead of coercing them', async () => {
    const engine = new SearchEngine();
    const entry = new HistoryEntry('https://example.com', 'Example');
    entry.timestamp = '10';
    engine.addEntry(entry);

    await expect(engine.search('example')).rejects.toThrow(
      'Search timestamps must be non-negative safe integers',
    );
    await expect(engine.search(null)).rejects.toThrow(
      'Search query must be a string',
    );
  });
});
