// Background service worker for Browser Recall.
// Central authority for extension reads and mutations. Persistent data and
// replay are owned by the desktop daemon.
import './browser-api.js';
import { generateSlugFromUrl, isInternalBrowserUrl } from './utils.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { SCHEME_HEX } from './color-scheme-map.js';
import { logDebug, logError } from './logger.js';
import { createBadgeController } from './badge-controller.js';
import { getBrowserCapabilities } from './browser-capabilities.js';
import {
  DEFAULT_ICON_PATHS,
  SPECIAL_LIST_ICON_PATHS,
  SPECIAL_MIXED_ICON_PATHS,
  SPECIAL_NOTE_ICON_PATHS,
  STOP_RECORDING_ICON_PATHS,
} from './icon-paths.js';
import {
  clearDesktopBuffer,
  enqueueDesktopCommand,
  enqueueDesktopSnapshot,
  getConnectorBridgeState,
  flushDesktopBuffer,
  initConnectorBridge,
  refreshConnectorBridgeState,
  subscribeConnectorBridgeState,
  subscribeDaemonMutations,
  requestDesktopHistoryFiles,
  requestDesktopHistoryBatch,
  requestDesktopPageInfo,
  requestDesktopPageSummary,
  requestDesktopSettings,
  requestDesktopCommand,
  requestDesktopPopupLists,
  requestDesktopSnapshotHtml,
  connectDesktopBridge,
} from './connector/ws-client.js';
import {
  NOTE_PREFIX,
  SNAPSHOT_PREFIX,
  LIST_PREFIX,
  pageKey,
} from './entity-types.js';

logDebug('Background script loading...');

function tr(key, fallback, substitutions) {
  return (
    chrome.i18n?.getMessage?.(
      key,
      substitutions === undefined
        ? undefined
        : Array.isArray(substitutions)
          ? substitutions
          : [substitutions],
    ) || fallback
  );
}

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — connector queue is durable until drained
const CONNECTOR_STATE_REFRESH_TIMEOUT_MS = 1000;
const POPUP_PREPARE_TIMEOUT_MS = 1500;
const POPUP_BOOTSTRAP_TTL_MS = 30_000;
const POPUP_ACTION_MAPPING_FALLBACK_CLEAR_MS = 5000;
const BROWSER_CAPABILITIES = getBrowserCapabilities();

let lastLogTimestamp = 0;
const pendingPopupBootstraps = new Map();

// tabId → URL from the content script's initial recordPageActivity.
// Used by popup to avoid slug mismatch when tab.url drifts (SPA pushState, etc.).
const tabReportedUrls = new Map();

function isSameDocumentPageUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return left === right;
  }
}

function badgeIdentityUrlForTab(tabId, url) {
  const reportedUrl = tabReportedUrls.get(tabId);
  if (reportedUrl && isSameDocumentPageUrl(reportedUrl, url)) {
    return reportedUrl;
  }
  return url;
}

// Device ID for this instance. The daemon owns it in app config; the extension
// mirrors it locally after connector status responses.
let localDeviceId = null;

// Service error state: null = healthy, { code, message, timestamp } = paused.
// Error codes: 'session_quota', 'local_quota', 'desktop_buffer_full'.
let serviceError = null;

// Lazy getter: returns localDeviceId, asking the daemon connector on cache miss.
// Handles both startup race and SW wakeup.
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
    .catch((error) =>
      logDebug('[badge] service resume failed:', error.message),
    );
  chrome.storage.session.remove(['serviceError']).catch(() => {});
  logDebug('Service resumed');
}

function isServicePaused() {
  return serviceError !== null;
}

async function getWorkspaceState() {
  const { workspace } = await chrome.storage.session.get(['workspace']);
  return workspace || null;
}

// Session storage: in-memory IPC, survives SW termination, cleared on browser restart.
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});

const badgeController = createBadgeController({
  logDebug,
  normalIconPaths: DEFAULT_ICON_PATHS,
  stoppedRecordingIconPaths: STOP_RECORDING_ICON_PATHS,
  specialListIconPaths: SPECIAL_LIST_ICON_PATHS,
  specialNoteIconPaths: SPECIAL_NOTE_ICON_PATHS,
  specialMixedIconPaths: SPECIAL_MIXED_ICON_PATHS,
  syncDesktopConnectorPauseState,
  readPageMarkers: async (url) => {
    const summary = await handleGetPageSummary({ url });
    if (!summary.success || !summary.page) return null;
    const slug = generateSlugFromUrl(url);
    return {
      hasNotes: summary.notes.length > 0 || summary.snapshots.length > 0,
      hasLists: summary.lists.some((list) =>
        (list.pins || []).some(
          (pin) => pin.kind === 'page' && pin.slug === slug,
        ),
      ),
    };
  },
  readRecordingPausedState: async () => {
    const workspace = await getWorkspaceState();
    return workspace?.mode === 'private';
  },
  resolveTabUrl: badgeIdentityUrlForTab,
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
      tr(
        'extensionDesktopBufferFull',
        'Browser Recall Desktop buffer full - start the desktop app or wait for the queue to drain.',
      ),
    );
    return;
  }
  if (serviceError?.code === 'desktop_buffer_full') {
    resumeService();
  }
}

async function nextLogTimestamp() {
  const now = Date.now();
  const timestamp = now > lastLogTimestamp ? now : lastLogTimestamp + 1;
  lastLogTimestamp = timestamp;
  return timestamp;
}

function observeLogTimestamp(timestamp) {
  if (Number.isFinite(timestamp) && timestamp > lastLogTimestamp) {
    lastLogTimestamp = timestamp;
  }
}

async function enqueueCommand(action, request) {
  try {
    const stats = await enqueueDesktopCommand(action, request);
    syncDesktopConnectorPauseState(stats);
  } catch (error) {
    if (error.code === 'buffer_full') {
      pauseService(
        'desktop_buffer_full',
        tr(
          'extensionDesktopBufferFull',
          'Browser Recall Desktop buffer full - start the desktop app or wait for the queue to drain.',
        ),
      );
      return;
    }
    logDebug('[desktop] command enqueue failed:', error.message);
    throw error;
  }
}

