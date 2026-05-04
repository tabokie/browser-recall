import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('apps/extension/browser-api.js', 'utf8');

function runShim(context) {
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
  it('wraps Firefox chrome compatibility APIs and no-ops session access level', async () => {
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
        runtime: {
          id: 'browser-recall@example.invalid',
          getBrowserInfo: async () => ({ name: 'Firefox' }),
        },
        storage: {
          local: promiseStorageArea(),
          session: promiseStorageArea({ colorScheme: 'amber' }),
        },
      },
    };

    runShim(context);

    expect(context.browserRecallWebExtension.engine).toBe('firefox');
    expect(context.chrome.runtime.id).toBe('browser-recall@example.invalid');
    expect(typeof context.chrome.storage.session.setAccessLevel).toBe(
      'function',
    );
    await expect(
      context.chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      }),
    ).resolves.toBeUndefined();

    const callback = vi.fn();
    const value = await context.chrome.storage.session.get(
      ['colorScheme'],
      callback,
    );
    expect(value).toEqual({ colorScheme: 'amber' });
    expect(callback).toHaveBeenCalledWith({ colorScheme: 'amber' });
  });

  it('keeps native Chromium chrome API when browser is absent', () => {
    const nativeChrome = {
      storage: {
        session: {
          setAccessLevel: vi.fn(),
        },
      },
    };
    const context = {
      console,
      chrome: nativeChrome,
    };

    runShim(context);

    expect(context.chrome).toBe(nativeChrome);
    expect(context.browserRecallWebExtension.engine).toBe('chromium');
  });

  it('fills runtime.getURL from the extension page origin when the browser API omits it', () => {
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

    runShim(context);

    expect(context.chrome.runtime.getURL('snapshot-viewer.html')).toBe(
      'moz-extension://browser-recall.invalid/snapshot-viewer.html',
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

    runShim(context);

    const manifest = context.chrome.runtime.getManifest();
    const url = context.chrome.runtime.getURL('snapshot-viewer.html');
    expect(manifest).toEqual({ version: '1.2.3' });
    expect(manifest?.then).toBeUndefined();
    expect(url).toBe(
      'moz-extension://browser-recall.invalid/snapshot-viewer.html',
    );
    expect(url?.then).toBeUndefined();
  });

  it('promisifies callback-style WebExtension methods', async () => {
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
          getBrowserInfo(callback) {
            callback({ name: 'Orion' });
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

    runShim(context);

    expect(context.browserRecallWebExtension.engine).toBe('chromium');
    await expect(
      context.chrome.storage.local.get(['connectorState']),
    ).resolves.toEqual({
      connectorState: 'connected',
      requested: ['connectorState'],
    });
    await expect(
      context.chrome.runtime.sendMessage({ action: 'getPageSummary' }),
    ).resolves.toEqual({
      success: true,
      action: 'getPageSummary',
    });
  });
});
