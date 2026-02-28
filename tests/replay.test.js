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
  effectOf,
  defaultEntity,
  applyLogToSettings,
  applyLogToPage,
  applyLogToNote,
  applyLogToPins,
  applyLogToDeletes,
  applyLogToRecycleBin,
  applyLogToShallowPage,
  applyLogToGateways,
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

  it('returns both child and parent slugs for page with referrerId', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrerId: `page:${parentSlug}` });
    expect(slugs.size).toBe(2);
    expect(slugs.has(generateSlugFromUrl('https://child.com'))).toBe(true);
    expect(slugs.has(parentSlug)).toBe(true);
  });

  it('returns single slug when referrerId points to same page', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const slugs = getAffectedSlugs({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrerId: `page:${slug}` });
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

  it('returns both child and parent page keys for referrerId', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const keys = getAffectedKeys({ timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrerId: `page:${parentSlug}` });
    expect(keys.size).toBe(2);
    expect(keys.has(`page:${generateSlugFromUrl('https://child.com')}`)).toBe(true);
    expect(keys.has(`page:${parentSlug}`)).toBe(true);
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
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, url: '', title: '', parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page A' };
    const result = applyLogToPage(page, entry);
    expect(result.url).toBe('https://a.com');
    expect(result.title).toBe('Page A');
    expect(result.timestamp).toBe(100);
  });

  it('accumulates parentIds from referrerId', () => {
    const googleSlug = generateSlugFromUrl('https://google.com');
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: ['page:old-slug-abc'] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrerId: `page:${googleSlug}` };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toHaveLength(2);
    expect(result.parentIds[0]).toBe('page:old-slug-abc');
    expect(result.parentIds[1]).toBe(`page:${googleSlug}`);
  });

  it('does not duplicate existing parentId', () => {
    const googleSlug = generateSlugFromUrl('https://google.com');
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [`page:${googleSlug}`] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrerId: `page:${googleSlug}` };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toEqual([`page:${googleSlug}`]);
  });

  it('caps parentIds at 50', () => {
    const parentIds = [];
    for (let i = 0; i < 50; i++) parentIds.push(`page:ref${i}`);
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds };
    const newRefSlug = generateSlugFromUrl('https://new-ref.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrerId: `page:${newRefSlug}` };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toHaveLength(50);
    expect(result.parentIds[0]).toBe('page:ref1'); // ref0 evicted
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
    const refSlug = generateSlugFromUrl('https://ref.com');
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A', referrerId: `page:${refSlug}` };
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
    let page = { slug, timestamp: 0, url: '', title: '', parentIds: [], childIds: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Old Title' };
    page = applyLogToPage(page, visit);
    expect(page.title).toBe('Old Title');

    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', title: 'New Title', scrollDepth: 80, timeOnPage: 5000 };
    page = applyLogToPage(page, attention);
    expect(page.title).toBe('New Title');
  });

  it('attention report without title preserves existing title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', parentIds: [], childIds: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Page Title' };
    page = applyLogToPage(page, visit);

    const attention = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 50, timeOnPage: 3000 };
    page = applyLogToPage(page, attention);
    expect(page.title).toBe('Page Title');
  });

  it('user_title is stored independently from title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', parentIds: [], childIds: [] };
    const visit = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'Auto Title' };
    page = applyLogToPage(page, visit);

    const userEdit = { timestamp: 200, action: 'page', url: 'https://a.com', user_title: 'My Custom Name' };
    page = applyLogToPage(page, userEdit);
    expect(page.title).toBe('Auto Title');
    expect(page.user_title).toBe('My Custom Name');
  });

  it('title update does not overwrite user_title', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, url: '', title: '', user_title: 'Custom', parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'New Auto Title' };
    page = applyLogToPage(page, entry);
    expect(page.title).toBe('New Auto Title');
    expect(page.user_title).toBe('Custom');
  });
});

// ---------------------------------------------------------------------------
// applyLogToPage — parent-side children accumulation
// ---------------------------------------------------------------------------

