import { sendAction } from '../utils.js';

export const CONNECTOR_STATES = Object.freeze({
  STARTING: 'starting',
  CONNECTING: 'connecting',
  PAIR_PENDING: 'pair_pending',
  PAIR_DENIED: 'pair_denied',
  AUTH_FAILED: 'auth_failed',
  INCOMPATIBLE: 'incompatible',
  CONNECTED: 'connected',
  PAUSED: 'paused',
  OFFLINE: 'offline',
});

const TERMINAL_STATES = new Set([
  CONNECTOR_STATES.CONNECTED,
  CONNECTOR_STATES.PAUSED,
  CONNECTOR_STATES.PAIR_PENDING,
  CONNECTOR_STATES.PAIR_DENIED,
  CONNECTOR_STATES.AUTH_FAILED,
  CONNECTOR_STATES.INCOMPATIBLE,
  CONNECTOR_STATES.OFFLINE,
]);

const MANUAL_READY_STATES = new Set([
  CONNECTOR_STATES.CONNECTED,
  CONNECTOR_STATES.PAUSED,
  CONNECTOR_STATES.PAIR_PENDING,
  CONNECTOR_STATES.PAIR_DENIED,
  CONNECTOR_STATES.INCOMPATIBLE,
]);

const PROBE_READY_STATES = new Set([
  CONNECTOR_STATES.CONNECTED,
  CONNECTOR_STATES.PAUSED,
  CONNECTOR_STATES.PAIR_DENIED,
  CONNECTOR_STATES.AUTH_FAILED,
  CONNECTOR_STATES.INCOMPATIBLE,
]);

export const CONNECTOR_STORAGE_KEYS = {
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

export const CONNECTOR_STATE_STORAGE_KEYS = [
  ...Object.values(CONNECTOR_STORAGE_KEYS),
  'desktopPendingCommands',
  'desktopPendingBytes',
  'desktopRefuseMode',
];

function storedOrInitial(stored, key, initialValue) {
  if (Object.prototype.hasOwnProperty.call(stored, key)) return stored[key];
  return initialValue;
}

function requireNullableString(value, key) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Stored connector ${key} must be a non-empty string or null`,
    );
  }
  return value;
}

function requireNonNegativeInteger(value, key) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored connector ${key} must be a non-negative integer`);
  }
  return value;
}

export function connectorStateFromStorage(stored = {}) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Stored connector state must be an object');
  }
  const state = storedOrInitial(
    stored,
    CONNECTOR_STORAGE_KEYS.state,
    CONNECTOR_STATES.STARTING,
  );
  if (!Object.values(CONNECTOR_STATES).includes(state)) {
    throw new Error(`Stored connector state is invalid: ${String(state)}`);
  }
  const port = storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.port, null);
  if (
    port !== null &&
    (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  ) {
    throw new Error('Stored connector port must be an integer from 1 to 65535');
  }
  const token = storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.token, null);
  const pendingCommands = requireNonNegativeInteger(
    storedOrInitial(stored, 'desktopPendingCommands', 0),
    'pending command count',
  );
  const pendingBytes = requireNonNegativeInteger(
    storedOrInitial(stored, 'desktopPendingBytes', 0),
    'pending byte count',
  );
  const refuseMode = storedOrInitial(stored, 'desktopRefuseMode', false);
  if (typeof refuseMode !== 'boolean') {
    throw new Error('Stored connector refuse mode must be a boolean');
  }
  const daemonBufferDepth = storedOrInitial(
    stored,
    CONNECTOR_STORAGE_KEYS.daemonBufferDepth,
    null,
  );
  if (daemonBufferDepth !== null) {
    requireNonNegativeInteger(daemonBufferDepth, 'daemon buffer depth');
  }
  const lastDiagnostic = storedOrInitial(
    stored,
    CONNECTOR_STORAGE_KEYS.lastDiagnostic,
    null,
  );
  if (
    lastDiagnostic !== null &&
    (!lastDiagnostic ||
      typeof lastDiagnostic !== 'object' ||
      Array.isArray(lastDiagnostic))
  ) {
    throw new Error('Stored connector diagnostic must be an object or null');
  }
  return {
    state,
    port,
    deviceId: requireNullableString(
      storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.deviceId, null),
      'device ID',
    ),
    hasToken: requireNullableString(token, 'auth token') !== null,
    pendingCommands,
    pendingBytes,
    refuseMode,
    lastError: requireNullableString(
      storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.lastError, null),
      'last error',
    ),
    lastErrorCode: requireNullableString(
      storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.lastErrorCode, null),
      'last error code',
    ),
    lastDrainedAt: (() => {
      const value = storedOrInitial(
        stored,
        CONNECTOR_STORAGE_KEYS.lastDrainedAt,
        null,
      );
      if (value !== null)
        requireNonNegativeInteger(value, 'last drained timestamp');
      return value;
    })(),
    dataFolder: requireNullableString(
      storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.dataFolder, null),
      'data folder',
    ),
    daemonBufferDepth,
    lastDiagnostic,
  };
}

export function hasConnectorStateStorageChange(changes = {}) {
  return CONNECTOR_STATE_STORAGE_KEYS.some((key) => key in changes);
}

export function isTerminalConnectorState(state) {
  return TERMINAL_STATES.has(state);
}

export function isManualReadyConnectorState(state) {
  return MANUAL_READY_STATES.has(state);
}

export function isProbeReadyConnectorState(state) {
  return PROBE_READY_STATES.has(state);
}

export async function readCachedConnectorState() {
  const stored = await chrome.storage.local.get(CONNECTOR_STATE_STORAGE_KEYS);
  return connectorStateFromStorage(stored);
}

export async function requestConnectorState() {
  return sendAction({ action: 'getDesktopConnectorState' });
}

export async function requestConnectorBridgeConnect() {
  return sendAction({ action: 'connectDesktopBridge' });
}
