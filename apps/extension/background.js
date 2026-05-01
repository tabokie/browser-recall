// Background service worker for Browser Recall.
// Central authority for extension reads and mutations. Persistent data and
// replay are owned by the desktop daemon.
import './browser-api.js';
import {
  generateSlugFromUrl,
  generateNoteSlug,
  dateKeyFromTimestamp,
} from './utils.js';
import { validateRuleConfig, validateFnRuleSource } from './rule-engine.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { SCHEME_HEX } from './color-scheme-map.js';
import { logDebug, logError } from './logger.js';
import { createBadgeController } from './badge-controller.js';
import { getBrowserCapabilities } from './browser-capabilities.js';
import {
  enqueueDesktopEvent,
  enqueueDesktopNote,
  enqueueDesktopSnapshot,
  getConnectorBridgeState,
  flushDesktopBuffer,
  initConnectorBridge,
  refreshConnectorBridgeState,
  subscribeConnectorBridgeState,
  requestDesktopHistorySearch,
  requestDesktopHistoryFiles,
  requestDesktopHistoryBatch,
  requestDesktopPageInfo,
  requestDesktopPageSummary,
  requestDesktopNotesSearch,
  requestDesktopEntity,
  requestDesktopDirectoryInfo,
  requestDesktopDirectorySize,
  requestDesktopClearAllData,
  requestDesktopReplayRemoteEntries,
  requestDesktopAllPages,
  requestDesktopPermanentDelete,
  requestDesktopPopupLists,
  requestDesktopRuleBatch,
  requestDesktopRulePreview,
  requestDesktopSetDeviceId,
  requestDesktopSnapshotHtml,
  requestDesktopSnapshotsSearch,
  requestDesktopTestReset,
  requestDesktopTestSeed,
  connectDesktopBridge,
} from './connector/ws-client.js';
import {
  PAGE_PREFIX,
  NOTE_PREFIX,
  SNAPSHOT_PREFIX,
  LIST_PREFIX,
  entitySlug,
  isSystemList,
  pageKey,
  noteKey,
  listKey,
  snapshotKey,
} from './entity-types.js';

logDebug('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — data is safe in chrome.storage.local until drained
const HISTORY_RECENT_DAYS = 7; // days of past history to cache for multi-day checks
const LOG_BUFFER_MAX_SIZE = 2000; // max entries before forced eviction
const CONNECTOR_STATE_REFRESH_TIMEOUT_MS = 1000;
const LOG_BUFFER_STORAGE_TIMEOUT_MS = 2500;
const BROWSER_CAPABILITIES = getBrowserCapabilities();

// In-memory Map of URL → visitDates (YYYYMMDD[]) from history:recent (past days).
// Populated during hydration, immutable until next browser restart.
let recentUrls = new Map();
let lastLogTimestamp = 0;

const CONNECTOR_LAST_DRAINED_AT_KEY = 'connectorLastDrainedAt';
const NORMAL_ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

// tabId → URL from the content script's initial reportPage.
// Used by popup to avoid slug mismatch when tab.url drifts (SPA pushState, etc.).
const tabReportedUrls = new Map();

// Device ID for this instance. The daemon owns it in app config; the extension
// mirrors it locally after connector status responses.
let localDeviceId = null;

// Service error state: null = healthy, { code, message, timestamp } = paused.
// Error codes: 'session_quota', 'local_quota', 'desktop_buffer_full'.
let serviceError = null;

// Lazy getter: returns localDeviceId, asking the daemon connector on cache miss.
// Handles both startup race (message before hydrateCache) and SW wakeup (no hydrateCache).
async function getDeviceId() {
  if (localDeviceId) return localDeviceId;
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (connector.deviceId) {
    localDeviceId = connector.deviceId;
    return localDeviceId;
  }
  return localDeviceId;
}

// ─── Service Downtime State ───────────────────────────────────────────

function pauseService(code, message) {
  serviceError = { code, message, timestamp: Date.now() };
  badgeController
    .setServicePaused({ title: message })
    .catch((error) => logDebug('[badge] service pause failed:', error.message));
  chrome.storage.session.set({ serviceError }).catch(() => {});
  logError(`Service paused: [${code}] ${message}`);
}

function resumeService() {
  serviceError = null;
  badgeController
    .setServiceActive()
    .catch((error) => logDebug('[badge] service resume failed:', error.message));
  chrome.storage.session.remove(['serviceError']).catch(() => {});
  logDebug('Service resumed');
}

function isServicePaused() {
  return serviceError !== null;
}

async function cacheGet(key) {
  const data = await chrome.storage.session.get([key]);
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
}

async function cacheSet(key, value, options) {
  void options;
  await chrome.storage.session.set({ [key]: value });
  return true;
}

function cachePin(key) {
  void key;
}

function cacheUnpin(key) {
  void key;
}

async function cacheClear() {
  await chrome.storage.session.clear();
}

// Session storage: in-memory IPC, survives SW termination, cleared on browser restart.
// hydrateCache() re-populates from persistent storage on every startup.
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});

// Resolves when hydrateCache() completes (or immediately if no hydration needed).
let hydrationDone = Promise.resolve();
const badgeController = createBadgeController({
  capabilities: BROWSER_CAPABILITIES,
  logDebug,
  normalIconPaths: NORMAL_ICON_PATHS,
  syncDesktopConnectorPauseState,
  readCacheable,
  generateSlugFromUrl,
  pageKey,
  notePrefix: NOTE_PREFIX,
  snapshotPrefix: SNAPSHOT_PREFIX,
  listPrefix: LIST_PREFIX,
  getBadgeAccentColor,
});

async function handleGetDesktopConnectorState() {
  const refreshed = await refreshDesktopConnectorStateProbe();
  const connector = refreshed || (await getConnectorBridgeState());
  syncDesktopConnectorPauseState(connector);
  badgeController.scheduleConnectorBadgeRefresh(connector);
  return { success: true, ...connector };
}

async function refreshDesktopConnectorStateProbe() {
  let timer;
  try {
    return await Promise.race([
      refreshConnectorBridgeState(),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(null),
          CONNECTOR_STATE_REFRESH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    logDebug('[connector] state refresh failed:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleConnectDesktopBridge() {
  const refreshed = await connectDesktopBridge();
  const connector = refreshed || (await getConnectorBridgeState());
  syncDesktopConnectorPauseState(connector);
  badgeController.scheduleConnectorBadgeRefresh(connector);
  return { success: true, ...connector };
}

function syncDesktopConnectorPauseState(connector) {
  if (connector?.refuseMode) {
    pauseService(
      'desktop_buffer_full',
      'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
    );
    return;
  }
  if (serviceError?.code === 'desktop_buffer_full') {
    resumeService();
  }
}

async function nextLogTimestamp() {
  await ensureLogBuffer();
  const now = Date.now();
  const floor = Math.max(lastLogTimestamp, logBufferWatermark);
  const timestamp = now > floor ? now : floor + 1;
  lastLogTimestamp = timestamp;
  return timestamp;
}

function observeLogTimestamp(timestamp) {
  if (Number.isFinite(timestamp) && timestamp > lastLogTimestamp) {
    lastLogTimestamp = timestamp;
  }
}

async function shouldMirrorEntryToDesktop(entry) {
  if (
    ![
      'visit_page',
      'leave_page',
      'rename_page',
      'rate_page',
      'update_setting',
      'pin_to_list',
      'unpin_from_list',
      'add_rule',
      'remove_rule',
      'update_rule',
      'create_list',
      'update_list',
      'update_list_tree',
      'delete_list',
      'restore_list',
      'delete_note',
      'restore_note',
      'delete_snapshot',
      'restore_snapshot',
    ].includes(entry?.action)
  )
    return false;
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return (
    connector.state === 'connected' ||
    connector.hasToken ||
    connector.pendingEvents > 0
  );
}

async function mirrorEntryToDesktop(entry) {
  if (!(await shouldMirrorEntryToDesktop(entry))) return;
  try {
    const stats = await enqueueDesktopEvent(entry);
    syncDesktopConnectorPauseState(stats);
  } catch (error) {
    if (error.code === 'buffer_full') {
      pauseService(
        'desktop_buffer_full',
        'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
      );
      return;
    }
    logDebug('[desktop] event mirror failed:', error.message);
  }
}

async function shouldDeferRuleEffectsToDesktop() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return (
    connector.state === 'connected' ||
    connector.hasToken ||
    connector.pendingEvents > 0
  );
}

async function canCallDesktopRuleRpc() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function requestRuleBatch(listIds, entries) {
  if (!(await canCallDesktopRuleRpc())) {
    return { success: false, error: 'Desktop rule engine unavailable' };
  }
  return await requestDesktopRuleBatch(listIds, entries);
}

async function requestRulePreview(rule, entries) {
  if (!(await canCallDesktopRuleRpc())) {
    return { success: false, error: 'Desktop rule engine unavailable' };
  }
  return await requestDesktopRulePreview(rule, entries);
}

async function canCallDesktopSearchRpc() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function canCallDesktopPopupRpc() {
  let connector = await getConnectorBridgeState();
  if (
    connector.state !== 'connected' &&
    connector.hasToken &&
    !connector.refuseMode
  ) {
    await connectDesktopBridge().catch((error) => {
      logDebug('[connector] popup rpc reconnect failed:', error.message);
    });
    connector = await getConnectorBridgeState();
  }
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function canCallDesktopStreamingReadRpc() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function canCallDesktopMutationRpc() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function loadDesktopEntityValue(key, { allowStale = false } = {}) {
  const canRead = allowStale
    ? await canCallDesktopStreamingReadRpc()
    : await canCallDesktopPopupRpc();
  if (!canRead) return { hit: false };
  try {
    const desktopResp = await requestDesktopEntity(key);
    if (!desktopResp?.success) {
      logDebug(
        `[desktop] read entity failed for ${key}:`,
        desktopResp?.error || 'unknown error',
      );
      return { hit: false };
    }
    return {
      hit: true,
      value: desktopResp.entity ?? null,
    };
  } catch (error) {
    logDebug(`[desktop] read entity failed for ${key}:`, error.message);
    return { hit: false };
  }
}

async function loadDesktopHistoryRange(from, to) {
  if (!(await canCallDesktopStreamingReadRpc())) {
    return { entries: [], files: [] };
  }
  const filesResp = await requestDesktopHistoryFiles(false);
  if (!filesResp?.success) {
    throw new Error(filesResp?.error || 'Desktop history file list failed');
  }
  const files = (filesResp.files || [])
    .filter((file) => {
      const dateStr = file.replace('.jsonl', '');
      return dateStr >= from && dateStr <= to;
    })
    .sort();
  if (files.length === 0) return { entries: [], files: [] };
  const batchResp = await requestDesktopHistoryBatch(files);
  if (!batchResp?.success) {
    throw new Error(batchResp?.error || 'Desktop history batch failed');
  }
  const entries = [...(batchResp.entries || [])].sort(
    (left, right) => (left.timestamp || 0) - (right.timestamp || 0),
  );
  return { entries, files };
}

async function readDesktopBackedValue(key) {
  switch (key) {
    case 'manifest:settings': {
      const desktop = await loadDesktopEntityValue(key, { allowStale: true });
      if (!desktop.hit) return undefined;
      return desktop.value || {};
    }
    case 'manifest:name-to-id': {
      const desktop = await loadDesktopEntityValue(key, { allowStale: true });
      if (!desktop.hit) return undefined;
      return desktop.value || { timestamp: 0, paths: {} };
    }
    case 'manifest:orphaned': {
      const desktop = await loadDesktopEntityValue(key, { allowStale: true });
      if (!desktop.hit) return undefined;
      return desktop.value || { timestamp: 0, entries: [] };
    }
    case 'manifest:list-order': {
      const desktop = await loadDesktopEntityValue(key, { allowStale: true });
      if (!desktop.hit) return undefined;
      return desktop.value || { timestamp: 0, tree: [] };
    }
    default: {
      if (key.startsWith('log:')) {
        const dateStr = key.slice('log:'.length);
        const desktop = await loadDesktopHistoryRange(dateStr, dateStr);
        return desktop.entries || [];
      }
      if (
        key.startsWith(PAGE_PREFIX) ||
        key.startsWith(NOTE_PREFIX) ||
        key.startsWith(LIST_PREFIX)
      ) {
        const desktop = await loadDesktopEntityValue(key, { allowStale: true });
        if (!desktop.hit) return undefined;
        return desktop.value;
      }
      return undefined;
    }
  }
}

function collectListEntityKeys(nodes, output = new Set()) {
  for (const node of nodes || []) {
    if (node?.id?.startsWith(LIST_PREFIX)) output.add(node.id);
    collectListEntityKeys(node?.children || [], output);
  }
  return output;
}

async function mirrorSnapshotToDesktop(snapshot) {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (
    !(
      connector.state === 'connected' ||
      connector.hasToken ||
      connector.pendingEvents > 0
    )
  ) {
    return false;
  }
  try {
    const stats = await enqueueDesktopSnapshot(snapshot);
    syncDesktopConnectorPauseState(stats);
    return true;
  } catch (error) {
    if (error.code === 'buffer_full') {
      pauseService(
        'desktop_buffer_full',
        'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
      );
      return false;
    }
    logDebug('[desktop] snapshot mirror failed:', error.message);
    return false;
  }
}

async function mirrorNoteToDesktop(note) {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (
    !(
      connector.state === 'connected' ||
      connector.hasToken ||
      connector.pendingEvents > 0
    )
  ) {
    return false;
  }
  try {
    const stats = await enqueueDesktopNote(note);
    syncDesktopConnectorPauseState(stats);
    return true;
  } catch (error) {
    if (error.code === 'buffer_full') {
      pauseService(
        'desktop_buffer_full',
        'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
      );
      return false;
    }
    logDebug('[desktop] note mirror failed:', error.message);
    return false;
  }
}

// ─── R-M-W Lock ──────────────────────────────────────────────────────
// Serializes read-modify-write on session cache. These are logical locks only;
// normal writes go through the daemon.

const rwLocks = new Map();
const LOCK_TIMEOUT_MS = 30000;

function withLock(key, fn) {
  const prev = rwLocks.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `withLock('${key}') timed out after ${LOCK_TIMEOUT_MS}ms`,
            ),
          );
        }, LOCK_TIMEOUT_MS);
        fn().then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    });
  rwLocks.set(key, next);
  next
    .catch(() => {})
    .then(() => {
      if (rwLocks.get(key) === next) rwLocks.delete(key);
    });
  return next;
}

