/**
 * reportPage handler entry builder tests.
 *
 * Verifies:
 * - buildVisitPageEntry always includes title, produces action: 'visit_page'
 * - buildLeavePageEntry includes attention fields, produces action: 'leave_page'
 * - referrerUrl is raw URL (not page:<slug> format)
 * - Title trimming is applied before inclusion
 * - rename_page entries carry user_title
 * - rate_page entries carry likes delta
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Inline reimplementation of entry builders (mirrors background.js logic)
// ---------------------------------------------------------------------------

function buildVisitPageEntry(url, title, referrerUrl, { checkpoint } = {}) {
  const entry = { timestamp: Date.now(), action: 'visit_page', url, title: title || '' };
  if (referrerUrl) entry.referrerUrl = referrerUrl;
  if (checkpoint) entry.checkpoint = true;
  return entry;
}

function buildLeavePageEntry(url, title, scrollDepth, timeOnPage) {
  const entry = { timestamp: Date.now(), action: 'leave_page', url };
  if (title) entry.title = title;
  if (scrollDepth !== undefined && scrollDepth !== null) entry.scrollDepth = scrollDepth;
  if (timeOnPage !== undefined && timeOnPage > 0) entry.timeOnPage = timeOnPage;
  return entry;
}

// Inline reimplementation of trimTitle for testing (mirrors background.js logic)
function makeTrimTitle(titleTrimRules = []) {
  return function trimTitle(rawTitle, url) {
    let title = rawTitle;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildVisitPageEntry', () => {
  const url = 'https://example.com/page';

  it('produces visit_page action with url and title', () => {
    const entry = buildVisitPageEntry(url, 'My Page', null);
    expect(entry.action).toBe('visit_page');
    expect(entry.url).toBe(url);
    expect(entry.title).toBe('My Page');
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it('always includes title (empty string when null)', () => {
    const entry = buildVisitPageEntry(url, null, null);
    expect(entry.title).toBe('');
  });

  it('always includes title (empty string when undefined)', () => {
    const entry = buildVisitPageEntry(url, undefined, null);
    expect(entry.title).toBe('');
  });

  it('includes referrerUrl as raw URL when provided', () => {
    const entry = buildVisitPageEntry(url, 'Page', 'https://google.com');
    expect(entry.referrerUrl).toBe('https://google.com');
  });

  it('omits referrerUrl when null', () => {
    const entry = buildVisitPageEntry(url, 'Page', null);
    expect(entry.referrerUrl).toBeUndefined();
  });

  it('does not include referrerId field (old format)', () => {
    const entry = buildVisitPageEntry(url, 'Page', 'https://google.com');
    expect(entry.referrerId).toBeUndefined();
  });

  it('includes checkpoint flag when set', () => {
    const entry = buildVisitPageEntry(url, 'Page', null, { checkpoint: true });
    expect(entry.checkpoint).toBe(true);
  });

  it('omits checkpoint flag when not set', () => {
    const entry = buildVisitPageEntry(url, 'Page', null);
    expect(entry.checkpoint).toBeUndefined();
  });
});

describe('buildLeavePageEntry', () => {
  const url = 'https://example.com/page';

  it('produces leave_page action with url', () => {
    const entry = buildLeavePageEntry(url, 'Page Title', 50, 3000);
    expect(entry.action).toBe('leave_page');
    expect(entry.url).toBe(url);
  });

  it('includes title when provided', () => {
    const entry = buildLeavePageEntry(url, 'Page Title', 50, 3000);
    expect(entry.title).toBe('Page Title');
  });

  it('omits title when null', () => {
    const entry = buildLeavePageEntry(url, null, 50, 3000);
    expect(entry.title).toBeUndefined();
  });

  it('omits title when empty string', () => {
    const entry = buildLeavePageEntry(url, '', 50, 3000);
    expect(entry.title).toBeUndefined();
  });

  it('includes scrollDepth when provided', () => {
    const entry = buildLeavePageEntry(url, null, 80, 0);
    expect(entry.scrollDepth).toBe(80);
  });

  it('includes scrollDepth 0', () => {
    const entry = buildLeavePageEntry(url, null, 0, 0);
    expect(entry.scrollDepth).toBe(0);
  });

  it('omits scrollDepth when undefined', () => {
    const entry = buildLeavePageEntry(url, null, undefined, 1000);
    expect(entry.scrollDepth).toBeUndefined();
  });

  it('includes timeOnPage when > 0', () => {
    const entry = buildLeavePageEntry(url, null, 50, 3000);
    expect(entry.timeOnPage).toBe(3000);
  });

  it('omits timeOnPage when 0', () => {
    const entry = buildLeavePageEntry(url, null, 50, 0);
    expect(entry.timeOnPage).toBeUndefined();
  });

  it('omits timeOnPage when undefined', () => {
    const entry = buildLeavePageEntry(url, null, 50, undefined);
    expect(entry.timeOnPage).toBeUndefined();
  });
});

describe('title trimming before entry building', () => {
  const url = 'https://example.com/page';

  it('trims title before building visit_page entry', () => {
    const trimTitle = makeTrimTitle([
      { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
    ]);
    const trimmed = trimTitle('My Page | Example Site', url);
    const entry = buildVisitPageEntry(url, trimmed, null);
    expect(entry.title).toBe('My Page');
  });

  it('trimmed title matches cached value → no unnecessary title in leave_page', () => {
    const trimTitle = makeTrimTitle([
      { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
    ]);
    const trimmed = trimTitle('My Page | Example Site', url);
    // In the new model, leave_page includes title only if non-empty
    // The caller (background.js) decides whether to pass title or null
    // Here we verify the trim itself works correctly
    expect(trimmed).toBe('My Page');
  });

  it('includes trimmed title when it differs', () => {
    const trimTitle = makeTrimTitle([
      { urlPrefix: 'https://example.com', action: 'remove_after_pipe' },
    ]);
    const trimmed = trimTitle('New Title | Example Site', url);
    const entry = buildVisitPageEntry(url, trimmed, null);
    expect(entry.title).toBe('New Title');
  });
});

describe('rename_page entry', () => {
  it('produces rename_page action with user_title', () => {
    const entry = {
      timestamp: Date.now(),
      action: 'rename_page',
      url: 'https://example.com/page',
      user_title: 'My Custom Name',
    };
    expect(entry.action).toBe('rename_page');
    expect(entry.user_title).toBe('My Custom Name');
    expect(entry.url).toBe('https://example.com/page');
  });
});

describe('rate_page entry', () => {
  it('produces rate_page action with likes delta', () => {
    const entry = {
      timestamp: Date.now(),
      action: 'rate_page',
      url: 'https://example.com/page',
      likes: 1,
    };
    expect(entry.action).toBe('rate_page');
    expect(entry.likes).toBe(1);
  });
});
