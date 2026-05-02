import { describe, expect, it } from 'vitest';

import {
  HistoryEntry,
  SearchEngine,
  searchBatch,
  searchNotes,
  searchSnapshots,
} from '../../apps/extension/search-runtime.js';

class FakeFile {
  constructor(text) {
    this._text = text;
  }

  async text() {
    return this._text;
  }
}

class FakeFileHandle {
  constructor(text) {
    this.kind = 'file';
    this._text = text;
  }

  async getFile() {
    return new FakeFile(this._text);
  }
}

class FakeDirectoryHandle {
  constructor(entries = {}) {
    this.kind = 'directory';
    this._entries = new Map(Object.entries(entries));
  }

  async getFileHandle(name) {
    const entry = this._entries.get(name);
    if (!(entry instanceof FakeFileHandle)) {
      throw new Error(`Missing file: ${name}`);
    }
    return entry;
  }

  async getDirectoryHandle(name) {
    const entry = this._entries.get(name);
    if (!(entry instanceof FakeDirectoryHandle)) {
      throw new Error(`Missing directory: ${name}`);
    }
    return entry;
  }

  async *values() {
    for (const [name, entry] of this._entries.entries()) {
      yield {
        name,
        kind: entry.kind,
      };
    }
  }
}

describe('search runtime compatibility module', () => {
  it('searches in-memory history entries with exact and fuzzy matches', async () => {
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

    engine.addEntry(exact);
    engine.addEntry(fuzzy);

    const exactResults = await engine.search('"react hooks"');
    expect(exactResults).toHaveLength(1);
    expect(exactResults[0].url).toBe('https://example.com/react-hooks');

    const fuzzyResults = await engine.search('raect');
    expect(fuzzyResults.map((result) => result.url)).toContain(
      'https://example.com/react-patterns',
    );
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

  it('searchBatch deduplicates URLs and loads page markdown content', async () => {
    const historyDir = new FakeDirectoryHandle({
      '2026-04-18.jsonl': new FakeFileHandle(
        [
          JSON.stringify({
            timestamp: 200,
            url: 'https://example.com/article',
            title: 'Unread title',
            slug: 'example-article',
          }),
          JSON.stringify({
            timestamp: 180,
            url: 'https://example.com/other',
            title: 'Other page',
          }),
        ].join('\n'),
      ),
      '2026-04-17.jsonl': new FakeFileHandle(
        JSON.stringify({
          timestamp: 100,
          url: 'https://example.com/article',
          title: 'Older duplicate',
          slug: 'example-article',
        }),
      ),
    });

    const pagesDir = new FakeDirectoryHandle({
      'example-article': new FakeDirectoryHandle({
        '100.md': new FakeFileHandle('stale content'),
        '200.md': new FakeFileHandle('banana match from markdown body'),
      }),
    });

    const results = await searchBatch(historyDir, pagesDir, 'banana', [
      '2026-04-18.jsonl',
      '2026-04-17.jsonl',
    ]);

    expect(results).toEqual([
      {
        url: 'https://example.com/article',
        title: 'Unread title',
        timestamp: 200,
        score: 1,
      },
    ]);
  });

  it('searchNotes searches note text and excerpt arrays', async () => {
    const notesDir = new FakeDirectoryHandle({
      'react-note.json': new FakeFileHandle(
        JSON.stringify({
          slug: 'react-note',
          url: 'https://example.com/react',
          excerpt: ['first match', 'second excerpt'],
          note: 'Remember the batching caveat',
        }),
      ),
      'other.json': new FakeFileHandle(
        JSON.stringify({
          url: 'https://example.com/other',
          excerpt: 'nothing relevant here',
        }),
      ),
    });

    const results = await searchNotes(notesDir, 'batching');

    expect(results).toEqual([
      {
        url: 'https://example.com/react',
        noteSlug: 'react-note',
      },
    ]);
  });

  it('searchSnapshots returns matched page slugs from snapshot markdown files', async () => {
    const snapshotsDir = new FakeDirectoryHandle({
      'my-page-1709251200000.md': new FakeFileHandle(
        'captured banana document',
      ),
      'other-page-1709251200001.md': new FakeFileHandle('no match here'),
    });

    const results = await searchSnapshots(snapshotsDir, 'banana', [
      'my-page-1709251200000.md',
      'other-page-1709251200001.md',
    ]);

    expect(results).toEqual([{ slug: 'my-page' }]);
  });
});
