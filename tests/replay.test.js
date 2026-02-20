/**
 * Replay module unit tests.
 *
 * Verifies that pure replay functions correctly apply log entries to entity
 * state, and that they are idempotent (safe to replay the same entry twice).
 */
import { describe, it, expect } from 'vitest';
import {
  applyLogToSettings,
  applyLogToAtom,
  applyLogToPins,
  applyLogToDeletes,
  applyLogToRecycleBin,
  applyLogToParentIndex,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// applyLogToSettings
// ---------------------------------------------------------------------------

describe('applyLogToSettings', () => {
  it('merges key/value into settings', () => {
    const settings = { timestamp: 0, workspace: { mode: 'default' } };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = applyLogToSettings(settings, entry);
    expect(result.workspace).toEqual({ mode: 'private' });
    expect(result.timestamp).toBe(100);
  });

  it('adds new key to settings', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 200, action: 'set', key: 'urlBlacklist', value: ['chrome://'] };
    const result = applyLogToSettings(settings, entry);
    expect(result.urlBlacklist).toEqual(['chrome://']);
    expect(result.timestamp).toBe(200);
  });

  it('ignores non-set entries', () => {
    const settings = { timestamp: 0, workspace: { mode: 'default' } };
    const entry = { timestamp: 100, action: 'highlight', slug: 'x', highlight: {} };
    const result = applyLogToSettings(settings, entry);
    expect(result).toBe(settings); // same reference
  });

  it('ignores visit entries (no action)', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a' };
    const result = applyLogToSettings(settings, entry);
    expect(result).toBe(settings);
  });

  it('is idempotent', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'set', key: 'collections', value: [{ id: 'c1' }] };
    const r1 = applyLogToSettings(settings, entry);
    const r2 = applyLogToSettings(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('preserves unrelated keys', () => {
    const settings = { timestamp: 0, workspace: { mode: 'default' }, collections: [{ id: 'c1' }] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = applyLogToSettings(settings, entry);
    expect(result.collections).toEqual([{ id: 'c1' }]);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — visit entries
// ---------------------------------------------------------------------------

describe('applyLogToAtom — visit', () => {
  it('updates url, title, attention, timestamp from visit entry', () => {
    const atom = { slug: 'a', timestamp: 0, url: '', title: '', highlights: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'Page A', slug: 'a', attention: '{"scrollDepth":50}' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.title).toBe('Page A');
    expect(result.attention).toBe('{"scrollDepth":50}');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates parent URLs from referrer', () => {
    const atom = { slug: 'a', timestamp: 0, parents: ['old-slug-abc'] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0]).toBe('old-slug-abc');
    expect(result.parents[1]).toBe('https://google.com'); // stored as URL
  });

  it('does not duplicate existing parent URL', () => {
    const atom = { slug: 'a', timestamp: 0, parents: ['https://google.com'] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toEqual(['https://google.com']);
  });

  it('does not duplicate when existing parent is a slug matching the referrer', () => {
    // Simulate post-drain state: parent resolved to slug
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://google.com' };
    const googleSlug = generateSlugFromUrl('https://google.com');
    const atom = { slug: 'a', timestamp: 0, parents: [googleSlug] };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('does not duplicate when existing parent is {url,title} object', () => {
    const atom = { slug: 'a', timestamp: 0, parents: [{ url: 'https://google.com', title: 'Google' }] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('caps parents at 50', () => {
    const parents = [];
    for (let i = 0; i < 50; i++) parents.push(`https://ref${i}.com`);
    const atom = { slug: 'a', timestamp: 0, parents };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://new-ref.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(50);
    expect(result.parents[0]).toBe('https://ref1.com'); // ref0 evicted
  });

  it('ignores visit entry with mismatched slug', () => {
    const atom = { slug: 'a', timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 100, url: 'https://b.com', title: 'B', slug: 'b' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('applies visit to atom without slug field (new atom)', () => {
    const atom = { timestamp: 0, highlights: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', attention: '' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.timestamp).toBe(100);
  });

  it('sets mdPath from visit entry', () => {
    const atom = { slug: 'a', timestamp: 0 };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', mdPath: 'atoms/a/100.md' };
    const result = applyLogToAtom(atom, entry);
    expect(result.mdPath).toBe('atoms/a/100.md');
  });

  it('is idempotent for visit entries', () => {
    const atom = { slug: 'a', timestamp: 0, parents: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', referrer: 'https://ref.com' };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — highlight operations
// ---------------------------------------------------------------------------

describe('applyLogToAtom — highlight', () => {
  it('pushes highlight to highlights array', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: 'hello', note: '', timestamp: 100 } };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].text).toBe('hello');
    expect(result.timestamp).toBe(100);
  });

  it('handles global note (isGlobalNote) — insert at front', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [{ text: 'existing', timestamp: 50 }] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: '', note: 'Page note', timestamp: 100, isGlobalNote: true } };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toHaveLength(2);
    expect(result.highlights[0].isGlobalNote).toBe(true);
  });

  it('replaces existing global note', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [{ text: '', note: 'old', timestamp: 50, isGlobalNote: true }] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: '', note: 'new', timestamp: 100, isGlobalNote: true } };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].note).toBe('new');
  });

  it('ignores highlight with mismatched slug', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'b', highlight: { text: 'hello', timestamp: 100 } };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });
});

describe('applyLogToAtom — unhighlight', () => {
  it('removes highlight by matchTimestamp', () => {
    const atom = {
      slug: 'a', timestamp: 0,
      highlights: [
        { text: 'keep', timestamp: 50 },
        { text: 'remove', timestamp: 80 },
      ],
    };
    const entry = { timestamp: 100, action: 'unhighlight', slug: 'a', matchTimestamp: 80 };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].text).toBe('keep');
    expect(result.timestamp).toBe(100);
  });

  it('is a no-op if matchTimestamp not found', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [{ text: 'x', timestamp: 50 }] };
    const entry = { timestamp: 100, action: 'unhighlight', slug: 'a', matchTimestamp: 999 };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toHaveLength(1);
  });

  it('is idempotent', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [{ text: 'x', timestamp: 50 }] };
    const entry = { timestamp: 100, action: 'unhighlight', slug: 'a', matchTimestamp: 50 };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2.highlights).toEqual(r1.highlights);
  });
});

