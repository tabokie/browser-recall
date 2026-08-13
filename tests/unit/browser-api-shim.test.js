import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('apps/extension/browser-api.js', 'utf8');

function runShim(context, buildTarget) {
  if (buildTarget !== undefined) {
    context.browserRecallBuildTarget = buildTarget;
  }
  vm.runInNewContext(source, context, {
    filename: 'apps/extension/browser-api.js',
  });
  return context;
}

function promiseStorageArea(seed = {}) {
  const data = { ...seed };
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
            .map((key) => [key, data[key]]),
        );
      }
      return { [keys]: data[keys] };
    },
    async set(patch) {
      Object.assign(data, patch);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
    async clear() {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    },
    _data: data,
  };
}

describe('browser-api shim', () => {
  it('wraps Firefox APIs without inventing unsupported session methods', async () => {
    const context = {
      console,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
      },
      chrome: {
        storage: {
          session: {},
          local: {},
        },
      },
      browser: {
        action: {},
        contextMenus: {},
        runtime: {
          id: 'browser-recall@example.invalid',
          getBrowserInfo: async () => ({ name: 'Firefox' }),
          getURL: (path) => `moz-extension://browser-recall.invalid/${path}`,
        },
        storage: {
          local: promiseStorageArea(),
          session: promiseStorageArea({ colorScheme: 'amber' }),
        },
      },
    };

    runShim(context, 'firefox');

    expect(context.browserRecallWebExtension.buildTarget).toBe('firefox');
    expect(context.chrome.runtime.id).toBe('browser-recall@example.invalid');
    expect(context.chrome.storage.session.setAccessLevel).toBeUndefined();

    const value = await context.chrome.storage.session.get(['colorScheme']);
    expect(value).toEqual({ colorScheme: 'amber' });
  });

  it('keeps native Chromium chrome API when browser is absent', () => {
    const nativeChrome = {
      runtime: {
        id: 'chromium-extension-id',
        getURL: (path) => `chrome-extension://chromium-extension-id/${path}`,
      },
      storage: {
        session: {
          setAccessLevel: vi.fn(),
        },
      },
    };
    const context = {
      console,
      navigator: {
        userAgent:
          'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      chrome: nativeChrome,
    };

    runShim(context, 'chromium');

    expect(context.chrome).toBe(nativeChrome);
    expect(context.browserRecallWebExtension.buildTarget).toBe('chromium');
  });

  it('uses the Chromium extension API when Chrome exposes an unrelated browser global', () => {
    const nativeChrome = {
      runtime: {
        id: 'chromium-extension-id',
        getURL: (path) => `chrome-extension://chromium-extension-id/${path}`,
      },
      storage: {
        session: {
          setAccessLevel: vi.fn(),
        },
      },
    };
    const unrelatedBrowserGlobal = { currentWindow: {} };
    const context = {
      console,
      navigator: {
        userAgent:
          'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.0.0 Safari/537.36',
      },
      chrome: nativeChrome,
      browser: unrelatedBrowserGlobal,
    };

    runShim(context, 'chromium');

    expect(context.chrome).toBe(nativeChrome);
    expect(context.browser).toBe(nativeChrome);
    expect(context.browserRecallWebExtension.buildTarget).toBe('chromium');
  });

  it('classifies extension runtime failures that need user-visible recovery', () => {
    const context = {
      console,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
      },
      browser: {
        action: {},
        contextMenus: {},
        runtime: {
          id: 'browser-recall@example.invalid',
          getURL: (path) => `moz-extension://browser-recall.invalid/${path}`,
        },
        storage: {
          local: promiseStorageArea(),
          session: promiseStorageArea(),
        },
      },
    };

    runShim(context, 'firefox');

    const isRuntimeFailure = context.browserRecallWebExtension.isRuntimeFailure;
    expect(isRuntimeFailure(new Error('Extension context invalidated.'))).toBe(
      true,
    );
    expect(
      isRuntimeFailure(
        new Error('requestStorageAccessFor: Permission denied.'),
      ),
    ).toBe(true);
    expect(
      isRuntimeFailure(
        new Error(
          "The service worker navigation preload request was cancelled before 'preloadResponse' settled.",
        ),
      ),
    ).toBe(true);
    expect(isRuntimeFailure(new Error('Validation failed.'))).toBe(false);
  });

  it('rejects a browser platform that omits runtime.getURL', () => {
    const context = {
      console,
      URL,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
      },
      window: {
        location: {
          href: 'moz-extension://browser-recall.invalid/popup.html',
        },
      },
      browser: {
        action: {},
        contextMenus: {},
        runtime: {
          id: 'browser-recall@example.invalid',
          getBrowserInfo: async () => ({ name: 'Firefox' }),
        },
        storage: {
          local: promiseStorageArea(),
          session: promiseStorageArea(),
        },
      },
    };

    expect(() => runShim(context, 'firefox')).toThrow(
      'Browser Recall requires the Firefox WebExtension API',
    );
  });

  it('keeps synchronous runtime helpers synchronous', () => {
    const context = {
      console,
      URL,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
      },
      browser: {
        action: {},
        contextMenus: {},
        runtime: {
          id: 'browser-recall@example.invalid',
          getManifest() {
            return { version: '1.2.3' };
          },
          getURL(resourcePath) {
            return `moz-extension://browser-recall.invalid/${resourcePath}`;
          },
        },
        storage: {
          local: promiseStorageArea(),
          session: promiseStorageArea(),
        },
      },
    };

    runShim(context, 'firefox');

    const manifest = context.chrome.runtime.getManifest();
    const url = context.chrome.runtime.getURL('popup.html');
    expect(manifest).toEqual({ version: '1.2.3' });
    expect(manifest?.then).toBeUndefined();
    expect(url).toBe('moz-extension://browser-recall.invalid/popup.html');
    expect(url?.then).toBeUndefined();
  });

  it('rejects unsupported Safari-style callback APIs', () => {
    const context = {
      console,
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      },
      setTimeout,
      browser: {
        runtime: {
          id: 'orion-extension@example.invalid',
          getURL(path) {
            return `safari-web-extension://browser-recall.invalid/${path}`;
          },
          getBrowserInfo(callback) {
            callback({ name: 'Safari' });
          },
          sendMessage(message, callback) {
            callback({ success: true, action: message.action });
          },
        },
        storage: {
          local: {
            get(keys, callback) {
              callback({ connectorState: 'connected', requested: keys });
            },
          },
        },
      },
    };

    expect(() => runShim(context)).toThrow(
      'Browser Recall build target is missing or invalid',
    );
  });
});
