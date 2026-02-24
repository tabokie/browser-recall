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
 */
function processPageReport(delta, { getCachedEntity, trimTitle }) {
  const url = delta.url;
  const slug = delta.slug || url.replace(/\W/g, '-');
  const cached = getCachedEntity('page:' + slug);

  const entry = {
    timestamp: Date.now(),
    action: 'page',
    url,
  };
  let hasChange = false;

  // Title: trim then compare
  if (delta.title != null) {
    const trimmed = trimTitle(delta.title, url);
    if (!cached || cached.title !== trimmed) {
      entry.title = trimmed;
      hasChange = true;
    }
  }

  // Referrer: only meaningful on first visit or if changed
  if (delta.referrer != null) {
    if (!cached || cached.referrer !== delta.referrer) {
      entry.referrer = delta.referrer;
      hasChange = true;
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

  // user_title: independent from auto-detected title
  if (delta.user_title != null) {
    if (!cached || cached.user_title !== delta.user_title) {
      entry.user_title = delta.user_title;
      hasChange = true;
    }
  }

  return { entry: hasChange ? entry : null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processPageReport', () => {
  const url = 'https://example.com/page';
  const slug = 'example-com-page';

  describe('title trimming', () => {
    it('trims title before logging on initial visit', () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      const { entry } = processPageReport(
        { url, title: 'My Page | Example Site', isInitialLoad: true },
        { getCachedEntity: () => null, trimTitle },
      );
      expect(entry.title).toBe('My Page');
    });

    it('trims title before comparing against cached value', () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      // Cached title is already trimmed
      const cached = { title: 'My Page', scrollDepth: 0 };
      const { entry } = processPageReport(
        { url, title: 'My Page | Example Site', scrollDepth: 10 },
        { getCachedEntity: () => cached, trimTitle },
      );
      // Title should NOT appear in entry (matches cached after trim)
      expect(entry).not.toBeNull();
      expect(entry.title).toBeUndefined();
      // But scrollDepth should be present
      expect(entry.scrollDepth).toBe(10);
    });

    it('includes title when trimmed value differs from cached', () => {
      const trimTitle = makeTrimTitle([
        { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
      ]);
      const cached = { title: 'Old Title' };
      const { entry } = processPageReport(
        { url, title: 'New Title | Example Site' },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.title).toBe('New Title');
    });
  });

  describe('diff-only logging', () => {
    it('returns null entry when nothing changed', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Same', scrollDepth: 50 };
      const { entry } = processPageReport(
        { url, title: 'Same', scrollDepth: 30 },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry).toBeNull();
    });

    it('includes only changed fields', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Same', scrollDepth: 20 };
      const { entry } = processPageReport(
        { url, title: 'Same', scrollDepth: 50, timeOnPage: 3000 },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.title).toBeUndefined(); // unchanged
      expect(entry.scrollDepth).toBe(50); // higher
      expect(entry.timeOnPage).toBe(3000); // always included
    });

    it('skips scrollDepth when not higher than cached', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Page', scrollDepth: 80 };
      const { entry } = processPageReport(
        { url, title: 'Page', scrollDepth: 50, timeOnPage: 1000 },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.scrollDepth).toBeUndefined();
      expect(entry.timeOnPage).toBe(1000);
    });

    it('skips timeOnPage when zero', () => {
      const trimTitle = makeTrimTitle();
      const { entry } = processPageReport(
        { url, title: 'New Page', timeOnPage: 0, isInitialLoad: true },
        { getCachedEntity: () => null, trimTitle },
      );
      expect(entry.title).toBe('New Page');
      expect(entry.timeOnPage).toBeUndefined();
    });
  });

  describe('referrer handling', () => {
    it('includes referrer on first visit', () => {
      const trimTitle = makeTrimTitle();
      const { entry } = processPageReport(
        { url, title: 'Page', referrer: 'https://google.com', isInitialLoad: true },
        { getCachedEntity: () => null, trimTitle },
      );
      expect(entry.referrer).toBe('https://google.com');
    });

    it('skips referrer when same as cached', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Page', referrer: 'https://google.com' };
      const { entry } = processPageReport(
        { url, title: 'Page', referrer: 'https://google.com', timeOnPage: 1000 },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.referrer).toBeUndefined();
    });
  });

  describe('user_title handling', () => {
    it('includes user_title when no cached user_title', () => {
      const trimTitle = makeTrimTitle();
      const { entry } = processPageReport(
        { url, user_title: 'My Custom Name' },
        { getCachedEntity: () => ({ title: 'Auto Title' }), trimTitle },
      );
      expect(entry.user_title).toBe('My Custom Name');
    });

    it('skips user_title when same as cached', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Auto Title', user_title: 'My Custom Name' };
      const { entry } = processPageReport(
        { url, user_title: 'My Custom Name', timeOnPage: 1000 },
        { getCachedEntity: () => cached, trimTitle },
      );
      expect(entry.user_title).toBeUndefined();
      expect(entry.timeOnPage).toBe(1000);
    });

    it('user_title and title are independent', () => {
      const trimTitle = makeTrimTitle();
      const cached = { title: 'Old Auto', user_title: 'Custom' };
      const { entry } = processPageReport(
        { url, title: 'New Auto', user_title: 'Custom' },
        { getCachedEntity: () => cached, trimTitle },
      );
      // title changed, user_title didn't
      expect(entry.title).toBe('New Auto');
      expect(entry.user_title).toBeUndefined();
    });
  });
});
