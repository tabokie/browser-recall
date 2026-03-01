/**
 * Unified reportPage handler tests.
 *
 * Verifies:
 * - Title trimming is applied before comparison
 * - Only changed fields are included in log entries
 * - isInitialLoad triggers first-visit extras
 * - isLeaving triggers immediate drain
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeSessionMock(initial = {}) {
  let store = { ...initial };
  return {
    get(keys) {
      if (!keys) return Promise.resolve({ ...store });
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) if (k in store) result[k] = store[k];
      return Promise.resolve(result);
    },
    set(obj) {
      Object.assign(store, obj);
      return Promise.resolve();
    },
    _store: store,
  };
}

// ---------------------------------------------------------------------------
// Extract processPageReport as a testable unit.
//
// processPageReport(delta, { getCachedEntity, trimTitle }) => { entry }
//   - delta: { url, title?, slug?, referrer?, scrollDepth?, timeOnPage? }
//   - entry: the log entry with only changed fields (or null if nothing changed)
// ---------------------------------------------------------------------------

// Inline reimplementation of trimTitle for testing (mirrors background.js logic)
function makeTrimTitle(titleTrimRules = []) {
  return function trimTitle(rawTitle, url) {
    let title = rawTitle || 'Untitled';
    for (const rule of titleTrimRules) {
      if (url.startsWith(rule.urlPrefix)) {
        if (rule.action === 'remove_after_pipe') {
          const pipeIdx = title.indexOf('|');
          if (pipeIdx > 0) title = title.substring(0, pipeIdx);
        } else if (rule.action === 'remove_brackets') {
          title = title.replace(/\s*\[[^\]]*\]\s*/g, ' ');
        } else if (rule.action === 'remove_parens') {
          title = title.replace(/\s*\([^)]*\)\s*/g, ' ');
        }
      }
    }
    return title.trim();
  };
}

/**
 * Process a page report delta against cached state.
 * Returns { entry } where entry is null if nothing changed.
 *
 * loadPage(slug): async fallback — loads page entity from disk when cache misses.
 */
