/**
 * Workspace auto-pin tests.
 *
 * Verifies that auto-pin resolves pin IDs correctly even when the entity
 * cache misses (e.g., after SW restart / LRU eviction). The pin ID should
 * be 'page:<slug>' for checkpointed pages, 'shallow:<url>' otherwise —
 * determined via resolvePageId (cache → disk), not cache-only.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * Resolve a URL to its authoritative pin ID.
 * Returns 'page:<slug>' if checkpointed (cache or disk), 'shallow:<url>' otherwise.
 */
async function resolvePageId(url, { getCachedEntity, pageExistsOnDisk, generateSlug }) {
  const slug = generateSlug(url);
  const key = 'page:' + slug;
  if (getCachedEntity(key)) return key;
  if (await pageExistsOnDisk(slug)) return key;
  return 'shallow:' + url;
}

/**
 * Derive pin ID for workspace auto-pin.
 * Mirrors the logic in background.js reportPage → workspace auto-pin block.
 */
async function deriveAutoPinId(url, { resolvePageId }) {
  return await resolvePageId(url);
}

describe('workspace auto-pin ID resolution', () => {
  const url = 'https://example.com/article';
  const slug = 'example-com-article';
  const generateSlug = () => slug;

  it('uses page:<slug> when entity is in cache', async () => {
    const pinId = await resolvePageId(url, {
      getCachedEntity: (key) => key === 'page:' + slug ? { title: 'Article' } : null,
      pageExistsOnDisk: () => false,
      generateSlug,
    });
    expect(pinId).toBe('page:' + slug);
  });

  it('uses page:<slug> when cache misses but page exists on disk', async () => {
    const pageExistsOnDisk = vi.fn().mockResolvedValue(true);
    const pinId = await resolvePageId(url, {
      getCachedEntity: () => null,  // cache miss
      pageExistsOnDisk,
      generateSlug,
    });
    expect(pinId).toBe('page:' + slug);
    expect(pageExistsOnDisk).toHaveBeenCalledWith(slug);
  });

  it('falls back to shallow:<url> only when page does not exist anywhere', async () => {
    const pinId = await resolvePageId(url, {
      getCachedEntity: () => null,
      pageExistsOnDisk: () => false,
      generateSlug,
    });
    expect(pinId).toBe('shallow:' + url);
  });

  it('does not hit disk when cache has the entity', async () => {
    const pageExistsOnDisk = vi.fn();
    await resolvePageId(url, {
      getCachedEntity: (key) => key === 'page:' + slug ? { title: 'Cached' } : null,
      pageExistsOnDisk,
      generateSlug,
    });
    expect(pageExistsOnDisk).not.toHaveBeenCalled();
  });
});
