import { buildPairRequest, CONNECTOR_PROTOCOL_VERSION } from './pairing.js';
import {
  bufferStats,
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
} from './state.js';
import { logDebug, logError } from '../logger.js';
import { canonicalizePageRequest, canonicalizePageUrl } from '../utils.js';
import { snapshotHtmlBudgetBytes } from '../snapshot-capture-budget.js';

const DEFAULT_PORTS = [28471, 28472, 28473];
const RECONNECT_ALARM_NAME = 'browserRecallConnectorReconnect';
const MANUAL_RECONNECT_DEADLINE_MS = 15_000;
const RECONNECT_DELAY_MS = 15_000;
const SOCKET_OPEN_TIMEOUT_MS = 5000;
const BRIDGE_REQUEST_TIMEOUT_MS = 1500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 60_000;
const SNAPSHOT_CAPTURE_ENVELOPE_RESERVE_BYTES = 64 * 1024;
const SNAPSHOT_RESOURCE_CONCURRENCY = 6;
const STATE_PROBE_TIMEOUT_MS = 2500;
const MANUAL_PAIR_SETTLE_MS = 1500;

const CONNECTION_PHASES = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  SYNCHRONIZING: 'synchronizing',
  READY: 'ready',
});

const runtime = {
  started: false,
  session: null,
  connectTask: null,
  drainTask: null,
  request: null,
  requestTail: Promise.resolve(),
  retryTimer: null,
  connection: {
    phase: CONNECTION_PHASES.OFFLINE,
    authority: null,
    failure: null,
    retryAt: null,
  },
};

let alarmListenerInstalled = false;
let connectorStorageCache = {};
let connectorStorageOperation = Promise.resolve();
const connectorStateListeners = new Set();
const daemonMutationListeners = new Set();

function presentationStateForConnection(connection) {
  switch (connection.phase) {
    case CONNECTION_PHASES.CONNECTING:
      return CONNECTOR_STATES.CONNECTING;
    case CONNECTION_PHASES.WAITING_FOR_APPROVAL:
      return CONNECTOR_STATES.PAIR_PENDING;
    case CONNECTION_PHASES.SYNCHRONIZING:
      return connection.failure
        ? CONNECTOR_STATES.PAUSED
        : CONNECTOR_STATES.CONNECTING;
    case CONNECTION_PHASES.READY:
      return connection.authority?.state === 'paused' || connection.failure
        ? CONNECTOR_STATES.PAUSED
        : CONNECTOR_STATES.CONNECTED;
    case CONNECTION_PHASES.OFFLINE:
    default:
      switch (connection.failure?.code) {
        case 'incompatible_protocol':
          return CONNECTOR_STATES.INCOMPATIBLE;
        case 'auth_failed':
          return CONNECTOR_STATES.AUTH_FAILED;
        case 'pair_denied':
          return CONNECTOR_STATES.PAIR_DENIED;
        case 'invalid_connector_port':
        case 'invalid_connector_port_override':
        case 'invalid_connector_configuration':
          return CONNECTOR_STATES.PAUSED;
        default:
          return CONNECTOR_STATES.OFFLINE;
      }
  }
}

async function transitionConnection(
  phase,
  details = {},
  presentationPatch = {},
  expectedSession = null,
) {
  if (expectedSession && !isCurrentSession(expectedSession)) return false;
  runtime.connection = {
    phase,
    authority: phase === CONNECTION_PHASES.READY ? { state: 'running' } : null,
    failure: null,
    retryAt: null,
    ...details,
  };
  notifyConnectorStateListeners();
  const written = await writeConnectionPresentation(
    presentationPatch,
    expectedSession,
  );
  return written && (!expectedSession || isCurrentSession(expectedSession));
}

async function setConnectionFailure(failure) {
  runtime.connection = { ...runtime.connection, failure };
  notifyConnectorStateListeners();
  await writeState({
    [STORAGE_KEYS.state]: presentationStateForConnection(runtime.connection),
  });
}

function createSession(socket) {
  const session = {
    socket,
    authenticated: false,
    statusTask: null,
    maxMessageBytes: null,
    closePolicy: null,
    ignoreClose: false,
  };
  runtime.session = session;
  return session;
}

function isCurrentSession(session) {
  return runtime.session === session;
}

function cachedConnectorState() {
  const state = {
    ...connectorStateFromStorage(connectorStorageCache),
    connection: { ...runtime.connection },
  };
  if (runtime.started) {
    state.state = presentationStateForConnection(runtime.connection);
  }
  return state;
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
  };
}

