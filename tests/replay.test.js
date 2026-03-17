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
  isPageEligible,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// Shared null load
const nullLoad = async () => null;

// Helper: build a load function from a store object
function makeLoad(store) {
  return async (key, opts) => {
    const entity = store[key] ?? null;
    if (!opts?.includeDeleted && entity?.deleted) return null;
    return entity;
  };
}

// Helper: base store with system entities for list tests
function listStore(extra = {}) {
  return {
    'manifest:name-to-id': { timestamp: 0, paths: { 'root/Test': 'test-id' } },
    'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [], parentList: 'list:system/root', childLists: [] },
    'list:system/root': { timestamp: 0, childLists: ['list:test-id'] },
    'manifest:orphaned': { timestamp: 0, keys: [] },
    'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', pins: [], parentList: null, childLists: [] },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// getAffectedKeys
// ---------------------------------------------------------------------------

describe('getAffectedKeys', () => {
  it('returns page key for visit_page', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'visit_page', url: 'https://a.com', title: 'A' });
    expect(keys.size).toBe(1);
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns child and parent keys for visit_page with referrerUrl', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'visit_page', url: 'https://child.com', title: 'C', referrerUrl: 'https://parent.com' });
    expect(keys.size).toBe(2);
    expect(keys.has(`page:${generateSlugFromUrl('https://child.com')}`)).toBe(true);
    expect(keys.has(`page:${generateSlugFromUrl('https://parent.com')}`)).toBe(true);
  });

  it('returns page key for create_note', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'create_note', url: 'https://a.com', path: 'notes/n1.json' });
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns page key for delete_snapshot', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const keys = getAffectedKeys({ timestamp: 100, action: 'delete_snapshot', url: 'https://a.com', path: `snapshots/${slug}-50` });
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns empty set for list events (no url)', () => {
    const keys = getAffectedKeys({ timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test', items: ['https://a.com'] });
    // pin_to_list has no entry.url at top level
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyLogToSettings
// ---------------------------------------------------------------------------

describe('applyLogToSettings', () => {
  it('merges key/value into settings', () => {
    const settings = { timestamp: 0, workspace: { mode: 'default' } };
    const entry = { timestamp: 100, action: 'update_setting', key: 'workspace', value: { mode: 'private' } };
    const result = applyLogToSettings(settings, entry);
    expect(result.workspace).toEqual({ mode: 'private' });
    expect(result.timestamp).toBe(100);
  });

  it('adds new key to settings', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 200, action: 'update_setting', key: 'urlBlacklist', value: ['chrome://'] };
    const result = applyLogToSettings(settings, entry);
    expect(result.urlBlacklist).toEqual(['chrome://']);
  });

  it('ignores non-update_setting entries', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'visit_page', url: 'https://a.com' };
    expect(applyLogToSettings(settings, entry)).toBe(settings);
  });

  it('is idempotent', () => {
    const settings = { timestamp: 0 };
    const entry = { timestamp: 100, action: 'update_setting', key: 'x', value: 42 };
    const r1 = applyLogToSettings(settings, entry);
    const r2 = applyLogToSettings(r1, entry);
    expect(r2).toEqual(r1);
  });

  it('preserves unrelated keys', () => {
    const settings = { timestamp: 0, a: 1, b: 2 };
    const entry = { timestamp: 100, action: 'update_setting', key: 'a', value: 10 };
    expect(applyLogToSettings(settings, entry).b).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity
// ---------------------------------------------------------------------------

describe('defaultEntity', () => {
  it('returns page default', () => {
    expect(defaultEntity('page:s1')).toEqual({ slug: 's1', timestamp: 0, parentIds: [], childIds: [] });
  });
  it('returns note default', () => {
    const e = defaultEntity('note:n1');
    expect(e.slug).toBe('n1');
    expect(e.excerpt).toBeNull();
  });
  it('returns settings default', () => {
    expect(defaultEntity('manifest:settings')).toEqual({ timestamp: 0 });
  });
  it('returns list default', () => {
    const e = defaultEntity('list:abc');
    expect(e.slug).toBe('abc');
    expect(e.pins).toEqual([]);
  });
  it('returns root default', () => {
    expect(defaultEntity('list:system/root')).toEqual({ timestamp: 0, childLists: [] });
  });
  it('returns name-map default', () => {
    expect(defaultEntity('manifest:name-to-id')).toEqual({ timestamp: 0, paths: {} });
  });
  it('returns orphaned default', () => {
    expect(defaultEntity('manifest:orphaned')).toEqual({ timestamp: 0, keys: [] });
  });
  it('returns null for unknown', () => {
    expect(defaultEntity('unknown:x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effectOf: update_setting
// ---------------------------------------------------------------------------

describe('effectOf: update_setting', () => {
  it('applies setting', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'update_setting', key: 'theme', value: 'dark' },
      makeLoad({ 'manifest:settings': { timestamp: 0 } }),
    );
    expect(result['manifest:settings'].theme).toBe('dark');
    expect(result['manifest:settings'].timestamp).toBe(100);
  });

  it('creates settings from null', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'update_setting', key: 'x', value: 1 },
      nullLoad,
    );
    expect(result['manifest:settings'].x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// effectOf: visit_page
// ---------------------------------------------------------------------------

describe('effectOf: visit_page', () => {
  it('enriches existing page entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: 'https://a.com', title: 'A' },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 0, parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].url).toBe('https://a.com');
    expect(result[`page:${slug}`].title).toBe('A');
    expect(result[`page:${slug}`].timestamp).toBe(100);
  });

  it('does NOT create entity from null (passive visit)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: 'https://a.com', title: 'A' },
      nullLoad,
    );
    expect(result[`page:${slug}`]).toBeUndefined();
  });

  it('adds visitDates', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: new Date('2026-03-11').getTime(), action: 'visit_page', url: 'https://a.com', title: 'A' },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 0, parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].visitDates).toContain(20260311);
  });

  it('adds referrerUrl to parentIds', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, timestamp: 0, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, url: 'https://parent.com', timestamp: 50, parentIds: [], childIds: [] },
      'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', pins: [], parentList: null, childLists: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: 'https://child.com', title: 'C', referrerUrl: 'https://parent.com' },
      makeLoad(store),
    );
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
    expect(result[`page:${parentSlug}`].childIds).toContain(`page:${childSlug}`);
  });

  it('skips parent childIds for gateway roots', async () => {
    const childSlug = generateSlugFromUrl('https://github.com/user/repo');
    const parentSlug = generateSlugFromUrl('https://github.com/');
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, url: 'https://github.com/user/repo', timestamp: 0, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: { slug: parentSlug, url: 'https://github.com/', timestamp: 50, parentIds: [], childIds: [] },
      'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', pins: [{ id: `page:${parentSlug}`, pinnedAt: 10 }], parentList: null, childLists: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: 'https://github.com/user/repo', title: 'Repo', referrerUrl: 'https://github.com/' },
      makeLoad(store),
    );
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${parentSlug}`);
    expect(result[`page:${parentSlug}`]).toBeUndefined(); // gateway: no child accumulation
  });
});

// ---------------------------------------------------------------------------
// effectOf: leave_page
// ---------------------------------------------------------------------------

describe('effectOf: leave_page', () => {
  it('updates attention data on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'leave_page', url: 'https://a.com', scrollDepth: 80, timeOnPage: 5000 },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].scrollDepth).toBe(80);
    expect(result[`page:${slug}`].timeOnPage).toBe(5000);
  });

  it('does NOT create entity from null', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'leave_page', url: 'https://a.com', scrollDepth: 80 },
      nullLoad,
    );
    expect(result[`page:${slug}`]).toBeUndefined();
  });

  it('idempotency: skips attention when timestamp <= prevTimestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'leave_page', url: 'https://a.com', scrollDepth: 50, timeOnPage: 1000 },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, scrollDepth: 30, timeOnPage: 2000, parentIds: [], childIds: [] } }),
    );
    // timestamp not > prevTimestamp, so attention not applied
    expect(result[`page:${slug}`].scrollDepth).toBe(30);
    expect(result[`page:${slug}`].timeOnPage).toBe(2000);
  });

  it('updates title from leave report', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'leave_page', url: 'https://a.com', title: 'New Title' },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, title: 'Old', parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].title).toBe('New Title');
  });
});

// ---------------------------------------------------------------------------
// effectOf: rename_page
// ---------------------------------------------------------------------------

describe('effectOf: rename_page', () => {
  it('sets user_title and creates entity if missing', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rename_page', url: 'https://a.com', user_title: 'Custom' },
      nullLoad,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].user_title).toBe('Custom');
  });

  it('updates user_title on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'rename_page', url: 'https://a.com', user_title: 'New Name' },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, user_title: 'Old', parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].user_title).toBe('New Name');
  });
});

// ---------------------------------------------------------------------------
// effectOf: rate_page
// ---------------------------------------------------------------------------

describe('effectOf: rate_page', () => {
  it('creates entity and applies likes', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1 },
      nullLoad,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].likes).toBe(1);
  });

  it('accumulates likes on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'rate_page', url: 'https://a.com', likes: -1 },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, likes: 3, parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].likes).toBe(2);
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1, title: 'Page A' },
      nullLoad,
    );
    expect(result[`page:${slug}`].title).toBe('Page A');
  });

  it('idempotency: skips likes when timestamp <= prevTimestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1 },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 100, likes: 3, parentIds: [], childIds: [] } }),
    );
    expect(result[`page:${slug}`].likes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// effectOf: create_snapshot
// ---------------------------------------------------------------------------

describe('effectOf: create_snapshot', () => {
  it('creates entity and links snapshot child', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 1000, action: 'create_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000` },
      nullLoad,
    );
    const page = result[`page:${slug}`];
    expect(page).toBeTruthy();
    expect(page.childIds).toContain(`snapshot:${slug}-1000`);
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 1000, action: 'create_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000`, title: 'Snap Title' },
      nullLoad,
    );
    expect(result[`page:${slug}`].title).toBe('Snap Title');
  });

  it('appends to existing childIds', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 2000, action: 'create_snapshot', url: 'https://a.com', path: `snapshots/${slug}-2000` },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 1000, parentIds: [], childIds: [`snapshot:${slug}-1000`] } }),
    );
    expect(result[`page:${slug}`].childIds).toContain(`snapshot:${slug}-1000`);
    expect(result[`page:${slug}`].childIds).toContain(`snapshot:${slug}-2000`);
  });
});

