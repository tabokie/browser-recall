import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectBrowserName } from '../../apps/extension/connector/pairing.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connector pairing browser detection', () => {
  it('detects Brave through the Brave navigator API before Chrome user agent fallback', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
      brave: {
        isBrave: async () => true,
      },
    });

    await expect(detectBrowserName()).resolves.toBe('Brave');
  });

  it('falls back to Chrome when no browser-specific signal is present', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    });

    await expect(detectBrowserName()).resolves.toBe('Chrome');
  });
});