async function runDesktopCommand(action, request = {}) {
  try {
    const response = await requestDesktopCommand(action, request);
    if (!response?.success) {
      return {
        success: false,
        error: response?.error || `${action} failed`,
      };
    }
    return response;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function loadDesktopHistoryRange(from, to) {
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

async function mirrorSnapshotToDesktop(snapshot) {
  try {
    const stats = await enqueueDesktopSnapshot(snapshot);
    syncDesktopConnectorPauseState(stats);
    return true;
  } catch (error) {
    if (error.code === 'buffer_full') {
      const message = tr(
        'extensionDesktopEventQueueFull',
        'Browser Recall Desktop event queue is full - start the desktop app or wait for the queue to drain.',
      );
      pauseService('desktop_buffer_full', message);
      throw new Error(message);
    }
    logDebug('[desktop] snapshot mirror failed:', error.message);
    throw error;
  }
}

// ─── Mutation Notifications ───────────────────────────────────────────
// Notify extension pages (options, popup) after data mutations so they can refresh.

function notifyMutation(type, detail) {
  chrome.runtime
    .sendMessage({ action: 'mutation', type, ...detail })
    .catch(() => {});
}

function isExtensionRuntimeFailure(error) {
  return Boolean(
    globalThis.browserRecallWebExtension?.isRuntimeFailure?.(error),
  );
}

function userActionErrorMessage(
  error,
  fallback = tr('extensionActionFailed', 'Action failed'),
) {
  if (isExtensionRuntimeFailure(error)) {
    return tr(
      'extensionReloaded',
      'Browser Recall extension reloaded. Please reload the page and try again.',
    );
  }
  return String(error?.message || error || fallback);
}

async function injectUserActionNotification(
  tabId,
  {
    id,
    message,
    durationMs = 5000,
    minWidth = '180px',
    maxWidth = 'min(360px, calc(100vw - 32px))',
    background = '#fffaf3',
    color = '#b3261e',
    border = '2px solid #d93025',
    boxShadow = 'none',
  },
) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => {
      const {
        id,
        message: displayMessage,
        durationMs,
        minWidth,
        maxWidth,
        background,
        color,
        border,
        boxShadow,
      } = options;
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const host = document.createElement('div');
      host.id = id;
      host.setAttribute('role', 'status');
      host.setAttribute('aria-label', displayMessage);
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const escaped = String(displayMessage).replace(
        /[&<>"']/g,
        (char) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[char],
      );
      shadow.innerHTML = `
        <style>
          .bubble {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) scale(0.92);
            z-index: 2147483647;
            min-width: ${minWidth};
            max-width: ${maxWidth};
            background: ${background};
            color: ${color};
            border: ${border};
            border-radius: 2px;
            box-shadow: ${boxShadow};
            font: 900 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            letter-spacing: 0.08em;
            padding: 9px 12px;
            pointer-events: none;
            text-align: center;
            text-transform: uppercase;
            opacity: 1;
          }
        </style>
        <div class="bubble">${escaped}</div>
      `;
      document.documentElement.appendChild(host);
      setTimeout(() => host.remove(), durationMs);
    },
    args: [
      {
        id,
        message,
        durationMs,
        minWidth,
        maxWidth,
        background,
        color,
        border,
        boxShadow,
      },
    ],
  });
}

async function injectUserActionErrorNotification(tabId, message) {
  return injectUserActionNotification(tabId, {
    id: 'browser-recall-user-action-error',
    message,
  });
}

async function injectUserActionSuccessNotification(tabId, message) {
  return injectUserActionNotification(tabId, {
    id: 'browser-recall-user-action-success',
    message,
    durationMs: 1600,
    minWidth: '140px',
    maxWidth: 'min(320px, calc(100vw - 32px))',
    background: '#ffffff',
    color: '#111111',
    border: '2px solid #171713',
    boxShadow:
      '0 16px 40px rgba(0, 0, 0, 0.18), 0 2px 10px rgba(0, 0, 0, 0.12)',
  });
}

async function notifyTabUserActionError(
  tabId,
  error,
  fallback = tr('extensionActionFailed', 'Action failed'),
) {
  if (!tabId || tabId <= 0) return;
  const message = userActionErrorMessage(error, fallback);
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'showErrorNotification',
      message,
    });
  } catch (sendError) {
    try {
      await injectUserActionErrorNotification(tabId, message);
    } catch (injectError) {
      logDebug(
        '[notification] user action error notification failed:',
        sendError.message,
        injectError.message,
      );
    }
  }
}

async function notifyTabUserActionSuccess(
  tabId,
  message,
  action,
  payload = {},
) {
  if (!tabId || tabId <= 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action, ...payload });
  } catch (sendError) {
    try {
      await injectUserActionSuccessNotification(tabId, message);
    } catch (injectError) {
      logDebug(
        '[notification] user action success notification failed:',
        sendError.message,
        injectError.message,
      );
    }
  }
}

// ─── Connector Queue Flush ───────────────────────────────────────────
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
    return connector;
  } catch (error) {
    logDebug('[connector] scheduled flush failed:', error.message);
    return null;
  }
}

async function flushInteractiveWrites() {
  return await drainNow();
}

subscribeConnectorBridgeState((connector) => {
  syncDesktopConnectorPauseState(connector);
  badgeController.scheduleConnectorBadgeRefresh(connector);
});

