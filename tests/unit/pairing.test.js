import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPairRequest,
  detectBrowserName,
} from '../../apps/extension/connector/pairing.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connector pairing browser detection', () => {
  it('detects Brave through the Brave navigator API before the Chrome user agent check', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
      brave: {
        isBrave: async () => true,
      },
    });

    await expect(detectBrowserName()).resolves.toBe('Brave');
  });

  it('detects Chrome when no browser-specific signal is present', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    });

    await expect(detectBrowserName()).resolves.toBe('Chrome');
  });

  it('detects Firefox before the Chrome user agent check', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
    });

    await expect(detectBrowserName()).resolves.toBe('Firefox');
  });

  it('builds a Firefox pair request from the canonical adapter runtime id', async () => {
    const store = {};
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => 'browser-install-firefox',
    });
    vi.stubGlobal('chrome', {
      runtime: { id: 'browser-recall@example.invalid' },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(
              keys
                .filter((key) =>
                  Object.prototype.hasOwnProperty.call(store, key),
                )
                .map((key) => [key, store[key]]),
            );
          },
          async set(patch) {
            Object.assign(store, patch);
          },
        },
      },
    });

    const request = await buildPairRequest();
    expect(request).toMatchObject({
      type: 'pair_request',
      protocolVersion: 1,
      browserId: 'browser-install-firefox',
      browserName: 'Firefox',
      extensionId: 'browser-recall@example.invalid',
      browserProfile: null,
    });
  });
});
