import { buildPairRequest } from './pairing.js';
import {
  bufferStats,
  bufferedMessageSize,
  enqueueBufferedMessage,
  peekBufferedMessage,
  shiftBufferedMessage,
} from './event-buffer.js';
import { logDebug } from '../logger.js';

const PORTS = [28471, 28472, 28473];
const STORAGE_KEYS = {
  deviceId: 'connectorDeviceId',
  port: 'connectorDaemonPort',
  state: 'connectorState',
  token: 'connectorAuthToken',
  lastError: 'connectorLastError',
  lastErrorCode: 'connectorLastErrorCode',
  lastDrainedAt: 'connectorLastDrainedAt',
  dataFolder: 'connectorDataFolder',
  daemonBufferDepth: 'connectorDaemonBufferDepth',
  lastDiagnostic: 'connectorLastDiagnostic',
};
const RECONNECT_ALARM_NAME = 'browserRecallConnectorReconnect';
const MANUAL_RECONNECT_DEADLINE_MS = 15_000;
const RECONNECT_DELAY_MS = 15_000;
const SOCKET_OPEN_TIMEOUT_MS = 3000;
const BRIDGE_REQUEST_TIMEOUT_MS = 1500;
const TERMINAL_STATES = new Set([
  'connected',
  'paused',
  'pair_pending',
  'pair_denied',
  'auth_failed',
  'offline',
]);
const MANUAL_READY_STATES = new Set([
  'connected',
  'paused',
  'pair_pending',
  'pair_denied',
]);

let currentSocket = null;
let reconnectTimer = null;
let connectPromise = null;
let flushPromise = null;
let pendingRequest = null;
let bridgeRequestQueue = Promise.resolve();
let started = false;
let alarmListenerInstalled = false;

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
}

async function syncBufferStats() {
  const stats = await bufferStats();
  await writeState({
    desktopPendingEvents: stats.pendingEvents,
    desktopPendingBytes: stats.pendingBytes,
    desktopRefuseMode: stats.refuseMode,
  });
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

function terminalConnectorState(state) {
  return TERMINAL_STATES.has(state);
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
    bufferDepth: Math.max(stats.pendingEvents - 1, 0),
    bufferBytes: Math.max(stats.pendingBytes - bufferedMessageSize(next), 0),
  };

  if (next.kind === 'note') {
    const payload = {
      ...base,
      type: 'note',
      slug: requiredString(next.slug),
      note: requiredString(next.note),
      url: requiredString(next.url),
      ts: requiredTimestamp(next.ts),
    };
    appendOptionalString(payload, 'excerpt', next.excerpt);
    appendOptionalString(payload, 'cssPath', next.cssPath);
    appendOptionalString(payload, 'oldSlug', next.oldSlug);
    appendOptionalString(payload, 'title', next.title);
    return payload;
  }

  if (next.kind === 'snapshot') {
    const payload = {
      ...base,
      type: 'snapshot',
      slug: requiredString(next.slug),
      ts: requiredTimestamp(next.ts),
      url: requiredString(next.url),
      html: requiredString(next.html),
    };
    appendOptionalString(payload, 'title', next.title);
    appendOptionalString(payload, 'markdown', next.markdown);
    return payload;
  }

  if (next.kind === 'event') {
    return {
      ...base,
      type: 'event',
      entry: next.entry ?? {},
    };
  }

  return null;
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
  if (!hasPreferred) return PORTS;
  return [preferred, ...PORTS.filter((port) => port !== preferred)];
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
    await setState(started ? 'connecting' : 'starting');

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
    await setState('offline');
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
  await setState('connected', {
    [STORAGE_KEYS.lastError]: null,
    [STORAGE_KEYS.lastErrorCode]: null,
  });
  void refreshAfterAuthentication(source);
}

