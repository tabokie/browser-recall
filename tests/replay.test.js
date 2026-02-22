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
  it('returns entry slug for page entry without referrer', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
    expect(slugs.size).toBe(1);
    expect(slugs.has(generateSlugFromUrl('https://a.com'))).toBe(true);
  });

  it('returns both child and parent slugs for page with referrer', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
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
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://a.com' });
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

  it('ignores page entries', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToSettings(settings, entry);
    expect(result).toBe(settings);
  });

  it('is idempotent', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'set', key: 'lists', value: [{ id: 'c1' }] };
    const r1 = applyLogToSettings(settings, entry);
    const r2 = applyLogToSettings(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('preserves unrelated keys', () => {
    const settings = { timestamp: 0, workspace: { mode: 'default' }, lists: [{ id: 'c1' }] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = applyLogToSettings(settings, entry);
    expect(result.lists).toEqual([{ id: 'c1' }]);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — visit entries
// ---------------------------------------------------------------------------

describe('applyLogToAtom — page (visit)', () => {
  it('updates url, title, timestamp from page entry', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: '', title: '', highlights: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.title).toBe('Page A');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates parent URLs from referrer', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['old-slug-abc'] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0]).toBe('old-slug-abc');
    expect(result.parents[1]).toBe('https://google.com'); // stored as URL
  });

  it('does not duplicate existing parent URL', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['https://google.com'] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toEqual(['https://google.com']);
  });

  it('does not duplicate when existing parent is a slug matching the referrer', () => {
    // Simulate post-drain state: parent resolved to slug
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const googleSlug = generateSlugFromUrl('https://google.com');
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [googleSlug] };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('does not duplicate when existing parent is {url,title} object', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [{ url: 'https://google.com', title: 'Google' }] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(1); // no duplicate
  });

  it('caps parents at 50', () => {
    const parents = [];
    for (let i = 0; i < 50; i++) parents.push(`https://ref${i}.com`);
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://new-ref.com' };
    const result = applyLogToAtom(atom, entry);
    expect(result.parents).toHaveLength(50);
    expect(result.parents[0]).toBe('https://ref1.com'); // ref0 evicted
  });

  it('ignores page entry with mismatched slug', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 100, action: 'page', url: 'https://b.com', title: 'B' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('applies page to atom without slug field (new atom)', () => {
    const atom = { timestamp: 0, highlights: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent for page entries', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://ref.com' };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — title change via attention report
// ---------------------------------------------------------------------------

describe('applyLogToAtom — title update from attention report', () => {
  it('attention report with title updates atom title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    // Initial visit sets title
    let atom = { slug, timestamp: 0, url: '', title: '', highlights: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Old Title' };
    atom = applyLogToAtom(atom, visit);
    expect(atom.title).toBe('Old Title');

    // Attention report carries updated title (title changed after initial visit)
    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', title: 'New Title', scrollDepth: 80, timeOnPage: 5000 };
    atom = applyLogToAtom(atom, attention);
    expect(atom.title).toBe('New Title');
  });

  it('attention report without title preserves existing title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let atom = { slug, timestamp: 0, url: '', title: '', highlights: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page Title' };
    atom = applyLogToAtom(atom, visit);

    // Attention report without title field — title should not be wiped
    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 50, timeOnPage: 3000 };
    atom = applyLogToAtom(atom, attention);
    expect(atom.title).toBe('Page Title');
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — parent-side children accumulation
// ---------------------------------------------------------------------------

describe('applyLogToAtom — children from referrer', () => {
  it('accumulates child URL on parent atom when page has referrer', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toBe('https://child.com');
    expect(result.timestamp).toBe(100);
  });

  it('does not duplicate existing child URL string', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: ['https://child.com'] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
  });

  it('does not duplicate existing child {url,title} object', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [{ url: 'https://child.com', title: 'Child' }] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(1);
  });

  it('caps children at REFERRER_CAP (50)', () => {
    const children = [];
    for (let i = 0; i < 50; i++) children.push(`https://child${i}.com`);
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children };
    const entry = { timestamp: 200, action: 'page', url: 'https://new-child.com', title: 'New', referrer: 'https://parent.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result.children).toHaveLength(50);
    expect(result.children[0]).toBe('https://child1.com'); // child0 evicted
    expect(result.children[49]).toBe('https://new-child.com');
  });

  it('ignores page without referrer (no parent-side effect)', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result).toBe(parentAtom); // slug mismatch, no referrer path
  });

  it('ignores page where referrer does not match parent slug', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://other.com' };
    const result = applyLogToAtom(parentAtom, entry);
    expect(result).toBe(parentAtom);
  });

  it('is idempotent', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const r1 = applyLogToAtom(parentAtom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('advances timestamp to max of existing and entry', () => {
    const parentAtom = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 500, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
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

describe('applyLogToAtom — capture (via page)', () => {
  it('sets mdPath and htmlPath', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const atom = { slug, timestamp: 0 };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', mdPath: 'pages/a/100.md', htmlPath: 'pages/a/100.html' };
    const result = applyLogToAtom(atom, entry);
    expect(result.mdPath).toBe('pages/a/100.md');
    expect(result.htmlPath).toBe('pages/a/100.html');
    expect(result.timestamp).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPins
// ---------------------------------------------------------------------------

describe('applyLogToPins — list operations', () => {
  it('adds pins and preserves metadata', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', qbTrees: [], pins: [{ url: 'https://old.com', title: 'Old', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'user/uuid-1', op: 'add', urls: ['https://new.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(2);
    expect(result.pins[1].url).toBe('https://new.com');
    expect(result.pins[1].title).toBe('Untitled');
    expect(result.pins[1].pinnedAt).toBe(100);
    expect(result.timestamp).toBe(100);
    expect(result.name).toBe('Rust');
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
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Old Name', qbTrees: [], pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'New Name' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('New Name');
    expect(result.id).toBe('uuid-1');
    expect(result.pins).toEqual(entity.pins);
    expect(result.timestamp).toBe(100);
  });

  it('updates only provided fields', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', qbTrees: [], pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'Rust Lang' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('Rust Lang');
    expect(result.qbTrees).toEqual([]);
  });

  it('sets qbTrees', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', qbTrees: [], pins: [] };
    const tree = { type: 'AND', children: [{ type: 'keyword', value: 'rust' }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'Test', qbTrees: [tree] };
    const result = applyLogToPins(entity, entry);
    expect(result.qbTrees).toEqual([tree]);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, id: 'c1', name: 'Test', qbTrees: [], pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/c2', name: 'Updated' };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity); // No change
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Test', qbTrees: [], pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'user/uuid-1', name: 'Updated' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

describe('applyLogToPins — del_list', () => {
  it('returns deleted entity', () => {
    const entity = { timestamp: 0, id: 'uuid-1', name: 'Rust', pins: [{ url: 'https://a.com' }] };
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

  it('accumulates visitDates from page entries', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime(); // Jan 15 local
    const result = applyLogToAtom(atom, { timestamp: ts1, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([toYMD(ts1)]);
  });

  it('does not duplicate same-day visits', () => {
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 15, 18, 0, 0).getTime();
    const ymd = toYMD(ts1);
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [], visitDates: [ymd] };
    const result = applyLogToAtom(atom, { timestamp: ts2, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([ymd]);
  });

  it('accumulates multiple distinct days', () => {
    let atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 16, 10, 0, 0).getTime();
    atom = applyLogToAtom(atom, { timestamp: ts1, action: 'page', url: 'https://a.com', title: 'A' });
    atom = applyLogToAtom(atom, { timestamp: ts2, action: 'page', url: 'https://a.com', title: 'A' });
    expect(atom.visitDates).toEqual([toYMD(ts1), toYMD(ts2)]);
  });

  it('does not add visitDates for non-page entries', () => {
    const atom = { slug: 'a', timestamp: 0, highlights: [] };
    const result = applyLogToAtom(atom, { timestamp: 100, action: 'highlight', slug: 'a', highlight: { text: 'x', timestamp: 100 } });
    expect(result.visitDates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyLogToAtom — page_checkpoint
// ---------------------------------------------------------------------------

describe('applyLogToAtom — page_checkpoint', () => {
  it('creates a minimal atom from page_checkpoint', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: 'Referrer Page' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Referrer Page');
    expect(result.timestamp).toBe(500);
  });

  it('does not overwrite existing url/title', () => {
    const atom = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 100, url: 'https://ref.com', title: 'Original Title' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: 'New Title' };
    const result = applyLogToAtom(atom, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Original Title');
    expect(result.timestamp).toBe(500);
  });

  it('advances timestamp to max', () => {
    const atom = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 600, url: 'https://ref.com', title: 'X' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: '' };
    const result = applyLogToAtom(atom, entry);
    expect(result.timestamp).toBe(600); // keeps higher existing timestamp
  });

  it('ignores mismatched slug', () => {
    const atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://b.com', title: 'B' };
    const result = applyLogToAtom(atom, entry);
    expect(result).toBe(atom);
  });

  it('is idempotent', () => {
    const atom = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://x.com', title: 'X' };
    const r1 = applyLogToAtom(atom, entry);
    const r2 = applyLogToAtom(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// Sequence replay — applying multiple entries in order
// ---------------------------------------------------------------------------

describe('sequence replay', () => {
  it('replaying page + highlight + unhighlight produces correct atom', () => {
    let atom = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, highlights: [], parents: [] };

    // Page (visit)
    atom = applyLogToAtom(atom, { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
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
    settings = applyLogToSettings(settings, { timestamp: 200, action: 'set', key: 'lists', value: [{ id: 'c1' }] });
    settings = applyLogToSettings(settings, { timestamp: 300, action: 'set', key: 'workspace', value: { mode: 'private' } });

    expect(settings.workspace).toEqual({ mode: 'private' });
    expect(settings.lists).toEqual([{ id: 'c1' }]);
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
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', referrer: 'https://parent.com', title: 'Child' };
    const result = applyLogToParentIndex(idx, entry);
    expect(Object.keys(result.index)).toHaveLength(1);
    expect(result.index['https://child.com']).toHaveLength(1);
    expect(typeof result.index['https://child.com'][0]).toBe('string');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates multiple parents for the same URL', () => {
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, { timestamp: 100, action: 'page', url: 'https://child.com', referrer: 'https://parent1.com', title: 'C' });
    idx = applyLogToParentIndex(idx, { timestamp: 200, action: 'page', url: 'https://child.com', referrer: 'https://parent2.com', title: 'C' });
    expect(idx.index['https://child.com']).toHaveLength(2);
    expect(idx.timestamp).toBe(200);
  });

  it('is idempotent', () => {
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', referrer: 'https://parent.com', title: 'C' };
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToParentIndex(idx, entry);
    const r2 = applyLogToParentIndex(idx, entry);
    expect(r2.index['https://child.com']).toEqual(idx.index['https://child.com']);
  });

  it('ignores entries with non-page action', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'highlight', highlight: {} };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores page entries without referrer', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToParentIndex(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without url', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'page', referrer: 'https://ref.com' };
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

  it('returns atom key for page entry without referrer', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope)).toEqual([`atom:${slug}`]);
  });

  it('returns atom + parent-index keys for page with referrer', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
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

  it('returns atom + parent-index keys for page_checkpoint entry', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' });
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

  it('returns list default with id', () => {
    const e = defaultEntity('list:user/uuid-1');
    expect(e).toEqual({ timestamp: 0, id: 'uuid-1', name: '', qbTrees: [], pins: [] });
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

  it('applies page to atom', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const scope = { [`atom:${slug}`]: { slug, timestamp: 0, highlights: [], parents: [], children: [] } };
    const result = applyTo(entry, scope);
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
    expect(result[`atom:${slug}`].timestamp).toBe(100);
  });

  it('only page_checkpoint can create atom from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyTo(page, { [`atom:${slug}`]: null });
    expect(result[`atom:${slug}`]).toBeNull();
  });

  it('page_checkpoint creates atom from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = applyTo(entry, { [`atom:${slug}`]: null });
    expect(result[`atom:${slug}`]).not.toBeNull();
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
  });

  it('applies page with referrer to both child and parent atoms', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] },
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    // Child gets visit data + parent ref (resolved to slug since parent atom exists in scope)
    expect(result[`atom:${childSlug}`].url).toBe('https://child.com');
    expect(result[`atom:${childSlug}`].parents).toContain(parentSlug);
    // Parent gets child ref (resolved to slug since child atom exists in scope)
    expect(result[`atom:${parentSlug}`].children).toContain(childSlug);
    // Parent-index pruned (child atom exists in scope)
    expect(result['index:parent-index'].index['https://child.com']).toBeUndefined();
  });

  it('skips parent atom update when parent is null (no checkpoint)', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: null,
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    expect(result[`atom:${parentSlug}`]).toBeNull(); // stays null
    expect(result[`atom:${childSlug}`].parents).toContain('https://parent.com');
  });

  it('applies list entry to list entity', () => {
    const entry = { timestamp: 100, action: 'list', id: 'user/c1', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:user/c1': { timestamp: 0, id: 'c1', name: 'Test', qbTrees: [], pins: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:user/c1'].pins).toHaveLength(1);
    expect(result['list:user/c1'].pins[0].url).toBe('https://a.com');
  });

  it('creates list entity from null on first list entry', () => {
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

  it('applies page attention entry to atom', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 0.5, timeOnPage: 3000 };
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
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
    expect(result[`atom:${slug}`].timestamp).toBe(100);
  });

  it('returns null for uncached atom on page (no create)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`atom:${slug}`]).toBeNull();
  });

  it('creates atom from null on page_checkpoint', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`atom:${slug}`]).not.toBeNull();
    expect(result[`atom:${slug}`].url).toBe('https://a.com');
  });

  it('updates mutable round cache across sequential calls', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const cache = new Map();

    const load = async (key) => cache.get(key) ?? null;

    // First: page_checkpoint creates the atom
    const r1 = await effectOf(
      { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' },
      load
    );
    // Write back to cache
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    // Second: page updates the atom (now non-null in cache)
    const r2 = await effectOf(
      { timestamp: 200, action: 'page', url: 'https://a.com', title: 'Updated A' },
      load
    );
    expect(r2[`atom:${slug}`].title).toBe('Updated A');
    expect(r2[`atom:${slug}`].timestamp).toBe(200);
  });

  it('handles page with referrer updating both atoms via closure', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`atom:${childSlug}`]: { slug: childSlug, timestamp: 0, highlights: [], parents: [], children: [] },
      [`atom:${parentSlug}`]: { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] },
      'index:parent-index': { timestamp: 0, index: {} },
    };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    // Post-loop resolves URLs to slugs since both atoms exist in scope
    expect(result[`atom:${childSlug}`].parents).toContain(parentSlug);
    expect(result[`atom:${parentSlug}`].children).toContain(childSlug);
    // Parent-index pruned since child atom exists in scope
    expect(result['index:parent-index'].index['https://child.com']).toBeUndefined();
  });

  it('applies settings entry via closure', async () => {
    const store = { settings: { timestamp: 0, workspace: { mode: 'default' } } };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
  });

  it('page then page_checkpoint preserves parent info for child', async () => {
    // Simulates offscreen drain: page(child, referrer=parent) THEN page_checkpoint(child).
    // The page can't populate atom.parents (child atom is null).
    // The page_checkpoint creates the atom but without parents.
    // Parent-index must NOT be pruned, because atom.parents is empty.
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const cache = new Map();

    // Seed: parent atom exists, child does not
    cache.set(`atom:${parentSlug}`, { slug: parentSlug, timestamp: 50, highlights: [], parents: [], children: [] });
    // child atom is absent (null)

    const load = async (key) => cache.get(key) ?? null;

    // Entry 1: page child with referrer=parent — child atom is null, stays null
    const r1 = await effectOf(
      { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    // Child atom should still be null (page can't create from null)
    expect(cache.get(`atom:${childSlug}`)).toBeNull();
    // Parent-index should have the parent info
    expect(cache.get('index:parent-index').index['https://child.com']).toEqual([parentSlug]);
    // Parent atom should have child in children
    expect(cache.get(`atom:${parentSlug}`).children).toContain('https://child.com');

    // Entry 2: page_checkpoint for child — creates atom, but page already passed
    const r2 = await effectOf(
      { timestamp: 101, action: 'page_checkpoint', url: 'https://child.com', title: 'Child' },
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
