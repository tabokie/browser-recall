const changeListeners = new Set();
const runtimeMessageListeners = new Set();
let runtimeBridgeStarted = false;
let storageBridgeStarted = false;
let runtimeBridgePromise = null;
let storageBridgePromise = null;
const storageBridgeInstanceId = globalThis.crypto?.randomUUID?.() ?? null;

function requireStorageBridgeInstanceId() {
  if (!storageBridgeInstanceId) {
    throw new Error('Desktop storage bridge requires crypto.randomUUID');
  }
  return storageBridgeInstanceId;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emitStorageChange(areaName, changes) {
  if (!changes || Object.keys(changes).length === 0) return;
  for (const listener of changeListeners) {
    try {
      listener(changes, areaName);
    } catch (error) {
      console.error(
        '[desktop-platform] storage.onChanged listener failed',
        error,
      );
    }
  }
}

function dispatchRuntimeMessage(message) {
  for (const listener of runtimeMessageListeners) {
    try {
      listener(message, { id: chromeShim.runtime.id }, () => {});
    } catch (error) {
      console.error(
        '[desktop-platform] runtime.onMessage listener failed',
        error,
      );
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
  throw new Error(`Tauri event bridge unavailable for ${eventName}`);
}

function ensureRuntimeBridge() {
  if (runtimeBridgeStarted) return runtimeBridgePromise;
  const listenPromise = tauriListen('bridge-runtime-message', (event) => {
    if (!event?.payload || typeof event.payload !== 'object') {
      console.error('[desktop-shim] runtime bridge payload must be an object');
      return;
    }
    dispatchRuntimeMessage(event.payload);
  });
  runtimeBridgeStarted = true;
  runtimeBridgePromise = Promise.resolve(listenPromise).catch((error) => {
    runtimeBridgeStarted = false;
    throw new Error(
      `Failed to attach desktop runtime bridge: ${error.message}`,
    );
  });
  return runtimeBridgePromise;
}

function ensureStorageBridge() {
  if (storageBridgeStarted) return storageBridgePromise;
  const listenPromise = tauriListen('bridge-storage-change', (event) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object') {
      console.error('[desktop-shim] storage bridge payload must be an object');
      return;
    }
    if (payload?.sourceId === storageBridgeInstanceId) return;
    const area = payload?.areaName;
    const changes = payload?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new Error('Desktop storage bridge changes must be an object');
    }
    if (area === 'session') {
      sessionArea.applyExternalChanges(changes);
    } else if (area === 'local') {
      localArea.applyExternalChanges(changes);
    } else {
      throw new Error(
        `Desktop storage bridge area is invalid: ${String(area)}`,
      );
    }
  });
  storageBridgeStarted = true;
  storageBridgePromise = Promise.resolve(listenPromise).catch((error) => {
    storageBridgeStarted = false;
    throw new Error(
      `Failed to attach desktop storage bridge: ${error.message}`,
    );
  });
  return storageBridgePromise;
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
    syncAllResponse(values);
    const snapshot = values;
    const keys = new Set([...allKeys(), ...Object.keys(snapshot)]);
    return syncSubset([...keys], snapshot);
  }

  function syncAllResponse(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Desktop storage response must be an object');
    }
  }

  return {
    async get(keys) {
      if (backendBacked) {
        let remoteValues;
        if (keys == null) {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys: null },
          });
          if (
            !remoteValues ||
            typeof remoteValues !== 'object' ||
            Array.isArray(remoteValues)
          ) {
            throw new Error('Desktop storage response must be an object');
          }
          syncAll(remoteValues);
          return remoteValues;
        }
        if (typeof keys === 'string') {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys: [keys] },
          });
          syncAllResponse(remoteValues);
          syncSubset([keys], remoteValues);
          return Object.prototype.hasOwnProperty.call(remoteValues, keys)
            ? { [keys]: remoteValues[keys] }
            : {};
        }
        if (Array.isArray(keys)) {
          remoteValues = await tauriInvoke('bridge_storage_get', {
            request: { areaName, keys },
          });
          syncAllResponse(remoteValues);
          syncSubset(keys, remoteValues);
          return remoteValues;
        }
        if (typeof keys === 'object') {
          throw new Error(
            'storage.get does not accept default-value objects; callers must handle absent keys explicitly',
          );
        }
        throw new Error('storage.get keys must be null, a string, or an array');
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
        throw new Error(
          'storage.get does not accept default-value objects; callers must handle absent keys explicitly',
        );
      }
      throw new Error('storage.get keys must be null, a string, or an array');
    },

    async set(items) {
      if (!items || typeof items !== 'object' || Array.isArray(items)) {
        throw new Error('storage.set items must be an object');
      }
      if (backendBacked) {
        const changes = await tauriInvoke('bridge_storage_set', {
          request: {
            areaName,
            sourceId: requireStorageBridgeInstanceId(),
            items,
          },
        });
        applyChanges(changes, { emit: true });
        return;
      }
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
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
          sourceId: requireStorageBridgeInstanceId(),
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-platform] failed to broadcast local storage set',
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
            sourceId: requireStorageBridgeInstanceId(),
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
          sourceId: requireStorageBridgeInstanceId(),
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-platform] failed to broadcast local storage remove',
          error,
        );
      });
    },

    async clear() {
      if (backendBacked) {
        const changes = await tauriInvoke('bridge_storage_clear', {
          request: {
            areaName,
            sourceId: requireStorageBridgeInstanceId(),
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
          sourceId: requireStorageBridgeInstanceId(),
          changes: normalized,
        },
      }).catch((error) => {
        console.error(
          '[desktop-platform] failed to broadcast local storage clear',
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
    async sendMessage(message) {
      if (message && typeof message === 'object' && message.action) {
        return tauriInvoke('bridge_action', { request: message });
      }
      throw new Error('Unsupported desktop runtime message shape');
    },
    reload() {
      window.location.reload();
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
      if (typeof url !== 'string' || !url) {
        throw new Error('Desktop external URL must be a non-empty string');
      }
      const response = await tauriInvoke('bridge_action', {
        request: { action: 'openExternalUrl', url },
      });
      if (!response || response.success !== true) {
        throw new Error(
          response?.error || 'Desktop failed to open external URL',
        );
      }
      return response;
    },
  },
};

window.browserRecallDesktopPlatformReady = Promise.all([
  ensureRuntimeBridge(),
  ensureStorageBridge(),
]);

const hostChrome = window.chrome ?? {};
for (const surface of ['runtime', 'storage', 'tabs']) {
  if (Object.prototype.hasOwnProperty.call(hostChrome, surface)) {
    throw new Error(`Desktop host already defines chrome.${surface}`);
  }
  hostChrome[surface] = chromeShim[surface];
}
window.chrome = hostChrome;
window.__BROWSER_RECALL_DESKTOP__ = true;
