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
  isStaleByLWW,
} from '../extension/replay.js';
import { generateSlugFromUrl } from '../extension/utils.js';

// Default device name for all tests (always-on)
const CTX = { deviceId: 'test-device' };

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
    'manifest:name-to-id': { paths: { 'test-device/Test': 'test-id' } },
    'list:test-id': {
      slug: 'test-id',
      name: 'Test',
      owner: 'test-device',
      pins: [],
    },
    'manifest:list-order': { tree: [{ id: 'list:test-id' }] },
    'manifest:orphaned': { entries: [] },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// getAffectedKeys
// ---------------------------------------------------------------------------

describe('getAffectedKeys', () => {
  it('returns page key for visit_page', () => {
    const keys = getAffectedKeys({
      timestamp: 100,
      action: 'visit_page',
      url: 'https://a.com',
      title: 'A',
    });
    expect(keys.size).toBe(1);
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns child and parent keys for visit_page with referrerUrl', () => {
    const keys = getAffectedKeys({
      timestamp: 100,
      action: 'visit_page',
      url: 'https://child.com',
      title: 'C',
      referrerUrl: 'https://parent.com',
    });
    expect(keys.size).toBe(2);
    expect(keys.has(`page:${generateSlugFromUrl('https://child.com')}`)).toBe(
      true,
    );
    expect(keys.has(`page:${generateSlugFromUrl('https://parent.com')}`)).toBe(
      true,
    );
  });

  it('returns page key for create_note', () => {
    const keys = getAffectedKeys({
      timestamp: 100,
      action: 'create_note',
      url: 'https://a.com',
      path: 'notes/n1.json',
    });
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns page key for delete_snapshot', () => {
    const slug = generateSlugFromUrl('https://a.com');
    const keys = getAffectedKeys({
      timestamp: 100,
      action: 'delete_snapshot',
      url: 'https://a.com',
      path: `snapshots/${slug}-50`,
    });
    expect(keys.has(`page:${generateSlugFromUrl('https://a.com')}`)).toBe(true);
  });

  it('returns empty set for list events (no url)', () => {
    const keys = getAffectedKeys({
      timestamp: 100,
      action: 'pin_to_list',
      listOwner: 'test-device',
      name: 'Test',
      items: ['https://a.com'],
    });
    // pin_to_list has no entry.url at top level
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyLogToSettings
// ---------------------------------------------------------------------------

describe('applyLogToSettings', () => {
  it('merges key/value into settings', () => {
    const settings = { workspace: { mode: 'default' } };
    const entry = {
      timestamp: 100,
      action: 'update_setting',
      key: 'workspace',
      value: { mode: 'private' },
    };
    const result = applyLogToSettings(settings, entry, CTX);
    expect(result.workspace).toEqual({ mode: 'private' });
    expect(result.timestamps?.['test-device']).toBe(100);
  });

  it('adds new key to settings', () => {
    const settings = {};
    const entry = {
      timestamp: 200,
      action: 'update_setting',
      key: 'urlBlacklist',
      value: ['chrome://'],
    };
    const result = applyLogToSettings(settings, entry, CTX);
    expect(result.urlBlacklist).toEqual(['chrome://']);
  });

  it('ignores non-update_setting entries', () => {
    const settings = {};
    const entry = {
      timestamp: 100,
      action: 'visit_page',
      url: 'https://a.com',
    };
    expect(applyLogToSettings(settings, entry, CTX)).toBe(settings);
  });

  it('is idempotent', () => {
    const settings = {};
    const entry = {
      timestamp: 100,
      action: 'update_setting',
      key: 'x',
      value: 42,
    };
    const r1 = applyLogToSettings(settings, entry, CTX);
    const r2 = applyLogToSettings(r1, entry, CTX);
    expect(r2).toEqual(r1);
  });

  it('preserves unrelated keys', () => {
    const settings = { a: 1, b: 2 };
    const entry = {
      timestamp: 100,
      action: 'update_setting',
      key: 'a',
      value: 10,
    };
    expect(applyLogToSettings(settings, entry, CTX).b).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// defaultEntity
// ---------------------------------------------------------------------------

describe('defaultEntity', () => {
  it('returns page default', () => {
    expect(defaultEntity('page:s1')).toEqual({
      slug: 's1',
      parentIds: [],
      childIds: [],
    });
  });
  it('returns note default', () => {
    const e = defaultEntity('note:n1');
    expect(e.slug).toBe('n1');
    expect(e.excerpt).toBeNull();
  });
  it('returns settings default', () => {
    expect(defaultEntity('manifest:settings')).toEqual({});
  });
  it('returns list default', () => {
    const e = defaultEntity('list:abc');
    expect(e.slug).toBe('abc');
    expect(e.pins).toEqual([]);
  });
  it('returns list-order default', () => {
    expect(defaultEntity('manifest:list-order')).toEqual({ tree: [] });
  });
  it('returns name-map default', () => {
    expect(defaultEntity('manifest:name-to-id')).toEqual({ paths: {} });
  });
  it('returns orphaned default', () => {
    expect(defaultEntity('manifest:orphaned')).toEqual({ entries: [] });
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
      makeLoad({ 'manifest:settings': {} }),
      CTX,
    );
    expect(result['manifest:settings'].theme).toBe('dark');
    expect(result['manifest:settings'].timestamps?.['test-device']).toBe(100);
  });

  it('creates settings from null', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'update_setting', key: 'x', value: 1 },
      nullLoad,
      CTX,
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
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
      },
      makeLoad({ [`page:${slug}`]: { slug, parentIds: [], childIds: [] } }),
      CTX,
    );
    expect(result[`page:${slug}`].url).toBe('https://a.com');
    expect(result[`page:${slug}`].title).toBe('A');
    expect(result[`page:${slug}`].timestamps?.['test-device']).toBe(100);
  });

  it('does NOT create entity from null (passive visit)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`]).toBeUndefined();
  });

  it('adds visitDates', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: new Date('2026-03-11').getTime(),
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
      },
      makeLoad({ [`page:${slug}`]: { slug, parentIds: [], childIds: [] } }),
      CTX,
    );
    expect(result[`page:${slug}`].visitDates).toContain(20260311);
  });

  it('adds referrerUrl to parentIds', async () => {
    const childSlug = generateSlugFromUrl('https://child.com');
    const parentSlug = generateSlugFromUrl('https://parent.com');
    const store = {
      [`page:${childSlug}`]: { slug: childSlug, parentIds: [], childIds: [] },
      [`page:${parentSlug}`]: {
        slug: parentSlug,
        url: 'https://parent.com',
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: [],
      },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://child.com',
        title: 'C',
        referrerUrl: 'https://parent.com',
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${childSlug}`].parentIds).toContain(
      `page:${parentSlug}`,
    );
    expect(result[`page:${parentSlug}`].childIds).toContain(
      `page:${childSlug}`,
    );
  });

  it('accumulates childIds on referrer page', async () => {
    const childSlug = generateSlugFromUrl('https://github.com/user/repo');
    const parentSlug = generateSlugFromUrl('https://github.com/');
    const store = {
      [`page:${childSlug}`]: {
        slug: childSlug,
        url: 'https://github.com/user/repo',
        parentIds: [],
        childIds: [],
      },
      [`page:${parentSlug}`]: {
        slug: parentSlug,
        url: 'https://github.com/',
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: [],
      },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://github.com/user/repo',
        title: 'Repo',
        referrerUrl: 'https://github.com/',
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${childSlug}`].parentIds).toContain(
      `page:${parentSlug}`,
    );
    expect(result[`page:${parentSlug}`].childIds).toContain(
      `page:${childSlug}`,
    );
  });

  it('creates entity when checkpoint flag is set (no pre-existing entity)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
        checkpoint: true,
      },
      nullLoad,
      CTX,
    );
    const page = result[`page:${slug}`];
    expect(page).toBeDefined();
    expect(page.url).toBe('https://a.com');
    expect(page.title).toBe('A');
    expect(page.timestamps?.['test-device']).toBe(100);
  });

  it('checkpoint enriches existing entity same as normal visit', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'Updated',
        checkpoint: true,
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          url: 'https://a.com',
          title: 'Old',
          timestamps: { 'test-device': 100 },
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
    );
    const page = result[`page:${slug}`];
    expect(page.title).toBe('Updated');
    expect(page.timestamps['test-device']).toBe(200);
  });

  it('checkpoint sets createdAt when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
        checkpoint: true,
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`].createdAt).toBe(100);
  });

  it('visit_page does not overwrite createdAt on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          createdAt: 50,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': 100 },
        },
      }),
      CTX,
    );
    expect(result[`page:${slug}`].createdAt).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// effectOf: leave_page
// ---------------------------------------------------------------------------

describe('effectOf: leave_page', () => {
  it('updates attention data on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'leave_page',
        url: 'https://a.com',
        scrollDepth: 80,
        timeOnPage: 5000,
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 100 },
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
    );
    expect(result[`page:${slug}`].scrollDepth).toBe(80);
    expect(result[`page:${slug}`].timeOnPage).toBe(5000);
  });

  it('does NOT create entity from null', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'leave_page',
        url: 'https://a.com',
        scrollDepth: 80,
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`]).toBeUndefined();
  });

  it('idempotency: skips attention when timestamps[device] >= entry.timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'leave_page',
        url: 'https://a.com',
        scrollDepth: 50,
        timeOnPage: 1000,
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          scrollDepth: 30,
          timeOnPage: 2000,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': 100 },
        },
      }),
      CTX,
    );
    // timestamps['test-device'] >= entry.timestamp, so attention not applied
    expect(result[`page:${slug}`].scrollDepth).toBe(30);
    expect(result[`page:${slug}`].timeOnPage).toBe(2000);
  });

  it('updates title from leave report', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'leave_page',
        url: 'https://a.com',
        title: 'New Title',
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 100 },
          title: 'Old',
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('New Title');
  });

  it('accumulates delta timeOnPage across multiple leave events', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;
    // First leave: 2000ms foreground delta
    const r1 = await effectOf(
      {
        timestamp: 200,
        action: 'leave_page',
        url: 'https://a.com',
        timeOnPage: 2000,
      },
      makeLoad({
        [pageKey]: {
          slug,
          timestamps: { 'test-device': 100 },
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
    );
    expect(r1[pageKey].timeOnPage).toBe(2000);
    // Second leave: 500ms foreground delta (after tab switch back)
    const r2 = await effectOf(
      {
        timestamp: 300,
        action: 'leave_page',
        url: 'https://a.com',
        timeOnPage: 500,
      },
      makeLoad({ [pageKey]: { ...r1[pageKey] } }),
      CTX,
    );
    expect(r2[pageKey].timeOnPage).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// effectOf: rename_page
// ---------------------------------------------------------------------------

describe('effectOf: rename_page', () => {
  it('sets user_title and creates entity if missing', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'rename_page',
        url: 'https://a.com',
        user_title: 'Custom',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].user_title).toBe('Custom');
  });

  it('updates user_title on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'rename_page',
        url: 'https://a.com',
        user_title: 'New Name',
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 100 },
          user_title: 'Old',
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
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
      CTX,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].likes).toBe(1);
  });

  it('accumulates likes on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'rate_page', url: 'https://a.com', likes: -1 },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 100 },
          likes: 3,
          parentIds: [],
          childIds: [],
        },
      }),
      CTX,
    );
    expect(result[`page:${slug}`].likes).toBe(2);
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'rate_page',
        url: 'https://a.com',
        likes: 1,
        title: 'Page A',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('Page A');
  });

  it('sets createdAt when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1 },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`].createdAt).toBe(100);
  });

  it('does not overwrite createdAt on existing entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 200, action: 'rate_page', url: 'https://a.com', likes: 1 },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          createdAt: 50,
          likes: 0,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': 100 },
        },
      }),
      CTX,
    );
    expect(result[`page:${slug}`].createdAt).toBe(50);
  });

  it('idempotency: skips likes when timestamps[device] >= entry.timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1 },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          likes: 3,
          parentIds: [],
          childIds: [],
          timestamps: { 'test-device': 100 },
        },
      }),
      CTX,
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
      {
        timestamp: 1000,
        action: 'create_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
      },
      nullLoad,
      CTX,
    );
    const page = result[`page:${slug}`];
    expect(page).toBeTruthy();
    expect(page.childIds).toContain(`snapshot:${slug}-1000`);
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 1000,
        action: 'create_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
        title: 'Snap Title',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('Snap Title');
  });

  it('appends to existing childIds', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 2000,
        action: 'create_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-2000`,
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 1000 },
          parentIds: [],
          childIds: [`snapshot:${slug}-1000`],
        },
      }),
      CTX,
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
      {
        timestamp: 100,
        action: 'create_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].childIds).toContain('note:n1');
  });

  it('applies title from entry when creating new entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
        title: 'Note Page',
      },
      nullLoad,
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('Note Page');
  });

  it('links note on existing page', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
      },
      makeLoad({
        [`page:${slug}`]: {
          slug,
          timestamps: { 'test-device': 50 },
          parentIds: [],
          childIds: ['note:n1'],
        },
      }),
      CTX,
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
    const pageSlug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${pageSlug}`;
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [pageKey]: {
        slug: pageSlug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: ['note:n1', 'note:n2'],
        user_title: 'Kept',
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    expect(result[pageKey].childIds).not.toContain('note:n1');
    expect(result['note:n1'].deleted).toBe(true);
    expect(result['manifest:orphaned'].entries).toContainEqual({
      key: 'note:n1',
      url: 'https://a.com',
    });
  });

  it('noop if already deleted with deletedTs >= entry.timestamp', async () => {
    const store = {
      'note:n1': {
        slug: 'n1',
        deleted: true,
        deletedTs: 200,
        url: 'https://a.com',
      },
      'manifest:orphaned': {
        entries: [{ key: 'note:n1', url: 'https://a.com' }],
      },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'delete_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      load,
      CTX,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('effectOf: restore_note', () => {
  it('re-links, clears deleted, unorphans', async () => {
    const pageSlug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${pageSlug}`;
    const store = {
      'note:n1': { slug: 'n1', deleted: true, url: 'https://a.com' },
      [pageKey]: {
        slug: pageSlug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: [],
      },
      'manifest:orphaned': {
        timestamps: { 'test-device': 50 },
        entries: [{ key: 'note:n1', url: 'https://a.com' }],
      },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'restore_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      load,
      CTX,
    );
    expect(result[pageKey].childIds).toContain('note:n1');
    expect(result['note:n1'].deleted).toBe(false);
    expect(result['manifest:orphaned'].entries.map((e) => e.key)).not.toContain(
      'note:n1',
    );
  });
});

