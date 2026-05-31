import { describe, expect, it, vi } from 'vitest';

import { createBadgeController } from '../../apps/extension/badge-controller.js';

const NORMAL_ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const SPECIAL_LIST_ICON_PATHS = {
  16: 'icons/icon16-special-lists.png',
  48: 'icons/icon48-special-lists.png',
  128: 'icons/icon128-special-lists.png',
};

const SPECIAL_NOTE_ICON_PATHS = {
  16: 'icons/icon16-special-notes.png',
  48: 'icons/icon48-special-notes.png',
  128: 'icons/icon128-special-notes.png',
};

const SPECIAL_MIXED_ICON_PATHS = {
  16: 'icons/icon16-special-mixed.png',
  48: 'icons/icon48-special-mixed.png',
  128: 'icons/icon128-special-mixed.png',
};

const STOP_RECORDING_ICON_PATHS = {
  16: 'icons/icon16-stop-recording.png',
  48: 'icons/icon48-stop-recording.png',
  128: 'icons/icon128-stop-recording.png',
};

function createApi({
  activeTab = { id: 7, url: 'https://example.test/' },
} = {}) {
  return {
    action: {
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setBadgeText: vi.fn(async () => {}),
      setIcon: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
    runtime: {
      getURL: (resource) => `chrome-extension://test/${resource}`,
    },
    tabs: {
      query: vi.fn(async (query) => {
        if (query?.active) return [activeTab];
        return [];
      }),
    },
  };
}

function createController(overrides = {}) {
  const api = overrides.api || createApi({ activeTab: overrides.activeTab });
  return {
    api,
    controller: createBadgeController({
      api,
      logDebug: () => {},
      normalIconPaths: NORMAL_ICON_PATHS,
      stoppedRecordingIconPaths: STOP_RECORDING_ICON_PATHS,
      specialListIconPaths: SPECIAL_LIST_ICON_PATHS,
      specialNoteIconPaths: SPECIAL_NOTE_ICON_PATHS,
      specialMixedIconPaths: SPECIAL_MIXED_ICON_PATHS,
      syncDesktopConnectorPauseState: vi.fn(),
      readDesktopValue: overrides.readDesktopValue || vi.fn(async () => null),
      readRecordingPausedState:
        overrides.readRecordingPausedState || vi.fn(async () => false),
      generateSlugFromUrl: (url) => new URL(url).hostname,
      pageKey: (slug) => `page:${slug}`,
      notePrefix: 'note:',
      snapshotPrefix: 'snapshot:',
      listPrefix: 'list:',
      resolveTabUrl: overrides.resolveTabUrl,
    }),
  };
}

describe('badge controller', () => {
  it('clears the global connector badge when the desktop connector is available', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    expect(api.action.setTitle).toHaveBeenCalledWith({
      title: 'Browser Recall',
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: NORMAL_ICON_PATHS,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
    });
  });

  it('shows a global offline badge and clears the active page marker', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({
      state: 'offline',
      lastDiagnostic: { code: 'socket_closed' },
    });

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: NORMAL_ICON_PATHS,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
      tabId: 7,
    });
  });

  it('clears tab page markers and leaves the global offline badge alone while offline', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({ state: 'offline' });
    await controller.updateBadgeForTab(12, 'https://example.test/page');

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
      tabId: 12,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith({
      path: SPECIAL_MIXED_ICON_PATHS,
      tabId: 12,
    });
  });

  it('clears badges for non-page tabs', async () => {
    const { api, controller } = createController();

    await controller.updateBadgeForTab(21, 'about:newtab');

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: NORMAL_ICON_PATHS,
      tabId: 21,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
      tabId: 21,
    });
  });

  it('applies the mixed special icon without a legacy badge overlay', async () => {
    const { api, controller } = createController({
      readDesktopValue: vi.fn(async () => ({
        childIds: ['note:1'],
        parentIds: ['list:1'],
      })),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    await controller.updateBadgeForTab(22, 'https://example.test/page');

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
      tabId: 22,
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: SPECIAL_MIXED_ICON_PATHS,
      tabId: 22,
    });
    expect(api.action.setBadgeBackgroundColor).not.toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 22 }),
    );
  });

  it('uses resolved tab identity before applying a list special icon', async () => {
    const readDesktopValue = vi.fn(async (key) =>
      key === 'page:original.example.test'
        ? {
            childIds: [],
            parentIds: ['list:1'],
          }
        : null,
    );
    const { api, controller } = createController({
      activeTab: {
        id: 22,
        url: 'https://mutated.example.test/page?tab=comments',
      },
      readDesktopValue,
      resolveTabUrl: vi.fn(() => 'https://original.example.test/page'),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    await controller.refreshActiveTabBadge();

    expect(readDesktopValue).toHaveBeenCalledWith('page:original.example.test');
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
      tabId: 22,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith(
      expect.objectContaining({
        imageData: expect.anything(),
        tabId: 22,
      }),
    );
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: SPECIAL_LIST_ICON_PATHS,
      tabId: 22,
    });
  });

  it('refreshes the active page marker after clearing the global connected badge', async () => {
    const { api, controller } = createController({
      readDesktopValue: vi.fn(async () => ({
        childIds: [],
        parentIds: ['list:1'],
      })),
    });

    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    const globalClearIndex = api.action.setBadgeText.mock.calls.findIndex(
      ([details]) => details.text === '' && details.tabId == null,
    );
    const pageMarkerIndex = api.action.setBadgeText.mock.calls.findIndex(
      ([details]) => details.text === '' && details.tabId === 7,
    );
    expect(globalClearIndex).toBeGreaterThanOrEqual(0);
    expect(pageMarkerIndex).toBeGreaterThan(globalClearIndex);
  });

  it('keeps the snapshot marker for visible snapshot refs without backing files', async () => {
    const { api, controller } = createController({
      readDesktopValue: vi.fn(async () => ({
        childIds: ['snapshot:example.test-1710000000000'],
        parentIds: [],
      })),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    await controller.updateBadgeForTab(27, 'https://example.test/page');

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
      tabId: 27,
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: SPECIAL_NOTE_ICON_PATHS,
      tabId: 27,
    });
  });

  it('uses the mixed special icon for a list and visible snapshot cleanup ref', async () => {
    const { api, controller } = createController({
      readDesktopValue: vi.fn(async () => ({
        childIds: ['snapshot:example.test-1710000000000'],
        parentIds: ['list:1'],
      })),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });

    await controller.updateBadgeForTab(28, 'https://example.test/page');

    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '',
      tabId: 28,
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: SPECIAL_MIXED_ICON_PATHS,
      tabId: 28,
    });
  });

  it('uses the packaged special icon without fetching extension resources', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      throw new Error('scheme handler failed');
    });
    globalThis.fetch = fetchMock;
    try {
      const { api, controller } = createController({
        readDesktopValue: vi.fn(async () => ({
          childIds: ['note:1'],
          parentIds: [],
        })),
      });
      await controller.setConnectorState({
        state: 'connected',
        deviceId: 'device-1',
      });

      await controller.updateBadgeForTab(26, 'https://example.test/page');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(api.action.setBadgeText).toHaveBeenCalledWith({
        text: '',
        tabId: 26,
      });
      expect(api.action.setIcon).toHaveBeenCalledWith({
        path: SPECIAL_NOTE_ICON_PATHS,
        tabId: 26,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the stopped recording icon while recording is paused', async () => {
    const { api, controller } = createController({
      readDesktopValue: vi.fn(async () => ({
        childIds: ['note:1'],
        parentIds: [],
      })),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });
    api.action.setBadgeText.mockClear();
    api.action.setIcon.mockClear();

    await controller.setRecordingPaused(true);
    await controller.updateBadgeForTab(7, 'https://example.test/page');

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
      tabId: 7,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith({
      path: SPECIAL_NOTE_ICON_PATHS,
      tabId: 7,
    });
  });

  it('replaces a stale special icon on a background tab while recording is paused', async () => {
    const { api, controller } = createController({
      activeTab: { id: 7, url: 'https://active.example.test/' },
      readDesktopValue: vi.fn(async () => ({
        childIds: ['note:1'],
        parentIds: [],
      })),
    });
    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });
    await controller.updateBadgeForTab(12, 'https://example.test/page');
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: SPECIAL_NOTE_ICON_PATHS,
      tabId: 12,
    });
    api.action.setIcon.mockClear();

    await controller.setRecordingPaused(true);
    await controller.updateBadgeForTab(12, 'https://example.test/page');

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
      tabId: 12,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith({
      path: SPECIAL_NOTE_ICON_PATHS,
      tabId: 12,
    });
  });

  it('hydrates recording pause state before startup connector badge refreshes', async () => {
    const { api, controller } = createController({
      readRecordingPausedState: vi.fn(async () => true),
      readDesktopValue: vi.fn(async () => ({
        childIds: ['note:1'],
        parentIds: [],
      })),
    });

    await controller.setConnectorState({
      state: 'connected',
      deviceId: 'device-1',
    });
    await controller.updateBadgeForTab(7, 'https://example.test/page');

    expect(api.action.setTitle).toHaveBeenCalledWith({
      title: 'Browser Recall recording is paused',
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
    });
    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
      tabId: 7,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith({
      path: SPECIAL_NOTE_ICON_PATHS,
      tabId: 7,
    });
  });

  it('keeps the recording pause icon when service pause starts while recording is paused', async () => {
    const { api, controller } = createController();

    await controller.setRecordingPaused(true);
    api.action.setIcon.mockClear();
    api.action.setBadgeText.mockClear();

    await controller.setServicePaused({ title: 'Storage full' });

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: STOP_RECORDING_ICON_PATHS,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(api.action.setIcon).not.toHaveBeenCalledWith({
      path: NORMAL_ICON_PATHS,
    });
    expect(api.action.setBadgeText).not.toHaveBeenCalledWith({ text: '!' });
  });

  it('restores the service pause badge when recording resumes during service pause', async () => {
    const { api, controller } = createController();

    await controller.setServicePaused({ title: 'Storage full' });
    await controller.setRecordingPaused(true);
    api.action.setIcon.mockClear();
    api.action.setBadgeText.mockClear();
    api.action.setTitle.mockClear();

    await controller.setRecordingPaused(false);

    expect(api.action.setIcon).toHaveBeenCalledWith({
      path: NORMAL_ICON_PATHS,
    });
    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#B85040',
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(api.action.setTitle).toHaveBeenCalledWith({
      title: 'Storage full',
    });
  });

  it('leaves the global badge unchanged during startup or connecting without offline evidence', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({ state: 'starting' });
    await controller.setConnectorState({ state: 'connecting' });

    expect(api.action.setBadgeText).not.toHaveBeenCalledWith({ text: '!' });
  });

  it('preserves a cached global offline badge while reconnecting', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({ state: 'offline' });
    await controller.setConnectorState({ state: 'connecting' });
    await controller.updateBadgeForTab(23, 'about:newtab');

    expect(api.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
      tabId: 23,
    });
  });

  it('renders an explicit offline badge on special pages instead of relying on null inheritance', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({ state: 'offline' });
    await controller.updateBadgeForTab(24, 'about:preferences');

    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#B85040',
      tabId: 24,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
      tabId: 24,
    });
  });

  it('still renders an offline badge on special pages when the tab icon update fails', async () => {
    const api = createApi();
    api.action.setIcon = vi.fn(async (details) => {
      if (details?.tabId) throw new Error('tab icon unavailable');
    });
    const { controller } = createController({ api });

    await controller.setConnectorState({ state: 'offline' });
    await controller.updateBadgeForTab(25, 'about:preferences');

    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#B85040',
      tabId: 25,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: '!',
      tabId: 25,
    });
  });

  it('shows the global offline badge immediately after a socket close while reconnecting', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({
      state: 'connecting',
      lastDiagnostic: { code: 'socket_closed' },
    });

    expect(api.action.setBadgeText).toHaveBeenCalledWith({ text: '!' });
  });

  it('clears the service pause badge when service resumes during startup', async () => {
    const { api, controller } = createController();

    await controller.setConnectorState({ state: 'starting' });
    await controller.setServicePaused({ title: 'Storage full' });
    await controller.setServiceActive();

    expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
    expect(api.action.setTitle).toHaveBeenLastCalledWith({
      title: 'Browser Recall',
    });
  });
});