describe('applyLogToAtom — highlights_replace', () => {
  it('replaces entire highlights array', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [{ text: 'old', timestamp: 50 }] };
    const newHighlights = [{ text: 'new1', timestamp: 90 }, { text: 'new2', timestamp: 95 }];
    const entry = { timestamp: 100, action: 'highlights_replace', slug: 'a', highlights: newHighlights };
    const result = applyLogToAtom(atom, entry);
    expect(result.highlights).toEqual(newHighlights);
    expect(result.timestamp).toBe(100);
  });
});

describe('applyLogToAtom — capture', () => {
  it('sets mdPath and htmlPath', () => {
    const atom = { slug: 'a', timestamp: 0 };
    const entry = { timestamp: 100, action: 'capture', slug: 'a', mdPath: 'atoms/a/100.md', htmlPath: 'atoms/a/100.html' };
    const result = applyLogToAtom(atom, entry);
    expect(result.mdPath).toBe('atoms/a/100.md');
    expect(result.htmlPath).toBe('atoms/a/100.html');
    expect(result.timestamp).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPins
// ---------------------------------------------------------------------------

describe('applyLogToPins — pins_replace', () => {
  it('replaces pins array and preserves metadata', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', qbTree: null, pins: [{ url: 'https://old.com', title: 'Old', pinnedAt: 50 }] };
    const newPins = [{ url: 'https://new.com', title: 'New', pinnedAt: 100 }];
    const entry = { timestamp: 100, action: 'pins_replace', collectionId: 'uuid-1', pins: newPins };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toEqual(newPins);
    expect(result.timestamp).toBe(100);
    expect(result.name).toBe('Rust');
    expect(result.query).toBe('rust');
    expect(result.id).toBe('uuid-1');
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, pins: [] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: {} };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, pins: [] };
    const newPins = [{ url: 'https://a.com', title: 'A', pinnedAt: 100 }];
    const entry = { timestamp: 100, action: 'pins_replace', collectionId: 'c1', pins: newPins };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

describe('applyLogToPins — collection_meta', () => {
  it('merges metadata fields and preserves pins', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Old Name', query: 'old', qbTree: null, pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'collection_meta', collectionId: 'uuid-1', name: 'New Name', query: 'new' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('New Name');
    expect(result.query).toBe('new');
    expect(result.id).toBe('uuid-1');
    expect(result.pins).toEqual(entity.pins);
    expect(result.timestamp).toBe(100);
  });

  it('updates only provided fields', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', qbTree: null, pins: [] };
    const entry = { timestamp: 100, action: 'collection_meta', collectionId: 'uuid-1', name: 'Rust Lang' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('Rust Lang');
    expect(result.query).toBe('rust');
    expect(result.qbTree).toBeNull();
  });

  it('sets qbTree', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', query: '', qbTree: null, pins: [] };
    const tree = { type: 'AND', children: [{ type: 'keyword', value: 'rust' }] };
    const entry = { timestamp: 100, action: 'collection_meta', collectionId: 'uuid-1', qbTree: tree };
    const result = applyLogToPins(entity, entry);
    expect(result.qbTree).toEqual(tree);
  });

  it('initializes metadata on empty entity', () => {
    const entity = { timestamp: 0, pins: [] };
    const entry = { timestamp: 100, action: 'collection_meta', collectionId: 'uuid-new', name: 'Brand New', query: 'new' };
    const result = applyLogToPins(entity, entry);
    expect(result.id).toBe('uuid-new');
    expect(result.name).toBe('Brand New');
    expect(result.query).toBe('new');
    expect(result.pins).toEqual([]);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', query: 'test', qbTree: null, pins: [] };
    const entry = { timestamp: 100, action: 'collection_meta', collectionId: 'uuid-1', name: 'Updated' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

describe('applyLogToPins — collection_delete', () => {
  it('returns deleted entity', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', pins: [{ url: 'https://a.com' }] };
    const entry = { timestamp: 100, action: 'collection_delete', collectionId: 'uuid-1' };
    const result = applyLogToPins(entity, entry);
    expect(result.deleted).toBe(true);
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, pins: [] };
    const entry = { timestamp: 100, action: 'collection_delete', collectionId: 'uuid-1' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToDeletes
// ---------------------------------------------------------------------------

describe('applyLogToDeletes', () => {
  it('replaces urls array', () => {
    const entity = { timestamp: 0, urls: ['https://old.com'] };
    const entry = { timestamp: 100, action: 'deletes_replace', urls: ['https://old.com', 'https://new.com'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.urls).toEqual(['https://old.com', 'https://new.com']);
    expect(result.timestamp).toBe(100);
  });

  it('ignores non-deletes_replace entries', () => {
    const entity = { timestamp: 0, urls: [] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'x', highlight: {} };
    const result = applyLogToDeletes(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, urls: [] };
    const entry = { timestamp: 100, action: 'deletes_replace', urls: ['https://a.com'] };
    const r1 = applyLogToDeletes(entity, entry);
    const r2 = applyLogToDeletes(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToRecycleBin
// ---------------------------------------------------------------------------

describe('applyLogToRecycleBin', () => {
  it('replaces items array', () => {
    const entity = { timestamp: 0, items: [{ url: 'https://old.com', title: 'Old', deletedAt: 50 }] };
    const newItems = [{ url: 'https://new.com', title: 'New', deletedAt: 100 }];
    const entry = { timestamp: 100, action: 'recycle_replace', items: newItems };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toEqual(newItems);
    expect(result.timestamp).toBe(100);
  });

  it('ignores non-recycle_replace entries', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: {} };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, items: [] };
    const newItems = [{ url: 'https://a.com', title: 'A', deletedAt: 100 }];
    const entry = { timestamp: 100, action: 'recycle_replace', items: newItems };
    const r1 = applyLogToRecycleBin(entity, entry);
    const r2 = applyLogToRecycleBin(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('handles empty items', () => {
    const entity = { timestamp: 0, items: [{ url: 'https://a.com', title: 'A', deletedAt: 50 }] };
    const entry = { timestamp: 100, action: 'recycle_replace', items: [] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toEqual([]);
    expect(result.timestamp).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — visitDates accumulation
// ---------------------------------------------------------------------------

describe('applyLogToAtom — visitDates', () => {
  // Helper: compute YYYYMMDD integer from timestamp using local time (matches replay.js)
  function toYMD(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  it('accumulates visitDates from visit entries', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime(); // Jan 15 local
    const result = applyLogToAtom(atom, { timestamp: ts1, url: 'https://a.com', title: 'A', slug: 'a' });
    expect(result.visitDates).toEqual([toYMD(ts1)]);
  });

  it('does not duplicate same-day visits', () => {
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 15, 18, 0, 0).getTime();
    const ymd = toYMD(ts1);
    const atom = { slug: 'a', timestamp: 0, highlights: [], parents: [], visitDates: [ymd] };
    const result = applyLogToAtom(atom, { timestamp: ts2, url: 'https://a.com', title: 'A', slug: 'a' });
    expect(result.visitDates).toEqual([ymd]);
  });

  it('accumulates multiple distinct days', () => {
    let atom = { slug: 'a', timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 16, 10, 0, 0).getTime();
    atom = applyLogToAtom(atom, { timestamp: ts1, url: 'https://a.com', title: 'A', slug: 'a' });
    atom = applyLogToAtom(atom, { timestamp: ts2, url: 'https://a.com', title: 'A', slug: 'a' });
    expect(atom.visitDates).toEqual([toYMD(ts1), toYMD(ts2)]);
  });

  it('does not add visitDates for non-visit entries', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };
    const result = applyLogToAtom(atom, { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: 'x', timestamp: 100 } });
    expect(result.visitDates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — ensure_checkpoint
// ---------------------------------------------------------------------------

describe('applyLogToAtom — ensure_checkpoint', () => {
  it('creates a minimal atom from ensure_checkpoint', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'ensure_checkpoint', slug: 'ref-slug', url: 'https://ref.com', title: 'Referrer Page' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Referrer Page');
    expect(result.timestamp).toBe(500);
  });

  it('does not overwrite existing url/title', () => {
    const atom = { slug: 'ref-slug', timestamp: 100, url: 'https://ref.com', title: 'Original Title' };
    const entry = { timestamp: 500, action: 'ensure_checkpoint', slug: 'ref-slug', url: 'https://ref.com', title: 'New Title' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Original Title');
    expect(result.timestamp).toBe(500);
  });

  it('advances timestamp to max', () => {
    const atom = { slug: 'ref-slug', timestamp: 600, url: 'https://ref.com', title: 'X' };
    const entry = { timestamp: 500, action: 'ensure_checkpoint', slug: 'ref-slug', url: 'https://ref.com', title: '' };
    const result = applyLogToAtom(atom, entry);
    expect(result.timestamp).toBe(600); // keeps higher existing timestamp
  });

  it('ignores mismatched slug', () => {
    const atom = { slug: 'a', timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 500, action: 'ensure_checkpoint', slug: 'b', url: 'https://b.com', title: 'B' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('is idempotent', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'ensure_checkpoint', slug: 'x', url: 'https://x.com', title: 'X' };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// Sequence replay — applying multiple entries in order
// ---------------------------------------------------------------------------

describe('sequence replay', () => {
  it('replaying visit + highlight + unhighlight produces correct atom', () => {
    let atom = { slug: 'a', timestamp: 0, highlights: [], parents: [] };

    // Visit
    atom = applyLogToAtom(atom, { timestamp: 100, url: 'https://a.com', title: 'A', slug: 'a', attention: '' });
    expect(atom.url).toBe('https://a.com');
    expect(atom.timestamp).toBe(100);

    // Highlight
    atom = applyLogToAtom(atom, { timestamp: 200, action: 'highlight', slug: 'a', highlight: { text: 'hello', note: '', timestamp: 200 } });
    expect(atom.highlights).toHaveLength(1);

    // Another highlight
    atom = applyLogToAtom(atom, { timestamp: 300, action: 'highlight', slug: 'a', highlight: { text: 'world', note: '', timestamp: 300 } });
    expect(atom.highlights).toHaveLength(2);

    // Unhighlight first
    atom = applyLogToAtom(atom, { timestamp: 400, action: 'unhighlight', slug: 'a', matchTimestamp: 200 });
    expect(atom.highlights).toHaveLength(1);
    expect(atom.highlights[0].text).toBe('world');
    expect(atom.timestamp).toBe(400);
  });

  it('replaying multiple settings entries produces correct state', () => {
    let settings = { timestamp: 0 };

    settings = applyLogToSettings(settings, { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'default' } });
    settings = applyLogToSettings(settings, { timestamp: 200, action: 'set', key: 'collections', value: [{ id: 'c1' }] });
    settings = applyLogToSettings(settings, { timestamp: 300, action: 'set', key: 'workspace', value: { mode: 'private' } });

    expect(settings.workspace).toEqual({ mode: 'private' });
    expect(settings.collections).toEqual([{ id: 'c1' }]);
    expect(settings.timestamp).toBe(300);
  });

  it('add_child accumulates child URLs', () => {
    let atom = { slug: 'parent', timestamp: 0, children: [] };
    atom = applyLogToAtom(atom, { timestamp: 100, action: 'add_child', slug: 'parent', childSlug: 'child-a', childUrl: 'https://a.com', childTitle: 'A' });
    atom = applyLogToAtom(atom, { timestamp: 200, action: 'add_child', slug: 'parent', childSlug: 'child-b', childUrl: 'https://b.com', childTitle: 'B' });
    expect(atom.children).toEqual(['https://a.com', 'https://b.com']);
    expect(atom.timestamp).toBe(200);
  });

  it('add_child dedup against existing URL', () => {
    const atom = { slug: 'parent', timestamp: 0, children: ['https://a.com'] };
    const entry = { timestamp: 100, action: 'add_child', slug: 'parent', childSlug: 'child-a', childUrl: 'https://a.com', childTitle: 'A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.children).toEqual(['https://a.com']);
  });

  it('add_child dedup against existing slug', () => {
    const atom = { slug: 'parent', timestamp: 0, children: ['child-a'] };
    const entry = { timestamp: 100, action: 'add_child', slug: 'parent', childSlug: 'child-a', childUrl: 'https://a.com', childTitle: 'A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.children).toEqual(['child-a']); // no duplicate
  });

  it('add_child dedup against existing {url,title} object', () => {
    const atom = { slug: 'parent', timestamp: 0, children: [{ url: 'https://a.com', title: 'A' }] };
    const entry = { timestamp: 100, action: 'add_child', slug: 'parent', childSlug: 'child-a', childUrl: 'https://a.com', childTitle: 'A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.children).toHaveLength(1); // no duplicate
  });

  it('add_child caps at 50', () => {
    const children = [];
    for (let i = 0; i < 50; i++) children.push(`https://child${i}.com`);
    const atom = { slug: 'parent', timestamp: 0, children };
    const entry = { timestamp: 100, action: 'add_child', slug: 'parent', childSlug: 'child-new', childUrl: 'https://new.com', childTitle: 'New' };
    const result = applyLogToAtom(atom, entry);
    expect(result.children).toHaveLength(50);
    expect(result.children[0]).toBe('https://child1.com'); // child0 evicted
    expect(result.children[49]).toBe('https://new.com');
  });

  it('add_child ignores mismatched slug', () => {
    const atom = { slug: 'a', timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'add_child', slug: 'b', childSlug: 'child-x', childUrl: 'https://x.com', childTitle: 'X' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('mixed entry types — irrelevant entries are no-ops', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };

    // Settings entry should not affect atom
    const r1 = applyLogToAtom(atom, { timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(r1).toBe(atom);

    // Pins entry should not affect atom
    const r2 = applyLogToAtom(atom, { timestamp: 200, action: 'pins_replace', collectionId: 'c1', pins: [] });
    expect(r2).toBe(atom);

    // Deletes entry should not affect atom
    const r3 = applyLogToAtom(atom, { timestamp: 300, action: 'deletes_replace', urls: [] });
    expect(r3).toBe(atom);
  });
});

// ---------------------------------------------------------------------------
// applyLogToParentIndex
// ---------------------------------------------------------------------------

describe('applyLogToParentIndex', () => {
  it('accumulates parent slugs for a URL', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, url: 'https://child.com', referrer: 'https://parent.com', slug: 'child-slug', title: 'Child' };
    const result = applyLogToParentIndex(idx, entry);
    expect(Object.keys(result.index)).toHaveLength(1);
    expect(result.index['https://child.com']).toHaveLength(1);
    expect(typeof result.index['https://child.com'][0]).toBe('string');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates multiple parents for the same URL', () => {
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, { timestamp: 100, url: 'https://child.com', referrer: 'https://parent1.com', slug: 'c', title: 'C' });
    idx = applyLogToParentIndex(idx, { timestamp: 200, url: 'https://child.com', referrer: 'https://parent2.com', slug: 'c', title: 'C' });
    expect(idx.index['https://child.com']).toHaveLength(2);
    expect(idx.timestamp).toBe(200);
  });

  it('is idempotent', () => {
    const entry = { timestamp: 100, url: 'https://child.com', referrer: 'https://parent.com', slug: 'c', title: 'C' };
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, entry);
    const r2 = applyLogToParentIndex(idx, entry);
    expect(r2.index['https://child.com']).toEqual(idx.index['https://child.com']);
  });

  it('ignores entries with action field', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'highlight', slug: 'a', highlight: {} };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without referrer', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, url: 'https://a.com', slug: 'a', title: 'A' };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without url', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, referrer: 'https://ref.com', action: undefined };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });
});
