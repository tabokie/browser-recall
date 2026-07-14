import { buildPairRequest, CONNECTOR_PROTOCOL_VERSION } from './pairing.js';
import {
  bufferStats,
  bufferedMessageSize,
  clearBufferedMessages,
  enqueueBufferedMessage,
  peekBufferedMessage,
  shiftBufferedMessage,
} from './command-buffer.js';
import {
  CONNECTOR_STATES,
  CONNECTOR_STATE_STORAGE_KEYS,
  CONNECTOR_STORAGE_KEYS as STORAGE_KEYS,
  connectorStateFromStorage,
  isManualReadyConnectorState,
  isProbeReadyConnectorState,
  isTerminalConnectorState,
} from './state.js';
import { logDebug, logError } from '../logger.js';
import { canonicalizePageRequest, canonicalizePageUrl } from '../utils.js';

const DEFAULT_PORTS = [28471, 28472, 28473];
const RECONNECT_ALARM_NAME = 'browserRecallConnectorReconnect';
const MANUAL_RECONNECT_DEADLINE_MS = 15_000;
const RECONNECT_DELAY_MS = 15_000;
const SOCKET_OPEN_TIMEOUT_MS = 5000;
const BRIDGE_REQUEST_TIMEOUT_MS = 1500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 60_000;
const STATE_PROBE_TIMEOUT_MS = 2500;

let currentSocket = null;
let reconnectTimer = null;
let connectPromise = null;
let flushPromise = null;
let pendingRequest = null;
let bridgeRequestQueue = Promise.resolve();
let started = false;
let alarmListenerInstalled = false;
let connectorStorageCache = {};
const connectorStateListeners = new Set();
const daemonMutationListeners = new Set();

function cachedConnectorState() {
  return connectorStateFromStorage(connectorStorageCache);
}

function notifyConnectorStateListeners() {
  const state = cachedConnectorState();
  for (const listener of [...connectorStateListeners]) {
    try {
      listener(state);
    } catch (error) {
      logDebug('[connector] state listener failed:', error.message);
    }
  }
}

export function subscribeConnectorBridgeState(listener) {
  connectorStateListeners.add(listener);
  return () => connectorStateListeners.delete(listener);
}

export function subscribeDaemonMutations(listener) {
  daemonMutationListeners.add(listener);
  return () => daemonMutationListeners.delete(listener);
}

function mergeConnectorStorageCache(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!CONNECTOR_STATE_STORAGE_KEYS.includes(key)) continue;
    if (Object.is(connectorStorageCache[key], value)) continue;
    connectorStorageCache[key] = value;
    changed = true;
  }
  if (changed) notifyConnectorStateListeners();
}

function removeConnectorStorageCache(keys) {
  let changed = false;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (!CONNECTOR_STATE_STORAGE_KEYS.includes(key)) continue;
    delete connectorStorageCache[key];
    changed = true;
  }
  if (changed) notifyConnectorStateListeners();
}

function bufferStatePatch(stats) {
  return {
    desktopPendingCommands: stats.pendingCommands,
    desktopPendingBytes: stats.pendingBytes,
    desktopRefuseMode: stats.refuseMode,
  };
}

function broadcastDaemonMutations(mutations) {
  if (!Array.isArray(mutations)) {
    throw new Error('Desktop change message mutations must be an array');
  }
  for (const mutation of mutations) {
    const expectedKeys = [
      'type',
      'listId',
      'pageSlug',
      'noteSlug',
      'oldNoteSlug',
      'slug',
      'url',
      'urls',
      'key',
    ];
    if (
      !mutation ||
      typeof mutation !== 'object' ||
      Array.isArray(mutation) ||
      Object.keys(mutation).length !== expectedKeys.length ||
      expectedKeys.some(
        (key) => !Object.prototype.hasOwnProperty.call(mutation, key),
      ) ||
      typeof mutation.type !== 'string'
    ) {
      throw new Error('Desktop change message contains an invalid mutation');
    }
    for (const key of [
      'listId',
      'pageSlug',
      'noteSlug',
      'oldNoteSlug',
      'slug',
      'url',
      'key',
    ]) {
      if (mutation[key] !== null && typeof mutation[key] !== 'string') {
        throw new Error(`Desktop mutation ${key} must be a string or null`);
      }
    }
    if (
      mutation.urls !== null &&
      (!Array.isArray(mutation.urls) ||
        mutation.urls.some((url) => typeof url !== 'string'))
    ) {
      throw new Error('Desktop mutation urls must be a string array or null');
    }
    for (const listener of [...daemonMutationListeners]) {
      try {
        listener(mutation);
      } catch (error) {
        logDebug('[connector] daemon mutation listener failed:', error.message);
      }
    }
    chrome.runtime
      .sendMessage({ action: 'mutation', ...mutation })
      .catch((error) =>
        logDebug(
          '[connector] mutation broadcast had no receiver:',
          error.message,
        ),
      );
  }
}

function installReconnectAlarmListener() {
  if (alarmListenerInstalled || !chrome.alarms?.onAlarm?.addListener) return;
  alarmListenerInstalled = true;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== RECONNECT_ALARM_NAME) return;
    reconnectTimer = null;
    void connect();
  });
}

async function writeState(patch) {
  await chrome.storage.local.set(patch);
  mergeConnectorStorageCache(patch);
}

async function syncBufferStats() {
  const stats = await bufferStats();
  mergeConnectorStorageCache(bufferStatePatch(stats));
  return stats;
}

