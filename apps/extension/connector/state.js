import { sendAction } from '../utils.js';

export const CONNECTOR_STATES = Object.freeze({
  STARTING: 'starting',
  CONNECTING: 'connecting',
  PAIR_PENDING: 'pair_pending',
  PAIR_DENIED: 'pair_denied',
  AUTH_FAILED: 'auth_failed',
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
  CONNECTOR_STATES.OFFLINE,
]);

const MANUAL_READY_STATES = new Set([
  CONNECTOR_STATES.CONNECTED,
  CONNECTOR_STATES.PAUSED,
  CONNECTOR_STATES.PAIR_PENDING,
  CONNECTOR_STATES.PAIR_DENIED,
]);

const PROBE_READY_STATES = new Set([
  CONNECTOR_STATES.CONNECTED,
  CONNECTOR_STATES.PAUSED,
  CONNECTOR_STATES.PAIR_DENIED,
  CONNECTOR_STATES.AUTH_FAILED,
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

export function connectorStateFromStorage(stored = {}, stats = {}) {
  return {
    state: stored[CONNECTOR_STORAGE_KEYS.state] || 'offline',
    port: stored[CONNECTOR_STORAGE_KEYS.port] || null,
    deviceId: stored[CONNECTOR_STORAGE_KEYS.deviceId] || null,
    hasToken: Boolean(stored[CONNECTOR_STORAGE_KEYS.token]),
    pendingCommands:
      stored.desktopPendingCommands ?? stats.pendingCommands ?? 0,
    pendingBytes: stored.desktopPendingBytes ?? stats.pendingBytes ?? 0,
    refuseMode: Boolean(stored.desktopRefuseMode ?? stats.refuseMode),
    lastError: stored[CONNECTOR_STORAGE_KEYS.lastError] || null,
    lastErrorCode: stored[CONNECTOR_STORAGE_KEYS.lastErrorCode] || null,
    lastDrainedAt: stored[CONNECTOR_STORAGE_KEYS.lastDrainedAt] || null,
    dataFolder: stored[CONNECTOR_STORAGE_KEYS.dataFolder] || null,
    daemonBufferDepth: stored[CONNECTOR_STORAGE_KEYS.daemonBufferDepth] ?? null,
    lastDiagnostic: stored[CONNECTOR_STORAGE_KEYS.lastDiagnostic] || null,
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
  try {
    const stored = await chrome.storage.local.get(CONNECTOR_STATE_STORAGE_KEYS);
    return connectorStateFromStorage(stored);
  } catch {
    return null;
  }
}

export async function requestConnectorState() {
  return sendAction({ action: 'getDesktopConnectorState' });
}

export async function requestConnectorBridgeConnect() {
  return sendAction({ action: 'connectDesktopBridge' });
}