function broadcastDaemonMutations(mutations) {
  if (!Array.isArray(mutations)) {
    throw new Error('Desktop change message mutations must be an array');
  }
  for (const mutation of mutations) {
    if (
      !mutation ||
      typeof mutation !== 'object' ||
      Array.isArray(mutation) ||
      ['type', 'url', 'urls'].some(
        (key) => !Object.prototype.hasOwnProperty.call(mutation, key),
      ) ||
      typeof mutation.type !== 'string'
    ) {
      throw new Error('Desktop change message contains an invalid mutation');
    }
    if (mutation.url !== null && typeof mutation.url !== 'string') {
      throw new Error('Desktop mutation url must be a string or null');
    }
    if (
      mutation.urls !== null &&
      (!Array.isArray(mutation.urls) ||
        mutation.urls.some((url) => typeof url !== 'string'))
    ) {
      throw new Error('Desktop mutation urls must be a string array or null');
    }
    const canonicalMutation = {
      type: mutation.type,
      url: mutation.url,
      urls: mutation.urls,
    };
    for (const listener of [...daemonMutationListeners]) {
      try {
        listener(canonicalMutation);
      } catch (error) {
        logDebug('[connector] daemon mutation listener failed:', error.message);
      }
    }
    chrome.runtime
      .sendMessage({ action: 'mutation', ...canonicalMutation })
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
    runtime.retryTimer = null;
    runtime.connection.retryAt = null;
    notifyConnectorStateListeners();
    launchConnect();
  });
}

function withConnectorStorageOperation(operation) {
  // Session callbacks must re-check ownership after every await; serializing
  // persistence also prevents an older session write from landing last.
  const run = connectorStorageOperation.then(operation, operation);
  connectorStorageOperation = run.catch(() => {});
  return run;
}

async function readState(keys) {
  await connectorStorageOperation.catch(() => {});
  return chrome.storage.local.get(keys);
}

async function writeState(patch, expectedSession = null) {
  return withConnectorStorageOperation(async () => {
    if (expectedSession && !isCurrentSession(expectedSession)) return false;
    await chrome.storage.local.set(patch);
    mergeConnectorStorageCache(patch);
    return !expectedSession || isCurrentSession(expectedSession);
  });
}

async function removeState(keys, expectedSession = null) {
  return withConnectorStorageOperation(async () => {
    if (expectedSession && !isCurrentSession(expectedSession)) return false;
    await chrome.storage.local.remove(keys);
    removeConnectorStorageCache(keys);
    return !expectedSession || isCurrentSession(expectedSession);
  });
}

async function syncBufferStats() {
  const stats = await bufferStats();
  mergeConnectorStorageCache(bufferStatePatch(stats));
  return stats;
}

async function writeConnectionPresentation(extra = {}, expectedSession = null) {
  await writeState(
    {
      [STORAGE_KEYS.state]: presentationStateForConnection(runtime.connection),
      ...extra,
    },
    expectedSession,
  );
  return !expectedSession || isCurrentSession(expectedSession);
}

async function publishUnexpectedConnectionFailure(error, source) {
  const failure = {
    code: error?.code || 'connector_runtime_failed',
    message: error?.message || String(error),
  };
  logError(`[connector] ${source}:`, error);
  runtime.connection = {
    phase: CONNECTION_PHASES.OFFLINE,
    authority: null,
    failure,
    retryAt: null,
  };
  notifyConnectorStateListeners();
  try {
    await writeConnectionPresentation({
      [STORAGE_KEYS.lastError]: failure.message,
      [STORAGE_KEYS.lastDiagnostic]: {
        code: failure.code,
        source,
        message: failure.message,
        at: Date.now(),
      },
    });
  } catch (storageError) {
    logError(
      '[connector] Failed to persist connector runtime failure:',
      storageError,
    );
  }
  scheduleReconnect(RECONNECT_DELAY_MS);
}

function observeUnexpectedConnectionFailure(error, source) {
  void publishUnexpectedConnectionFailure(error, source).catch(
    (publicationError) => {
      logError(
        '[connector] Failed to publish unexpected connection failure:',
        publicationError,
      );
    },
  );
}

function launchConnect(options = {}) {
  void connect(options).catch((error) => {
    logError('[connector] Failed to finalize connection failure:', error);
  });
}

function launchDrain() {
  void flushBufferedMessages().catch(async (error) => {
    const failure = {
      code: error?.code || 'buffer_flush_failed',
      message: error?.message || String(error),
    };
    logError('[connector] background buffer drain failed:', error);
    try {
      await setDiagnostic('buffer_flush_failed', {
        message: failure.message,
        errorCode: failure.code,
      });
      await setConnectionFailure(failure);
      await writeConnectionPresentation({
        [STORAGE_KEYS.lastError]: failure.message,
      });
    } catch (publicationError) {
      logError(
        '[connector] Failed to publish background buffer drain failure:',
        publicationError,
      );
    }
  });
}

function isTerminalConnection(connection) {
  return [
    CONNECTION_PHASES.OFFLINE,
    CONNECTION_PHASES.WAITING_FOR_APPROVAL,
    CONNECTION_PHASES.READY,
  ].includes(connection.phase);
}