subscribeDaemonMutations((mutation) => {
  handleRuntimeMutation(mutation);
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

// High-level: enqueue an observed browser command for Desktop. The connector
// queue is the only durable extension-side command queue; snapshots use the live bridge.
async function enqueueReportCommand(action, request, { flush = false } = {}) {
  if (isServicePaused()) {
    throw new Error(`Service paused [${serviceError.code}]`);
  }
  observeLogTimestamp(request.timestamp);
  await enqueueCommand(action, request);
  if (flush) {
    await flushInteractiveWrites();
  } else {
    scheduleDrainNotify();
  }
  if (request.url) {
    void badgeController.refreshBadgesForUrls([request.url]);
  }
  return {};
}

async function buildVisitReport(
  url,
  title,
  referrerUrl,
  bodyPreview,
  bypassBlacklist,
) {
  const request = {
    timestamp: await nextLogTimestamp(),
    url,
  };
  if (title) request.title = title;
  if (referrerUrl) request.referrer = referrerUrl;
  if (bodyPreview) request.bodyPreview = bodyPreview;
  if (bypassBlacklist) request.bypassBlacklist = true;
  return request;
}

async function buildLeaveReport(url, title, scrollDepth, timeOnPage) {
  const request = {
    timestamp: await nextLogTimestamp(),
    url,
  };
  if (title) request.title = title;
  if (scrollDepth !== undefined && scrollDepth !== null)
    request.scrollDepth = scrollDepth;
  if (timeOnPage !== undefined && timeOnPage > 0)
    request.timeOnPage = timeOnPage;
  return request;
}

// ─── Settings Keys ───────────────────────────────────────────────────

async function ensureDefaultLists() {
  try {
    const response = await runDesktopCommand('ensureDefaultLists');
    if (response?.success && response.created) {
      notifyMutation('lists');
      notifyMutation('rules', { listId: 'hubs' });
    }
  } catch (e) {
    logDebug('First-run default list creation failed:', e.message);
  }
}

// ─── Title Trimming ───────────────────────────────────────────────────

async function trimTitle(rawTitle, url) {
  const response = await runDesktopCommand('trimTitle', {
    title: rawTitle,
    url,
  });
  if (!response.success) throw new Error(response.error || 'Title trim failed');
  return response.title || '';
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    badgeController.updateBadgeForTab(
      tabId,
      badgeIdentityUrlForTab(tabId, tab.url),
    );
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
    const reportedUrl = tabReportedUrls.get(details.tabId);
    const isSameReportedPage =
      reportedUrl && isSameDocumentPageUrl(reportedUrl, details.url);
    tabUrls.set(details.tabId, details.url);
    if (!isSameReportedPage) tabReportedUrls.delete(details.tabId);
    committed.set(details.tabId, referrer);
    badgeController.updateBadgeForTab(
      details.tabId,
      isSameReportedPage ? reportedUrl : details.url,
    );
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

function callContextMenuMethod(methodName, ...args) {
  const method = chrome.contextMenus[methodName].bind(chrome.contextMenus);
  // Firefox exposes context-menu promises; Chromium-compatible engines may
  // report callback-only failures through runtime.lastError.
  if (globalThis.browserRecallWebExtension?.engine === 'firefox') {
    return Promise.resolve(method(...args));
  }
  return new Promise((resolve, reject) => {
    try {
      method(...args, () => {
        const error =
          globalThis.browser?.runtime?.lastError || chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureLocalizedHighlightContextMenu() {
  const item = {
    id: 'portal-highlight',
    title: tr('extensionHighlightSelected', 'Highlight Selected'),
    contexts: ['selection'],
  };
  try {
    await callContextMenuMethod('update', item.id, { title: item.title });
  } catch {
    await callContextMenuMethod('create', item);
  }
}

chrome.runtime.onInstalled.addListener(async (details = {}) => {
  logDebug('browser-recall extension installed');

  await ensureLocalizedHighlightContextMenu();

  if (details.reason === 'install') {
    await chrome.runtime.openOptionsPage().catch((error) => {
      logDebug('[install] open options page failed:', error.message);
    });
  }

  logDebug('Extension installed');

  startConnectorBridge('install');
});

chrome.runtime.onStartup.addListener(async () => {
  logDebug('Extension started');

  await ensureLocalizedHighlightContextMenu();

  startConnectorBridge('browser start');
});

// ─── Save Page WE Integration ─────────────────────────────────────────
initSavepageBridge();
startConnectorBridge('background boot');

// ─── Snapshot Capture ─────────────────────────────────────────────────

async function getBadgeAccentColor() {
  const { colorScheme } = await chrome.storage.session.get(['colorScheme']);
  return SCHEME_HEX[colorScheme] || SCHEME_HEX.amber;
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

function escapeHtmlAttribute(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char],
  );
}

function prepareSnapshotHtml(html, slug, url = null) {
  if (!html) return html;
  let cleaned = html
    .replace(
      /<mark\b(?=[^>]*\bclass=(["'])[^"']*\bportal-highlight\b[^"']*\1)[^>]*>([\s\S]*?)<\/mark>/gi,
      '$2',
    )
    .replace(
      /\sclass=(["'])([^"']*\bportal-highlight\b[^"']*)\1/gi,
      (_, quote, classes) => {
        const remaining = classes
          .split(/\s+/)
          .filter((className) => className && className !== 'portal-highlight')
          .join(' ');
        return remaining ? ` class=${quote}${remaining}${quote}` : '';
      },
    )
    .replace(/\sdata-highlight-(?:text|timestamp)=(["']).*?\1/gi, '')
    .replace(/\sdata-note-slug=(["']).*?\1/gi, '');

  if (!slug || /<meta\s+name=(["'])x-portal-slug\1/i.test(cleaned)) {
    return cleaned;
  }
  const meta = [
    `<meta name="x-portal-slug" content="${escapeHtmlAttribute(slug)}">`,
    url
      ? `<meta name="x-portal-url" content="${escapeHtmlAttribute(url)}">`
      : '',
  ].join('');
  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (match) => `${match}${meta}`);
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(
      /<html\b[^>]*>/i,
      (match) => `${match}<head>${meta}</head>`,
    );
  }
  return `${meta}${cleaned}`;
}

async function captureAndLog(tabId, slug, timestamp, url, title) {
  badgeController.startSpinnerBadge(tabId);
  try {
    const cannotCapturePdfMessage = tr(
      'extensionCannotCapturePdf',
      'Cannot capture PDF pages',
    );
    // PDF pages render via a native plugin — no extractable content
    if (url && /\.pdf(\?|#|$)/i.test(new URL(url).pathname)) {
      throw new Error(cannotCapturePdfMessage);
    }
    // Fallback: ask content script to check for Chrome's PDF viewer embed
    try {
      const pdfCheck = await chrome.tabs.sendMessage(tabId, {
        action: 'isPdfPage',
      });
      if (pdfCheck?.isPdf) throw new Error(cannotCapturePdfMessage);
    } catch (e) {
      if (
        e.message === cannotCapturePdfMessage ||
        e.message === 'Cannot capture PDF pages'
      )
        throw e;
      if (isExtensionRuntimeFailure(e)) throw e;
      // Content script might not be loaded — proceed with capture
    }
    const mdResp = await chrome.tabs.sendMessage(tabId, {
      action: 'extractMarkdown',
    });
    const settingsResponse = await requestDesktopSettings();
    if (!settingsResponse?.success) {
      throw new Error(
        settingsResponse?.error || 'Desktop settings unavailable',
      );
    }
    const settings = settingsResponse.settings || {};
    const capture = await captureSavePage(tabId, settings);
    const html = prepareSnapshotHtml(capture.html, slug, url);
    const markdown = mdResp?.markdown || '';
    if (!markdown && !html) {
      throw new Error(
        tr(
          'extensionCaptureNoContent',
          'Capture failed: page returned no content',
        ),
      );
    }
    await mirrorSnapshotToDesktop({
      slug,
      ts: timestamp,
      url,
      title,
      markdown,
      html: html || '',
    });
    await flushInteractiveWrites();
    void badgeController.refreshBadgesForUrls([url]);
    notifyMutation('snapshot', { slug });
    return { warnings: capture.warnings || [] };
  } finally {
    stopSpinnerBadge(tabId);
  }
}

function captureWarningMessage(warnings) {
  const count = warnings?.length || 0;
  if (count === 0) return null;
  if (count === 1) {
    return tr(
      'extensionSnapshotCapturedWithOneWarning',
      'Snapshot captured, but 1 resource was unavailable.',
    );
  }
  return tr(
    'extensionSnapshotCapturedWithWarnings',
    `Snapshot captured, but ${count} resources were unavailable.`,
    [String(count)],
  );
}

// ─── Context Menu ─────────────────────────────────────────────────────

function collapseSelectionWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getContextMenuSelectionPayload(tabId, fallbackText) {
  const fallback = String(fallbackText || '').trim();
  if (!tabId || tabId <= 0) {
    return { excerpt: fallback ? [fallback] : [], cssPath: [''] };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'getStructuredSelectionText',
    });
    const structured = String(response?.selectionText || '').trim();
    if (
      structured &&
      collapseSelectionWhitespace(structured) ===
        collapseSelectionWhitespace(fallback)
    ) {
      return {
        excerpt: Array.isArray(response.selectionExcerpt)
          ? response.selectionExcerpt
          : [structured],
        cssPath: Array.isArray(response.selectionCssPath)
          ? response.selectionCssPath
          : [''],
      };
    }
  } catch (error) {
    logDebug('[context-menu] Structured selection unavailable:', error.message);
  }

  return { excerpt: fallback ? [fallback] : [], cssPath: [''] };
}

async function handleContextMenuHighlight(url, title, selectionText, tabId) {
  const slug = generateSlugFromUrl(url);
  const { excerpt, cssPath } = await getContextMenuSelectionPayload(
    tabId,
    selectionText,
  );

  const response = await runDesktopCommand('createNote', {
    pageSlug: slug,
    excerpt,
    note: '',
    cssPath,
    url,
    title,
  });
  if (!response.success) return response;
  void badgeController.refreshBadgesForUrls([url]);

  notifyMutation('note', { pageSlug: slug, noteSlug: response.noteSlug });

  // Show highlights panel in the tab's content script
  if (tabId > 0) {
    const pageInfo = await handleGetPageInfo({ slug });
    const notes = pageInfo.success ? pageInfo.notes : [];
    chrome.tabs
      .sendMessage(tabId, {
        action: 'showHighlightsPanel',
        notes,
        pageSlug: slug,
      })
      .catch(() => {});
  }

  return { success: true, noteSlug: response.noteSlug };
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
    const response = await handleContextMenuHighlight(
      activeTab.url,
      activeTab.title,
      info.selectionText.trim(),
      activeTab.id,
    );
    if (response?.success === false) {
      await notifyTabUserActionError(
        activeTab.id,
        response.error,
        tr('extensionHighlightFailed', 'Highlight failed'),
      );
    }
  } catch (error) {
    logDebug('[context-menu] Highlight error:', error.message);
    await notifyTabUserActionError(
      activeTab.id,
      error,
      tr('extensionHighlightFailed', 'Highlight failed'),
    );
  }
});

// ─── Keyboard Shortcuts ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  logDebug(`[background] Command received: ${command}`);

  const recordingState = await getWorkspaceState();
  if (recordingState && recordingState.mode === 'private') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab ||
    isInternalBrowserUrl(tab.url) ||
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
      const capture = await captureAndLog(
        tab.id,
        slug,
        timestamp,
        tab.url,
        tab.title,
      );
      chrome.tabs
        .sendMessage(tab.id, { action: 'hideCaptureSpinner' })
        .catch(() => {});
      const warning = captureWarningMessage(capture.warnings);
      if (warning) {
        await notifyTabUserActionError(tab.id, warning, warning);
      } else {
        chrome.tabs
          .sendMessage(tab.id, { action: 'showCaptureNotification' })
          .catch(() => {});
      }
    } catch (error) {
      logDebug('[capture] ERROR:', error.message, error);
      chrome.tabs
        .sendMessage(tab.id, { action: 'hideCaptureSpinner' })
        .catch(() => {});
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionCaptureFailed', 'Capture failed'),
      );
    }
  } else if (command === 'highlight-selection') {
    try {
      logDebug(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = await chrome.tabs.sendMessage(tab.id, {
        action: 'highlightSelection',
      });
      logDebug('[background] highlightSelection response:', resp);
      if (resp?.success === false) {
        await notifyTabUserActionError(
          tab.id,
          resp.error,
          tr('extensionHighlightFailed', 'Highlight failed'),
        );
      }
    } catch (error) {
      logDebug('[background] Could not highlight selection:', error.message);
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionHighlightFailed', 'Highlight failed'),
      );
    }
  } else if (command === 'like-page' || command === 'dislike-page') {
    const delta = command === 'like-page' ? 1 : -1;
    try {
      const response = await runDesktopCommand('ratePage', {
        url: tab.url,
        likes: delta,
        title: tab.title || '',
      });
      if (!response.success)
        throw new Error(
          response.error || tr('extensionRatePageFailed', 'ratePage failed'),
        );
      notifyMutation('history', { url: tab.url });
      await notifyTabUserActionSuccess(
        tab.id,
        delta >= 0
          ? tr('extensionLiked', 'Liked')
          : tr('extensionDisliked', 'Disliked'),
        'showLikeNotification',
        { delta },
      );
    } catch (error) {
      logDebug(`[${command}] ERROR:`, error.message, error);
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionLikeFailed', 'Like failed'),
      );
    }
  }
});

// ─── Message Handlers: Tab/Popup Queries ─────────────────────────────

function handleGetReportedUrl(request) {
  return { success: true, url: tabReportedUrls.get(request.tabId) || null };
}

async function handleGetPageInfo(request) {
  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          tr(
            'extensionDesktopPageDataUnavailable',
            'Desktop page data unavailable.',
          ),
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
      error:
        error.message ||
        tr(
          'extensionDesktopPageDataUnavailable',
          'Desktop page data unavailable.',
        ),
    };
  }
}

async function handleGetPageSummary(request) {
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
      error:
        error.message ||
        tr(
          'extensionDesktopPageDataUnavailable',
          'Desktop page data unavailable.',
        ),
    };
  }
}

async function handleGetPopupLists() {
  try {
    const desktopResp = await requestDesktopPopupLists();
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          tr('extensionCouldNotLoadLists', 'Could not load lists.'),
      };
    }
    return {
      success: true,
      lists: desktopResp.lists || [],
    };
  } catch (error) {
    return {
      success: false,
      error:
        error.message ||
        tr('extensionCouldNotLoadLists', 'Could not load lists.'),
    };
  }
}