// ---------------------------------------------------------------------------
// effectOf: replace_note
// ---------------------------------------------------------------------------

describe('effectOf: replace_note', () => {
  const rpPageSlug = generateSlugFromUrl('https://a.com');
  const rpPageKey = `page:${rpPageSlug}`;

  it('unlinks old note, links new note on parent page', async () => {
    const store = {
      'note:n1': { slug: 'n1', excerpt: 'old text', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    // Old note unlinked from page
    expect(result[rpPageKey].childIds).not.toContain('note:n1');
    // New note linked to page
    expect(result[rpPageKey].childIds).toContain('note:n2');
  });

  it('marks old note as deleted with reason "replaced"', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['note:n1'].deleted).toBe(true);
    expect(result['note:n1'].deletionReason).toBe('replaced');
    expect(result['note:n1'].replacedBy).toBe('note:n2');
  });

  it('orphans old note', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['manifest:orphaned'].entries.map((e) => e.key)).toContain(
      'note:n1',
    );
  });

  it('transfers list pins from old note to new note', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:name-to-id': { paths: { 'test-device/Test': 'test-id' } },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        owner: 'test-device',
        pins: [{ id: 'note:n1', pinnedAt: 50 }],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    // Old note pin replaced with new note pin
    const pins = result['list:test-id'].pins;
    expect(pins.some((p) => p.id === 'note:n2')).toBe(true);
    expect(pins.some((p) => p.id === 'note:n1')).toBe(false);
  });

  it('copies url from old note to new note', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:name-to-id': { paths: { 'test-device/Test': 'test-id' } },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        owner: 'test-device',
        pins: [{ id: 'note:n1', pinnedAt: 50 }],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    // New note inherits url from old note
    expect(result['note:n2'].url).toBe('https://a.com');
  });

  it('proceeds even if old note is already deleted — both edits survive as siblings', async () => {
    const pageSlug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${pageSlug}`;
    const store = {
      'note:n1': {
        slug: 'n1',
        deleted: true,
        deletedTs: 50,
        url: 'https://a.com',
      },
      [pageKey]: {
        slug: pageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: [],
      },
      'manifest:orphaned': {
        entries: [{ key: 'note:n1', url: 'https://a.com' }],
      },
      'manifest:name-to-id': { paths: {} },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'replace_note',
        url: 'https://a.com',
        path: 'notes/n2.json',
        oldPath: 'notes/n1.json',
      },
      load,
      CTX,
    );
    // New note IS created (both edits survive as siblings)
    expect(result['note:n2']).toBeDefined();
    expect(result['note:n2'].url).toBe('https://a.com');
    // New note linked to page
    expect(result[pageKey].childIds).toContain('note:n2');
  });

  it('is idempotent (safe to replay twice)', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [rpPageKey]: {
        slug: rpPageSlug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:orphaned': { entries: [] },
      'manifest:name-to-id': { paths: {} },
    };
    const entry = {
      timestamp: 100,
      action: 'replace_note',
      url: 'https://a.com',
      path: 'notes/n2.json',
      oldPath: 'notes/n1.json',
    };
    const result1 = await effectOf(entry, makeLoad(store), CTX);

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
    const result2 = await effectOf(entry, load2, CTX);

    // Apply result2 to store2 for final state
    const store3 = { ...store2 };
    for (const [k, v] of Object.entries(result2)) {
      if (v === null) delete store3[k];
      else store3[k] = v;
    }

    // Final state converges: page has note:n2 (not n1), n1 is deleted, n2 has url
    expect(store3[rpPageKey].childIds).toContain('note:n2');
    expect(store3[rpPageKey].childIds).not.toContain('note:n1');
    expect(store3['note:n1'].deleted).toBe(true);
    expect(store3['note:n2'].url).toBe('https://a.com');
  });
});

// ---------------------------------------------------------------------------
// effectOf: delete_snapshot / restore_snapshot
// ---------------------------------------------------------------------------

describe('effectOf: delete_snapshot', () => {
  it('unlinks from page childIds, orphans', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        parentIds: ['list:some-list'],
        childIds: [`snapshot:${slug}-1000`],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`].childIds).not.toContain(
      `snapshot:${slug}-1000`,
    );
    expect(result['manifest:orphaned'].entries).toContainEqual({
      key: `snapshot:${slug}-1000`,
      url: 'https://a.com',
    });
  });
});