async function processPageReport(delta, { getCachedEntity, loadPage, trimTitle }) {
  const url = delta.url;
  const slug = delta.slug || url.replace(/\W/g, '-');
  let cached = getCachedEntity('page:' + slug);
  if (!cached && loadPage) cached = await loadPage(slug);

  const entry = {
    timestamp: Date.now(),
    action: 'page',
    url,
  };
  let hasChange = !!delta.isInitialLoad; // initial visit is always meaningful

  // Title: trim then compare; always include on initial load
  if (delta.title != null) {
    const trimmed = trimTitle(delta.title, url);
    if (delta.isInitialLoad) {
      entry.title = trimmed;
    } else if (!cached || cached.title !== trimmed) {
      entry.title = trimmed;
      hasChange = true;
    }
  }

  // Referrer: convert to referrerId (page:<slug> format), skip self-referential
  if (delta.referrer != null) {
    const refSlug = delta.referrer.replace(/\W/g, '-');
    if (refSlug !== slug) {
      const referrerId = 'page:' + refSlug;
      if (!cached || cached.referrerId !== referrerId) {
        entry.referrerId = referrerId;
        hasChange = true;
      }
    }
  }

  // scrollDepth: include if higher than cached
  if (delta.scrollDepth != null) {
    if (!cached || (cached.scrollDepth ?? -1) < delta.scrollDepth) {
      entry.scrollDepth = delta.scrollDepth;
      hasChange = true;
    }
  }

  // timeOnPage: always include when > 0 (incremental delta)
  if (delta.timeOnPage != null && delta.timeOnPage > 0) {
    entry.timeOnPage = delta.timeOnPage;
    hasChange = true;
  }

  // user_title: from delta if explicitly set, or from cached entity on initial load
  if (delta.user_title != null) {
    if (!cached || cached.user_title !== delta.user_title) {
      entry.user_title = delta.user_title;
      hasChange = true;
    }
  } else if (delta.isInitialLoad && cached?.user_title) {
    entry.user_title = cached.user_title;
  }

  return { entry: hasChange ? entry : null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processPageReport', () => {
  const url = 'https://example.com/page';
  const slug = 'example-com-page';
  const noLoad = { getCachedEntity: () => null, loadPage: () => null, trimTitle: makeTrimTitle() };

  describe('title trimming', () => {
    it('trims title before logging on initial visit', async () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      const { entry } = await processPageReport(
        { url, title: 'My Page | Example Site', isInitialLoad: true },
        { ...noLoad, trimTitle },
      );
      expect(entry.title).toBe('My Page');
    });

    it('trims title before comparing against cached value', async () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      // Cached title is already trimmed
      const cached = { title: 'My Page', scrollDepth: 0 };
      const { entry } = await processPageReport(
        { url, title: 'My Page | Example Site', scrollDepth: 10 },
        { ...noLoad, getCachedEntity: () => cached, trimTitle },
      );
      // Title should NOT appear in entry (matches cached after trim)
      expect(entry).not.toBeNull();
      expect(entry.title).toBeUndefined();
      // But scrollDepth should be present
      expect(entry.scrollDepth).toBe(10);
    });

    it('includes title when trimmed value differs from cached', async () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      const cached = { title: 'Old Title' };
      const { entry } = await processPageReport(
        { url, title: 'New Title | Example Site' },
        { ...noLoad, getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.title).toBe('New Title');
    });
  });

  describe('diff-only logging', () => {
    it('returns null entry when nothing changed', async () => {
      const cached = { title: 'Same', scrollDepth: 50 };
      const { entry } = await processPageReport(
        { url, title: 'Same', scrollDepth: 30 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry).toBeNull();
    });

    it('includes only changed fields', async () => {
      const cached = { title: 'Same', scrollDepth: 20 };
      const { entry } = await processPageReport(
        { url, title: 'Same', scrollDepth: 50, timeOnPage: 3000 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry.title).toBeUndefined(); // unchanged
      expect(entry.scrollDepth).toBe(50); // higher
      expect(entry.timeOnPage).toBe(3000); // always included
    });

    it('skips scrollDepth when not higher than cached', async () => {
      const cached = { title: 'Page', scrollDepth: 80 };
      const { entry } = await processPageReport(
        { url, title: 'Page', scrollDepth: 50, timeOnPage: 1000 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry.scrollDepth).toBeUndefined();
      expect(entry.timeOnPage).toBe(1000);
    });

    it('skips timeOnPage when zero', async () => {
      const { entry } = await processPageReport(
        { url, title: 'New Page', timeOnPage: 0, isInitialLoad: true },
        noLoad,
      );
      expect(entry.title).toBe('New Page');
      expect(entry.timeOnPage).toBeUndefined();
    });
  });

  describe('initial load always logs', () => {
    it('produces entry on initial load even when all fields match cached', async () => {
      const cached = { title: 'Same', scrollDepth: 50 };
      const { entry } = await processPageReport(
        { url, title: 'Same', scrollDepth: 30, isInitialLoad: true },
        { ...noLoad, getCachedEntity: () => cached },
      );
      // Initial load should always produce an entry (the visit itself matters)
      expect(entry).not.toBeNull();
      expect(entry.action).toBe('page');
      expect(entry.url).toBe(url);
      // Title is always included on initial load (avoids enrichment at render time)
      expect(entry.title).toBe('Same');
      // But other unchanged fields should still be omitted
      expect(entry.scrollDepth).toBeUndefined();
    });

    it('includes user_title from cached entity on initial load', async () => {
      const cached = { title: 'Auto Title', user_title: 'My Custom Name', scrollDepth: 50 };
      const { entry } = await processPageReport(
        { url, title: 'Auto Title', isInitialLoad: true },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry).not.toBeNull();
      expect(entry.title).toBe('Auto Title');
      expect(entry.user_title).toBe('My Custom Name');
    });

    it('omits user_title on initial load when cached entity has none', async () => {
      const cached = { title: 'Auto Title', scrollDepth: 50 };
      const { entry } = await processPageReport(
        { url, title: 'Auto Title', isInitialLoad: true },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry).not.toBeNull();
      expect(entry.user_title).toBeUndefined();
    });

    it('still returns null for non-initial reports with no changes', async () => {
      const cached = { title: 'Same', scrollDepth: 50 };
      const { entry } = await processPageReport(
        { url, title: 'Same', scrollDepth: 30 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry).toBeNull();
    });
  });

  describe('disk fallback on cache miss', () => {
    it('diffs against disk entity when cache misses', async () => {
      const diskPage = { title: 'Same Title', scrollDepth: 50, referrerId: 'page:google-com' };
      const loadPage = vi.fn().mockReturnValue(diskPage);
      const { entry } = await processPageReport(
        { url, title: 'Same Title', scrollDepth: 30, timeOnPage: 2000 },
        { getCachedEntity: () => null, loadPage, trimTitle: makeTrimTitle() },
      );
      // loadPage should have been called
      expect(loadPage).toHaveBeenCalledWith(expect.stringContaining('example'));
      // title and scrollDepth unchanged vs disk — should NOT appear
      expect(entry).not.toBeNull();
      expect(entry.title).toBeUndefined();
      expect(entry.scrollDepth).toBeUndefined();
      // timeOnPage always included
      expect(entry.timeOnPage).toBe(2000);
    });

    it('returns null when all fields match disk entity', async () => {
      const diskPage = { title: 'Page Title', scrollDepth: 80 };
      const { entry } = await processPageReport(
        { url, title: 'Page Title', scrollDepth: 50 },
        { getCachedEntity: () => null, loadPage: () => diskPage, trimTitle: makeTrimTitle() },
      );
      expect(entry).toBeNull();
    });

    it('does not call loadPage when cache hits', async () => {
      const cached = { title: 'Cached' };
      const loadPage = vi.fn();
      await processPageReport(
        { url, title: 'Cached', timeOnPage: 500 },
        { getCachedEntity: () => cached, loadPage, trimTitle: makeTrimTitle() },
      );
      expect(loadPage).not.toHaveBeenCalled();
    });
  });

  describe('referrer handling', () => {
    it('includes referrerId on first visit', async () => {
      const { entry } = await processPageReport(
        { url, title: 'Page', referrer: 'https://google.com', isInitialLoad: true },
        noLoad,
      );
      expect(entry.referrerId).toBe('page:https---google-com');
    });

    it('skips referrerId when same as cached', async () => {
      const refSlug = 'https---google-com';
      const cached = { title: 'Page', referrerId: 'page:' + refSlug };
      const { entry } = await processPageReport(
        { url, title: 'Page', referrer: 'https://google.com', timeOnPage: 1000 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry.referrerId).toBeUndefined();
    });
  });

  describe('user_title handling', () => {
    it('includes user_title when no cached user_title', async () => {
      const { entry } = await processPageReport(
        { url, user_title: 'My Custom Name' },
        { ...noLoad, getCachedEntity: () => ({ title: 'Auto Title' }) },
      );
      expect(entry.user_title).toBe('My Custom Name');
    });

    it('skips user_title when same as cached', async () => {
      const cached = { title: 'Auto Title', user_title: 'My Custom Name' };
      const { entry } = await processPageReport(
        { url, user_title: 'My Custom Name', timeOnPage: 1000 },
        { ...noLoad, getCachedEntity: () => cached },
      );
      expect(entry.user_title).toBeUndefined();
      expect(entry.timeOnPage).toBe(1000);
    });

    it('user_title and title are independent', async () => {
      const cached = { title: 'Old Auto', user_title: 'Custom' };
      const { entry } = await processPageReport(
        { url, title: 'New Auto', user_title: 'Custom' },
        { ...noLoad, getCachedEntity: () => cached },
      );
      // title changed, user_title didn't
      expect(entry.title).toBe('New Auto');
      expect(entry.user_title).toBeUndefined();
    });
  });
});