async function handleCaptureCurrentPageFromPopup() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab)
      return {
        success: false,
        error: tr('extensionNoTargetTab', 'No target tab'),
      };
    const slug = generateSlugFromUrl(tab.url);
    const timestamp = await nextLogTimestamp();
    const capture = await captureAndLog(
      tab.id,
      slug,
      timestamp,
      tab.url,
      tab.title,
    );
    return {
      success: true,
      timestamp,
      warning: captureWarningMessage(capture.warnings),
      warnings: capture.warnings,
    };
  } catch (error) {
    logDebug('[capture-popup] ERROR:', error.message, error);
    return { success: false, error: error.message };
  }
}

// ─── Message Handlers: Page Lifecycle ────────────────────────────────

async function handleRecordPageActivity(request, sender) {
  try {
    if (isServicePaused()) {
      return {
        success: false,
        error: tr('extensionBrowserRecallPaused', 'Browser Recall is paused'),
        code: serviceError.code,
      };
    }
    const url = request.url;

    const recordingState = await getWorkspaceState();
    if (recordingState && recordingState.mode === 'private') {
      return { success: true };
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

      const report = await buildVisitReport(
        url,
        request.title || '',
        referrerUrl,
        request.bodyPreview,
        request.bypassBlacklist,
      );
      const response = await enqueueReportCommand('reportVisit', report);

      notifyMutation('history', { url });
      return response;
    } else if (request.isLeaving) {
      const report = await buildLeaveReport(
        url,
        request.title || '',
        request.scrollDepth,
        request.timeOnPage,
      );
      const response = await enqueueReportCommand('reportLeave', report);
      void drainNow();
      return response;
    } else if (request.user_title !== undefined) {
      const renameResp = await runDesktopCommand('renamePage', {
        url,
        userTitle: request.user_title,
      });
      if (!renameResp.success) return renameResp;
    }

    logDebug(
      `Processed page report: ${url} (initial=${!!request.isInitialLoad}, leaving=${!!request.isLeaving})`,
    );
    return { success: true };
  } catch (error) {
    logError('Error processing recordPageActivity:', error);
    return { success: false, error: error.message, code: error.code };
  }
}

