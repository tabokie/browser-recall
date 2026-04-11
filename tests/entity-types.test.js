import { describe, it, expect } from 'vitest';
import {
  PAGE_PREFIX,
  NOTE_PREFIX,
  SNAPSHOT_PREFIX,
  LIST_PREFIX,
  MANIFEST_PREFIX,
  pageKey,
  noteKey,
  listKey,
  snapshotKey,
  entityPrefix,
  entitySlug,
  isSystemList,
  entityTypeLabel,
} from '../extension/entity-types.js';

describe('prefix constants', () => {
  it('have correct values', () => {
    expect(PAGE_PREFIX).toBe('page:');
    expect(NOTE_PREFIX).toBe('note:');
    expect(SNAPSHOT_PREFIX).toBe('snapshot:');
    expect(LIST_PREFIX).toBe('list:');
    expect(MANIFEST_PREFIX).toBe('manifest:');
  });
});

describe('key constructors', () => {
  it('pageKey builds page:slug', () => {
    expect(pageKey('example-abc123')).toBe('page:example-abc123');
  });

  it('noteKey builds note:slug', () => {
    expect(noteKey('hl-abc')).toBe('note:hl-abc');
  });

  it('listKey builds list:id', () => {
    expect(listKey('abc-123')).toBe('list:abc-123');
  });

  it('snapshotKey builds snapshot:stem', () => {
    expect(snapshotKey('example-abc123-1700000000000')).toBe(
      'snapshot:example-abc123-1700000000000',
    );
  });
});

describe('entityPrefix', () => {
  it('returns prefix for page keys', () => {
    expect(entityPrefix('page:some-slug')).toBe('page:');
  });

  it('returns prefix for note keys', () => {
    expect(entityPrefix('note:hl-abc')).toBe('note:');
  });

  it('returns prefix for snapshot keys', () => {
    expect(entityPrefix('snapshot:slug-123')).toBe('snapshot:');
  });

  it('returns prefix for list keys', () => {
    expect(entityPrefix('list:abc')).toBe('list:');
  });

  it('returns prefix for manifest keys', () => {
    expect(entityPrefix('manifest:settings')).toBe('manifest:');
  });

  it('returns null for unknown keys', () => {
    expect(entityPrefix('workspace')).toBeNull();
    expect(entityPrefix('unknown:foo')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(entityPrefix('')).toBeNull();
  });
});

describe('entitySlug', () => {
  it('strips page prefix', () => {
    expect(entitySlug('page:my-slug')).toBe('my-slug');
  });

  it('strips note prefix', () => {
    expect(entitySlug('note:hl-abc')).toBe('hl-abc');
  });

  it('strips list prefix', () => {
    expect(entitySlug('list:abc-123')).toBe('abc-123');
  });

  it('strips snapshot prefix', () => {
    expect(entitySlug('snapshot:slug-123')).toBe('slug-123');
  });

  it('strips manifest prefix', () => {
    expect(entitySlug('manifest:settings')).toBe('settings');
  });

  it('returns key as-is for unknown prefix', () => {
    expect(entitySlug('workspace')).toBe('workspace');
  });
});

describe('isSystemList', () => {
  it('returns true for system list keys', () => {
    expect(isSystemList('list:system/workspace')).toBe(true);
    expect(isSystemList('list:system/trash')).toBe(true);
  });

  it('returns false for regular list keys', () => {
    expect(isSystemList('list:abc-123')).toBe(false);
  });

  it('returns false for non-list keys', () => {
    expect(isSystemList('page:system/foo')).toBe(false);
  });
});

describe('entityTypeLabel (existing)', () => {
  it('returns correct labels', () => {
    expect(entityTypeLabel('snapshot:foo')).toBe('Snapshot');
    expect(entityTypeLabel('note:bar')).toBe('Note');
    expect(entityTypeLabel('list:baz')).toBe('List');
    expect(entityTypeLabel('page:qux')).toBe('Page');
    expect(entityTypeLabel('unknown:x')).toBe('Unknown');
  });
});