// ─── Mutation Notifications ───────────────────────────────────────────
// Notify extension pages (options, popup) after data mutations so they can refresh.

function notifyMutation(type, detail) {
  chrome.runtime
    .sendMessage({ action: 'mutation', type, ...detail })
    .catch(() => {});
}

// ─── Log Buffer ──────────────────────────────────────────────────────
// Event-sourced log entries. Ground truth during SW lifetime.
// Backed up to storage.local['logBuffer'] for durability.
// The connector acks are authoritative for pruning.
// Lazy-restored on first access so idle wake-ups don't lose unflushed entries.

let logBuffer = null; // null = not yet restored from storage.local
let logBufferWatermark = 0; // last drain watermark — entries ≤ this are safely on disk

function storageTimeoutError(operation) {
  const error = new Error(
    `${operation} timed out after ${LOG_BUFFER_STORAGE_TIMEOUT_MS}ms`,
  );
  error.code = 'storage_timeout';
  return error;
}

function storageTimeout(operation) {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(storageTimeoutError(operation)),
      LOG_BUFFER_STORAGE_TIMEOUT_MS,
    );
  });
}

function isQuotaError(error) {
  return (
    error?.message?.includes('QUOTA_BYTES') || error?.message?.includes('quota')
  );
}

async function ensureLogBuffer() {
  if (logBuffer !== null) return;
  let stored;
  try {
    stored = await Promise.race([
      chrome.storage.local.get(['logBuffer', CONNECTOR_LAST_DRAINED_AT_KEY]),
      storageTimeout('logBuffer restore'),
    ]);
  } catch (error) {
    if (error.code !== 'storage_timeout') throw error;
    logDebug('[logBuffer] restore timed out; continuing with memory queue');
    logBuffer = [];
    return;
  }
  const persistedWatermark = stored[CONNECTOR_LAST_DRAINED_AT_KEY] || 0;
  const restored = (stored.logBuffer || []).filter(
    (entry) => (entry?.timestamp || 0) > persistedWatermark,
  );
  for (const entry of restored) observeLogTimestamp(entry?.timestamp);
  logBuffer = restored;
  logBufferWatermark = Math.max(logBufferWatermark, persistedWatermark);
  if (restored.length !== (stored.logBuffer || []).length) {
    await persistLogBuffer();
  }
  if (logBuffer.length > 0) {
    logDebug(
      `Restored ${logBuffer.length} pending log entries from storage.local`,
    );
  }
}

async function persistLogBuffer() {
  let timedOut = false;
  const writePromise = chrome.storage.local
    .set({ logBuffer })
    .catch((error) => {
      if (timedOut) {
        logDebug('[logBuffer] deferred persist failed:', error.message);
      }
      throw error;
    });
  try {
    await Promise.race([
      writePromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(storageTimeoutError('logBuffer persist'));
        }, LOG_BUFFER_STORAGE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (e) {
    if (e.code === 'storage_timeout') {
      writePromise.catch(() => {});
      logDebug('[logBuffer] persist timed out; keeping in-memory queue');
      return false;
    }
    if (isQuotaError(e)) {
      pauseService(
        'local_quota',
        `Local storage full — logBuffer has ${logBuffer.length} undrained entries. Drain may be stuck.`,
      );
    }
    throw e;
  }
}

// ─── Drain Notify ────────────────────────────────────────────────────
// Flushes the connector buffer and lets daemon acknowledgements prune the
// durable local queue.
let drainNotifyTimer = null;

function scheduleDrainNotify() {
  if (drainNotifyTimer) return;
  drainNotifyTimer = setTimeout(drainNow, DRAIN_INTERVAL_MS);
}

async function drainNow() {
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  try {
    const connector = await flushDesktopBuffer();
    syncDesktopConnectorPauseState(connector);
  } catch (error) {
    logDebug('[connector] scheduled flush failed:', error.message);
  }
}

async function applyDesktopPersistedWatermark(watermark) {
  await ensureLogBuffer();
  logBufferWatermark = Math.max(logBufferWatermark, watermark);
  const next = logBuffer.filter((entry) => (entry?.timestamp || 0) > watermark);
  if (next.length === logBuffer.length) return;
  logBuffer = next;
  await persistLogBuffer();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const drainedAt = changes[CONNECTOR_LAST_DRAINED_AT_KEY]?.newValue;
  if (drainedAt) {
    applyDesktopPersistedWatermark(drainedAt).catch((error) => {
      logDebug('[connector] log buffer prune failed:', error.message);
    });
  }
});

subscribeConnectorBridgeState((connector) => {
  syncDesktopConnectorPauseState(connector);
  badgeController.scheduleConnectorBadgeRefresh(connector);
});

async function applyCachedConnectorBadge(reason) {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  await badgeController.setConnectorState(connector);
}

function startConnectorBridge(reason) {
  void (async () => {
    try {
      await applyCachedConnectorBadge(reason);
    } catch (error) {
      logDebug(
        `[connector] cached badge apply failed on ${reason}:`,
        error.message,
      );
    }
    try {
      await initConnectorBridge();
    } catch (error) {
      logDebug(`[connector] startup on ${reason} failed:`, error.message);
    }
  })();
}

// High-level: append to logBuffer and mirror to the daemon.
// Serialized via logBuffer lock so concurrent calls see each other's cache writes.
async function addLog(entry) {
  if (isServicePaused()) {
    throw new Error(`Service paused [${serviceError.code}]`);
  }
  let effects = {};
  await withLock('logBuffer', async () => {
    await ensureLogBuffer();
    observeLogTimestamp(entry.timestamp);
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
      logBuffer = logBuffer.filter((e) => e.timestamp > logBufferWatermark);
      if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
        logBuffer = logBuffer.slice(-LOG_BUFFER_MAX_SIZE);
      }
    }
    await persistLogBuffer();
  });
  scheduleDrainNotify();
  await mirrorEntryToDesktop(entry);
  badgeController.refreshBadgesForEntry(entry);
  return effects;
}

// Build a visit_page log entry. Title omitted when absent (slow-loading pages).
// checkpoint: true forces page entity creation (used by explicit user capture of blacklisted URLs).
async function buildVisitPageEntry(
  url,
  title,
  referrerUrl,
  { checkpoint } = {},
) {
  const entry = {
    timestamp: await nextLogTimestamp(),
    action: 'visit_page',
    url,
  };
  if (title) entry.title = title;
  if (referrerUrl) entry.referrerUrl = referrerUrl;
  if (checkpoint) entry.checkpoint = true;
  return entry;
}

// Build a leave_page log entry with attention data.
async function buildLeavePageEntry(url, title, scrollDepth, timeOnPage) {
  const entry = {
    timestamp: await nextLogTimestamp(),
    action: 'leave_page',
    url,
  };
  if (title) entry.title = title;
  if (scrollDepth !== undefined && scrollDepth !== null)
    entry.scrollDepth = scrollDepth;
  if (timeOnPage !== undefined && timeOnPage > 0) entry.timeOnPage = timeOnPage;
  return entry;
}

// ─── Settings Keys ───────────────────────────────────────────────────

async function readCacheable(key, includeDeleted = false) {
  const value = await readDesktopBackedValue(key);
  if (!includeDeleted && value?.deleted) return null;
  return value;
}