describe('effectOf: restore_snapshot', () => {
  it('re-links to page childIds, unorphans', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: [],
      },
      'manifest:orphaned': {
        timestamps: { 'test-device': 50 },
        entries: [{ key: `snapshot:${slug}-1000`, url: 'https://a.com' }],
      },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'restore_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`].childIds).toContain(`snapshot:${slug}-1000`);
    expect(result['manifest:orphaned'].entries.map((e) => e.key)).not.toContain(
      `snapshot:${slug}-1000`,
    );
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
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].pins).toHaveLength(1);
    expect(result['list:test-id'].pins[0].id).toBe(`page:${slug}`);
    expect(result[`page:${slug}`]).toBeTruthy();
    expect(result[`page:${slug}`].parentIds).toContain('list:test-id');
  });

  it('applies pin to deleted/orphaned list (preserved for restore)', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      'manifest:orphaned': { entries: [{ key: 'list:test-id' }] },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id']).toBeDefined();
    expect(result['list:test-id'].pins).toHaveLength(1);
    expect(result['list:test-id'].pins[0].id).toBe(`page:${slug}`);
  });

  it('applies title from entry.titles to newly-created page entity', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
        titles: { 'https://a.com': 'Page A Title' },
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('Page A Title');
  });

  it('does not overwrite existing title with entry.titles', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        title: 'Existing Title',
        parentIds: [],
        childIds: [],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
        titles: { 'https://a.com': 'New Title' },
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`].title).toBe('Existing Title');
  });

  it('skips null items without crashing', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: [null, 'https://a.com', null],
      },
      makeLoad(store),
      CTX,
    );
    const slug = generateSlugFromUrl('https://a.com');
    expect(result['list:test-id'].pins).toHaveLength(1);
    expect(result['list:test-id'].pins[0].id).toBe(`page:${slug}`);
  });

  it('deduplicates pins', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: ['list:test-id'],
        childIds: [],
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        pins: [{ id: `page:${slug}`, pinnedAt: 50 }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].pins).toHaveLength(1);
  });
});

describe('effectOf: unpin_from_list', () => {
  it('removes pin, GCs page with no other eligible criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: ['list:test-id'],
        childIds: [],
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        pins: [{ id: `page:${slug}`, pinnedAt: 50 }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'unpin_from_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].pins).toHaveLength(0);
    expect(result[`page:${slug}`]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effectOf: create_list
// ---------------------------------------------------------------------------

describe('effectOf: create_list', () => {
  it('creates list, updates name-map and tree manifest', async () => {
    const store = {
      'manifest:name-to-id': { paths: {} },
      'manifest:list-order': { tree: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_list',
        name: 'My List',
        listOwner: 'test-device',
      },
      makeLoad(store),
      CTX,
    );
    // Find the generated list ID
    const listKey = Object.keys(result).find((k) => k.startsWith('list:'));
    expect(listKey).toBeTruthy();
    const listId = listKey.replace('list:', '');
    expect(result[listKey]).toBeTruthy();
    expect(result[listKey].name).toBe('My List');
    expect(result[listKey].parentList).toBeUndefined();
    // Tree manifest should contain the new list as top-level node
    const tree = result['manifest:list-order'].tree;
    expect(tree.some((n) => n.id === listKey)).toBe(true);
    // Flat name-to-id
    expect(result['manifest:name-to-id'].paths['test-device/My List']).toBe(
      listId,
    );
    expect(result[listKey].owner).toBe('test-device');
  });

  it('creates nested list under parent', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_list',
        name: 'Child',
        listOwner: 'test-device',
        parentListId: 'test-id',
      },
      makeLoad(store),
      CTX,
    );
    const childKey = Object.keys(result).find(
      (k) => k.startsWith('list:') && k !== 'list:test-id',
    );
    expect(childKey).toBeTruthy();
    const childId = childKey.replace('list:', '');
    expect(result[childKey].parentList).toBeUndefined();
    // Tree manifest should have Child nested under Test
    const tree = result['manifest:list-order'].tree;
    const testNode = tree.find((n) => n.id === 'list:test-id');
    expect(testNode).toBeTruthy();
    expect(testNode.children.some((n) => n.id === childKey)).toBe(true);
    // Compound name-to-id
    expect(result['manifest:name-to-id'].paths['test-device/Child']).toBe(
      childId,
    );
  });

  it('uses provided listId when present (migrated events)', async () => {
    const store = {
      'manifest:name-to-id': { paths: {} },
      'manifest:list-order': { tree: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_list',
        name: 'Cinema',
        listOwner: 'test-device',
        listId: 'cinema-gfl1h7',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:cinema-gfl1h7']).toBeTruthy();
    expect(result['list:cinema-gfl1h7'].name).toBe('Cinema');
    const tree = result['manifest:list-order'].tree;
    expect(tree.some((n) => n.id === 'list:cinema-gfl1h7')).toBe(true);
    expect(result['manifest:name-to-id'].paths['test-device/Cinema']).toBe(
      'cinema-gfl1h7',
    );
  });
});

// ---------------------------------------------------------------------------
// effectOf: update_list
// ---------------------------------------------------------------------------

describe('effectOf: update_list', () => {
  it('renames list and updates flat name-map (no cascade)', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_list',
        listOwner: 'test-device',
        name: 'Test',
        newName: 'Renamed',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].name).toBe('Renamed');
    // Compound name-to-id: old name removed, new name added
    expect(result['manifest:name-to-id'].paths['test-device/Renamed']).toBe(
      'test-id',
    );
    expect(
      result['manifest:name-to-id'].paths['test-device/Test'],
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// effectOf: delete_list / restore_list
// ---------------------------------------------------------------------------

describe('effectOf: delete_list', () => {
  it('soft-deletes, removes from tree and name-map, orphans', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_list',
        listOwner: 'test-device',
        name: 'Test',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].deleted).toBe(true);
    // Removed from tree manifest
    const tree = result['manifest:list-order'].tree;
    expect(tree.some((n) => n.id === 'list:test-id')).toBe(false);
    // Removed from compound name-to-id
    expect(
      result['manifest:name-to-id'].paths['test-device/Test'],
    ).toBeUndefined();
    expect(result['manifest:orphaned'].entries.map((e) => e.key)).toContain(
      'list:test-id',
    );
    expect(result['list:test-id'].deletedTs).toBe(100);
  });

  it('noop if already deleted with deletedTs >= entry.timestamp', async () => {
    const store = listStore({
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        owner: 'test-device',
        deleted: true,
        deletedTs: 200,
        pins: [],
      },
    });
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      {
        timestamp: 200,
        action: 'delete_list',
        listOwner: 'test-device',
        name: 'Test',
      },
      load,
      CTX,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('promotes children when deleting a parent (non-cascading)', async () => {
    const store = listStore({
      'manifest:name-to-id': {
        paths: {
          'test-device/Test': 'test-id',
          'test-device/Child': 'child-id',
        },
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        owner: 'test-device',
        pins: [],
      },
      'list:child-id': {
        slug: 'child-id',
        name: 'Child',
        owner: 'test-device',
        pins: [],
      },
      'manifest:list-order': {
        tree: [{ id: 'list:test-id', children: [{ id: 'list:child-id' }] }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_list',
        listOwner: 'test-device',
        name: 'Test',
      },
      makeLoad(store),
      CTX,
    );
    // Parent is deleted
    expect(result['list:test-id'].deleted).toBe(true);
    // Child is NOT deleted (non-cascading)
    expect(result['list:child-id']).toBeUndefined();
    // Child is promoted to top-level in tree
    const tree = result['manifest:list-order'].tree;
    expect(tree.some((n) => n.id === 'list:child-id')).toBe(true);
    expect(tree.some((n) => n.id === 'list:test-id')).toBe(false);
    // Only parent removed from compound name-to-id
    expect(
      result['manifest:name-to-id'].paths['test-device/Test'],
    ).toBeUndefined();
    expect(result['manifest:name-to-id'].paths['test-device/Child']).toBe(
      'child-id',
    );
  });
});

describe('effectOf: restore_list', () => {
  it('restores to top-level in tree, re-adds to name-map, unorphans', async () => {
    const store = {
      'manifest:name-to-id': { paths: {} },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        owner: 'test-device',
        deleted: true,
        timestamps: { 'test-device': 50 },
        pins: [],
      },
      'manifest:list-order': { tree: [] },
      'manifest:orphaned': {
        timestamps: { 'test-device': 50 },
        entries: [{ key: 'list:test-id' }],
      },
    };
    const load = async (key, opts) => {
      const e = store[key] ?? null;
      if (!opts?.includeDeleted && e?.deleted) return null;
      return e;
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'restore_list',
        listOwner: 'test-device',
        name: 'Test',
      },
      load,
      CTX,
    );
    expect(result['list:test-id'].deleted).toBe(false);
    // Added to tree manifest as top-level
    const tree = result['manifest:list-order'].tree;
    expect(tree.some((n) => n.id === 'list:test-id')).toBe(true);
    // Compound name-to-id
    expect(result['manifest:name-to-id'].paths['test-device/Test']).toBe(
      'test-id',
    );
    expect(result['manifest:orphaned'].entries.map((e) => e.key)).not.toContain(
      'list:test-id',
    );
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
      existingParentIds.push(
        `page:${generateSlugFromUrl(`https://example.com/old-parent-${i}`)}`,
      );
    }
    const store = {
      [`page:${childSlug}`]: {
        slug: childSlug,
        url: 'https://example.com/child',
        title: 'Child',
        timestamps: { 'test-device': 50 },
        parentIds: existingParentIds,
        childIds: [],
      },
      'manifest:orphaned': { entries: [] },
    };
    const newParentUrl = 'https://example.com/new-parent-51';
    const newParentSlug = generateSlugFromUrl(newParentUrl);
    store[`page:${newParentSlug}`] = {
      slug: newParentSlug,
      url: newParentUrl,
      title: 'New Parent',
      timestamps: { 'test-device': 50 },
      parentIds: [],
      childIds: [],
    };

    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://example.com/child',
        title: 'Child',
        referrerUrl: newParentUrl,
      },
      makeLoad(store),
      CTX,
    );

    // parentIds should still be 50 (capped), with oldest evicted
    expect(result[`page:${childSlug}`].parentIds).toHaveLength(50);
    // Oldest parent (index 0) should be evicted
    expect(result[`page:${childSlug}`].parentIds).not.toContain(
      existingParentIds[0],
    );
    // New parent should be present
    expect(result[`page:${childSlug}`].parentIds).toContain(
      `page:${newParentSlug}`,
    );
  });

  it('caps childIds at 50 on referrer page', async () => {
    const parentSlug = generateSlugFromUrl('https://example.com/parent');
    const existingChildIds = [];
    for (let i = 0; i < 50; i++) {
      existingChildIds.push(
        `page:${generateSlugFromUrl(`https://example.com/old-child-${i}`)}`,
      );
    }
    const store = {
      [`page:${parentSlug}`]: {
        slug: parentSlug,
        url: 'https://example.com/parent',
        title: 'Parent',
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: existingChildIds,
      },
      'manifest:orphaned': { entries: [] },
    };
    const newChildUrl = 'https://example.com/new-child-51';
    const newChildSlug = generateSlugFromUrl(newChildUrl);
    store[`page:${newChildSlug}`] = {
      slug: newChildSlug,
      url: newChildUrl,
      title: 'New Child',
      timestamps: { 'test-device': 50 },
      parentIds: [],
      childIds: [],
    };

    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: newChildUrl,
        title: 'New Child',
        referrerUrl: 'https://example.com/parent',
      },
      makeLoad(store),
      CTX,
    );

    // childIds should still be 50 (capped), with oldest evicted
    expect(result[`page:${parentSlug}`].childIds).toHaveLength(50);
    // Oldest child (index 0) should be evicted
    expect(result[`page:${parentSlug}`].childIds).not.toContain(
      existingChildIds[0],
    );
    // New child should be present
    expect(result[`page:${parentSlug}`].childIds).toContain(
      `page:${newChildSlug}`,
    );
  });
});

// effectOf: update_list_tree
// ---------------------------------------------------------------------------

describe('effectOf: update_list_tree', () => {
  it('writes new tree structure (LWW)', async () => {
    const store = {
      'manifest:list-order': {
        tree: [{ id: 'list:a-id' }, { id: 'list:b-id' }],
      },
    };
    const newTree = [{ id: 'list:a-id', children: [{ id: 'list:b-id' }] }];
    const result = await effectOf(
      { timestamp: 100, action: 'update_list_tree', tree: newTree },
      makeLoad(store),
      CTX,
    );
    expect(result['manifest:list-order'].tree).toEqual(newTree);
    expect(result['manifest:list-order'].timestamps?.['test-device']).toBe(100);
  });

  it('skips if older than current tree timestamp (LWW)', async () => {
    const store = {
      'manifest:list-order': {
        timestamps: { 'test-device': 200 },
        tree: [{ id: 'list:a-id' }],
      },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_list_tree',
        tree: [{ id: 'list:b-id' }],
      },
      makeLoad(store),
      CTX,
    );
    // Stale event — no changes
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('does not modify name-to-id (tree-independent)', async () => {
    const store = {
      'manifest:list-order': {
        tree: [{ id: 'list:a-id' }, { id: 'list:b-id' }],
      },
      'manifest:name-to-id': {
        paths: { 'test-device/A': 'a-id', 'test-device/B': 'b-id' },
      },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_list_tree',
        tree: [{ id: 'list:a-id', children: [{ id: 'list:b-id' }] }],
      },
      makeLoad(store),
      CTX,
    );
    // name-to-id should NOT be in the result (not modified)
    expect(result['manifest:name-to-id']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isPageEligible
// ---------------------------------------------------------------------------

describe('isPageEligible', () => {
  it('returns true for page with list parent', () => {
    expect(
      isPageEligible({ slug: 's', parentIds: ['list:test-id'], childIds: [] }),
    ).toBe(true);
  });

  it('returns true for page with note child', () => {
    expect(
      isPageEligible({ slug: 's', parentIds: [], childIds: ['note:n1'] }),
    ).toBe(true);
  });

  it('returns true for page with snapshot child', () => {
    expect(
      isPageEligible({
        slug: 's',
        parentIds: [],
        childIds: ['snapshot:s-100'],
      }),
    ).toBe(true);
  });

  it('returns true for page with user_title', () => {
    expect(
      isPageEligible({
        slug: 's',
        parentIds: [],
        childIds: [],
        user_title: 'My Title',
      }),
    ).toBe(true);
  });

  it('returns true for page with likes', () => {
    expect(
      isPageEligible({ slug: 's', parentIds: [], childIds: [], likes: 2 }),
    ).toBe(true);
  });

  it('returns false for visit-only page', () => {
    expect(
      isPageEligible({
        slug: 's',
        parentIds: [],
        childIds: [],
        visitDates: [20260314],
      }),
    ).toBe(false);
  });

  it('returns false for page with only page:* parents (referrers)', () => {
    expect(
      isPageEligible({ slug: 's', parentIds: ['page:other'], childIds: [] }),
    ).toBe(false);
  });

  it('returns false for page with only page:* children (referrer links)', () => {
    expect(
      isPageEligible({ slug: 's', parentIds: [], childIds: ['page:other'] }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on unpin_from_list
// ---------------------------------------------------------------------------

describe('effectOf: page GC on unpin_from_list', () => {
  it('GCs page when last list parent removed and no other criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: ['list:test-id'],
        childIds: [],
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        pins: [{ id: `page:${slug}`, pinnedAt: 50 }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'unpin_from_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('keeps page when it still has note children after unpin', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: ['list:test-id'],
        childIds: ['note:n1'],
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        pins: [{ id: `page:${slug}`, pinnedAt: 50 }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'unpin_from_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].parentIds).not.toContain('list:test-id');
  });

  it('keeps page when it has user_title after unpin', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = listStore({
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        url: 'https://a.com',
        parentIds: ['list:test-id'],
        childIds: [],
        user_title: 'Custom',
      },
      'list:test-id': {
        slug: 'test-id',
        name: 'Test',
        pins: [{ id: `page:${slug}`, pinnedAt: 50 }],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'unpin_from_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].user_title).toBe('Custom');
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on delete_note
// ---------------------------------------------------------------------------

describe('effectOf: page GC on delete_note', () => {
  const gcPageSlug = generateSlugFromUrl('https://a.com');
  const gcPageKey = `page:${gcPageSlug}`;

  it('GCs parent page when note was last eligible criterion', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [gcPageKey]: {
        slug: gcPageSlug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: ['note:n1'],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    expect(result[gcPageKey]).toBeNull();
  });

  it('keeps parent page when it has other eligible criteria', async () => {
    const store = {
      'note:n1': { slug: 'n1', url: 'https://a.com' },
      [gcPageKey]: {
        slug: gcPageSlug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: ['note:n1'],
        user_title: 'Kept',
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_note',
        url: 'https://a.com',
        path: 'notes/n1.json',
      },
      makeLoad(store),
      CTX,
    );
    expect(result[gcPageKey]).not.toBeNull();
    expect(result[gcPageKey].childIds).not.toContain('note:n1');
  });
});

// ---------------------------------------------------------------------------
// effectOf: page GC on delete_snapshot
// ---------------------------------------------------------------------------

describe('effectOf: page GC on delete_snapshot', () => {
  it('GCs parent page when snapshot was last eligible criterion', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        parentIds: [],
        childIds: [`snapshot:${slug}-1000`],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`]).toBeNull();
  });

  it('keeps parent page when it has other eligible criteria', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const store = {
      [`page:${slug}`]: {
        slug,
        timestamps: { 'test-device': 50 },
        parentIds: ['list:some-list'],
        childIds: [`snapshot:${slug}-1000`],
      },
      'manifest:orphaned': { entries: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'delete_snapshot',
        url: 'https://a.com',
        path: `snapshots/${slug}-1000`,
      },
      makeLoad(store),
      CTX,
    );
    expect(result[`page:${slug}`]).not.toBeNull();
    expect(result[`page:${slug}`].childIds).not.toContain(
      `snapshot:${slug}-1000`,
    );
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
        listOwner: 'test-device',
        name: 'Test',
        rule: {
          type: 'keyword',
          config: { pattern: 'test', fields: ['title'] },
        },
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id']).toBeTruthy();
    expect(result['list:test-id'].rules).toHaveLength(1);
    expect(result['list:test-id'].rules[0].type).toBe('keyword');
    expect(result['list:test-id'].rules[0].config.pattern).toBe('test');
    expect(result['list:test-id'].rules[0].id).toMatch(/^rule-k-/);
    expect(result['list:test-id'].timestamps?.['test-device']).toBe(100);
  });

  it('is idempotent — replaying same entry does not duplicate', async () => {
    const ruleId = 'rule-k-abc-1234';
    const store = listStore({
      'list:test-id': {
        timestamps: { 'test-device': 50 },
        slug: 'test-id',
        name: 'Test',
        pins: [],
        rules: [
          {
            id: ruleId,
            type: 'keyword',
            config: { pattern: 'test' },
            createdAt: 50,
          },
        ],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        listOwner: 'test-device',
        name: 'Test',
        rule: { type: 'keyword', config: { pattern: 'test' }, id: ruleId },
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].rules).toHaveLength(1);
  });

  it('applies rule to deleted/orphaned list (preserved for restore)', async () => {
    const store = listStore({
      'manifest:orphaned': { entries: [{ key: 'list:test-id' }] },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        listOwner: 'test-device',
        name: 'Test',
        rule: { type: 'keyword', config: { pattern: 'test' } },
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id']).toBeDefined();
    expect(result['list:test-id'].rules).toHaveLength(1);
  });

  it('returns empty result for unknown list', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'add_rule',
        listOwner: 'test-device',
        name: 'NonExistent',
        rule: { type: 'keyword', config: { pattern: 'test' } },
      },
      makeLoad(store),
      CTX,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('effectOf: remove_rule', () => {
  it('removes a rule from a list', async () => {
    const store = listStore({
      'list:test-id': {
        timestamps: { 'test-device': 50 },
        slug: 'test-id',
        name: 'Test',
        pins: [],
        rules: [
          {
            id: 'rule-k-abc-1234',
            type: 'keyword',
            config: { pattern: 'test' },
            createdAt: 50,
          },
        ],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'remove_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
    expect(result['list:test-id'].timestamps?.['test-device']).toBe(100);
  });

  it('is idempotent — removing non-existent rule is no-op', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'remove_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-nonexistent',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
  });

  it('applies remove_rule to deleted/orphaned list (preserved for restore)', async () => {
    const store = listStore({
      'manifest:orphaned': { entries: [{ key: 'list:test-id' }] },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'remove_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id']).toBeDefined();
    expect(result['list:test-id'].rules).toHaveLength(0);
  });
});

describe('effectOf: update_rule', () => {
  it('merges config for matching rule', async () => {
    const store = listStore({
      'list:test-id': {
        timestamps: { 'test-device': 50 },
        slug: 'test-id',
        name: 'Test',
        pins: [],
        rules: [
          {
            id: 'rule-k-abc-1234',
            type: 'keyword',
            config: { pattern: 'old', fields: ['title'] },
            createdAt: 50,
          },
        ],
      },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
        config: { pattern: 'new' },
      },
      makeLoad(store),
      CTX,
    );
    const rule = result['list:test-id'].rules[0];
    expect(rule.config.pattern).toBe('new');
    expect(rule.config.fields).toEqual(['title']); // preserved
    expect(rule.createdAt).toBe(50); // preserved
    expect(result['list:test-id'].timestamps?.['test-device']).toBe(100);
  });

  it('is idempotent — updating non-existent rule leaves list unchanged', async () => {
    const store = listStore();
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-nonexistent',
        config: { pattern: 'test' },
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].rules).toHaveLength(0);
  });

  it('applies update_rule to deleted/orphaned list (preserved for restore)', async () => {
    const store = listStore({
      'manifest:orphaned': { entries: [{ key: 'list:test-id' }] },
    });
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'update_rule',
        listOwner: 'test-device',
        name: 'Test',
        ruleId: 'rule-k-abc-1234',
        config: { pattern: 'test' },
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id']).toBeDefined();
    expect(result['list:test-id'].rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// effectOf: Math.max timestamp preservation
// ---------------------------------------------------------------------------

describe('effectOf: Math.max timestamp', () => {
  it('visit_page preserves higher existing timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = {
      slug,
      timestamps: { 'test-device': 500 },
      url: 'https://a.com',
      parentIds: [],
      childIds: [],
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'visit_page',
        url: 'https://a.com',
        title: 'A',
      },
      makeLoad({ [`page:${slug}`]: page }),
      CTX,
    );
    expect(result[`page:${slug}`].timestamps?.['test-device']).toBe(500);
  });

  it('leave_page preserves higher existing timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = {
      slug,
      timestamps: { 'test-device': 500 },
      parentIds: [],
      childIds: [],
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'leave_page',
        url: 'https://a.com',
        title: 'B',
      },
      makeLoad({ [`page:${slug}`]: page }),
      CTX,
    );
    expect(result[`page:${slug}`].timestamps?.['test-device']).toBe(500);
  });

  it('rename_page preserves higher existing timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = {
      slug,
      timestamps: { 'test-device': 500 },
      url: 'https://a.com',
      parentIds: [],
      childIds: [],
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'rename_page',
        url: 'https://a.com',
        user_title: 'Renamed',
      },
      makeLoad({ [`page:${slug}`]: page }),
      CTX,
    );
    expect(result[`page:${slug}`].timestamps?.['test-device']).toBe(500);
  });

  it('rate_page preserves higher existing timestamp', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const page = {
      slug,
      timestamps: { 'test-device': 500 },
      url: 'https://a.com',
      parentIds: [],
      childIds: [],
    };
    const result = await effectOf(
      { timestamp: 100, action: 'rate_page', url: 'https://a.com', likes: 1 },
      makeLoad({ [`page:${slug}`]: page }),
      CTX,
    );
    expect(result[`page:${slug}`].timestamps?.['test-device']).toBe(500);
  });

  it('pin_to_list preserves higher existing list timestamp', async () => {
    const store = listStore();
    store['list:test-id'].timestamps = { 'test-device': 500 };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'pin_to_list',
        listOwner: 'test-device',
        name: 'Test',
        items: ['https://a.com'],
      },
      makeLoad(store),
      CTX,
    );
    expect(result['list:test-id'].timestamps?.['test-device']).toBe(500);
  });

  it('update_setting preserves higher existing timestamp', async () => {
    const result = await effectOf(
      { timestamp: 100, action: 'update_setting', key: 'theme', value: 'dark' },
      makeLoad({ 'manifest:settings': { timestamps: { 'test-device': 500 } } }),
      CTX,
    );
    expect(result['manifest:settings'].timestamps?.['test-device']).toBe(500);
  });

  it('create_list preserves higher existing manifest timestamps', async () => {
    const store = {
      'manifest:name-to-id': { timestamps: { 'test-device': 500 }, paths: {} },
      'manifest:list-order': { timestamps: { 'test-device': 500 }, tree: [] },
    };
    const result = await effectOf(
      {
        timestamp: 100,
        action: 'create_list',
        listOwner: 'test-device',
        name: 'NewList',
      },
      makeLoad(store),
      CTX,
    );
    expect(result['manifest:name-to-id'].timestamps?.['test-device']).toBe(500);
    expect(result['manifest:list-order'].timestamps?.['test-device']).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// effectOf: sync mode — commutativity tests (sync-plan.md §11)
// ---------------------------------------------------------------------------

// Replay helper: apply events sequentially to a store copy
async function replay(events, baseStore, contexts) {
  const s = JSON.parse(JSON.stringify(baseStore));
  for (let i = 0; i < events.length; i++) {
    const ctx = Array.isArray(contexts) ? contexts[i] : contexts;
    const effects = await effectOf(events[i], makeLoad(s), ctx);
    Object.assign(s, effects);
  }
  return s;
}

// Generate all permutations of an array
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

// Assert that replaying events in all orderings produces the same value for a key
async function assertConverges(events, baseStore, ctx, key, assertFn) {
  const perms = permutations(events);
  const states = [];
  for (const perm of perms) {
    states.push(await replay(perm, baseStore, ctx));
  }
  for (let i = 1; i < states.length; i++) {
    assertFn(
      states[i][key],
      states[0][key],
      `ordering ${i} diverged from ordering 0`,
    );
  }
  return states[0];
}

// Shared note base store for note commutativity tests
function noteBaseStore() {
  const slug = generateSlugFromUrl('https://a.com');
  return {
    'note:n1': {
      slug: 'n1',
      url: 'https://a.com',
      excerpt: 'ex',
      note: 'text',
      cssPath: '',
    },
    [`page:${slug}`]: {
      slug,
      url: 'https://a.com',
      parentIds: [],
      childIds: ['note:n1'],
    },
    'manifest:orphaned': { entries: [] },
    'manifest:name-to-id': { paths: {} },
  };
}

describe('effectOf: sync commutativity — §11.1 note edit conflicts', () => {
  it('T1: two devices edit same note — both new notes survive', async () => {
    const base = noteBaseStore();
    // Add note:n1 file data so replace_note can load it
    base['note:newY'] = null;
    base['note:newZ'] = null;
    const events = [
      {
        timestamp: 10,
        action: 'replace_note',
        path: 'notes/newY.json',
        oldPath: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'replace_note',
        path: 'notes/newZ.json',
        oldPath: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;

    const stateA = await replay(events, base, CTX);
    const stateB = await replay([events[1], events[0]], base, CTX);

    // Both orders: Y and Z linked to page, n1 orphaned
    for (const state of [stateA, stateB]) {
      const page = state[pageKey];
      expect(page.childIds).toContain('note:newY');
      expect(page.childIds).toContain('note:newZ');
      expect(state['note:n1'].deleted).toBe(true);
    }
  });

  it('T2: one device edits, other deletes same note — edit creates Y regardless', async () => {
    const base = noteBaseStore();
    const events = [
      {
        timestamp: 10,
        action: 'replace_note',
        path: 'notes/newY.json',
        oldPath: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'delete_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;

    const stateA = await replay(events, base, CTX);
    const stateB = await replay([events[1], events[0]], base, CTX);

    for (const state of [stateA, stateB]) {
      expect(state['note:newY']).toBeDefined();
      expect(state['note:newY'].url).toBe('https://a.com');
      expect(state[pageKey].childIds).toContain('note:newY');
      expect(state['note:n1'].deleted).toBe(true);
    }
  });

  it('T3: delete then edit (edit is newer) — same result as T2', async () => {
    const base = noteBaseStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'replace_note',
        path: 'notes/newY.json',
        oldPath: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;

    const stateA = await replay(events, base, CTX);
    const stateB = await replay([events[1], events[0]], base, CTX);

    for (const state of [stateA, stateB]) {
      expect(state['note:newY']).toBeDefined();
      expect(state['note:n1'].deleted).toBe(true);
    }
  });
});

describe('effectOf: sync commutativity — §11.2 note delete/restore', () => {
  it('T4: delete(10) + restore(20) — restore wins, both orders', async () => {
    const base = noteBaseStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'restore_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'note:n1',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.deletedTs, msg).toBe(b.deletedTs);
      },
    );
    expect(state['note:n1'].deleted).toBe(false);
    expect(state['note:n1'].deletedTs).toBe(20);
  });

  it('T5: restore(10) + delete(20) — delete wins, both orders', async () => {
    const base = noteBaseStore();
    // Start with note already deleted so restore has something to restore
    base['note:n1'].deleted = true;
    base['note:n1'].deletedTs = 5;
    base['manifest:orphaned'].entries = [
      { key: 'note:n1', url: 'https://a.com' },
    ];
    const slug = generateSlugFromUrl('https://a.com');
    base[`page:${slug}`].childIds = [];
    const events = [
      {
        timestamp: 10,
        action: 'restore_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'delete_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'note:n1',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.deletedTs, msg).toBe(b.deletedTs);
      },
    );
    expect(state['note:n1'].deleted).toBe(true);
    expect(state['note:n1'].deletedTs).toBe(20);
  });
});

describe('effectOf: sync commutativity — §11.3 list delete/restore', () => {
  it('T6: delete(10) + restore(20) — restore wins, both orders', async () => {
    const base = listStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'restore_list',
        name: 'Test',
        listOwner: 'test-device',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.deletedTs, msg).toBe(b.deletedTs);
      },
    );
    expect(state['list:test-id'].deleted).toBe(false);
    expect(state['list:test-id'].deletedTs).toBe(20);
  });

  it('T7: restore(10) + delete(20) — delete wins, both orders', async () => {
    const base = listStore();
    base['list:test-id'].deleted = true;
    base['list:test-id'].deletedTs = 5;
    base['manifest:orphaned'].entries = [{ key: 'list:test-id' }];
    base['manifest:name-to-id'].paths = {};
    base['manifest:list-order'].tree = [];
    const events = [
      {
        timestamp: 10,
        action: 'restore_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.deletedTs, msg).toBe(b.deletedTs);
      },
    );
    expect(state['list:test-id'].deleted).toBe(true);
    expect(state['list:test-id'].deletedTs).toBe(20);
  });
});

