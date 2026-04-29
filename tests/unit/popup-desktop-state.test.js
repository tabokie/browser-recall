import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const POPUP_HTML = readFileSync(
  path.join(ROOT, 'apps', 'extension', 'popup.html'),
  'utf8',
);

async function waitFor(predicate, timeoutMs = 1500, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('condition not met before timeout');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function listenerStore() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function installDom() {
  const dom = new JSDOM(POPUP_HTML, {
    url: 'chrome-extension://abcdefghijklmnop/popup.html',
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  return dom;
}

function installChromeMock({ tab, responses }) {
  const storageChanged = listenerStore();
  const runtimeMessages = listenerStore();
  const sessionStore = {};

  globalThis.chrome = {
    runtime: {
      getURL: (resource) => `chrome-extension://abcdefghijklmnop/${resource}`,
      onMessage: runtimeMessages,
      reload: vi.fn(),
      sendMessage: vi.fn(async (request) => {
        const handler = responses[request.action];
        if (!handler) return { success: true };
        return typeof handler === 'function' ? handler(request) : handler;
      }),
    },
    storage: {
      local: {
        onChanged: storageChanged,
      },
      session: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys
                .filter((key) =>
                  Object.prototype.hasOwnProperty.call(sessionStore, key),
                )
                .map((key) => [key, sessionStore[key]]),
            );
          }
          if (typeof keys === 'string') {
            return Object.prototype.hasOwnProperty.call(sessionStore, keys)
              ? { [keys]: sessionStore[keys] }
              : {};
          }
          return { ...sessionStore };
        },
        async set(values) {
          Object.assign(sessionStore, values);
        },
      },
      onChanged: storageChanged,
    },
    tabs: {
      query: vi.fn(async () => [tab]),
      sendMessage: vi.fn(async () => ({ success: true })),
    },
  };
}

describe('popup desktop state rendering', () => {
  afterEach(() => {
    vi.resetModules();
    delete globalThis.chrome;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.navigator;
    delete globalThis.HTMLElement;
    delete globalThis.CustomEvent;
    delete globalThis.getComputedStyle;
  });

  it('does not render fallback page details when desktop summary metadata fails', async () => {
    const tab = {
      id: 42,
      url: 'https://example.com/popup-broken-summary',
      title: 'Browser Tab Title',
    };
    installDom();
    installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: {
          success: true,
          state: 'connected',
          deviceId: 'test-device',
          hasToken: true,
        },
        getReportedUrl: { success: true, url: tab.url },
        trimTitle: { title: tab.title },
        readCacheable: { success: true, value: null },
        getPageSummary: {
          success: false,
          error: 'Desktop popup page summary failed',
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    );
    await waitFor(
      () => document.getElementById('setup-required').style.display === 'block',
    );

    expect(document.getElementById('dashboard').style.display).toBe('none');
    expect(document.getElementById('setupRequiredTitle').textContent).toBe(
      'Desktop Offline',
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'getPageSummary',
      url: tab.url,
    });
  });

  it('shows connector diagnostics while desktop is not connected', async () => {
    const tab = {
      id: 43,
      url: 'https://example.com/reconnect-diagnostic',
      title: 'Reconnect Diagnostic',
    };
    installDom();
    installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: {
          success: true,
          state: 'connecting',
          hasToken: true,
          lastDiagnostic: {
            code: 'manual_reconnect_exhausted',
            elapsedMs: 15000,
            lastDiagnostic: 'no_ports_reachable',
            failures: [
              { port: 28471, code: 'connect_error' },
              { port: 28472, code: 'connect_timeout' },
            ],
          },
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () => document.getElementById('setup-required').style.display === 'block',
    );

    expect(document.getElementById('setupRequiredTitle').textContent).toBe(
      'Desktop Offline',
    );
    expect(document.getElementById('setupRequiredMeta').textContent).toContain(
      'Desktop approved, but not reachable.',
    );
    expect(document.getElementById('setupRequiredMeta').textContent).toContain(
      'Last check: desktop did not become reachable in 15s.',
    );
    expect(document.getElementById('setupRequiredMeta').textContent).toContain(
      'Last port failures: 28471: connect_error, 28472: connect_timeout.',
    );
  });

  it('reveals the offline shell while desktop state probing is still pending', async () => {
    const tab = {
      id: 45,
      url: 'https://example.com/offline-pending',
      title: 'Offline Pending',
    };
    const connectorState = deferred();
    installDom();
    installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: () => connectorState.promise,
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.documentElement.style.opacity === '');
    expect(document.getElementById('setup-required').style.display).toBe(
      'block',
    );
    expect(document.getElementById('dashboard').style.display).toBe('none');
    expect(document.getElementById('setupRequiredTitle').textContent).toBe(
      'Desktop Offline',
    );

    connectorState.resolve({
      success: true,
      state: 'offline',
      hasToken: true,
    });
  });

  it('keeps the popup hidden until connected page details finish loading', async () => {
    const tab = {
      id: 44,
      url: 'https://example.com/slow-popup-summary',
      title: 'Tab Title Before Desktop',
    };
    const pageSummary = deferred();
    installDom();
    installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: {
          success: true,
          state: 'connected',
          deviceId: 'test-device',
          hasToken: true,
        },
        getReportedUrl: { success: true, url: tab.url },
        trimTitle: { title: tab.title },
        readCacheable: { success: true, value: null },
        getPageSummary: () => pageSummary.promise,
        getPopupLists: { success: true, lists: [] },
      },
    });

    await import('../../apps/extension/popup.js');
    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    );

    expect(document.documentElement.style.opacity).toBe('0');
    expect(document.getElementById('dashboard').style.display).toBe('none');

    pageSummary.resolve({
      success: true,
      page: {
        slug: 'slow-popup-summary',
        url: tab.url,
        title: 'Desktop Title',
        visitDates: [],
      },
      notes: [],
      snapshots: [],
      lists: [],
    });

    await waitFor(
      () => document.getElementById('dashboard').style.display === 'flex',
    );
    expect(document.documentElement.style.opacity).toBe('');
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Desktop Title',
    );
  });
});