// Collect all list keys from the tree manifest.
async function getAllListKeys() {
  await hydrationDone;
  const order = await readCacheable('manifest:list-order');
  const result = [];
  function walk(nodes) {
    for (const node of nodes) {
      result.push(node.id);
      if (node.children) walk(node.children);
    }
  }
  walk(order?.tree || []);
  return result;
}

function getListTreeChildren(tree, parentListId) {
  if (!parentListId) return tree || [];
  const wantedId = listKey(parentListId);
  const stack = [...(tree || [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === wantedId) {
      return node.children || [];
    }
    stack.push(...(node.children || []));
  }
  return [];
}

async function createListAndResolveId({ listOwner, name, parentListId }) {
  const beforeOrder = (await readCacheable('manifest:list-order')) || {
    tree: [],
  };
  const beforeIds = new Set(
    getListTreeChildren(beforeOrder.tree, parentListId).map((node) => node.id),
  );

  const createEntry = {
    timestamp: await nextLogTimestamp(),
    action: 'create_list',
    listOwner,
    name,
  };
  if (parentListId) createEntry.parentListId = parentListId;
  const effects = await addLog(createEntry);

  const effectKey = Object.keys(effects).find(
    (key) =>
      key.startsWith(LIST_PREFIX) &&
      key !== 'manifest:list-order' &&
      key !== 'manifest:name-to-id',
  );
  if (effectKey) {
    return entitySlug(effectKey);
  }

  const afterOrder = (await readCacheable('manifest:list-order')) || {
    tree: [],
  };
  const afterChildren = getListTreeChildren(afterOrder.tree, parentListId);
  const createdNode = afterChildren.find(
    (node) => node?.id?.startsWith(LIST_PREFIX) && !beforeIds.has(node.id),
  );
  if (createdNode?.id) {
    return entitySlug(createdNode.id);
  }

  for (const node of afterChildren) {
    if (!node?.id?.startsWith(LIST_PREFIX) || beforeIds.has(node.id)) continue;
    const entity = await readCacheable(node.id);
    if (entity?.name === name) {
      return entitySlug(node.id);
    }
  }

  return null;
}

// ─── Cache Hydration Phases ──────────────────────────────────────────

async function hydrateBaseEntities() {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (connector.deviceId) {
    localDeviceId = connector.deviceId;
  }

  try {
    const resp = await loadDesktopEntityValue('manifest:settings', {
      allowStale: true,
    });
    if (resp.hit) await cacheSet('manifest:settings', resp.value || {});
  } catch (e) {
    logDebug('Settings load failed:', e.message);
  }

  let listOrder = null;
  try {
    const orderResp = await loadDesktopEntityValue('manifest:list-order', {
      allowStale: true,
    });
    listOrder = orderResp.hit
      ? orderResp.value || { timestamp: 0, tree: [] }
      : null;
    if (listOrder) await cacheSet('manifest:list-order', listOrder);
  } catch (e) {
    logDebug('List order load failed:', e.message);
  }

  let nameMap = null;
  try {
    const nmResp = await loadDesktopEntityValue('manifest:name-to-id', {
      allowStale: true,
    });
    nameMap = nmResp.hit ? nmResp.value || { timestamp: 0, paths: {} } : null;
    if (nameMap) await cacheSet('manifest:name-to-id', nameMap);
  } catch (e) {
    logDebug('Name-map load failed:', e.message);
  }

  try {
    const orphanedResp = await loadDesktopEntityValue('manifest:orphaned', {
      allowStale: true,
    });
    if (orphanedResp.hit) {
      await cacheSet(
        'manifest:orphaned',
        orphanedResp.value || { timestamp: 0, entries: [] },
      );
    }
  } catch (e) {
    logDebug('Orphaned manifest load failed:', e.message);
  }

  const listKeys = new Set();
  if (nameMap?.paths) {
    for (const listId of Object.values(nameMap.paths)) {
      listKeys.add(listKey(listId));
    }
  }
  if (listOrder?.tree) {
    collectListEntityKeys(listOrder.tree, listKeys);
  }
  for (const key of listKeys) {
    try {
      const listResp = await loadDesktopEntityValue(key, { allowStale: true });
      if (listResp.hit && listResp.value) {
        await cacheSet(key, listResp.value);
      }
    } catch (e) {
      logDebug(
        `[hydrateBaseEntities] List entity load failed for ${key}:`,
        e.message,
      );
    }
  }
}

async function hydrateHistoryCache() {
  const todayStr = dateKeyFromTimestamp(Date.now());
  // Load today's history — pinned because addLog appends entries here that are
  // newer than the on-disk JSONL file; evicting would lose unflushed data.
  const todayResp = await loadDesktopHistoryRange(todayStr, todayStr);
  const todayEntries = todayResp.entries || [];
  const todayKey = 'log:' + todayStr;
  const todayMaxTs = todayEntries.length
    ? todayEntries[todayEntries.length - 1].timestamp
    : 0;
  await cacheSet(todayKey, todayEntries, { timestamp: todayMaxTs });
  cachePin(todayKey);

  // Load past HISTORY_RECENT_DAYS days — pinned because multi-day visit checks
  // (recentUrls) read these frequently; eviction would force repeated disk loads.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - HISTORY_RECENT_DAYS);
  const fromStr = dateKeyFromTimestamp(fromDate.getTime());
  const toStr = dateKeyFromTimestamp(yesterday.getTime());

  recentUrls = new Map();
  if (fromStr <= toStr) {
    // Load the full range, then split into per-date keys
    const recentResp = await loadDesktopHistoryRange(fromStr, toStr);
    const recentEntries = recentResp.entries || [];

    // Group entries by date
    const byDate = new Map();
    for (const entry of recentEntries) {
      const d = dateKeyFromTimestamp(entry.timestamp);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(entry);
    }

    // Fill every date in range: existing files get their entries, gaps get empty arrays
    const cur = new Date(fromDate);
    const end = new Date(yesterday);
    while (cur <= end) {
      const d = dateKeyFromTimestamp(cur.getTime());
      const entries = byDate.get(d) || [];
      const hKey = 'log:' + d;
      const maxTs = entries.length ? entries[entries.length - 1].timestamp : 0;
      await cacheSet(hKey, entries, { timestamp: maxTs });
      cachePin(hKey);
      cur.setDate(cur.getDate() + 1);
    }

    // Build in-memory URL → visitDates map for O(1) multi-day lookups
    for (const entry of recentEntries) {
      if ((entry.action === 'visit_page' || !entry.action) && entry.url) {
        const d = new Date(entry.timestamp);
        const yyyymmdd =
          d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
        const dates = recentUrls.get(entry.url);
        if (dates) {
          if (!dates.includes(yyyymmdd)) dates.push(yyyymmdd);
        } else {
          recentUrls.set(entry.url, [yyyymmdd]);
        }
      }
    }

    // Unpin any older history keys still in session from prior SW lifetime
    // (session survives SW termination; these are stale cache from before the 7-day window)
    // We can't enumerate session keys, but we can check known old dates
    // by looking at files older than our range from listHistoryFiles
    const allFilesResp = await requestDesktopHistoryFiles(false);
    const allFiles = allFilesResp?.files || []; // Missing files listing is non-fatal
    for (const f of allFiles) {
      const d = f.replace('.jsonl', '');
      if (d < fromStr) {
        const oldKey = 'log:' + d;
        cacheUnpin(oldKey); // evictable if still in session
      }
    }
  }

  logDebug(
    `History cache: ${todayEntries.length} today, ${recentUrls.size} recent URLs`,
  );
}

async function hydrateBufferPages() {
  await ensureLogBuffer();

  // Dedup logBuffer against today's history (entries already flushed to disk)
  {
    const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
    let todayForDedup = await cacheGet(todayKey);
    if (todayForDedup == null) {
      logDebug(`[dedup] history cache miss for ${todayKey}, loading from disk`);
      const dateStr = dateKeyFromTimestamp(Date.now());
      const resp = await loadDesktopHistoryRange(dateStr, dateStr);
      todayForDedup = resp.entries || [];
    }
    if (todayForDedup.length > 0 && logBuffer.length > 0) {
      const flushedTimestamps = new Set(todayForDedup.map((e) => e.timestamp));
      const before = logBuffer.length;
      logBuffer = logBuffer.filter((e) => !flushedTimestamps.has(e.timestamp));
      if (logBuffer.length < before) {
        logDebug(
          `logBuffer dedup: ${before} → ${logBuffer.length} (${before - logBuffer.length} already flushed)`,
        );
        await persistLogBuffer();
      }
    }
  }

  // Pre-load page entities referenced by logBuffer from persistent storage.
  const bufferPageSlugs = new Set();
  for (const entry of logBuffer) {
    if (entry.url) bufferPageSlugs.add(generateSlugFromUrl(entry.url));
    if (entry.referrerId) {
      const refSlug = entry.referrerId.startsWith(PAGE_PREFIX)
        ? entitySlug(entry.referrerId)
        : entry.referrerId;
      bufferPageSlugs.add(refSlug);
    }
  }
  if (bufferPageSlugs.size > 0) {
    const slugsToLoad = [];
    for (const slug of bufferPageSlugs) {
      if (!(await cacheGet(pageKey(slug)))) slugsToLoad.push(slug);
    }
    if (slugsToLoad.length > 0) {
      const pages = await Promise.all(
        slugsToLoad.map(async (slug) => {
          const resp = await loadDesktopEntityValue(pageKey(slug), {
            allowStale: true,
          });
          return resp.hit && resp.value ? [slug, resp.value] : null;
        }),
      );
      for (const page of pages) {
        if (!page) continue;
        await cacheSet(pageKey(page[0]), page[1]);
      }
    }
  }
}

async function replayBufferEntries() {
  await ensureLogBuffer();
  if (logBuffer.length === 0) return;
  const deviceId = await getDeviceId();
  if (!deviceId) return;
  const replayResp = await requestDesktopReplayRemoteEntries(
    deviceId,
    logBuffer,
  );
  if (!replayResp?.success) {
    throw new Error(replayResp?.error || 'Desktop local buffer replay failed');
  }
  logBuffer = [];
  await persistLogBuffer();
}

async function replayRemoteLogs() {
  // Remote logs are pulled by sync and written to data/logs/<remoteDevice>/.
  // Replay is idempotent (per-device timestamp guards) so re-replaying
  // already-checkpointed entries is a safe no-op.
  const settings = await cacheGet('manifest:settings');
  if (settings?.syncEnabled && localDeviceId) {
    const filesResp = await requestDesktopHistoryFiles(false);
    if (!filesResp?.success) {
      throw new Error(filesResp?.error || 'Desktop history file list failed');
    }
    const batchResp = await requestDesktopHistoryBatch(filesResp.files || []);
    if (!batchResp?.success) {
      throw new Error(batchResp?.error || 'Desktop history batch failed');
    }
    const remotes = new Map();
    for (const entry of batchResp.entries || []) {
      const deviceId = entry?.deviceId;
      if (!deviceId || deviceId === localDeviceId) continue;
      if (!remotes.has(deviceId)) remotes.set(deviceId, []);
      remotes.get(deviceId).push(entry);
    }
    if (remotes.size > 0) {
      let totalEntries = 0;
      for (const [peerId, entries] of remotes) {
        const replayResp = await requestDesktopReplayRemoteEntries(
          peerId,
          entries,
        );
        if (!replayResp?.success) {
          logDebug(
            '[hydrateCache] Remote entry replay error:',
            replayResp?.error || 'Desktop remote replay failed',
            'device:',
            peerId,
          );
          continue;
        }
        totalEntries += entries.length;
      }
      logDebug(
        `Remote log replay: ${remotes.size} peers, ${totalEntries} entries`,
      );
    }
  }
}

// ─── Cache Hydration ──────────────────────────────────────────────────

async function hydrateCache() {
  // Phase 1: Load base entities from persistent storage into session cache.
  await hydrateBaseEntities();

  // Phase 1.1 (default list creation) runs AFTER hydrateCache returns —
  // it uses addLog() which calls readCacheable → await hydrationDone,
  // so it can't run inside hydrateCache itself (circular wait).

  // Phase 1.5: History cache — per-date keys history:YYYY-MM-DD
  try {
    await hydrateHistoryCache();
  } catch (e) {
    logDebug('History cache load failed:', e.message);
  }

  // Phase 1.6: Pre-load page entities referenced by logBuffer from persistent storage.
  await hydrateBufferPages();

  // Phase 2: Replay pending logBuffer entries through the daemon
  await replayBufferEntries();

  // Phase 3: Replay remote device log files (multi-device sync)
  try {
    await replayRemoteLogs();
  } catch (e) {
    logDebug('Remote log replay failed:', e.message);
  }

  logDebug('Cache hydrated');
}

// Device identity is owned by the daemon; the extension only mirrors it locally.
async function ensureDeviceId() {
  const deviceId = await getDeviceId();
  if (!deviceId) {
    throw new Error('Desktop device id unavailable');
  }
  localDeviceId = deviceId;
}

async function ensureDefaultLists() {
  if (!(await canCallDesktopPopupRpc())) {
    return;
  }
  const deviceId = await getDeviceId();
  if (!deviceId) return;
  localDeviceId = deviceId;
  try {
    const nameMap = (await readCacheable('manifest:name-to-id')) || {
      paths: {},
    };
    const userLists = Object.keys(nameMap.paths || {}).filter(
      (key) => !key.startsWith('system/'),
    );
    if (userLists.length === 0) {
      await addLog({
        timestamp: await nextLogTimestamp(),
        action: 'create_list',
        listOwner: 'system',
        listId: 'hubs',
        name: 'Hubs',
      });
      await addLog({
        timestamp: await nextLogTimestamp(),
        action: 'add_rule',
        listOwner: 'system',
        name: 'Hubs',
        rule: {
          type: 'function',
          config: {
            description: 'Hub and landing pages',
            fnSource: [
              'const u = new URL(page.url);',
              'const p = u.pathname.toLowerCase();',
              "const skip = ['s', 'search', 'query', 'q', 'target'];",
              'if (skip.some(k => u.searchParams.has(k))) return false;',
              "if (p === '/' || p === '') return u.search.length <= 100;",
              "const parts = p.split('/').filter(Boolean);",
              "if (parts.length === 1 && p.endsWith('/')) return true;",
              "const last = parts[parts.length - 1] || '';",
              "const hub = ['blog', 'wiki', 'home', 'landing', 'explore', 'discover', 'index'];",
              'if (hub.some(k => last.includes(k))) return !u.hash;',
              'return false;',
            ].join('\n'),
          },
        },
      });
    }
  } catch (e) {
    logDebug('First-run default list creation failed:', e.message);
  }
}

// ─── Rule Auto-Pin on Visit ──────────────────────────────────────────
// Evaluate all lists with rules against a visited page and auto-pin matches.

async function evaluateRulesForVisit(url, title) {
  const listKeys = await getAllListKeys();
  const listIds = listKeys.map((key) => entitySlug(key));
  if (listIds.length === 0) return;
  try {
    const desktopResp = await requestRuleBatch(listIds, [
      {
        timestamp: await nextLogTimestamp(),
        action: 'visit_page',
        url,
        title,
      },
    ]);
    if (!desktopResp?.success) {
      throw new Error(desktopResp?.error || 'Rule batch failed');
    }
    await applyDesktopRuleBatchLocally(desktopResp.results || []);
  } catch (error) {
    logDebug('[rules] visit batch failed:', error.message);
  }
}

function applyDesktopRuleBatchLocally(results) {
  if ((results || []).length > 0) notifyMutation('pins', {});
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  let title = rawTitle;
  const settings = (await readCacheable('manifest:settings')) || {};
  if (settings.titleCleanupEnabled === false) return title.trim();
  const titleTrimRules = settings.titleTrimRules || [];
  for (const rule of titleTrimRules) {
    if (url.startsWith(rule.urlPrefix)) {
      if (rule.action === 'remove_after_pipe') {
        const pipeIdx = title.indexOf('|');
        if (pipeIdx > 0) title = title.substring(0, pipeIdx);
      } else if (rule.action === 'remove_brackets') {
        title = title.replace(/\s*\[[^\]]*\]\s*/g, ' ');
      } else if (rule.action === 'remove_parens') {
        title = title.replace(/\s*\([^)]*\)\s*/g, ' ');
      }
    }
  }
  return title.trim();
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    badgeController.updateBadgeForTab(tabId, tab.url);
  } catch (e) {
    /* tab may have been closed */
  }
});