async function setState(state, extra = {}) {
  await writeState({
    [STORAGE_KEYS.state]: state,
    ...extra,
  });
}

async function setDiagnostic(code, details = {}) {
  logDebug('[connector]', code, details);
  await writeState({
    [STORAGE_KEYS.lastDiagnostic]: {
      code,
      at: Date.now(),
      ...details,
    },
  });
}

async function clearDiagnostic() {
  await chrome.storage.local.remove(STORAGE_KEYS.lastDiagnostic);
  removeConnectorStorageCache(STORAGE_KEYS.lastDiagnostic);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const clearResult = chrome.alarms?.clear?.(RECONNECT_ALARM_NAME);
  if (clearResult?.catch) {
    clearResult.catch((error) => {
      logError('[connector] Failed to clear reconnect alarm:', error);
    });
  }
}

function scheduleReconnect(delayMs) {
  installReconnectAlarmListener();
  clearReconnect();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
  chrome.alarms?.create?.(RECONNECT_ALARM_NAME, {
    when: Date.now() + delayMs,
  });
}

function socketReadyStateName(socket) {
  switch (socket?.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return 'missing';
  }
}

async function waitForConnectorState(predicate, timeoutMs = 1500) {
  const initial = await getConnectorBridgeState();
  if (predicate(initial)) return initial;
  if (!chrome.storage.onChanged?.addListener) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = await getConnectorBridgeState();
      if (predicate(state)) return state;
    }
    return getConnectorBridgeState();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChanged);
      resolve(await getConnectorBridgeState());
    };
    const timer = setTimeout(finish, timeoutMs);
    const onChanged = (changes, areaName) => {
      if (areaName !== 'local') return;
      if (
        ![
          STORAGE_KEYS.state,
          STORAGE_KEYS.deviceId,
          STORAGE_KEYS.lastError,
          STORAGE_KEYS.lastErrorCode,
        ].some((key) => key in changes)
      ) {
        return;
      }
      void getConnectorBridgeState().then((state) => {
        if (predicate(state)) void finish();
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
  });
}

function closeSocketForReconnect(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    if (currentSocket === socket) currentSocket = null;
    return Promise.resolve();
  }
  if (currentSocket === socket) currentSocket = null;
  if (pendingRequest) {
    pendingRequest.reject(new Error('Desktop bridge disconnected'));
    pendingRequest = null;
  }
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
    socket._ignoreClose = true;
    socket.close();
  });
}

function hasAuthenticatedOpenSocket() {
  return (
    currentSocket?._authenticated && currentSocket.readyState === WebSocket.OPEN
  );
}

async function refreshAuthenticatedSocketStatus({
  diagnosticCode,
  logMessage,
  awaitFlush,
}) {
  const socket = currentSocket;
  if (!hasAuthenticatedOpenSocket()) return false;
  clearReconnect();
  if (pendingRequest) {
    await bridgeRequestQueue.catch(() => {});
    if (currentSocket !== socket || !hasAuthenticatedOpenSocket()) {
      return false;
    }
  }
  const status = await requestStatus().catch(async (error) => {
    await setDiagnostic(diagnosticCode, {
      message: error.message,
      code: error.code || null,
    });
    logDebug(logMessage, error.message);
    return null;
  });
  if (!status) return false;
  if (currentSocket !== socket || !hasAuthenticatedOpenSocket()) return false;
  // A successful status probe proves transport liveness, not daemon write
  // health. Preserve stronger states such as PAUSED until a new session auth.
  if (cachedConnectorState().state !== CONNECTOR_STATES.PAUSED) {
    await setState(CONNECTOR_STATES.CONNECTED, {
      [STORAGE_KEYS.lastError]: null,
      [STORAGE_KEYS.lastErrorCode]: null,
    });
  }
  // An await above can let close handling authenticate a replacement socket.
  // Never publish fallback state here that could overwrite that newer session.
  if (currentSocket !== socket || !hasAuthenticatedOpenSocket()) {
    return false;
  }
  const flush = flushBufferedMessages();
  if (awaitFlush) await flush;
  else void flush;
  return true;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error(`Snapshot ${field} must be a non-empty string`);
    error.code = 'invalid_snapshot_payload';
    throw error;
  }
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const error = new Error(`Snapshot ${field} must be a string when provided`);
  error.code = 'invalid_snapshot_payload';
  throw error;
}

function requiredTimestamp(value) {
  if (!Number.isSafeInteger(value)) {
    const error = new Error('Snapshot timestamp must be a safe integer');
    error.code = 'invalid_snapshot_payload';
    throw error;
  }
  return value;
}

function appendOptionalString(payload, key, value) {
  const normalized = optionalString(value, key);
  if (normalized !== undefined) payload[key] = normalized;
}

function buildBufferedBridgePayload(next, stats) {
  const base = {
    bufferDepth: Math.max(stats.pendingCommands - 1, 0),
    bufferBytes: Math.max(stats.pendingBytes - bufferedMessageSize(next), 0),
  };

  if (next.kind === 'command') {
    if (
      typeof next.action !== 'string' ||
      next.action.trim() === '' ||
      next.request === null ||
      typeof next.request !== 'object' ||
      Array.isArray(next.request)
    ) {
      return null;
    }
    return {
      ...base,
      type: 'run_command',
      action: next.action,
      request: next.request,
    };
  }

  return null;
}

