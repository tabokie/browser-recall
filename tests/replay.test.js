/**
 * Replay module unit tests.
 *
 * Verifies that pure replay functions correctly apply log entries to entity
 * state, and that they are idempotent (safe to replay the same entry twice).
 */
import { describe, it, expect } from 'vitest';
import {
  getAffectedSlugs,
  scopeOf,
  applyTo,
  effectOf,
  defaultEntity,
  applyLogToSettings,
  applyLogToAtom,
  applyLogToPins,
  applyLogToDeletes,
  applyLogToRecycleBin,
  applyLogToParentIndex,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// getAffectedSlugs
// ---------------------------------------------------------------------------

describe('getAffectedSlugs', () => {
  it('returns entry slug for visit entry without referrer', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, url: 'https://a.com', title: 'A' });
    expect(slugs.size).toBe(1);
    expect(slugs.has(generateSlugFromUrl('https://a.com'))).toBe(true);
  });

  it('returns both child and parent slugs for visit with referrer', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
    expect(slugs.size).toBe(2);
    expect(slugs.has(generateSlugFromUrl('https://child.com'))).toBe(true);
    expect(slugs.has(generateSlugFromUrl('https://parent.com'))).toBe(true);
  });

  it('returns single slug for action entries', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'highlight', url: 'https://a.com', highlight: {} });
    expect(slugs.size).toBe(1);
    expect(slugs.has(generateSlugFromUrl('https://a.com'))).toBe(true);
  });

  it('returns single slug when referrer is same as url', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://a.com' });
    expect(slugs.size).toBe(1);
  });

  it('returns empty set for entries without url', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(slugs.size).toBe(0);
  });
});

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
  it('updates url, title, timestamp from visit entry (no attention)', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: '', title: '', highlights: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'Page A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.title).toBe('Page A');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates parent URLs from referrer', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['old-slug-abc'] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0]).toBe('old-slug-abc');
    expect(result.parents[1]).toBe('https://google.com'); // stored as URL
  });

  it('does not duplicate existing parent URL', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['https://google.com'] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toEqual(['https://google.com']);
  });

  it('does not duplicate when existing parent is a slug matching the referrer', () => {
    // Simulate post-drain state: parent resolved to slug
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const googleSlug = generateSlugFromUrl('https://google.com');
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [googleSlug] };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('does not duplicate when existing parent is {url,title} object', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [{ url: 'https://google.com', title: 'Google' }] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('caps parents at 50', () => {
    const parents = [];
    for (let i = 0; i < 50; i++) parents.push(`https://ref${i}.com`);
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://new-ref.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(50);
    expect(result.parents[0]).toBe('https://ref1.com'); // ref0 evicted
  });

  it('ignores visit entry with mismatched slug', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 100, url: 'https://b.com', title: 'B' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('applies visit to atom without slug field (new atom)', () => {
    const atom = { timestamp: 0, highlights: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent for visit entries', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [] };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A', referrer: 'https://ref.com' };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — parent-side children accumulation
// ---------------------------------------------------------------------------

describe('applyLogToAtom — children from referrer', () => {
  it('accumulates child URL on parent atom when visit has referrer', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toBe('https://child.com');
    expect(result.timestamp).toBe(100);
  });

  it('does not duplicate existing child URL string', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: ['https://child.com'] };
    const entry = { timestamp: 200, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
  });

  it('does not duplicate existing child {url,title} object', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [{ url: 'https://child.com', title: 'Child' }] };
    const entry = { timestamp: 200, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
  });

  it('caps children at REFERRER_CAP (50)', () => {
    const children = [];
    for (let i = 0; i < 50; i++) children.push(`https://child${i}.com`);
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children };
    const entry = { timestamp: 200, url: 'https://new-child.com', title: 'New', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(50);
    expect(result.children[0]).toBe('https://child1.com'); // child0 evicted
    expect(result.children[49]).toBe('https://new-child.com');
  });

  it('ignores visit without referrer (no parent-side effect)', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result).toBe(parentAtom); // slug mismatch, no referrer path
  });

  it('ignores visit where referrer does not match parent slug', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://other.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result).toBe(parentAtom);
  });

  it('is idempotent', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const r1 = applyLogToAtom(parentAtom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('advances timestamp to max of existing and entry', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 500, children: [] };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.timestamp).toBe(500); // keeps higher existing
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

describe('applyLogToPins — list operations', () => {
  it('adds pins and preserves metadata', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', qbTree: null, pins: [{ url: 'https://old.com', title: 'Old', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'user/uuid-1', op: 'add', urls: ['https://new.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(2);
    expect(result.pins[1].url).toBe('https://new.com');
    expect(result.pins[1].title).toBe('Untitled');
    expect(result.pins[1].pinnedAt).toBe(100);
    expect(result.timestamp).toBe(100);
    expect(result.name).toBe('Rust');
    expect(result.query).toBe('rust');
    expect(result.id).toBe('uuid-1');
  });

  it('removes pins', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }, { url: 'https://b.com', title: 'B', pinnedAt: 60 }] };
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'del', urls: ['https://a.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].url).toBe('https://b.com');
  });

  it('clears pins', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'clear', urls: [] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toEqual([]);
    expect(result.timestamp).toBe(100);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: {} };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'user/c2', op: 'add', urls: ['https://a.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'add', urls: ['https://a.com'] };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2.pins).toHaveLength(1); // Doesn't duplicate
  });
});