chrome.tabs.onCreated?.addListener?.((tab) => {
  badgeController.clearNewTabBadge(tab);
});

// ─── Supplementary referrer detection ─────────────────────────────────
// Sites that suppress document.referrer via Referrer-Policy or rel="noreferrer"
// leave an empty string in content script. webNavigation sees the real navigation.
const getReferrer = (() => {
  const tabUrls = new Map();
  // Stores the resolved referrer (or null) once onCommitted fires.
  const committed = new Map();
  // Pending getReferrer() calls waiting for onCommitted to fire.
  const waiters = new Map();

  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const previousUrl = tabUrls.get(details.tabId);
    const referrer =
      details.transitionType === 'link' && previousUrl ? previousUrl : null;
    tabUrls.set(details.tabId, details.url);
    committed.set(details.tabId, referrer);
    badgeController.updateBadgeForTab(details.tabId, details.url);
    // Wake up any pending getReferrer() call
    const waiter = waiters.get(details.tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(details.tabId);
      waiter.resolve(referrer);
    }
  });

  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const sourceUrl = tabUrls.get(details.sourceTabId);
    if (sourceUrl) committed.set(details.tabId, sourceUrl);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabUrls.delete(tabId);
    committed.delete(tabId);
    const waiter = waiters.get(tabId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(tabId);
      waiter.resolve(null);
    }
  });

  // Async: returns the referrer URL or null. If onCommitted hasn't fired yet
  // (race with content script), waits up to 200ms for it.
  return async (tabId) => {
    const ref = committed.get(tabId);
    if (ref !== undefined) {
      committed.delete(tabId);
      return ref;
    }
    // onCommitted hasn't fired yet — wait briefly
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(tabId);
        resolve(null);
      }, 200);
      waiters.set(tabId, { resolve, timer });
    });
  };
})();

chrome.tabs.onRemoved.addListener((tabId) => {
  tabReportedUrls.delete(tabId);
});

// ─── Initialization ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  logDebug('browser-recall extension installed');

  chrome.contextMenus.create({
    id: 'portal-highlight',
    title: 'Highlight Selected',
    contexts: ['selection'],
  });

  await ensureLogBuffer();
  logDebug('Connector buffer initialized');

  startConnectorBridge('install');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureLogBuffer();
  logDebug('Extension started');

  startConnectorBridge('browser start');
});

// ─── Save Page WE Integration ─────────────────────────────────────────
initSavepageBridge();
startConnectorBridge('background boot');

// ─── List Event Fields ───────────────────────────────────────────────
// Resolve a list internal ID to { name, listOwner } for event emission.

async function getListEventFields(listId) {
  if (listId.startsWith('system/')) {
    return { name: listId, listOwner: await getDeviceId() };
  }
  const nameToId = await readCacheable('manifest:name-to-id');
  if (!nameToId?.paths) return null;
  // Reverse lookup: find compound key for this listId
  let listName = null;
  for (const [key, id] of Object.entries(nameToId.paths)) {
    if (id === listId) {
      const slashIdx = key.indexOf('/');
      listName = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;
      break;
    }
  }
  if (!listName) {
    const entity = await readCacheable(listKey(listId));
    listName = entity?.name;
  }
  if (!listName) return null;
  const entity = await readCacheable(listKey(listId));
  const owner = entity?.owner || (await getDeviceId());
  return { name: listName, listOwner: owner };
}

// ─── Snapshot Capture ─────────────────────────────────────────────────

async function getBadgeAccentColor() {
  const { colorScheme } = await chrome.storage.session.get(['colorScheme']);
  return SCHEME_HEX[colorScheme] || SCHEME_HEX.amber;
}

async function startSpinnerBadge(tabId) {
  await badgeController.startSpinnerBadge(tabId);
}
async function stopSpinnerBadge(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await badgeController.stopSpinnerBadge(tabId, tab.url);
  } catch {
    badgeController
      .stopSpinnerBadge(tabId)
      .catch((e) => logDebug('[spinner] badge clear failed:', e.message));
  }
}