function attachSocket(socket) {
  socket.addEventListener('message', async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (pendingRequest && pendingRequest.acceptTypes.includes(payload.type)) {
      const resolve = pendingRequest.resolve;
      const reject = pendingRequest.reject;
      pendingRequest = null;
      if (payload.type === 'error') {
        if (payload.error === 'paused') {
          await setState('paused', {
            [STORAGE_KEYS.lastError]:
              payload.message || 'Browser Recall is paused',
            [STORAGE_KEYS.lastErrorCode]: payload.code || 'paused',
          });
        }
        const error = new Error(
          payload.message || payload.error || 'Daemon error',
        );
        error.code = payload.code || payload.error || 'daemon_error';
        error.payload = payload;
        reject(error);
      } else {
        resolve(payload);
      }
      return;
    }

    switch (payload.type) {
      case 'pair_approved':
        await markSocketAuthenticated(socket, {
          source: 'pair',
          storagePatch: {
            [STORAGE_KEYS.deviceId]: payload.deviceId,
            [STORAGE_KEYS.token]: payload.token,
          },
        });
        break;
      case 'auth_ok':
        await markSocketAuthenticated(socket, { source: 'auth' });
        break;
      case 'pair_pending':
        await setState('pair_pending');
        break;
      case 'auth_fail':
        await setDiagnostic('auth_fail', {
          reason: payload.reason || null,
        });
        socket._closeState = 'auth_failed';
        socket._reconnectDelayMs = 250;
        await chrome.storage.local.remove([STORAGE_KEYS.token]);
        socket.close();
        break;
      case 'pair_denied':
        await setDiagnostic('pair_denied');
        socket._closeState = 'pair_denied';
        socket._reconnectDelayMs = 30_000;
        socket.close();
        break;
      case 'error':
        if (payload.error === 'paused') {
          await setState('paused', {
            [STORAGE_KEYS.lastError]:
              payload.message || 'Browser Recall is paused',
            [STORAGE_KEYS.lastErrorCode]: payload.code || 'paused',
          });
        }
        break;
      case 'pong':
        break;
      case 'change':
        for (const mutation of payload.mutations || []) {
          chrome.runtime
            .sendMessage({
              action: 'mutation',
              ...mutation,
            })
            .catch(() => {});
        }
        break;
      default:
        break;
    }
  });

  socket.addEventListener(
    'close',
    async () => {
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
        await setState('connecting');
        void connect({ storedOnly: true });
        return;
      }
      await setDiagnostic('socket_closed', {
        state: 'unauthenticated_socket_closed',
        readyState: socketReadyStateName(socket),
      });
      await setState('offline');
      scheduleReconnect(RECONNECT_DELAY_MS);
    },
    { once: true },
  );
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