function buildSnapshotBridgePayload(snapshot, stats) {
  const payload = {
    source: 'extension',
    bufferDepth: stats.pendingCommands,
    bufferBytes: stats.pendingBytes,
    type: 'snapshot',
    slug: requiredString(snapshot.slug, 'slug'),
    ts: requiredTimestamp(snapshot.ts),
    url: requiredString(snapshot.url, 'url'),
    html: requiredString(snapshot.html, 'html'),
  };
  appendOptionalString(payload, 'title', snapshot.title);
  appendOptionalString(payload, 'markdown', snapshot.markdown);
  return payload;
}

async function waitForAuthenticatedSocket(timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasAuthenticatedOpenSocket()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return hasAuthenticatedOpenSocket();
}

async function candidatePorts({ storedOnly = false } = {}) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.port]);
  const preferred = stored[STORAGE_KEYS.port];
  const hasPreferred = preferred !== undefined && preferred !== null;
  if (
    hasPreferred &&
    (!Number.isInteger(preferred) || preferred < 1 || preferred > 65_535)
  ) {
    const error = new Error(
      'Stored connector port must be an integer from 1 to 65535',
    );
    error.code = 'invalid_connector_port';
    throw error;
  }
  if (storedOnly) {
    return hasPreferred ? [preferred] : [];
  }
  const override = configuredPortOverride();
  const ports = override || DEFAULT_PORTS;
  if (!hasPreferred) return ports;
  if (override && !ports.includes(preferred)) return ports;
  return [preferred, ...ports.filter((port) => port !== preferred)];
}

function configuredPortOverride() {
  const override = globalThis.__BROWSER_RECALL_CONNECTOR_PORTS;
  if (override === undefined) return null;
  if (
    !Array.isArray(override) ||
    override.length === 0 ||
    !override.every(
      (port) => Number.isInteger(port) && port > 0 && port < 65_536,
    )
  ) {
    const error = new Error(
      'Connector port override must be a non-empty array of valid ports',
    );
    error.code = 'invalid_connector_port_override';
    throw error;
  }
  return [...new Set(override)];
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      socket.close();
      const error = new Error('connect_timeout');
      error.code = 'connect_timeout';
      error.port = port;
      reject(error);
    }, SOCKET_OPEN_TIMEOUT_MS);

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        const error = new Error('connect_error');
        error.code = 'connect_error';
        error.port = port;
        reject(error);
      },
      { once: true },
    );
  });
}