async function captureAndLog(tabId, slug, timestamp, url, title) {
  startSpinnerBadge(tabId);
  try {
    // PDF pages render via a native plugin — no extractable content
    if (url && /\.pdf(\?|#|$)/i.test(new URL(url).pathname)) {
      throw new Error('Cannot capture PDF pages');
    }
    // Fallback: ask content script to check for Chrome's PDF viewer embed
    try {
      const pdfCheck = await chrome.tabs.sendMessage(tabId, {
        action: 'isPdfPage',
      });
      if (pdfCheck?.isPdf) throw new Error('Cannot capture PDF pages');
    } catch (e) {
      if (e.message === 'Cannot capture PDF pages') throw e;
      // Content script might not be loaded — proceed with capture
    }
    const mdResp = await chrome.tabs.sendMessage(tabId, {
      action: 'extractMarkdown',
    });
    const html = await captureSavePage(tabId);
    const markdown = mdResp?.markdown || '';
    if (!markdown && !html) {
      throw new Error('Capture failed: page returned no content');
    }
    const queued = await mirrorSnapshotToDesktop({
      slug,
      ts: timestamp,
      url,
      title,
      markdown,
      html: html || '',
    });
    if (!queued) {
      throw new Error('Desktop snapshot queue unavailable');
    }
    void badgeController.refreshBadgesForUrls([url]);
    notifyMutation('snapshot', { slug });
  } finally {
    stopSpinnerBadge(tabId);
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────

async function handleContextMenuHighlight(url, title, selectionText, tabId) {
  const slug = generateSlugFromUrl(url);

  const timestamp = await nextLogTimestamp();
  const noteSlug = generateNoteSlug(timestamp, selectionText);

  // create_note ensures the daemon replay pipeline can create/link the page.
  const queued = await mirrorNoteToDesktop({
    slug: noteSlug,
    excerpt: selectionText,
    note: '',
    cssPath: null,
    url,
    title,
    ts: timestamp,
  });
  if (!queued) {
    throw new Error('Desktop note queue unavailable');
  }
  void badgeController.refreshBadgesForUrls([url]);

  notifyMutation('note', { pageSlug: slug, noteSlug });

  // Show highlights panel in the tab's content script
  if (tabId > 0) {
    const page = await readCacheable(pageKey(slug));
    const noteRefs = (page?.childIds || []).filter((c) =>
      c.startsWith(NOTE_PREFIX),
    );
    const notes = [];
    for (const ref of noteRefs) {
      const note = await readCacheable(ref);
      if (note) notes.push(note);
    }
    chrome.tabs
      .sendMessage(tabId, {
        action: 'showHighlightsPanel',
        notes,
        pageSlug: slug,
      })
      .catch(() => {});
  }

  return { success: true, noteSlug };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'portal-highlight') return;
  if (!info.selectionText) return;

  // The callback's tab object has wrong URL/id for PDF viewer tabs.
  // Query the real active tab instead; guard with title match.
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!activeTab?.url) return;
  if (tab?.title && activeTab.title !== tab.title) {
    logDebug('[context-menu] Active tab title mismatch, skipping');
    return;
  }

  try {
    await handleContextMenuHighlight(
      activeTab.url,
      activeTab.title,
      info.selectionText.trim(),
      activeTab.id,
    );
  } catch (error) {
    logDebug('[context-menu] Highlight error:', error.message);
    if (activeTab.id > 0) {
      chrome.tabs
        .sendMessage(activeTab.id, {
          action: 'showErrorNotification',
          message: error.message,
        })
        .catch(() => {});
    }
  }
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  logDebug(`[background] Command received: ${command}`);

  const recordingState = await cacheGet('workspace');
  if (recordingState && recordingState.mode === 'private') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab ||
    tab.url.startsWith('chrome://') ||
    tab.url.startsWith('chrome-extension://')
  ) {
    logDebug('[background] Command ignored: no suitable tab');
    return;
  }

  if (command === 'capture-snapshot') {
    chrome.tabs
      .sendMessage(tab.id, { action: 'showCaptureSpinner' })
      .catch(() => {});
    try {
      const slug = generateSlugFromUrl(tab.url);
      const timestamp = await nextLogTimestamp();
      await captureAndLog(tab.id, slug, timestamp, tab.url, tab.title);
      chrome.tabs
        .sendMessage(tab.id, { action: 'hideCaptureSpinner' })
        .catch(() => {});
      chrome.tabs
        .sendMessage(tab.id, { action: 'showCaptureNotification' })
        .catch(() => {});
    } catch (error) {
      logDebug('[capture] ERROR:', error.message, error);
      chrome.tabs
        .sendMessage(tab.id, { action: 'hideCaptureSpinner' })
        .catch(() => {});
      chrome.tabs
        .sendMessage(tab.id, {
          action: 'showErrorNotification',
          message: error.message,
        })
        .catch(() => {});
    }
  } else if (command === 'highlight-selection') {
    try {
      logDebug(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = await chrome.tabs.sendMessage(tab.id, {
        action: 'highlightSelection',
      });
      logDebug('[background] highlightSelection response:', resp);
    } catch (error) {
      logDebug('[background] Could not highlight selection:', error.message);
    }
  } else if (command === 'like-page' || command === 'dislike-page') {
    const delta = command === 'like-page' ? 1 : -1;
    try {
      const rateEntry = {
        timestamp: await nextLogTimestamp(),
        action: 'rate_page',
        url: tab.url,
        likes: delta,
      };
      if (tab.title) rateEntry.title = tab.title;
      await addLog(rateEntry);
      notifyMutation('history', { url: tab.url });
      chrome.tabs
        .sendMessage(tab.id, { action: 'showLikeNotification', delta })
        .catch(() => {});
    } catch (error) {
      logDebug(`[${command}] ERROR:`, error.message, error);
    }
  }
});

// ─── Message Handlers: Tab/Popup Queries ─────────────────────────────

function handleGetReportedUrl(request) {
  return { success: true, url: tabReportedUrls.get(request.tabId) || null };
}

async function handleGetPageInfo(request) {
  if (!(await canCallDesktopPopupRpc())) {
    return {
      success: false,
      error: 'Desktop popup page info unavailable',
    };
  }

  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop popup page info failed',
      };
    }
    return {
      success: true,
      slug: desktopResp.slug,
      entry: desktopResp.entry || null,
      snapshots: desktopResp.snapshots || [],
      notes: desktopResp.notes || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Desktop popup page info failed',
    };
  }
}

async function handleGetPageSummary(request) {
  if (!(await canCallDesktopPopupRpc())) {
    return {
      success: false,
      error: 'Desktop popup page summary unavailable',
    };
  }

  try {
    const desktopResp = await requestDesktopPageSummary(request.url);
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          `Desktop returned ${desktopResp?.type || 'an empty response'} without page summary data`,
      };
    }
    return {
      success: true,
      url: desktopResp.url || request.url,
      page: desktopResp.page || null,
      notes: desktopResp.notes || [],
      snapshots: desktopResp.snapshots || [],
      lists: desktopResp.lists || [],
      attention: desktopResp.attention || null,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Desktop popup page summary failed',
    };
  }
}

async function handleGetPopupLists() {
  if (!(await canCallDesktopPopupRpc())) {
    return {
      success: false,
      error: 'Desktop popup lists unavailable',
    };
  }
  try {
    const desktopResp = await requestDesktopPopupLists();
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop popup lists failed',
      };
    }
    return {
      success: true,
      lists: desktopResp.lists || [],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Desktop popup lists failed',
    };
  }
}

async function handleCaptureCurrentPageFromPopup() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) return { success: false, error: 'No active tab' };
    const slug = generateSlugFromUrl(tab.url);
    const timestamp = await nextLogTimestamp();
    await captureAndLog(tab.id, slug, timestamp, tab.url, tab.title);
    return { success: true, timestamp };
  } catch (error) {
    logDebug('[capture-popup] ERROR:', error.message, error);
    return { success: false, error: error.message };
  }
}

async function handleHydrateCacheMsg() {
  await hydrateCache();
  return { success: true };
}

// ─── Message Handlers: Page Lifecycle ────────────────────────────────

async function handleReportPage(request, sender) {
  try {
    if (isServicePaused()) {
      return {
        success: false,
        error: 'Service paused',
        code: serviceError.code,
      };
    }
    const url = request.url;

    const recordingState = await cacheGet('workspace');
    if (recordingState && recordingState.mode === 'private') {
      return { success: true };
    }

    // Check blacklist (skip when feature is toggled off, but always block chrome:// and edge://)
    const rpSettings = (await readCacheable('manifest:settings')) || {};
    const blacklistEnabled = rpSettings.blacklistEnabled !== false;
    const urlBlacklist = rpSettings.urlBlacklist;
    const builtinBlacklist = ['chrome://', 'edge://'];
    const blacklist = blacklistEnabled
      ? (urlBlacklist ?? builtinBlacklist)
      : builtinBlacklist;
    if (
      !request.bypassBlacklist &&
      blacklist.some((prefix) => url.startsWith(prefix))
    ) {
      if (request.isInitialLoad) {
        const todayKey = 'log:' + dateKeyFromTimestamp(Date.now());
        const todayEntries = (await readCacheable(todayKey)) || [];
        const inSession = todayEntries.some((e) => e.url === url);
        if (!inSession) {
          const pageSlug = generateSlugFromUrl(url);
          const existing = await readCacheable(pageKey(pageSlug));
          if (!existing) {
            logDebug(`Skipping blacklisted URL (not in database): ${url}`);
            return { success: true };
          }
        }
        logDebug(`Blacklisted URL but already in database, continuing: ${url}`);
      } else {
        return { success: true };
      }
    }

    if (request.isInitialLoad) {
      // Track the URL the content script reported for this tab.
      if (sender.tab?.id != null) {
        tabReportedUrls.set(sender.tab.id, url);
      }
      let referrerUrl = request.referrer || null;
      if (!referrerUrl && sender.tab?.id != null) {
        const bgRef = await getReferrer(sender.tab.id);
        if (bgRef) referrerUrl = bgRef;
      }
      if (referrerUrl) {
        const refSlug = generateSlugFromUrl(referrerUrl);
        const selfSlug = generateSlugFromUrl(url);
        if (refSlug === selfSlug) referrerUrl = null;
      }

      const title = request.title ? await trimTitle(request.title, url) : '';
      const entry = await buildVisitPageEntry(url, title, referrerUrl, {
        checkpoint: request.bypassBlacklist,
      });
      await addLog(entry);

      evaluateRulesForVisit(url, title).catch((err) => {
        logDebug('Rule auto-pin error:', err.message);
      });

      notifyMutation('history', { url });
    } else if (request.isLeaving) {
      const title = request.title ? await trimTitle(request.title, url) : null;
      const entry = await buildLeavePageEntry(
        url,
        title,
        request.scrollDepth,
        request.timeOnPage,
      );
      await addLog(entry);
      drainNow();
    } else if (request.user_title !== undefined) {
      await addLog({
        timestamp: await nextLogTimestamp(),
        action: 'rename_page',
        url,
        user_title: request.user_title,
      });
    }

    logDebug(
      `Processed page report: ${url} (initial=${!!request.isInitialLoad}, leaving=${!!request.isLeaving})`,
    );
    return { success: true };
  } catch (error) {
    logError('Error processing reportPage:', error);
    return { success: false, error: error.message, code: error.code };
  }
}

// ─── Message Handlers: Cache/Queue ───────────────────────────────────

async function handleClearWriteQueue() {
  logBuffer = [];
  await persistLogBuffer();
  return { success: true };
}

async function handleFlushLogBuffer() {
  await ensureLogBuffer();
  await drainNow();
  await new Promise((r) => setTimeout(r, 50));
  return { success: true, remaining: logBuffer.length };
}

async function handleGetDeviceId() {
  const deviceId = (await getDeviceId()) || null;
  if (!deviceId && isServicePaused()) {
    return {
      success: false,
      error: `Service paused [${serviceError.code}]`,
      code: serviceError.code,
    };
  }
  return { success: true, deviceId };
}