describe('effectOf: sync commutativity — §11.4 pin to deleted list', () => {
  it('T8: pin to concurrently deleted list — pin applies to deleted entity', async () => {
    const base = listStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'pin_to_list',
        name: 'Test',
        listOwner: 'test-device',
        items: ['https://a.com'],
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.pins.length, msg).toBe(b.pins.length);
        expect(a.deleted, msg).toBe(b.deleted);
      },
    );
    expect(state['list:test-id'].deleted).toBe(true);
    expect(state['list:test-id'].pins.length).toBe(1);
  });

  it('T9: pin(10) + delete(20) + restore(30) — all 6 orderings converge', async () => {
    const base = listStore();
    const events = [
      {
        timestamp: 10,
        action: 'pin_to_list',
        name: 'Test',
        listOwner: 'test-device',
        items: ['https://a.com'],
      },
      {
        timestamp: 20,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 30,
        action: 'restore_list',
        name: 'Test',
        listOwner: 'test-device',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.pins.length, msg).toBe(b.pins.length);
      },
    );
    expect(state['list:test-id'].deleted).toBe(false);
    expect(state['list:test-id'].pins.length).toBe(1);
  });

  it('T10: unpin from deleted list — unpin applies', async () => {
    const base = listStore();
    const slug = generateSlugFromUrl('https://a.com');
    base['list:test-id'].pins = [{ id: `page:${slug}`, pinnedAt: 5 }];
    base[`page:${slug}`] = {
      slug,
      url: 'https://a.com',
      parentIds: ['list:test-id'],
      childIds: [],
    };
    const events = [
      {
        timestamp: 10,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'unpin_from_list',
        name: 'Test',
        listOwner: 'test-device',
        items: ['https://a.com'],
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.pins.length, msg).toBe(b.pins.length);
      },
    );
    expect(state['list:test-id'].pins.length).toBe(0);
  });
});