async function connect(options = {}) {
  if (
    currentSocket &&
    (currentSocket.readyState === WebSocket.CLOSED ||
      currentSocket.readyState === WebSocket.CLOSING)
  ) {
    currentSocket = null;
  }
  if (currentSocket || connectPromise) return connectPromise;

  connectPromise = (async () => {
    await syncBufferStats();
    await setState(
      started ? CONNECTOR_STATES.CONNECTING : CONNECTOR_STATES.STARTING,
    );

    let ports;
    try {
      ports = await candidatePorts(options);
    } catch (error) {
      const errorCode = error.code || 'invalid_connector_configuration';
      await setDiagnostic('invalid_connector_configuration', {
        message: error.message,
        errorCode,
      });
      await setState(CONNECTOR_STATES.PAUSED, {
        [STORAGE_KEYS.port]: null,
        [STORAGE_KEYS.lastError]: error.message,
        [STORAGE_KEYS.lastErrorCode]: errorCode,
      });
      return;
    }
    logDebug('[connector] connect start', {
      ports,
      storedOnly: Boolean(options.storedOnly),
    });
    const failures = [];
    for (const port of ports) {
      try {
        logDebug('[connector] connecting port', { port, ports });
        const socket = await openSocket(port);
        currentSocket = socket;
        await writeState({ [STORAGE_KEYS.port]: port });
        logDebug('[connector] socket open', { port });
        attachSocket(socket);

        const stored = await chrome.storage.local.get([STORAGE_KEYS.token]);

        if (stored[STORAGE_KEYS.token]) {
          socket.send(
            JSON.stringify({
              type: 'auth',
              protocolVersion: CONNECTOR_PROTOCOL_VERSION,
              token: stored[STORAGE_KEYS.token],
            }),
          );
        } else {
          socket.send(JSON.stringify(await buildPairRequest()));
        }
        return;
      } catch (error) {
        failures.push({
          port,
          code: error.code || error.message || 'connect_error',
        });
      }
    }

    await setDiagnostic('no_ports_reachable', { ports, failures });
    await setState(CONNECTOR_STATES.OFFLINE);
    scheduleReconnect(RECONNECT_DELAY_MS);
  })();

  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

async function markSocketAuthenticated(socket, { source, storagePatch = {} }) {
  clearReconnect();
  await clearDiagnostic();
  if (Object.keys(storagePatch).length) {
    await writeState(storagePatch);
  }
  socket._authenticated = true;
  try {
    await refreshAfterAuthentication();
    if (cachedConnectorState().state !== CONNECTOR_STATES.PAUSED) {
      await setState(CONNECTOR_STATES.CONNECTED, {
        [STORAGE_KEYS.lastError]: null,
        [STORAGE_KEYS.lastErrorCode]: null,
      });
    }
  } catch (error) {
    await setDiagnostic('status_after_auth_failed', {
      source,
      message: error.message,
      code: error.code || null,
    });
    logDebug(`[connector] status after ${source} failed:`, error.message);
    socket._closeState = CONNECTOR_STATES.OFFLINE;
    socket._reconnectDelayMs = RECONNECT_DELAY_MS;
    await setState(CONNECTOR_STATES.OFFLINE, {
      [STORAGE_KEYS.lastError]: error.message,
      [STORAGE_KEYS.lastErrorCode]: error.code || 'status_after_auth_failed',
    });
    socket.close();
  }
}

async function setPausedState(payload) {
  await setState(CONNECTOR_STATES.PAUSED, {
    [STORAGE_KEYS.lastError]: payload.message || 'Browser Recall is paused',
    [STORAGE_KEYS.lastErrorCode]: payload.code || 'paused',
  });
}

async function rejectIncompatibleDaemon(socket, payload) {
  const actual = payload.protocolVersion ?? null;
  await setDiagnostic('incompatible_protocol', {
    expected: CONNECTOR_PROTOCOL_VERSION,
    actual,
  });
  socket._closeState = CONNECTOR_STATES.INCOMPATIBLE;
  socket._reconnectDelayMs = RECONNECT_DELAY_MS;
  await setState(CONNECTOR_STATES.INCOMPATIBLE, {
    [STORAGE_KEYS.lastError]:
      'Desktop app and browser extension versions are incompatible. Update and restart both.',
    [STORAGE_KEYS.lastErrorCode]: 'incompatible_protocol',
  });
  socket.close();
}

function hasCompatibleDaemonProtocol(payload) {
  return payload.protocolVersion === CONNECTOR_PROTOCOL_VERSION;
}

function daemonResponseError(payload) {
  const error = new Error(payload.message || payload.error || 'Daemon error');
  error.code = payload.code || payload.error || 'daemon_error';
  error.payload = payload;
  return error;
}

async function settlePendingRequest(payload) {
  if (!pendingRequest?.acceptTypes.includes(payload.type)) return false;
  const request = pendingRequest;
  pendingRequest = null;
  if (payload.type === 'error') {
    if (payload.error === 'paused') await setPausedState(payload);
    request.reject(daemonResponseError(payload));
  } else {
    request.resolve(payload);
  }
  return true;
}

async function handleSocketMessage(socket, payload) {
  if (await settlePendingRequest(payload)) return;

  switch (payload.type) {
    case 'pair_approved':
      if (!hasCompatibleDaemonProtocol(payload)) {
        await rejectIncompatibleDaemon(socket, payload);
        break;
      }
      await markSocketAuthenticated(socket, {
        source: 'pair',
        storagePatch: {
          [STORAGE_KEYS.deviceId]: payload.deviceId,
          [STORAGE_KEYS.token]: payload.token,
        },
      });
      break;
    case 'auth_ok':
      if (!hasCompatibleDaemonProtocol(payload)) {
        await rejectIncompatibleDaemon(socket, payload);
        break;
      }
      await markSocketAuthenticated(socket, { source: 'auth' });
      break;
    case 'pair_pending':
      await setState(CONNECTOR_STATES.PAIR_PENDING);
      break;
    case 'auth_fail':
      await setDiagnostic('auth_fail', {
        reason: payload.reason || null,
      });
      socket._closeState = CONNECTOR_STATES.AUTH_FAILED;
      socket._reconnectDelayMs = 250;
      await chrome.storage.local.remove([STORAGE_KEYS.token]);
      removeConnectorStorageCache([STORAGE_KEYS.token]);
      socket.close();
      break;
    case 'pair_denied':
      await setDiagnostic('pair_denied');
      socket._closeState = CONNECTOR_STATES.PAIR_DENIED;
      socket._reconnectDelayMs = 30_000;
      socket.close();
      break;
    case 'error':
      if (payload.code === 'incompatible_protocol') {
        await rejectIncompatibleDaemon(socket, payload);
      } else if (payload.error === 'paused') {
        await setPausedState(payload);
      } else {
        await setDiagnostic(payload.code || payload.error || 'daemon_error', {
          message: payload.message || payload.error || 'Daemon error',
          error: payload.error || null,
        });
        socket._closeState = CONNECTOR_STATES.OFFLINE;
        socket._reconnectDelayMs = RECONNECT_DELAY_MS;
        socket.close();
      }
      break;
    case 'change':
      broadcastDaemonMutations(payload.mutations);
      break;
    default:
      throw new Error(
        `Desktop sent unsupported connector message type: ${String(payload.type)}`,
      );
  }
}

async function rejectInvalidDaemonMessage(socket, error) {
  logError('[connector] invalid desktop message:', error);
  await setDiagnostic('invalid_daemon_message', {
    message: error.message,
  });
  socket._closeState = CONNECTOR_STATES.OFFLINE;
  socket._reconnectDelayMs = RECONNECT_DELAY_MS;
  await setState(CONNECTOR_STATES.OFFLINE, {
    [STORAGE_KEYS.lastError]: error.message,
    [STORAGE_KEYS.lastErrorCode]: 'invalid_daemon_message',
  });
  socket.close();
}

async function handleSocketClose(socket) {
  if (socket._ignoreClose) return;
  if (currentSocket === socket) currentSocket = null;
  if (pendingRequest) {
    pendingRequest.reject(new Error('Desktop bridge disconnected'));
    pendingRequest = null;
  }
  if (socket._closeState) {
    await setState(socket._closeState);
    scheduleReconnect(socket._reconnectDelayMs ?? RECONNECT_DELAY_MS);
    return;
  }
  if (socket._authenticated) {
    await setDiagnostic('socket_closed', {
      state: 'authenticated_socket_closed',
      readyState: socketReadyStateName(socket),
    });
    await setState(CONNECTOR_STATES.CONNECTING);
    void connect({ storedOnly: true });
    return;
  }
  await setDiagnostic('socket_closed', {
    state: 'unauthenticated_socket_closed',
    readyState: socketReadyStateName(socket),
  });
  await setState(CONNECTOR_STATES.OFFLINE);
  scheduleReconnect(RECONNECT_DELAY_MS);
}

function attachSocket(socket) {
  socket.addEventListener('message', (event) => {
    void (async () => {
      const payload = JSON.parse(event.data);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Desktop connector message must be an object');
      }
      await handleSocketMessage(socket, payload);
    })().catch((error) => rejectInvalidDaemonMessage(socket, error));
  });

  socket.addEventListener('close', () => handleSocketClose(socket), {
    once: true,
  });
}

