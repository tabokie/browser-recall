import { test, expect } from '@playwright/test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { generateSlugFromUrl } from '../../packages/core/page-identity.js';

import {
  cleanupStagedAssets,
  stageFirefoxExtensionAssets,
} from '../../scripts/stage-app-assets.mjs';

const FIREFOX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0';
const EN_MESSAGES = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/core/locales/en/messages.json'),
    'utf8',
  ),
);

function createEnglishI18n() {
  return {
    getUILanguage: () => 'en',
    getMessage(key, substitutions = []) {
      const values = Array.isArray(substitutions)
        ? substitutions
        : [substitutions];
      return (EN_MESSAGES[key]?.message || '').replace(
        /\$(\d+)/g,
        (match, index) => values[Number(index) - 1] ?? match,
      );
    },
  };
}

function navigatorWithUserAgent(base, userAgent) {
  return Object.create(base || {}, {
    userAgent: {
      configurable: true,
      value: userAgent,
    },
  });
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    listenerCount() {
      return listeners.size;
    },
    async dispatch(...args) {
      const results = [];
      for (const listener of [...listeners]) {
        results.push(await listener(...args));
      }
      return results;
    },
    listeners,
  };
}

function normalizeStorageKeys(keys, data) {
  if (keys == null) return Object.keys(data);
  if (Array.isArray(keys)) return keys;
  if (typeof keys === 'string') return [keys];
  if (typeof keys === 'object') return Object.keys(keys);
  return [];
}

function createStorageArea(areaName, storageChanged, seed = {}) {
  const data = { ...seed };
  return {
    _data: data,
    async get(keys) {
      const result = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
        Object.assign(result, keys);
      }
      for (const key of normalizeStorageKeys(keys, data)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          result[key] = data[key];
        }
      }
      return result;
    },
    async set(patch) {
      const changes = {};
      for (const [key, newValue] of Object.entries(patch || {})) {
        const oldValue = data[key];
        if (Object.is(oldValue, newValue)) continue;
        data[key] = newValue;
        changes[key] = { oldValue, newValue };
      }
      if (Object.keys(changes).length > 0) {
        await storageChanged.dispatch(changes, areaName);
      }
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        changes[key] = { oldValue: data[key], newValue: undefined };
        delete data[key];
      }
      if (Object.keys(changes).length > 0) {
        await storageChanged.dispatch(changes, areaName);
      }
    },
    async clear() {
      const changes = {};
      for (const [key, oldValue] of Object.entries(data)) {
        changes[key] = { oldValue, newValue: undefined };
        delete data[key];
      }
      if (Object.keys(changes).length > 0) {
        await storageChanged.dispatch(changes, areaName);
      }
    },
  };
}