describe('effectOf: sync commutativity — §11.5 list tree structure', () => {
  it('T11: two tree updates — newer wins via LWW, both orders', async () => {
    const base = {
      'manifest:list-order': { tree: [] },
      'manifest:name-to-id': { paths: {} },
      'manifest:orphaned': { entries: [] },
    };
    const events = [
      {
        timestamp: 10,
        action: 'update_list_tree',
        tree: [{ id: 'list:a' }, { id: 'list:b' }],
      },
      {
        timestamp: 20,
        action: 'update_list_tree',
        tree: [
          { id: 'list:c', children: [{ id: 'list:a' }] },
          { id: 'list:b' },
        ],
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'manifest:list-order',
      (a, b, msg) => {
        expect(JSON.stringify(a.tree), msg).toBe(JSON.stringify(b.tree));
      },
    );
    expect(state['manifest:list-order'].tree[0].id).toBe('list:c');
  });

  it('T21: create_list appends to tree manifest', async () => {
    const base = {
      'manifest:name-to-id': { paths: {} },
      'manifest:list-order': { tree: [] },
    };
    const result = await effectOf(
      {
        timestamp: 10,
        action: 'create_list',
        name: 'NewList',
        listOwner: 'test-device',
      },
      makeLoad(base),
      CTX,
    );
    const tree = result['manifest:list-order'].tree;
    expect(tree.length).toBe(1);
    expect(tree[0].id).toMatch(/^list:/);
  });

  it('T12: tree update + create_list — both orders include all lists', async () => {
    const base = {
      'manifest:name-to-id': {
        paths: { 'test-device/A': 'a-id', 'test-device/B': 'b-id' },
      },
      'manifest:list-order': {
        tree: [{ id: 'list:a-id' }, { id: 'list:b-id' }],
      },
      'manifest:orphaned': { entries: [] },
      'list:a-id': { slug: 'a-id', name: 'A', owner: 'test-device', pins: [] },
      'list:b-id': { slug: 'b-id', name: 'B', owner: 'test-device', pins: [] },
    };
    const events = [
      {
        timestamp: 10,
        action: 'update_list_tree',
        tree: [{ id: 'list:a-id' }, { id: 'list:b-id' }],
      },
      {
        timestamp: 20,
        action: 'create_list',
        name: 'C',
        listOwner: 'test-device',
      },
    ];

    // Helper: collect all IDs from a tree
    function collectTreeIds(nodes) {
      const ids = new Set();
      for (const n of nodes) {
        ids.add(n.id);
        if (n.children)
          for (const id of collectTreeIds(n.children)) ids.add(id);
      }
      return ids;
    }

    const stateA = await replay(events, base, CTX);
    const stateB = await replay([events[1], events[0]], base, CTX);
    const idsA = collectTreeIds(stateA['manifest:list-order'].tree);
    const idsB = collectTreeIds(stateB['manifest:list-order'].tree);
    // Both orders should include A, B, and the new list C
    expect(idsA.has('list:a-id')).toBe(true);
    expect(idsA.has('list:b-id')).toBe(true);
    expect(idsA.size).toBe(3); // A, B, C
    expect(idsB.has('list:a-id')).toBe(true);
    expect(idsB.has('list:b-id')).toBe(true);
    expect(idsB.size).toBe(3);
  });

  it('T13: tree update + delete_list — both orders remove deleted list', async () => {
    const base = {
      'manifest:name-to-id': {
        paths: {
          'test-device/A': 'a-id',
          'test-device/B': 'b-id',
          'test-device/C': 'c-id',
        },
      },
      'manifest:list-order': {
        tree: [
          { id: 'list:a-id', children: [{ id: 'list:b-id' }] },
          { id: 'list:c-id' },
        ],
      },
      'manifest:orphaned': { entries: [] },
      'list:a-id': { slug: 'a-id', name: 'A', owner: 'test-device', pins: [] },
      'list:b-id': { slug: 'b-id', name: 'B', owner: 'test-device', pins: [] },
      'list:c-id': { slug: 'c-id', name: 'C', owner: 'test-device', pins: [] },
    };
    const events = [
      {
        timestamp: 10,
        action: 'update_list_tree',
        tree: [
          { id: 'list:a-id', children: [{ id: 'list:b-id' }] },
          { id: 'list:c-id' },
        ],
      },
      {
        timestamp: 20,
        action: 'delete_list',
        name: 'B',
        listOwner: 'test-device',
      },
    ];

    function collectTreeIds(nodes) {
      const ids = new Set();
      for (const n of nodes) {
        ids.add(n.id);
        if (n.children)
          for (const id of collectTreeIds(n.children)) ids.add(id);
      }
      return ids;
    }

    const stateA = await replay(events, base, CTX);
    const stateB = await replay([events[1], events[0]], base, CTX);
    const idsA = collectTreeIds(stateA['manifest:list-order'].tree);
    const idsB = collectTreeIds(stateB['manifest:list-order'].tree);
    // B should be removed from tree in both orders
    expect(idsA.has('list:b-id')).toBe(false);
    expect(idsA.has('list:a-id')).toBe(true);
    expect(idsA.has('list:c-id')).toBe(true);
    expect(idsB.has('list:b-id')).toBe(false);
    expect(idsB.has('list:a-id')).toBe(true);
    expect(idsB.has('list:c-id')).toBe(true);
  });

  it('T18: create + tree update + delete — all 6 orderings reconcile', async () => {
    const base = {
      'manifest:name-to-id': {
        paths: { 'test-device/A': 'a-id', 'test-device/B': 'b-id' },
      },
      'manifest:list-order': {
        tree: [{ id: 'list:a-id' }, { id: 'list:b-id' }],
      },
      'manifest:orphaned': { entries: [] },
      'list:a-id': { slug: 'a-id', name: 'A', owner: 'test-device', pins: [] },
      'list:b-id': { slug: 'b-id', name: 'B', owner: 'test-device', pins: [] },
    };
    const events = [
      {
        timestamp: 10,
        action: 'create_list',
        name: 'C',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'update_list_tree',
        tree: [{ id: 'list:a-id', children: [{ id: 'list:b-id' }] }],
      },
      {
        timestamp: 30,
        action: 'delete_list',
        name: 'A',
        listOwner: 'test-device',
      },
    ];

    function collectTreeIds(nodes) {
      const ids = new Set();
      for (const n of nodes) {
        ids.add(n.id);
        if (n.children)
          for (const id of collectTreeIds(n.children)) ids.add(id);
      }
      return ids;
    }

    // All 6 orderings should converge: B and C in tree, A removed
    const perms = permutations(events);
    const results = [];
    for (const perm of perms) {
      results.push(await replay(perm, base, CTX));
    }
    for (const state of results) {
      const ids = collectTreeIds(state['manifest:list-order'].tree);
      expect(ids.has('list:a-id')).toBe(false);
      expect(ids.has('list:b-id')).toBe(true);
      // C was created — find its key
      const cKey = Object.keys(state).find(
        (k) => k.startsWith('list:') && state[k]?.name === 'C',
      );
      expect(cKey).toBeDefined();
      expect(ids.has(cKey)).toBe(true);
    }
  });
});

describe('effectOf: sync commutativity — §11.6 additive fields', () => {
  it('T14: two devices rate same page — both orders produce same likes', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;
    const base = {
      [pageKey]: {
        slug,
        url: 'https://a.com',
        parentIds: [],
        childIds: [],
        likes: 0,
        timestamps: {},
      },
    };
    const events = [
      { timestamp: 10, action: 'rate_page', url: 'https://a.com', likes: 1 },
      { timestamp: 20, action: 'rate_page', url: 'https://a.com', likes: 1 },
    ];
    // Different device contexts per event
    const ctxs = [{ deviceId: 'deviceA' }, { deviceId: 'deviceB' }];
    const stateA = await replay(events, base, ctxs);
    const stateB = await replay([events[1], events[0]], base, [
      ctxs[1],
      ctxs[0],
    ]);
    expect(stateA[pageKey].likes).toBe(2);
    expect(stateB[pageKey].likes).toBe(2);
  });

  it('T15: same device rate replayed twice — no double-count', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;
    const base = {
      [pageKey]: {
        slug,
        url: 'https://a.com',
        parentIds: [],
        childIds: [],
        likes: 0,
        timestamps: {},
      },
    };
    const entry = {
      timestamp: 10,
      action: 'rate_page',
      url: 'https://a.com',
      likes: 1,
    };
    const state = await replay([entry, entry], base, { deviceId: 'deviceA' });
    expect(state[pageKey].likes).toBe(1);
  });

  it('leave_page per-device timeOnPage — both orders accumulate', async () => {
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;
    const base = {
      [pageKey]: {
        slug,
        parentIds: [],
        childIds: [],
        timeOnPage: 0,
        timestamps: {},
      },
    };
    const events = [
      {
        timestamp: 10,
        action: 'leave_page',
        url: 'https://a.com',
        timeOnPage: 5000,
      },
      {
        timestamp: 20,
        action: 'leave_page',
        url: 'https://a.com',
        timeOnPage: 3000,
      },
    ];
    const ctxs = [{ deviceId: 'deviceA' }, { deviceId: 'deviceB' }];
    const stateA = await replay(events, base, ctxs);
    const stateB = await replay([events[1], events[0]], base, [
      ctxs[1],
      ctxs[0],
    ]);
    expect(stateA[pageKey].timeOnPage).toBe(8000);
    expect(stateB[pageKey].timeOnPage).toBe(8000);
  });
});

