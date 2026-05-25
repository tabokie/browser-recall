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
  requestDesktopEntity,
  requestDesktopCommand,
  requestDesktopPopupLists,
  requestDesktopSetDeviceId,
  requestDesktopSnapshotHtml,
  requestDesktopTestReset,
  requestDesktopTestSeed,
  connectDesktopBridge,
} from './connector/ws-client.js';
import {
  NOTE_PREFIX,
  SNAPSHOT_PREFIX,
  LIST_PREFIX,
  pageKey,
} from './entity-types.js';

logDebug('Background script loading...');

const DRAIN_INTERVAL_MS = 5000; // 5 seconds — connector queue is durable until drained
const CONNECTOR_STATE_REFRESH_TIMEOUT_MS = 1000;
const BROWSER_CAPABILITIES = getBrowserCapabilities();

let lastLogTimestamp = 0;

const NORMAL_ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

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
  capabilities: BROWSER_CAPABILITIES,
  logDebug,
  normalIconPaths: NORMAL_ICON_PATHS,
  syncDesktopConnectorPauseState,
  readDesktopValue,
  generateSlugFromUrl,
  pageKey,
  notePrefix: NOTE_PREFIX,
  snapshotPrefix: SNAPSHOT_PREFIX,
  listPrefix: LIST_PREFIX,
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
      'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
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
        'Browser Recall Desktop buffer full — start the desktop app or wait for the queue to drain.',
      );
      return;
    }
    logDebug('[desktop] command enqueue failed:', error.message);
    throw error;
  }
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
  let connector = await getConnectorBridgeState();
  if (
    connector.state !== 'connected' &&
    connector.hasToken &&
    !connector.refuseMode
  ) {
    await connectDesktopBridge().catch((error) => {
      logDebug('[connector] mutation rpc reconnect failed:', error.message);
    });
    connector = await getConnectorBridgeState();
  }
  syncDesktopConnectorPauseState(connector);
  return connector.state === 'connected' && !connector.refuseMode;
}

