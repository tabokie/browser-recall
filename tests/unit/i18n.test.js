// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveLocale,
  initializeCatalogI18n,
  tr,
} from '../../packages/core/i18n.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockCatalogFetch() {
  globalThis.fetch = vi.fn(async (url) => {
    const path = String(url);
    if (path.includes('/zh-CN/messages.json')) {
      return {
        ok: true,
        json: async () => ({
          commonSettings: { message: '设置' },
        }),
      };
    }
    if (path.includes('/en/messages.json')) {
      return {
        ok: true,
        json: async () => ({
          commonSettings: { message: 'Settings' },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('catalog localization', () => {
  it('maps common Simplified Chinese system locale tags to zh-CN', async () => {
    mockCatalogFetch();

    await initializeCatalogI18n({ locale: 'zh_Hans_CN' });

    expect(getActiveLocale()).toBe('zh-CN');
    expect(tr('commonSettings', 'Settings')).toBe('设置');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: expect.stringContaining('/zh-CN/messages.json'),
      }),
    );
  });
});