// ─── Message Handlers: Cache/Queue ───────────────────────────────────

async function handleClearDesktopQueue() {
  await clearDesktopBuffer();
  return { success: true };
}

async function handleDrainDesktopQueue() {
  const connector = await drainNow();
  await new Promise((r) => setTimeout(r, 50));
  const refreshed = connector || (await getConnectorBridgeState());
  return { success: true, remaining: refreshed.pendingCommands || 0 };
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

async function handleGetPopupAccessState(request) {
  const response = await runDesktopCommand('getPopupAccessState', {
    url: request.url,
  });
  if (!response.success) return response;
  return {
    success: true,
    blacklisted: Boolean(response.blacklisted),
    hasVisitHistory: Boolean(response.hasVisitHistory),
  };
}

function popupBootstrapToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function storePopupBootstrap(bootstrap) {
  // The popup can only receive a URL from chrome.action.openPopup(), not an
  // object payload. Keep the prepared model in memory and pass a one-shot token
  // so normal toolbar opens avoid extension-side persistent product caches.
  const token = popupBootstrapToken();
  pendingPopupBootstraps.set(token, {
    bootstrap,
    expiresAt: Date.now() + POPUP_BOOTSTRAP_TTL_MS,
  });
  setTimeout(() => {
    const entry = pendingPopupBootstraps.get(token);
    if (entry?.expiresAt <= Date.now()) pendingPopupBootstraps.delete(token);
  }, POPUP_BOOTSTRAP_TTL_MS + 1000);
  return token;
}

function consumePopupBootstrapEntry(token, entry) {
  if (token) pendingPopupBootstraps.delete(token);
  if (entry.expiresAt <= Date.now()) {
    return { success: false, error: 'Popup bootstrap expired' };
  }
  clearPreparedActionPopup(entry.bootstrap?.tab?.id);
  return { success: true, bootstrap: entry.bootstrap };
}

async function handleConsumePopupBootstrap(request) {
  const token = typeof request.token === 'string' ? request.token : '';
  const entry = token ? pendingPopupBootstraps.get(token) : null;
  if (entry) return consumePopupBootstrapEntry(token, entry);
  return { success: false, error: 'Popup bootstrap not found' };
}

function clearPreparedActionPopup(tabId) {
  if (!chrome.action?.setPopup) return;
  const clearDetails = [{ popup: '' }];
  if (Number.isFinite(tabId)) clearDetails.push({ tabId, popup: '' });
  for (const details of clearDetails) {
    chrome.action
      .setPopup(details)
      .catch((error) =>
        logDebug('[popup] action popup clear failed:', error.message),
      );
  }
}

async function setPreparedActionPopup(tabId, popupPath) {
  await chrome.action.setPopup({ popup: popupPath });
  if (Number.isFinite(tabId)) {
    await chrome.action.setPopup({ tabId, popup: popupPath });
  }
}

function snapshotViewerSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.href.startsWith(chrome.runtime.getURL('snapshot-viewer.html'))) {
      return parsed.searchParams.get('slug');
    }
  } catch {}
  return null;
}