function createFirefoxWebExtensionApi({
  sendMessage,
  onOpenOptionsPage,
  onSendMessage,
  i18n = createEnglishI18n(),
} = {}) {
  const storageChanged = createEvent();
  const runtimeMessage = createEvent();
  const runtimeConnect = createEvent();
  const runtimeInstalled = createEvent();
  const runtimeStartup = createEvent();
  const actionClicked = createEvent();

  const storage = {
    onChanged: storageChanged,
    local: null,
    session: null,
    sync: null,
  };
  storage.local = createStorageArea('local', storageChanged);
  storage.session = createStorageArea('session', storageChanged);
  storage.sync = createStorageArea('sync', storageChanged);
  const badgeState = {
    global: { text: '', color: '#000000', title: '', icon: null },
    tabs: new Map(),
  };
  const actionPopupState = {
    openCount: 0,
    popupByTab: new Map(),
  };
  const contextMenuItems = new Map();

  function assertFirefoxArgs(methodName, args, expectedLength) {
    if (args.length !== expectedLength) {
      throw new TypeError(
        `${methodName} expected ${expectedLength} argument(s), got ${args.length}`,
      );
    }
  }

  function badgeTarget(details = {}) {
    if (details.tabId == null) return badgeState.global;
    if (!badgeState.tabs.has(details.tabId)) {
      badgeState.tabs.set(details.tabId, { ...badgeState.global });
    }
    return badgeState.tabs.get(details.tabId);
  }

  const runtimeSendMessage =
    sendMessage ||
    (async (message, sender = {}) => {
      onSendMessage?.(message);
      for (const listener of [...runtimeMessage.listeners]) {
        let settled = false;
        let callbackResponse;
        const callbackPromise = new Promise((resolve) => {
          const sendResponse = (response) => {
            settled = true;
            callbackResponse = response;
            resolve(response);
          };
          const result = listener(message, sender, sendResponse);
          if (result === true) return;
          if (result?.then) {
            result.then(resolve, resolve);
            return;
          }
          resolve(settled ? callbackResponse : undefined);
        });
        const response = await callbackPromise;
        if (response !== undefined || settled) return response;
      }
      return undefined;
    });

  const browserApi = {
    badgeState,
    i18n,
    action: {
      onClicked: actionClicked,
      async setBadgeBackgroundColor(details) {
        assertFirefoxArgs('setBadgeBackgroundColor', arguments, 1);
        badgeTarget(details).color = details.color;
      },
      async setBadgeText(details) {
        assertFirefoxArgs('setBadgeText', arguments, 1);
        badgeTarget(details).text = details.text;
      },
      async setIcon(details) {
        assertFirefoxArgs('setIcon', arguments, 1);
        badgeTarget(details).icon = details.imageData || details.path || null;
      },
      async setTitle(details) {
        assertFirefoxArgs('setTitle', arguments, 1);
        badgeTarget(details).title = details.title;
      },
      async getBadgeBackgroundColor(details = {}) {
        assertFirefoxArgs('getBadgeBackgroundColor', arguments, 1);
        return badgeTarget(details).color;
      },
      async getBadgeText(details = {}) {
        assertFirefoxArgs('getBadgeText', arguments, 1);
        return badgeTarget(details).text;
      },
    },
    alarms: {
      onAlarm: createEvent(),
      async clear() {
        return true;
      },
      async create() {},
    },
    commands: {
      onCommand: createEvent(),
      async getAll() {
        return [];
      },
    },
    contextMenus: {
      onClicked: createEvent(),
      async removeAll() {
        contextMenuItems.clear();
      },
      async create(item) {
        contextMenuItems.set(item.id, { ...item });
        return item.id;
      },
      async update(id, patch) {
        if (!contextMenuItems.has(id)) {
          throw new Error(`Unknown context menu: ${id}`);
        }
        contextMenuItems.set(id, {
          ...contextMenuItems.get(id),
          ...patch,
        });
      },
    },
    runtime: {
      id: 'browser-recall@example.invalid',
      onConnect: runtimeConnect,
      onInstalled: runtimeInstalled,
      onMessage: runtimeMessage,
      onStartup: runtimeStartup,
      async getBrowserInfo() {
        return { name: 'Firefox', vendor: 'Mozilla' };
      },
      getManifest() {
        return { manifest_version: 3, name: 'browser-recall' };
      },
      getURL(resourcePath) {
        return `moz-extension://browser-recall.invalid/${resourcePath}`;
      },
      async openOptionsPage() {
        onOpenOptionsPage?.();
      },
      reload() {},
      sendMessage: runtimeSendMessage,
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
    storage,
    tabs: {
      onActivated: createEvent(),
      onRemoved: createEvent(),
      async create({ url } = {}) {
        return { id: 99, url };
      },
      async get(tabId) {
        return { id: tabId, url: 'https://example.test/', title: 'Example' };
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return {};
      },
      async update(tabId, patch = {}) {
        return { id: tabId, ...patch };
      },
    },
    webNavigation: {
      onCommitted: createEvent(),
      onCreatedNavigationTarget: createEvent(),
    },
  };

  Object.defineProperties(browserApi.action, {
    setPopup: {
      configurable: true,
      async value(details) {
        if (this !== browserApi.action) {
          throw new TypeError('setPopup requires the Firefox action receiver');
        }
        actionPopupState.popupByTab.set(details.tabId, details.popup);
      },
    },
    openPopup: {
      configurable: true,
      async value() {
        if (this !== browserApi.action) {
          throw new TypeError('openPopup requires the Firefox action receiver');
        }
        actionPopupState.openCount += 1;
      },
    },
  });

  return {
    browserApi,
    chromeCompat: {
      storage: {
        local: {},
        session: {},
        sync: {},
      },
    },
    events: {
      actionClicked,
      runtimeInstalled,
      runtimeConnect,
      runtimeMessage,
      runtimeStartup,
      storageChanged,
    },
    storage,
    badgeState,
    actionPopupState,
    contextMenuItems,
  };
}

class FailingWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FailingWebSocket.CONNECTING;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = FailingWebSocket.CLOSED;
      this.#emit('error', {});
      this.#emit('close', {});
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send() {}

  close() {
    this.readyState = FailingWebSocket.CLOSED;
    this.#emit('close', {});
  }

  #emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

class SuccessfulWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static entityForKey = (key) =>
    key?.startsWith('page:')
      ? {
          url: 'https://example.test/marked',
          childIds: ['note:smoke'],
          parentIds: [],
        }
      : null;

  constructor(url) {
    this.url = url;
    this.readyState = SuccessfulWebSocket.CONNECTING;
    this.listeners = new Map();
    SuccessfulWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = SuccessfulWebSocket.OPEN;
      this.#emit('open', {});
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(raw) {
    const payload = JSON.parse(raw);
    if (payload.type === 'auth') {
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({ type: 'auth_ok', protocolVersion: 3 }),
        }),
      );
      return;
    }
    if (payload.type === 'get_status') {
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'status',
            deviceId: 'firefox-device',
            maxMessageBytes: 64 * 1024 * 1024,
            authority: { state: 'running' },
          }),
        }),
      );
      return;
    }
    if (payload.type === 'get_settings') {
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'settings_result',
            success: true,
            settings: {
              theme: 'system',
              colorScheme: 'amber',
              localeOverride: 'system',
              historyFileBatch: 10,
              captureSnapshotVideo: false,
              blacklistEnabled: true,
              urlBlacklist: ['chrome://', 'edge://', 'about:'],
              titleCleanupEnabled: true,
              titleTrimRules: [],
              syncEnabled: false,
              syncMethod: 'github',
              syncRepoUrl: '',
              syncRetentionDays: 7,
            },
            error: null,
          }),
        }),
      );
      return;
    }
    if (payload.type === 'get_page_summary') {
      const slug = generateSlugFromUrl(payload.url);
      const page = SuccessfulWebSocket.entityForKey(`page:${slug}`);
      const notes = (page?.childIds || [])
        .filter((id) => id.startsWith('note:'))
        .map((id) => ({ slug: id.slice('note:'.length) }));
      const snapshots = (page?.childIds || [])
        .filter((id) => id.startsWith('snapshot:'))
        .map((id) => ({ slug: id.slice('snapshot:'.length) }));
      const lists = (page?.parentIds || [])
        .filter((id) => id.startsWith('list:'))
        .map((id) => ({
          slug: id.slice('list:'.length),
          name: id.slice('list:'.length),
          containsPage: true,
          lastActivity: 0,
        }));
      const projectedPage = page
        ? {
            slug,
            url: page.url,
            title: page.title || null,
            user_title: null,
            scrollDepth: null,
            timeOnPage: null,
            likes: null,
            visitDates: [],
            timestamps: { 'firefox-device': Date.now() },
          }
        : null;
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'page_summary_result',
            success: true,
            url: payload.url,
            displayTitle: page?.title || payload.title || '',
            access: {
              blacklisted: false,
              hasVisitHistory: Boolean(page),
            },
            page: projectedPage,
            notes,
            snapshots,
            lists,
            attention: null,
            error: null,
          }),
        }),
      );
      return;
    }
    if (payload.type === 'get_entity') {
      const entity = SuccessfulWebSocket.entityForKey(payload.key);
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'entity_result',
            success: true,
            key: payload.key,
            entity,
          }),
        }),
      );
      return;
    }
    if (
      payload.type === 'test_control' &&
      payload.request?.type === 'list_history_files'
    ) {
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'history_files_result',
            success: true,
            files: [],
            sizes: {},
          }),
        }),
      );
      return;
    }
    if (
      payload.type === 'test_control' &&
      payload.request?.type === 'load_history_batch'
    ) {
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'history_batch_result',
            success: true,
            entries: [],
          }),
        }),
      );
      return;
    }
    if (payload.type === 'snapshot') {
      queueMicrotask(() => {
        this.#emit('message', {
          data: JSON.stringify({ type: 'ack' }),
        });
        this.#emit('message', {
          data: JSON.stringify({
            type: 'change',
            mutations: [
              {
                type: 'snapshot',
                url: payload.url,
                urls: null,
              },
            ],
          }),
        });
      });
      return;
    }
    queueMicrotask(() =>
      this.#emit('message', {
        data: JSON.stringify({ type: 'ack' }),
      }),
    );
  }

  emitMessage(payload) {
    this.#emit('message', {
      data: JSON.stringify(payload),
    });
  }

  close() {
    this.readyState = SuccessfulWebSocket.CLOSED;
    this.#emit('close', {});
  }

  #emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      beginPath() {},
      arc() {},
      clearRect() {},
      fill() {},
      lineTo() {},
      moveTo() {},
      stroke() {},
      getImageData: () => ({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      }),
    };
  }
}