describe('effectOf: sync commutativity — §11.7 mixed multi-operation', () => {
  it('T16: replace + delete + restore note — all 6 orderings converge', async () => {
    const base = noteBaseStore();
    const events = [
      {
        timestamp: 10,
        action: 'replace_note',
        path: 'notes/newY.json',
        oldPath: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 20,
        action: 'delete_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
      {
        timestamp: 30,
        action: 'restore_note',
        path: 'notes/n1.json',
        url: 'https://a.com',
      },
    ];
    const slug = generateSlugFromUrl('https://a.com');
    const pageKey = `page:${slug}`;
    const state = await assertConverges(
      events,
      base,
      CTX,
      'note:n1',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.deletedTs, msg).toBe(b.deletedTs);
      },
    );
    // restore(30) > delete(20): n1 alive
    expect(state['note:n1'].deleted).toBe(false);
    expect(state['note:n1'].deletedTs).toBe(30);
    // Y also exists (replace created it independently)
    expect(state['note:newY']).toBeDefined();
  });

  it('T17: delete(10) + pin(20) + restore(30) list — all 6 orderings converge', async () => {
    const base = listStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'pin_to_list',
        name: 'Test',
        listOwner: 'test-device',
        items: ['https://a.com'],
      },
      {
        timestamp: 30,
        action: 'restore_list',
        name: 'Test',
        listOwner: 'test-device',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect(a.pins.length, msg).toBe(b.pins.length);
      },
    );
    expect(state['list:test-id'].deleted).toBe(false);
    expect(state['list:test-id'].pins.length).toBe(1);
  });
});