async function refreshAfterAuthentication() {
  await requestStatus();
  await flushBufferedMessages();
}

async function sendBridgeMessage(message, acceptTypes, options = {}) {
  const previous = bridgeRequestQueue;
  let releaseQueue;
  bridgeRequestQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  // This promise is only the serialization tail. The request that created it
  // received and observed its own rejection before the next request proceeds.
  await previous.catch(() => {});
  try {
    await ensureBridgeReadyForRequest();
    return await sendBridgeMessageNow(message, acceptTypes, options);
  } finally {
    releaseQueue();
  }
}

async function ensureBridgeReadyForRequest() {
  if (hasAuthenticatedOpenSocket()) return;

  const stored = await chrome.storage.local.get([STORAGE_KEYS.token]);
  if (!stored[STORAGE_KEYS.token]) return;

  if (currentSocket?.readyState === WebSocket.CLOSED) {
    currentSocket = null;
  }

  if (!currentSocket) {
    if (!started) started = true;
    await connect({ storedOnly: true });
  } else if (connectPromise) {
    await connectPromise;
  }

  if (await waitForAuthenticatedSocket()) return;
  throw new Error('Desktop bridge is not connected');
}

function sendBridgeMessageNow(message, acceptTypes, options = {}) {
  if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
    throw new Error('Desktop bridge is not connected');
  }
  if (pendingRequest) {
    throw new Error('Desktop bridge request already in flight');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingRequest?.timer !== timer) return;
      pendingRequest = null;
      const error = new Error('Desktop bridge request timed out');
      error.code = 'bridge_timeout';
      reject(error);
    }, options.timeoutMs || BRIDGE_REQUEST_TIMEOUT_MS);
    pendingRequest = {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
      acceptTypes,
      timer,
    };
    try {
      currentSocket.send(JSON.stringify(message));
    } catch (error) {
      clearTimeout(timer);
      pendingRequest = null;
      reject(error);
    }
  });
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Desktop status ${field} must be a non-negative integer`);
  }
  return value;
}

function validateStatusPayload(payload) {
  const expectedKeys = new Set([
    'type',
    'connectedBrowsers',
    'bufferDepth',
    'bufferBytes',
    'daemonBufferDepth',
    'lastDrainedAt',
    'dataFolder',
    'deviceId',
  ]);
  for (const key of Object.keys(payload)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`Desktop status contains unknown field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`Desktop status is missing field: ${key}`);
    }
  }
  if (payload.type !== 'status') {
    throw new Error('Desktop status response has the wrong message type');
  }
  if (
    !Array.isArray(payload.connectedBrowsers) ||
    payload.connectedBrowsers.some(
      (browser) => typeof browser !== 'string' || browser.length === 0,
    )
  ) {
    throw new Error(
      'Desktop status connectedBrowsers must contain non-empty strings',
    );
  }
  requireNonNegativeInteger(payload.bufferDepth, 'bufferDepth');
  requireNonNegativeInteger(payload.bufferBytes, 'bufferBytes');
  requireNonNegativeInteger(payload.daemonBufferDepth, 'daemonBufferDepth');
  if (
    payload.lastDrainedAt !== null &&
    !Number.isSafeInteger(payload.lastDrainedAt)
  ) {
    throw new Error('Desktop status lastDrainedAt must be an integer or null');
  }
  for (const key of ['dataFolder', 'deviceId']) {
    if (typeof payload[key] !== 'string' || payload[key].length === 0) {
      throw new Error(`Desktop status ${key} must be a non-empty string`);
    }
  }
  return payload;
}

async function requestStatus() {
  if (!currentSocket?._authenticated) {
    throw new Error('Cannot request desktop status before authentication');
  }
  const payload = validateStatusPayload(
    await sendBridgeMessage({ type: 'get_status' }, ['status', 'error']),
  );
  const statePatch = {
    [STORAGE_KEYS.daemonBufferDepth]: payload.daemonBufferDepth,
    [STORAGE_KEYS.lastDrainedAt]: payload.lastDrainedAt,
    [STORAGE_KEYS.dataFolder]: payload.dataFolder,
    [STORAGE_KEYS.deviceId]: payload.deviceId,
  };
  if (cachedConnectorState().state !== CONNECTOR_STATES.PAUSED) {
    statePatch[STORAGE_KEYS.lastError] = null;
    statePatch[STORAGE_KEYS.lastErrorCode] = null;
  }
  await writeState(statePatch);
  await clearDiagnostic();
  return payload;
}