async function withStagedFirefoxExtension(run) {
  const outDir = mkdtempSync(
    path.join(tmpdir(), 'browser-recall-firefox-e2e-'),
  );
  stageFirefoxExtensionAssets(outDir);
  writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}\n');
  try {
    return await run(outDir);
  } finally {
    cleanupStagedAssets(outDir);
  }
}

async function withPatchedGlobals(patch, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  try {
    return await run();
  } finally {
    // Background startup is intentionally fire-and-forget. Give its queued
    // WebSocket/storage continuations one turn before removing the mocked APIs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const key of Object.keys(patch)) {
      const descriptor = previous.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test.describe('Firefox extension smoke', () => {
  test('toolbar click opens the same prepared current-page popup as Chromium', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const manifest = JSON.parse(
        readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
      );
      expect(manifest.action.default_popup).toBeUndefined();

      const api = createFirefoxWebExtensionApi();
      const activeTab = {
        id: 40,
        url: 'https://example.test/firefox-toolbar-popup',
        title: 'Firefox Toolbar Popup',
      };
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);
          await api.events.actionClicked.dispatch(activeTab);
          await waitFor(
            () => api.actionPopupState.openCount === 1,
            'prepared Firefox toolbar popup',
          );

          expect(api.actionPopupState.popupByTab.get(activeTab.id)).toMatch(
            /^popup\.html\?bootstrap=/,
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('open-popup command opens the staged Firefox action popup', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const api = createFirefoxWebExtensionApi();
      const activeTab = {
        id: 41,
        url: 'https://example.test/firefox-popup',
        title: 'Firefox Popup',
      };
      const createdTabs = [];
      api.browserApi.tabs.query = async () => [activeTab];
      api.browserApi.tabs.create = async ({ url }) => {
        createdTabs.push(url);
        return { id: 99, url };
      };
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);
          const [result] = await api.browserApi.commands.onCommand.dispatch(
            'open-popup',
            activeTab,
          );

          expect(result).toEqual({ success: true });
          expect(api.actionPopupState.openCount).toBe(1);
          expect(api.actionPopupState.popupByTab.get(activeTab.id)).toMatch(
            /^popup\.html\?bootstrap=/,
          );
          expect(createdTabs).toEqual([]);
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('open-popup command falls back to a tab when Firefox rejects action.openPopup', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const api = createFirefoxWebExtensionApi();
      const activeTab = {
        id: 42,
        url: 'https://example.test/firefox-popup-fallback',
        title: 'Firefox Popup Fallback',
      };
      const createdTabs = [];
      Object.defineProperty(api.browserApi.action, 'openPopup', {
        configurable: true,
        async value() {
          throw new Error('openPopup is unavailable in this Firefox window');
        },
      });
      api.browserApi.tabs.create = async ({ url }) => {
        createdTabs.push(url);
        return { id: 100, url };
      };
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);
          const [result] = await api.browserApi.commands.onCommand.dispatch(
            'open-popup',
            activeTab,
          );

          expect(result).toEqual({ success: true });
          expect(createdTabs).toHaveLength(1);
          expect(createdTabs[0]).toMatch(
            /^moz-extension:\/\/browser-recall\.invalid\/popup\.html\?bootstrap=/,
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('staged background boots with Firefox-shaped WebExtension APIs', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const api = createFirefoxWebExtensionApi();
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);

          await waitFor(
            () => api.storage.local._data.connectorState === 'offline',
            'background connector offline state',
          );
          await waitFor(
            () => api.browserApi.badgeState.global.text === '!',
            'global offline badge text',
          );

          expect(globalThis.browserRecallWebExtension.buildTarget).toBe(
            'firefox',
          );
          expect(
            globalThis.chrome.storage.session.setAccessLevel,
          ).toBeUndefined();
          expect(api.events.runtimeMessage.listenerCount()).toBeGreaterThan(0);
          expect(api.browserApi.tabs.onRemoved.listenerCount()).toBeGreaterThan(
            0,
          );
          expect(api.browserApi.webNavigation.onCommitted.listenerCount()).toBe(
            1,
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('staged background opens options only on fresh install', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      let optionsOpenCount = 0;
      let highlightTitle = 'Highlight Selected';
      const api = createFirefoxWebExtensionApi({
        i18n: {
          ...createEnglishI18n(),
          getMessage(key, substitutions) {
            if (key === 'extensionHighlightSelected') return highlightTitle;
            return createEnglishI18n().getMessage(key, substitutions);
          },
        },
        onOpenOptionsPage() {
          optionsOpenCount += 1;
        },
      });
      api.contextMenuItems.set('stale-highlight-command', {
        id: 'stale-highlight-command',
        title: 'Stale Highlight Command',
        contexts: ['selection'],
      });
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);

          await api.events.runtimeInstalled.dispatch({ reason: 'update' });
          expect(optionsOpenCount).toBe(0);
          expect(
            api.contextMenuItems.get('browser-recall-highlight')?.title,
          ).toBe('Highlight Selected');
          expect([...api.contextMenuItems.keys()]).toEqual([
            'browser-recall-highlight',
          ]);

          highlightTitle = '選択したテキストをハイライト';
          await api.events.runtimeStartup.dispatch();
          expect(
            api.contextMenuItems.get('browser-recall-highlight')?.title,
          ).toBe('選択したテキストをハイライト');

          await api.events.runtimeInstalled.dispatch({ reason: 'install' });
          await waitFor(
            () => optionsOpenCount === 1,
            'options page opened after install',
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('staged popup opens to the desktop-offline state without fatal errors', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const html = readFileSync(path.join(outDir, 'popup.html'), 'utf8');
      const dom = new JSDOM(html, {
        url: 'moz-extension://browser-recall.invalid/popup.html',
        pretendToBeVisual: true,
      });
      dom.window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      });
      dom.window.open = () => {};
      dom.window.close = () => {};

      const api = createFirefoxWebExtensionApi({
        async sendMessage(message) {
          if (message?.action === 'getDesktopConnectorState') {
            return {
              success: true,
              state: 'offline',
              hasToken: false,
              pendingCommands: 0,
              pendingBytes: 0,
            };
          }
          return { success: true };
        },
      });

      await withPatchedGlobals(
        {
          window: dom.window,
          document: dom.window.document,
          HTMLElement: dom.window.HTMLElement,
          Node: dom.window.Node,
          navigator: navigatorWithUserAgent(
            dom.window.navigator,
            FIREFOX_USER_AGENT,
          ),
          browser: api.browserApi,
          chrome: api.chromeCompat,
        },
        async () => {
          const shim = readFileSync(
            path.join(outDir, 'browser-api.js'),
            'utf8',
          );
          vm.runInThisContext(shim, {
            filename: path.join(outDir, 'browser-api.js'),
          });
          const extensionSurface = readFileSync(
            path.join(outDir, 'extension-surface.js'),
            'utf8',
          );
          vm.runInThisContext(extensionSurface, {
            filename: path.join(outDir, 'extension-surface.js'),
          });

          await import(pathToFileURL(path.join(outDir, 'popup.js')).href);

          await waitFor(() => {
            const section = dom.window.document.getElementById(
              'pageDiagnosticSection',
            );
            const title = dom.window.document.getElementById(
              'pageDiagnosticTitle',
            );
            return (
              section.style.display !== 'none' &&
              /DESKTOP OFFLINE|Desktop Offline/.test(title.textContent)
            );
          }, 'popup desktop-offline diagnostic state');

          expect(
            dom.window.document.body.textContent.includes(
              'Storage Unavailable',
            ),
          ).toBe(false);
          expect(
            dom.window.document.getElementById('pageDiagnosticTitle')
              .textContent,
          ).toMatch(/DESKTOP OFFLINE|Desktop Offline/);
          expect(globalThis.browserRecallWebExtension.buildTarget).toBe(
            'firefox',
          );
          expect(
            globalThis.chrome.storage.session.setAccessLevel,
          ).toBeUndefined();
        },
      );

      dom.window.close();
    });
  });

  test('staged background applies Firefox page marker icon without extension resource fetches', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const api = createFirefoxWebExtensionApi();
      const activeTab = {
        id: 31,
        url: 'https://example.test/marked',
        title: 'Marked Page',
      };
      Object.assign(api.storage.local._data, {
        connectorAuthToken: 'test-token',
        connectorDaemonPort: 28471,
      });
      api.browserApi.tabs.query = async () => [activeTab];
      api.browserApi.tabs.get = async () => activeTab;

      const fetchCalls = [];
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: SuccessfulWebSocket,
          OffscreenCanvas: FakeOffscreenCanvas,
          fetch: async (url) => {
            fetchCalls.push(url);
            throw new Error('scheme handler failed');
          },
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);

          await waitFor(
            () => api.storage.local._data.connectorState === 'connected',
            'background connector connected state',
          );

          await api.browserApi.webNavigation.onCommitted.dispatch({
            tabId: activeTab.id,
            url: activeTab.url,
            transitionType: 'link',
          });

          await waitFor(
            () =>
              api.browserApi.badgeState.tabs.get(activeTab.id)?.icon?.[16] ===
              'icons/icon16-special-notes.png',
            'tab page marker icon',
          );

          expect(fetchCalls).toEqual([]);
          expect(api.browserApi.badgeState.tabs.get(activeTab.id).text).toBe(
            '',
          );
          expect(api.browserApi.badgeState.tabs.get(activeTab.id).icon).toEqual(
            {
              16: 'icons/icon16-special-notes.png',
              48: 'icons/icon48-special-notes.png',
              128: 'icons/icon128-special-notes.png',
            },
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('staged background reports successful snapshot capture without bubbling badge refresh errors', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const mutationMessages = [];
      const api = createFirefoxWebExtensionApi({
        onSendMessage(message) {
          if (message?.action === 'mutation') mutationMessages.push(message);
        },
      });
      const activeTab = {
        id: 11,
        url: 'https://example.test/capture',
        title: 'Capture Page',
      };
      Object.assign(api.storage.local._data, {
        connectorAuthToken: 'test-token',
        connectorDaemonPort: 28471,
      });
      api.browserApi.tabs.query = async () => [activeTab];
      api.browserApi.tabs.get = async () => activeTab;
      api.browserApi.tabs.sendMessage = async (tabId, message) => {
        if (message?.action === 'isPdfPage') return { isPdf: false };
        if (message?.action === 'extractMarkdown') {
          return { success: true, markdown: 'captured markdown' };
        }
        if (message?.type === 'performAction') {
          queueMicrotask(() => {
            void api.events.runtimeMessage.dispatch(
              {
                type: 'savepageDone',
                captureId: message.captureId,
                html: '<html><body>captured html</body></html>',
              },
              { tab: activeTab },
            );
          });
        }
        return { success: true };
      };
      api.browserApi.scripting.executeScript = async ({ files }) => {
        if (files?.includes('savepage/content.js')) {
          queueMicrotask(() => {
            void api.events.runtimeMessage.dispatch(
              { type: 'scriptLoaded' },
              { tab: activeTab },
            );
          });
        }
        return [];
      };

      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };

      await withPatchedGlobals(
        {
          browser: api.browserApi,
          chrome: api.chromeCompat,
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            FIREFOX_USER_AGENT,
          ),
          WebSocket: SuccessfulWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);

          await waitFor(
            () => api.storage.local._data.connectorState === 'connected',
            'background connector connected state',
          );

          const response = await api.browserApi.runtime.sendMessage({
            action: 'captureCurrentPageFromPopup',
          });

          expect(response, JSON.stringify(response)).toMatchObject({
            success: true,
          });
          expect(response.timestamp).toEqual(expect.any(Number));
          expect(mutationMessages).toContainEqual(
            expect.objectContaining({
              action: 'mutation',
              type: 'snapshot',
            }),
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });
});