async function sendBridgeMessage(message, acceptTypes) {
  const previous = bridgeRequestQueue;
  let releaseQueue;
  bridgeRequestQueue = new Promise((resolve) => {
    releaseQueue = resolve;
  });

  await previous.catch(() => {});
  try {
    await ensureBridgeReadyForRequest();
    return await sendBridgeMessageNow(message, acceptTypes);
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

function sendBridgeMessageNow(message, acceptTypes) {
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
    }, BRIDGE_REQUEST_TIMEOUT_MS);
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
  await writeState({
    [STORAGE_KEYS.daemonBufferDepth]:
      payload.daemonBufferDepth ?? payload.bufferDepth,
    [STORAGE_KEYS.lastDrainedAt]: payload.lastDrainedAt,
    [STORAGE_KEYS.dataFolder]: payload.dataFolder,
    [STORAGE_KEYS.deviceId]: payload.deviceId,
    [STORAGE_KEYS.lastError]: null,
    [STORAGE_KEYS.lastErrorCode]: null,
  });
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
        const response = await sendBridgeMessage(payload, ['ack', 'error']);
        await shiftBufferedMessage();
        await writeState({
          [STORAGE_KEYS.lastDrainedAt]: response.lastDrainedAt,
          [STORAGE_KEYS.daemonBufferDepth]: response.bufferDepth,
          [STORAGE_KEYS.lastError]: null,
          [STORAGE_KEYS.lastErrorCode]: null,
        });
      } catch (error) {
        if (error.code === 'replay_error' || error.code === 'fs_error') {
          await setState('paused', {
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

export async function initConnectorBridge() {
  installReconnectAlarmListener();
  if (started) {
    if (connectPromise) await connectPromise;
    return;
  }
  started = true;
  await setState('starting');
  await connect();
}

export async function connectDesktopBridge() {
  if (hasAuthenticatedOpenSocket()) {
    clearReconnect();
    if (pendingRequest) return getConnectorBridgeState();
    const status = await requestStatus().catch(async (error) => {
      await setDiagnostic('manual_status_failed', {
        message: error.message,
        code: error.code || null,
      });
      logDebug('[connector] manual status refresh failed:', error.message);
      return null;
    });
    if (status) {
      await flushBufferedMessages();
      return getConnectorBridgeState();
    }
    if (currentSocket) {
      await closeSocketForReconnect(currentSocket);
    }
  }

  clearReconnect();
  await setState('connecting');

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
      terminalConnectorState(candidate.state),
    );
    if (MANUAL_READY_STATES.has(state.state)) {
      return state;
    }
    logDebug('[connector] manual reconnect retry', {
      attempt,
      state: state.state,
      diagnostic: state.lastDiagnostic?.code || null,
    });
    if (currentSocket && !MANUAL_READY_STATES.has(state.state)) {
      await closeSocketForReconnect(currentSocket);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await setState('connecting');
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
  await setState('offline');
  return getConnectorBridgeState();
}

export async function enqueueDesktopEvent(entry) {
  const stats = await enqueueBufferedMessage({ kind: 'event', entry });
  await syncBufferStats();
  if (currentSocket?._authenticated) {
    void flushBufferedMessages();
  } else {
    void connect();
  }
  return stats;
}

export async function enqueueDesktopSnapshot(snapshot) {
  const stats = await enqueueBufferedMessage({
    kind: 'snapshot',
    slug: snapshot.slug,
    ts: snapshot.ts,
    url: snapshot.url,
    title: snapshot.title,
    markdown: snapshot.markdown,
    html: snapshot.html,
  });
  await syncBufferStats();
  if (currentSocket?._authenticated) {
    void flushBufferedMessages();
  } else {
    void connect();
  }
  return stats;
}

export async function enqueueDesktopNote(note) {
  const payload = {
    kind: 'note',
    slug: note.slug,
    excerpt: note.excerpt,
    note: note.note,
    cssPath: note.cssPath ?? null,
    url: note.url,
    title: note.title,
    ts: note.ts,
  };
  if (note.oldSlug) payload.oldSlug = note.oldSlug;
  const stats = await enqueueBufferedMessage(payload);
  await syncBufferStats();
  if (currentSocket?._authenticated) {
    void flushBufferedMessages();
  } else {
    void connect();
  }
  return stats;
}

export async function getConnectorBridgeState() {
  const stats = await syncBufferStats();
  const stored = await chrome.storage.local.get([
    ...Object.values(STORAGE_KEYS),
    'desktopPendingEvents',
    'desktopPendingBytes',
    'desktopRefuseMode',
  ]);
  return {
    state: stored[STORAGE_KEYS.state] || 'offline',
    port: stored[STORAGE_KEYS.port] || null,
    deviceId: stored[STORAGE_KEYS.deviceId] || null,
    hasToken: Boolean(stored[STORAGE_KEYS.token]),
    pendingEvents: stored.desktopPendingEvents ?? stats.pendingEvents,
    pendingBytes: stored.desktopPendingBytes ?? stats.pendingBytes,
    refuseMode: Boolean(stored.desktopRefuseMode ?? stats.refuseMode),
    lastError: stored[STORAGE_KEYS.lastError] || null,
    lastErrorCode: stored[STORAGE_KEYS.lastErrorCode] || null,
    lastDrainedAt: stored[STORAGE_KEYS.lastDrainedAt] || null,
    dataFolder: stored[STORAGE_KEYS.dataFolder] || null,
    daemonBufferDepth: stored[STORAGE_KEYS.daemonBufferDepth] ?? null,
    lastDiagnostic: stored[STORAGE_KEYS.lastDiagnostic] || null,
  };
}

export async function requestDesktopRuleBatch(listIds, entries) {
  await waitForIdleBridge();
  const payload = await sendBridgeMessage(
    {
      type: 'run_rule_batch',
      listIds,
      entries,
    },
    ['rule_batch_result', 'error'],
  );
  return payload;
}

export async function requestDesktopRulePreview(rule, entries) {
  await waitForIdleBridge();
  const payload = await sendBridgeMessage(
    {
      type: 'preview_rule',
      rule,
      entries,
    },
    ['preview_rule_result', 'error'],
  );
  return payload;
}

export async function requestDesktopPageInfo(slug) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_page_info',
      slug,
    },
    ['page_info_result', 'error'],
  );
}

export async function requestDesktopPageSummary(url) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_page_summary',
      url,
    },
    ['page_summary_result', 'error'],
  );
}

