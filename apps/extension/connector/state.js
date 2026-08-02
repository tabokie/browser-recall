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

export const CONNECTOR_STORAGE_KEYS = {
  deviceId: 'connectorDeviceId',
  port: 'connectorDaemonPort',
  state: 'connectorState',
  token: 'connectorAuthToken',
  lastError: 'connectorLastError',
  lastDiagnostic: 'connectorLastDiagnostic',
};

export const CONNECTOR_STATE_STORAGE_KEYS = [
  ...Object.values(CONNECTOR_STORAGE_KEYS),
  'desktopPendingCommands',
  'desktopPendingBytes',
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
    lastError: requireNullableString(
      storedOrInitial(stored, CONNECTOR_STORAGE_KEYS.lastError, null),
      'last error',
    ),
    lastDiagnostic,
  };
}

export function hasConnectorStateStorageChange(changes = {}) {
  return CONNECTOR_STATE_STORAGE_KEYS.some((key) => key in changes);
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