// ---------------------------------------------------------------------------
// effectOf: create_note
// ---------------------------------------------------------------------------

describe('effectOf: create_note', () => {
  it('creates page entity and links note child', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'create_note', url: 'https://a.com', path: 'notes/n1.json' },
      nullLoad,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].childIds).toContain('note:n1');
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'create_note', url: 'https://a.com', path: 'notes/n1.json', title: 'Note Page' },
      nullLoad,
    );
    expect(result[`page:${slug}`].title).toBe('Note Page');
  });

  it('links note on existing page', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'create_note', url: 'https://a.com', path: 'notes/n2.json' },
      makeLoad({ [`page:${slug}`]: { slug, timestamp: 50, parentIds: [], childIds: ['note:n1'] } }),
    );
    expect(result[`page:${slug}`].childIds).toContain('note:n1');
    expect(result[`page:${slug}`].childIds).toContain('note:n2');
  });
});

// ---------------------------------------------------------------------------
// effectOf: delete_note / restore_note
// ---------------------------------------------------------------------------

describe('effectOf: delete_note', () => {
  it('unlinks from parent, marks deleted, orphans', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: ['note:n1', 'note:n2'], user_title: 'Kept' },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_note', url: 'https://a.com', path: 'notes/n1.json' },
      makeLoad(store),
    );
    expect(result['page:p1'].childIds).not.toContain('note:n1');
    expect(result['note:n1'].deleted).toBe(true);
    expect(result['manifest:orphaned'].keys).toContain('note:n1');
  });

  it('noop if already deleted', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, deleted: true, parentIds: ['page:p1'], childIds: [] },
      'manifest:orphaned': { timestamp: 0, keys: ['note:n1'] },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      { timestamp: 200, action: 'delete_note', url: 'https://a.com', path: 'notes/n1.json' },
      load,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('effectOf: restore_note', () => {
  it('re-links, clears deleted, unorphans', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, deleted: true, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: [] },
      'manifest:orphaned': { timestamp: 50, keys: ['note:n1'] },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'restore_note', url: 'https://a.com', path: 'notes/n1.json' },
      load,
    );
    expect(result['page:p1'].childIds).toContain('note:n1');
    expect(result['note:n1'].deleted).toBe(false);
    expect(result['manifest:orphaned'].keys).not.toContain('note:n1');
  });
});