export async function requestDesktopSnapshotHtml(slug, timestamp) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_snapshot_html',
      slug,
      ts: timestamp,
    },
    ['snapshot_html_result', 'error'],
  );
}

export async function requestDesktopEntity(key) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_entity',
      key,
    },
    ['entity_result', 'error'],
  );
}

export async function requestDesktopDirectoryInfo() {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_directory_info',
    },
    ['directory_info_result', 'error'],
  );
}

export async function requestDesktopDirectorySize() {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_directory_size',
    },
    ['directory_size_result', 'error'],
  );
}

export async function requestDesktopClearAllData() {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'clear_all_data',
    },
    ['clear_all_data_result', 'error'],
  );
}

export async function requestDesktopSyncManifest(key) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'load_sync_manifest',
      key,
    },
    ['sync_manifest_result', 'error'],
  );
}

export async function requestDesktopSaveSyncManifest(key, data) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'save_sync_manifest',
      key,
      data,
    },
    ['sync_manifest_result', 'error'],
  );
}

export async function requestDesktopCollectSyncFiles(deviceId, retentionDays) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'collect_sync_files',
      deviceId,
      retentionDays,
    },
    ['sync_files_result', 'error'],
  );
}

export async function requestDesktopWriteSyncFiles(files) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'write_sync_files',
      files,
    },
    ['write_sync_files_result', 'error'],
  );
}

export async function requestDesktopReplayRemoteEntries(deviceId, entries) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'replay_remote_entries',
      deviceId,
      entries,
    },
    ['remote_replay_result', 'error'],
  );
}

export async function requestDesktopSetDeviceId(deviceId) {
  await waitForIdleBridge();
  const payload = await sendBridgeMessage(
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
  await waitForIdleBridge();
  const payload = await sendBridgeMessage(
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
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'test_seed_data',
      files,
    },
    ['test_seed_data_result', 'error'],
  );
}

export async function requestDesktopHistoryFiles(includeSizes = false) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'list_history_files',
      includeSizes,
    },
    ['history_files_result', 'error'],
  );
}

export async function requestDesktopHistoryBatch(files) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'load_history_batch',
      files,
    },
    ['history_batch_result', 'error'],
  );
}

export async function requestDesktopAllPages() {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_all_pages',
    },
    ['all_pages_result', 'error'],
  );
}

export async function requestDesktopPermanentDelete(keys) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'permanent_delete',
      keys,
    },
    ['permanent_delete_result', 'error'],
  );
}

export async function requestDesktopPopupLists() {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'get_popup_lists',
    },
    ['popup_lists_result', 'error'],
  );
}

export async function requestDesktopHistorySearch(query, limit) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'search_history',
      query,
      ...(limit !== undefined ? { limit } : {}),
    },
    ['search_history_result', 'error'],
  );
}

export async function requestDesktopNotesSearch(query, limit) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'search_notes',
      query,
      ...(limit !== undefined ? { limit } : {}),
    },
    ['search_notes_result', 'error'],
  );
}

export async function requestDesktopSnapshotsSearch(query, limit) {
  await waitForIdleBridge();
  return sendBridgeMessage(
    {
      type: 'search_snapshots',
      query,
      ...(limit !== undefined ? { limit } : {}),
    },
    ['search_snapshots_result', 'error'],
  );
}
