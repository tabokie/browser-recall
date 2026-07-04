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
const EN_MESSAGES = JSON.parse(
  readFileSync(
    path.join(ROOT, 'packages', 'core', 'locales', 'en', 'messages.json'),
    'utf8',
  ),
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

function installDom(url = 'chrome-extension://abcdefghijklmnop/popup.html') {
  const dom = new JSDOM(POPUP_HTML, {
    url,
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
    i18n: {
      getUILanguage: () => 'en',
      getMessage: (key, substitutions = []) => {
        const values = Array.isArray(substitutions)
          ? substitutions
          : [substitutions];
        return (EN_MESSAGES[key]?.message || '').replace(
          /\$(\d+)/g,
          (match, index) => values[Number(index) - 1] ?? match,
        );
      },
    },
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

  it('renders a prepared toolbar-click bootstrap without refetching page summary', async () => {
    const tab = {
      id: 45,
      url: 'https://example.com/prepared-popup',
      title: 'Untrimmed Browser Title',
    };
    const bootstrap = {
      mode: 'dashboard',
      connector: {
        success: true,
        state: 'connected',
        deviceId: 'test-device',
        hasToken: true,
      },
      tab,
      identity: {
        slug: 'prepared-popup',
        url: tab.url,
        title: 'Prepared Desktop Title',
      },
      summary: {
        success: true,
        url: tab.url,
        page: {
          slug: 'prepared-popup',
          url: tab.url,
          title: 'Prepared Desktop Title',
          visitDates: [20260617],
          likes: 1,
        },
        notes: [],
        snapshots: [],
        lists: [{ slug: 'reading', name: 'Reading', pins: [] }],
      },
    };
    installDom(
      'chrome-extension://abcdefghijklmnop/popup.html?bootstrap=token-1',
    );
    installChromeMock({
      tab,
      responses: {
        consumePopupBootstrap: (request) => {
          expect(request.token).toBe('token-1');
          return { success: true, bootstrap };
        },
        getPageSummary: () => {
          throw new Error('prepared popup should not refetch page summary');
        },
        getPopupLists: () => {
          throw new Error('prepared popup should not refetch popup lists');
        },
        readDesktopValue: { success: true, value: null },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageTitle').textContent ===
        'Prepared Desktop Title',
    );

    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('loading').style.display).toBe('none');
    expect(document.getElementById('setup-required').style.display).toBe(
      'none',
    );
    expect(document.getElementById('pageUrl').textContent).toBe(tab.url);
    expect(document.getElementById('listCount').textContent).toBe('00');
    expect(
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    ).toBe(false);
    expect(
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPopupLists',
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
    expect(document.body.classList.contains('popup-compact')).toBe(true);
    expect(getComputedStyle(document.body).minHeight).toBe('0');
    expect(document.getElementById('recordingBar')).toBeTruthy();
    expect(document.getElementById('recordingToggle')).toBeTruthy();
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
  });

  it('keeps paused popup compact and restores the active page non-progressively when recording resumes', async () => {
    const tab = {
      id: 44,
      url: 'https://example.com/resume-from-paused-popup',
      title: 'Resume From Paused Popup',
    };
    const pageSummary = deferred();
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
        getPageSummary: () => pageSummary.promise,
        getPopupLists: { success: true, lists: [] },
      },
    });
    sessionStore.workspace = { mode: 'private' };

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none',
    );
    expect(document.body.classList.contains('popup-compact')).toBe(true);
    expect(getComputedStyle(document.body).minHeight).toBe('0');
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

    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    );
    expect(document.body.classList.contains('popup-compact')).toBe(true);
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'none',
    );

    pageSummary.resolve({
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
    });

    await waitFor(
      () =>
        document.getElementById('dashboardContent').style.display === 'block',
    );
    expect(document.getElementById('dashboardContent')).toBeTruthy();
    expect(document.body.classList.contains('popup-compact')).toBe(false);
    expect(document.getElementById('pageTitle').textContent).toBe(tab.title);
  });

  it('disables resume while a pause command is still committing', async () => {
    const tab = {
      id: 47,
      url: 'https://example.com/rapid-pause-resume',
      title: 'Rapid Pause Resume',
    };
    const firstPauseSave = deferred();
    let saveCalls = 0;
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
        setRecordingPaused: async (request) => {
          saveCalls++;
          if (saveCalls === 1) await firstPauseSave.promise;
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

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('dashboardContent').style.display === 'block',
    );
    const toggle = document.getElementById('recordingToggle');
    toggle.click();

    await waitFor(() => toggle.disabled === true);
    toggle.click();

    await waitFor(() => saveCalls >= 1);
    expect(
      chrome.runtime.sendMessage.mock.calls.filter(
        ([request]) => request.action === 'setRecordingPaused',
      ),
    ).toEqual([[{ action: 'setRecordingPaused', paused: true }]]);

    firstPauseSave.resolve();

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none' &&
        toggle.disabled === false,
    );

    expect(
      chrome.runtime.sendMessage.mock.calls.filter(
        ([request]) => request.action === 'setRecordingPaused',
      ),
    ).toEqual([[{ action: 'setRecordingPaused', paused: true }]]);
    expect(document.body.classList.contains('popup-compact')).toBe(true);
  });

  it('ignores list mutations while a recording toggle is committing', async () => {
    const tab = {
      id: 53,
      url: 'https://example.com/locked-list-while-pausing',
      title: 'Locked List While Pausing',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const firstPauseSave = deferred();
    let saveCalls = 0;
    let toggleCalls = 0;
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
        setRecordingPaused: async (request) => {
          saveCalls++;
          if (saveCalls === 1) await firstPauseSave.promise;
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
            slug: pageSlug,
            url: tab.url,
            title: tab.title,
            visitDates: [],
          },
          notes: [],
          snapshots: [],
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: [],
            },
          ],
        },
        getPopupLists: {
          success: true,
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: [],
            },
          ],
        },
        toggleListPin: () => {
          toggleCalls++;
          return { success: true, pinned: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.list-chip'));
    const toggle = document.getElementById('recordingToggle');
    toggle.click();
    await waitFor(() => toggle.disabled === true);

    document.querySelector('.list-chip').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toggleCalls).toBe(0);

    firstPauseSave.resolve();
    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none',
    );
    expect(toggleCalls).toBe(0);
  });

  it('disables recording toggle while a list mutation is committing', async () => {
    const tab = {
      id: 54,
      url: 'https://example.com/locked-recording-while-pinning',
      title: 'Locked Recording While Pinning',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const listRefresh = deferred();
    let summaryCalls = 0;
    let pauseCalls = 0;
    let pinned = false;
    const currentLists = () => [
      {
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [{ kind: 'page', slug: pageSlug, pinnedAt: Date.now() }]
          : [],
      },
    ];
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
          pauseCalls++;
          sessionStore.workspace = request.paused ? { mode: 'private' } : {};
          return { success: true };
        },
        trimTitle: (request) => ({ title: request.title }),
        readDesktopValue: { success: true, value: null },
        getPageSummary: () => {
          summaryCalls++;
          if (summaryCalls === 2) return listRefresh.promise;
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

    await waitFor(() => document.querySelector('.list-chip'));
    document.querySelector('.list-chip').click();
    await waitFor(() => summaryCalls === 2);

    const recordingToggle = document.getElementById('recordingToggle');
    expect(recordingToggle.disabled).toBe(true);
    recordingToggle.click();
    expect(pauseCalls).toBe(0);

    listRefresh.resolve({
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

    await waitFor(() => recordingToggle.disabled === false);
    expect(pauseCalls).toBe(0);
  });

  it('locks the popup immediately when a page note blur queues a save', async () => {
    const tab = {
      id: 55,
      url: 'https://example.com/page-note-save-lock',
      title: 'Page Note Save Lock',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const noteSave = deferred();
    let toggleCalls = 0;
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
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: [],
            },
          ],
        },
        getPopupLists: {
          success: true,
          lists: [
            {
              slug: 'reading',
              name: 'Reading',
              pins: [],
            },
          ],
        },
        createNote: () => noteSave.promise,
        toggleListPin: () => {
          toggleCalls++;
          return { success: true, pinned: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('pageNoteAddBtn'));
    document.getElementById('pageNoteAddBtn').click();
    const textarea = document.querySelector('.page-note-edit-textarea');
    textarea.value = 'Queued note';
    textarea.blur();

    await waitFor(() => document.body.classList.contains('popup-ui-mutating'));
    expect(textarea.disabled).toBe(true);

    document.querySelector('.list-chip').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toggleCalls).toBe(0);

    noteSave.resolve({ success: true, noteSlug: 'note-queued' });
    await waitFor(() => !document.body.classList.contains('popup-ui-mutating'));
    expect(toggleCalls).toBe(0);
  });

  it('keeps the page note editor enabled during a focused debounced autosave', async () => {
    const tab = {
      id: 57,
      url: 'https://example.com/page-note-focused-autosave',
      title: 'Page Note Focused Autosave',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const noteSave = deferred();
    let createNoteCalls = 0;
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
          lists: [],
        },
        getPopupLists: { success: true, lists: [] },
        createNote: () => {
          createNoteCalls++;
          return noteSave.promise;
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('pageNoteAddBtn'));
    document.getElementById('pageNoteAddBtn').click();
    const textarea = document.querySelector('.page-note-edit-textarea');
    textarea.value = 'Focused autosave';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

    await waitFor(() => createNoteCalls === 1);
    expect(textarea.disabled).toBe(false);
    expect(document.body.classList.contains('popup-ui-mutating')).toBe(false);

    noteSave.resolve({ success: true, noteSlug: 'note-focused' });
    await waitFor(() => textarea.dataset.noteSlug === 'note-focused');
  });

  it('keeps the highlight note editor enabled during a focused debounced autosave', async () => {
    const tab = {
      id: 58,
      url: 'https://example.com/highlight-note-focused-autosave',
      title: 'Highlight Note Focused Autosave',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const noteSave = deferred();
    let updateNoteCalls = 0;
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
          success: true,
          url: tab.url,
          page: {
            slug: pageSlug,
            url: tab.url,
            title: tab.title,
            visitDates: [],
          },
          notes: [
            {
              slug: 'highlight-note',
              excerpt: 'Marked passage',
              note: 'Old note',
            },
          ],
          snapshots: [],
          lists: [],
        },
        getPopupLists: { success: true, lists: [] },
        updateNote: () => {
          updateNoteCalls++;
          return noteSave.promise;
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.highlight-item'));
    document.querySelector('.highlight-item .note-action-btn.edit').click();
    const textarea = document.querySelector('.highlight-note-edit-textarea');
    textarea.value = 'Focused highlight autosave';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

    await waitFor(() => updateNoteCalls === 1);
    expect(textarea.disabled).toBe(false);
    expect(document.body.classList.contains('popup-ui-mutating')).toBe(false);

    noteSave.resolve({ success: true, noteSlug: 'highlight-note' });
  });

  it('runs a delayed note autosave after an active list mutation completes', async () => {
    const tab = {
      id: 56,
      url: 'https://example.com/delayed-note-save-lock',
      title: 'Delayed Note Save Lock',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const listRefresh = deferred();
    let summaryCalls = 0;
    let updateNoteCalls = 0;
    let pinned = false;
    const currentLists = () => [
      {
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [{ kind: 'page', slug: pageSlug, pinnedAt: Date.now() }]
          : [],
      },
    ];
    const currentSummary = () => ({
      success: true,
      url: tab.url,
      page: {
        slug: pageSlug,
        url: tab.url,
        title: tab.title,
        visitDates: [],
      },
      notes: [
        {
          slug: 'highlight-note',
          excerpt: 'Marked passage',
          note: 'Old note',
        },
      ],
      snapshots: [],
      lists: currentLists(),
    });
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
          if (summaryCalls === 2) return listRefresh.promise;
          return currentSummary();
        },
        getPopupLists: () => ({ success: true, lists: currentLists() }),
        toggleListPin: () => {
          pinned = true;
          return { success: true, pinned: true };
        },
        updateNote: () => {
          updateNoteCalls++;
          return { success: true, noteSlug: 'highlight-note' };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.highlight-item'));
    document.querySelector('.highlight-item .note-action-btn.edit').click();
    const textarea = document.querySelector('.highlight-note-edit-textarea');
    textarea.value = 'New note';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

    document.querySelector('.list-chip').click();
    await waitFor(() => summaryCalls === 2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(updateNoteCalls).toBe(0);

    listRefresh.resolve(currentSummary());
    await waitFor(() => updateNoteCalls === 1);
  });

  it('disables pause while a resume render is still loading page data', async () => {
    const tab = {
      id: 48,
      url: 'https://example.com/resume-render-pending',
      title: 'Resume Render Pending',
    };
    const pageSummary = deferred();
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
        getPageSummary: () => pageSummary.promise,
        getPopupLists: { success: true, lists: [] },
      },
    });
    sessionStore.workspace = { mode: 'private' };

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none',
    );
    const toggle = document.getElementById('recordingToggle');
    toggle.click();

    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    );
    expect(toggle.disabled).toBe(true);
    toggle.click();
    expect(
      chrome.runtime.sendMessage.mock.calls.filter(
        ([request]) => request.action === 'setRecordingPaused',
      ),
    ).toEqual([[{ action: 'setRecordingPaused', paused: false }]]);

    pageSummary.resolve({
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
    });

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display ===
          'block' && toggle.disabled === false,
    );
    expect(document.body.classList.contains('popup-compact')).toBe(false);
  });

  it('ignores background mutation messages while a popup session is open', async () => {
    const tab = {
      id: 49,
      url: 'https://example.com/resume-mutation-race',
      title: 'Resume Mutation Race',
    };
    const resumeSummary = deferred();
    let summaryCalls = 0;
    const summaryPayload = {
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
    };
    installDom();
    const { sessionStore, runtimeMessages } = installChromeMock({
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
        getPageSummary: () => {
          summaryCalls++;
          if (summaryCalls === 2) return resumeSummary.promise;
          return summaryPayload;
        },
        getPopupLists: { success: true, lists: [] },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'block',
    );
    const toggle = document.getElementById('recordingToggle');
    toggle.click();
    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none',
    );
    toggle.click();
    await waitFor(() => summaryCalls === 2);

    runtimeMessages.emit({
      action: 'mutation',
      type: 'lists',
      url: tab.url,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(summaryCalls).toBe(2);

    resumeSummary.resolve(summaryPayload);

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display ===
          'block' && toggle.disabled === false,
    );
    expect(document.body.classList.contains('popup-compact')).toBe(false);
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
    expect(document.body.classList.contains('popup-compact')).toBe(true);
    expect(getComputedStyle(document.body).minHeight).toBe('0');
    expect(document.getElementById('recordingBar')).toBeTruthy();
    expect(document.getElementById('recordingToggle')).toBeTruthy();
    expect(document.getElementById('dashboardContent').style.display).toBe(
      'block',
    );
    expect(document.getElementById('pageDiagnosticSection').style.display).toBe(
      '',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Browser Recall',
    );
    const messageStyle = getComputedStyle(
      document.getElementById('pageDiagnosticTitle'),
    );
    expect(messageStyle.textTransform).toBe('uppercase');
    expect(messageStyle.fontWeight).toBe('900');
    expect(document.getElementById('recordingBar').nextElementSibling).toBe(
      document.getElementById('dashboardContent'),
    );
  });

  it('restores the unavailable admin page diagnostic after pause and resume', async () => {
    const tab = {
      id: 39,
      url: 'chrome://extensions/',
      title: 'Extensions',
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
        setRecordingPaused: (request) => {
          sessionStore.workspace = request.paused ? { mode: 'private' } : {};
          return { success: true };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Not available for this page',
    );
    const toggle = document.getElementById('recordingToggle');
    toggle.click();
    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'none',
    );
    toggle.click();

    await waitFor(
      () =>
        document.getElementById('dashboardContent')?.style.display === 'block',
    );

    expect(document.body.classList.contains('popup-compact')).toBe(true);
    expect(document.getElementById('pageDiagnosticSection').style.display).toBe(
      '',
    );
    expect(document.getElementById('pageDiagnosticTitle').textContent).toBe(
      'Not available for this page',
    );
    expect(document.getElementById('pageHeader').style.display).toBe('none');
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
      'DESKTOP OFFLINE',
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
                      kind: 'page',
                      slug: generateSlugFromUrl(tab.url),
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

  it('keeps the static ticket shell visible while desktop state probing is still pending', async () => {
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
    expect(document.documentElement.style.opacity).not.toBe('0');
    expect(document.documentElement.dataset.popupHidden).toBeUndefined();
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe(
      'rgb(247, 244, 234)',
    );
    expect(getComputedStyle(document.body).width).toBe('296px');
    expect(getComputedStyle(document.body).minHeight).toBe('320px');
    expect(document.getElementById('loading').style.display).toBe('none');
    expect(document.getElementById('setup-required').style.display).toBe(
      'none',
    );
    expect(document.getElementById('dashboard').style.display).toBe('');
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Browser Recall',
    );

    connectorState.resolve({
      success: true,
      state: 'offline',
      hasToken: true,
    });
    await waitFor(
      () => document.getElementById('setup-required').style.display === 'block',
    );
    expect(document.documentElement.dataset.popupHidden).toBeUndefined();
  });

  it('keeps the connected ticket shell visible while page details are still loading', async () => {
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
        getPopupLists: {
          success: true,
          lists: [{ slug: 'reading', name: 'Reading', pins: [] }],
        },
      },
    });

    await import('../../apps/extension/popup.js');
    await waitFor(() =>
      chrome.runtime.sendMessage.mock.calls.some(
        ([request]) => request.action === 'getPageSummary',
      ),
    );

    expect(document.documentElement.style.opacity).not.toBe('0');
    expect(document.documentElement.dataset.popupHidden).toBeUndefined();
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe(
      'rgb(247, 244, 234)',
    );
    expect(getComputedStyle(document.body).width).toBe('296px');
    expect(getComputedStyle(document.body).minHeight).toBe('320px');
    expect(document.getElementById('loading').style.display).toBe('none');
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
      lists: [{ slug: 'reading', name: 'Reading', pins: [] }],
    });

    await waitFor(
      () =>
        document.getElementById('pageTitle').textContent === 'Desktop Title',
    );
    expect(document.documentElement.style.opacity).toBe('');
    expect(document.getElementById('pageTitle').textContent).toBe(
      'Desktop Title',
    );
    await waitFor(() =>
      document.getElementById('listChips').textContent.includes('Reading'),
    );
    expect(document.getElementById('dashboard').style.display).toBe('flex');
    expect(document.getElementById('listSection').style.display).toBe('');
    expect(document.getElementById('notesSection').style.display).toBe('');
    expect(document.getElementById('snapshotSection').style.display).toBe('');
  });

  it('uses page summary lists during startup without a separate list read', async () => {
    const tab = {
      id: 45,
      url: 'https://example.com/summary-list-fallback',
      title: 'Summary List Fallback',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let popupListCalls = 0;

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
          lists: [
            {
              slug: 'summary-list',
              name: 'Summary List',
              pins: [{ kind: 'page', slug: pageSlug, pinnedAt: Date.now() }],
            },
          ],
        },
        getPopupLists: () => {
          popupListCalls++;
          return { success: false, error: 'Temporary list read failure' };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() =>
      document.getElementById('listChips').textContent.includes('Summary List'),
    );
    expect(popupListCalls).toBe(0);
    expect(document.getElementById('listChips').textContent).toContain(
      'Summary List',
    );
    expect(document.querySelector('.list-chip.selected')).toBeTruthy();
  });

  it('does not render delayed fast list chips after page summary fails', async () => {
    const tab = {
      id: 46,
      url: 'https://example.com/failed-summary-delayed-lists',
      title: 'Failed Summary Delayed Lists',
    };
    const popupLists = deferred();

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
          error: 'Desktop page summary failed',
        },
        getPopupLists: () => popupLists.promise,
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(
      () =>
        document.getElementById('pageDiagnosticTitle').textContent ===
        'Page Data Unavailable',
    );

    popupLists.resolve({
      success: true,
      lists: [{ slug: 'late-list', name: 'Late List', pins: [] }],
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(document.getElementById('listSection').style.display).toBe('none');
    expect(document.getElementById('listChips').textContent).not.toContain(
      'Late List',
    );
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
                      kind: 'page',
                      slug: generateSlugFromUrl(tab.url),
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
                      kind: 'page',
                      slug: generateSlugFromUrl(tab.url),
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
                kind: 'page',
                slug: pageSlug,
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

  it('refreshes hidden chips after toggling a filtered picker row even if summary refresh stalls', async () => {
    const tab = {
      id: 56,
      url: 'https://example.com/picker-hidden-chip-refresh',
      title: 'Picker Hidden Chip Refresh',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let pinned = false;
    let summaryCalls = 0;
    const stalledSummary = deferred();
    const currentLists = () => {
      const lists = [];
      for (let index = 0; index < 10; index += 1) {
        lists.push({
          slug: `extra-${index + 1}`,
          name: `Extra ${index + 1}`,
          pins: [
            {
              kind: 'page',
              slug: pageSlug,
              pinnedAt: Date.now(),
            },
          ],
        });
      }
      lists.push({
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [
              {
                kind: 'page',
                slug: pageSlug,
                pinnedAt: Date.now(),
              },
            ]
          : [],
      });
      return lists;
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
    expect(document.getElementById('listChips').textContent).not.toContain(
      'Reading',
    );
    document.getElementById('listAddBtn').click();
    await waitFor(() => document.getElementById('listSearchInput'));
    const input = document.getElementById('listSearchInput');
    input.value = 'Reading';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => document.querySelector('.list-picker-row'));
    document.querySelector('.list-picker-row').click();
    await waitFor(() => summaryCalls === 2);

    await waitFor(() =>
      document.querySelector('#listChips .list-chip[data-list-id="reading"]'),
    );
    expect(document.getElementById('listCount').textContent).toBe('11');
  });

  it('keeps list count accurate when a hidden pinned list is toggled', async () => {
    const tab = {
      id: 54,
      url: 'https://example.com/hidden-pin-count',
      title: 'Hidden Pin Count',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    const currentLists = () => {
      const lists = [
        {
          slug: 'reading',
          name: 'Reading',
          pins: [
            {
              kind: 'page',
              slug: pageSlug,
              pinnedAt: Date.now(),
            },
          ],
        },
      ];
      for (let index = 0; index < 10; index += 1) {
        lists.push({
          slug: `extra-${index + 1}`,
          name: `Extra ${index + 1}`,
          pins: [
            {
              kind: 'page',
              slug: pageSlug,
              pinnedAt: Date.now(),
            },
          ],
        });
      }
      return lists;
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
        getPageSummary: () => ({
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
        }),
        getPopupLists: () => ({ success: true, lists: currentLists() }),
        toggleListPin: () => ({ success: true, pinned: false }),
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.list-chip'));
    expect(document.getElementById('listCount').textContent).toBe('11');
    document.querySelector('.list-chip').click();
    await waitFor(() => document.querySelector('.list-chip:not(.selected)'));
    expect(document.getElementById('listCount').textContent).toBe('10');
  });

  it('keeps the chip strip in sync after exact-match picker toggles a hidden list', async () => {
    const tab = {
      id: 55,
      url: 'https://example.com/exact-match-hidden-chip',
      title: 'Exact Match Hidden Chip',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let pinned = false;
    const currentLists = () => {
      const lists = [];
      for (let index = 0; index < 10; index += 1) {
        lists.push({
          slug: `extra-${index + 1}`,
          name: `Extra ${index + 1}`,
          pins: [
            {
              kind: 'page',
              slug: pageSlug,
              pinnedAt: Date.now(),
            },
          ],
        });
      }
      lists.push({
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [
              {
                kind: 'page',
                slug: pageSlug,
                pinnedAt: Date.now(),
              },
            ]
          : [],
      });
      return lists;
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
        getPageSummary: () => ({
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
        }),
        getPopupLists: () => ({ success: true, lists: currentLists() }),
        toggleListPin: () => {
          pinned = !pinned;
          return { success: true, pinned };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.getElementById('listAddBtn'));
    document.getElementById('listAddBtn').click();
    await waitFor(() => document.getElementById('listSearchInput'));
    const input = document.getElementById('listSearchInput');
    input.value = 'Reading';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitFor(() => document.querySelector('.list-picker-row'));
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );

    await waitFor(() => document.querySelector('.list-chip'));
    expect(document.getElementById('listCount').textContent).toBe('10');
  });

  it('keeps the same chip node when toggling a list', async () => {
    const tab = {
      id: 53,
      url: 'https://example.com/chip-node-stability',
      title: 'Chip Node Stability',
    };
    const pageSlug = generateSlugFromUrl(tab.url);
    let pinned = false;
    const currentLists = () => [
      {
        slug: 'reading',
        name: 'Reading',
        pins: pinned
          ? [
              {
                kind: 'page',
                slug: pageSlug,
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
        getPageSummary: () => ({
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
        }),
        getPopupLists: () => ({ success: true, lists: currentLists() }),
        toggleListPin: () => {
          pinned = !pinned;
          return { success: true, pinned };
        },
      },
    });

    await import('../../apps/extension/popup.js');

    await waitFor(() => document.querySelector('.list-chip'));
    const listChips = document.getElementById('listChips');
    const chipBefore = document.querySelector('.list-chip');
    chipBefore.click();
    await waitFor(() => document.querySelector('.list-chip.selected'));
    const chipAfter = document.querySelector('.list-chip.selected');

    expect(chipAfter).toBe(chipBefore);
    expect(listChips.querySelectorAll('.list-chip')).toHaveLength(1);
  });
});