async function runDesktopCommand(action, request = {}) {
  if (!(await canCallDesktopMutationRpc())) {
    return { success: false, error: 'Desktop bridge unavailable' };
  }
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

async function loadDesktopEntityValue(key, { allowStale = false } = {}) {
  const canRead = allowStale
    ? await canCallDesktopStreamingReadRpc()
    : await canCallDesktopPopupRpc();
  if (!canRead) throw new Error('Desktop bridge unavailable');
  try {
    const desktopResp = await requestDesktopEntity(key);
    if (!desktopResp?.success) {
      throw new Error(desktopResp?.error || `Desktop read failed for ${key}`);
    }
    return {
      hit: true,
      value: desktopResp.entity ?? null,
    };
  } catch (error) {
    logDebug(`[desktop] read entity failed for ${key}:`, error.message);
    throw error;
  }
}

async function loadDesktopHistoryRange(from, to) {
  if (!(await canCallDesktopStreamingReadRpc())) {
    throw new Error('Desktop bridge unavailable');
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

async function readDesktopValueFromDaemon(key) {
  if (key.startsWith('log:')) {
    const dateStr = key.slice('log:'.length);
    const desktop = await loadDesktopHistoryRange(dateStr, dateStr);
    return desktop.entries;
  }
  const desktop = await loadDesktopEntityValue(key, { allowStale: true });
  return desktop.hit ? desktop.value : undefined;
}

async function mirrorSnapshotToDesktop(snapshot) {
  try {
    const stats = await enqueueDesktopSnapshot(snapshot);
    syncDesktopConnectorPauseState(stats);
    return true;
  } catch (error) {
    if (error.code === 'buffer_full') {
      const message =
        'Browser Recall Desktop event queue is full — start the desktop app or wait for the queue to drain.';
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

function userActionErrorMessage(error, fallback = 'Action failed') {
  if (isExtensionRuntimeFailure(error)) {
    return 'Browser Recall extension reloaded. Please reload the page and try again.';
  }
  return String(error?.message || error || fallback);
}

async function injectUserActionErrorNotification(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (displayMessage) => {
      const existing = document.getElementById(
        'browser-recall-user-action-error',
      );
      if (existing) existing.remove();
      const host = document.createElement('div');
      host.id = 'browser-recall-user-action-error';
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
            min-width: 180px;
            max-width: min(360px, calc(100vw - 32px));
            background: #fffaf3;
            color: #b3261e;
            border: 1px solid #d93025;
            border-radius: 2px;
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
      setTimeout(() => host.remove(), 5000);
    },
    args: [message],
  });
}

async function notifyTabUserActionError(
  tabId,
  error,
  fallback = 'Action failed',
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
  const connector = await getConnectorBridgeState();
  if (connector.state !== 'connected') return connector;
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

async function readDesktopValue(key, includeDeleted = false) {
  const value = await readDesktopValueFromDaemon(key);
  if (!includeDeleted && value?.deleted) return null;
  return value;
}

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

chrome.runtime.onInstalled.addListener(async (details = {}) => {
  logDebug('browser-recall extension installed');

  chrome.contextMenus.create({
    id: 'portal-highlight',
    title: 'Highlight Selected',
    contexts: ['selection'],
  });

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
      if (isExtensionRuntimeFailure(e)) throw e;
      // Content script might not be loaded — proceed with capture
    }
    const mdResp = await chrome.tabs.sendMessage(tabId, {
      action: 'extractMarkdown',
    });
    const settings = (await readDesktopValue('manifest:settings')) || {};
    const html = prepareSnapshotHtml(
      await captureSavePage(tabId, settings),
      slug,
      url,
    );
    const markdown = mdResp?.markdown || '';
    if (!markdown && !html) {
      throw new Error('Capture failed: page returned no content');
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
  } finally {
    stopSpinnerBadge(tabId);
  }
}

// ─── Context Menu ─────────────────────────────────────────────────────

async function handleContextMenuHighlight(url, title, selectionText, tabId) {
  const slug = generateSlugFromUrl(url);

  const response = await runDesktopCommand('createNote', {
    pageSlug: slug,
    excerpt: selectionText,
    note: '',
    cssPath: null,
    url,
    title,
  });
  if (!response.success) return response;
  void badgeController.refreshBadgesForUrls([url]);

  notifyMutation('note', { pageSlug: slug, noteSlug: response.noteSlug });

  // Show highlights panel in the tab's content script
  if (tabId > 0) {
    const page = await readDesktopValue(pageKey(slug));
    const noteRefs = (page?.childIds || []).filter((c) =>
      c.startsWith(NOTE_PREFIX),
    );
    const notes = [];
    for (const ref of noteRefs) {
      const note = await readDesktopValue(ref);
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
        'Highlight failed',
      );
    }
  } catch (error) {
    logDebug('[context-menu] Highlight error:', error.message);
    await notifyTabUserActionError(activeTab.id, error, 'Highlight failed');
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
      await notifyTabUserActionError(tab.id, error, 'Capture failed');
    }
  } else if (command === 'highlight-selection') {
    try {
      logDebug(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = await chrome.tabs.sendMessage(tab.id, {
        action: 'highlightSelection',
      });
      logDebug('[background] highlightSelection response:', resp);
      if (resp?.success === false) {
        await notifyTabUserActionError(tab.id, resp.error, 'Highlight failed');
      }
    } catch (error) {
      logDebug('[background] Could not highlight selection:', error.message);
      await notifyTabUserActionError(tab.id, error, 'Highlight failed');
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
        throw new Error(response.error || 'ratePage failed');
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

// ─── Message Handlers: Page Lifecycle ────────────────────────────────

async function handleRecordPageActivity(request, sender) {
  try {
    if (isServicePaused()) {
      return {
        success: false,
        error: 'Service paused',
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

async function handleReadDesktopValue(request) {
  try {
    const value = await readDesktopValue(request.key, request.includeDeleted);
    return { success: true, value };
  } catch (error) {
    return { success: false, error: error.message };
  }
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
  const connector = await getConnectorBridgeState();
  syncDesktopConnectorPauseState(connector);
  if (connector.state !== 'connected') {
    return { success: false, error: 'Browser Recall Desktop is not connected' };
  }
  if (connector.deviceId) localDeviceId = connector.deviceId;
  await ensureDefaultLists();
  return { success: true };
}

async function handleDeleteSnapshot(request) {
  const pageBefore = request.slug
    ? await readDesktopValue(pageKey(request.slug)).catch(() => null)
    : null;
  const response = await runDesktopCommand('deleteSnapshot', request);
  if (!response.success) return response;
  if (pageBefore?.url) {
    void badgeController.refreshBadgesForUrls([pageBefore.url]);
  } else {
    void badgeController.refreshActiveTabBadge();
  }
  notifyMutation('snapshot', { slug: request.slug });
  notifyMutation('orphaned');
  return response;
}

// ─── Message Handlers: Test ──────────────────────────────────────────

async function handleResetForTest() {
  const resetResp = await requestDesktopTestReset();
  if (!resetResp?.success) return resetResp;
  await clearDesktopBuffer();
  localDeviceId = null;
  tabReportedUrls.clear();
  serviceError = null;
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  resumeService();
  return { success: true };
}

async function handleResumeService() {
  resumeService();
  scheduleDrainNotify();
  return { success: true };
}

async function handleFlushDesktopQueueForTest(request) {
  if (!request.keepDesktopQueue) {
    await clearDesktopBuffer();
  }
  localDeviceId = null;
  if (drainNotifyTimer) {
    clearTimeout(drainNotifyTimer);
    drainNotifyTimer = null;
  }
  await flushDesktopBuffer().catch((error) => {
    logDebug('[connector] test queue flush failed:', error.message);
    return null;
  });
  await ensureDefaultLists();
  return { success: true };
}

function seedDeviceId(files) {
  for (const file of files || []) {
    const match = file?.path?.match(/^(?:data\/)?logs\/([^/]+)\//);
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

async function handleGetDesktopQueueForTest() {
  const connector = await getConnectorBridgeState();
  return {
    success: true,
    length: connector.pendingCommands || 0,
    watermark: connector.lastDrainedAt || 0,
  };
}

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
        case 'readDesktopValue':
          sendResponse(await handleReadDesktopValue(request));
          break;
        case 'getPopupAccessState':
          sendResponse(await handleGetPopupAccessState(request));
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
        // Test helpers
        case 'resetForTest':
          sendResponse(await handleResetForTest());
          break;
        case 'resumeService':
          sendResponse(await handleResumeService());
          break;
        case 'flushDesktopQueueForTest':
          sendResponse(await handleFlushDesktopQueueForTest(request));
          break;
        case 'seedTestData':
          sendResponse(await handleSeedTestData(request));
          break;
        case 'getDesktopQueueForTest':
          sendResponse(await handleGetDesktopQueueForTest());
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