describe('effectOf: sync commutativity — §11.8 implementation correctness', () => {
  it('T20: rules on deleted list preserved for restore — all 6 orderings', async () => {
    const base = listStore();
    const events = [
      {
        timestamp: 10,
        action: 'delete_list',
        name: 'Test',
        listOwner: 'test-device',
      },
      {
        timestamp: 20,
        action: 'add_rule',
        name: 'Test',
        listOwner: 'test-device',
        rule: { type: 'keyword', config: { pattern: 'test' } },
      },
      {
        timestamp: 30,
        action: 'restore_list',
        name: 'Test',
        listOwner: 'test-device',
      },
    ];
    const state = await assertConverges(
      events,
      base,
      CTX,
      'list:test-id',
      (a, b, msg) => {
        expect(a.deleted, msg).toBe(b.deleted);
        expect((a.rules || []).length, msg).toBe((b.rules || []).length);
      },
    );
    expect(state['list:test-id'].deleted).toBe(false);
    expect(state['list:test-id'].rules.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isStaleByLWW
// ---------------------------------------------------------------------------

describe('isStaleByLWW', () => {
  it('returns false when entity has no deletedTs', () => {
    expect(isStaleByLWW({ slug: 'x' }, 100)).toBe(false);
  });

  it('returns false when entity is null/undefined', () => {
    expect(isStaleByLWW(null, 100)).toBe(false);
    expect(isStaleByLWW(undefined, 100)).toBe(false);
  });

  it('returns true when deletedTs equals entry timestamp', () => {
    expect(isStaleByLWW({ deletedTs: 100 }, 100)).toBe(true);
  });

  it('returns true when deletedTs is greater than entry timestamp', () => {
    expect(isStaleByLWW({ deletedTs: 200 }, 100)).toBe(true);
  });

  it('returns false when deletedTs is less than entry timestamp', () => {
    expect(isStaleByLWW({ deletedTs: 50 }, 100)).toBe(false);
  });

  it('returns false when deletedTs is 0 (falsy)', () => {
    expect(isStaleByLWW({ deletedTs: 0 }, 100)).toBe(false);
  });
});
