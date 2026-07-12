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
import { logDebug } from '../logger.js';
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
let connectorStatsCache = {};
const connectorStateListeners = new Set();
const daemonMutationListeners = new Set();

function cachedConnectorState() {
  return connectorStateFromStorage(connectorStorageCache, connectorStatsCache);
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

function updateConnectorStatsCache(stats) {
  connectorStatsCache = stats || {};
  notifyConnectorStateListeners();
}

function broadcastDaemonMutations(mutations) {
  if (!Array.isArray(mutations)) return;
  for (const mutation of mutations) {
    if (!mutation || typeof mutation.type !== 'string') continue;
    for (const listener of [...daemonMutationListeners]) {
      try {
        listener(mutation);
      } catch (error) {
        logDebug('[connector] daemon mutation listener failed:', error.message);
      }
    }
    chrome.runtime
      .sendMessage({ action: 'mutation', ...mutation })
      .catch(() => {});
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
  mergeConnectorStorageCache(patch);
  await chrome.storage.local.set(patch);
}

async function syncBufferStats() {
  const stats = await bufferStats();
  await writeState({
    desktopPendingCommands: stats.pendingCommands,
    desktopPendingBytes: stats.pendingBytes,
    desktopRefuseMode: stats.refuseMode,
  });
  updateConnectorStatsCache(stats);
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
  removeConnectorStorageCache(STORAGE_KEYS.lastDiagnostic);
  await chrome.storage.local.remove(STORAGE_KEYS.lastDiagnostic);
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const clearResult = chrome.alarms?.clear?.(RECONNECT_ALARM_NAME);
  if (clearResult?.catch) clearResult.catch(() => {});
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

function requiredString(value) {
  return typeof value === 'string' ? value : '';
}

function optionalString(value) {
  return typeof value === 'string' ? value : undefined;
}

function requiredTimestamp(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function appendOptionalString(payload, key, value) {
  const normalized = optionalString(value);
  if (normalized !== undefined) payload[key] = normalized;
}

function buildBufferedBridgePayload(next, stats) {
  const base = {
    source: 'extension',
    bufferDepth: Math.max(stats.pendingCommands - 1, 0),
    bufferBytes: Math.max(stats.pendingBytes - bufferedMessageSize(next), 0),
  };

  if (next.kind === 'command') {
    return {
      ...base,
      type: 'run_command',
      action: next.action,
      request: next.request ?? {},
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
    slug: requiredString(snapshot.slug),
    ts: requiredTimestamp(snapshot.ts),
    url: requiredString(snapshot.url),
    html: requiredString(snapshot.html),
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
  const hasPreferred =
    Number.isInteger(preferred) && preferred > 0 && preferred < 65536;
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
  if (Array.isArray(override)) {
    const ports = override.filter(
      (port) => Number.isInteger(port) && port > 0 && port < 65536,
    );
    if (ports.length > 0) return ports;
  }
  return null;
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

    const ports = await candidatePorts(options);
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
        await chrome.storage.local.set({ [STORAGE_KEYS.port]: port });
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
  await setState(CONNECTOR_STATES.CONNECTED, {
    [STORAGE_KEYS.lastError]: null,
    [STORAGE_KEYS.lastErrorCode]: null,
  });
  void refreshAfterAuthentication(source);
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
      removeConnectorStorageCache([STORAGE_KEYS.token]);
      await chrome.storage.local.remove([STORAGE_KEYS.token]);
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
      break;
  }
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
  socket.addEventListener('message', async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    await handleSocketMessage(socket, payload);
  });

  socket.addEventListener('close', () => handleSocketClose(socket), {
    once: true,
  });
}

async function refreshAfterAuthentication(source) {
  try {
    await requestStatus();
  } catch (error) {
    await setDiagnostic('status_after_auth_failed', {
      source,
      message: error.message,
      code: error.code || null,
    });
    logDebug(`[connector] status after ${source} failed:`, error.message);
  }
  await flushBufferedMessages();
}

async function sendBridgeMessage(message, acceptTypes, options = {}) {
  const previous = bridgeRequestQueue;
  let releaseQueue;
  bridgeRequestQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

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

async function requestStatus() {
  if (!currentSocket?._authenticated) return null;
  const payload = await sendBridgeMessage({ type: 'get_status' }, [
    'status',
    'error',
  ]);
  const statePatch = {
    [STORAGE_KEYS.daemonBufferDepth]:
      payload.daemonBufferDepth ?? payload.bufferDepth,
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
          logDebug(
            '[connector] dropping unknown buffered item kind:',
            next.kind,
          );
          await shiftBufferedMessage();
          continue;
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
        await shiftBufferedMessage();
        const commandResponse = response.response || {};
        await writeState({
          [STORAGE_KEYS.lastDrainedAt]:
            response.lastDrainedAt || commandResponse.timestamp || Date.now(),
          [STORAGE_KEYS.daemonBufferDepth]:
            response.bufferDepth ?? commandResponse.bufferDepth,
          [STORAGE_KEYS.lastError]: null,
          [STORAGE_KEYS.lastErrorCode]: null,
        });
      } catch (error) {
        if (error.code === 'replay_error' || error.code === 'fs_error') {
          await setState(CONNECTOR_STATES.PAUSED, {
            [STORAGE_KEYS.lastError]: error.message,
            [STORAGE_KEYS.lastErrorCode]: error.code,
          });
        } else if (error.code === 'invalid_message') {
          logDebug(
            '[connector] dropping invalid buffered item:',
            error.message,
          );
          await shiftBufferedMessage();
          await writeState({
            [STORAGE_KEYS.lastError]: error.message,
            [STORAGE_KEYS.lastErrorCode]: error.code,
          });
          continue;
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
    await requestStatus().catch((error) => {
      logDebug('[connector] post-flush status refresh failed:', error.message);
      return null;
    });
  }

  return getConnectorBridgeState();
}

export async function clearDesktopBuffer() {
  const stats = await clearBufferedMessages();
  updateConnectorStatsCache(stats);
  await writeState({
    desktopPendingCommands: stats.pendingCommands,
    desktopPendingBytes: stats.pendingBytes,
    desktopRefuseMode: stats.refuseMode,
  });
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
  await syncBufferStats();
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
  connectorStatsCache = stats || {};
  connectorStorageCache = { ...connectorStorageCache, ...stored };
  return cachedConnectorState();
}

async function requestDesktopPayload(message, acceptTypes) {
  await waitForIdleBridge();
  return sendBridgeMessage(message, acceptTypes);
}

export async function requestDesktopPageInfo(slug) {
  return requestDesktopPayload(
    {
      type: 'get_page_info',
      slug,
    },
    ['page_info_result', 'error'],
  );
}

export async function requestDesktopPageSummary(url, title = null) {
  const canonicalUrl = canonicalizePageUrl(url);
  const request = {
    type: 'get_page_summary',
    url: canonicalUrl,
  };
  if (typeof title === 'string' && title) request.title = title;
  return requestDesktopPayload(request, ['page_summary_result', 'error']);
}

export async function requestDesktopSettings() {
  return requestDesktopPayload({ type: 'get_settings' }, [
    'settings_result',
    'error',
  ]);
}

export async function requestDesktopSnapshotHtml(slug, timestamp) {
  return requestDesktopPayload(
    {
      type: 'get_snapshot_html',
      slug,
      ts: timestamp,
    },
    ['snapshot_html_result', 'error'],
  );
}

export async function requestDesktopEntity(key) {
  return requestDesktopPayload(
    {
      type: 'get_entity',
      key,
    },
    ['entity_result', 'error'],
  );
}

export async function requestDesktopSetDeviceId(deviceId) {
  const payload = await requestDesktopPayload(
    {
      type: 'set_device_id',
      deviceId,
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
      type: 'test_reset_data',
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
      type: 'test_seed_data',
      files,
    },
    ['test_seed_data_result', 'error'],
  );
}

export async function requestDesktopHistoryFiles(includeSizes = false) {
  return requestDesktopPayload(
    {
      type: 'list_history_files',
      includeSizes,
    },
    ['history_files_result', 'error'],
  );
}

export async function requestDesktopHistoryBatch(files) {
  return requestDesktopPayload(
    {
      type: 'load_history_batch',
      files,
    },
    ['history_batch_result', 'error'],
  );
}

export async function requestDesktopCommand(action, request = {}) {
  const canonicalRequest = canonicalizePageRequest(request);
  const payload = await requestDesktopPayload(
    {
      type: 'run_command',
      action,
      request: canonicalRequest,
    },
    ['command_result', 'error'],
  );
  if (!payload?.success) {
    return (
      payload?.response || {
        success: false,
        error: payload?.error || `${action} failed`,
      }
    );
  }
  return payload.response || { success: true };
}