async function handleReadCacheable(request) {
  try {
    const value = await readCacheable(request.key, request.includeDeleted);
    return { success: true, value };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── Message Handlers: Entity Reads ──────────────────────────────────

async function handleLoadPageNotes(request) {
  const t0 = performance.now();
  if (!(await canCallDesktopPopupRpc())) {
    return { success: false, error: 'Desktop page info unavailable' };
  }

  let notes;
  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop page info unavailable',
      };
    }
    notes = desktopResp.notes || [];
  } catch (error) {
    return { success: false, error: error.message };
  }
  logDebug(
    `[I/O] loadPageNotes(${request.slug}): ${notes.length} notes in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, notes };
}

async function handleListSnapshots(request) {
  const t0 = performance.now();
  if (!(await canCallDesktopPopupRpc())) {
    return { success: false, error: 'Desktop page info unavailable' };
  }

  let snapshots;
  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop page info unavailable',
      };
    }
    snapshots = desktopResp.snapshots || [];
  } catch (error) {
    return { success: false, error: error.message };
  }
  logDebug(
    `[I/O] listSnapshots(${request.slug}): ${snapshots.length} from entity in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, snapshots };
}

async function handleGetSnapshotUrl(request) {
  if (!(await canCallDesktopStreamingReadRpc())) {
    return {
      success: false,
      error: 'Desktop snapshot url unavailable',
    };
  }
  try {
    const desktopResp = await requestDesktopSnapshotHtml(
      request.slug,
      request.timestamp,
    );
    if (!desktopResp?.success || !desktopResp?.html) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop snapshot url failed',
      };
    }
    return {
      success: true,
      url:
        'data:text/html;charset=utf-8,' + encodeURIComponent(desktopResp.html),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Desktop snapshot url failed',
    };
  }
}

async function handleGetSnapshotHtml(request) {
  if (!(await canCallDesktopStreamingReadRpc())) {
    return {
      success: false,
      error: 'Desktop snapshot html unavailable',
    };
  }
  try {
    const desktopResp = await requestDesktopSnapshotHtml(
      request.slug,
      request.timestamp,
    );
    if (!desktopResp?.success || !desktopResp?.html) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop snapshot html failed',
      };
    }
    return {
      success: true,
      html: desktopResp.html,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Desktop snapshot html failed',
    };
  }
}

async function handleOpenSnapshot(request) {
  const viewerUrl = chrome.runtime.getURL(
    `snapshot-viewer.html?slug=${encodeURIComponent(request.slug)}&ts=${request.timestamp}`,
  );
  const tab = await chrome.tabs.create({ url: viewerUrl });
  return { success: true, tabId: tab.id };
}

