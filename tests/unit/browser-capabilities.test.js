import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrowserCapabilities } from '../../apps/extension/browser-capabilities.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser capabilities', () => {
  it('uses promise message responses for Firefox', () => {
    vi.stubGlobal('browserRecallWebExtension', { buildTarget: 'firefox' });
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          setAccessLevel() {},
        },
      },
    });

    expect(getBrowserCapabilities()).toMatchObject({
      buildTarget: 'firefox',
      supportsPromiseOnMessage: true,
    });
  });

  it('uses callback message responses for Chromium browsers', () => {
    vi.stubGlobal('browserRecallWebExtension', { buildTarget: 'chromium' });
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          setAccessLevel() {},
        },
      },
    });

    expect(getBrowserCapabilities()).toMatchObject({
      buildTarget: 'chromium',
      supportsPromiseOnMessage: false,
    });
  });
});
