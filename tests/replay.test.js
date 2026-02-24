/**
 * Replay module unit tests.
 *
 * Verifies that pure replay functions correctly apply log entries to entity
 * state, and that they are idempotent (safe to replay the same entry twice).
 */
import { describe, it, expect } from 'vitest';
import {
  getAffectedSlugs,
  getAffectedKeys,
  scopeOf,
  applyTo,
  effectOf,
  defaultEntity,
  applyLogToSettings,
  applyLogToPage,
  applyLogToNote,
  applyLogToPins,
  applyLogToDeletes,
  applyLogToRecycleBin,
  applyLogToParentIndex,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// getAffectedSlugs / getAffectedKeys
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

  it('returns single slug when referrer is same as url', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://a.com' });
    expect(slugs.size).toBe(1);
  });

  it('returns empty set for entries without url', () => {
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(slugs.size).toBe(0);
  });
});

describe('getAffectedKeys', () => {
  it('returns page: prefixed keys', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(keys.size).toBe(1);
    expect(keys.has(`page:${slug}`)).toBe(true);
  });

  it('returns both child and parent page keys for referrer', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
    expect(keys.size).toBe(2);
    expect(keys.has(`page:${generateSlugFromUrl('https://child.com')}`)).toBe(true);
    expect(keys.has(`page:${generateSlugFromUrl('https://parent.com')}`)).toBe(true);
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
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToSettings(settings, entry);
    expect(result).toBe(settings); // same reference
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
// applyLogToPage — visit entries
// ---------------------------------------------------------------------------

describe('applyLogToPage — page (visit)', () => {
  it('updates url, title, timestamp from page entry', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: '', title: '', parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page A' };
    const result = applyLogToPage(page, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.title).toBe('Page A');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates parent URLs from referrer', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['old-slug-abc'] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toHaveLength(2);
    expect(result.parents[0]).toBe('old-slug-abc');
    expect(result.parents[1]).toBe('https://google.com'); // stored as URL initially
  });

  it('does not duplicate existing parent URL', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: ['https://google.com'] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toEqual(['https://google.com']);
  });

  it('does not duplicate when existing parent is a slug matching the referrer', () => {
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const googleSlug = generateSlugFromUrl('https://google.com');
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [googleSlug] };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toHaveLength(1);
  });

  it('does not duplicate when existing parent is page:slug key', () => {
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const googleSlug = generateSlugFromUrl('https://google.com');
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [`page:${googleSlug}`] };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toHaveLength(1);
  });

  it('does not duplicate when existing parent is {url,title} object', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [{ url: 'https://google.com', title: 'Google' }] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://google.com' };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toHaveLength(1);
  });

  it('caps parents at 50', () => {
    const parents = [];
    for (let i = 0; i < 50; i++) parents.push(`https://ref${i}.com`);
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://new-ref.com' };
    const result = applyLogToPage(page, entry);
    expect(result.parents).toHaveLength(50);
    expect(result.parents[0]).toBe('https://ref1.com'); // ref0 evicted
  });

  it('ignores page entry with mismatched slug', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 100, action: 'page', url: 'https://b.com', title: 'B' };
    const result = applyLogToPage(page, entry);
    expect(result).toBe(page);
  });

  it('applies page to entity without slug field (new entity)', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToPage(page, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent for page entries', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrer: 'https://ref.com' };
    const r1 = applyLogToPage(page, entry);
    const r2 = applyLogToPage(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — title change via attention report
// ---------------------------------------------------------------------------

describe('applyLogToPage — title update from attention report', () => {
  it('attention report with title updates page title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', parents: [], children: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Old Title' };
    page = applyLogToPage(page, visit);
    expect(page.title).toBe('Old Title');

    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', title: 'New Title', scrollDepth: 80, timeOnPage: 5000 };
    page = applyLogToPage(page, attention);
    expect(page.title).toBe('New Title');
  });

  it('attention report without title preserves existing title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', parents: [], children: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page Title' };
    page = applyLogToPage(page, visit);

    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 50, timeOnPage: 3000 };
    page = applyLogToPage(page, attention);
    expect(page.title).toBe('Page Title');
  });

  it('user_title is stored independently from title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', parents: [], children: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Auto Title' };
    page = applyLogToPage(page, visit);

    const userEdit = { timestamp: 200, action: 'page', url: 'https://a.com', user_title: 'My Custom Name' };
    page = applyLogToPage(page, userEdit);
    expect(page.title).toBe('Auto Title');
    expect(page.user_title).toBe('My Custom Name');
  });

  it('title update does not overwrite user_title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', user_title: 'Custom', parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'New Auto Title' };
    page = applyLogToPage(page, entry);
    expect(page.title).toBe('New Auto Title');
    expect(page.user_title).toBe('Custom');
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — parent-side children accumulation
// ---------------------------------------------------------------------------

describe('applyLogToPage — children from referrer', () => {
  it('accumulates child URL on parent page when page has referrer', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toBe('https://child.com');
    expect(result.timestamp).toBe(100);
  });

  it('does not duplicate existing child URL string', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: ['https://child.com'] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.children).toHaveLength(1);
  });

  it('does not duplicate existing child {url,title} object', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [{ url: 'https://child.com', title: 'Child' }] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.children).toHaveLength(1);
  });

  it('does not duplicate existing child page:slug key', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [`page:${childSlug}`] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.children).toHaveLength(1);
  });

  it('caps children at REFERRER_CAP (50)', () => {
    const children = [];
    for (let i = 0; i < 50; i++) children.push(`https://child${i}.com`);
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children };
    const entry = { timestamp: 200, action: 'page', url: 'https://new-child.com', title: 'New', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.children).toHaveLength(50);
    expect(result.children[0]).toBe('https://child1.com'); // child0 evicted
    expect(result.children[49]).toBe('https://new-child.com');
  });

  it('ignores page without referrer (no parent-side effect)', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child' };
    const result = applyLogToPage(parentPage, entry);
    expect(result).toBe(parentPage);
  });

  it('ignores page where referrer does not match parent slug', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://other.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result).toBe(parentPage);
  });

  it('is idempotent', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const r1 = applyLogToPage(parentPage, entry);
    const r2 = applyLogToPage(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('advances timestamp to max of existing and entry', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 500, children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const result = applyLogToPage(parentPage, entry);
    expect(result.timestamp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// applyLogToNote
// ---------------------------------------------------------------------------

describe('applyLogToNote', () => {
  it('creates note with excerpt, note text, cssPath, parents', () => {
    const noteEntity = { slug: '260223-hello-abc', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'note', slug: '260223-hello-abc', excerpt: 'hello world', note: 'my note', cssPath: 'body > p', parents: ['page:some-slug'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toBe('hello world');
    expect(result.note).toBe('my note');
    expect(result.cssPath).toBe('body > p');
    expect(result.parents).toEqual(['page:some-slug']);
    expect(result.timestamp).toBe(100);
  });

  it('updates note text without changing excerpt', () => {
    const noteEntity = { slug: 'n1', timestamp: 100, excerpt: 'text', note: 'old', cssPath: 'p', parents: ['page:p1'], children: [] };
    const entry = { timestamp: 200, action: 'note', slug: 'n1', note: 'updated' };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.note).toBe('updated');
    expect(result.excerpt).toBe('text'); // unchanged
    expect(result.timestamp).toBe(200);
  });

  it('supports array excerpts (cross-block highlights)', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: ['block1', 'block2'], parents: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toEqual(['block1', 'block2']);
  });

  it('supports null excerpt (page-level note)', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: null, note: 'Page level note', parents: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toBeNull();
    expect(result.note).toBe('Page level note');
  });

  it('ignores non-note entries', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToNote(noteEntity, entry);
    expect(result).toBe(noteEntity);
  });

  it('ignores mismatched slug', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n2', excerpt: 'text', parents: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result).toBe(noteEntity);
  });

  it('is idempotent', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', note: 'world', parents: ['page:p1'] };
    const r1 = applyLogToNote(noteEntity, entry);
    const r2 = applyLogToNote(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — capture (via page)
// ---------------------------------------------------------------------------

describe('applyLogToPage — capture (via page)', () => {
  it('sets mdPath and htmlPath', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { slug, timestamp: 0 };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', mdPath: 'pages/a/100.md', htmlPath: 'pages/a/100.html' };
    const result = applyLogToPage(page, entry);
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
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Rust', qbTrees: [], pins: [{ url: 'https://old.com', title: 'Old', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'uuid-1', op: 'add', urls: ['https://new.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(2);
    expect(result.pins[1].url).toBe('https://new.com');
    expect(result.pins[1].title).toBe('Untitled');
    expect(result.pins[1].pinnedAt).toBe(100);
    expect(result.timestamp).toBe(100);
    expect(result.name).toBe('Rust');
    expect(result.slug).toBe('uuid-1');
  });

  it('removes pins', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }, { url: 'https://b.com', title: 'B', pinnedAt: 60 }] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'del', urls: ['https://a.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].url).toBe('https://b.com');
  });

  it('clears pins', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'clear', urls: [] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toEqual([]);
    expect(result.timestamp).toBe(100);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: {} };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'c2', op: 'add', urls: ['https://a.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', urls: ['https://a.com'] };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2.pins).toHaveLength(1);
  });
});

