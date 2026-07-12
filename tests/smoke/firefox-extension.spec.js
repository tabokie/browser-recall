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
const NON_FIREFOX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
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
  const runtimeInstalled = createEvent();
  const runtimeStartup = createEvent();

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
      runtimeInstalled,
      runtimeMessage,
      runtimeStartup,
      storageChanged,
    },
    storage,
    badgeState,
    contextMenuItems,
  };
}

function createOrionCallbackWebExtensionApi({
  tab,
  responses,
  runtimeId = 'orion-extension@example.invalid',
} = {}) {
  const runtimeMessage = createEvent();
  const storageChanged = createEvent();
  const badgeState = {
    global: { text: '', color: null, icon: null, title: '' },
    tabs: new Map(),
  };
  const contextMenuItems = new Map();
  const storageData = {
    connectorState: 'connected',
    connectorDeviceId: 'orion-device',
    connectorAuthToken: 'token',
    desktopPendingCommands: 0,
    desktopPendingBytes: 0,
    desktopRefuseMode: false,
  };

  function callbackLater(value, callback) {
    if (typeof callback === 'function') queueMicrotask(() => callback(value));
    return undefined;
  }

  function storageGet(keys, callback) {
    const result = {};
    for (const key of normalizeStorageKeys(keys, storageData)) {
      if (Object.prototype.hasOwnProperty.call(storageData, key)) {
        result[key] = storageData[key];
      }
    }
    return callbackLater(result, callback);
  }

  function badgeTarget(details = {}) {
    if (details.tabId == null) return badgeState.global;
    if (!badgeState.tabs.has(details.tabId)) {
      badgeState.tabs.set(details.tabId, { ...badgeState.global });
    }
    return badgeState.tabs.get(details.tabId);
  }

  const action = {
    setBadgeBackgroundColor(details, callback) {
      badgeTarget(details).color = details.color;
      return callbackLater(undefined, callback);
    },
    setBadgeText(details, callback) {
      badgeTarget(details).text = details.text;
      return callbackLater(undefined, callback);
    },
    setIcon(details, callback) {
      badgeTarget(details).icon = details.imageData || details.path || null;
      return callbackLater(undefined, callback);
    },
    setTitle(details, callback) {
      badgeTarget(details).title = details.title;
      return callbackLater(undefined, callback);
    },
  };
  const runtime = {
    ...(runtimeId ? { id: runtimeId } : {}),
    lastError: null,
    onInstalled: createEvent(),
    onMessage: runtimeMessage,
    onStartup: createEvent(),
    getBrowserInfo(callback) {
      return callbackLater({ name: 'Orion' }, callback);
    },
    getManifest() {
      return {
        manifest_version: 3,
        name: 'browser-recall',
        browser_specific_settings: {
          gecko: { id: 'browser-recall@example.invalid' },
        },
      };
    },
    reload() {},
    sendMessage(message, callback) {
      const handler = responses[message?.action];
      const value = handler
        ? typeof handler === 'function'
          ? handler(message)
          : handler
        : { success: true };
      if (value?.__delayMs) {
        setTimeout(() => callback?.(value.response), value.__delayMs);
        return undefined;
      }
      return callbackLater(value, callback);
    },
  };
  const callbackWithLastError = (error, callback) => {
    queueMicrotask(() => {
      runtime.lastError = error ? { message: error.message } : null;
      callback?.();
      runtime.lastError = null;
    });
  };

  return {
    badgeState,
    contextMenuItems,
    i18n: createEnglishI18n(),
    action,
    alarms: {
      onAlarm: createEvent(),
      clear(callback) {
        return callbackLater(true, callback);
      },
      create(_, callback) {
        return callbackLater(undefined, callback);
      },
    },
    commands: {
      onCommand: createEvent(),
      getAll(callback) {
        return callbackLater([], callback);
      },
    },
    contextMenus: {
      onClicked: createEvent(),
      create(item, callback) {
        contextMenuItems.set(item.id, { ...item });
        callbackWithLastError(null, callback);
        return item.id;
      },
      update(id, patch, callback) {
        if (!contextMenuItems.has(id)) {
          callbackWithLastError(
            new Error(`Unknown context menu: ${id}`),
            callback,
          );
          return undefined;
        }
        contextMenuItems.set(id, {
          ...contextMenuItems.get(id),
          ...patch,
        });
        callbackWithLastError(null, callback);
        return undefined;
      },
    },
    runtime,
    storage: {
      onChanged: storageChanged,
      local: {
        _data: storageData,
        get: storageGet,
        set(values, callback) {
          Object.assign(storageData, values || {});
          return callbackLater(undefined, callback);
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageData[key];
          }
          return callbackLater(undefined, callback);
        },
      },
      session: {
        get(_, callback) {
          return callbackLater({}, callback);
        },
        set(_, callback) {
          return callbackLater(undefined, callback);
        },
        remove(_, callback) {
          return callbackLater(undefined, callback);
        },
        clear(callback) {
          return callbackLater(undefined, callback);
        },
      },
    },
    tabs: {
      onActivated: createEvent(),
      onCreated: createEvent(),
      onRemoved: createEvent(),
      query(_, callback) {
        return callbackLater([tab], callback);
      },
      get(tabId, callback) {
        return callbackLater({ ...tab, id: tabId }, callback);
      },
      sendMessage(_, __, callback) {
        return callbackLater({ success: true }, callback);
      },
      create({ url } = {}, callback) {
        return callbackLater({ id: 99, url }, callback);
      },
      update(tabId, patch = {}, callback) {
        return callbackLater({ id: tabId, ...patch }, callback);
      },
    },
    webNavigation: {
      onCommitted: createEvent(),
      onCreatedNavigationTarget: createEvent(),
    },
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
          data: JSON.stringify({ type: 'auth_ok', protocolVersion: 2 }),
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
            bufferDepth: 0,
            lastDrainedAt: Date.now(),
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
            settings: {},
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
      queueMicrotask(() =>
        this.#emit('message', {
          data: JSON.stringify({
            type: 'page_summary_result',
            success: true,
            url: payload.url,
            displayTitle: page?.title || '',
            access: {
              blacklisted: false,
              hasVisitHistory: Boolean(page),
            },
            page,
            notes,
            snapshots,
            lists,
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
    if (payload.type === 'list_history_files') {
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
    if (payload.type === 'load_history_batch') {
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
          data: JSON.stringify({
            type: 'ack',
            bufferDepth: 0,
            lastDrainedAt: Date.now(),
          }),
        });
        this.#emit('message', {
          data: JSON.stringify({
            type: 'change',
            mutations: [
              { type: 'snapshot', slug: payload.slug, url: payload.url },
            ],
          }),
        });
      });
      return;
    }
    queueMicrotask(() =>
      this.#emit('message', {
        data: JSON.stringify({
          type: 'ack',
          bufferDepth: 0,
          lastDrainedAt: Date.now(),
        }),
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

          expect(globalThis.browserRecallWebExtension.engine).toBe('firefox');
          expect(typeof globalThis.chrome.storage.session.setAccessLevel).toBe(
            'function',
          );
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
          expect(api.contextMenuItems.get('portal-highlight')?.title).toBe(
            'Highlight Selected',
          );

          highlightTitle = '選択したテキストをハイライト';
          await api.events.runtimeStartup.dispatch();
          expect(api.contextMenuItems.get('portal-highlight')?.title).toBe(
            '選択したテキストをハイライト',
          );

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

  test('staged background creates its context menu through callback-only APIs', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const api = createOrionCallbackWebExtensionApi({
        tab: {
          id: 31,
          url: 'https://example.test/callback-context-menu',
          title: 'Callback Context Menu',
        },
        responses: {},
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
          browser: api,
          chrome: {},
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            NON_FIREFOX_USER_AGENT,
          ),
          WebSocket: FailingWebSocket,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);
          await api.runtime.onInstalled.dispatch({ reason: 'update' });
          expect(api.contextMenuItems.get('portal-highlight')?.title).toBe(
            'Highlight Selected',
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

          await import(pathToFileURL(path.join(outDir, 'popup.js')).href);

          await waitFor(
            () =>
              dom.window.document.getElementById('setup-required').style
                .display === 'block',
            'popup setup-required state',
          );

          expect(
            dom.window.document.body.textContent.includes(
              'Storage Unavailable',
            ),
          ).toBe(false);
          expect(
            dom.window.document.getElementById('setupRequiredTitle')
              .textContent,
          ).toMatch(/DESKTOP OFFLINE|Desktop Offline/);
          expect(globalThis.browserRecallWebExtension.engine).toBe('firefox');
          expect(typeof globalThis.chrome.storage.session.setAccessLevel).toBe(
            'function',
          );
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
          return { markdown: 'captured markdown' };
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

          expect(response).toMatchObject({ success: true });
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

  test('staged popup loads connected dashboard when runtime.getURL is missing', async () => {
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

      const activeTab = {
        id: 12,
        url: 'https://example.test/orion',
        title: 'Orion Page',
      };
      const api = createFirefoxWebExtensionApi({
        async sendMessage(message) {
          switch (message?.action) {
            case 'getDesktopConnectorState':
              return {
                success: true,
                state: 'connected',
                deviceId: 'orion-device',
                hasToken: true,
              };
            case 'getReportedUrl':
              return { success: true, url: activeTab.url };
            case 'getPageSummary':
              return {
                success: true,
                displayTitle: activeTab.title,
                access: {
                  blacklisted: false,
                  hasVisitHistory: true,
                },
                page: {
                  slug: 'orion-page',
                  url: activeTab.url,
                  title: activeTab.title,
                  visitDates: [],
                },
                notes: [],
                snapshots: [],
                lists: [],
              };
            default:
              return { success: true };
          }
        },
      });
      delete api.browserApi.runtime.getURL;
      api.browserApi.tabs.query = async () => [activeTab];

      await withPatchedGlobals(
        {
          window: dom.window,
          document: dom.window.document,
          HTMLElement: dom.window.HTMLElement,
          Node: dom.window.Node,
          navigator: navigatorWithUserAgent(
            dom.window.navigator,
            NON_FIREFOX_USER_AGENT,
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

          await import(pathToFileURL(path.join(outDir, 'popup.js')).href);

          await waitFor(
            () =>
              dom.window.document.getElementById('dashboard').style.display ===
              'flex',
            'connected dashboard',
          );

          expect(
            dom.window.document.body.textContent.includes(
              'Storage Unavailable',
            ),
          ).toBe(false);
          expect(
            dom.window.document.getElementById('pageTitle').textContent,
          ).toBe('Orion Page');
          expect(globalThis.browserRecallWebExtension.engine).toBe('chromium');
          expect(typeof globalThis.chrome.runtime.getURL).toBe('function');
        },
      );

      dom.window.close();
    });
  });

  test('staged popup uses cached connected state with Orion callback-style APIs', async () => {
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

      const activeTab = {
        id: 13,
        url: 'https://example.test/orion-callback',
        title: 'Orion Callback Page',
      };
      const actions = [];
      const api = createOrionCallbackWebExtensionApi({
        tab: activeTab,
        responses: {
          getDesktopConnectorState: () => {
            actions.push('getDesktopConnectorState');
            return {
              __delayMs: 1000,
              response: {
                success: true,
                state: 'connected',
                deviceId: 'orion-device',
                hasToken: true,
              },
            };
          },
          getReportedUrl: { success: true, url: activeTab.url },
          getPageSummary: {
            success: true,
            displayTitle: activeTab.title,
            access: {
              blacklisted: false,
              hasVisitHistory: true,
            },
            page: {
              slug: 'orion-callback-page',
              url: activeTab.url,
              title: activeTab.title,
              visitDates: [],
            },
            notes: [],
            snapshots: [],
            lists: [],
          },
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
            NON_FIREFOX_USER_AGENT,
          ),
          browser: api,
          chrome: {},
        },
        async () => {
          const shim = readFileSync(
            path.join(outDir, 'browser-api.js'),
            'utf8',
          );
          vm.runInThisContext(shim, {
            filename: path.join(outDir, 'browser-api.js'),
          });

          const startedAt = Date.now();
          await import(pathToFileURL(path.join(outDir, 'popup.js')).href);

          await waitFor(
            () =>
              dom.window.document.getElementById('dashboard').style.display ===
              'flex',
            'Orion callback dashboard',
          );

          expect(Date.now() - startedAt).toBeLessThan(250);
          expect(actions).toContain('getDesktopConnectorState');
          expect(
            dom.window.document.getElementById('pageTitle').textContent,
          ).toBe('Orion Callback Page');
          expect(globalThis.browserRecallWebExtension.engine).toBe('chromium');
        },
      );

      dom.window.close();
    });
  });

  test('staged background connects with Orion callback-style APIs', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const activeTab = {
        id: 14,
        url: 'https://example.test/orion-connect',
        title: 'Orion Connect Page',
      };
      const api = createOrionCallbackWebExtensionApi({
        tab: activeTab,
        responses: {},
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
          browser: api,
          chrome: {},
          navigator: navigatorWithUserAgent(
            globalThis.navigator,
            NON_FIREFOX_USER_AGENT,
          ),
          WebSocket: SuccessfulWebSocket,
          OffscreenCanvas: FakeOffscreenCanvas,
          setTimeout: unrefSetTimeout,
        },
        async () => {
          await import(pathToFileURL(path.join(outDir, 'background.js')).href);

          await waitFor(
            () => api.storage.local._data.connectorState === 'connected',
            'Orion background connector state',
          );
          expect(api.storage.local._data.connectorAuthToken).toBeTruthy();
          expect(globalThis.chrome.runtime.id).toBe(
            'orion-extension@example.invalid',
          );
        },
      );

      for (const timer of timers) clearTimeout(timer);
    });
  });

  test('staged Orion background renders Chrome-style badge for active listed page on first load', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const activeTab = {
        id: 17,
        url: 'https://example.test/orion-first-load',
        title: 'Orion First Load',
      };
      const api = createOrionCallbackWebExtensionApi({
        tab: activeTab,
        responses: {},
      });
      api.storage.local._data.connectorState = 'offline';
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };
      SuccessfulWebSocket.instances = [];
      const previousEntityForKey = SuccessfulWebSocket.entityForKey;
      SuccessfulWebSocket.entityForKey = (key) =>
        key?.startsWith('page:')
          ? {
              url: activeTab.url,
              childIds: [],
              parentIds: ['list:reading'],
            }
          : null;

      try {
        await withPatchedGlobals(
          {
            browser: api,
            chrome: {},
            navigator: navigatorWithUserAgent(
              globalThis.navigator,
              NON_FIREFOX_USER_AGENT,
            ),
            WebSocket: SuccessfulWebSocket,
            OffscreenCanvas: FakeOffscreenCanvas,
            setTimeout: unrefSetTimeout,
          },
          async () => {
            await import(
              pathToFileURL(path.join(outDir, 'background.js')).href
            );

            await waitFor(
              () =>
                api.badgeState.tabs.get(activeTab.id)?.icon?.[16] ===
                'icons/icon16-special-lists.png',
              'Orion first-load page marker icon',
            );
            expect(api.badgeState.tabs.get(activeTab.id).text).toBe('');
            expect(api.badgeState.tabs.get(activeTab.id).icon).toEqual({
              16: 'icons/icon16-special-lists.png',
              48: 'icons/icon48-special-lists.png',
              128: 'icons/icon128-special-lists.png',
            });
          },
        );
      } finally {
        SuccessfulWebSocket.entityForKey = previousEntityForKey;
        for (const timer of timers) clearTimeout(timer);
      }
    });
  });

  test('staged Orion background refreshes Chrome-style badge from Desktop mutations', async () => {
    await withStagedFirefoxExtension(async (outDir) => {
      const activeTab = {
        id: 18,
        url: 'https://example.test/orion-listed',
        title: 'Orion Listed Page',
      };
      const api = createOrionCallbackWebExtensionApi({
        tab: activeTab,
        responses: {},
      });
      api.storage.local._data.connectorState = 'offline';
      const timers = new Set();
      const nativeSetTimeout = globalThis.setTimeout;
      const unrefSetTimeout = (callback, ms, ...args) => {
        const timer = nativeSetTimeout(callback, ms, ...args);
        timer.unref?.();
        timers.add(timer);
        return timer;
      };
      SuccessfulWebSocket.instances = [];
      const previousEntityForKey = SuccessfulWebSocket.entityForKey;
      SuccessfulWebSocket.entityForKey = () => null;

      try {
        await withPatchedGlobals(
          {
            browser: api,
            chrome: {},
            navigator: navigatorWithUserAgent(
              globalThis.navigator,
              NON_FIREFOX_USER_AGENT,
            ),
            WebSocket: SuccessfulWebSocket,
            OffscreenCanvas: FakeOffscreenCanvas,
            setTimeout: unrefSetTimeout,
          },
          async () => {
            await import(
              pathToFileURL(path.join(outDir, 'background.js')).href
            );

            await waitFor(
              () => api.storage.local._data.connectorState === 'connected',
              'Orion background connector state',
            );
            expect(api.badgeState.tabs.get(activeTab.id)?.text || '').toBe('');

            SuccessfulWebSocket.entityForKey = (key) =>
              key?.startsWith('page:')
                ? {
                    url: activeTab.url,
                    childIds: [],
                    parentIds: ['list:reading'],
                  }
                : null;
            SuccessfulWebSocket.instances[0].emitMessage({
              type: 'change',
              mutations: [{ type: 'pins', url: activeTab.url }],
            });

            await waitFor(
              () =>
                api.badgeState.tabs.get(activeTab.id)?.icon?.[16] ===
                'icons/icon16-special-lists.png',
              'Orion page marker icon',
            );
            expect(api.badgeState.tabs.get(activeTab.id).text).toBe('');
            expect(api.badgeState.tabs.get(activeTab.id).icon).toEqual({
              16: 'icons/icon16-special-lists.png',
              48: 'icons/icon48-special-lists.png',
              128: 'icons/icon128-special-lists.png',
            });
          },
        );
      } finally {
        SuccessfulWebSocket.entityForKey = previousEntityForKey;
        for (const timer of timers) clearTimeout(timer);
      }
    });
  });
});
