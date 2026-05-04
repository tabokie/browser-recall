import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateSlugFromUrl } from '../../apps/extension/utils.js';

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

  it('throws for invalid URLs', () => {
    expect(() => generateSlugFromUrl('not-a-url')).toThrow();
  });

  it('truncates long slugs to 80 chars', () => {
    const longPath = '/a'.repeat(100);
    const slug = generateSlugFromUrl(`https://example.com${longPath}`);
    expect(slug.length).toBeLessThanOrEqual(80);
  });

  it('handles unicode in hostname', () => {
    const slug = generateSlugFromUrl('https://例え.jp/ページ');
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const url = 'https://example.com/test?q=hello';
    expect(generateSlugFromUrl(url)).toBe(generateSlugFromUrl(url));
  });
});

// ---------------------------------------------------------------------------
// collectQbTrees
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// readDesktopValue / loadSettingsValue (behavioral tests with mocked chrome APIs)
// ---------------------------------------------------------------------------

describe('readDesktopValue', () => {
  let sendMessageMock;

  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn(async () => ({ success: true, value: undefined })),
      },
    };
    sendMessageMock = chrome.runtime.sendMessage;
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('sends readDesktopValue action and returns resp.value', async () => {
    sendMessageMock.mockResolvedValue({
      success: true,
      value: { timestamp: 0, pins: [] },
    });
    const { readDesktopValue } = await import('../../apps/extension/utils.js');
    const result = await readDesktopValue('list:some-list');
    expect(sendMessageMock).toHaveBeenCalledWith({
      action: 'readDesktopValue',
      key: 'list:some-list',
      includeDeleted: false,
    });
    expect(result).toEqual({ timestamp: 0, pins: [] });
  });

  it('returns undefined when both session and background miss', async () => {
    sendMessageMock.mockResolvedValue({ success: true, value: undefined });
    const { readDesktopValue } = await import('../../apps/extension/utils.js');
    const result = await readDesktopValue('nonExistent');
    expect(result).toBeUndefined();
  });
});

describe('loadSettingsValue delegates to readDesktopValue', () => {
  let sendMessageMock;

  beforeEach(() => {
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn(async () => ({ success: true, value: undefined })),
      },
    };
    sendMessageMock = chrome.runtime.sendMessage;
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  it('returns defaultValue when readDesktopValue returns undefined', async () => {
    sendMessageMock.mockResolvedValue({ success: true, value: undefined });
    const { loadSettingsValue } = await import('../../apps/extension/utils.js');
    const result = await loadSettingsValue('archiveQuality', 'medium');
    expect(result).toBe('medium');
  });

  it('returns value from readDesktopValue when present', async () => {
    sendMessageMock.mockResolvedValue({
      success: true,
      value: { archiveQuality: 'high' },
    });
    const { loadSettingsValue } = await import('../../apps/extension/utils.js');
    const result = await loadSettingsValue('archiveQuality', 'medium');
    expect(result).toBe('high');
  });
});