async function waitForIdleBridge() {
  if (flushPromise) {
    await flushPromise;
  }
}

async function flushBufferedMessages() {
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    while (
      currentSocket?._authenticated &&
      currentSocket.readyState === WebSocket.OPEN
    ) {
      const next = await peekBufferedMessage();
      if (!next) {
        await syncBufferStats();
        return;
      }
      try {
        const stats = await bufferStats();
        const payload = buildBufferedBridgePayload(next, stats);
        if (!payload) {
          const message = `Connector queue contains unsupported item kind: ${String(next.kind)}`;
          await setDiagnostic('invalid_buffer_item', {
            message,
            kind: next.kind ?? null,
          });
          await setState(CONNECTOR_STATES.PAUSED, {
            [STORAGE_KEYS.lastError]: message,
            [STORAGE_KEYS.lastErrorCode]: 'invalid_buffer_item',
          });
          return;
        }
        const response = await sendBridgeMessage(payload, [
          'ack',
          'command_result',
          'error',
        ]);
        if (response.type === 'command_result' && response.success === false) {
          const error = new Error(
            response.error ||
              response.response?.error ||
              'Desktop command failed',
          );
          error.code = response.code || 'command_error';
          throw error;
        }
        if (
          response.type === 'command_result' &&
          (response.success !== true ||
            !response.response ||
            typeof response.response !== 'object' ||
            Array.isArray(response.response))
        ) {
          const error = new Error(
            'Desktop returned an incomplete command acknowledgement',
          );
          error.code = 'invalid_command_response';
          throw error;
        }
        await shiftBufferedMessage();
        const commandResponse = response.response;
        const statePatch = {
          [STORAGE_KEYS.daemonBufferDepth]: payload.bufferDepth,
          [STORAGE_KEYS.lastError]: null,
          [STORAGE_KEYS.lastErrorCode]: null,
        };
        if (Number.isSafeInteger(commandResponse.timestamp)) {
          statePatch[STORAGE_KEYS.lastDrainedAt] = commandResponse.timestamp;
        }
        await writeState(statePatch);
      } catch (error) {
        if (error.code === 'replay_error' || error.code === 'fs_error') {
          await setState(CONNECTOR_STATES.PAUSED, {
            [STORAGE_KEYS.lastError]: error.message,
            [STORAGE_KEYS.lastErrorCode]: error.code,
          });
        } else if (error.code === 'invalid_message') {
          await setState(CONNECTOR_STATES.PAUSED, {
            [STORAGE_KEYS.lastError]: error.message,
            [STORAGE_KEYS.lastErrorCode]: error.code,
          });
          return;
        } else {
          logDebug('[connector] flush failed:', error.message);
        }
        return;
      }
    }
  })();

  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
}

export async function flushDesktopBuffer() {
  if (!started) {
    await initConnectorBridge();
  } else if (!currentSocket && !connectPromise) {
    await connect();
  } else if (connectPromise) {
    await connectPromise;
  }

  if (currentSocket?._authenticated) {
    await flushBufferedMessages();
    await requestStatus();
  }

  return getConnectorBridgeState();
}

export async function clearDesktopBuffer() {
  const stats = await clearBufferedMessages();
  mergeConnectorStorageCache(bufferStatePatch(stats));
  return getConnectorBridgeState();
}

export async function initConnectorBridge() {
  installReconnectAlarmListener();
  if (started) {
    if (connectPromise) await connectPromise;
    return;
  }
  started = true;
  await setState(CONNECTOR_STATES.STARTING);
  await connect();
}

export async function restartConnectorRuntimeForTest() {
  clearReconnect();
  if (currentSocket) await closeSocketForReconnect(currentSocket);
  started = false;
  connectPromise = null;
  flushPromise = null;
  await setState(CONNECTOR_STATES.STARTING);
  void initConnectorBridge();
}

export async function refreshConnectorBridgeState(
  timeoutMs = STATE_PROBE_TIMEOUT_MS,
) {
  installReconnectAlarmListener();

  if (
    await refreshAuthenticatedSocketStatus({
      diagnosticCode: 'state_probe_status_failed',
      logMessage: '[connector] state probe status refresh failed:',
      awaitFlush: false,
    })
  ) {
    return getConnectorBridgeState();
  }

  if (
    currentSocket &&
    (currentSocket.readyState === WebSocket.CLOSED ||
      currentSocket.readyState === WebSocket.CLOSING)
  ) {
    currentSocket = null;
  }

  if (!started) {
    started = true;
    await setState(CONNECTOR_STATES.STARTING);
    await connect();
  } else if (connectPromise) {
    await connectPromise;
  } else if (!currentSocket) {
    await connect();
  }

  return waitForConnectorState((candidate) => {
    if (
      candidate.state === CONNECTOR_STATES.CONNECTED &&
      candidate.deviceId &&
      !candidate.refuseMode
    ) {
      return true;
    }
    if (candidate.state === CONNECTOR_STATES.OFFLINE) {
      return !currentSocket && !connectPromise;
    }
    return isProbeReadyConnectorState(candidate.state);
  }, timeoutMs);
}