function isManualReadyConnection(connection) {
  if (connection.phase === CONNECTION_PHASES.READY) return true;
  if (connection.phase === CONNECTION_PHASES.WAITING_FOR_APPROVAL) return true;
  return (
    connection.phase === CONNECTION_PHASES.OFFLINE &&
    ['incompatible_protocol', 'pair_denied'].includes(connection.failure?.code)
  );
}

function isProbeReadyConnection(connection) {
  if (connection.phase === CONNECTION_PHASES.READY) return true;
  return (
    connection.phase === CONNECTION_PHASES.OFFLINE &&
    ['incompatible_protocol', 'pair_denied', 'auth_failed'].includes(
      connection.failure?.code,
    )
  );
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

async function clearDiagnostic(expectedSession = null) {
  return removeState(STORAGE_KEYS.lastDiagnostic, expectedSession);
}

function clearReconnect() {
  if (runtime.retryTimer) {
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  }
  runtime.connection.retryAt = null;
  notifyConnectorStateListeners();
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
  const retryAt = Date.now() + delayMs;
  runtime.connection.retryAt = retryAt;
  notifyConnectorStateListeners();
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null;
    runtime.connection.retryAt = null;
    notifyConnectorStateListeners();
    launchConnect();
  }, delayMs);
  chrome.alarms?.create?.(RECONNECT_ALARM_NAME, {
    when: retryAt,
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

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let unsubscribe = () => {};
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    };
    unsubscribe = subscribeConnectorBridgeState((state) => {
      if (predicate(state)) finish(state);
    });
    timer = setTimeout(() => {
      void getConnectorBridgeState().then(finish).catch(fail);
    }, timeoutMs);
    const current = cachedConnectorState();
    if (predicate(current)) {
      finish(current);
    }
  });
}

function closeSessionForReconnect(session) {
  const socket = session?.socket;
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    if (isCurrentSession(session)) runtime.session = null;
    return Promise.resolve();
  }
  if (isCurrentSession(session)) runtime.session = null;
  if (runtime.request?.session === session) {
    runtime.request.reject(new Error('Desktop bridge disconnected'));
    runtime.request = null;
  }
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
    session.ignoreClose = true;
    socket.close();
  });
}

function hasAuthenticatedOpenSocket() {
  return (
    runtime.session?.authenticated &&
    runtime.session.socket.readyState === WebSocket.OPEN
  );
}

async function refreshAuthenticatedSocketStatus({
  diagnosticCode,
  logMessage,
  awaitFlush,
}) {
  const session = runtime.session;
  if (!hasAuthenticatedOpenSocket()) return false;
  clearReconnect();
  if (runtime.request) {
    await runtime.requestTail.catch(() => {});
    if (!isCurrentSession(session) || !hasAuthenticatedOpenSocket()) {
      return false;
    }
  }
  const status = await requestStatus().catch(async (error) => {
    await setDiagnostic(diagnosticCode, {
      message: error.message,
      code: error.code || null,
    });
    logDebug(logMessage, error.message);
    if (isCurrentSession(session)) {
      await closeSessionForReconnect(session);
      await transitionConnection(CONNECTION_PHASES.OFFLINE, {
        failure: {
          code: error.code || diagnosticCode,
          message: error.message,
        },
      });
    }
    return null;
  });
  if (!status) return false;
  if (!isCurrentSession(session) || !hasAuthenticatedOpenSocket()) return false;
  if (status.authority.state === 'paused') return true;
  if (awaitFlush) await flushBufferedMessages();
  else launchDrain();
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

function buildBufferedBridgePayload(next) {
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
      type: 'run_command',
      action: next.action,
      request: next.request,
    };
  }

  return null;
}

