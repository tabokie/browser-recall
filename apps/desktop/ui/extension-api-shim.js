const changeListeners = new Set();
const runtimeMessageListeners = new Set();
let runtimeBridgeStarted = false;
let storageBridgeStarted = false;
const storageBridgeInstanceId =
  globalThis.crypto?.randomUUID?.() ||
  `desktop-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emitStorageChange(areaName, changes) {
  if (!changes || Object.keys(changes).length === 0) return;
  for (const listener of changeListeners) {
    try {
      listener(changes, areaName);
    } catch (error) {
      console.error('[desktop-shim] storage.onChanged listener failed', error);
    }
  }
}

function dispatchRuntimeMessage(message) {
  for (const listener of runtimeMessageListeners) {
    try {
      listener(message, { id: chromeShim.runtime.id }, () => {});
    } catch (error) {
      console.error('[desktop-shim] runtime.onMessage listener failed', error);
    }
  }
}

function tauriListen(eventName, handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(eventName, handler);
  }
  if (window.__TAURI_INTERNALS__?.event?.listen) {
    return window.__TAURI_INTERNALS__.event.listen(eventName, handler);
  }
  return null;
}

function ensureRuntimeBridge() {
  if (runtimeBridgeStarted) return;
  const listenPromise = tauriListen('bridge-runtime-message', (event) => {
    dispatchRuntimeMessage(event?.payload ?? {});
  });
  if (!listenPromise) return;
  runtimeBridgeStarted = true;
  Promise.resolve(listenPromise).catch((error) => {
    runtimeBridgeStarted = false;
    console.error('[desktop-shim] failed to attach runtime bridge', error);
  });
}

function ensureStorageBridge() {
  if (storageBridgeStarted) return;
  const listenPromise = tauriListen('bridge-storage-change', (event) => {
    const payload = event?.payload ?? {};
    if (payload?.sourceId === storageBridgeInstanceId) return;
    const area = payload?.areaName;
    const changes = payload?.changes;
    if (!changes || typeof changes !== 'object') return;
    if (area === 'session') {
      sessionArea.applyExternalChanges(changes);
    } else if (area === 'local') {
      localArea.applyExternalChanges(changes);
    }
  });
  if (!listenPromise) return;
  storageBridgeStarted = true;
  Promise.resolve(listenPromise).catch((error) => {
    storageBridgeStarted = false;
    console.error('[desktop-shim] failed to attach storage bridge', error);
  });
}

function createUnsupportedPort(name) {
  const messageListeners = new Set();
  const disconnectListeners = new Set();

  function emitMessage(payload) {
    for (const listener of messageListeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[desktop-shim] runtime.connect listener failed', error);
      }
    }
  }

  function emitDisconnect() {
    for (const listener of disconnectListeners) {
      try {
        listener();
      } catch (error) {
        console.error(
          '[desktop-shim] runtime.connect disconnect listener failed',
          error,
        );
      }
    }
  }

  return {
    name,
    onMessage: {
      addListener(listener) {
        messageListeners.add(listener);
      },
      removeListener(listener) {
        messageListeners.delete(listener);
      },
      hasListener(listener) {
        return messageListeners.has(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.add(listener);
      },
      removeListener(listener) {
        disconnectListeners.delete(listener);
      },
      hasListener(listener) {
        return disconnectListeners.has(listener);
      },
    },
    postMessage(message) {
      const action = message?.action || name || 'request';
      queueMicrotask(() => {
        emitMessage({
          type: 'error',
          message: `${action} is not available in the desktop app yet`,
        });
        emitDisconnect();
      });
    },
    disconnect() {
      emitDisconnect();
    },
  };
}

function normalizeChanges(changes = {}) {
  return Object.fromEntries(
    Object.entries(changes).filter(([, change]) => {
      if (!change || typeof change !== 'object') return false;
      return !Object.is(change.oldValue, change.newValue);
    }),
  );
}

function listenerChangesFromTransport(changes = {}) {
  return Object.fromEntries(
    Object.entries(changes).map(([key, change]) => [
      key,
      change?.newValue === null
        ? { oldValue: clone(change.oldValue), newValue: undefined }
        : change,
    ]),
  );
}

function createStorageArea(storage, areaName, keyPrefix, options = {}) {
  const { backendBacked = false } = options;

  function storageKey(key) {
    return `${keyPrefix}${key}`;
  }

  function readRaw(key) {
    const raw = storage.getItem(storageKey(key));
    if (raw === null) return undefined;
    return JSON.parse(raw);
  }

  function writeRaw(key, value) {
    storage.setItem(storageKey(key), JSON.stringify(value));
  }

  function removeRaw(key) {
    storage.removeItem(storageKey(key));
  }

  function allKeys() {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(keyPrefix)) {
        keys.push(key.slice(keyPrefix.length));
      }
    }
    return keys;
  }

  function applyChanges(changes, { emit = true } = {}) {
    const normalized = normalizeChanges(changes);
    if (Object.keys(normalized).length === 0) return normalized;
    for (const [key, change] of Object.entries(normalized)) {
      if (change.newValue === undefined || change.newValue === null) {
        removeRaw(key);
      } else {
        writeRaw(key, change.newValue);
      }
    }
    if (emit)
      emitStorageChange(areaName, listenerChangesFromTransport(normalized));
    return normalized;
  }

  function syncSubset(keys, values) {
    const result = {};
    for (const key of keys) {
      const previous = readRaw(key);
      const hasValue = Object.prototype.hasOwnProperty.call(values, key);
      const nextValue = hasValue ? values[key] : undefined;
      if (hasValue) {
        writeRaw(key, nextValue);
      } else {
        removeRaw(key);
      }
      result[key] = { oldValue: clone(previous), newValue: clone(nextValue) };
    }
    return result;
  }

  function syncAll(values) {
    const snapshot = values || {};
    const keys = new Set([...allKeys(), ...Object.keys(snapshot)]);
    return syncSubset([...keys], snapshot);
  }

  return {
    async get(keys) {
      if (backendBacked) {
        let remoteValues = {};
        if (keys == null) {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys: null },
          });
          syncAll(remoteValues);
          return remoteValues || {};
        }
        if (typeof keys === 'string') {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys: [keys] },
          });
          syncSubset([keys], remoteValues || {});
          return Object.prototype.hasOwnProperty.call(remoteValues || {}, keys)
            ? { [keys]: remoteValues[keys] }
            : {};
        }
        if (Array.isArray(keys)) {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys },
          });
          syncSubset(keys, remoteValues || {});
          return remoteValues || {};
        }
        if (typeof keys === 'object') {
          const keyList = Object.keys(keys);
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys: keyList },
          });
          syncSubset(keyList, remoteValues || {});
          return Object.fromEntries(
            keyList.map((key) => [
              key,
              Object.prototype.hasOwnProperty.call(remoteValues || {}, key)
                ? remoteValues[key]
                : keys[key],
            ]),
          );
        }
        return {};
      }
      if (keys == null) {
        return Object.fromEntries(allKeys().map((key) => [key, readRaw(key)]));
      }
      if (typeof keys === 'string') {
        const value = readRaw(keys);
        return value === undefined ? {} : { [keys]: value };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .map((key) => [key, readRaw(key)])
            .filter(([, value]) => value !== undefined),
        );
      }
      if (typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => {
            const value = readRaw(key);
            return [key, value === undefined ? fallback : value];
          }),
        );
      }
      return {};
    },

    async set(items) {
      if (backendBacked) {
        const changes = await tauriInvoke('bridge_storage_set', {
          request: {
            areaName,
            sourceId: storageBridgeInstanceId,
            items,
          },
        });
        applyChanges(changes, { emit: true });
        return;
      }
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        const oldValue = readRaw(key);
        changes[key] = {
          oldValue: clone(oldValue),
          newValue: clone(value),
        };
      }
      const normalized = applyChanges(changes, { emit: true });
      tauriInvoke('bridge_storage_broadcast', {
        request: {
          areaName,
          sourceId: storageBridgeInstanceId,
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-shim] failed to broadcast local storage set',
          error,
        );
      });
    },

    async remove(keys) {
      if (backendBacked) {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes = await tauriInvoke('bridge_storage_remove', {
          request: {
            areaName,
            sourceId: storageBridgeInstanceId,
            keys: list,
          },
        });
        applyChanges(changes, { emit: true });
        return;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        const oldValue = readRaw(key);
        changes[key] = {
          oldValue: clone(oldValue),
          newValue: null,
        };
      }
      const normalized = applyChanges(changes, { emit: true });
      tauriInvoke('bridge_storage_broadcast', {
        request: {
          areaName,
          sourceId: storageBridgeInstanceId,
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-shim] failed to broadcast local storage remove',
          error,
        );
      });
    },

    async clear() {
      if (backendBacked) {
        const changes = await tauriInvoke('bridge_storage_clear', {
          request: {
            areaName,
            sourceId: storageBridgeInstanceId,
          },
        });
        applyChanges(changes, { emit: true });
        return;
      }
      const changes = {};
      for (const key of allKeys()) {
        changes[key] = {
          oldValue: clone(readRaw(key)),
          newValue: null,
        };
      }
      const normalized = applyChanges(changes, { emit: true });
      tauriInvoke('bridge_storage_broadcast', {
        request: {
          areaName,
          sourceId: storageBridgeInstanceId,
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-shim] failed to broadcast local storage clear',
          error,
        );
      });
    },

    applyExternalChanges(changes) {
      applyChanges(changes, { emit: true });
    },
  };
}

async function tauriInvoke(command, payload) {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(command, payload);
  }
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke(command, payload);
  }
  throw new Error('Tauri invoke bridge unavailable');
}

const sessionArea = createStorageArea(
  window.sessionStorage,
  'session',
  'br:session:',
  {
    backendBacked: true,
  },
);
const localArea = createStorageArea(window.localStorage, 'local', 'br:local:');

const chromeShim = {
  runtime: {
    id: 'browser-recall-desktop',
    getURL(path = '') {
      return String(path).replace(/^\.\//, '');
    },
    async sendMessage(message) {
      if (message && typeof message === 'object' && message.action) {
        return tauriInvoke('bridge_action', { request: message });
      }
      throw new Error('Unsupported desktop runtime message shape');
    },
    reload() {
      window.location.reload();
    },
    connect(connectInfo = {}) {
      return createUnsupportedPort(connectInfo?.name || '');
    },
    onMessage: {
      addListener(listener) {
        runtimeMessageListeners.add(listener);
        ensureRuntimeBridge();
      },
      removeListener(listener) {
        runtimeMessageListeners.delete(listener);
      },
      hasListener(listener) {
        return runtimeMessageListeners.has(listener);
      },
    },
  },
  storage: {
    session: sessionArea,
    local: localArea,
    onChanged: {
      addListener(listener) {
        changeListeners.add(listener);
      },
      removeListener(listener) {
        changeListeners.delete(listener);
      },
      hasListener(listener) {
        return changeListeners.has(listener);
      },
    },
  },
  tabs: {
    async create({ url }) {
      if (url) {
        await tauriInvoke('bridge_action', {
          request: { action: 'openExternalUrl', url },
        });
      }
      return { id: Date.now(), url };
    },
  },
  contextMenus: {
    create() {},
    removeAll() {},
  },
};

ensureRuntimeBridge();
ensureStorageBridge();

window.chrome = window.chrome || chromeShim;
window.chrome.runtime = window.chrome.runtime || chromeShim.runtime;
window.chrome.storage = window.chrome.storage || chromeShim.storage;
window.chrome.tabs = window.chrome.tabs || chromeShim.tabs;
window.chrome.contextMenus =
  window.chrome.contextMenus || chromeShim.contextMenus;
window.chrome.runtime.onMessage =
  window.chrome.runtime.onMessage || chromeShim.runtime.onMessage;
window.__BROWSER_RECALL_DESKTOP__ = true;
