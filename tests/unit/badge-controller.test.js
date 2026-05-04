import { describe, expect, it, vi } from 'vitest';

import { createBadgeController } from '../../apps/extension/badge-controller.js';

const NORMAL_ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
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
      capabilities: overrides.capabilities || { usesIconPageMarker: false },
      logDebug: () => {},
      normalIconPaths: NORMAL_ICON_PATHS,
      syncDesktopConnectorPauseState: vi.fn(),
      readDesktopValue: overrides.readDesktopValue || vi.fn(async () => null),
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
    expect(api.action.setBadgeBackgroundColor).not.toHaveBeenCalledWith({
      color: '#9C27B0',
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

  it('applies page marker color from page relations only when connected', async () => {
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

    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#9C27B0',
      tabId: 22,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: ' ',
      tabId: 22,
    });
  });

  it('uses resolved tab identity before applying a Chrome-style page marker', async () => {
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
    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#4CAF50',
      tabId: 22,
    });
    expect(api.action.setBadgeText).toHaveBeenCalledWith({
      text: ' ',
      tabId: 22,
    });
    expect(api.action.setIcon).not.toHaveBeenCalledWith(
      expect.objectContaining({
        imageData: expect.anything(),
        tabId: 22,
      }),
    );
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
      ([details]) => details.text === ' ' && details.tabId === 7,
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

    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#4A90D9',
      tabId: 27,
    });
  });

  it('uses combined marker color for a list and visible snapshot cleanup ref', async () => {
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

    expect(api.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#9C27B0',
      tabId: 28,
    });
  });

  it('generates Firefox page marker icons without fetching extension resources', async () => {
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      throw new Error('scheme handler failed');
    });

    class FakeOffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return {
          beginPath: vi.fn(),
          arc: vi.fn(),
          clearRect: vi.fn(),
          fill: vi.fn(),
          lineTo: vi.fn(),
          moveTo: vi.fn(),
          stroke: vi.fn(),
          getImageData: vi.fn(() => ({
            width: this.width,
            height: this.height,
            data: new Uint8ClampedArray(this.width * this.height * 4),
          })),
        };
      }
    }

    globalThis.OffscreenCanvas = FakeOffscreenCanvas;
    globalThis.fetch = fetchMock;
    try {
      const { api, controller } = createController({
        capabilities: { usesIconPageMarker: true },
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
        imageData: {
          16: expect.objectContaining({ width: 16, height: 16 }),
          48: expect.objectContaining({ width: 48, height: 48 }),
          128: expect.objectContaining({ width: 128, height: 128 }),
        },
        tabId: 26,
      });
    } finally {
      globalThis.OffscreenCanvas = originalOffscreenCanvas;
      globalThis.fetch = originalFetch;
    }
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
