import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrowserCapabilities } from '../../apps/extension/browser-capabilities.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser capabilities', () => {
  it('uses promise message responses for Firefox', () => {
    vi.stubGlobal('browserRecallWebExtension', { engine: 'firefox' });
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          setAccessLevel() {},
        },
      },
    });

    expect(getBrowserCapabilities()).toMatchObject({
      engine: 'firefox',
      supportsPromiseOnMessage: true,
    });
  });

  it('uses callback message responses for Chromium browsers', () => {
    vi.stubGlobal('browserRecallWebExtension', { engine: 'chromium' });
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          setAccessLevel() {},
        },
      },
    });

    expect(getBrowserCapabilities()).toMatchObject({
      engine: 'chromium',
      supportsPromiseOnMessage: false,
    });
  });
});