function buildSnapshotBridgePayload(snapshot) {
  const payload = {
    type: 'snapshot',
    slug: requiredString(snapshot.slug, 'slug'),
    ts: requiredTimestamp(snapshot.ts),
    url: requiredString(snapshot.url, 'url'),
    title: optionalString(snapshot.title, 'title') ?? null,
    markdown: optionalString(snapshot.markdown, 'markdown') ?? null,
    html: requiredString(snapshot.html, 'html'),
  };
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
  const stored = await readState([STORAGE_KEYS.port]);
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
  const current = runtime.session;
  if (
    current &&
    (current.socket.readyState === WebSocket.CLOSED ||
      current.socket.readyState === WebSocket.CLOSING)
  ) {
    runtime.session = null;
  }
  if (runtime.session || runtime.connectTask) return runtime.connectTask;

  runtime.connectTask = (async () => {
    await syncBufferStats();
    await transitionConnection(CONNECTION_PHASES.CONNECTING);

    let ports;
    try {
      ports = await candidatePorts(options);
    } catch (error) {
      const errorCode = error.code || 'invalid_connector_configuration';
      await setDiagnostic('invalid_connector_configuration', {
        message: error.message,
        errorCode,
      });
      await transitionConnection(
        CONNECTION_PHASES.OFFLINE,
        { failure: { code: errorCode, message: error.message } },
        {
          [STORAGE_KEYS.port]: null,
          [STORAGE_KEYS.lastError]: error.message,
        },
      );
      return;
    }
    logDebug('[connector] connect start', {
      ports,
      storedOnly: Boolean(options.storedOnly),
    });
    const failures = [];
    for (const port of ports) {
      let socket;
      try {
        logDebug('[connector] connecting port', { port, ports });
        socket = await openSocket(port);
      } catch (error) {
        failures.push({
          port,
          code: error.code || error.message || 'connect_error',
        });
        continue;
      }

      const session = createSession(socket);
      try {
        await writeState({ [STORAGE_KEYS.port]: port });
        logDebug('[connector] socket open', { port });
        attachSocket(session);

        const stored = await readState([STORAGE_KEYS.token]);

        if (stored[STORAGE_KEYS.token]) {
          socket.send(
            JSON.stringify({
              type: 'auth',
              protocolVersion: CONNECTOR_PROTOCOL_VERSION,
              token: stored[STORAGE_KEYS.token],
            }),
          );
        } else {
          await transitionConnection(CONNECTION_PHASES.WAITING_FOR_APPROVAL);
          socket.send(JSON.stringify(await buildPairRequest()));
        }
        return;
      } catch (error) {
        await closeSessionForReconnect(session);
        throw error;
      }
    }

    await setDiagnostic('no_ports_reachable', { ports, failures });
    await transitionConnection(CONNECTION_PHASES.OFFLINE, {
      failure: { code: 'no_ports_reachable', failures },
    });
    scheduleReconnect(RECONNECT_DELAY_MS);
  })();

  try {
    return await runtime.connectTask;
  } catch (error) {
    await publishUnexpectedConnectionFailure(error, 'connection task failed');
  } finally {
    runtime.connectTask = null;
  }
}

async function ensureConnection(options = {}) {
  runtime.started = true;
  if (
    runtime.session &&
    (runtime.session.socket.readyState === WebSocket.CLOSED ||
      runtime.session.socket.readyState === WebSocket.CLOSING)
  ) {
    runtime.session = null;
  }
  if (runtime.connectTask) {
    await runtime.connectTask;
  } else if (!runtime.session) {
    await connect(options);
  }
  return runtime.session;
}

async function markSessionAuthenticated(
  session,
  { source, storagePatch = {} },
) {
  if (!isCurrentSession(session)) return;
  clearReconnect();
  if (!(await clearDiagnostic(session))) return;
  if (Object.keys(storagePatch).length) {
    if (!(await writeState(storagePatch, session))) return;
  }
  if (!isCurrentSession(session)) return;
  session.authenticated = true;
  if (
    !(await transitionConnection(
      CONNECTION_PHASES.SYNCHRONIZING,
      {},
      {},
      session,
    ))
  ) {
    return;
  }
  session.statusTask = requestStatus(session);
  try {
    const status = await session.statusTask;
    if (!isCurrentSession(session)) return;
    if (status.authority.state === 'paused') return;
    const drained = await flushBufferedMessages();
    if (!isCurrentSession(session)) return;
    if (!drained) {
      if (cachedConnectorState().state === CONNECTOR_STATES.PAUSED) return;
      const error = new Error(
        'Desktop command outbox did not drain during connection synchronization',
      );
      error.code = 'outbox_sync_failed';
      throw error;
    }
    await transitionConnection(
      CONNECTION_PHASES.READY,
      {},
      { [STORAGE_KEYS.lastError]: null },
      session,
    );
  } catch (error) {
    if (!isCurrentSession(session)) return;
    await setDiagnostic('status_after_auth_failed', {
      source,
      message: error.message,
      code: error.code || null,
    });
    logDebug(`[connector] status after ${source} failed:`, error.message);
    session.closePolicy = {
      delayMs: RECONNECT_DELAY_MS,
      failure: {
        code: error.code || 'status_after_auth_failed',
        message: error.message,
      },
    };
    await transitionConnection(
      CONNECTION_PHASES.OFFLINE,
      {
        failure: {
          code: error.code || 'status_after_auth_failed',
          message: error.message,
        },
      },
      { [STORAGE_KEYS.lastError]: error.message },
      session,
    );
    if (!isCurrentSession(session)) return;
    session.socket.close();
  }
}

async function setPausedState(payload, expectedSession = runtime.session) {
  const message = payload.message || 'Browser Recall is paused';
  return transitionConnection(
    CONNECTION_PHASES.READY,
    {
      authority: {
        state: 'paused',
        code: payload.code || 'paused',
        message,
      },
    },
    { [STORAGE_KEYS.lastError]: message },
    expectedSession,
  );
}