describe('applyLogToPins — list_meta', () => {
  it('merges metadata fields and preserves pins', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Old Name', query: 'old', qbTree: null, pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'New Name', query: 'new' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('New Name');
    expect(result.query).toBe('new');
    expect(result.id).toBe('uuid-1');
    expect(result.pins).toEqual(entity.pins);
    expect(result.timestamp).toBe(100);
  });

  it('updates only provided fields', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', qbTree: null, pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'Rust Lang' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('Rust Lang');
    expect(result.query).toBe('rust');
    expect(result.qbTree).toBeNull();
  });

  it('sets qbTree', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', query: '', qbTree: null, pins: [] };
    const tree = { type: 'AND', children: [{ type: 'keyword', value: 'rust' }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', qbTree: tree };
    const result = applyLogToPins(entity, entry);
    expect(result.qbTree).toEqual(tree);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, id: 'c1', name: 'Test', query: 'test', qbTree: null, pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/c2', name: 'Updated' };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity); // No change
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', query: 'test', qbTree: null, pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'Updated' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

describe('applyLogToPins — del_list', () => {
  it('returns deleted entity', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', query: 'rust', pins: [{ url: 'https://a.com' }] };
    const entry = { timestamp: 100, action: 'del_list', id: 'user/uuid-1' };
    const result = applyLogToPins(entity, entry);
    expect(result.deleted).toBe(true);
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, id: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'del_list', id: 'user/c1' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToDeletes
// ---------------------------------------------------------------------------

describe('applyLogToDeletes', () => {
  it('adds urls', () => {
    const entity = { timestamp: 0, urls: ['https://old.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://new.com'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.urls).toEqual(['https://old.com', 'https://new.com']);
    expect(result.timestamp).toBe(100);
  });

  it('removes urls', () => {
    const entity = { timestamp: 0, urls: ['https://a.com', 'https://b.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'del', urls: ['https://a.com'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.urls).toEqual(['https://b.com']);
  });

  it('clears urls', () => {
    const entity = { timestamp: 0, urls: ['https://a.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'clear', urls: [] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.urls).toEqual([]);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, urls: [] };
    const entry = { timestamp: 100, action: 'highlight', slug: 'x', highlight: {} };
    const result = applyLogToDeletes(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, urls: [] };
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'add', urls: ['https://a.com'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, urls: [] };
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://a.com'] };
    const r1 = applyLogToDeletes(entity, entry);
    const r2 = applyLogToDeletes(r1, entry);
    expect(r2.urls).toEqual(['https://a.com']); // Doesn't duplicate
  });
});

// ---------------------------------------------------------------------------
// applyLogToRecycleBin
// ---------------------------------------------------------------------------

describe('applyLogToRecycleBin', () => {
  it('adds items', () => {
    const entity = { timestamp: 0, items: [{ url: 'https://old.com', title: 'Old', deletedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'add', urls: ['https://new.com'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].url).toBe('https://new.com');
    expect(result.items[1].title).toBe('Untitled');
    expect(result.items[1].deletedAt).toBe(100);
    expect(result.timestamp).toBe(100);
  });

  it('removes items', () => {
    const entity = { timestamp: 0, items: [{ url: 'https://a.com', title: 'A', deletedAt: 50 }, { url: 'https://b.com', title: 'B', deletedAt: 60 }] };
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'del', urls: ['https://a.com'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBe('https://b.com');
  });

  it('clears items', () => {
    const entity = { timestamp: 0, items: [{ url: 'https://a.com', title: 'A', deletedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'clear', urls: [] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toEqual([]);
    expect(result.timestamp).toBe(100);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: {} };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://a.com'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'add', urls: ['https://a.com'] };
    const r1 = applyLogToRecycleBin(entity, entry);
    const r2 = applyLogToRecycleBin(r1, entry);
    expect(r2.items).toHaveLength(1); // Doesn't duplicate
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
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime(); // Jan 15 local
    const result = applyLogToAtom(atom, { timestamp: ts1, url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([toYMD(ts1)]);
  });

  it('does not duplicate same-day visits', () => {
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 15, 18, 0, 0).getTime();
    const ymd = toYMD(ts1);
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [], visitDates: [ymd] };
    const result = applyLogToAtom(atom, { timestamp: ts2, url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([ymd]);
  });

  it('accumulates multiple distinct days', () => {
    let atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 16, 10, 0, 0).getTime();
    atom = applyLogToAtom(atom, { timestamp: ts1, url: 'https://a.com', title: 'A' });
    atom = applyLogToAtom(atom, { timestamp: ts2, url: 'https://a.com', title: 'A' });
    expect(atom.visitDates).toEqual([toYMD(ts1), toYMD(ts2)]);
  });

  it('does not add visitDates for non-visit entries', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };
    const result = applyLogToAtom(atom, { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: 'x', timestamp: 100 } });
    expect(result.visitDates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — create_checkpoint
// ---------------------------------------------------------------------------

describe('applyLogToAtom — create_checkpoint', () => {
  it('creates a minimal atom from create_checkpoint', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'create_checkpoint', url: 'https://ref.com', title: 'Referrer Page' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Referrer Page');
    expect(result.timestamp).toBe(500);
  });

  it('does not overwrite existing url/title', () => {
    const atom = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 100, url: 'https://ref.com', title: 'Original Title' };
    const entry = { timestamp: 500, action: 'create_checkpoint', url: 'https://ref.com', title: 'New Title' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Original Title');
    expect(result.timestamp).toBe(500);
  });

  it('advances timestamp to max', () => {
    const atom = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 600, url: 'https://ref.com', title: 'X' };
    const entry = { timestamp: 500, action: 'create_checkpoint', url: 'https://ref.com', title: '' };
    const result = applyLogToAtom(atom, entry);
    expect(result.timestamp).toBe(600); // keeps higher existing timestamp
  });

  it('ignores mismatched slug', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 500, action: 'create_checkpoint', url: 'https://b.com', title: 'B' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('is idempotent', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'create_checkpoint', url: 'https://x.com', title: 'X' };
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
    let atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };

    // Visit
    atom = applyLogToAtom(atom, { timestamp: 100, url: 'https://a.com', title: 'A' });
    expect(atom.url).toBe('https://a.com');
    expect(atom.timestamp).toBe(100);

    // Highlight
    atom = applyLogToAtom(atom, { timestamp: 200, action: 'highlight', url: 'https://a.com', highlight: { text: 'hello', note: '', timestamp: 200 } });
    expect(atom.highlights).toHaveLength(1);

    // Another highlight
    atom = applyLogToAtom(atom, { timestamp: 300, action: 'highlight', url: 'https://a.com', highlight: { text: 'world', note: '', timestamp: 300 } });
    expect(atom.highlights).toHaveLength(2);

    // Unhighlight first
    atom = applyLogToAtom(atom, { timestamp: 400, action: 'unhighlight', url: 'https://a.com', matchTimestamp: 200 });
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

  it('mixed entry types — irrelevant entries are no-ops', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [] };

    // Settings entry should not affect atom
    const r1 = applyLogToAtom(atom, { timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(r1).toBe(atom);

    // List entry should not affect atom
    const r2 = applyLogToAtom(atom, { timestamp: 200, action: 'list', id: 'user/c1', op: 'clear', urls: [] });
    expect(r2).toBe(atom);

    // Deletes list entry should not affect atom
    const r3 = applyLogToAtom(atom, { timestamp: 300, action: 'list', id: 'permanent-deletes', op: 'clear', urls: [] });
    expect(r3).toBe(atom);
  });
});

// ---------------------------------------------------------------------------
// applyLogToParentIndex
// ---------------------------------------------------------------------------

describe('applyLogToParentIndex', () => {
  it('accumulates parent slugs for a URL', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, url: 'https://child.com', referrer: 'https://parent.com', title: 'Child' };
    const result = applyLogToParentIndex(idx, entry);
    expect(Object.keys(result.index)).toHaveLength(1);
    expect(result.index['https://child.com']).toHaveLength(1);
    expect(typeof result.index['https://child.com'][0]).toBe('string');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates multiple parents for the same URL', () => {
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, { timestamp: 100, url: 'https://child.com', referrer: 'https://parent1.com', title: 'C' });
    idx = applyLogToParentIndex(idx, { timestamp: 200, url: 'https://child.com', referrer: 'https://parent2.com', title: 'C' });
    expect(idx.index['https://child.com']).toHaveLength(2);
    expect(idx.timestamp).toBe(200);
  });

  it('is idempotent', () => {
    const entry = { timestamp: 100, url: 'https://child.com', referrer: 'https://parent.com', title: 'C' };
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, entry);
    const r2 = applyLogToParentIndex(idx, entry);
    expect(r2.index['https://child.com']).toEqual(idx.index['https://child.com']);
  });

  it('ignores entries with action field', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'highlight', highlight: {} };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without referrer', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without url', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, referrer: 'https://ref.com' };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });
});

// ---------------------------------------------------------------------------
// scopeOf
// ---------------------------------------------------------------------------

describe('scopeOf', () => {
  it('returns settings key for set entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(Object.keys(scope)).toEqual(['settings']);
  });

  it('returns list key for list entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'user/c1', op: 'add', urls: ['https://a.com'] });
    expect(Object.keys(scope)).toEqual(['list:user/c1']);
  });

  it('returns list key for list_meta entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list_meta', id: 'user/c1', name: 'Test' });
    expect(Object.keys(scope)).toEqual(['list:user/c1']);
  });

  it('returns list key for del_list entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'del_list', id: 'user/c1' });
    expect(Object.keys(scope)).toEqual(['list:user/c1']);
  });

  it('returns atom key for visit entry without referrer', () => {
    const scope = scopeOf({ timestamp: 100, url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope)).toEqual([`atom:${slug}`]);
  });

  it('returns atom + parent-index keys for visit with referrer', () => {
    const scope = scopeOf({ timestamp: 100, url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const keys = Object.keys(scope).sort();
    expect(keys).toEqual([`atom:${childSlug}`, `atom:${parentSlug}`, 'index:parent-index'].sort());
  });

  it('returns atom key for highlight entry', () => {
    const scope = scopeOf({ timestamp: 100, action: 'highlight', url: 'https://a.com', highlight: {} });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope)).toEqual([`atom:${slug}`]);
  });

  it('returns atom key for create_checkpoint entry', () => {
    const scope = scopeOf({ timestamp: 100, action: 'create_checkpoint', url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope)).toEqual([`atom:${slug}`, 'index:parent-index']);
  });

  it('returns recycle-bin key', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'recycle-bin', op: 'add', urls: ['https://a.com'] });
    expect(Object.keys(scope)).toEqual(['list:recycle-bin']);
  });

  it('returns permanent-deletes key', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://a.com'] });
    expect(Object.keys(scope)).toEqual(['list:permanent-deletes']);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity
// ---------------------------------------------------------------------------

describe('defaultEntity', () => {
  it('returns atom default with slug', () => {
    const e = defaultEntity('atom:my-slug');
    expect(e).toEqual({ slug: 'my-slug', timestamp: 0, highlights: [], parents: [], children: [] });
  });

  it('returns settings default', () => {
    expect(defaultEntity('settings')).toEqual({ timestamp: 0 });
  });

  it('returns collection default with id', () => {
    const e = defaultEntity('list:user/uuid-1');
    expect(e).toEqual({ timestamp: 0, id: 'uuid-1', name: '', query: '', qbTree: null, pins: [] });
  });

  it('returns recycle-bin default', () => {
    expect(defaultEntity('list:recycle-bin')).toEqual({ timestamp: 0, items: [] });
  });

  it('returns permanent-deletes default', () => {
    expect(defaultEntity('list:permanent-deletes')).toEqual({ timestamp: 0, urls: [] });
  });

  it('returns parent-index default', () => {
    expect(defaultEntity('index:parent-index')).toEqual({ timestamp: 0, index: {} });
  });

  it('returns null for unknown key', () => {
    expect(defaultEntity('unknown:foo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyTo
// ---------------------------------------------------------------------------

describe('applyTo', () => {
  it('applies set entry to settings', () => {
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const scope = { settings: { timestamp: 0 } };
    const result = applyTo(entry, scope);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
    expect(result.settings.timestamp).toBe(100);
  });

  it('creates settings from null on first set', () => {
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const scope = { settings: null };
    const result = applyTo(entry, scope);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
    expect(result.settings.timestamp).toBe(100);
  });

  it('applies visit to atom', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const scope = { [`atom:${slug}`]: { slug, timestamp: 0, highlights: [], parents: [], children: [] } };
    const result = applyTo(entry, scope);
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
    expect(result[`atom:${slug}`].timestamp).toBe(100);
  });

  it('only create_checkpoint can create atom from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const visit = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const result = applyTo(visit, { [`atom:${slug}`]: null });
    expect(result[`atom:${slug}`]).toBeNull();
  });

  it('create_checkpoint creates atom from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'create_checkpoint', url: 'https://a.com', title: 'A' };
    const result = applyTo(entry, { [`atom:${slug}`]: null });
    expect(result[`atom:${slug}`]).not.toBeNull();
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
  });

  it('applies visit with referrer to both child and parent atoms', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] },
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    // Child gets visit data + parent ref
    expect(result[`atom:${childSlug}`].url).toBe('https://child.com');
    expect(result[`atom:${childSlug}`].parents).toContain('https://parent.com');
    // Parent gets child URL
    expect(result[`atom:${parentSlug}`].children).toContain('https://child.com');
    // Parent-index updated
    expect(result['index:parent-index'].index['https://child.com']).toHaveLength(1);
  });

  it('skips parent atom update when parent is null (no checkpoint)', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: null,
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    expect(result[`atom:${parentSlug}`]).toBeNull(); // stays null
    expect(result[`atom:${childSlug}`].parents).toContain('https://parent.com');
  });

  it('applies list entry to collection', () => {
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:user/c1': { timestamp: 0, id: 'c1', name: 'Test', query: '', qbTree: null, pins: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:user/c1'].pins).toHaveLength(1);
    expect(result['list:user/c1'].pins[0].url).toBe('https://a.com');
  });

  it('creates collection from null on first list entry', () => {
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:user/c1': null };
    const result = applyTo(entry, scope);
    expect(result['list:user/c1'].pins).toHaveLength(1);
    expect(result['list:user/c1'].id).toBe('c1');
  });

  it('applies list entry to recycle-bin', () => {
    const entry = { timestamp: 100, action: 'list', id: 'recycle-bin', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:recycle-bin': { timestamp: 0, items: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:recycle-bin'].items).toHaveLength(1);
  });

  it('applies list entry to permanent-deletes', () => {
    const entry = { timestamp: 100, action: 'list', id: 'permanent-deletes', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:permanent-deletes': { timestamp: 0, urls: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:permanent-deletes'].urls).toEqual(['https://a.com']);
  });

  it('applies report entry to atom', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'report', url: 'https://a.com', scrollDepth: 0.5, timeOnPage: 3000 };
    const atom = { slug, timestamp: 100, highlights: [], parents: [], children: [] };
    const result = applyTo(entry, { [`atom:${slug}`]: atom });
    const att = JSON.parse(result[`atom:${slug}`].attention);
    expect(att.scrollDepth).toBe(0.5);
    expect(att.timeOnPage).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// effectOf
// ---------------------------------------------------------------------------

describe('effectOf', () => {
  it('loads entities via closure and applies entry', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = { [`atom:${slug}`]: { slug, timestamp: 0, highlights: [], parents: [], children: [] } };
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
    expect(result[`atom:${slug}`].timestamp).toBe(100);
  });

  it('returns null for uncached atom on visit (no create)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`atom:${slug}`]).toBeNull();
  });

  it('creates atom from null on create_checkpoint', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'create_checkpoint', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`atom:${slug}`]).not.toBeNull();
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
  });

  it('updates mutable round cache across sequential calls', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const cache = new Map();

    const load = async (key) => cache.get(key) ?? null;

    // First: create_checkpoint creates the atom
    const r1 = await effectOf(
      { timestamp: 100, action: 'create_checkpoint', url: 'https://a.com', title: 'A' },
      load
    );
    // Write back to cache
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    // Second: visit updates the atom (now non-null in cache)
    const r2 = await effectOf(
      { timestamp: 200, url: 'https://a.com', title: 'Updated A' },
      load
    );
    expect(r2[`atom:${slug}`].title).toBe('Updated A');
    expect(r2[`atom:${slug}`].timestamp).toBe(200);
  });

  it('handles visit with referrer updating both atoms via closure', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] },
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const entry = { timestamp: 100, url: 'https://child.com', title: 'C', referrer: 'https://parent.com' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`atom:${childSlug}`].parents).toContain('https://parent.com');
    expect(result[`atom:${parentSlug}`].children).toContain('https://child.com');
    expect(result['index:parent-index'].index['https://child.com']).toHaveLength(1);
  });

  it('applies settings entry via closure', async () => {
    const store = { settings: { timestamp: 0, workspace: { mode: 'default' } } };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
  });

  it('visit then create_checkpoint preserves parent info for child', async () => {
    // Simulates offscreen drain: visit(child, referrer=parent) THEN create_checkpoint(child).
    // The visit can't populate atom.parents (child atom is null).
    // The create_checkpoint creates the atom but without parents.
    // Parent-index must NOT be pruned, because atom.parents is empty.
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const cache = new Map();

    // Seed: parent atom exists, child does not
    cache.set(`atom:${parentSlug}`, { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] });
    // child atom is absent (null)

    const load = async (key) => cache.get(key) ?? null;

    // Entry 1: visit child with referrer=parent — child atom is null, stays null
    const r1 = await effectOf(
      { timestamp: 100, url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    // Child atom should still be null (visit can't create from null)
    expect(cache.get(`atom:${childSlug}`)).toBeNull();
    // Parent-index should have the parent info
    expect(cache.get('index:parent-index').index['https://child.com']).toEqual([parentSlug]);
    // Parent atom should have child in children
    expect(cache.get(`atom:${parentSlug}`).children).toContain('https://child.com');

    // Entry 2: create_checkpoint for child — creates atom, but visit already passed
    const r2 = await effectOf(
      { timestamp: 101, action: 'create_checkpoint', url: 'https://child.com', title: 'Child' },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    // Child atom now exists with parents absorbed from parent-index
    const childAtom = cache.get(`atom:${childSlug}`);
    expect(childAtom).not.toBeNull();
    expect(childAtom.parents).toEqual([parentSlug]);

    // Parent-index entry absorbed into atom — should be removed
    const parentIndex = cache.get('index:parent-index');
    expect(parentIndex.index['https://child.com']).toBeUndefined();

    // --- Simulate offscreen flush prune (offscreen.js lines ~509-522) ---
    // Prune is now safe: atom.parents has the info, parent-index entry already gone.
    const checkpointedSlugs = new Set();
    for (const key of cache.keys()) {
      if (key.startsWith('atom:') && cache.get(key) !== null) {
        checkpointedSlugs.add(key.slice(5));
      }
    }
    const idx = { ...parentIndex, index: { ...parentIndex.index } };
    for (const url of Object.keys(idx.index)) {
      const urlSlug = generateSlugFromUrl(url);
      if (checkpointedSlugs.has(urlSlug)) {
        delete idx.index[url];
      }
    }

    // Parent info preserved in atom.parents — prune doesn't lose anything
    expect(childAtom.parents).toEqual([parentSlug]);
  });
});