describe('applyLogToPins — list_meta', () => {
  it('merges metadata fields and preserves pins', () => {
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Old Name', qbTrees: [], pins: [{ url: 'https://a.com', title: 'A', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'uuid-1', name: 'New Name' };
    const result = applyLogToPins(entity, entry);
    expect(result.name).toBe('New Name');
    expect(result.slug).toBe('uuid-1');
    expect(result.pins).toEqual(entity.pins);
    expect(result.timestamp).toBe(100);
  });

  it('sets qbTrees', () => {
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Test', qbTrees: [], pins: [] };
    const tree = { type: 'AND', children: [{ type: 'keyword', value: 'rust' }] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'uuid-1', name: 'Test', qbTrees: [tree] };
    const result = applyLogToPins(entity, entry);
    expect(result.qbTrees).toEqual([tree]);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, slug: 'c1', name: 'Test', qbTrees: [], pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'c2', name: 'Updated' };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Test', qbTrees: [], pins: [] };
    const entry = { timestamp: 100, action: 'list_meta', id: 'uuid-1', name: 'Updated' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

describe('applyLogToPins — del_list', () => {
  it('returns deleted entity', () => {
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Rust', pins: [{ url: 'https://a.com' }] };
    const entry = { timestamp: 100, action: 'del_list', id: 'uuid-1' };
    const result = applyLogToPins(entity, entry);
    expect(result.deleted).toBe(true);
    expect(result.timestamp).toBe(100);
  });

  it('is idempotent', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'del_list', id: 'c1' };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToDeletes
// ---------------------------------------------------------------------------

describe('applyLogToDeletes', () => {
  it('adds keys', () => {
    const entity = { timestamp: 0, keys: ['page:old-slug'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:new-slug'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.keys).toEqual(['page:old-slug', 'page:new-slug']);
    expect(result.timestamp).toBe(100);
  });

  it('removes keys', () => {
    const entity = { timestamp: 0, keys: ['page:a', 'page:b'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'del', keys: ['page:a'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.keys).toEqual(['page:b']);
  });

  it('clears keys', () => {
    const entity = { timestamp: 0, keys: ['page:a'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'clear', keys: [] };
    const result = applyLogToDeletes(entity, entry);
    expect(result.keys).toEqual([]);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, keys: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToDeletes(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, keys: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] };
    const result = applyLogToDeletes(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, keys: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] };
    const r1 = applyLogToDeletes(entity, entry);
    const r2 = applyLogToDeletes(r1, entry);
    expect(r2.keys).toEqual(['page:a']);
  });
});

// ---------------------------------------------------------------------------
// applyLogToRecycleBin
// ---------------------------------------------------------------------------

describe('applyLogToRecycleBin', () => {
  it('adds items with key field', () => {
    const entity = { timestamp: 0, items: [{ key: 'page:old', title: 'Old', deletedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:new'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toHaveLength(2);
    expect(result.items[1].key).toBe('page:new');
    expect(result.items[1].title).toBe('Untitled');
    expect(result.items[1].deletedAt).toBe(100);
    expect(result.timestamp).toBe(100);
  });

  it('adds note keys to recycle bin', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['note:n1'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe('note:n1');
  });

  it('removes items by key', () => {
    const entity = { timestamp: 0, items: [{ key: 'page:a', title: 'A', deletedAt: 50 }, { key: 'page:b', title: 'B', deletedAt: 60 }] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'del', keys: ['page:a'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].key).toBe('page:b');
  });

  it('clears items', () => {
    const entity = { timestamp: 0, items: [{ key: 'page:a', title: 'A', deletedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'clear', keys: [] };
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
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] };
    const result = applyLogToRecycleBin(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, items: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] };
    const r1 = applyLogToRecycleBin(entity, entry);
    const r2 = applyLogToRecycleBin(r1, entry);
    expect(r2.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — visitDates accumulation
// ---------------------------------------------------------------------------

describe('applyLogToPage — visitDates', () => {
  function toYMD(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  it('accumulates visitDates from page entries', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const result = applyLogToPage(page, { timestamp: ts1, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([toYMD(ts1)]);
  });

  it('does not duplicate same-day visits', () => {
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 15, 18, 0, 0).getTime();
    const ymd = toYMD(ts1);
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [], visitDates: [ymd] };
    const result = applyLogToPage(page, { timestamp: ts2, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([ymd]);
  });

  it('accumulates multiple distinct days', () => {
    let page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 16, 10, 0, 0).getTime();
    page = applyLogToPage(page, { timestamp: ts1, action: 'page', url: 'https://a.com', title: 'A' });
    page = applyLogToPage(page, { timestamp: ts2, action: 'page', url: 'https://a.com', title: 'A' });
    expect(page.visitDates).toEqual([toYMD(ts1), toYMD(ts2)]);
  });

  it('does not add visitDates for non-page entries', () => {
    const page = { slug: 'a', timestamp: 0 };
    const result = applyLogToPage(page, { timestamp: 100, action: 'note', slug: 'a', excerpt: 'x' });
    expect(result.visitDates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — likes accumulation
// ---------------------------------------------------------------------------

describe('applyLogToPage — likes', () => {
  it('accumulates likes in attention JSON', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { slug, timestamp: 0, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 };
    const result = applyLogToPage(page, entry);
    const att = JSON.parse(result.attention);
    expect(att.likes).toBe(1);
  });

  it('accumulates multiple likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parents: [], children: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 300, action: 'page', url: 'https://a.com', likes: 1 });
    const att = JSON.parse(page.attention);
    expect(att.likes).toBe(3);
  });

  it('preserves other attention fields when adding likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parents: [], children: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', scrollDepth: 80, timeOnPage: 5000 });
    page = applyLogToPage(page, { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 });
    const att = JSON.parse(page.attention);
    expect(att.scrollDepth).toBe(80);
    expect(att.timeOnPage).toBe(5000);
    expect(att.likes).toBe(1);
  });

  it('idempotent: same timestamp replay does not double-count likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 };
    page = applyLogToPage(page, entry);
    page = applyLogToPage(page, entry); // replay same timestamp
    const att = JSON.parse(page.attention);
    expect(att.likes).toBe(1);
  });

  it('ignores likes entry with mismatched slug', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { slug, timestamp: 0, parents: [], children: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://b.com', likes: 1 };
    const result = applyLogToPage(page, entry);
    expect(result).toBe(page);
  });

  it('applyTo integration: likes entry updates page attention', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 };
    const page = { slug, timestamp: 100, parents: [], children: [] };
    const result = applyTo(entry, { [`page:${slug}`]: page });
    const att = JSON.parse(result[`page:${slug}`].attention);
    expect(att.likes).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — page_checkpoint
// ---------------------------------------------------------------------------

describe('applyLogToPage — page_checkpoint', () => {
  it('creates a minimal page from page_checkpoint', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: 'Referrer Page' };
    const result = applyLogToPage(page, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Referrer Page');
    expect(result.timestamp).toBe(500);
  });

  it('does not overwrite existing url/title', () => {
    const page = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 100, url: 'https://ref.com', title: 'Original Title' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: 'New Title' };
    const result = applyLogToPage(page, entry);
    expect(result.url).toBe('https://ref.com');
    expect(result.title).toBe('Original Title');
    expect(result.timestamp).toBe(500);
  });

  it('advances timestamp to max', () => {
    const page = { slug: generateSlugFromUrl('https://ref.com'), timestamp: 600, url: 'https://ref.com', title: 'X' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://ref.com', title: '' };
    const result = applyLogToPage(page, entry);
    expect(result.timestamp).toBe(600);
  });

  it('ignores mismatched slug', () => {
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: 'https://a.com', title: 'A' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://b.com', title: 'B' };
    const result = applyLogToPage(page, entry);
    expect(result).toBe(page);
  });

  it('is idempotent', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://x.com', title: 'X' };
    const r1 = applyLogToPage(page, entry);
    const r2 = applyLogToPage(r1, entry);
    expect(r2).toEqual(r1);
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
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'x' };
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
// Sequence replay
// ---------------------------------------------------------------------------

describe('sequence replay', () => {
  it('replaying page + note creation produces correct state', () => {
    let page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parents: [], children: [] };

    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
    expect(page.url).toBe('https://a.com');
    expect(page.timestamp).toBe(100);
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
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0 };

    // Settings entry should not affect page
    const r1 = applyLogToPage(page, { timestamp: 100, action: 'set', key: 'workspace', value: {} });
    expect(r1).toBe(page);

    // List entry should not affect page
    const r2 = applyLogToPage(page, { timestamp: 200, action: 'list', id: 'c1', op: 'clear', urls: [] });
    expect(r2).toBe(page);

    // Deletes list entry should not affect page
    const r3 = applyLogToPage(page, { timestamp: 300, action: 'list', id: 'system/permanent-deletes', op: 'clear', keys: [] });
    expect(r3).toBe(page);
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

  it('returns list key for list entries (bare id)', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'c1', op: 'add', urls: ['https://a.com'] });
    expect(Object.keys(scope)).toEqual(['list:c1']);
  });

  it('returns list key for list_meta entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list_meta', id: 'c1', name: 'Test' });
    expect(Object.keys(scope)).toEqual(['list:c1']);
  });

  it('returns list key for del_list entries', () => {
    const scope = scopeOf({ timestamp: 100, action: 'del_list', id: 'c1' });
    expect(Object.keys(scope)).toEqual(['list:c1']);
  });

  it('returns page key for page entry without referrer', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope)).toEqual([`page:${slug}`]);
  });

  it('returns page + parent-index keys for page with referrer', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' });
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const keys = Object.keys(scope).sort();
    expect(keys).toEqual([`list:index/parent`, `page:${childSlug}`, `page:${parentSlug}`].sort());
  });

  it('returns page + parent-index keys for page_checkpoint entry', () => {
    const scope = scopeOf({ timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' });
    const slug = generateSlugFromUrl('https://a.com');
    expect(Object.keys(scope).sort()).toEqual([`list:index/parent`, `page:${slug}`].sort());
  });

  it('returns note + parent keys for note entry', () => {
    const scope = scopeOf({ timestamp: 100, action: 'note', slug: 'n1', excerpt: 'text', parents: ['page:p1'] });
    const keys = Object.keys(scope).sort();
    expect(keys).toEqual(['note:n1', 'page:p1'].sort());
  });

  it('returns recycle-bin key', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] });
    expect(Object.keys(scope)).toEqual(['list:system/recycle-bin']);
  });

  it('returns permanent-deletes key', () => {
    const scope = scopeOf({ timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] });
    expect(Object.keys(scope)).toEqual(['list:system/permanent-deletes']);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity
// ---------------------------------------------------------------------------

describe('defaultEntity', () => {
  it('returns page default with slug', () => {
    const e = defaultEntity('page:my-slug');
    expect(e).toEqual({ slug: 'my-slug', timestamp: 0, parents: [], children: [] });
  });

  it('returns note default with slug', () => {
    const e = defaultEntity('note:my-note');
    expect(e).toEqual({ slug: 'my-note', timestamp: 0, excerpt: null, note: null, cssPath: null, parents: [], children: [] });
  });

  it('returns settings default', () => {
    expect(defaultEntity('settings')).toEqual({ timestamp: 0 });
  });

  it('returns list default with id', () => {
    const e = defaultEntity('list:uuid-1');
    expect(e).toEqual({ timestamp: 0, slug: 'uuid-1', name: '', qbTrees: [], pins: [] });
  });

  it('returns recycle-bin default', () => {
    expect(defaultEntity('list:system/recycle-bin')).toEqual({ timestamp: 0, items: [] });
  });

  it('returns permanent-deletes default', () => {
    expect(defaultEntity('list:system/permanent-deletes')).toEqual({ timestamp: 0, keys: [] });
  });

  it('returns parent-index default', () => {
    expect(defaultEntity('list:index/parent')).toEqual({ timestamp: 0, index: {} });
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

  it('applies page to page entity', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const scope = { [`page:${slug}`]: { slug, timestamp: 0, parents: [], children: [] } };
    const result = applyTo(entry, scope);
    expect(result[`page:${slug}`].url).toBe('https://a.com');
    expect(result[`page:${slug}`].timestamp).toBe(100);
  });

  it('only page_checkpoint can create page from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyTo(page, { [`page:${slug}`]: null });
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('page_checkpoint creates page from null', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = applyTo(entry, { [`page:${slug}`]: null });
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].url).toBe('https://a.com');
  });

  it('note action creates note from null', () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parents: ['page:p1'] };
    const scope = { 'note:n1': null, 'page:p1': { slug: 'p1', timestamp: 50, parents: [], children: [] } };
    const result = applyTo(entry, scope);
    expect(result['note:n1']).not.toBeNull();
    expect(result['note:n1'].excerpt).toBe('hello');
    // Cross-entity: note key added to parent's children
    expect(result['page:p1'].children).toContain('note:n1');
  });

  it('note action leaves parent page null when parent has no checkpoint', () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parents: ['page:p1'] };
    const scope = { 'note:n1': null, 'page:p1': null };
    const result = applyTo(entry, scope);
    expect(result['note:n1']).not.toBeNull();
    // Parent stays null — orchestration must create page_checkpoint before note
    expect(result['page:p1']).toBeNull();
  });

  it('applies page with referrer to both child and parent pages', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parents: [], children: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, timestamp: 50, parents: [], children: [] },
      'list:index/parent': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    // Child gets visit data + parent ref (resolved to page:slug since parent exists in scope)
    expect(result[`page:${childSlug}`].url).toBe('https://child.com');
    expect(result[`page:${childSlug}`].parents).toContain(`page:${parentSlug}`);
    // Parent gets child ref (resolved to page:slug since child exists in scope)
    expect(result[`page:${parentSlug}`].children).toContain(`page:${childSlug}`);
    // Parent-index pruned (child page exists in scope)
    expect(result['list:index/parent'].index['https://child.com']).toBeUndefined();
  });

  it('skips parent page update when parent is null (no checkpoint)', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' };
    const scope = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parents: [], children: [] },
      [`page:${parentSlug}`]: null,
      'list:index/parent': { timestamp: 0, index: {} },
    };
    const result = applyTo(entry, scope);
    expect(result[`page:${parentSlug}`]).toBeNull();
    expect(result[`page:${childSlug}`].parents).toContain('https://parent.com');
  });

  it('applies list entry to list entity', () => {
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:c1': { timestamp: 0, slug: 'c1', name: 'Test', qbTrees: [], pins: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:c1'].pins).toHaveLength(1);
    expect(result['list:c1'].pins[0].url).toBe('https://a.com');
  });

  it('creates list entity from null on first list entry', () => {
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', urls: ['https://a.com'] };
    const scope = { 'list:c1': null };
    const result = applyTo(entry, scope);
    expect(result['list:c1'].pins).toHaveLength(1);
    expect(result['list:c1'].slug).toBe('c1');
  });

  it('applies list entry to recycle-bin', () => {
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] };
    const scope = { 'list:system/recycle-bin': { timestamp: 0, items: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:system/recycle-bin'].items).toHaveLength(1);
  });

  it('applies list entry to permanent-deletes', () => {
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] };
    const scope = { 'list:system/permanent-deletes': { timestamp: 0, keys: [] } };
    const result = applyTo(entry, scope);
    expect(result['list:system/permanent-deletes'].keys).toEqual(['page:a']);
  });

  it('applies page attention entry to page', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 0.5, timeOnPage: 3000 };
    const page = { slug, timestamp: 100, parents: [], children: [] };
    const result = applyTo(entry, { [`page:${slug}`]: page });
    const att = JSON.parse(result[`page:${slug}`].attention);
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
    const store = { [`page:${slug}`]: { slug, timestamp: 0, parents: [], children: [] } };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`page:${slug}`].url).toBe('https://a.com');
    expect(result[`page:${slug}`].timestamp).toBe(100);
  });

  it('returns null for uncached page on page (no create)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('creates page from null on page_checkpoint', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].url).toBe('https://a.com');
  });

  it('creates note from null on note action', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parents: ['page:p1'] };
    const store = { 'page:p1': { slug: 'p1', timestamp: 50, parents: [], children: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['note:n1']).not.toBeNull();
    expect(result['note:n1'].excerpt).toBe('hello');
    expect(result['page:p1'].children).toContain('note:n1');
  });

  it('page_checkpoint before note wires note into parent children (drain simulation)', async () => {
    // Simulates the correct drain sequence: page_checkpoint creates the page,
    // then note entry adds to its children. This is the pattern background.js
    // must follow — ensureCheckpointIfMissing before createNote.
    const cache = new Map();
    const load = async (key) => cache.get(key) ?? null;

    // 1. page_checkpoint creates the page from null
    const r1 = await effectOf(
      { timestamp: 50, action: 'page_checkpoint', url: 'https://example.com/article', title: 'Article' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    const slug = generateSlugFromUrl('https://example.com/article');
    expect(cache.get(`page:${slug}`)).not.toBeNull();

    // 2. note entry references that page as parent
    const r2 = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parents: [`page:${slug}`] },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    // Note created and wired into page children
    expect(cache.get('note:n1')).not.toBeNull();
    expect(cache.get(`page:${slug}`).children).toContain('note:n1');
  });

  it('updates mutable round cache across sequential calls', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const cache = new Map();

    const load = async (key) => cache.get(key) ?? null;

    const r1 = await effectOf(
      { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    const r2 = await effectOf(
      { timestamp: 200, action: 'page', url: 'https://a.com', title: 'Updated A' },
      load
    );
    expect(r2[`page:${slug}`].title).toBe('Updated A');
    expect(r2[`page:${slug}`].timestamp).toBe(200);
  });

  it('handles page with referrer updating both pages via closure', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parents: [], children: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, timestamp: 50, parents: [], children: [] },
      'list:index/parent': { timestamp: 0, index: {} },
    };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrer: 'https://parent.com' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`page:${childSlug}`].parents).toContain(`page:${parentSlug}`);
    expect(result[`page:${parentSlug}`].children).toContain(`page:${childSlug}`);
    expect(result['list:index/parent'].index['https://child.com']).toBeUndefined();
  });

  it('applies settings entry via closure', async () => {
    const store = { settings: { timestamp: 0, workspace: { mode: 'default' } } };
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
  });

  it('page then page_checkpoint preserves parent info for child', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const cache = new Map();

    cache.set(`page:${parentSlug}`, { slug: parentSlug, timestamp: 50, parents: [], children: [] });

    const load = async (key) => cache.get(key) ?? null;

    // Entry 1: page child with referrer=parent — child page is null, stays null
    const r1 = await effectOf(
      { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrer: 'https://parent.com' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    expect(cache.get(`page:${childSlug}`)).toBeNull();
    expect(cache.get('list:index/parent').index['https://child.com']).toEqual([parentSlug]);
    expect(cache.get(`page:${parentSlug}`).children).toContain('https://child.com');

    // Entry 2: page_checkpoint for child — creates page, absorbs parent-index
    const r2 = await effectOf(
      { timestamp: 101, action: 'page_checkpoint', url: 'https://child.com', title: 'Child' },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    const childPage = cache.get(`page:${childSlug}`);
    expect(childPage).not.toBeNull();
    // Absorption converts bare slugs from parent-index to page:slug keys
    expect(childPage.parents).toEqual([`page:${parentSlug}`]);

    // Parent-index entry absorbed into page — should be removed
    const parentIndex = cache.get('list:index/parent');
    expect(parentIndex.index['https://child.com']).toBeUndefined();
  });

  it('note deletion via recycle bin', async () => {
    const entry = { timestamp: 200, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['note:n1'] };
    const store = { 'list:system/recycle-bin': { timestamp: 0, items: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['list:system/recycle-bin'].items).toHaveLength(1);
    expect(result['list:system/recycle-bin'].items[0].key).toBe('note:n1');
  });
});