async function handleGetDirectoryInfo() {
  if (!(await canCallDesktopMutationRpc())) {
    return { success: true, info: null };
  }
  try {
    const desktopResp = await requestDesktopDirectoryInfo();
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop directory info unavailable',
      };
    }
    return { success: true, info: desktopResp.info || null };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleGetDirectorySize() {
  if (!(await canCallDesktopMutationRpc())) {
    return { success: true, size: 0 };
  }
  try {
    const desktopResp = await requestDesktopDirectorySize();
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop directory size unavailable',
      };
    }
    return { success: true, size: desktopResp.size || 0 };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleListHistoryFiles(request) {
  if (!(await canCallDesktopSearchRpc())) {
    return {
      success: true,
      files: [],
      ...(request.includeSizes ? { sizes: {} } : {}),
    };
  }
  try {
    const desktopResp = await requestDesktopHistoryFiles(
      Boolean(request.includeSizes),
    );
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop history file list unavailable',
      };
    }
    return {
      success: true,
      files: desktopResp.files || [],
      ...(request.includeSizes ? { sizes: desktopResp.sizes || {} } : {}),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleLoadHistoryBatch(request) {
  const t0 = performance.now();
  if (!(await canCallDesktopSearchRpc())) {
    return { success: true, entries: [] };
  }
  let resp;
  try {
    const desktopResp = await requestDesktopHistoryBatch(request.files);
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop history batch unavailable',
      };
    }
    resp = { success: true, entries: desktopResp.entries || [] };
  } catch (error) {
    return { success: false, error: error.message };
  }
  logDebug(
    `[I/O] loadHistoryBatch: ${request.files.length} files in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return resp;
}

async function handleLoadAllPages() {
  await hydrationDone;
  const t0 = performance.now();
  if (!(await canCallDesktopPopupRpc())) {
    return { success: false, error: 'Desktop page scan unavailable' };
  }
  try {
    const desktopResp = await requestDesktopAllPages();
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop page scan unavailable',
      };
    }
    const resp = { success: true, pages: desktopResp.pages || {} };
    logDebug(
      `[I/O] loadAllPages: ${Object.keys(resp.pages).length} pages in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return resp;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── Message Handlers: Page Relations ────────────────────────────────

async function handleGetPageRelations(request) {
  try {
    const url = request.url;
    const slug = generateSlugFromUrl(url);
    const page = (await readCacheable(pageKey(slug))) || {};

    async function resolveRefs(refs) {
      const urls = [];
      for (const ref of refs) {
        if (ref.startsWith(PAGE_PREFIX)) {
          const p = await readCacheable(ref);
          if (p && p.url) urls.push(p.url);
        }
      }
      return urls;
    }

    const pageParentRefs = (page.parentIds || []).filter((p) =>
      p.startsWith(PAGE_PREFIX),
    );
    const parentReferrers = await resolveRefs(pageParentRefs);

    const parentLists = [];
    const listParentRefs = (page.parentIds || []).filter(
      (p) => p.startsWith(LIST_PREFIX) && !isSystemList(p),
    );
    for (const lk of listParentRefs) {
      const listEntity = await readCacheable(lk);
      if (listEntity) {
        const listSlug = entitySlug(lk);
        parentLists.push({
          slug: listSlug,
          name: listEntity.name,
          type: 'pin',
        });
      }
    }

    const childRefs = (page.childIds || []).filter((c) =>
      c.startsWith(PAGE_PREFIX),
    );
    const children = await resolveRefs(childRefs);

    return {
      success: true,
      parents: { referrers: parentReferrers, lists: parentLists },
      children,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ─── Message Handlers: Context Menu & Settings ───────────────────────

async function handleContextMenuHighlightMsg(request) {
  try {
    const tabs = await chrome.tabs.query({ url: request.url });
    const tabId = tabs?.[0]?.id || null;
    return await handleContextMenuHighlight(
      request.url,
      request.title,
      request.selectionText,
      tabId,
    );
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleSaveSettingsKey(request) {
  const settings = await readCacheable('manifest:settings');
  if (
    !settings ||
    JSON.stringify(settings[request.key]) !== JSON.stringify(request.value)
  ) {
    await addLog({
      timestamp: await nextLogTimestamp(),
      action: 'update_setting',
      key: request.key,
      value: request.value,
    });
    notifyMutation('settings', { key: request.key });
  }
  if (request.key === 'colorScheme') {
    await chrome.storage.session.set({ colorScheme: request.value });
  }
  return { success: true };
}

// ─── Message Handlers: Note Mutations ────────────────────────────────

async function handleCreateNote(request, sender) {
  const pageSlug = request.pageSlug;
  const timestamp = await nextLogTimestamp();
  const noteSlug = generateNoteSlug(timestamp, request.excerpt);

  const cnPageEntity = await readCacheable(pageKey(pageSlug));
  const pageUrl = cnPageEntity?.url || request.url || sender?.tab?.url;
  if (!pageUrl) {
    return { success: false, error: 'Cannot determine page URL for note' };
  }

  const cnTitle = cnPageEntity?.title || sender?.tab?.title;
  const queued = await mirrorNoteToDesktop({
    slug: noteSlug,
    excerpt: request.excerpt,
    note: request.note || '',
    cssPath: request.cssPath || null,
    url: pageUrl,
    title: cnTitle || null,
    ts: timestamp,
  });
  if (!queued) {
    throw new Error('Desktop note queue unavailable');
  }
  void badgeController.refreshBadgesForUrls([pageUrl]);

  const notesResp = await handleLoadPageNotes({ slug: pageSlug });
  notifyMutation('note', { pageSlug, noteSlug });
  return { success: true, notes: notesResp.notes || [], noteSlug };
}

async function handleDeleteNote(request) {
  const noteSlug = request.noteSlug;
  const noteEntity = await readCacheable(noteKey(noteSlug), true);
  const dnPageUrl = noteEntity?.url || null;
  const dnEntry = {
    timestamp: await nextLogTimestamp(),
    action: 'delete_note',
    path: `notes/${noteSlug}.json`,
  };
  if (dnPageUrl) dnEntry.url = dnPageUrl;
  await addLog(dnEntry);
  notifyMutation('note', { noteSlug });
  notifyMutation('orphaned');
  return { success: true };
}

async function handleUpdateNote(request) {
  const oldNoteSlug = request.noteSlug;
  const unTimestamp = await nextLogTimestamp();
  const oldNoteData = await readCacheable(noteKey(oldNoteSlug), true);
  if (!oldNoteData) {
    return { success: false, error: 'Note not found' };
  }

  if (request.note === (oldNoteData.note ?? '')) {
    return { success: true, noteSlug: oldNoteSlug };
  }

  const newNoteSlug = generateNoteSlug(unTimestamp, oldNoteData.excerpt || '');
  const unNoteUrl = oldNoteData.url || null;

  let queued = false;
  if (unNoteUrl) {
    queued = await mirrorNoteToDesktop({
      slug: newNoteSlug,
      oldSlug: oldNoteSlug,
      excerpt: oldNoteData.excerpt || '',
      note: request.note,
      cssPath: oldNoteData.cssPath || null,
      url: unNoteUrl,
      title: null,
      ts: unTimestamp,
    });
  }
  if (!queued) {
    throw new Error('Desktop note queue unavailable');
  }

  notifyMutation('note', { noteSlug: newNoteSlug, oldNoteSlug });
  return { success: true, noteSlug: newNoteSlug };
}

// ─── Message Handlers: List Mutations ────────────────────────────────

async function handleToggleListPin(request) {
  try {
    const { listId, url, id: requestId } = request;
    const pn = await getListEventFields(listId);
    if (!pn) return { success: false, error: 'List not found' };

    let pinItem;
    if (requestId?.startsWith(NOTE_PREFIX)) {
      const noteSlug = entitySlug(requestId);
      pinItem = `notes/${noteSlug}.json`;
    } else {
      pinItem = url;
    }

    const list = await readCacheable(listKey(listId));
    const pins = list?.pins || [];
    let pinKey;
    if (requestId?.startsWith(NOTE_PREFIX)) {
      pinKey = requestId;
    } else {
      pinKey = pageKey(generateSlugFromUrl(pinItem));
    }
    const isPinned = pins.some((p) => p.id === pinKey);

    const pinLogEntry = {
      timestamp: await nextLogTimestamp(),
      action: isPinned ? 'unpin_from_list' : 'pin_to_list',
      name: pn.name,
      listOwner: pn.listOwner,
      items: [pinItem],
    };
    if (!isPinned && !requestId?.startsWith(NOTE_PREFIX)) {
      const pageEntity = await readCacheable(pinKey);
      if (pageEntity?.title)
        pinLogEntry.titles = { [pinItem]: pageEntity.title };
    }
    await addLog(pinLogEntry);
    notifyMutation('pins', { listId });
    return { success: true, pinned: !isPinned };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleAddListPins(request) {
  const pn = await getListEventFields(request.listId);
  if (pn && request.urls.length > 0) {
    const titles = { ...(request.titles || {}) };
    for (const u of request.urls) {
      if (!titles[u]) {
        const slug = generateSlugFromUrl(u);
        const pe = await readCacheable(pageKey(slug));
        if (pe?.title) titles[u] = pe.title;
      }
    }
    const pinEntry = {
      timestamp: await nextLogTimestamp(),
      action: 'pin_to_list',
      name: pn.name,
      listOwner: pn.listOwner,
      items: request.urls,
    };
    if (Object.keys(titles).length > 0) pinEntry.titles = titles;
    await addLog(pinEntry);
  }
  notifyMutation('pins', { listId: request.listId });
  return { success: true };
}

async function handleSaveListMeta(request) {
  const cached = request.listId
    ? await readCacheable(listKey(request.listId))
    : null;
  const pn = request.listId ? await getListEventFields(request.listId) : null;

  if (!cached) {
    let parentListId;
    if (request.parentPath && request.parentPath !== 'root') {
      const parts = request.parentPath.split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart.startsWith(LIST_PREFIX)) parentListId = entitySlug(lastPart);
    }
    if (request.name) {
      const deviceId = await getDeviceId();
      const generatedId = await createListAndResolveId({
        listOwner: deviceId,
        name: request.name,
        parentListId,
      });
      notifyMutation('lists');
      return { success: true, listId: generatedId };
    }
  } else if (pn) {
    const entry = {
      timestamp: await nextLogTimestamp(),
      action: 'update_list',
      name: pn.name,
      listOwner: pn.listOwner,
    };
    let hasChange = false;
    if (request.name !== undefined && cached.name !== request.name) {
      entry.newName = request.name;
      hasChange = true;
    }
    if (hasChange) {
      await addLog(entry);
      notifyMutation('lists');
    }
  }
  return { success: true };
}

async function handleDeleteList(request) {
  const pnDel = await getListEventFields(request.listId);
  if (!pnDel) return { success: false, error: 'List not found in name-to-id' };
  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'delete_list',
    name: pnDel.name,
    listOwner: pnDel.listOwner,
  });
  notifyMutation('lists');
  notifyMutation('orphaned');
  return { success: true };
}

async function handleUpdateListTree(request) {
  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'update_list_tree',
    tree: request.tree,
  });
  notifyMutation('lists');
  return { success: true };
}

// ─── Message Handlers: Recycle Bin ───────────────────────────────────

async function handleRestoreNote(request) {
  const noteSlug = request.noteSlug;
  const orphanedForRestore = await readCacheable('manifest:orphaned');
  const noteOrphanEntry = (orphanedForRestore?.entries || []).find(
    (e) => e.key === noteKey(noteSlug),
  );
  const rnNoteData = await readCacheable(noteKey(noteSlug), true);
  const rnPageUrl = noteOrphanEntry?.url || rnNoteData?.url || null;
  const rnEntry = {
    timestamp: await nextLogTimestamp(),
    action: 'restore_note',
    path: `notes/${noteSlug}.json`,
  };
  if (rnPageUrl) rnEntry.url = rnPageUrl;
  await addLog(rnEntry);
  notifyMutation('orphaned');
  notifyMutation('note', { noteSlug });
  return { success: true };
}

async function handleRestoreSnapshot(request) {
  const snapStem = request.snapSlug;
  const lastDash = snapStem.lastIndexOf('-');
  const pageSlug = lastDash >= 0 ? snapStem.slice(0, lastDash) : snapStem;
  const rsOrphaned = await readCacheable('manifest:orphaned');
  const snapOrphanEntry = (rsOrphaned?.entries || []).find(
    (e) => e.key === snapshotKey(snapStem),
  );
  let rsPageUrl = snapOrphanEntry?.url || null;
  if (!rsPageUrl) {
    const page = await readCacheable(pageKey(pageSlug));
    rsPageUrl = page?.url || null;
  }
  if (!rsPageUrl) {
    return { success: false, error: 'Cannot determine page URL for snapshot' };
  }
  const restoreEntry = {
    timestamp: await nextLogTimestamp(),
    action: 'restore_snapshot',
    url: rsPageUrl,
    path: `snapshots/${snapStem}`,
  };
  await addLog(restoreEntry);
  notifyMutation('orphaned');
  notifyMutation('snapshot', { slug: pageSlug });
  return { success: true };
}

async function handleRestoreList(request) {
  const listId = request.listId;
  const entity = await readCacheable(listKey(listId), true);
  const name = entity?.name || listId;
  const owner = entity?.owner || (await getDeviceId());
  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'restore_list',
    name,
    listOwner: owner,
  });
  notifyMutation('orphaned');
  notifyMutation('lists');
  return { success: true };
}

async function handlePermanentDelete(request) {
  if (isServicePaused())
    return { success: false, error: 'Service paused', code: serviceError.code };
  if (!(await canCallDesktopMutationRpc())) {
    return { success: false, error: 'Desktop bridge unavailable' };
  }
  const key = request.key;
  try {
    const desktopResp = await requestDesktopPermanentDelete([key]);
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop permanent delete failed',
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
  if (key.startsWith(NOTE_PREFIX)) {
    notifyMutation('note', { noteSlug: entitySlug(key) });
  } else if (key.startsWith(LIST_PREFIX)) {
    notifyMutation('lists');
  } else if (key.startsWith(SNAPSHOT_PREFIX)) {
    const snapStem = entitySlug(key);
    const lastDash = snapStem.lastIndexOf('-');
    const slug = lastDash >= 0 ? snapStem.slice(0, lastDash) : snapStem;
    notifyMutation('snapshot', { slug });
  }
  notifyMutation('orphaned');
  return { success: true };
}

async function handlePermanentDeleteAll() {
  if (isServicePaused())
    return { success: false, error: 'Service paused', code: serviceError.code };
  if (!(await canCallDesktopMutationRpc())) {
    return { success: false, error: 'Desktop bridge unavailable' };
  }
  const orphaned = (await readCacheable('manifest:orphaned')) || {
    timestamp: 0,
    entries: [],
  };
  const keys = (orphaned.entries || []).map((entry) => entry.key);
  if (keys.length > 0) {
    try {
      const desktopResp = await requestDesktopPermanentDelete(keys);
      if (!desktopResp?.success) {
        return {
          success: false,
          error: desktopResp?.error || 'Desktop permanent delete failed',
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  notifyMutation('note', {});
  notifyMutation('snapshot', {});
  notifyMutation('lists');
  notifyMutation('orphaned');
  return { success: true };
}

// ─── Message Handlers: Filesystem ────────────────────────────────────

async function handleInitializeFilesystem(request) {
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (connector.state !== 'connected') {
    return { success: false, error: 'Browser Recall Desktop is not connected' };
  }
  if (connector.deviceId) localDeviceId = connector.deviceId;
  await ensureLogBuffer();
  hydrationDone = Promise.resolve();
  await ensureDefaultLists();
  return { success: true };
}

async function handleDeleteSnapshot(request) {
  const slug = request.slug;
  const snapTimestamp = request.timestamp;
  const page = await readCacheable(pageKey(slug));
  if (!page?.url)
    return { success: false, error: 'Page entity not found for snapshot' };
  const deleteEntry = {
    timestamp: await nextLogTimestamp(),
    action: 'delete_snapshot',
    url: page.url,
    path: `snapshots/${slug}-${snapTimestamp}`,
  };
  await addLog(deleteEntry);
  notifyMutation('snapshot', { slug });
  notifyMutation('orphaned');
  return { success: true };
}

async function handleClearAllData() {
  if (!(await canCallDesktopMutationRpc())) {
    return { success: false, error: 'Desktop bridge unavailable' };
  }
  const resp = await requestDesktopClearAllData();
  if (!resp?.success) return resp;
  logBuffer = [];
  await persistLogBuffer();
  await cacheClear();
  recentUrls = new Map();
  tabReportedUrls.clear();
  return { success: true, deletedCount: resp.deletedCount };
}

async function handleSetImportDirectoryHandle(request) {
  void request;
  return {
    success: false,
    error: 'Import directory handles are not supported in desktop mode',
  };
}

// ─── Message Handlers: Rules ─────────────────────────────────────────

async function handleAddRule(request) {
  const { listId, rule } = request;
  const listInfo = await getListEventFields(listId);
  if (!listInfo) return { success: false, error: 'List not found' };

  const validation = validateRuleConfig(rule);
  if (!validation.valid)
    return { success: false, error: validation.errors.join('; ') };

  if (rule.type === 'function') {
    const fnValidation = validateFnRuleSource(rule.config.fnSource);
    if (!fnValidation.valid)
      return { success: false, error: fnValidation.errors.join('; ') };
    const compileResp = await requestRulePreview(rule, []);
    if (!compileResp?.success)
      return {
        success: false,
        error: compileResp?.error || 'Function failed to compile',
      };
  }

  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'add_rule',
    name: listInfo.name,
    listOwner: listInfo.listOwner,
    rule: { type: rule.type, config: rule.config },
  });
  notifyMutation('rules', { listId });
  return { success: true };
}

async function handleRemoveRule(request) {
  const { listId, ruleId } = request;
  const listInfo = await getListEventFields(listId);
  if (!listInfo) return { success: false, error: 'List not found' };

  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'remove_rule',
    name: listInfo.name,
    listOwner: listInfo.listOwner,
    ruleId,
  });
  notifyMutation('rules', { listId });
  return { success: true };
}

async function handleUpdateRule(request) {
  const { listId, ruleId, config } = request;
  const listInfo = await getListEventFields(listId);
  if (!listInfo) return { success: false, error: 'List not found' };

  await addLog({
    timestamp: await nextLogTimestamp(),
    action: 'update_rule',
    name: listInfo.name,
    listOwner: listInfo.listOwner,
    ruleId,
    config,
  });
  notifyMutation('rules', { listId });
  return { success: true };
}

async function handleRunRuleBatch(request) {
  const { listIds: batchListIds, entries } = request;
  const desktopResp = await requestRuleBatch(batchListIds, entries);
  if (!desktopResp?.success) {
    return {
      success: false,
      error: desktopResp?.error || 'Rule batch failed',
    };
  }
  await applyDesktopRuleBatchLocally(desktopResp.results || []);
  return {
    success: true,
    results: desktopResp.results || [],
  };
}

async function handlePreviewRule(request) {
  const { rule, entries } = request;
  const validation = validateRuleConfig(rule);
  if (!validation.valid)
    return { success: false, error: validation.errors.join('; ') };
  if (rule.type === 'function') {
    const fnValidation = validateFnRuleSource(rule.config.fnSource);
    if (!fnValidation.valid)
      return { success: false, error: fnValidation.errors.join('; ') };
  }
  const desktopResp = await requestRulePreview(rule, entries);
  if (!desktopResp?.success) {
    return {
      success: false,
      error: desktopResp?.error || 'Rule preview failed',
    };
  }
  return { success: true, results: desktopResp.results || [] };
}

async function handleSearchHistory(request) {
  if (!(await canCallDesktopSearchRpc())) {
    return { success: false, error: 'Desktop search unavailable' };
  }
  try {
    const desktopResp = await requestDesktopHistorySearch(
      request.query,
      request.limit,
    );
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop history search failed',
      };
    }
    return {
      success: true,
      results: desktopResp.results || [],
    };
  } catch (error) {
    return { success: false, error: error.message || 'Desktop search failed' };
  }
}

