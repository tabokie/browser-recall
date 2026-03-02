/**
 * Replay module unit tests.
 *
 * Verifies that pure replay functions correctly apply log entries to entity
 * state, and that they are idempotent (safe to replay the same entry twice).
 */
import { describe, it, expect } from 'vitest';
import {
  getAffectedKeys,
  effectOf,
  defaultEntity,
  applyLogToSettings,
  applyLogToPage,
  applyLogToPins,
  applyLogToShallowPage,
  applyLogToGateways,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// ---------------------------------------------------------------------------
// getAffectedKeys
// ---------------------------------------------------------------------------

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
    const result = applyLogToPage(page, { timestamp: 100, action: 'note', slug: 'a' });
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

  it('dislike decrements likes', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 200, action: 'page', url: 'https://a.com', likes: 1 });
    page = applyLogToPage(page, { timestamp: 300, action: 'page', url: 'https://a.com', likes: -1 });
    expect(page.likes).toBe(1);
  });

  it('likes can go negative', () => {
    const slug = generateSlugFromUrl('https://a.com');
    let page = { slug, timestamp: 0, parentIds: [], childIds: [] };
    page = applyLogToPage(page, { timestamp: 100, action: 'page', url: 'https://a.com', likes: -1 });
    expect(page.likes).toBe(-1);
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

  it('sets parentIds from checkpoint entry', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://child.com', title: 'Child', parentIds: ['page:parent-com'] };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toEqual(['page:parent-com']);
  });

  it('merges parentIds without duplicates', () => {
    const slug = generateSlugFromUrl('https://child.com');
    const page = { slug, timestamp: 100, url: 'https://child.com', title: 'Child', parentIds: ['page:parent-a'] };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://child.com', parentIds: ['page:parent-a', 'page:parent-b'] };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toEqual(['page:parent-a', 'page:parent-b']);
  });

  it('does not set parentIds when entry has none', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://x.com', title: 'X' };
    const result = applyLogToPage(page, entry);
    expect(result.parentIds).toBeUndefined();
  });

  it('sets user_title from checkpoint entry', () => {
    const page = { timestamp: 0 };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://x.com', title: 'X', user_title: 'My Custom Title' };
    const result = applyLogToPage(page, entry);
    expect(result.user_title).toBe('My Custom Title');
  });

  it('does not overwrite existing user_title', () => {
    const slug = generateSlugFromUrl('https://x.com');
    const page = { slug, timestamp: 100, url: 'https://x.com', title: 'X', user_title: 'Original' };
    const entry = { timestamp: 500, action: 'page_checkpoint', url: 'https://x.com', user_title: 'New' };
    const result = applyLogToPage(page, entry);
    expect(result.user_title).toBe('Original');
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
    expect(result.index['https://child.com'].parentIds).toEqual([`page:${parentSlug}`]);
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

  it('accumulates multiple parentIds for the same URL', () => {
    let idx = { timestamp: 0, index: {} };
    const p1Slug = generateSlugFromUrl('https://parent1.com');
    const p2Slug = generateSlugFromUrl('https://parent2.com');
    idx = applyLogToShallowPage(idx, { timestamp: 100, action: 'page', url: 'https://child.com', referrerId: `page:${p1Slug}`, title: 'C' });
    idx = applyLogToShallowPage(idx, { timestamp: 200, action: 'page', url: 'https://child.com', referrerId: `page:${p2Slug}`, title: 'C' });
    expect(idx.index['https://child.com'].parentIds).toHaveLength(2);
    expect(idx.timestamp).toBe(200);
  });

  it('records list membership from list entry with shallow: ids', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['shallow:https://child.com'] };
    const result = applyLogToShallowPage(idx, entry);
    expect(result.index['https://child.com'].lists).toEqual(['list:my-list']);
  });

  it('removes list membership on list del', () => {
    const idx = { timestamp: 0, index: { 'https://child.com': { parentIds: [], lists: ['list:my-list'], title: null, user_title: null } } };
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
    expect(r2.index['https://child.com'].parentIds).toEqual(idx.index['https://child.com'].parentIds);
  });

  it('ignores entries with non-page/list action', () => {
    const idx = { timestamp: 0, index: {} };
    const entry = { timestamp: 100, action: 'note', slug: 'n1' };
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

    // System list entry should not affect page
    const r3 = applyLogToPage(page, { timestamp: 300, action: 'list', id: 'system/gateways', op: 'add', origins: ['https://a.com'] });
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

  it('list_meta for new list adds entry to settings.listOrder', async () => {
    const settings = { listOrder: [{ id: 'list:existing', name: 'Existing' }] };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:brand-new') return null; // new list, not yet on disk
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'brand-new', name: 'Brand New' }, load);
    expect(result['settings']).toBeTruthy();
    expect(result['settings'].listOrder).toEqual([
      { id: 'list:existing', name: 'Existing' },
      { id: 'list:brand-new', name: 'Brand New' },
    ]);
  });

  it('list_meta for new list with empty listOrder creates it', async () => {
    const settings = { trimRules: [] }; // no listOrder key at all
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:first') return null;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'first', name: 'First List' }, load);
    expect(result['settings']).toBeTruthy();
    expect(result['settings'].listOrder).toEqual([
      { id: 'list:first', name: 'First List' },
    ]);
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
    expect(result['settings'].listOrder).toEqual([{ id: 'list:c2', name: 'B' }]);
  });

  it('del_list adds list key to system/orphaned', async () => {
    const settings = { listOrder: [{ id: 'list:c1', name: 'A' }] };
    const listEntity = { timestamp: 0, slug: 'c1', name: 'A', qbTrees: [], pins: [] };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:c1') return listEntity;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, load);
    expect(result['list:system/orphaned']).toBeTruthy();
    expect(result['list:system/orphaned'].keys).toContain('list:c1');
  });

  it('del_list removes list from shallow page SPI lists', async () => {
    const settings = { listOrder: [{ id: 'list:c1', name: 'A' }] };
    const listEntity = {
      timestamp: 0, slug: 'c1', name: 'A', qbTrees: [],
      pins: [{ id: 'shallow:https://a.com', pinnedAt: 50 }],
    };
    const spi = {
      timestamp: 50,
      index: {
        'https://a.com': { parentIds: [], lists: ['list:c1', 'list:other'], title: 'A', user_title: null },
      },
    };
    const load = async (key) => {
      if (key === 'settings') return settings;
      if (key === 'list:c1') return listEntity;
      if (key === 'list:system/shallow-page') return spi;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, load);
    expect(result['list:system/shallow-page']).toBeTruthy();
    const entry = result['list:system/shallow-page'].index['https://a.com'];
    expect(entry.lists).not.toContain('list:c1');
    expect(entry.lists).toContain('list:other');
  });

  it('affects list key and settings for list_meta entries without settings', async () => {
    const result = await effectOf({ timestamp: 100, action: 'list_meta', id: 'c1', name: 'Test' }, nullLoad);
    expect(Object.keys(result).sort()).toEqual(['list:c1', 'settings']);
    // New list should be added to listOrder even when settings was null
    expect(result['settings'].listOrder).toEqual([{ id: 'list:c1', name: 'Test' }]);
  });

  it('affects list key + orphaned for del_list entries without settings', async () => {
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, nullLoad);
    expect(Object.keys(result).sort()).toEqual(['list:c1', 'list:system/orphaned']);
  });

  // --- list→page parentIds wiring ---

  it('list op:add adds list:<id> to pinned page parentIds', async () => {
    const pageEntity = { slug: 'a-slug', timestamp: 0, parentIds: ['page:ref'], childIds: [] };
    const load = async (key) => {
      if (key === 'page:a-slug') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['page:a-slug'] },
      load,
    );
    expect(result['page:a-slug']).toBeTruthy();
    expect(result['page:a-slug'].parentIds).toContain('list:my-list');
    // Existing parentIds preserved
    expect(result['page:a-slug'].parentIds).toContain('page:ref');
  });

  it('list op:add does not duplicate list ref in parentIds', async () => {
    const pageEntity = { slug: 'a-slug', timestamp: 0, parentIds: ['list:my-list'], childIds: [] };
    const load = async (key) => {
      if (key === 'page:a-slug') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['page:a-slug'] },
      load,
    );
    expect(result['page:a-slug'].parentIds.filter(p => p === 'list:my-list')).toHaveLength(1);
  });

  it('list op:add skips shallow pins (no page entity update)', async () => {
    const load = async () => null;
    const result = await effectOf(
      { timestamp: 100, action: 'list', id: 'my-list', op: 'add', ids: ['shallow:https://a.com'] },
      load,
    );
    // Should have list + SPI keys, but no page: keys
    expect(Object.keys(result).some(k => k.startsWith('page:'))).toBe(false);
  });

  it('list op:del removes list:<id> from unpinned page parentIds', async () => {
    const pageEntity = { slug: 'a-slug', timestamp: 0, parentIds: ['page:ref', 'list:my-list'], childIds: [] };
    const load = async (key) => {
      if (key === 'page:a-slug') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'list', id: 'my-list', op: 'del', ids: ['page:a-slug'] },
      load,
    );
    expect(result['page:a-slug']).toBeTruthy();
    expect(result['page:a-slug'].parentIds).not.toContain('list:my-list');
    expect(result['page:a-slug'].parentIds).toContain('page:ref');
  });

  it('del_list removes list:<id> from all pinned page parentIds', async () => {
    const pageA = { slug: 'a-slug', timestamp: 0, parentIds: ['list:c1', 'page:ref'], childIds: [] };
    const pageB = { slug: 'b-slug', timestamp: 0, parentIds: ['list:c1'], childIds: [] };
    const listEntity = {
      timestamp: 0, slug: 'c1', name: 'A', qbTrees: [], pins: [
        { id: 'page:a-slug', pinnedAt: 50 },
        { id: 'page:b-slug', pinnedAt: 60 },
      ]
    };
    const settings = { listOrder: [{ id: 'list:c1', name: 'A' }] };
    const load = async (key) => {
      if (key === 'list:c1') return listEntity;
      if (key === 'page:a-slug') return pageA;
      if (key === 'page:b-slug') return pageB;
      if (key === 'settings') return settings;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, load);
    expect(result['page:a-slug'].parentIds).not.toContain('list:c1');
    expect(result['page:a-slug'].parentIds).toContain('page:ref');
    expect(result['page:b-slug'].parentIds).not.toContain('list:c1');
    expect(result['page:b-slug'].parentIds).toEqual([]);
  });

  it('del_list skips shallow pins in parentIds cleanup', async () => {
    const listEntity = {
      timestamp: 0, slug: 'c1', name: 'A', qbTrees: [],
      pins: [{ id: 'shallow:https://a.com', pinnedAt: 50 }]
    };
    const settings = { listOrder: [{ id: 'list:c1', name: 'A' }] };
    const load = async (key) => {
      if (key === 'list:c1') return listEntity;
      if (key === 'settings') return settings;
      return null;
    };
    const result = await effectOf({ timestamp: 100, action: 'del_list', id: 'c1' }, load);
    // Should not have any page: keys
    expect(Object.keys(result).some(k => k.startsWith('page:'))).toBe(false);
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

  it('note wires childIds on parent page without updating note entity', async () => {
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: [] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    // Should only update parent page, not note entity
    expect(Object.keys(result)).toEqual(['page:p1']);
    expect(result['page:p1'].childIds).toContain('note:n1');
  });

  it('note does not duplicate existing childId', async () => {
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: ['note:n1'] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    expect(result['page:p1'].childIds.filter(c => c === 'note:n1')).toHaveLength(1);
  });

  it('note skips missing parent pages', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:missing'] },
      nullLoad,
    );
    expect(result['page:missing']).toBeNull();
  });

  // --- del_note: remove note from parent page childIds ---

  it('del_note removes note from parent page childIds', async () => {
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: ['note:n1', 'note:n2'] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'del_note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    expect(result['page:p1'].childIds).toEqual(['note:n2']);
    expect(result['page:p1'].childIds).not.toContain('note:n1');
  });

  it('del_note is safe when note not in childIds', async () => {
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: ['note:other'] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'del_note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    expect(result['page:p1'].childIds).toEqual(['note:other']);
  });

  it('del_note skips missing parent pages', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'del_note', slug: 'n1', parentIds: ['page:missing'] },
      nullLoad,
    );
    expect(result['page:missing']).toBeNull();
  });

  it('del_note adds note key to system/orphaned list', async () => {
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: ['note:n1'] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'del_note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    expect(result['list:system/orphaned']).toBeTruthy();
    expect(result['list:system/orphaned'].keys).toContain('note:n1');
    expect(result['list:system/orphaned'].timestamp).toBe(100);
  });

  it('del_note does not duplicate key in orphaned list', async () => {
    const orphaned = { timestamp: 50, keys: ['note:n1'] };
    const pageEntity = { slug: 'p1', timestamp: 0, parentIds: [], childIds: ['note:n1'] };
    const load = async (key) => {
      if (key === 'page:p1') return pageEntity;
      if (key === 'list:system/orphaned') return orphaned;
      return null;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'del_note', slug: 'n1', parentIds: ['page:p1'] },
      load,
    );
    expect(result['list:system/orphaned'].keys.filter(k => k === 'note:n1')).toHaveLength(1);
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

  it('note wires childIds on parent page', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:p1'] };
    const store = { 'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    // note does NOT create/update note entity — only wires parent childIds
    expect(result['note:n1']).toBeUndefined();
    expect(result['page:p1'].childIds).toContain('note:n1');
  });

  it('note leaves parent page null when parent has no checkpoint', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:p1'] };
    const result = await effectOf(entry, async () => null);
    expect(result['note:n1']).toBeUndefined();
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

  it('skips parent childIds accumulation when parent is a gateway root', async () => {
    const childSlug = generateSlugFromUrl('https://github.com/user/repo');
    const parentSlug = generateSlugFromUrl('https://github.com/');
    const entry = { timestamp: 100, action: 'page', url: 'https://github.com/user/repo', title: 'Repo', referrerId: `page:${parentSlug}` };
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, url: 'https://github.com/user/repo', timestamp: 0, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, url: 'https://github.com/', timestamp: 50, parentIds: [], childIds: [] },
      'list:system/shallow-page': { timestamp: 0, index: {} },
      'list:system/gateways': { timestamp: 0, origins: ['https://github.com'] },
    };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    // Child still gets parentIds
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
    // But parent should NOT get childIds (it's a gateway root)
    expect(result[`page:${parentSlug}`]).toBeUndefined();
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

  it('note wires childIds on parent page (effectOf idempotent)', async () => {
    const entry = { timestamp: 100, action: 'note', slug: 'n1', parentIds: ['page:p1'] };
    const store = { 'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: [] } };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    expect(result['page:p1'].childIds).toContain('note:n1');
  });

  it('page_checkpoint before note wires note into parent childIds (drain simulation)', async () => {
    // Simulates the correct drain sequence: page_checkpoint creates the page,
    // then note adds note to its childIds.
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

    // 2. note references that page as parent
    const r2 = await effectOf(
      { timestamp: 100, action: 'note', slug: 'n1', parentIds: [`page:${slug}`] },
      load
    );
    for (const [k, v] of Object.entries(r2)) cache.set(k, v);

    // Note entity NOT in cache (written directly to filesystem), but page childIds wired
    expect(cache.get('note:n1')).toBeUndefined();
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
    expect(cache.get('list:system/shallow-page').index['https://child.com'].parentIds).toEqual([`page:${parentSlug}`]);
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
// SPI invariant: SPI entries are for non-checkpointed pages only
// ---------------------------------------------------------------------------

describe('SPI and checkpoint mutual exclusion', () => {
  it('page_checkpoint absorption removes SPI entry', async () => {
    // When a page gets checkpointed, its SPI entry is absorbed into the page
    // entity and deleted from SPI. So SPI entries never coexist with checkpoints.
    const slug = generateSlugFromUrl('https://a.com');
    const existingSpi = {
      timestamp: 50,
      index: { 'https://a.com': { parentIds: ['page:ref'], lists: ['list:x'], title: 'Title', user_title: null } },
    };
    const store = { 'list:system/shallow-page': existingSpi };
    const entry = { timestamp: 100, action: 'page_checkpoint', url: 'https://a.com', title: 'A' };
    const result = await effectOf(entry, async (key) => store[key] ?? null);
    const spi = result['list:system/shallow-page'];
    // SPI entry must be deleted after absorption
    expect(spi.index['https://a.com']).toBeUndefined();
    // Page entity must have absorbed the parentIds
    expect(result[`page:${slug}`].parentIds).toContain('page:ref');
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
        [testUrl]: { title: 'Test Article', parentIds: [], lists: ['list:my-list'] },
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
    const entry = { timestamp: 100, action: 'list', id: 'some-list', op: 'add', ids: ['page:a'] };
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