// ---------------------------------------------------------------------------
// effectOf: replace_note
// ---------------------------------------------------------------------------

describe('effectOf: replace_note', () => {
  it('unlinks old note, links new note on parent page', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, excerpt: 'old text', parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      makeLoad(store),
    );
    // Old note unlinked from page
    expect(result['page:p1'].childIds).not.toContain('note:n1');
    // New note linked to page
    expect(result['page:p1'].childIds).toContain('note:n2');
  });

  it('marks old note as deleted with reason "replaced"', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      makeLoad(store),
    );
    expect(result['note:n1'].deleted).toBe(true);
    expect(result['note:n1'].deletionReason).toBe('replaced');
    expect(result['note:n1'].replacedBy).toBe('note:n2');
  });

  it('orphans old note', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      makeLoad(store),
    );
    expect(result['manifest:orphaned'].keys).toContain('note:n1');
  });

  it('transfers list pins from old note to new note', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1', 'list:test-id'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: 'note:n1', pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      makeLoad(store),
    );
    // Old note pin replaced with new note pin
    const pins = result['list:test-id'].pins;
    expect(pins.some(p => p.id === 'note:n2')).toBe(true);
    expect(pins.some(p => p.id === 'note:n1')).toBe(false);
  });

  it('sets new note parentIds from old note', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1', 'list:test-id'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: 'note:n1', pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      makeLoad(store),
    );
    // New note inherits parentIds
    expect(result['note:n2'].parentIds).toContain('page:p1');
    expect(result['note:n2'].parentIds).toContain('list:test-id');
  });

  it('noop if old note is already deleted', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, deleted: true, parentIds: ['page:p1'], childIds: [] },
      'manifest:orphaned': { timestamp: 0, keys: ['note:n1'] },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' },
      load,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('is idempotent (safe to replay twice)', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, url: 'https://a.com', parentIds: [], childIds: ['note:n1'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const entry = { timestamp: 100, action: 'replace_note', url: 'https://a.com', path: 'notes/n2.json', oldPath: 'notes/n1.json' };
    const result1 = await effectOf(entry, makeLoad(store));

    // Apply result1 to store, then replay
    const store2 = { ...store };
    for (const [k, v] of Object.entries(result1)) {
      if (v === null) delete store2[k];
      else store2[k] = v;
    }
    const load2 = async (key, opts) => {
      const e = store2[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result2 = await effectOf(entry, load2);

    // Second replay should be a noop (old note already deleted)
    expect(Object.keys(result2)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// effectOf: delete_snapshot / restore_snapshot
// ---------------------------------------------------------------------------

describe('effectOf: delete_snapshot', () => {
  it('unlinks from page childIds, orphans', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: { slug, timestamp: 50, parentIds: ['list:some-list'], childIds: [`snapshot:${slug}-1000`] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000` },
      makeLoad(store),
    );
    expect(result[`page:${slug}`].childIds).not.toContain(`snapshot:${slug}-1000`);
    expect(result['manifest:orphaned'].keys).toContain(`snapshot:${slug}-1000`);
  });
});

describe('effectOf: restore_snapshot', () => {
  it('re-links to page childIds, unorphans', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: { slug, timestamp: 50, parentIds: [], childIds: [] },
      'manifest:orphaned': { timestamp: 50, keys: [`snapshot:${slug}-1000`] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'restore_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000` },
      makeLoad(store),
    );
    expect(result[`page:${slug}`].childIds).toContain(`snapshot:${slug}-1000`);
    expect(result['manifest:orphaned'].keys).not.toContain(`snapshot:${slug}-1000`);
  });
});

// ---------------------------------------------------------------------------
// effectOf: pin_to_list / unpin_from_list
// ---------------------------------------------------------------------------

describe('effectOf: pin_to_list', () => {
  it('adds pin, creates page entity, updates parentIds', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result['list:test-id'].pins).toHaveLength(1);
    expect(result['list:test-id'].pins[0].id).toBe(`page:${slug}`);
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].parentIds).toContain('list:test-id');
  });

  it('resolves auto list by name directly', async () => {
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: [], name: 'auto/gateways', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result['list:auto/gateways'].pins).toHaveLength(1);
  });

  it('skips orphaned lists', async () => {
    const store = listStore({ 'manifest:orphaned': { timestamp: 0, keys: ['list:test-id'] } });
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result['list:test-id']).toBeUndefined();
  });

  it('applies title from entry.titles to newly-created page entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test',
        items: ['https://a.com'], titles: { 'https://a.com': 'Page A Title' } },
      makeLoad(store),
    );
    expect(result[`page:${slug}`].title).toBe('Page A Title');
  });

  it('does not overwrite existing title with entry.titles', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', title: 'Existing Title', parentIds: [], childIds: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test',
        items: ['https://a.com'], titles: { 'https://a.com': 'New Title' } },
      makeLoad(store),
    );
    expect(result[`page:${slug}`].title).toBe('Existing Title');
  });

  it('deduplicates pins', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', parentIds: ['list:test-id'], childIds: [] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: `page:${slug}`, pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'pin_to_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result['list:test-id'].pins).toHaveLength(1);
  });
});