async function handleSearchNotes(request) {
  if (!(await canCallDesktopSearchRpc())) {
    return { success: false, error: 'Desktop search unavailable' };
  }
  try {
    const desktopResp = await requestDesktopNotesSearch(
      request.query,
      request.limit,
    );
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop note search failed',
      };
    }
    return {
      success: true,
      results: desktopResp.results || [],
    };
  } catch (error) {
    return { success: false, error: error.message || 'Desktop search failed' };
  }
}

async function handleSearchSnapshots(request) {
  if (!(await canCallDesktopSearchRpc())) {
    return { success: false, error: 'Desktop search unavailable' };
  }
  try {
    const desktopResp = await requestDesktopSnapshotsSearch(
      request.query,
      request.limit,
    );
    if (!desktopResp?.success) {
      return {
        success: false,
        error: desktopResp?.error || 'Desktop snapshot search failed',
      };
    }
    return {
      success: true,
      results: desktopResp.results || [],
    };
  } catch (error) {
    return { success: false, error: error.message || 'Desktop search failed' };
  }
}

// ─── Message Handlers: Test ──────────────────────────────────────────

async function handleResetForTest() {
  const resetResp = await requestDesktopTestReset();
  if (!resetResp?.success) return resetResp;
  logBuffer = [];
  await persistLogBuffer();
  await cacheClear();
  localDeviceId = null;
  recentUrls = new Map();
  tabReportedUrls.clear();
  serviceError = null;
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  resumeService();
  hydrationDone = hydrateCache();
  await hydrationDone;
  await ensureDefaultLists();
  return { success: true };
}

async function handleResumeService() {
  resumeService();
  hydrationDone = hydrateCache();
  await hydrationDone;
  scheduleDrainNotify();
  return { success: true };
}

async function handleSetLogBufferForTest(request) {
  logBuffer = request.entries || [];
  await persistLogBuffer();
  return { success: true };
}

async function handleRehydrateForTest(request) {
  if (!request.keepLogBuffer) {
    logBuffer = [];
    await persistLogBuffer();
  }
  await cacheClear();
  localDeviceId = null;
  recentUrls = new Map();
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  hydrationDone = hydrateCache();
  await hydrationDone;
  await ensureDefaultLists();
  return { success: true };
}

function seedDeviceId(files) {
  for (const file of files || []) {
    const match = file?.path?.match(/^data\/logs\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }
  return null;
}

function serializeTestSeedFile(file) {
  if (!file?.path) return null;
  if (typeof file.content === 'string') {
    return { path: file.path, content: file.content };
  }
  if (Object.prototype.hasOwnProperty.call(file, 'data')) {
    return {
      path: file.path,
      content: `${JSON.stringify(file.data, null, 2)}\n`,
    };
  }
  if (Array.isArray(file.lines)) {
    return {
      path: file.path,
      content: `${file.lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    };
  }
  throw new Error(`Unsupported test seed payload for ${file.path}`);
}

async function handleSeedTestData(request) {
  const deviceId = request.deviceId || seedDeviceId(request.files);
  if (deviceId) {
    const setDeviceResp = await requestDesktopSetDeviceId(deviceId);
    if (!setDeviceResp?.success) return setDeviceResp;
    localDeviceId = deviceId;
  }
  const files = (request.files || [])
    .map(serializeTestSeedFile)
    .filter(Boolean);
  if (files.length === 0) {
    return { success: true };
  }
  return requestDesktopTestSeed(files);
}

async function handleGetLogBufferForTest() {
  await ensureLogBuffer();
  return {
    success: true,
    length: logBuffer.length,
    watermark: logBufferWatermark,
  };
}

// ─── Message Dispatch ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, rawSendResponse) => {
  // Skip Save Page WE messages (they use `type` field, handled by separate listener)
  if (request.type && !request.action) return false;

  const usePromiseResponse = BROWSER_CAPABILITIES.supportsPromiseOnMessage;
  let resolveResponse;
  const responsePromise = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const sendResponse = (response) => {
    resolveResponse(response);
    if (!usePromiseResponse) rawSendResponse(response);
  };

  (async () => {
    try {
      switch (request.action) {
        // Tab/popup queries
        case 'getReportedUrl':
          sendResponse(handleGetReportedUrl(request));
          break;
        case 'getPageInfo':
          sendResponse(await handleGetPageInfo(request));
          break;
        case 'getPageSummary':
          sendResponse(await handleGetPageSummary(request));
          break;
        case 'getPopupLists':
          sendResponse(await handleGetPopupLists());
          break;
        case 'trimTitle':
          sendResponse({
            title: await trimTitle(request.title || '', request.url || ''),
          });
          break;
        case 'captureCurrentPageFromPopup':
          sendResponse(await handleCaptureCurrentPageFromPopup());
          break;
        case 'hydrateCache':
          sendResponse(await handleHydrateCacheMsg());
          break;
        // Page lifecycle
        case 'reportPage':
          sendResponse(await handleReportPage(request, sender));
          break;
        // Cache/queue
        case 'clearWriteQueue':
          sendResponse(await handleClearWriteQueue());
          break;
        case 'flushLogBuffer':
          sendResponse(await handleFlushLogBuffer());
          break;
        case 'getDeviceId':
          sendResponse(await handleGetDeviceId());
          break;
        case 'getDesktopConnectorState':
          sendResponse(await handleGetDesktopConnectorState());
          break;
        case 'connectDesktopBridge':
          sendResponse(await handleConnectDesktopBridge());
          break;
        case 'readCacheable':
          sendResponse(await handleReadCacheable(request));
          break;
        // Entity reads
        case 'loadPageNotes':
          sendResponse(await handleLoadPageNotes(request));
          break;
        case 'listSnapshots':
          sendResponse(await handleListSnapshots(request));
          break;
        case 'getSnapshotUrl':
          sendResponse(await handleGetSnapshotUrl(request));
          break;
        case 'getSnapshotHtml':
          sendResponse(await handleGetSnapshotHtml(request));
          break;
        case 'openSnapshot':
          sendResponse(await handleOpenSnapshot(request));
          break;
        case 'getDirectoryInfo':
          sendResponse(await handleGetDirectoryInfo());
          break;
        case 'getDirectorySize':
          sendResponse(await handleGetDirectorySize());
          break;
        case 'listHistoryFiles':
          sendResponse(await handleListHistoryFiles(request));
          break;
        case 'loadHistoryBatch':
          sendResponse(await handleLoadHistoryBatch(request));
          break;
        case 'loadAllPages':
          sendResponse(await handleLoadAllPages());
          break;
        // Page relations
        case 'getPageRelations':
          sendResponse(await handleGetPageRelations(request));
          break;
        // Context menu / settings
        case 'contextMenuHighlight':
          sendResponse(await handleContextMenuHighlightMsg(request));
          break;
        case 'saveSettingsKey':
          sendResponse(await handleSaveSettingsKey(request));
          break;
        // Note mutations
        case 'createNote':
          sendResponse(await handleCreateNote(request, sender));
          break;
        case 'deleteNote':
          sendResponse(await handleDeleteNote(request));
          break;
        case 'updateNote':
          sendResponse(await handleUpdateNote(request));
          break;
        // List mutations
        case 'toggleListPin':
          sendResponse(await handleToggleListPin(request));
          break;
        case 'addListPins':
          sendResponse(await handleAddListPins(request));
          break;
        case 'saveListMeta':
          sendResponse(await handleSaveListMeta(request));
          break;
        case 'deleteList':
          sendResponse(await handleDeleteList(request));
          break;
        case 'updateListTree':
          sendResponse(await handleUpdateListTree(request));
          break;
        // Recycle bin
        case 'restoreNote':
          sendResponse(await handleRestoreNote(request));
          break;
        case 'restoreSnapshot':
          sendResponse(await handleRestoreSnapshot(request));
          break;
        case 'restoreList':
          sendResponse(await handleRestoreList(request));
          break;
        case 'permanentDelete':
          sendResponse(await handlePermanentDelete(request));
          break;
        case 'permanentDeleteAll':
          sendResponse(await handlePermanentDeleteAll());
          break;
        // Filesystem
        case 'initializeFilesystem':
          sendResponse(await handleInitializeFilesystem(request));
          break;
        case 'deleteSnapshot':
          sendResponse(await handleDeleteSnapshot(request));
          break;
        case 'clearAllData':
          sendResponse(await handleClearAllData());
          break;
        case 'setImportDirectoryHandle':
          sendResponse(await handleSetImportDirectoryHandle(request));
          break;
        // Rules
        case 'addRule':
          sendResponse(await handleAddRule(request));
          break;
        case 'removeRule':
          sendResponse(await handleRemoveRule(request));
          break;
        case 'updateRule':
          sendResponse(await handleUpdateRule(request));
          break;
        case 'runRuleBatch':
          sendResponse(await handleRunRuleBatch(request));
          break;
        case 'previewRule':
          sendResponse(await handlePreviewRule(request));
          break;
        case 'searchHistory':
          sendResponse(await handleSearchHistory(request));
          break;
        case 'searchNotes':
          sendResponse(await handleSearchNotes(request));
          break;
        case 'searchSnapshots':
          sendResponse(await handleSearchSnapshots(request));
          break;
        // Test helpers
        case 'resetForTest':
          sendResponse(await handleResetForTest());
          break;
        case 'resumeService':
          sendResponse(await handleResumeService());
          break;
        case 'setLogBufferForTest':
          sendResponse(await handleSetLogBufferForTest(request));
          break;
        case 'rehydrateForTest':
          sendResponse(await handleRehydrateForTest(request));
          break;
        case 'seedTestData':
          sendResponse(await handleSeedTestData(request));
          break;
        case 'getLogBufferForTest':
          sendResponse(await handleGetLogBufferForTest());
          break;
        default:
          sendResponse({
            success: false,
            error: `Unknown action: ${request.action}`,
          });
      }
    } catch (error) {
      logError('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  if (usePromiseResponse) return responsePromise;
  return true;
});