export async function connectDesktopBridge() {
  if (
    await refreshAuthenticatedSocketStatus({
      diagnosticCode: 'manual_status_failed',
      logMessage: '[connector] manual status refresh failed:',
      awaitFlush: true,
    })
  ) {
    return getConnectorBridgeState();
  }
  if (hasAuthenticatedOpenSocket()) {
    if (currentSocket) {
      await closeSocketForReconnect(currentSocket);
    }
  }

  clearReconnect();
  await setState(CONNECTOR_STATES.CONNECTING);

  if (currentSocket) await closeSocketForReconnect(currentSocket);
  if (!started) started = true;
  const deadline = Date.now() + MANUAL_RECONNECT_DEADLINE_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    clearReconnect();
    logDebug('[connector] manual reconnect attempt', {
      attempt,
      previousSocket: socketReadyStateName(currentSocket),
    });
    await connect();
    const state = await waitForConnectorState((candidate) =>
      isTerminalConnectorState(candidate.state),
    );
    if (isManualReadyConnectorState(state.state)) {
      return state;
    }
    logDebug('[connector] manual reconnect retry', {
      attempt,
      state: state.state,
      diagnostic: state.lastDiagnostic?.code || null,
    });
    if (currentSocket && !isManualReadyConnectorState(state.state)) {
      await closeSocketForReconnect(currentSocket);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await setState(CONNECTOR_STATES.CONNECTING);
  }
  const finalState = await getConnectorBridgeState();
  const finalDiagnostic = finalState.lastDiagnostic || {};
  await setDiagnostic('manual_reconnect_exhausted', {
    elapsedMs: MANUAL_RECONNECT_DEADLINE_MS,
    lastState: finalState.state,
    lastDiagnostic: finalDiagnostic.code || null,
    failures: Array.isArray(finalDiagnostic.failures)
      ? finalDiagnostic.failures
      : [],
    ports: Array.isArray(finalDiagnostic.ports) ? finalDiagnostic.ports : [],
  });
  await setState(CONNECTOR_STATES.OFFLINE);
  return getConnectorBridgeState();
}

export async function enqueueDesktopCommand(action, request = {}) {
  const canonicalRequest = canonicalizePageRequest(request);
  const stats = await enqueueBufferedMessage({
    kind: 'command',
    action,
    request: canonicalRequest,
  });
  mergeConnectorStorageCache(bufferStatePatch(stats));
  if (currentSocket?._authenticated) {
    void flushBufferedMessages();
  } else {
    void connect();
  }
  return stats;
}

export async function enqueueDesktopSnapshot(snapshot) {
  const canonicalUrl = canonicalizePageUrl(snapshot.url);
  const message = {
    kind: 'snapshot',
    slug: snapshot.slug,
    ts: snapshot.ts,
    url: canonicalUrl,
    title: snapshot.title,
    markdown: snapshot.markdown,
    html: snapshot.html,
  };
  await ensureBridgeReadyForRequest();
  await flushBufferedMessages();
  const stats = await bufferStats();
  if (stats.pendingCommands > 0) {
    const error = new Error('Desktop command queue did not drain');
    error.code = 'desktop_queue_not_drained';
    throw error;
  }
  const payload = buildSnapshotBridgePayload(message, stats);
  const response = await sendBridgeMessage(payload, ['ack', 'error'], {
    timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
  });
  await writeState({
    [STORAGE_KEYS.lastDrainedAt]: response.lastDrainedAt,
    [STORAGE_KEYS.daemonBufferDepth]: response.bufferDepth,
    [STORAGE_KEYS.lastError]: null,
    [STORAGE_KEYS.lastErrorCode]: null,
  });
  return await syncBufferStats();
}

export async function getConnectorBridgeState() {
  const stats = await bufferStats();
  const stored = await chrome.storage.local.get(CONNECTOR_STATE_STORAGE_KEYS);
  connectorStorageCache = { ...stored, ...bufferStatePatch(stats) };
  return cachedConnectorState();
}

async function requestDesktopPayload(message, acceptTypes) {
  await waitForIdleBridge();
  return sendBridgeMessage(message, acceptTypes);
}

function validateResultEnvelope(payload, label) {
  if (payload?.type === 'error' || payload?.success === false) {
    if (typeof payload.error !== 'string' || !payload.error.trim()) {
      throw new Error(`Desktop ${label} failure response is missing an error`);
    }
    return false;
  }
  if (!payload || typeof payload !== 'object' || payload.success !== true) {
    throw new Error(`Desktop returned an incomplete ${label} response`);
  }
  return true;
}

function requireResultArray(payload, key, label) {
  if (!Array.isArray(payload[key])) {
    throw new Error(`Desktop ${label} response ${key} must be an array`);
  }
}