describe('effectOf: unpin_from_list', () => {
  it('removes pin, GCs page with no other eligible criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', parentIds: ['list:test-id'], childIds: [] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: `page:${slug}`, pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'unpin_from_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result['list:test-id'].pins).toHaveLength(0);
    expect(result[`page:${slug}`]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effectOf: create_list
// ---------------------------------------------------------------------------

describe('effectOf: create_list', () => {
  it('creates list, updates name-map and root', async () => {
    const store = {
      'manifest:name-to-id': { timestamp: 0, paths: {} },
      'list:system/root': { timestamp: 0, childLists: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'create_list', name: 'My List', parents: [] },
      makeLoad(store),
    );
    // Find the generated list ID
    const listKey = Object.keys(result).find(k => k.startsWith('list:') && k !== 'list:system/root');
    expect(listKey).toBeTruthy();
    const listId = listKey.replace('list:', '');
    expect(result[listKey]).toBeTruthy();
    expect(result[listKey].name).toBe('My List');
    expect(result[listKey].parentList).toBe('list:system/root');
    expect(result['list:system/root'].childLists).toContain(listKey);
    expect(result['manifest:name-to-id'].paths['root/My List']).toBe(listId);
  });

  it('creates nested list under parent', async () => {
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'create_list', name: 'Child', parents: ['root', 'Test'] },
      makeLoad(store),
    );
    const childKey = Object.keys(result).find(k => k.startsWith('list:') && k !== 'list:system/root' && k !== 'list:test-id');
    expect(childKey).toBeTruthy();
    const childId = childKey.replace('list:', '');
    expect(result[childKey].parentList).toBe('list:test-id');
    expect(result['list:test-id'].childLists).toContain(childKey);
    expect(result['manifest:name-to-id'].paths['root/Test/Child']).toBe(childId);
  });

  it('uses provided listId when present (migrated events)', async () => {
    const store = {
      'manifest:name-to-id': { timestamp: 0, paths: {} },
      'list:system/root': { timestamp: 0, childLists: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'create_list', name: 'Cinema', parents: [], listId: 'cinema-gfl1h7' },
      makeLoad(store),
    );
    expect(result['list:cinema-gfl1h7']).toBeTruthy();
    expect(result['list:cinema-gfl1h7'].name).toBe('Cinema');
    expect(result['list:system/root'].childLists).toContain('list:cinema-gfl1h7');
    expect(result['manifest:name-to-id'].paths['root/Cinema']).toBe('cinema-gfl1h7');
  });
});

// ---------------------------------------------------------------------------
// effectOf: update_list
// ---------------------------------------------------------------------------

describe('effectOf: update_list', () => {
  it('renames list and updates name-map', async () => {
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'update_list', parents: ['root'], name: 'Test', newName: 'Renamed' },
      makeLoad(store),
    );
    expect(result['list:test-id'].name).toBe('Renamed');
    expect(result['manifest:name-to-id'].paths['root/Renamed']).toBe('test-id');
    expect(result['manifest:name-to-id'].paths['root/Test']).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// effectOf: delete_list / restore_list
// ---------------------------------------------------------------------------

describe('effectOf: delete_list', () => {
  it('soft-deletes, removes from parent and name-map, orphans', async () => {
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'delete_list', parents: ['root'], name: 'Test' },
      makeLoad(store),
    );
    expect(result['list:test-id'].deleted).toBe(true);
    expect(result['list:system/root'].childLists).not.toContain('list:test-id');
    expect(result['manifest:name-to-id'].paths['root/Test']).toBeUndefined();
    expect(result['manifest:orphaned'].keys).toContain('list:test-id');
  });

  it('noop if already deleted', async () => {
    const store = listStore({
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', deleted: true, pins: [], parentList: 'list:system/root', childLists: [] },
    });
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      { timestamp: 200, action: 'delete_list', parents: ['root'], name: 'Test' },
      load,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('cascades to child lists', async () => {
    const store = listStore({
      'manifest:name-to-id': { timestamp: 0, paths: { 'root/Test': 'test-id', 'root/Test/Child': 'child-id' } },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [], parentList: 'list:system/root', childLists: ['list:child-id'] },
      'list:child-id': { timestamp: 0, slug: 'child-id', name: 'Child', pins: [], parentList: 'list:test-id', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'delete_list', parents: ['root'], name: 'Test' },
      makeLoad(store),
    );
    expect(result['list:child-id'].deleted).toBe(true);
    expect(result['manifest:orphaned'].keys).toContain('list:child-id');
    expect(result['manifest:name-to-id'].paths['root/Test/Child']).toBeUndefined();
  });
});

describe('effectOf: restore_list', () => {
  it('restores to root, re-adds to name-map, unorphans', async () => {
    const store = {
      'manifest:name-to-id': { timestamp: 0, paths: {} },
      'list:test-id': { slug: 'test-id', name: 'Test', deleted: true, timestamp: 50, pins: [], parentList: 'list:system/root', childLists: [] },
      'list:system/root': { timestamp: 0, childLists: [] },
      'manifest:orphaned': { timestamp: 50, keys: ['list:test-id'] },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      { timestamp: 100, action: 'restore_list', parents: ['root'], name: 'Test' },
      load,
    );
    expect(result['list:test-id'].deleted).toBe(false);
    expect(result['list:system/root'].childLists).toContain('list:test-id');
    expect(result['manifest:name-to-id'].paths['root/Test']).toBe('test-id');
    expect(result['manifest:orphaned'].keys).not.toContain('list:test-id');
  });
});

// ---------------------------------------------------------------------------
// effectOf: visit_page — REFERRER_CAP
// ---------------------------------------------------------------------------

describe('effectOf: visit_page — REFERRER_CAP', () => {
  it('caps parentIds at 50 via LRU eviction', async () => {
    // Build a page with 50 existing parentIds
    const childSlug = generateSlugFromUrl('https://example.com/child');
    const existingParentIds = [];
    for (let i = 0; i < 50; i++) {
      existingParentIds.push(`page:${generateSlugFromUrl(`https://example.com/old-parent-${i}`)}`);
    }
    const store = {
      [`page:${childSlug}`]: {
        slug: childSlug, url: 'https://example.com/child', title: 'Child',
        timestamp: 50, parentIds: existingParentIds, childIds: [],
      },
      'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', pins: [], parentList: null, childLists: [] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const newParentUrl = 'https://example.com/new-parent-51';
    const newParentSlug = generateSlugFromUrl(newParentUrl);
    store[`page:${newParentSlug}`] = {
      slug: newParentSlug, url: newParentUrl, title: 'New Parent',
      timestamp: 50, parentIds: [], childIds: [],
    };

    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: 'https://example.com/child', title: 'Child', referrerUrl: newParentUrl },
      makeLoad(store),
    );

    // parentIds should still be 50 (capped), with oldest evicted
    expect(result[`page:${childSlug}`].parentIds).toHaveLength(50);
    // Oldest parent (index 0) should be evicted
    expect(result[`page:${childSlug}`].parentIds).not.toContain(existingParentIds[0]);
    // New parent should be present
    expect(result[`page:${childSlug}`].parentIds).toContain(`page:${newParentSlug}`);
  });

  it('caps childIds at 50 on referrer page', async () => {
    const parentSlug = generateSlugFromUrl('https://example.com/parent');
    const existingChildIds = [];
    for (let i = 0; i < 50; i++) {
      existingChildIds.push(`page:${generateSlugFromUrl(`https://example.com/old-child-${i}`)}`);
    }
    const store = {
      [`page:${parentSlug}`]: {
        slug: parentSlug, url: 'https://example.com/parent', title: 'Parent',
        timestamp: 50, parentIds: [], childIds: existingChildIds,
      },
      'list:auto/gateways': { timestamp: 0, slug: 'auto/gateways', name: 'Gateways', pins: [], parentList: null, childLists: [] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const newChildUrl = 'https://example.com/new-child-51';
    const newChildSlug = generateSlugFromUrl(newChildUrl);
    store[`page:${newChildSlug}`] = {
      slug: newChildSlug, url: newChildUrl, title: 'New Child',
      timestamp: 50, parentIds: [], childIds: [],
    };

    const result = await effectOf(
      { timestamp: 100, action: 'visit_page', url: newChildUrl, title: 'New Child', referrerUrl: 'https://example.com/parent' },
      makeLoad(store),
    );

    // childIds should still be 50 (capped), with oldest evicted
    expect(result[`page:${parentSlug}`].childIds).toHaveLength(50);
    // Oldest child (index 0) should be evicted
    expect(result[`page:${parentSlug}`].childIds).not.toContain(existingChildIds[0]);
    // New child should be present
    expect(result[`page:${parentSlug}`].childIds).toContain(`page:${newChildSlug}`);
  });
});

// effectOf: reparent_list
// ---------------------------------------------------------------------------

describe('effectOf: reparent_list', () => {
  it('moves list between parents and updates name-map', async () => {
    const store = {
      'manifest:name-to-id': { timestamp: 0, paths: { 'root/A': 'a-id', 'root/B': 'b-id' } },
      'list:a-id': { timestamp: 0, slug: 'a-id', name: 'A', pins: [], parentList: 'list:system/root', childLists: [] },
      'list:b-id': { timestamp: 0, slug: 'b-id', name: 'B', pins: [], parentList: 'list:system/root', childLists: [] },
      'list:system/root': { timestamp: 0, childLists: ['list:a-id', 'list:b-id'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'reparent_list', parents: ['root'], name: 'B', toParents: ['root', 'A'] },
      makeLoad(store),
    );
    expect(result['list:b-id'].parentList).toBe('list:a-id');
    expect(result['list:system/root'].childLists).not.toContain('list:b-id');
    expect(result['list:a-id'].childLists).toContain('list:b-id');
    expect(result['manifest:name-to-id'].paths['root/A/B']).toBe('b-id');
    expect(result['manifest:name-to-id'].paths['root/B']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isPageEligible
// ---------------------------------------------------------------------------

describe('isPageEligible', () => {
  it('returns true for page with list parent', () => {
    expect(isPageEligible({ slug: 's', parentIds: ['list:test-id'], childIds: [] })).toBe(true);
  });

  it('returns true for page with note child', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: ['note:n1'] })).toBe(true);
  });

  it('returns true for page with snapshot child', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: ['snapshot:s-100'] })).toBe(true);
  });

  it('returns true for page with user_title', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: [], user_title: 'My Title' })).toBe(true);
  });

  it('returns true for page with likes', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: [], likes: 2 })).toBe(true);
  });

  it('returns false for visit-only page', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: [], visitDates: [20260314] })).toBe(false);
  });

  it('returns false for page with only page:* parents (referrers)', () => {
    expect(isPageEligible({ slug: 's', parentIds: ['page:other'], childIds: [] })).toBe(false);
  });

  it('returns false for page with only page:* children (referrer links)', () => {
    expect(isPageEligible({ slug: 's', parentIds: [], childIds: ['page:other'] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on unpin_from_list
// ---------------------------------------------------------------------------

describe('effectOf: page GC on unpin_from_list', () => {
  it('GCs page when last list parent removed and no other criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', parentIds: ['list:test-id'], childIds: [] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: `page:${slug}`, pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'unpin_from_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('keeps page when it still has note children after unpin', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', parentIds: ['list:test-id'], childIds: ['note:n1'] },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: `page:${slug}`, pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'unpin_from_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].parentIds).not.toContain('list:test-id');
  });

  it('keeps page when it has user_title after unpin', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: { slug, timestamp: 50, url: 'https://a.com', parentIds: ['list:test-id'], childIds: [], user_title: 'Custom' },
      'list:test-id': { timestamp: 0, slug: 'test-id', name: 'Test', pins: [{ id: `page:${slug}`, pinnedAt: 50 }], parentList: 'list:system/root', childLists: [] },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'unpin_from_list', parents: ['root'], name: 'Test', items: ['https://a.com'] },
      makeLoad(store),
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].user_title).toBe('Custom');
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on delete_note
// ---------------------------------------------------------------------------

describe('effectOf: page GC on delete_note', () => {
  it('GCs parent page when note was last eligible criterion', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: ['note:n1'] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_note', url: 'https://a.com', path: 'notes/n1.json' },
      makeLoad(store),
    );
    expect(result['page:p1']).toBeNull();
  });

  it('keeps parent page when it has other eligible criteria', async () => {
    const store = {
      'note:n1': { slug: 'n1', timestamp: 50, parentIds: ['page:p1'], childIds: [] },
      'page:p1': { slug: 'p1', timestamp: 50, parentIds: [], childIds: ['note:n1'], user_title: 'Kept' },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_note', url: 'https://a.com', path: 'notes/n1.json' },
      makeLoad(store),
    );
    expect(result['page:p1']).not.toBeNull();
    expect(result['page:p1'].childIds).not.toContain('note:n1');
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on delete_snapshot
// ---------------------------------------------------------------------------

describe('effectOf: page GC on delete_snapshot', () => {
  it('GCs parent page when snapshot was last eligible criterion', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: { slug, timestamp: 50, parentIds: [], childIds: [`snapshot:${slug}-1000`] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000` },
      makeLoad(store),
    );
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('keeps parent page when it has other eligible criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: { slug, timestamp: 50, parentIds: ['list:some-list'], childIds: [`snapshot:${slug}-1000`] },
      'manifest:orphaned': { timestamp: 0, keys: [] },
    };
    const result = await effectOf(
      { timestamp: 100, action: 'delete_snapshot', url: 'https://a.com', path: `snapshots/${slug}-1000` },
      makeLoad(store),
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].childIds).not.toContain(`snapshot:${slug}-1000`);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity: list includes rules
// ---------------------------------------------------------------------------

describe('defaultEntity: list rules field', () => {
  it('includes rules array in list default entity', () => {
    const entity = defaultEntity('list:my-list');
    expect(entity.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// effectOf: add_rule / remove_rule / update_rule
// ---------------------------------------------------------------------------

describe('effectOf: add_rule', () => {
  it('adds a rule to a list', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        parents: ['root'],
        name: 'Test',
        rule: { type: 'keyword', config: { pattern: 'test', fields: ['title'] } },
      },
      makeLoad(store),
    );
    expect(result['list:test-id']).toBeTruthy();
    expect(result['list:test-id'].rules).toHaveLength(1);
    expect(result['list:test-id'].rules[0].type).toBe('keyword');
    expect(result['list:test-id'].rules[0].config.pattern).toBe('test');
    expect(result['list:test-id'].rules[0].id).toMatch(/^rule-k-/);
    expect(result['list:test-id'].timestamp).toBe(100);
  });

  it('is idempotent — replaying same entry does not duplicate', async () => {
    const ruleId = 'rule-k-abc-1234';
    const store = listStore({
      'list:test-id': {
        timestamp: 50, slug: 'test-id', name: 'Test', pins: [],
        rules: [{ id: ruleId, type: 'keyword', config: { pattern: 'test' }, createdAt: 50 }],
        parentList: 'list:system/root', childLists: [],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        parents: ['root'],
        name: 'Test',
        rule: { type: 'keyword', config: { pattern: 'test' }, id: ruleId },
      },
      makeLoad(store),
    );
    expect(result['list:test-id'].rules).toHaveLength(1);
  });

  it('skips orphaned lists', async () => {
    const store = listStore({ 'manifest:orphaned': { timestamp: 0, keys: ['list:test-id'] } });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        parents: ['root'],
        name: 'Test',
        rule: { type: 'keyword', config: { pattern: 'test' } },
      },
      makeLoad(store),
    );
    expect(result['list:test-id']).toBeUndefined();
  });

  it('returns empty result for unknown list', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        parents: ['root'],
        name: 'NonExistent',
        rule: { type: 'keyword', config: { pattern: 'test' } },
      },
      makeLoad(store),
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('effectOf: remove_rule', () => {
  it('removes a rule from a list', async () => {
    const store = listStore({
      'list:test-id': {
        timestamp: 50, slug: 'test-id', name: 'Test', pins: [],
        rules: [{ id: 'rule-k-abc-1234', type: 'keyword', config: { pattern: 'test' }, createdAt: 50 }],
        parentList: 'list:system/root', childLists: [],
      },
    });
    const result = await effectOf(
      { timestamp: 100, action: 'remove_rule', parents: ['root'], name: 'Test', ruleId: 'rule-k-abc-1234' },
      makeLoad(store),
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
    expect(result['list:test-id'].timestamp).toBe(100);
  });

  it('is idempotent — removing non-existent rule is no-op', async () => {
    const store = listStore();
    const result = await effectOf(
      { timestamp: 100, action: 'remove_rule', parents: ['root'], name: 'Test', ruleId: 'rule-k-nonexistent' },
      makeLoad(store),
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
  });

  it('skips orphaned lists', async () => {
    const store = listStore({ 'manifest:orphaned': { timestamp: 0, keys: ['list:test-id'] } });
    const result = await effectOf(
      { timestamp: 100, action: 'remove_rule', parents: ['root'], name: 'Test', ruleId: 'rule-k-abc-1234' },
      makeLoad(store),
    );
    expect(result['list:test-id']).toBeUndefined();
  });
});

describe('effectOf: update_rule', () => {
  it('merges config for matching rule', async () => {
    const store = listStore({
      'list:test-id': {
        timestamp: 50, slug: 'test-id', name: 'Test', pins: [],
        rules: [{
          id: 'rule-k-abc-1234', type: 'keyword',
          config: { pattern: 'old', fields: ['title'] },
          createdAt: 50,
        }],
        parentList: 'list:system/root', childLists: [],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        parents: ['root'],
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
        config: { pattern: 'new' },
      },
      makeLoad(store),
    );
    const rule = result['list:test-id'].rules[0];
    expect(rule.config.pattern).toBe('new');
    expect(rule.config.fields).toEqual(['title']); // preserved
    expect(rule.createdAt).toBe(50); // preserved
    expect(result['list:test-id'].timestamp).toBe(100);
  });

  it('is idempotent — updating non-existent rule leaves list unchanged', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        parents: ['root'],
        name: 'Test',
        ruleId: 'rule-k-nonexistent',
        config: { pattern: 'test' },
      },
      makeLoad(store),
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
  });

  it('skips orphaned lists', async () => {
    const store = listStore({ 'manifest:orphaned': { timestamp: 0, keys: ['list:test-id'] } });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        parents: ['root'],
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
        config: { pattern: 'test' },
      },
      makeLoad(store),
    );
    expect(result['list:test-id']).toBeUndefined();
  });
});
