import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { generateSlugFromUrl } from '../../apps/extension/utils.js';

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
  globalThis.browserRecallWebExtension = {
    isRuntimeFailure(error) {
      const message = String(error?.message || error || '');
      return /extension context invalidated|receiving end does not exist|message port closed|could not establish connection|requeststorageaccessfor: permission denied|navigation preload request was cancelled/i.test(
        message,
      );
    },
  };
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

  return { runtimeMessages, sessionStore, storageChanged };
}

describe('popup desktop state rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete globalThis.chrome;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.navigator;
    delete globalThis.HTMLElement;
    delete globalThis.CustomEvent;
    delete globalThis.getComputedStyle;
    delete globalThis.browserRecallWebExtension;
  });

  it('does not render synthetic page details when desktop summary metadata fails', async () => {
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
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
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
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Page Data Unavailable',
    );

    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
    expect(document.getElementById('pageDiagnosticTitle').textContent).toBe(
      'Page Data Unavailable',
    );
    expect(document.getElementById('pageDiagnosticMessage').textContent).toBe(
      'Desktop popup page summary failed',
    );
    expect(
      document.getElementById('pageDiagnosticDetail').textContent,
    ).toContain('reason: popup-page-summary-failed');
    expect(
      document.getElementById('pageDiagnosticDetail').textContent,
    ).toContain('connector: connected');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'getPageSummary',
      url: tab.url,
    });
    expect(
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getExtensionDiagnostics',
      ),
    ).toBe(false);
  });

  it('clears a stale page diagnostic after page summary recovers', async () => {
    const tab = {
      id: 43,
      url: 'https://example.com/popup-summary-recovers',
      title: 'Recovered Browser Title',
    };
    let recovered = false;
    installDom();
    const { runtimeMessages } = installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: {
          success: true,
          state: 'connected',
          deviceId: 'test-device',
          hasToken: true,
        },
        getReportedUrl: { success: true, url: tab.url },
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: () =>
          recovered
            ? {
                success: true,
                url: tab.url,
                page: {
                  slug: 'popup-summary-recovers',
                  url: tab.url,
                  title: 'Recovered Desktop Title',
                  visitDates: [],
                },
                notes: [],
                snapshots: [],
                lists: [],
              }
            : {
                success: false,
                error: 'Temporary summary failure',
              },
        getPopupLists: { success: true, lists: [] },
        captureCurrentPageFromPopup: { success: true },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Page Data Unavailable',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');

    recovered = true;
    document.getElementById('captureBtn').click();

    await waitFor(
      () =>
        document.getElementById('pageTitle').textContent ===
        'Recovered Desktop Title',
    );
    expect(document.getElementById('pageDiagnosticSection').style.display).toBe(
      'none',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('');
  });

  it('keeps the recording banner visible when page data is unavailable', async () => {
    const tab = {
      id: 41,
      url: 'https://example.com/popup-broken-summary-banner',
      title: 'Broken Summary Banner',
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
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: {
          success: false,
          error: 'Desktop popup page summary failed',
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Page Data Unavailable',
    );

    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('recordingBar')).toBeTruthy();
    expect(document.getElementById('recordingToggle')).toBeTruthy();
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
  });

  it('records and restores the active page when recording resumes from paused popup', async () => {
    const tab = {
      id: 44,
      url: 'https://example.com/resume-from-paused-popup',
      title: 'Resume From Paused Popup',
    };
    installDom();
    const { sessionStore } = installChromeMock({
      tab,
      responses: {
        getDesktopConnectorState: {
          success: true,
          state: 'connected',
          deviceId: 'test-device',
          hasToken: true,
        },
        getReportedUrl: { success: true, url: tab.url },
        setRecordingPaused: (request) => {
          sessionStore.workspace = request.paused ? { mode: 'private' } : {};
          return { success: true };
        },
        recordPageActivity: { success: true },
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: {
          success: true,
          url: tab.url,
          page: {
            slug: generateSlugFromUrl(tab.url),
            url: tab.url,
            title: tab.title,
            visitDates: [],
          },
          notes: [],
          snapshots: [],
          lists: [],
        },
        getPopupLists: { success: true, lists: [] },
      },
    });
    sessionStore.workspace = { mode: 'private' };

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('dashboardContent') === null);
    document.getElementById('recordingToggle').click();

    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'recordPageActivity',
      ),
    );

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'recordPageActivity',
      url: tab.url,
      title: tab.title,
      slug: generateSlugFromUrl(tab.url),
      isInitialLoad: true,
    });
    expect(document.getElementById('dashboardContent')).toBeTruthy();
    expect(document.getElementById('pageTitle').textContent).toBe(tab.title);
  });

  it('keeps the recording banner visible when the active page is unavailable', async () => {
    const tab = {
      id: 39,
      url: 'chrome://extensions/',
      title: 'Extensions',
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
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Not available for this page',
    );

    expect(document.getElementById('loading').style.display).toBe('none');
    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('recordingBar')).toBeTruthy();
    expect(document.getElementById('recordingToggle')).toBeTruthy();
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageDiagnosticSection').style.display).toBe(
      '',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
    expect(document.getElementById('pageTitle').textContent).toBe('—');
    const messageStyle = getComputedStyle(
      document.getElementById('pageDiagnosticTitle'),
    );
    expect(messageStyle.textTransform).toBe('uppercase');
    expect(messageStyle.fontWeight).toBe('900');
    expect(document.getElementById('recordingBar').nextElementSibling).toBe(
      document.getElementById('dashboardContent'),
    );
  });

  it('keeps the recording banner visible when the current page is blacklisted', async () => {
    const tab = {
      id: 40,
      url: 'https://blocked.example.com/private',
      title: 'Blocked Page',
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
        getPopupAccessState: {
          success: true,
          blacklisted: true,
          hasVisitHistory: false,
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Blacklisted',
    );

    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('recordingBar')).toBeTruthy();
    expect(document.getElementById('recordingToggle')).toBeTruthy();
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
    expect(document.getElementById('pageDiagnosticMessage').textContent).toBe(
      tab.url,
    );
    expect(document.getElementById('captureOnceBtn')).toBeTruthy();
    expect(document.getElementById('blacklistSettingsLink')).toBeTruthy();
  });

  it('falls back to a popup bubble when blacklisted capture cannot notify the page', async () => {
    const tab = {
      id: 41,
      url: 'https://blocked.example.com/capture-failure',
      title: 'Blocked Capture Failure',
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
        getPopupAccessState: {
          success: true,
          blacklisted: true,
          hasVisitHistory: false,
        },
        recordPageActivity: { success: true },
        captureCurrentPageFromPopup: {
          success: false,
          error: 'Blacklisted capture failed',
        },
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: {
          success: true,
          url: tab.url,
          page: {
            slug: generateSlugFromUrl(tab.url),
            url: tab.url,
            title: tab.title,
            visitDates: [],
          },
          notes: [],
          snapshots: [],
          lists: [],
        },
        getPopupLists: { success: true, lists: [] },
      },
    });
    chrome.tabs.sendMessage.mockRejectedValue(
      new Error('Receiving end does not exist.'),
    );

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('captureOnceBtn'));
    document.getElementById('captureOnceBtn').click();

    await waitFor(() => document.getElementById('errorBubble'));
    const errorBubble = document.getElementById('errorBubble');
    expect(errorBubble.textContent).toContain('Blacklisted capture failed');
    expect(errorBubble.style.backgroundColor).toBe('rgb(247, 244, 234)');
    expect(errorBubble.style.color).toBe('rgb(255, 45, 32)');
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
      'Desktop approved, but connection failed.',
    );
    expect(document.getElementById('setupRequiredMeta').textContent).toContain(
      'Last check: desktop connection did not succeed in 15s.',
    );
    expect(document.getElementById('setupRequiredMeta').textContent).toContain(
      'Last port failures: 28471: connect_error, 28472: connect_timeout.',
    );
  });

  it('renders current tab details when desktop has no page entry yet', async () => {
    const tab = {
      id: 46,
      url: 'https://example.com/page-not-drained-yet',
      title: 'Page Not Drained Yet',
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
        readDesktopValue: { success: true, value: null },
        getPageSummary: {
          success: true,
          url: tab.url,
          page: null,
          notes: [],
          snapshots: [],
          lists: [],
        },
        getPopupLists: () => ({
          success: true,
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: pinned
                ? [
                    {
                      id: `page:${generateSlugFromUrl(tab.url)}`,
                      pinnedAt: Date.now(),
                    },
                  ]
                : [],
            },
          ],
        }),
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () => document.getElementById('dashboard').style.display === 'flex',
    );

    expect(document.getElementById('setup-required').style.display).toBe(
      'none',
    );
    expect(document.getElementById('pageTitle').textContent).toBe(tab.title);
    expect(document.getElementById('pageUrl').textContent).toBe(tab.url);
    expect(document.getElementById('visitsLikesSection').style.display).toBe(
      'none',
    );
    expect(document.getElementById('setupDiagnostic').textContent).toBe('');
  });

  it('keeps the startup loader visible while desktop state probing is still pending', async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.documentElement.style.opacity).toBe('');
    expect(document.getElementById('loading').style.display).toBe('flex');
    expect(document.getElementById('setup-required').style.display).toBe(
      'none',
    );
    expect(document.getElementById('dashboard').style.display).toBe('none');

    connectorState.resolve({
      success: true,
      state: 'offline',
      hasToken: true,
    });
  });

  it('reveals the page header while connected page details are still loading', async () => {
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
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
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

    expect(document.documentElement.style.opacity).toBe('');
    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('pageTitle').textContent).toBe(tab.title);
    expect(document.getElementById('pageUrl').textContent).toBe(tab.url);
    expect(document.getElementById('listSection').style.display).toBe('none');
    expect(document.getElementById('notesSection').style.display).toBe('none');
    expect(document.getElementById('snapshotSection').style.display).toBe(
      'none',
    );

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
      () =>
        document.getElementById('pageTitle').textContent === 'Desktop Title',
    );
    expect(document.documentElement.style.opacity).toBe('');
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Desktop Title',
    );
    expect(document.getElementById('notesSection').style.display).toBe('');
    expect(document.getElementById('snapshotSection').style.display).toBe('');
  });

  it('keeps the editable page title legible in the dark popup theme', async () => {
    installDom();

    const inputRule = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((rule) => rule.selectorText === '.page-title-input');

    expect(inputRule?.style.color).toBe('var(--text-primary)');
  });

  it('notifies the active page when popup capture fails because the extension context was invalidated', async () => {
    const tab = {
      id: 49,
      url: 'https://example.com/context-invalidated',
      title: 'Context Invalidated',
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
        readDesktopValue: { success: true, value: null },
        getPageSummary: {
          success: true,
          url: tab.url,
          page: {
            slug: 'context-invalidated',
            url: tab.url,
            title: tab.title,
            visitDates: [],
          },
          notes: [],
          snapshots: [],
          lists: [],
        },
        getPopupLists: { success: true, lists: [] },
        captureCurrentPageFromPopup: {
          success: false,
          error: 'Extension context invalidated.',
        },
      },
    });
    await import('../../apps/extension/popup.js');

    await waitFor(
      () => document.getElementById('dashboard').style.display === 'flex',
    );
    document.getElementById('captureBtn').click();

    await waitFor(() => chrome.tabs.sendMessage.mock.calls.length > 0);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      tab.id,
      expect.objectContaining({
        action: 'showErrorNotification',
        message: expect.stringContaining('Reload this page'),
      }),
    );
  });

  it('keeps the popup title trimmed after adding the current page to a list', async () => {
    const tab = {
      id: 50,
      url: 'https://example.com/trimmed-title-after-pin',
      title: 'Trimmed Title | Example Site',
    };
    let pinned = false;
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
        trimTitle: (request) => ({
          title: (request.title || '').split('|')[0].trim(),
        }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: () => ({
          success: true,
          url: tab.url,
          page: {
            slug: 'trimmed-title-after-pin',
            url: tab.url,
            title: pinned ? tab.title : 'Trimmed Title',
            visitDates: [],
          },
          notes: [],
          snapshots: [],
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: pinned
                ? [
                    {
                      id: `page:${generateSlugFromUrl(tab.url)}`,
                      pinnedAt: Date.now(),
                    },
                  ]
                : [],
            },
          ],
        }),
        getPopupLists: () => ({
          success: true,
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: pinned
                ? [
                    {
                      id: `page:${generateSlugFromUrl(tab.url)}`,
                      pinnedAt: Date.now(),
                    },
                  ]
                : [],
            },
          ],
        }),
        toggleListPin: () => {
          pinned = true;
          return { success: true, pinned: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageTitle').textContent === 'Trimmed Title',
    );
    document.querySelector('.list-chip').click();

    await waitFor(() => document.querySelector('.list-chip.selected'));
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Trimmed Title',
    );
  });

  it('does not blank list chips while refreshing after a list toggle', async () => {
    const tab = {
      id: 51,
      url: 'https://example.com/no-list-toggle-flicker',
      title: 'No List Toggle Flicker',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let pinned = false;
    let summaryCalls = 0;
    let popupListCalls = 0;
    const secondSummary = deferred();
    const secondPopupLists = deferred();
    const currentLists = () => [
      {
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [
              {
                id: `page:${pageSlug}`,
                pinnedAt: Date.now(),
              },
            ]
          : [],
      },
    ];

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
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: () => {
          summaryCalls++;
          if (summaryCalls === 2) return secondSummary.promise;
          return {
            success: true,
            url: tab.url,
            page: {
              slug: pageSlug,
              url: tab.url,
              title: tab.title,
              visitDates: [],
            },
            notes: [],
            snapshots: [],
            lists: currentLists(),
          };
        },
        getPopupLists: () => {
          popupListCalls++;
          if (popupListCalls === 2) return secondPopupLists.promise;
          return { success: true, lists: currentLists() };
        },
        toggleListPin: () => {
          pinned = true;
          return { success: true, pinned: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.list-chip'));
    const listChips = document.getElementById('listChips');
    expect(listChips.textContent).toContain('Reading');

    document.querySelector('.list-chip').click();
    await waitFor(() => summaryCalls === 2);
    secondSummary.resolve({
      success: true,
      url: tab.url,
      page: {
        slug: pageSlug,
        url: tab.url,
        title: tab.title,
        visitDates: [],
      },
      notes: [],
      snapshots: [],
      lists: currentLists(),
    });
    await waitFor(() => popupListCalls === 2);

    expect(listChips.textContent).toContain('Reading');
    expect(listChips.querySelectorAll('.list-chip')).toHaveLength(1);

    secondPopupLists.resolve({ success: true, lists: currentLists() });
    await waitFor(() => document.querySelector('.list-chip.selected'));
  });

  it('refreshes visible chips after toggling a list from the picker even if summary refresh stalls', async () => {
    const tab = {
      id: 52,
      url: 'https://example.com/picker-chip-refresh',
      title: 'Picker Chip Refresh',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let pinned = false;
    let summaryCalls = 0;
    const stalledSummary = deferred();
    const currentLists = () => [
      {
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [
              {
                id: `page:${pageSlug}`,
                pinnedAt: Date.now(),
              },
            ]
          : [],
      },
    ];

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
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: () => {
          summaryCalls++;
          if (summaryCalls === 2) return stalledSummary.promise;
          return {
            success: true,
            url: tab.url,
            page: {
              slug: pageSlug,
              url: tab.url,
              title: tab.title,
              visitDates: [],
            },
            notes: [],
            snapshots: [],
            lists: currentLists(),
          };
        },
        getPopupLists: () => ({ success: true, lists: currentLists() }),
        toggleListPin: () => {
          pinned = true;
          return { success: true, pinned: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('listAddBtn'));
    document.getElementById('listAddBtn').click();
    await waitFor(() => document.querySelector('.list-picker-row'));
    document.querySelector('.list-picker-row').click();
    await waitFor(() => summaryCalls === 2);

    await waitFor(() => document.querySelector('.list-chip.selected'));
    await waitFor(() => document.querySelector('.list-picker-row.selected'));
    expect(document.getElementById('listChips').textContent).toContain(
      'Reading',
    );
  });
});