async function rejectIncompatibleDaemon(session, payload) {
  const actual = payload.protocolVersion ?? null;
  await setDiagnostic('incompatible_protocol', {
    expected: CONNECTOR_PROTOCOL_VERSION,
    actual,
  });
  if (!isCurrentSession(session)) return;
  session.closePolicy = {
    delayMs: RECONNECT_DELAY_MS,
    failure: { code: 'incompatible_protocol' },
  };
  await transitionConnection(
    CONNECTION_PHASES.OFFLINE,
    { failure: { code: 'incompatible_protocol' } },
    {
      [STORAGE_KEYS.lastError]:
        'Desktop app and browser extension versions are incompatible. Update and restart both.',
    },
    session,
  );
  if (!isCurrentSession(session)) return;
  session.socket.close();
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

async function settlePendingRequest(session, payload) {
  if (
    runtime.request?.session !== session ||
    !runtime.request.acceptTypes.includes(payload.type)
  ) {
    return false;
  }
  const request = runtime.request;
  runtime.request = null;
  if (payload.type === 'error') {
    if (payload.error === 'paused') await setPausedState(payload, session);
    request.reject(daemonResponseError(payload));
  } else {
    request.resolve(payload);
  }
  return true;
}

async function handleSocketMessage(session, payload) {
  if (!isCurrentSession(session)) return;
  if (await settlePendingRequest(session, payload)) return;
  if (!isCurrentSession(session)) return;

  switch (payload.type) {
    case 'pair_approved':
      if (!hasCompatibleDaemonProtocol(payload)) {
        await rejectIncompatibleDaemon(session, payload);
        break;
      }
      await markSessionAuthenticated(session, {
        source: 'pair',
        storagePatch: {
          [STORAGE_KEYS.token]: payload.token,
        },
      });
      break;
    case 'auth_ok':
      if (!hasCompatibleDaemonProtocol(payload)) {
        await rejectIncompatibleDaemon(session, payload);
        break;
      }
      await markSessionAuthenticated(session, { source: 'auth' });
      break;
    case 'pair_pending':
      await transitionConnection(
        CONNECTION_PHASES.WAITING_FOR_APPROVAL,
        {},
        {},
        session,
      );
      break;
    case 'auth_fail':
      await setDiagnostic('auth_fail', {
        reason: payload.reason || null,
      });
      if (!isCurrentSession(session)) return;
      session.closePolicy = {
        delayMs: 250,
        failure: {
          code: 'auth_failed',
          reason: payload.reason || null,
        },
      };
      if (!(await removeState([STORAGE_KEYS.token], session))) return;
      session.socket.close();
      break;
    case 'pair_denied':
      await setDiagnostic('pair_denied');
      if (!isCurrentSession(session)) return;
      session.closePolicy = {
        delayMs: 30_000,
        failure: { code: 'pair_denied' },
      };
      session.socket.close();
      break;
    case 'error':
      if (payload.code === 'incompatible_protocol') {
        await rejectIncompatibleDaemon(session, payload);
      } else if (payload.error === 'paused') {
        await setPausedState(payload, session);
      } else {
        await setDiagnostic(payload.code || payload.error || 'daemon_error', {
          message: payload.message || payload.error || 'Daemon error',
          error: payload.error || null,
        });
        if (!isCurrentSession(session)) return;
        session.closePolicy = {
          delayMs: RECONNECT_DELAY_MS,
          failure: {
            code: payload.code || payload.error || 'daemon_error',
            message: payload.message || payload.error || 'Daemon error',
          },
        };
        session.socket.close();
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

async function rejectInvalidDaemonMessage(session, error) {
  if (!isCurrentSession(session)) return;
  logError('[connector] invalid desktop message:', error);
  await setDiagnostic('invalid_daemon_message', {
    message: error.message,
  });
  if (!isCurrentSession(session)) return;
  session.closePolicy = {
    delayMs: RECONNECT_DELAY_MS,
    failure: { code: 'invalid_daemon_message', message: error.message },
  };
  await writeConnectionPresentation(
    { [STORAGE_KEYS.lastError]: error.message },
    session,
  );
  if (!isCurrentSession(session)) return;
  session.socket.close();
}

async function handleSocketClose(session) {
  if (session.ignoreClose || !isCurrentSession(session)) return;
  runtime.session = null;
  if (runtime.request?.session === session) {
    runtime.request.reject(new Error('Desktop bridge disconnected'));
    runtime.request = null;
  }
  if (session.closePolicy) {
    await transitionConnection(CONNECTION_PHASES.OFFLINE, {
      failure: session.closePolicy.failure,
    });
    scheduleReconnect(session.closePolicy.delayMs);
    return;
  }
  if (session.authenticated) {
    await setDiagnostic('socket_closed', {
      state: 'authenticated_socket_closed',
      readyState: socketReadyStateName(session.socket),
    });
    await transitionConnection(CONNECTION_PHASES.CONNECTING);
    launchConnect({ storedOnly: true });
    return;
  }
  await setDiagnostic('socket_closed', {
    state: 'unauthenticated_socket_closed',
    readyState: socketReadyStateName(session.socket),
  });
  await transitionConnection(CONNECTION_PHASES.OFFLINE, {
    failure: { code: 'socket_closed' },
  });
  scheduleReconnect(RECONNECT_DELAY_MS);
}

function attachSocket(session) {
  session.socket.addEventListener('message', (event) => {
    void (async () => {
      const payload = JSON.parse(event.data);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Desktop connector message must be an object');
      }
      await handleSocketMessage(session, payload);
    })().catch(async (error) => {
      try {
        await rejectInvalidDaemonMessage(session, error);
      } catch (rejectionError) {
        logError(
          '[connector] Failed to publish invalid desktop message:',
          rejectionError,
        );
      }
    });
  });

  session.socket.addEventListener(
    'close',
    () => {
      void handleSocketClose(session).catch((error) =>
        observeUnexpectedConnectionFailure(
          error,
          'socket close handler failed',
        ),
      );
    },
    { once: true },
  );
}

async function sendBridgeMessage(message, acceptTypes, options = {}) {
  const previous = runtime.requestTail;
  let releaseQueue;
  runtime.requestTail = new Promise((resolve) => {
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

  const stored = await readState([STORAGE_KEYS.token]);
  if (!stored[STORAGE_KEYS.token]) return;

  await ensureConnection({ storedOnly: true });

  if (await waitForAuthenticatedSocket()) return;
  throw new Error('Desktop bridge is not connected');
}

function sendBridgeMessageNow(message, acceptTypes, options = {}) {
  const session = runtime.session;
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    throw new Error('Desktop bridge is not connected');
  }
  if (runtime.request) {
    throw new Error('Desktop bridge request already in flight');
  }
  const serializedMessage = JSON.stringify(message);
  if (message.type === 'snapshot') {
    const maxMessageBytes = session.maxMessageBytes;
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
      const error = new Error(
        'Desktop did not advertise a valid snapshot message limit',
      );
      error.code = 'missing_desktop_message_limit';
      throw error;
    }
    const payloadBytes = new TextEncoder().encode(serializedMessage).length;
    if (payloadBytes > maxMessageBytes) {
      const error = new Error(
        `Snapshot message is ${payloadBytes} bytes, exceeding the ${maxMessageBytes}-byte desktop message limit`,
      );
      error.code = 'snapshot_message_too_large';
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (runtime.request?.timer !== timer) return;
      runtime.request = null;
      const error = new Error('Desktop bridge request timed out');
      error.code = 'bridge_timeout';
      reject(error);
    }, options.timeoutMs || BRIDGE_REQUEST_TIMEOUT_MS);
    runtime.request = {
      session,
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
      session.socket.send(serializedMessage);
    } catch (error) {
      clearTimeout(timer);
      runtime.request = null;
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
  const requiredKeys = ['type', 'deviceId', 'maxMessageBytes', 'authority'];
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error(`Desktop status is missing field: ${key}`);
    }
  }
  if (payload.type !== 'status') {
    throw new Error('Desktop status response has the wrong message type');
  }
  requireNonNegativeInteger(payload.maxMessageBytes, 'maxMessageBytes');
  if (payload.maxMessageBytes === 0) {
    throw new Error('Desktop status maxMessageBytes must be greater than zero');
  }
  if (typeof payload.deviceId !== 'string' || payload.deviceId.length === 0) {
    throw new Error('Desktop status deviceId must be a non-empty string');
  }
  if (
    !payload.authority ||
    typeof payload.authority !== 'object' ||
    Array.isArray(payload.authority) ||
    !['running', 'paused'].includes(payload.authority.state)
  ) {
    throw new Error('Desktop status authority must be running or paused');
  }
  if (payload.authority.state === 'paused') {
    for (const key of ['code', 'message']) {
      if (
        typeof payload.authority[key] !== 'string' ||
        !payload.authority[key]
      ) {
        throw new Error(
          `Paused desktop authority ${key} must be a non-empty string`,
        );
      }
    }
  }
  return payload;
}

async function requestStatus(expectedSession = runtime.session) {
  if (!expectedSession?.authenticated || !isCurrentSession(expectedSession)) {
    throw new Error('Cannot request desktop status before authentication');
  }
  const payload = validateStatusPayload(
    await sendBridgeMessage({ type: 'get_status' }, ['status', 'error']),
  );
  if (!isCurrentSession(expectedSession) || !expectedSession.authenticated) {
    throw new Error('Desktop bridge changed while reading status');
  }
  expectedSession.maxMessageBytes = payload.maxMessageBytes;
  const statePatch = {
    [STORAGE_KEYS.deviceId]: payload.deviceId,
    [STORAGE_KEYS.lastError]: null,
  };
  if (payload.authority.state === 'paused') {
    if (!(await setPausedState(payload.authority, expectedSession))) {
      throw new Error('Desktop bridge changed while applying paused status');
    }
    if (
      !(await writeState(
        { [STORAGE_KEYS.deviceId]: payload.deviceId },
        expectedSession,
      ))
    ) {
      throw new Error('Desktop bridge changed while storing status identity');
    }
  } else if (runtime.connection.phase === CONNECTION_PHASES.SYNCHRONIZING) {
    if (!(await writeState(statePatch, expectedSession))) {
      throw new Error('Desktop bridge changed while storing status');
    }
  } else {
    const existingFailure = runtime.connection.failure;
    await transitionConnection(
      CONNECTION_PHASES.READY,
      existingFailure ? { failure: existingFailure } : {},
      statePatch,
      expectedSession,
    );
  }
  if (!(await clearDiagnostic(expectedSession))) {
    throw new Error('Desktop bridge changed while clearing status diagnostics');
  }
  return payload;
}

async function requireDesktopSnapshotMessageLimit() {
  const session = runtime.session;
  if (session?.statusTask) {
    await session.statusTask;
  }
  if (!isCurrentSession(session) || !hasAuthenticatedOpenSocket()) {
    const error = new Error(
      'Desktop bridge changed before communicating the snapshot message limit',
    );
    error.code = 'desktop_bridge_changed';
    throw error;
  }
  const maxMessageBytes = session.maxMessageBytes;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    const error = new Error(
      'Desktop did not advertise a valid snapshot message limit',
    );
    error.code = 'missing_desktop_message_limit';
    throw error;
  }
  return maxMessageBytes;
}

async function waitForIdleBridge() {
  if (runtime.drainTask) {
    await runtime.drainTask.promise;
  }
}

async function flushBufferedMessages(expectedSession = runtime.session) {
  if (
    !expectedSession?.authenticated ||
    !isCurrentSession(expectedSession) ||
    expectedSession.socket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  if (runtime.drainTask) {
    if (runtime.drainTask.session === expectedSession) {
      return runtime.drainTask.promise;
    }
    await runtime.drainTask.promise.catch(() => {});
    if (
      !isCurrentSession(expectedSession) ||
      expectedSession.socket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    return flushBufferedMessages(expectedSession);
  }

  const drain = { session: expectedSession, promise: null };
  drain.promise = (async () => {
    while (
      isCurrentSession(expectedSession) &&
      expectedSession.authenticated &&
      expectedSession.socket.readyState === WebSocket.OPEN
    ) {
      const next = await peekBufferedMessage();
      if (!isCurrentSession(expectedSession)) return false;
      if (!next) {
        await syncBufferStats();
        if (!isCurrentSession(expectedSession)) return false;
        await setConnectionFailure(null);
        return true;
      }
      try {
        const payload = buildBufferedBridgePayload(next);
        if (!payload) {
          const message = `Connector queue contains unsupported item kind: ${String(next.kind)}`;
          await setDiagnostic('invalid_buffer_item', {
            message,
            kind: next.kind ?? null,
          });
          if (!isCurrentSession(expectedSession)) return false;
          await setConnectionFailure({ code: 'invalid_buffer_item', message });
          if (!isCurrentSession(expectedSession)) return false;
          await writeConnectionPresentation({
            [STORAGE_KEYS.lastError]: message,
          });
          return false;
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
        if (!isCurrentSession(expectedSession)) return false;
        await writeState({ [STORAGE_KEYS.lastError]: null }, expectedSession);
      } catch (error) {
        if (!isCurrentSession(expectedSession)) return false;
        const code = error.code || 'buffer_flush_failed';
        if (!['replay_error', 'fs_error', 'invalid_message'].includes(code)) {
          await setDiagnostic('buffer_flush_failed', {
            message: error.message,
            errorCode: code,
          });
          logDebug('[connector] flush failed:', error.message);
        }
        if (!isCurrentSession(expectedSession)) return false;
        await setConnectionFailure({ code, message: error.message });
        if (!isCurrentSession(expectedSession)) return false;
        await writeConnectionPresentation({
          [STORAGE_KEYS.lastError]: error.message,
        });
        return false;
      }
    }
    return false;
  })();
  runtime.drainTask = drain;

  try {
    return await drain.promise;
  } finally {
    if (runtime.drainTask === drain) runtime.drainTask = null;
  }
}

export async function flushDesktopBuffer() {
  if (!runtime.started) {
    await initConnectorBridge();
  } else {
    await ensureConnection();
  }

  if (runtime.session?.authenticated) {
    const drained = await flushBufferedMessages();
    if (drained) await requestStatus();
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
  if (runtime.started) {
    if (runtime.connectTask) await runtime.connectTask;
    return;
  }
  runtime.started = true;
  await ensureConnection();
}

export async function restartConnectorRuntimeForTest() {
  clearReconnect();
  const drainPromise = runtime.drainTask?.promise;
  if (runtime.session) await closeSessionForReconnect(runtime.session);
  await drainPromise?.catch(() => {});
  runtime.started = false;
  runtime.connectTask = null;
  runtime.drainTask = null;
  runtime.request = null;
  runtime.requestTail = Promise.resolve();
  await transitionConnection(CONNECTION_PHASES.OFFLINE);
  void initConnectorBridge().catch((error) => {
    observeUnexpectedConnectionFailure(error, 'connector restart failed');
  });
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

  await ensureConnection();

  return waitForConnectorState((candidate) => {
    if (
      candidate.connection.phase === CONNECTION_PHASES.READY &&
      candidate.deviceId
    ) {
      return true;
    }
    if (candidate.connection.phase === CONNECTION_PHASES.OFFLINE) {
      return !runtime.session && !runtime.connectTask;
    }
    return isProbeReadyConnection(candidate.connection);
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
    if (runtime.session) {
      await closeSessionForReconnect(runtime.session);
    }
  }

  clearReconnect();

  if (runtime.session) await closeSessionForReconnect(runtime.session);
  if (!runtime.started) runtime.started = true;
  const deadline = Date.now() + MANUAL_RECONNECT_DEADLINE_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    clearReconnect();
    logDebug('[connector] manual reconnect attempt', {
      attempt,
      previousSocket: socketReadyStateName(runtime.session?.socket),
    });
    await connect();
    // Auto-approved pairing still emits pair_pending before its final result.
    // Give that transient state time to settle; a real pending approval is
    // returned when the bounded wait expires.
    const state = await waitForConnectorState(
      (candidate) =>
        isTerminalConnection(candidate.connection) &&
        candidate.connection.phase !== CONNECTION_PHASES.WAITING_FOR_APPROVAL,
      MANUAL_PAIR_SETTLE_MS,
    );
    if (isManualReadyConnection(state.connection)) {
      return state;
    }
    logDebug('[connector] manual reconnect retry', {
      attempt,
      state: state.state,
      diagnostic: state.lastDiagnostic?.code || null,
    });
    if (runtime.session && !isManualReadyConnection(state.connection)) {
      await closeSessionForReconnect(runtime.session);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  if (runtime.session) await closeSessionForReconnect(runtime.session);
  await transitionConnection(CONNECTION_PHASES.OFFLINE, {
    failure: {
      code: 'manual_reconnect_exhausted',
      message: 'Desktop reconnect attempts were exhausted',
    },
  });
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
  if (runtime.session?.authenticated) {
    launchDrain();
  } else {
    launchConnect();
  }
  return stats;
}

async function prepareSnapshotRequest() {
  await ensureBridgeReadyForRequest();
  const maxMessageBytes = await requireDesktopSnapshotMessageLimit();
  await flushBufferedMessages();
  const stats = await bufferStats();
  if (stats.pendingCommands > 0) {
    const error = new Error('Desktop command queue did not drain');
    error.code = 'desktop_queue_not_drained';
    throw error;
  }
  return maxMessageBytes;
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
  await prepareSnapshotRequest();
  const payload = buildSnapshotBridgePayload(message);
  await sendBridgeMessage(payload, ['ack', 'error'], {
    timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
  });
  await writeState({
    [STORAGE_KEYS.lastError]: null,
  });
  return await syncBufferStats();
}

export async function requestDesktopSnapshotCaptureBudget(snapshot) {
  const canonicalUrl = canonicalizePageUrl(snapshot.url);
  const maxMessageBytes = await prepareSnapshotRequest();
  const payload = buildSnapshotBridgePayload({
    kind: 'snapshot',
    slug: snapshot.slug,
    ts: snapshot.ts,
    url: canonicalUrl,
    title: snapshot.title,
    markdown: snapshot.markdown,
    html: 'x',
  });
  payload.html = '';
  return {
    maxEncodedHtmlBytes: snapshotHtmlBudgetBytes({
      maxMessageBytes,
      payload,
      reserveBytes: SNAPSHOT_CAPTURE_ENVELOPE_RESERVE_BYTES,
    }),
    maxConcurrentResourceLoads: SNAPSHOT_RESOURCE_CONCURRENCY,
  };
}

export async function getConnectorBridgeState() {
  const stats = await bufferStats();
  const stored = await readState(CONNECTOR_STATE_STORAGE_KEYS);
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
      type: 'test_control',
      request: { type: 'list_history_files', includeSizes },
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
      type: 'test_control',
      request: { type: 'load_history_batch', files },
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
