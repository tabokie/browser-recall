import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSlugFromUrl, savedSearchesChanged, isGatewayRoot } from '../extension/utils.js';

describe('generateSlugFromUrl', () => {
  it('produces a slug from a simple URL', () => {
    const slug = generateSlugFromUrl('https://example.com/page');
    expect(slug).toMatch(/^example-page-/);
  });

  it('strips leading/trailing hyphens', () => {
    const slug = generateSlugFromUrl('https://example.com/');
    expect(slug).not.toMatch(/^-/);
    expect(slug).not.toMatch(/-$/);
  });

  it('differentiates URLs with different query params', () => {
    const a = generateSlugFromUrl('https://example.com/page?a=1');
    const b = generateSlugFromUrl('https://example.com/page?a=2');
    expect(a).not.toBe(b);
  });

  it('returns "untitled" for invalid URLs', () => {
    expect(generateSlugFromUrl('not-a-url')).toBe('untitled');
  });

  it('truncates long slugs to 80 chars', () => {
    const longPath = '/a'.repeat(100);
    const slug = generateSlugFromUrl(`https://example.com${longPath}`);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('handles unicode in hostname', () => {
    const slug = generateSlugFromUrl('https://例え.jp/ページ');
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toBe('untitled');
  });

  it('is deterministic', () => {
    const url = 'https://example.com/test?q=hello';
    expect(generateSlugFromUrl(url)).toBe(generateSlugFromUrl(url));
  });
});

// ---------------------------------------------------------------------------
// collectQbTrees
// ---------------------------------------------------------------------------

describe('savedSearchesChanged', () => {
  it('returns false for identical arrays', () => {
    expect(savedSearchesChanged(['rust', 'go'], ['rust', 'go'])).toBe(false);
  });

  it('returns false for both empty', () => {
    expect(savedSearchesChanged([], [])).toBe(false);
  });

  it('returns true when a search is added', () => {
    expect(savedSearchesChanged(['rust'], ['rust', 'go'])).toBe(true);
  });

  it('returns true when a search is removed', () => {
    expect(savedSearchesChanged(['rust', 'go'], ['rust'])).toBe(true);
  });

  it('returns true when search content differs', () => {
    expect(savedSearchesChanged(['rust'], ['wasm'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGatewayRoot
// ---------------------------------------------------------------------------

describe('isGatewayRoot', () => {
  const origins = ['https://github.com', 'https://docs.rs'];

  it('matches root URL of a gateway domain', () => {
    expect(isGatewayRoot('https://github.com/', origins)).toBe(true);
  });

  it('matches root URL without trailing slash', () => {
    expect(isGatewayRoot('https://github.com', origins)).toBe(true);
  });

  it('rejects child page of a gateway domain', () => {
    expect(isGatewayRoot('https://github.com/some/repo', origins)).toBe(false);
  });

  it('rejects URL from a non-gateway domain', () => {
    expect(isGatewayRoot('https://example.com/', origins)).toBe(false);
  });

  it('matches second gateway origin', () => {
    expect(isGatewayRoot('https://docs.rs/', origins)).toBe(true);
  });

  it('rejects child page of second gateway', () => {
    expect(isGatewayRoot('https://docs.rs/tokio/latest', origins)).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isGatewayRoot('not-a-url', origins)).toBe(false);
  });

  it('returns false when origins is empty', () => {
    expect(isGatewayRoot('https://github.com/', [])).toBe(false);
  });

  it('rejects gateway origin with query parameters', () => {
    expect(isGatewayRoot('https://github.com/?q=test', origins)).toBe(false);
  });

  it('rejects gateway origin with complex query string', () => {
    expect(isGatewayRoot('https://docs.rs/?dateRange=pastWeek&page=0&query=2028', origins)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readCacheable / loadSettingsValue (behavioral tests with mocked chrome APIs)
// ---------------------------------------------------------------------------

describe('readCacheable', () => {
  let sessionStore;
  let sendMessageMock;

  beforeEach(() => {
    sessionStore = {};
    // Mock chrome.storage.session.get
    globalThis.chrome = {
      storage: {
        session: {
          get: vi.fn(async (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const k of arr) if (k in sessionStore) result[k] = sessionStore[k];
            return result;
          }),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ success: true, value: undefined })),
      },
    };
    sendMessageMock = chrome.runtime.sendMessage;
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('returns value from session cache without sendMessage', async () => {
    sessionStore.settings = { trimRules: [] };
    // Dynamic import to pick up mocked chrome
    const { readCacheable } = await import('../extension/utils.js');
    const result = await readCacheable('settings');
    expect(result).toEqual({ trimRules: [] });
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('sends readCacheable action on session miss and returns resp.value', async () => {
    sendMessageMock.mockResolvedValue({ success: true, value: ['https://docs.rs'] });
    const { readCacheable } = await import('../extension/utils.js');
    const result = await readCacheable('list:system/gateways');
    expect(sendMessageMock).toHaveBeenCalledWith({ action: 'readCacheable', key: 'list:system/gateways', includeDeleted: false });
    expect(result).toEqual(['https://docs.rs']);
  });

  it('returns undefined when both session and background miss', async () => {
    sendMessageMock.mockResolvedValue({ success: true, value: undefined });
    const { readCacheable } = await import('../extension/utils.js');
    const result = await readCacheable('nonExistent');
    expect(result).toBeUndefined();
  });
});

describe('loadSettingsValue delegates to readCacheable', () => {
  let sessionStore;
  let sendMessageMock;

  beforeEach(() => {
    sessionStore = {};
    globalThis.chrome = {
      storage: {
        session: {
          get: vi.fn(async (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            const result = {};
            for (const k of arr) if (k in sessionStore) result[k] = sessionStore[k];
            return result;
          }),
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ success: true, value: undefined })),
      },
    };
    sendMessageMock = chrome.runtime.sendMessage;
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('returns defaultValue when readCacheable returns undefined', async () => {
    sendMessageMock.mockResolvedValue({ success: true, value: undefined });
    const { loadSettingsValue } = await import('../extension/utils.js');
    const result = await loadSettingsValue('archiveQuality', 'medium');
    expect(result).toBe('medium');
  });

  it('returns value from readCacheable when present', async () => {
    sessionStore.settings = { archiveQuality: 'high' };
    const { loadSettingsValue } = await import('../extension/utils.js');
    const result = await loadSettingsValue('archiveQuality', 'medium');
    expect(result).toBe('high');
  });
});