function requireResultObject(payload, key, label) {
  const value = payload[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Desktop ${label} response ${key} must be an object`);
  }
}

export async function requestDesktopPageInfo(slug) {
  const payload = await requestDesktopPayload(
    {
      type: 'get_page_info',
      slug,
    },
    ['page_info_result', 'error'],
  );
  if (validateResultEnvelope(payload, 'page info')) {
    if (payload.slug !== slug) {
      throw new Error('Desktop page info response slug does not match request');
    }
    requireResultArray(payload, 'snapshots', 'page info');
    requireResultArray(payload, 'notes', 'page info');
    if (
      payload.entry !== null &&
      (typeof payload.entry !== 'object' || Array.isArray(payload.entry))
    ) {
      throw new Error(
        'Desktop page info response entry must be an object or null',
      );
    }
  }
  return payload;
}

export async function requestDesktopPageSummary(url, title = null) {
  const canonicalUrl = canonicalizePageUrl(url);
  const request = {
    type: 'get_page_summary',
    url: canonicalUrl,
    title: typeof title === 'string' && title ? title : null,
  };
  const payload = await requestDesktopPayload(request, [
    'page_summary_result',
    'error',
  ]);
  if (validateResultEnvelope(payload, 'page summary')) {
    requireResultObject(payload, 'access', 'page summary');
    requireResultArray(payload, 'notes', 'page summary');
    requireResultArray(payload, 'snapshots', 'page summary');
    requireResultArray(payload, 'lists', 'page summary');
    if (
      payload.url !== canonicalUrl ||
      typeof payload.displayTitle !== 'string'
    ) {
      throw new Error(
        'Desktop page summary response identity does not match request',
      );
    }
    if (
      typeof payload.access.blacklisted !== 'boolean' ||
      typeof payload.access.hasVisitHistory !== 'boolean'
    ) {
      throw new Error(
        'Desktop page summary response access flags must be booleans',
      );
    }
    for (const key of ['page', 'attention']) {
      if (
        payload[key] !== null &&
        (typeof payload[key] !== 'object' || Array.isArray(payload[key]))
      ) {
        throw new Error(
          `Desktop page summary response ${key} must be an object or null`,
        );
      }
    }
  }
  return payload;
}

export async function requestDesktopSettings() {
  const payload = await requestDesktopPayload({ type: 'get_settings' }, [
    'settings_result',
    'error',
  ]);
  if (validateResultEnvelope(payload, 'settings')) {
    requireResultObject(payload, 'settings', 'settings');
  }
  return payload;
}

export async function requestDesktopSnapshotHtml(slug, timestamp) {
  const payload = await requestDesktopPayload(
    {
      type: 'get_snapshot_html',
      slug,
      ts: timestamp,
    },
    ['snapshot_html_result', 'error'],
  );
  if (validateResultEnvelope(payload, 'snapshot HTML')) {
    if (typeof payload.html !== 'string' || !payload.html) {
      throw new Error('Desktop snapshot HTML response must contain HTML');
    }
  }
  return payload;
}

export async function requestDesktopEntity(key) {
  const payload = await requestDesktopPayload(
    {
      type: 'test_control',
      request: { type: 'get_entity', key },
    },
    ['entity_result', 'error'],
  );
  validateResultEnvelope(payload, 'entity');
  return payload;
}

export async function requestDesktopSetDeviceId(deviceId) {
  const payload = await requestDesktopPayload(
    {
      type: 'test_control',
      request: { type: 'set_device_id', deviceId },
    },
    ['set_device_id_result', 'error'],
  );
  if (payload?.success && payload.deviceId) {
    await writeState({
      [STORAGE_KEYS.deviceId]: payload.deviceId,
    });
  }
  return payload;
}

export async function requestDesktopTestReset() {
  const payload = await requestDesktopPayload(
    {
      type: 'test_control',
      request: { type: 'reset_data' },
    },
    ['test_reset_data_result', 'error'],
  );
  if (payload?.success && payload.deviceId) {
    await writeState({
      [STORAGE_KEYS.deviceId]: payload.deviceId,
    });
  }
  return payload;
}

export async function requestDesktopTestSeed(files) {
  return requestDesktopPayload(
    {
      type: 'test_control',
      request: { type: 'seed_data', files },
    },
    ['test_seed_data_result', 'error'],
  );
}

export async function requestDesktopHistoryFiles(includeSizes = false) {
  const payload = await requestDesktopPayload(
    {
      type: 'list_history_files',
      includeSizes,
    },
    ['history_files_result', 'error'],
  );
  if (validateResultEnvelope(payload, 'history files')) {
    requireResultArray(payload, 'files', 'history files');
    requireResultArray(payload, 'devices', 'history files');
    if (includeSizes) {
      requireResultObject(payload, 'sizes', 'history files');
    } else if (
      !Object.prototype.hasOwnProperty.call(payload, 'sizes') ||
      payload.sizes !== null
    ) {
      throw new Error(
        'Desktop history files response sizes must be null when sizes were not requested',
      );
    }
  }
  return payload;
}

export async function requestDesktopHistoryBatch(files) {
  const payload = await requestDesktopPayload(
    {
      type: 'load_history_batch',
      files,
    },
    ['history_batch_result', 'error'],
  );
  if (validateResultEnvelope(payload, 'history batch')) {
    requireResultArray(payload, 'entries', 'history batch');
  }
  return payload;
}

export async function requestDesktopCommand(action, request = {}) {
  const canonicalRequest = canonicalizePageRequest(request);
  await ensureBridgeReadyForRequest();
  await flushBufferedMessages();
  const stats = await bufferStats();
  if (stats.pendingCommands !== 0 || stats.pendingBytes !== 0) {
    throw new Error(
      'Desktop command queue did not drain before direct command',
    );
  }
  const payload = await requestDesktopPayload(
    {
      type: 'run_command',
      action,
      request: canonicalRequest,
      bufferDepth: 0,
      bufferBytes: 0,
    },
    ['command_result', 'error'],
  );
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Desktop returned no response for ${action}`);
  }
  if (payload.success !== true) {
    throw new Error(payload.error || `${action} failed`);
  }
  if (
    !payload.response ||
    typeof payload.response !== 'object' ||
    Array.isArray(payload.response)
  ) {
    throw new Error(`Desktop returned an incomplete response for ${action}`);
  }
  return { success: true, ...payload.response };
}