describe('applyLogToPage — childIds from referrerId', () => {
  it('accumulates shallow child on parent page when page has referrerId', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const parentPage = { slug: parentSlug, timestamp: 0, childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result.childIds).toHaveLength(1);
    expect(result.childIds[0]).toBe('shallow:https://child.com');
    expect(result.timestamp).toBe(100);
  });

  it('does not duplicate existing shallow child', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const parentPage = { slug: parentSlug, timestamp: 0, childIds: ['shallow:https://child.com'] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result.childIds).toHaveLength(1);
  });

  it('does not duplicate existing page:slug child', () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const parentPage = { slug: parentSlug, timestamp: 0, childIds: [`page:${childSlug}`] };
    const entry = { timestamp: 200, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result.childIds).toHaveLength(1);
  });

  it('caps childIds at REFERRER_CAP (50)', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const childIds = [];
    for (let i = 0; i < 50; i++) childIds.push(`shallow:https://child${i}.com`);
    const parentPage = { slug: parentSlug, timestamp: 0, childIds };
    const entry = { timestamp: 200, action: 'page', url: 'https://new-child.com', title: 'New', referrerId: `page:${parentSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result.childIds).toHaveLength(50);
    expect(result.childIds[0]).toBe('shallow:https://child1.com'); // child0 evicted
    expect(result.childIds[49]).toBe('shallow:https://new-child.com');
  });

  it('ignores page without referrerId (no parent-side effect)', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child' };
    const result = applyLogToPage(parentPage, entry);
    expect(result).toBe(parentPage);
  });

  it('ignores page where referrerId does not match parent slug', () => {
    const parentPage = { slug: generateSlugFromUrl('https://parent.com'), timestamp: 0, childIds: [] };
    const otherSlug = generateSlugFromUrl('https://other.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${otherSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result).toBe(parentPage);
  });

  it('is idempotent', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const parentPage = { slug: parentSlug, timestamp: 0, childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const r1 = applyLogToPage(parentPage, entry);
    const r2 = applyLogToPage(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('advances timestamp to max of existing and entry', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const parentPage = { slug: parentSlug, timestamp: 500, childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const result = applyLogToPage(parentPage, entry);
    expect(result.timestamp).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// applyLogToNote
// ---------------------------------------------------------------------------

describe('applyLogToNote', () => {
  it('creates note with excerpt, note text, cssPath, parentIds', () => {
    const noteEntity = { slug: '260223-hello-abc', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'note', slug: '260223-hello-abc', excerpt: 'hello world', note: 'my note', cssPath: 'body > p', parentIds: ['page:some-slug'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toBe('hello world');
    expect(result.note).toBe('my note');
    expect(result.cssPath).toBe('body > p');
    expect(result.parentIds).toEqual(['page:some-slug']);
    expect(result.timestamp).toBe(100);
  });

  it('updates note text without changing excerpt', () => {
    const noteEntity = { slug: 'n1', timestamp: 100, excerpt: 'text', note: 'old', cssPath: 'p', parentIds: ['page:p1'], childIds: [] };
    const entry = { timestamp: 200, action: 'note', slug: 'n1', note: 'updated' };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.note).toBe('updated');
    expect(result.excerpt).toBe('text'); // unchanged
    expect(result.timestamp).toBe(200);
  });

  it('supports array excerpts (cross-block highlights)', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: ['block1', 'block2'], parentIds: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toEqual(['block1', 'block2']);
  });

  it('supports null excerpt (page-level note)', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: null, note: 'Page level note', parentIds: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result.excerpt).toBeNull();
    expect(result.note).toBe('Page level note');
  });

  it('ignores non-note entries', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToNote(noteEntity, entry);
    expect(result).toBe(noteEntity);
  });

  it('ignores mismatched slug', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n2', excerpt: 'text', parentIds: ['page:p1'] };
    const result = applyLogToNote(noteEntity, entry);
    expect(result).toBe(noteEntity);
  });

  it('is idempotent', () => {
    const noteEntity = { slug: 'n1', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', note: 'world', parentIds: ['page:p1'] };
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
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Rust', qbTrees: [], pins: [{ id: 'page:old-slug', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'uuid-1', op: 'add', ids: ['shallow:https://new.com'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(2);
    expect(result.pins[1].id).toBe('shallow:https://new.com');
    expect(result.pins[1].pinnedAt).toBe(100);
    expect(result.timestamp).toBe(100);
    expect(result.name).toBe('Rust');
    expect(result.slug).toBe('uuid-1');
  });

  it('removes pins by id', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [{ id: 'page:a-slug', pinnedAt: 50 }, { id: 'shallow:https://b.com', pinnedAt: 60 }] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'del', ids: ['page:a-slug'] };
    const result = applyLogToPins(entity, entry);
    expect(result.pins).toHaveLength(1);
    expect(result.pins[0].id).toBe('shallow:https://b.com');
  });

  it('clears pins', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [{ id: 'page:a-slug', pinnedAt: 50 }] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'clear', ids: [] };
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
    const entry = { timestamp: 100, action: 'list', id: 'c2', op: 'add', ids: ['page:a-slug'] };
    const result = applyLogToPins(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, slug: 'c1', pins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', ids: ['page:a-slug'] };
    const r1 = applyLogToPins(entity, entry);
    const r2 = applyLogToPins(r1, entry);
    expect(r2.pins).toHaveLength(1);
  });
});

describe('applyLogToPins — list_meta', () => {
  it('merges metadata fields and preserves pins', () => {
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Old Name', qbTrees: [], pins: [{ id: 'page:a-slug', pinnedAt: 50 }] };
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
    const entity = { timestamp: 0, slug: 'uuid-1', name: 'Rust', pins: [{ id: 'page:a-slug' }] };
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
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [] };
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const result = applyLogToPage(page, { timestamp: ts1, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([toYMD(ts1)]);
  });

  it('does not duplicate same-day visits', () => {
    const ts1 = new Date(2024, 0, 15, 10, 0, 0).getTime();
    const ts2 = new Date(2024, 0, 15, 18, 0, 0).getTime();
    const ymd = toYMD(ts1);
    const page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [], visitDates: [ymd] };
    const result = applyLogToPage(page, { timestamp: ts2, action: 'page', url: 'https://a.com', title: 'A' });
    expect(result.visitDates).toEqual([ymd]);
  });

  it('accumulates multiple distinct days', () => {
    let page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [] };
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
  it('accumulates likes as flat field', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 };
    const result = applyLogToPage(page, entry);
    expect(result.likes).toBe(1);
  });

  it('accumulates multiple likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 300, action: 'page', url: 'https://a.com', likes: 1 });
    expect(page.likes).toBe(3);
  });

  it('preserves other attention fields when adding likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', scrollDepth: 80, timeOnPage: 5000 });
    page = applyLogToPage(page, { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 });
    expect(page.scrollDepth).toBe(80);
    expect(page.timeOnPage).toBe(5000);
    expect(page.likes).toBe(1);
  });

  it('idempotent: same timestamp replay does not double-count likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 };
    page = applyLogToPage(page, entry);
    page = applyLogToPage(page, entry); // replay same timestamp
    expect(page.likes).toBe(1);
  });

  it('ignores likes entry with mismatched slug', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://b.com', likes: 1 };
    const result = applyLogToPage(page, entry);
    expect(result).toBe(page);
  });

  it('likes entry updates page attention via effectOf', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 };
    const page = { slug, timestamp: 100, parentIds: [], childIds: [] };
    const result = await effectOf(entry, async (key) =>
      key === `page:${slug}` ? page : null
    );
    expect(result[`page:${slug}`].likes).toBe(1);
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
// applyLogToShallowPage
// ---------------------------------------------------------------------------

describe('applyLogToShallowPage', () => {
  it('records parent from page entry with referrerId', () => {
    const idx = { timestamp: 0, index: {} };
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', referrerId: `page:${parentSlug}`, title: 'Child' };
    const result = applyLogToShallowPage(idx, entry);
    expect(Object.keys(result.index)).toHaveLength(1);
    expect(result.index['https://child.com'].parents).toEqual([`page:${parentSlug}`]);
    expect(result.index['https://child.com'].title).toBe('Child');
    expect(result.timestamp).toBe(100);
  });

  it('records title from page entry', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'My Title' };
    const result = applyLogToShallowPage(idx, entry);
    expect(result.index['https://child.com'].title).toBe('My Title');
  });

  it('records user_title from page entry', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', user_title: 'Custom' };
    const result = applyLogToShallowPage(idx, entry);
    expect(result.index['https://child.com'].user_title).toBe('Custom');
  });

  it('accumulates multiple parents for the same URL', () => {
    let idx = { timestamp: 0, index: {} };
    const p1Slug = generateSlugFromUrl('https://parent1.com');
    const p2Slug = generateSlugFromUrl('https://parent2.com');
    idx = applyLogToShallowPage(idx, { timestamp: 100, action: 'page', url: 'https://child.com', referrerId: `page:${p1Slug}`, title: 'C' });
    idx = applyLogToShallowPage(idx, { timestamp: 200, action: 'page', url: 'https://child.com', referrerId: `page:${p2Slug}`, title: 'C' });
    expect(idx.index['https://child.com'].parents).toHaveLength(2);
    expect(idx.timestamp).toBe(200);
  });

  it('records list membership from list entry with shallow: ids', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['shallow:https://child.com'] };
    const result = applyLogToShallowPage(idx, entry);
    expect(result.index['https://child.com'].lists).toEqual(['list:my-list']);
  });

  it('removes list membership on list del', () => {
    const idx = { timestamp: 0, index: { 'https://child.com': { parents: [], lists: ['list:my-list'], title: null, user_title: null } } };
    const entry = { timestamp: 100, action: 'list', id: 'my-list', op: 'del', ids: ['shallow:https://child.com'] };
    const result = applyLogToShallowPage(idx, entry);
    expect(result.index['https://child.com'].lists).toEqual([]);
  });

  it('is idempotent', () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', referrerId: `page:${parentSlug}`, title: 'C' };
    let idx = { timestamp: 0, index: {} };
    idx = applyLogToShallowPage(idx, entry);
    const r2 = applyLogToShallowPage(idx, entry);
    expect(r2.index['https://child.com'].parents).toEqual(idx.index['https://child.com'].parents);
  });

  it('ignores entries with non-page/list action', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'x' };
    const result = applyLogToShallowPage(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores page entries without referrerId or title', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', scrollDepth: 50 };
    const result = applyLogToShallowPage(idx, entry);
    expect(result).toBe(idx);
  });

  it('ignores entries without url', () => {
    const idx = { timestamp: 0, index: {} };
    const parentSlug = generateSlugFromUrl('https://ref.com');
    const entry = { timestamp: 100, action: 'page', referrerId: `page:${parentSlug}` };
    const result = applyLogToShallowPage(idx, entry);
    expect(result).toBe(idx);
  });
});

// ---------------------------------------------------------------------------
// Sequence replay
// ---------------------------------------------------------------------------

describe('sequence replay', () => {
  it('replaying page + note creation produces correct state', () => {
    let page = { slug: generateSlugFromUrl('https://a.com'), timestamp: 0, parentIds: [], childIds: [] };

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
    const r2 = applyLogToPage(page, { timestamp: 200, action: 'list', id: 'c1', op: 'clear', ids: [] });
    expect(r2).toBe(page);

    // Deletes list entry should not affect page
    const r3 = applyLogToPage(page, { timestamp: 300, action: 'list', id: 'system/permanent-deletes', op: 'clear', keys: [] });
    expect(r3).toBe(page);
  });
});

// ---------------------------------------------------------------------------
// effectOf scope (verifies which entity keys are affected by each entry type)
// ---------------------------------------------------------------------------

describe('effectOf scope', () => {
  const nullLoad = async () => null;

  it('affects settings key for set entries', async () => {
    const result = await effectOf({ timestamp: 100, action: 'set', key: 'workspace', value: {} }, nullLoad);
    expect(Object.keys(result)).toEqual(['settings']);
  });

  it('affects list key for list entries (bare id)', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list', id: 'c1', op: 'add', ids: ['page:a-slug'] }, nullLoad);
    expect(Object.keys(result)).toEqual(['list:c1']);
  });

  it('affects list + shallow_page keys for list entries with shallow ids', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list', id: 'c1', op: 'add', ids: ['shallow:https://a.com'] }, nullLoad);
    expect(Object.keys(result).sort()).toEqual(['list:c1', 'list:system/shallow-page'].sort());
  });

  it('list_meta with name change also updates settings.listOrder', async () => {
    const settings = { listOrder: [{ id: 'list:c1', name: 'Old Name' }, { id: 'list:c2', name: 'Other' }] };
    const listEntity = { timestamp: 0, slug: 'c1', name: 'Old Name', qbTrees: [], pins: [] };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:c1') return listEntity;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'c1', name: 'New Name' }, load);
    expect(Object.keys(result).sort()).toEqual(['list:c1', 'settings']);
    expect(result['list:c1'].name).toBe('New Name');
    expect(result['settings'].listOrder[0]).toEqual({ id: 'list:c1', name: 'New Name' });
    expect(result['settings'].listOrder[1]).toEqual({ id: 'list:c2', name: 'Other' });
  });

  it('list_meta without name change does not touch settings', async () => {
    const settings = { listOrder: [{ id: 'list:c1', name: 'Same' }] };
    const listEntity = { timestamp: 0, slug: 'c1', name: 'Same', qbTrees: [], pins: [] };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:c1') return listEntity;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'c1', name: 'Same', qbTrees: [{ type: 'AND' }] }, load);
    expect(Object.keys(result)).toEqual(['list:c1']);
  });

  it('del_list removes entry from settings.listOrder', async () => {
    const settings = { listOrder: [{ id: 'list:c1', name: 'A' }, { id: 'list:c2', name: 'B' }] };
    const listEntity = { timestamp: 0, slug: 'c1', name: 'A', qbTrees: [], pins: [] };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:c1') return listEntity;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, load);
    expect(Object.keys(result).sort()).toEqual(['list:c1', 'settings']);
    expect(result['settings'].listOrder).toEqual([{ id: 'list:c2', name: 'B' }]);
  });

  it('affects list key for list_meta entries without settings', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'c1', name: 'Test' }, nullLoad);
    expect(Object.keys(result)).toEqual(['list:c1']);
  });

  it('affects list key for del_list entries without settings', async () => {
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, nullLoad);
    expect(Object.keys(result)).toEqual(['list:c1']);
  });

  it('affects page + shallow_page keys for page entry with title', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf({ timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' }, nullLoad);
    expect(Object.keys(result)).toEqual([`page:${slug}`, 'list:system/shallow-page']);
  });

  it('affects page key only for page entry without title or referrerId', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf({ timestamp: 100, action: 'page', url: 'https://a.com', scrollDepth: 50 }, nullLoad);
    expect(Object.keys(result)).toEqual([`page:${slug}`]);
  });

  it('affects page + parent + shallow_page keys for page with referrerId', async () => {
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const childSlug = generateSlugFromUrl('https://child.com');
    const result = await effectOf(
      { timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrerId: `page:${parentSlug}` },
      nullLoad,
    );
    expect(Object.keys(result).sort()).toEqual([`list:system/shallow-page`, `page:${childSlug}`, `page:${parentSlug}`].sort());
  });

  it('affects page + shallow_page keys for page_checkpoint entry', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf({ timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' }, nullLoad);
    expect(Object.keys(result).sort()).toEqual([`list:system/shallow-page`, `page:${slug}`].sort());
  });

  it('affects note + parent keys for note entry', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'text', parentIds: ['page:p1'] },
      nullLoad,
    );
    expect(Object.keys(result).sort()).toEqual(['note:n1', 'page:p1'].sort());
  });

  it('affects recycle-bin key', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] }, nullLoad);
    expect(Object.keys(result)).toEqual(['list:system/recycle-bin']);
  });

  it('affects permanent-deletes key', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] }, nullLoad);
    expect(Object.keys(result)).toEqual(['list:system/permanent-deletes']);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity
// ---------------------------------------------------------------------------

describe('defaultEntity', () => {
  it('returns page default with slug', () => {
    const e = defaultEntity('page:my-slug');
    expect(e).toEqual({ slug: 'my-slug', timestamp: 0, parentIds: [], childIds: [] });
  });

  it('returns note default with slug', () => {
    const e = defaultEntity('note:my-note');
    expect(e).toEqual({ slug: 'my-note', timestamp: 0, excerpt: null, note: null, cssPath: null, parentIds: [], childIds: [] });
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

  it('returns shallow_page default', () => {
    expect(defaultEntity('list:system/shallow-page')).toEqual({ timestamp: 0, index: {} });
  });

  it('returns null for unknown key', () => {
    expect(defaultEntity('unknown:foo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effectOf apply (verifies entity mutations for each entry type)
// ---------------------------------------------------------------------------

describe('effectOf apply', () => {
  it('applies set entry to settings', async () => {
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = await effectOf(entry, async (key) =>
      key === 'settings' ? { timestamp: 0 } : null
    );
    expect(result.settings.workspace).toEqual({ mode: 'private' });
    expect(result.settings.timestamp).toBe(100);
  });

  it('creates settings from null on first set', async () => {
    const entry = { timestamp: 100, action: 'set', key: 'workspace', value: { mode: 'private' } };
    const result = await effectOf(entry, async () => null);
    expect(result.settings.workspace).toEqual({ mode: 'private' });
    expect(result.settings.timestamp).toBe(100);
  });

  it('applies page to page entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async (key) =>
      key === `page:${slug}` ? { slug, timestamp: 0, parentIds: [], childIds: [] } : null
    );
    expect(result[`page:${slug}`].url).toBe('https://a.com');
    expect(result[`page:${slug}`].timestamp).toBe(100);
  });

  it('only page_checkpoint can create page from null', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('page_checkpoint creates page from null', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async () => null);
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].url).toBe('https://a.com');
  });

  it('note action creates note from null', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parentIds: ['page:p1'] };
    const store = { 'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['note:n1']).not.toBeNull();
    expect(result['note:n1'].excerpt).toBe('hello');
    expect(result['page:p1'].childIds).toContain('note:n1');
  });

  it('note action leaves parent page null when parent has no checkpoint', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parentIds: ['page:p1'] };
    const result = await effectOf(entry, async () => null);
    expect(result['note:n1']).not.toBeNull();
    expect(result['page:p1']).toBeNull();
  });

  it('applies page with referrerId to both child and parent pages', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, timestamp: 50, parentIds: [], childIds: [] },
      'list:system/shallow-page': { timestamp: 0, index: {} },
    };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`page:${childSlug}`].url).toBe('https://child.com');
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
    expect(result[`page:${parentSlug}`].childIds).toContain(`page:${childSlug}`);
    expect(result['list:system/shallow-page'].index['https://child.com']).toBeUndefined();
  });

  it('skips parent page update when parent is null (no checkpoint)', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` };
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parentIds: [], childIds: [] },
      'list:system/shallow-page': { timestamp: 0, index: {} },
    };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`page:${parentSlug}`]).toBeNull();
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
  });

  it('applies list entry to list entity', async () => {
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', ids: ['page:a-slug'] };
    const result = await effectOf(entry, async (key) =>
      key === 'list:c1' ? { timestamp: 0, slug: 'c1', name: 'Test', qbTrees: [], pins: [] } : null
    );
    expect(result['list:c1'].pins).toHaveLength(1);
    expect(result['list:c1'].pins[0].id).toBe('page:a-slug');
  });

  it('creates list entity from null on first list entry', async () => {
    const entry = { timestamp: 100, action: 'list', id: 'c1', op: 'add', ids: ['shallow:https://a.com'] };
    const result = await effectOf(entry, async () => null);
    expect(result['list:c1'].pins).toHaveLength(1);
    expect(result['list:c1'].slug).toBe('c1');
  });

  it('applies list entry to recycle-bin', async () => {
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] };
    const result = await effectOf(entry, async (key) =>
      key === 'list:system/recycle-bin' ? { timestamp: 0, items: [] } : null
    );
    expect(result['list:system/recycle-bin'].items).toHaveLength(1);
  });

  it('applies list entry to permanent-deletes', async () => {
    const entry = { timestamp: 100, action: 'list', id: 'system/permanent-deletes', op: 'add', keys: ['page:a'] };
    const result = await effectOf(entry, async (key) =>
      key === 'list:system/permanent-deletes' ? { timestamp: 0, keys: [] } : null
    );
    expect(result['list:system/permanent-deletes'].keys).toEqual(['page:a']);
  });

  it('applies page attention entry to page', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const entry = { timestamp: 200, action: 'page', url: 'https://a.com', scrollDepth: 0.5, timeOnPage: 3000 };
    const page = { slug, timestamp: 100, parentIds: [], childIds: [] };
    const result = await effectOf(entry, async (key) =>
      key === `page:${slug}` ? page : null
    );
    expect(result[`page:${slug}`].scrollDepth).toBe(0.5);
    expect(result[`page:${slug}`].timeOnPage).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// effectOf
// ---------------------------------------------------------------------------

describe('effectOf', () => {
  it('loads entities via closure and applies entry', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = { [`page:${slug}`]: { slug, timestamp: 0, parentIds: [], childIds: [] } };
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
    const entry = { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parentIds: ['page:p1'] };
    const store = { 'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['note:n1']).not.toBeNull();
    expect(result['note:n1'].excerpt).toBe('hello');
    expect(result['page:p1'].childIds).toContain('note:n1');
  });

  it('page_checkpoint before note wires note into parent childIds (drain simulation)', async () => {
    // Simulates the correct drain sequence: page_checkpoint creates the page,
    // then note entry adds to its childIds. This is the pattern background.js
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
      { timestamp: 100, action: 'note', slug: 'n1', excerpt: 'hello', parentIds: [`page:${slug}`] },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    // Note created and wired into page childIds
    expect(cache.get('note:n1')).not.toBeNull();
    expect(cache.get(`page:${slug}`).childIds).toContain('note:n1');
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

  it('handles page with referrerId updating both pages via closure', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, timestamp: 50, parentIds: [], childIds: [] },
      'list:system/shallow-page': { timestamp: 0, index: {} },
    };
    const entry = { timestamp: 100, action: 'page', url: 'https://child.com', title: 'C', referrerId: `page:${parentSlug}` };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
    expect(result[`page:${parentSlug}`].childIds).toContain(`page:${childSlug}`);
    expect(result['list:system/shallow-page'].index['https://child.com']).toBeUndefined();
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

    cache.set(`page:${parentSlug}`, { slug: parentSlug, timestamp: 50, parentIds: [], childIds: [] });

    const load = async (key) => cache.get(key) ?? null;

    // Entry 1: page child with referrerId=parent — child page is null, stays null
    const r1 = await effectOf(
      { timestamp: 100, action: 'page', url: 'https://child.com', title: 'Child', referrerId: `page:${parentSlug}` },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    expect(cache.get(`page:${childSlug}`)).toBeNull();
    expect(cache.get('list:system/shallow-page').index['https://child.com'].parents).toEqual([`page:${parentSlug}`]);
    expect(cache.get(`page:${parentSlug}`).childIds).toContain('shallow:https://child.com');

    // Entry 2: page_checkpoint for child — creates page, absorbs shallow_page index
    const r2 = await effectOf(
      { timestamp: 101, action: 'page_checkpoint', url: 'https://child.com', title: 'Child' },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    const childPage = cache.get(`page:${childSlug}`);
    expect(childPage).not.toBeNull();
    // Absorption converts from shallow_page index to page:slug keys
    expect(childPage.parentIds).toEqual([`page:${parentSlug}`]);

    // Shallow page index entry absorbed into page — should be removed
    const shallowPageIndex = cache.get('list:system/shallow-page');
    expect(shallowPageIndex.index['https://child.com']).toBeUndefined();
  });

  it('note deletion via recycle bin', async () => {
    const entry = { timestamp: 200, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['note:n1'] };
    const store = { 'list:system/recycle-bin': { timestamp: 0, items: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['list:system/recycle-bin'].items).toHaveLength(1);
    expect(result['list:system/recycle-bin'].items[0].key).toBe('note:n1');
  });

  it('creates list from null on list_meta then adds pins (drain simulation)', async () => {
    // Simulates the offscreen drain for createListAndPin:
    // list_meta creates the list, then list add appends a pin.
    // The load closure returns null for non-existent lists — both sessionLoad
    // and offscreen load must behave identically here.
    const cache = new Map();
    const load = async (key) => cache.get(key) ?? null;

    // 1. list_meta creates the list from null
    const r1 = await effectOf(
      { timestamp: 50, action: 'list_meta', id: 'my-list', name: 'My List' },
      load
    );
    for (const [k, v] of Object.entries(r1)) cache.set(k, v);

    const listEntity = cache.get('list:my-list');
    expect(listEntity).not.toBeNull();
    expect(listEntity.slug).toBe('my-list');
    expect(listEntity.name).toBe('My List');

    // 2. list add appends a pin
    const r2 = await effectOf(
      { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['page:some-slug'] },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    const updated = cache.get('list:my-list');
    expect(updated.pins).toHaveLength(1);
    expect(updated.pins[0].id).toBe('page:some-slug');
    expect(updated.name).toBe('My List');
  });

});

// ---------------------------------------------------------------------------
// Entity storage correctness: title resolution via replay
// ---------------------------------------------------------------------------

describe('entity storage title resolution', () => {
  const url = 'https://example.com/page';
  const slug = generateSlugFromUrl(url);

  it('applyLogToPage uses last-write-wins for title', () => {
    // Simulate a checkpointed page with initial generic title
    const page = { slug, url, title: 'Generic Site Title', timestamp: 100 };

    // Later visit entry with updated title
    const entry = { timestamp: 200, action: 'page', url, title: 'Specific Page Title - Generic Site Title' };
    const updated = applyLogToPage(page, entry);

    expect(updated.title).toBe('Specific Page Title - Generic Site Title');
    expect(updated.timestamp).toBe(200);
  });

  it('sequential page entries update title to latest value', () => {
    let page = { slug, url, title: 'Title A', timestamp: 100 };

    page = applyLogToPage(page, { timestamp: 200, action: 'page', url, title: 'Title B' });
    expect(page.title).toBe('Title B');

    page = applyLogToPage(page, { timestamp: 300, action: 'page', url, title: 'Title C' });
    expect(page.title).toBe('Title C');
  });

  it('replaying logBuffer entries over a checkpoint produces correct title', () => {
    // Checkpoint has old title
    const checkpoint = { slug, url, title: 'Old Title', timestamp: 100 };

    // Buffer has newer entries
    const logBuffer = [
      { timestamp: 200, action: 'page', url, title: 'Intermediate Title' },
      { timestamp: 300, action: 'page', url, title: 'Final Title' },
    ];

    // Simulate replayBufferOver (same logic as the helper we'll add to background.js)
    let current = checkpoint;
    for (const entry of logBuffer) {
      current = applyLogToPage(current, entry);
    }

    expect(current.title).toBe('Final Title');
    expect(current.timestamp).toBe(300);
  });

  it('buffer entries for other URLs do not affect the page', () => {
    const checkpoint = { slug, url, title: 'My Title', timestamp: 100 };

    const logBuffer = [
      { timestamp: 200, action: 'page', url: 'https://other.com', title: 'Other Title' },
      { timestamp: 300, action: 'set', key: 'workspace', value: {} },
    ];

    let current = checkpoint;
    for (const entry of logBuffer) {
      current = applyLogToPage(current, entry);
    }

    expect(current.title).toBe('My Title');
    expect(current.timestamp).toBe(100);
  });

  it('user_title is preserved through replay', () => {
    const checkpoint = { slug, url, title: 'Auto Title', timestamp: 100 };

    const logBuffer = [
      { timestamp: 200, action: 'page', url, title: 'Auto Title', user_title: 'My Custom Title' },
    ];

    let current = checkpoint;
    for (const entry of logBuffer) {
      current = applyLogToPage(current, entry);
    }

    expect(current.user_title).toBe('My Custom Title');
    expect(current.title).toBe('Auto Title');
  });
});

// ---------------------------------------------------------------------------
// page_checkpoint absorption: upgrade list pins from shallow: to page:
// ---------------------------------------------------------------------------

describe('page_checkpoint absorption upgrades list pins', () => {
  const testUrl = 'https://example.com/article';
  const testSlug = generateSlugFromUrl(testUrl);

  it('effectOf upgrades shallow: pin to page: in affected lists on page_checkpoint', async () => {
    // Setup: a list has a shallow pin, SPI has the entry with list membership
    const listEntity = {
      timestamp: 50, slug: 'my-list', name: 'My List', qbTrees: [],
      pins: [{ id: `shallow:${testUrl}`, pinnedAt: 50 }],
    };
    const spiEntity = {
      timestamp: 50, index: {
        [testUrl]: { title: 'Test Article', parents: [], lists: ['list:my-list'] },
      },
    };

    const cache = new Map();
    cache.set('list:my-list', listEntity);
    cache.set('list:system/shallow-page', spiEntity);
    // No existing page entity
    const load = async (key) => cache.get(key) ?? null;

    // page_checkpoint absorbs the shallow page
    const result = await effectOf(
      { timestamp: 100, action: 'page_checkpoint', url: testUrl, title: 'Test Article' },
      load,
    );

    // Apply results to cache
    for (const [k, v] of Object.entries(result)) cache.set(k, v);

    // Page entity should be created
    const page = cache.get(`page:${testSlug}`);
    expect(page).not.toBeNull();
    expect(page.title).toBe('Test Article');

    // SPI entry should be removed (absorbed)
    const spi = cache.get('list:system/shallow-page');
    expect(spi.index[testUrl]).toBeUndefined();

    // List pin should be upgraded from shallow: to page:
    const list = cache.get('list:my-list');
    expect(list.pins).toHaveLength(1);
    expect(list.pins[0].id).toBe(`page:${testSlug}`);
    expect(list.pins[0].pinnedAt).toBe(50); // pinnedAt preserved
  });
});

// ---------------------------------------------------------------------------
// applyLogToGateways
// ---------------------------------------------------------------------------

describe('applyLogToGateways', () => {
  it('adds origins', () => {
    const entity = { timestamp: 0, origins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'add', origins: ['https://example.com'] };
    const result = applyLogToGateways(entity, entry);
    expect(result.origins).toEqual(['https://example.com']);
    expect(result.timestamp).toBe(100);
  });

  it('adds multiple origins', () => {
    const entity = { timestamp: 0, origins: ['https://a.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'add', origins: ['https://b.com', 'https://c.com'] };
    const result = applyLogToGateways(entity, entry);
    expect(result.origins).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('removes origins', () => {
    const entity = { timestamp: 0, origins: ['https://a.com', 'https://b.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'del', origins: ['https://a.com'] };
    const result = applyLogToGateways(entity, entry);
    expect(result.origins).toEqual(['https://b.com']);
  });

  it('clears origins', () => {
    const entity = { timestamp: 0, origins: ['https://a.com'] };
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'clear' };
    const result = applyLogToGateways(entity, entry);
    expect(result.origins).toEqual([]);
  });

  it('ignores irrelevant entries', () => {
    const entity = { timestamp: 0, origins: [] };
    const entry = { timestamp: 100, action: 'page', url: 'https://a.com', title: 'A' };
    const result = applyLogToGateways(entity, entry);
    expect(result).toBe(entity);
  });

  it('ignores wrong id', () => {
    const entity = { timestamp: 0, origins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/recycle-bin', op: 'add', keys: ['page:a'] };
    const result = applyLogToGateways(entity, entry);
    expect(result).toBe(entity);
  });

  it('is idempotent for add', () => {
    const entity = { timestamp: 0, origins: [] };
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'add', origins: ['https://a.com'] };
    const r1 = applyLogToGateways(entity, entry);
    const r2 = applyLogToGateways(r1, entry);
    expect(r2.origins).toEqual(['https://a.com']);
  });

  it('default entity has empty origins', () => {
    const entity = defaultEntity('list:system/gateways');
    expect(entity).toEqual({ timestamp: 0, origins: [] });
  });
});

// ---------------------------------------------------------------------------
// effectOf — gateways dispatch
// ---------------------------------------------------------------------------

describe('effectOf — gateways', () => {
  it('dispatches list entry for system/gateways to applyLogToGateways', async () => {
    const entry = { timestamp: 100, action: 'list', id: 'system/gateways', op: 'add', origins: ['https://example.com'] };
    const result = await effectOf(entry, async () => null);
    const gw = result['list:system/gateways'];
    expect(gw.origins).toEqual(['https://example.com']);
    expect(gw.timestamp).toBe(100);
  });
});
