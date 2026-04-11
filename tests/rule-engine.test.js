/**
 * Rule engine module unit tests.
 *
 * Tests pure functions for rule validation, matching, and ID generation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RULE_TYPES,
  generateRuleId,
  validateRuleConfig,
  validateFnRuleSource,
  matchKeywordRule,
  matchRules,
  buildPageDataFromEntry,
} from '../extension/rule-engine.js';

// ---------------------------------------------------------------------------
// generateRuleId
// ---------------------------------------------------------------------------

describe('generateRuleId', () => {
  it('produces correct format: rule-<type[0]>-<base36_ts>-<4char>', () => {
    const id = generateRuleId('keyword', 1710000000000);
    expect(id).toMatch(/^rule-k-[a-z0-9]+-[a-z0-9]{4}$/);
  });

  it('uses first char of type', () => {
    expect(generateRuleId('keyword', 1000)).toMatch(/^rule-k-/);
    expect(generateRuleId('function', 1000)).toMatch(/^rule-f-/);
  });

  it('encodes timestamp in base36', () => {
    const ts = 1710000000000;
    const id = generateRuleId('keyword', ts);
    const parts = id.split('-');
    expect(parts[2]).toBe(ts.toString(36));
  });

  it('generates unique IDs for same timestamp', () => {
    const a = generateRuleId('keyword', 1000);
    const b = generateRuleId('keyword', 1000);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// validateRuleConfig
// ---------------------------------------------------------------------------

describe('validateRuleConfig', () => {
  describe('keyword rules', () => {
    it('accepts valid keyword config', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: 'test', fields: ['title'] },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects missing pattern', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { fields: ['title'] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('pattern'))).toBe(true);
    });

    it('rejects empty pattern', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: '', fields: ['title'] },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid fields', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: 'test', fields: ['body'] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('fields'))).toBe(true);
    });

    it('defaults fields to title+url when not specified', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: 'test' },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts regex pattern delimited by slashes', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: '/test\\d+/', fields: ['title'] },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid regex pattern', () => {
      const result = validateRuleConfig({
        type: 'keyword',
        config: { pattern: '/[invalid(/', fields: ['title'] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('regex'))).toBe(true);
    });
  });

  describe('function rules', () => {
    it('accepts valid function config', () => {
      const result = validateRuleConfig({
        type: 'function',
        config: {
          description: 'pages with long titles',
          fnSource: 'return page.title.length > 50;',
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects missing fnSource', () => {
      const result = validateRuleConfig({
        type: 'function',
        config: { description: 'test' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('fnSource'))).toBe(true);
    });

    it('rejects missing description', () => {
      const result = validateRuleConfig({
        type: 'function',
        config: { fnSource: 'return 1;' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('description'))).toBe(true);
    });
  });

  it('rejects unknown rule type', () => {
    const result = validateRuleConfig({ type: 'unknown', config: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('type'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSmartRuleFn
// ---------------------------------------------------------------------------

describe('validateFnRuleSource', () => {
  it('accepts clean function source', () => {
    const result = validateFnRuleSource(
      'return page.title.length > 50 ? 1 : 0;',
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects fetch usage', () => {
    const result = validateFnRuleSource(
      'return fetch("http://evil.com").then(() => 1);',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('fetch'))).toBe(true);
  });

  it('rejects chrome API usage', () => {
    const result = validateFnRuleSource(
      'chrome.storage.local.get("key"); return 1;',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('chrome'))).toBe(true);
  });

  it('rejects window usage', () => {
    const result = validateFnRuleSource('window.location.href; return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects document usage', () => {
    const result = validateFnRuleSource('document.cookie; return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects eval usage', () => {
    const result = validateFnRuleSource('eval("alert(1)"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects Function constructor', () => {
    const result = validateFnRuleSource(
      'new Function("return 1")(); return 1;',
    );
    expect(result.valid).toBe(false);
  });

  it('rejects globalThis', () => {
    const result = validateFnRuleSource('globalThis.fetch("x"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects setTimeout', () => {
    const result = validateFnRuleSource('setTimeout(() => {}, 0); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects setInterval', () => {
    const result = validateFnRuleSource(
      'setInterval(() => {}, 1000); return 1;',
    );
    expect(result.valid).toBe(false);
  });

  it('rejects WebSocket', () => {
    const result = validateFnRuleSource(
      'new WebSocket("ws://evil.com"); return 1;',
    );
    expect(result.valid).toBe(false);
  });

  it('rejects Worker', () => {
    const result = validateFnRuleSource('new Worker("evil.js"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects localStorage', () => {
    const result = validateFnRuleSource('localStorage.getItem("x"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects sessionStorage', () => {
    const result = validateFnRuleSource(
      'sessionStorage.getItem("x"); return 1;',
    );
    expect(result.valid).toBe(false);
  });

  it('rejects indexedDB', () => {
    const result = validateFnRuleSource('indexedDB.open("x"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects importScripts', () => {
    const result = validateFnRuleSource('importScripts("evil.js"); return 1;');
    expect(result.valid).toBe(false);
  });

  it('rejects navigator', () => {
    const result = validateFnRuleSource(
      'navigator.sendBeacon("/log", "data"); return 1;',
    );
    expect(result.valid).toBe(false);
  });

  it('rejects source >10KB', () => {
    const bigSource = 'return 1;' + ' '.repeat(11000);
    const result = validateFnRuleSource(bigSource);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('10KB') || e.includes('10240')),
    ).toBe(true);
  });

  it('allows page property access', () => {
    const result = validateFnRuleSource(
      'if (page.url.includes("github.com")) return 1; return 0;',
    );
    expect(result.valid).toBe(true);
  });

  it('does not false-positive on substrings', () => {
    // "fetchResults" contains "fetch" as substring — should NOT trigger
    const result = validateFnRuleSource(
      'const fetchResults = page.title.length; return fetchResults > 10 ? 1 : 0;',
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchKeywordRule
// ---------------------------------------------------------------------------

describe('matchKeywordRule', () => {
  it('matches substring in title', () => {
    const rule = { config: { pattern: 'hello', fields: ['title'] } };
    expect(
      matchKeywordRule(rule, {
        title: 'say hello world',
        url: 'https://x.com',
      }),
    ).toBe(1);
  });

  it('matches substring in url', () => {
    const rule = { config: { pattern: 'github', fields: ['url'] } };
    expect(
      matchKeywordRule(rule, { title: 'Repo', url: 'https://github.com/foo' }),
    ).toBe(1);
  });

  it('returns 0 on no match', () => {
    const rule = { config: { pattern: 'xyz', fields: ['title'] } };
    expect(
      matchKeywordRule(rule, { title: 'hello world', url: 'https://x.com' }),
    ).toBe(0);
  });

  it('matches case-insensitively by default', () => {
    const rule = { config: { pattern: 'HELLO', fields: ['title'] } };
    expect(matchKeywordRule(rule, { title: 'hello world', url: '' })).toBe(1);
  });

  it('respects caseSensitive flag', () => {
    const rule = {
      config: { pattern: 'HELLO', fields: ['title'], caseSensitive: true },
    };
    expect(matchKeywordRule(rule, { title: 'hello world', url: '' })).toBe(0);
    expect(matchKeywordRule(rule, { title: 'HELLO world', url: '' })).toBe(1);
  });

  it('checks both title and url when fields has both', () => {
    const rule = { config: { pattern: 'match', fields: ['title', 'url'] } };
    expect(
      matchKeywordRule(rule, { title: 'no', url: 'https://match.com' }),
    ).toBe(1);
    expect(
      matchKeywordRule(rule, { title: 'match here', url: 'https://x.com' }),
    ).toBe(1);
  });

  it('defaults fields to title+url when not specified', () => {
    const rule = { config: { pattern: 'found' } };
    expect(
      matchKeywordRule(rule, { title: 'not here', url: 'https://found.com' }),
    ).toBe(1);
  });

  it('handles regex pattern', () => {
    const rule = { config: { pattern: '/test\\d+/', fields: ['title'] } };
    expect(matchKeywordRule(rule, { title: 'test123 page', url: '' })).toBe(1);
    expect(matchKeywordRule(rule, { title: 'test page', url: '' })).toBe(0);
  });

  it('handles regex with case-insensitive flag', () => {
    const rule = { config: { pattern: '/TEST/', fields: ['title'] } };
    // Regex without caseSensitive should still be case-insensitive by default
    expect(matchKeywordRule(rule, { title: 'test page', url: '' })).toBe(1);
  });

  it('returns 0 for invalid regex gracefully', () => {
    const rule = { config: { pattern: '/[invalid(/', fields: ['title'] } };
    expect(matchKeywordRule(rule, { title: 'test', url: '' })).toBe(0);
  });

  it('handles missing pageData fields', () => {
    const rule = { config: { pattern: 'test', fields: ['title'] } };
    expect(matchKeywordRule(rule, { url: 'https://x.com' })).toBe(0);
    expect(matchKeywordRule(rule, {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchRules
// ---------------------------------------------------------------------------

describe('matchRules', () => {
  it('matches keyword rules without sandbox', async () => {
    const rules = [
      {
        id: 'r1',
        type: 'keyword',
        config: { pattern: 'github', fields: ['url'] },
      },
    ];
    const pageData = { title: 'My Repo', url: 'https://github.com/foo' };
    const results = await matchRules(rules, pageData, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ruleId: 'r1', match: true });
  });

  it('excludes non-matches by default', async () => {
    const rules = [
      {
        id: 'r1',
        type: 'keyword',
        config: { pattern: 'notfound', fields: ['title'] },
      },
    ];
    const results = await matchRules(rules, { title: 'hello', url: '' }, {});
    expect(results).toHaveLength(0);
  });

  it('matches function rules with mock sandbox returning true', async () => {
    const sandbox = vi.fn().mockResolvedValue(true);
    const rules = [
      {
        id: 'r1',
        type: 'function',
        config: { fnSource: 'return true;' },
      },
    ];
    const pageData = { title: 'test', url: 'https://x.com' };
    const results = await matchRules(rules, pageData, { sandbox });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ruleId: 'r1', match: true });
    expect(sandbox).toHaveBeenCalledWith('return true;', pageData);
  });

  it('excludes function rules returning false', async () => {
    const sandbox = vi.fn().mockResolvedValue(false);
    const rules = [
      {
        id: 'r1',
        type: 'function',
        config: { fnSource: 'return false;' },
      },
    ];
    const results = await matchRules(
      rules,
      { title: 'test', url: 'https://x.com' },
      { sandbox },
    );
    expect(results).toHaveLength(0);
  });

  it('handles mixed rule types', async () => {
    const sandbox = vi.fn().mockResolvedValue(true);
    const rules = [
      {
        id: 'r1',
        type: 'keyword',
        config: { pattern: 'test', fields: ['title'] },
      },
      {
        id: 'r2',
        type: 'function',
        config: { fnSource: 'return true;' },
      },
    ];
    const results = await matchRules(
      rules,
      { title: 'test', url: 'https://x.com' },
      { sandbox },
    );
    expect(results).toHaveLength(2);
  });

  it('skips function rules when no sandbox provided', async () => {
    const rules = [
      {
        id: 'r1',
        type: 'function',
        config: { fnSource: 'return true;' },
      },
    ];
    const results = await matchRules(rules, { title: 'test', url: '' }, {});
    expect(results).toHaveLength(0);
  });

  it('includes all rules when allResults is true', async () => {
    const sandbox = vi.fn().mockResolvedValue(false);
    const rules = [
      {
        id: 'r1',
        type: 'keyword',
        config: { pattern: 'notfound', fields: ['title'] },
      },
      {
        id: 'r2',
        type: 'function',
        config: { fnSource: 'return false;' },
      },
    ];
    const results = await matchRules(
      rules,
      { title: 'test', url: '' },
      { sandbox, allResults: true },
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ruleId: 'r1', match: false });
    expect(results[1]).toEqual({ ruleId: 'r2', match: false });
  });
});

// ---------------------------------------------------------------------------
// buildPageDataFromEntry
// ---------------------------------------------------------------------------

describe('buildPageDataFromEntry', () => {
  it('extracts title and url from visit_page entry', () => {
    const entry = {
      timestamp: 100,
      action: 'visit_page',
      url: 'https://x.com',
      title: 'X',
    };
    expect(buildPageDataFromEntry(entry)).toEqual({
      title: 'X',
      url: 'https://x.com',
    });
  });

  it('handles missing title', () => {
    const entry = {
      timestamp: 100,
      action: 'visit_page',
      url: 'https://x.com',
    };
    expect(buildPageDataFromEntry(entry)).toEqual({
      title: '',
      url: 'https://x.com',
    });
  });

  it('handles missing url', () => {
    const entry = { timestamp: 100, action: 'visit_page', title: 'X' };
    expect(buildPageDataFromEntry(entry)).toEqual({ title: 'X', url: '' });
  });
});

// ---------------------------------------------------------------------------
// RULE_TYPES
// ---------------------------------------------------------------------------

describe('RULE_TYPES', () => {
  it('has expected values', () => {
    expect(RULE_TYPES.KEYWORD).toBe('keyword');
    expect(RULE_TYPES.FUNCTION).toBe('function');
  });
});
