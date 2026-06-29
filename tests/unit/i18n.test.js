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

function mockCatalogFetch(catalogs) {
  globalThis.fetch = vi.fn(async (url) => {
    const path = String(url);
    for (const [locale, message] of Object.entries(catalogs)) {
      if (path.includes(`/${locale}/messages.json`)) {
        return {
          ok: true,
          json: async () => ({ commonSettings: { message } }),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('catalog localization', () => {
  it.each([
    ['zh_Hans_CN', 'zh-CN', '设置'],
    ['zh-Hant-HK', 'zh-TW', '設定'],
    ['pt-PT', 'pt-PT', 'Configurações'],
    ['ar-EG', 'ar', 'الإعدادات'],
    ['zh', 'zh-CN', '设置'],
  ])('maps system locale %s to %s', async (systemLocale, locale, message) => {
    mockCatalogFetch({ [locale]: message, en: 'Settings' });

    await initializeCatalogI18n({ locale: systemLocale });

    expect(getActiveLocale()).toBe(locale);
    expect(tr('commonSettings', 'Settings')).toBe(message);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: expect.stringContaining(`/${locale}/messages.json`),
      }),
    );
  });

  it('surfaces a missing selected catalog instead of loading English', async () => {
    mockCatalogFetch({ en: 'Settings' });

    await expect(initializeCatalogI18n({ locale: 'ja' })).rejects.toThrow(
      'Could not load locale ja: 404',
    );
  });
});