function popupTabIsUnavailable(tab) {
  return (
    !tab ||
    !tab.url ||
    isInternalBrowserUrl(tab.url) ||
    (tab.url.startsWith('chrome-extension://') &&
      !snapshotViewerSlugFromUrl(tab.url))
  );
}

async function resolvePreparedPopupIdentity(tab) {
  let effectiveUrl = tab.url;
  let effectiveSlug = null;
  let effectiveTitle = tab.title || '<unknown>';

  const reportedUrl = tabReportedUrls.get(tab.id);
  if (reportedUrl && isSameDocumentPageUrl(reportedUrl, tab.url)) {
    effectiveUrl = reportedUrl;
  }

  const viewerSlug = snapshotViewerSlugFromUrl(tab.url);
  if (viewerSlug) {
    const pageInfo = await handleGetPageInfo({ slug: viewerSlug });
    if (pageInfo?.success && pageInfo.entry?.url) {
      effectiveSlug = viewerSlug;
      effectiveUrl = pageInfo.entry.url;
      if (pageInfo.entry.title) effectiveTitle = pageInfo.entry.title;
    }
  } else if (tab.id != null) {
    try {
      const identity = await chrome.tabs.sendMessage(tab.id, {
        action: 'getPageIdentity',
      });
      if (identity?.success && identity.embedded && identity.slug) {
        effectiveSlug = identity.slug;
        if (identity.url) {
          effectiveUrl = identity.url;
        } else {
          const pageInfo = await handleGetPageInfo({ slug: identity.slug });
          if (pageInfo?.success && pageInfo.entry?.url) {
            effectiveUrl = pageInfo.entry.url;
            if (pageInfo.entry.title) effectiveTitle = pageInfo.entry.title;
          }
        }
      }
    } catch {}
  }

  try {
    effectiveTitle = await trimTitle(effectiveTitle, effectiveUrl);
  } catch {}

  return {
    slug: effectiveSlug || generateSlugFromUrl(effectiveUrl),
    url: effectiveUrl,
    title: effectiveTitle,
  };
}

async function preparePopupBootstrapForTab(tab) {
  const connector = await handleGetDesktopConnectorState();
  if (connector?.state !== 'connected' || !connector?.deviceId) {
    return { mode: 'setup', connector };
  }

  if (popupTabIsUnavailable(tab)) {
    return {
      mode: 'unavailable',
      connector,
      message: tr('extensionNotAvailablePage', 'Not available for this page'),
    };
  }

  const identity = await resolvePreparedPopupIdentity(tab);
  const preparedTab = {
    id: tab.id,
    url: tab.url,
    title: tab.title || '',
    _effectiveSlug: identity.slug,
    _effectiveUrl: identity.url,
    _effectiveTitle: identity.title,
  };

  const workspace = await getWorkspaceState();
  if (workspace?.mode === 'private') {
    return { mode: 'private', connector, tab: preparedTab, identity };
  }

  const access = await handleGetPopupAccessState({ url: identity.url });
  if (access?.success === false) {
    return {
      mode: 'data-unavailable',
      connector,
      tab: preparedTab,
      identity,
      error:
        access.error ||
        tr(
          'extensionDesktopPopupAccessFailed',
          'Desktop popup access check failed',
        ),
      diagnostic: {
        reason: 'popup-access-check-failed',
        access,
        connector,
        url: identity.url,
      },
    };
  }
  if (access?.blacklisted && !access?.hasVisitHistory) {
    return { mode: 'blacklisted', connector, tab: preparedTab, identity };
  }

  const summary = await handleGetPageSummary({ url: identity.url });
  if (!summary?.success) {
    return {
      mode: 'data-unavailable',
      connector,
      tab: preparedTab,
      identity,
      error:
        summary?.error ||
        tr(
          'extensionDesktopPageDataUnavailable',
          'Desktop page data unavailable.',
        ),
      diagnostic: {
        reason: 'popup-page-summary-failed',
        summary,
        connector,
        url: identity.url,
      },
    };
  }

  return {
    mode: 'dashboard',
    connector,
    tab: preparedTab,
    identity,
    summary,
  };
}

