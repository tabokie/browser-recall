import { afterEach, describe, expect, it, vi } from 'vitest';

import { getBrowserCapabilities } from '../../apps/extension/browser-capabilities.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser capabilities', () => {
  it('uses Firefox-only icon page markers for Firefox', () => {
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
      usesIconPageMarker: true,
    });
  });

  it('keeps non-Firefox browsers on the Chrome-style badge marker path', () => {
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
      usesIconPageMarker: false,
    });
  });
});