function timeoutPopupBootstrap(tab) {
  const url = tab?.url || '';
  const title = tab?.title || '<unknown>';
  const identity = url
    ? { slug: generateSlugFromUrl(url), url, title }
    : { slug: '', url: '', title };
  return {
    mode: tab?.url ? 'data-unavailable' : 'unavailable',
    tab: tab
      ? {
          id: tab.id,
          url: tab.url,
          title: tab.title || '',
          _effectiveSlug: identity.slug,
          _effectiveUrl: identity.url,
          _effectiveTitle: identity.title,
        }
      : null,
    identity,
    error: tr('extensionPopupDataTimedOut', 'Popup data timed out. Try again.'),
    diagnostic: {
      reason: 'popup-prepare-timeout',
      timeoutMs: POPUP_PREPARE_TIMEOUT_MS,
      url,
    },
  };
}

async function preparePopupBootstrapWithTimeout(tab) {
  let timer;
  try {
    return await Promise.race([
      preparePopupBootstrapForTab(tab),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(timeoutPopupBootstrap(tab)),
          POPUP_PREPARE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function preparePopupOpenPayload(tab) {
  const bootstrap = await preparePopupBootstrapWithTimeout(tab);
  const token = storePopupBootstrap(bootstrap);
  return {
    bootstrap,
    popupPath: `popup.html?bootstrap=${encodeURIComponent(token)}`,
  };
}

async function openPreparedActionPopup(tab) {
  const { popupPath } = await preparePopupOpenPayload(tab);
  if (!chrome.action?.setPopup || !chrome.action?.openPopup) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(popupPath) });
    return;
  }
  const tabId = Number.isFinite(tab?.id) ? tab.id : undefined;
  try {
    await setPreparedActionPopup(tabId, popupPath);
    await chrome.action.openPopup();
  } catch (error) {
    logDebug('[popup] action openPopup failed:', error.message);
    clearPreparedActionPopup(tabId);
    await chrome.tabs.create({ url: chrome.runtime.getURL(popupPath) });
  } finally {
    // Some engines resolve/callback openPopup before the popup document has
    // consumed its token. Prefer cleanup in handleConsumePopupBootstrap(); this
    // fallback only prevents a stale mapping if the popup never opens.
    setTimeout(() => {
      clearPreparedActionPopup(tabId);
    }, POPUP_ACTION_MAPPING_FALLBACK_CLEAR_MS);
  }
}

if (chrome.action?.onClicked?.addListener) {
  chrome.action.onClicked.addListener((tab) => {
    void openPreparedActionPopup(tab).catch((error) => {
      logDebug('[popup] action click failed:', error.message);
    });
  });
}

globalThis.browserRecallPreparedPopupForTest = {
  async prepare(request = {}) {
    const tab = Number.isFinite(request.tabId)
      ? await chrome.tabs.get(request.tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const { bootstrap, popupPath } = await preparePopupOpenPayload(tab);
    return { success: true, mode: bootstrap.mode, popupPath };
  },
  async reset() {
    pendingPopupBootstraps.clear();
    clearPreparedActionPopup();
  },
};

// ─── Message Handlers: Entity Reads ──────────────────────────────────

async function handleLoadPageNotes(request) {
  const t0 = performance.now();
  let notes;
  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          tr(
            'extensionDesktopPageDataUnavailable',
            'Desktop page data unavailable.',
          ),
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
  let snapshots;
  try {
    const desktopResp = await requestDesktopPageInfo(request.slug);
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          tr(
            'extensionDesktopPageDataUnavailable',
            'Desktop page data unavailable.',
          ),
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

async function requestSnapshotHtml(request, fallbackError) {
  try {
    const desktopResp = await requestDesktopSnapshotHtml(
      request.slug,
      request.timestamp,
    );
    if (!desktopResp?.success || !desktopResp?.html) {
      return {
        success: false,
        error: desktopResp?.error || fallbackError,
      };
    }
    return { success: true, html: desktopResp.html };
  } catch (error) {
    return {
      success: false,
      error: error.message || fallbackError,
    };
  }
}

async function handleGetSnapshotUrl(request) {
  const response = await requestSnapshotHtml(
    request,
    'Desktop snapshot url failed',
  );
  if (!response.success) return response;
  return {
    success: true,
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(response.html),
  };
}

function handleGetSnapshotHtml(request) {
  return requestSnapshotHtml(request, 'Desktop snapshot html failed');
}

async function handleOpenSnapshot(request) {
  const viewerUrl = chrome.runtime.getURL(
    `snapshot-viewer.html?slug=${encodeURIComponent(request.slug)}&ts=${request.timestamp}`,
  );
  const tab = await chrome.tabs.create({ url: viewerUrl });
  return { success: true, tabId: tab.id };
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
  const response = await runDesktopCommand('saveSettingsKey', {
    key: request.key,
    value: request.value,
  });
  if (!response.success) return response;
  notifyMutation('settings', { key: request.key });
  if (request.key === 'colorScheme') {
    await chrome.storage.session.set({ colorScheme: request.value });
  }
  return { success: true };
}

// ─── Message Handlers: Note Mutations ────────────────────────────────

async function handleCreateNote(request, sender) {
  const response = await runDesktopCommand('createNote', {
    ...request,
    url: request.url || sender?.tab?.url,
  });
  if (!response.success) return response;
  if (request.url || sender?.tab?.url) {
    void badgeController.refreshBadgesForUrls([request.url || sender.tab.url]);
  }
  notifyMutation('note', {
    pageSlug: response.pageSlug || request.pageSlug,
    noteSlug: response.noteSlug,
  });
  return response;
}

async function handleDeleteNote(request) {
  const response = await runDesktopCommand('deleteNote', request);
  if (!response.success) return response;
  if (response.url) {
    void badgeController.refreshBadgesForUrls([response.url]);
  } else {
    void badgeController.refreshActiveTabBadge();
  }
  notifyMutation('note', {
    noteSlug: response.noteSlug || request.noteSlug,
    pageSlug: response.pageSlug,
    url: response.url,
  });
  notifyMutation('orphaned');
  return response;
}

async function handleUpdateNote(request) {
  const response = await runDesktopCommand('updateNote', request);
  if (!response.success) return response;
  notifyMutation('note', {
    noteSlug: response.noteSlug || request.noteSlug,
    oldNoteSlug: response.oldNoteSlug,
  });
  return response;
}

// ─── Message Handlers: List Mutations ────────────────────────────────

async function handleToggleListPin(request) {
  const response = await runDesktopCommand('toggleListPin', request);
  if (!response.success) return response;
  if (request.url) void badgeController.refreshBadgesForUrls([request.url]);
  notifyMutation('pins', { listId: request.listId, url: request.url });
  return response;
}

async function handleAddListPins(request) {
  const response = await runDesktopCommand('addListPins', request);
  if (!response.success) return response;
  if (Array.isArray(request.urls) && request.urls.length > 0) {
    void badgeController.refreshBadgesForUrls(request.urls);
  }
  notifyMutation('pins', { listId: request.listId });
  return response;
}

async function handleSaveListMeta(request) {
  const response = await runDesktopCommand('saveListMeta', request);
  if (!response.success) return response;
  notifyMutation('lists');
  return response;
}

async function handleDeleteList(request) {
  const response = await runDesktopCommand('deleteList', request);
  if (!response.success) return response;
  if (Array.isArray(response.urls) && response.urls.length > 0) {
    void badgeController.refreshBadgesForUrls(response.urls);
  } else {
    void badgeController.refreshActiveTabBadge();
  }
  notifyMutation('lists', {
    listId: response.listId || request.listId,
    urls: response.urls,
  });
  notifyMutation('orphaned');
  return response;
}

async function handleUpdateListTree(request) {
  const response = await runDesktopCommand('updateListTree', request);
  if (!response.success) return response;
  notifyMutation('lists');
  return response;
}

// ─── Message Handlers: Filesystem ────────────────────────────────────

async function handleInitializeFilesystem(request) {
  const connector = await refreshConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (connector.state !== 'connected') {
    return {
      success: false,
      error: tr(
        'extensionDesktopNotConnectedRefresh',
        'Browser Recall Desktop is not connected yet. Start the desktop app and refresh from the popup.',
      ),
    };
  }
  if (connector.deviceId) localDeviceId = connector.deviceId;
  await ensureDefaultLists();
  return { success: true };
}

async function handleDeleteSnapshot(request) {
  const pageInfo = request.slug
    ? await handleGetPageInfo({ slug: request.slug }).catch(() => null)
    : null;
  const response = await runDesktopCommand('deleteSnapshot', request);
  if (!response.success) return response;
  if (pageInfo?.entry?.url) {
    void badgeController.refreshBadgesForUrls([pageInfo.entry.url]);
  } else {
    void badgeController.refreshActiveTabBadge();
  }
  notifyMutation('snapshot', { slug: request.slug });
  notifyMutation('orphaned');
  return response;
}

async function handleResumeService() {
  resumeService();
  scheduleDrainNotify();
  return { success: true };
}

async function resetEphemeralConnectorStateForTest() {
  localDeviceId = null;
  tabReportedUrls.clear();
  serviceError = null;
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  resumeService();
}

globalThis.browserRecallBackgroundTestControl = {
  clearDesktopBuffer,
  ensureDefaultLists,
  flushDesktopBuffer,
  getConnectorBridgeState,
  resetEphemeralConnectorState: resetEphemeralConnectorStateForTest,
  setLocalDeviceIdForTest(deviceId) {
    localDeviceId = deviceId || null;
  },
};

function handleRuntimeMutation(request) {
  const urls = new Set();
  if (typeof request.url === 'string' && request.url) urls.add(request.url);
  if (Array.isArray(request.urls)) {
    for (const url of request.urls) {
      if (typeof url === 'string' && url) urls.add(url);
    }
  }
  if (urls.size > 0) {
    void badgeController.refreshBadgesForUrls([...urls]);
  } else {
    void badgeController.refreshActiveTabBadge();
  }
  return { success: true };
}

async function handleSetRecordingPaused(request) {
  const paused = request.paused === true;
  await chrome.storage.session.set({
    workspace: {
      mode: paused ? 'private' : 'default',
    },
  });
  await badgeController.setRecordingPaused(paused);
  return { success: true };
}

// ─── Message Dispatch ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, rawSendResponse) => {
  // Skip Save Page WE messages (they use `type` field, handled by separate listener)
  if (request.type && !request.action) return false;
  if (globalThis.browserRecallBackgroundTestActions?.has(request.action)) {
    return false;
  }

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
        case 'setRecordingPaused':
          sendResponse(await handleSetRecordingPaused(request));
          break;
        // Page lifecycle
        case 'recordPageActivity':
          sendResponse(await handleRecordPageActivity(request, sender));
          break;
        // Cache/queue
        case 'clearDesktopQueue':
          sendResponse(await handleClearDesktopQueue());
          break;
        case 'flushDesktopQueue':
          sendResponse(await handleDrainDesktopQueue());
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
        case 'getPopupAccessState':
          sendResponse(await handleGetPopupAccessState(request));
          break;
        case 'consumePopupBootstrap':
          sendResponse(await handleConsumePopupBootstrap(request));
          break;
        case 'mutation':
          sendResponse(handleRuntimeMutation(request));
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
        // Filesystem
        case 'initializeFilesystem':
          sendResponse(await handleInitializeFilesystem(request));
          break;
        case 'deleteSnapshot':
          sendResponse(await handleDeleteSnapshot(request));
          break;
        case 'resumeService':
          sendResponse(await handleResumeService());
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
