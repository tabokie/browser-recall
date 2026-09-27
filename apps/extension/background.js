// Background service worker for Browser Recall.
// Central authority for extension reads and mutations. Persistent data and
// replay are owned by the desktop daemon.
import './browser-build-target.js';
import './browser-api.js';
import { requirePrivilegedBrowserApis } from './browser-privileged-api.js';
import {
  generateSlugFromUrl,
  isInternalBrowserUrl,
  isSameDocumentPageUrl,
} from './utils.js';
import { initSavepageBridge, captureSavePage } from './savepage-bridge.js';
import { SCHEME_HEX } from './color-scheme-map.js';
import { logDebug, logError } from './logger.js';
import {
  acceptPopupNoteSession,
  mutatePopupNoteSession,
} from './popup-note-session.js';
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
  requestDesktopPageInfo,
  requestDesktopPageSummary,
  requestDesktopSettings,
  requestDesktopSnapshotCaptureBudget,
  requestDesktopCommand,
  requestDesktopSnapshotHtml,
  connectDesktopBridge,
} from './connector/ws-client.js';
import {
  NOTE_PREFIX,
  SNAPSHOT_PREFIX,
  LIST_PREFIX,
  pageKey,
} from './entity-types.js';
import {
  prepareSnapshotHtml,
  validateSnapshotIdentity,
} from '../../packages/core/snapshot-html.js';

logDebug('Background script loading...');

requirePrivilegedBrowserApis([
  'action',
  'commands',
  'contextMenus',
  'runtime',
  'storage',
  'tabs',
]);

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

const CONNECTOR_STATE_REFRESH_TIMEOUT_MS = 1000;
const POPUP_PREPARE_TIMEOUT_MS = 1500;
const POPUP_BOOTSTRAP_TTL_MS = 30_000;
const POPUP_ACTION_MAPPING_FALLBACK_CLEAR_MS = 5000;
const POPUP_IDENTITY_NAVIGATION_RETRIES = 2;
const BROWSER_CAPABILITIES = getBrowserCapabilities();

let lastLogTimestamp = 0;
const pendingPopupBootstraps = new Map();
let popupBootstrapMutationRevision = 0;
let preparedActionPopupUpdateTail = Promise.resolve();
let preparedActionPopupGlobalOwner = null;
const preparedActionPopupTabOwners = new Map();
let popupPreparationGateForTest = null;

function createPopupPreparationGateForTest(holdPreparation) {
  if (holdPreparation !== true) return null;
  if (popupPreparationGateForTest) {
    throw new Error('Popup preparation test gate is already active');
  }
  let release;
  const preparationGate = new Promise((resolve) => {
    release = resolve;
  });
  popupPreparationGateForTest = { release };
  return preparationGate;
}

// tabId → URL from the content script's initial recordPageActivity.
// Used by popup to avoid slug mismatch when tab.url drifts (SPA pushState, etc.).
const tabReportedUrls = new Map();
const pendingNavigations = new Map();

function requireNavigationDelivery(tabId, url) {
  const pending = pendingNavigations.get(tabId);
  if (pending?.url === url && pending.error) {
    throw Object.assign(
      new Error(
        `Page navigation capture is delayed; retrying automatically. ${pending.error}`,
      ),
      { code: 'navigation-delivery-failed' },
    );
  }
}

async function badgeIdentityUrlForTab(tabId, url) {
  requireNavigationDelivery(tabId, url);
  if (snapshotViewerSlugFromUrl(url)) {
    const tab = await chrome.tabs.get(tabId);
    return (await resolveTabPageIdentity(tab)).url;
  }
  const reportedUrl = tabReportedUrls.get(tabId);
  if (reportedUrl && isSameDocumentPageUrl(reportedUrl, url)) {
    return reportedUrl;
  }
  return url;
}

// Worker-local platform error state.
let localFailure = null;

// ─── Service Downtime State ───────────────────────────────────────────

function setLocalFailure(code, message) {
  localFailure = { code, message, timestamp: Date.now() };
  badgeController
    .setServicePaused({ title: message })
    .catch((error) => logDebug('[badge] service pause failed:', error.message));
  logError(`Service paused: [${code}] ${message}`);
}

function clearLocalFailure() {
  localFailure = null;
  badgeController
    .setServiceActive()
    .catch((error) =>
      logDebug('[badge] service resume failed:', error.message),
    );
  logDebug('Service resumed');
}

function hasLocalFailure() {
  return localFailure !== null;
}

async function getWorkspaceState() {
  const { workspace } = await chrome.storage.session.get(['workspace']);
  if (workspace === undefined) return null;
  if (
    !workspace ||
    typeof workspace !== 'object' ||
    Array.isArray(workspace) ||
    (workspace.mode !== 'default' && workspace.mode !== 'private')
  ) {
    throw new Error('Stored recording state must have mode default or private');
  }
  return workspace;
}

// Session storage is in-memory IPC, survives SW termination, and is cleared on
// browser restart. Chromium requires an explicit content-script access grant;
// Firefox exposes extension session storage without this Chromium-only API.
if (getBrowserCapabilities().supportsSessionAccessLevel) {
  chrome.storage.session
    .setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    })
    .catch((error) => {
      logError('[background] Could not expose session storage:', error);
      setLocalFailure('session_access_failed', error.message);
    });
}

const badgeController = createBadgeController({
  logDebug,
  normalIconPaths: DEFAULT_ICON_PATHS,
  stoppedRecordingIconPaths: STOP_RECORDING_ICON_PATHS,
  specialListIconPaths: SPECIAL_LIST_ICON_PATHS,
  specialNoteIconPaths: SPECIAL_NOTE_ICON_PATHS,
  specialMixedIconPaths: SPECIAL_MIXED_ICON_PATHS,
  readPageMarkers: async (url) => {
    const summary = await handleGetPageSummary({ url });
    if (!summary.success || !summary.page) return null;
    return {
      hasNotes: summary.notes.length > 0 || summary.snapshots.length > 0,
      hasLists: summary.lists.some((list) => list.containsPage),
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
  const connector = await refreshDesktopConnectorStateProbe();
  badgeController.scheduleConnectorBadgeRefresh(connector);
  return { success: true, ...connector };
}

async function refreshDesktopConnectorStateProbe() {
  return refreshConnectorBridgeState(CONNECTOR_STATE_REFRESH_TIMEOUT_MS);
}

async function handleConnectDesktopBridge() {
  const connector = await connectDesktopBridge();
  badgeController.scheduleConnectorBadgeRefresh(connector);
  return { success: true, ...connector };
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
  await enqueueDesktopCommand(action, request);
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

async function mirrorSnapshotToDesktop(snapshot) {
  try {
    await enqueueDesktopSnapshot(snapshot);
    return true;
  } catch (error) {
    logDebug('[desktop] snapshot mirror failed:', error.message);
    throw error;
  }
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

async function flushInteractiveWrites() {
  return flushDesktopBuffer();
}

subscribeConnectorBridgeState((connector) => {
  badgeController.scheduleConnectorBadgeRefresh(connector);
});

subscribeDaemonMutations((mutation) => {
  popupBootstrapMutationRevision += 1;
  handleRuntimeMutation(mutation);
});

async function applyCachedConnectorBadge(reason) {
  const connector = await getConnectorBridgeState();
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
  if (hasLocalFailure()) {
    throw new Error(`Service paused [${localFailure.code}]`);
  }
  observeLogTimestamp(request.timestamp);
  await enqueueCommand(action, request);
  if (flush) {
    const connector = await flushInteractiveWrites();
    if (connector?.pendingCommands !== 0) {
      throw new Error('Desktop command queue did not drain');
    }
  }
  return { success: true };
}

async function buildVisitReport(
  url,
  title,
  referrerUrl,
  bodyPreview,
  bypassBlacklist,
) {
  return {
    timestamp: await nextLogTimestamp(),
    url,
    title: title || null,
    referrer: referrerUrl || null,
    bodyPreview: bodyPreview || null,
    bypassBlacklist: bypassBlacklist === true,
  };
}

async function buildLeaveReport(url, title, scrollDepth, timeOnPage) {
  return {
    timestamp: await nextLogTimestamp(),
    url,
    title: title || null,
    scrollDepth: scrollDepth ?? null,
    timeOnPage: timeOnPage ?? null,
  };
}

// ─── Settings Keys ───────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    badgeController.updateBadgeForTab(tabId, tab.url);
  } catch (e) {
    logDebug('[badge] activated tab became unavailable:', e.message);
  }
});

chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && snapshotViewerSlugFromUrl(tab?.url)) {
    void (async () => {
      const connector = await refreshDesktopConnectorStateProbe();
      await badgeController.setConnectorState(connector);
      await badgeController.updateBadgeForTab(tabId, tab.url);
    })().catch((error) => {
      logDebug('[badge] snapshot viewer refresh failed:', error.message);
    });
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
    pendingNavigations.delete(details.tabId);
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
  pendingNavigations.delete(tabId);
});

async function forwardSameDocumentNavigation(details) {
  const pending = { ...details, error: null };
  pendingNavigations.set(details.tabId, pending);
  // Keep the latest unresolved observation recoverable after the quick retries.
  // These browser API calls also keep the worker alive while delivery is pending.
  for (let attempt = 0; ; attempt += 1) {
    const delay = [0, 100, 500][attempt] ?? 5000;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (pendingNavigations.get(details.tabId) !== pending) return;
    try {
      const tab = await chrome.tabs.get(details.tabId);
      if (pendingNavigations.get(details.tabId) !== pending) return;
      if (tab.url !== details.url) {
        pendingNavigations.delete(details.tabId);
        await badgeController.updateBadgeForTab(details.tabId, tab.url);
        return;
      }
      const response = await chrome.tabs.sendMessage(
        details.tabId,
        {
          action: 'sameDocumentNavigation',
          url: details.url,
        },
        { frameId: 0 },
      );
      if (response?.success !== true) {
        throw new Error(
          response?.error || 'Navigation receiver did not acknowledge delivery',
        );
      }
      if (pendingNavigations.get(details.tabId) !== pending) return;
      pendingNavigations.delete(details.tabId);
      await badgeController.updateBadgeForTab(details.tabId, details.url);
      return;
    } catch (error) {
      if (pendingNavigations.get(details.tabId) !== pending) return;
      if (attempt >= 2) {
        pending.error = error.message;
        if (attempt === 2) {
          logError(
            '[navigation] history update delivery delayed; continuing retries:',
            error,
          );
        }
        await badgeController.updateBadgeForTab(details.tabId, details.url);
      } else {
        logDebug(
          '[navigation] retrying history update delivery:',
          error.message,
        );
      }
    }
  }
}

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void forwardSameDocumentNavigation(details).catch((error) => {
    logError('[navigation] history update forwarding failed:', error);
  });
});

// ─── Initialization ───────────────────────────────────────────────────

function callContextMenuMethod(methodName, ...args) {
  const method = chrome.contextMenus[methodName].bind(chrome.contextMenus);
  // Firefox exposes context-menu promises; Chromium-compatible engines may
  // report callback-only failures through runtime.lastError.
  if (globalThis.browserRecallWebExtension?.buildTarget === 'firefox') {
    return Promise.resolve(method(...args));
  }
  return new Promise((resolve, reject) => {
    try {
      method(...args, () => {
        const error = chrome.runtime.lastError;
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
    id: 'browser-recall-highlight',
    title: tr('extensionHighlightSelected', 'Highlight Selected'),
    contexts: ['selection'],
  };
  await callContextMenuMethod('removeAll');
  await callContextMenuMethod('create', item);
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
    // Also check the page capability because Chrome's PDF viewer URL is not a
    // reliable indicator of its embedded native plugin.
    const pdfCheck = await chrome.tabs.sendMessage(tabId, {
      action: 'isPdfPage',
    });
    if (!pdfCheck || typeof pdfCheck.isPdf !== 'boolean') {
      throw new Error('PDF capability response is invalid');
    }
    if (pdfCheck.isPdf) throw new Error(cannotCapturePdfMessage);
    const mdResp = await chrome.tabs.sendMessage(tabId, {
      action: 'extractMarkdown',
    });
    if (
      !mdResp ||
      mdResp.success !== true ||
      typeof mdResp.markdown !== 'string'
    ) {
      throw new Error(
        mdResp?.error || 'Markdown extraction response is invalid',
      );
    }
    const settingsResponse = await requestDesktopSettings();
    if (!settingsResponse?.success) {
      throw new Error(
        settingsResponse?.error || 'Desktop settings unavailable',
      );
    }
    const settings = settingsResponse.settings;
    const captureBudget = await requestDesktopSnapshotCaptureBudget({
      slug,
      ts: timestamp,
      url,
      title,
      markdown: mdResp.markdown,
    });
    const capture = await captureSavePage(tabId, settings, captureBudget);
    if (
      !capture ||
      typeof capture.html !== 'string' ||
      !Array.isArray(capture.warnings)
    ) {
      throw new Error('Snapshot capture returned an invalid payload');
    }
    const html = prepareSnapshotHtml(capture.html, { slug, url });
    const markdown = mdResp.markdown;
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
      html,
    });
    await flushInteractiveWrites();
    return { warnings: capture.warnings };
  } finally {
    stopSpinnerBadge(tabId);
  }
}

function captureWarningMessage(warnings) {
  if (!Array.isArray(warnings)) {
    throw new Error('Snapshot capture warnings must be an array');
  }
  const count = warnings.filter(
    (warning) => warning.intentional !== true,
  ).length;
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

async function getContextMenuSelectionPayload(tabId, menuSelectionText) {
  const menuSelection = String(menuSelectionText || '').trim();
  if (!tabId || tabId <= 0) {
    throw new Error('Cannot capture a highlight without a source tab');
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    action: 'getStructuredSelectionText',
  });
  if (!response || typeof response !== 'object') {
    throw new Error('Page returned no structured selection');
  }
  const structured = String(response.selectionText || '').trim();
  if (!structured) {
    throw new Error('Page returned an empty structured selection');
  }
  if (
    collapseSelectionWhitespace(structured) !==
    collapseSelectionWhitespace(menuSelection)
  ) {
    throw new Error('Page selection changed before the highlight was captured');
  }
  if (
    !Array.isArray(response.selectionExcerpt) ||
    !response.selectionExcerpt.every((part) => typeof part === 'string')
  ) {
    throw new Error('Page selection excerpt must be a string array');
  }
  if (
    !Array.isArray(response.selectionCssPath) ||
    !response.selectionCssPath.every((part) => typeof part === 'string')
  ) {
    throw new Error('Page selection CSS path must be a string array');
  }
  return {
    excerpt: response.selectionExcerpt,
    cssPath: response.selectionCssPath,
  };
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
      .catch((error) =>
        logDebug(
          '[context-menu] highlight panel delivery failed:',
          error.message,
        ),
      );
  }

  return { success: true, noteSlug: response.noteSlug };
}

async function highlightSnapshotSelection(tab, selectionText) {
  const response = await chrome.runtime.sendMessage({
    action: 'highlightSelection',
    targetTabId: tab.id,
    ...(selectionText ? { selectionText } : {}),
  });
  if (!response || typeof response.success !== 'boolean') {
    throw new Error('Snapshot highlight response is incomplete');
  }
  return response;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'browser-recall-highlight') return;
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
    const selectionText = info.selectionText.trim();
    const response = snapshotViewerSlugFromUrl(activeTab.url)
      ? await highlightSnapshotSelection(activeTab, selectionText)
      : await handleContextMenuHighlight(
          activeTab.url,
          activeTab.title,
          selectionText,
          activeTab.id,
        );
    if (response?.success !== true) {
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

chrome.commands.onCommand.addListener(async (command, commandTab) => {
  logDebug(`[background] Command received: ${command}`);

  if (command === 'open-popup') {
    try {
      const tab = Number.isFinite(commandTab?.id)
        ? commandTab
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      await openPreparedActionPopup(tab);
      return { success: true };
    } catch (error) {
      logDebug('[popup] keyboard shortcut failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  const recordingState = await getWorkspaceState();
  if (recordingState && recordingState.mode === 'private') {
    return { success: true, handled: false, reason: 'private_workspace' };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const snapshotSlug = snapshotViewerSlugFromUrl(tab?.url);
  const targetsSnapshotViewer =
    command === 'highlight-selection' && Boolean(snapshotSlug);
  if (
    !tab?.url ||
    isInternalBrowserUrl(tab.url) ||
    (tab.url.startsWith('chrome-extension://') && !targetsSnapshotViewer)
  ) {
    logDebug('[background] Command ignored: no suitable tab');
    return { success: true, handled: false, reason: 'no_suitable_tab' };
  }

  if (command === 'capture-snapshot') {
    chrome.tabs
      .sendMessage(tab.id, { action: 'showCaptureSpinner' })
      .catch((error) =>
        logDebug('[capture] spinner delivery failed:', error.message),
      );
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
        .catch((error) =>
          logDebug('[capture] spinner dismissal failed:', error.message),
        );
      const warning = captureWarningMessage(capture.warnings);
      if (warning) {
        await notifyTabUserActionError(tab.id, warning, warning);
      } else {
        chrome.tabs
          .sendMessage(tab.id, { action: 'showCaptureNotification' })
          .catch((error) =>
            logDebug('[capture] notification delivery failed:', error.message),
          );
      }
      return { success: true };
    } catch (error) {
      logDebug('[capture] ERROR:', error.message, error);
      chrome.tabs
        .sendMessage(tab.id, { action: 'hideCaptureSpinner' })
        .catch((deliveryError) =>
          logDebug(
            '[capture] spinner dismissal after failure failed:',
            deliveryError.message,
          ),
        );
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionCaptureFailed', 'Capture failed'),
      );
      return { success: false, error: error.message };
    }
  } else if (command === 'highlight-selection') {
    try {
      logDebug(`[background] Sending highlightSelection to tab ${tab.id}`);
      const resp = snapshotSlug
        ? await highlightSnapshotSelection(tab)
        : await chrome.tabs.sendMessage(tab.id, {
            action: 'highlightSelection',
          });
      logDebug('[background] highlightSelection response:', resp);
      if (resp?.success !== true) {
        await notifyTabUserActionError(
          tab.id,
          resp.error,
          tr('extensionHighlightFailed', 'Highlight failed'),
        );
        return {
          success: false,
          error: resp?.error || 'Highlight response is incomplete',
        };
      }
      return { success: true };
    } catch (error) {
      logDebug('[background] Could not highlight selection:', error.message);
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionHighlightFailed', 'Highlight failed'),
      );
      return { success: false, error: error.message };
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
      await notifyTabUserActionSuccess(
        tab.id,
        delta >= 0
          ? tr('extensionLiked', 'Liked')
          : tr('extensionDisliked', 'Disliked'),
        'showLikeNotification',
        { delta },
      );
      return { success: true };
    } catch (error) {
      logDebug(`[${command}] ERROR:`, error.message, error);
      await notifyTabUserActionError(
        tab.id,
        error,
        tr('extensionLikeFailed', 'Like failed'),
      );
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: `Unknown browser command: ${command}` };
});

// ─── Message Handlers: Tab/Popup Queries ─────────────────────────────

function handleGetReportedUrl(request) {
  return { success: true, url: tabReportedUrls.get(request.tabId) ?? null };
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
      entry: desktopResp.entry,
      snapshots: desktopResp.snapshots,
      notes: desktopResp.notes,
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
    const desktopResp = await requestDesktopPageSummary(
      request.url,
      request.title,
    );
    if (!desktopResp?.success) {
      return {
        success: false,
        error:
          desktopResp?.error ||
          `Desktop returned ${desktopResp?.type || 'an empty response'} without page summary data`,
      };
    }
    if (
      typeof desktopResp.displayTitle !== 'string' ||
      typeof desktopResp.access?.blacklisted !== 'boolean' ||
      typeof desktopResp.access?.hasVisitHistory !== 'boolean'
    ) {
      return {
        success: false,
        error: 'Desktop returned an incomplete popup summary projection',
      };
    }
    return {
      success: true,
      url: desktopResp.url,
      displayTitle: desktopResp.displayTitle,
      access: desktopResp.access,
      page: desktopResp.page,
      notes: desktopResp.notes,
      snapshots: desktopResp.snapshots,
      lists: desktopResp.lists,
      attention: desktopResp.attention,
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
    if (hasLocalFailure()) {
      return {
        success: false,
        error: tr('extensionBrowserRecallPaused', 'Browser Recall is paused'),
        code: localFailure.code,
      };
    }
    const url = request.url;
    if (
      request.awaitCommit !== undefined &&
      typeof request.awaitCommit !== 'boolean'
    ) {
      throw new Error('recordPageActivity awaitCommit must be a boolean');
    }

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
      const report = await buildVisitReport(
        url,
        request.title || '',
        referrerUrl,
        request.bodyPreview,
        request.bypassBlacklist,
      );
      const response = await enqueueReportCommand('reportVisit', report, {
        flush: request.awaitCommit === true,
      });

      return response;
    } else if (request.isLeaving) {
      const report = await buildLeaveReport(
        url,
        request.title || '',
        request.scrollDepth,
        request.timeOnPage,
      );
      const response = await enqueueReportCommand('reportLeave', report);
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

async function handleDrainDesktopQueue() {
  const connector = await flushDesktopBuffer();
  await new Promise((r) => setTimeout(r, 50));
  const refreshed = connector;
  if (
    !refreshed ||
    !Number.isSafeInteger(refreshed.pendingCommands) ||
    refreshed.pendingCommands < 0
  ) {
    throw new Error(
      'Connector drain returned an invalid pending command count',
    );
  }
  return { success: true, remaining: refreshed.pendingCommands };
}

function popupBootstrapToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function popupBootstrapPath(token, actionTabId = null) {
  const params = new URLSearchParams({ bootstrap: token });
  if (Number.isSafeInteger(actionTabId) && actionTabId > 0) {
    params.set('actionTabId', String(actionTabId));
  }
  return `popup.html?${params.toString()}`;
}

function storePopupBootstrap({
  bootstrap,
  mutationRevision,
  targetTabId,
  preparation = null,
  refreshAfterMutation = true,
}) {
  // The popup can only receive a URL from chrome.action.openPopup(), not an
  // object payload. Keep the prepared model in memory and pass a one-shot token
  // so normal toolbar opens avoid extension-side persistent product caches.
  const token = popupBootstrapToken();
  pendingPopupBootstraps.set(token, {
    bootstrap,
    mutationRevision,
    targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
    refreshAfterMutation,
    lifecycleConnected: false,
    claimed: false,
    preparation:
      preparation === null
        ? null
        : Promise.resolve(preparation).then(
            (preparedBootstrap) => ({
              success: true,
              bootstrap: preparedBootstrap,
            }),
            (error) => ({
              success: false,
              error: error?.message || String(error),
            }),
          ),
    expiresAt: Date.now() + POPUP_BOOTSTRAP_TTL_MS,
  });
  setTimeout(() => {
    const entry = pendingPopupBootstraps.get(token);
    if (entry?.expiresAt <= Date.now()) {
      pendingPopupBootstraps.delete(token);
      void releasePreparedActionPopup(token);
    }
  }, POPUP_BOOTSTRAP_TTL_MS + 1000);
  return token;
}

function deletePopupBootstrap(token, entry) {
  if (pendingPopupBootstraps.get(token) === entry) {
    pendingPopupBootstraps.delete(token);
  }
}

async function resolvePopupBootstrapEntry(entry) {
  let bootstrap = entry.bootstrap;
  while (
    entry.refreshAfterMutation &&
    entry.mutationRevision !== popupBootstrapMutationRevision
  ) {
    const preparationRevision = popupBootstrapMutationRevision;
    let tab = bootstrap?.tab;
    if (Number.isFinite(entry.targetTabId)) {
      try {
        tab = await chrome.tabs.get(entry.targetTabId);
      } catch (error) {
        return {
          success: false,
          error: `Popup bootstrap tab is unavailable: ${error.message}`,
        };
      }
    }
    if (!tab) {
      return { success: false, error: 'Popup bootstrap invalidated' };
    }
    bootstrap = await preparePopupBootstrapWithTimeout(tab);
    entry.bootstrap = bootstrap;
    entry.mutationRevision = preparationRevision;
  }
  return { success: true, bootstrap };
}

async function handleConsumePopupBootstrap(request) {
  const token = typeof request.token === 'string' ? request.token : '';
  const targetTabId =
    Number.isSafeInteger(request.targetTabId) && request.targetTabId > 0
      ? request.targetTabId
      : null;
  await releasePreparedActionPopup(token, targetTabId);
  const entry = token ? pendingPopupBootstraps.get(token) : null;
  if (!entry) return { success: true, missing: true };
  if (entry.expiresAt <= Date.now()) {
    deletePopupBootstrap(token, entry);
    return { success: false, error: 'Popup bootstrap expired' };
  }
  if (entry.claimed) {
    return { success: false, error: 'Popup bootstrap already consumed' };
  }
  entry.claimed = true;
  if (entry.preparation) {
    return { success: true, pending: true, bootstrap: entry.bootstrap };
  }
  try {
    return await resolvePopupBootstrapEntry(entry);
  } finally {
    deletePopupBootstrap(token, entry);
  }
}

async function handleAwaitPopupBootstrap(request) {
  const token = typeof request.token === 'string' ? request.token : '';
  const targetTabId =
    Number.isSafeInteger(request.targetTabId) && request.targetTabId > 0
      ? request.targetTabId
      : null;
  await releasePreparedActionPopup(token, targetTabId);
  const entry = token ? pendingPopupBootstraps.get(token) : null;
  if (!entry) return { success: true, missing: true };
  if (!entry.claimed) {
    return { success: false, error: 'Popup bootstrap has not been consumed' };
  }
  if (!entry.preparation) {
    return { success: false, error: 'Popup bootstrap is not pending' };
  }

  try {
    const outcome = await entry.preparation;
    if (outcome.success !== true) return outcome;
    entry.bootstrap = outcome.bootstrap;
    entry.preparation = null;
    return await resolvePopupBootstrapEntry(entry);
  } finally {
    deletePopupBootstrap(token, entry);
  }
}

function queuePreparedActionPopupUpdate(update) {
  const task = preparedActionPopupUpdateTail.then(update, update);
  preparedActionPopupUpdateTail = task.catch((error) => {
    logDebug('[popup] action popup update failed:', error.message);
  });
  return task;
}

async function applyPreparedActionPopupClears(details) {
  const outcomes = await Promise.allSettled(
    details.map((entry) => chrome.action.setPopup(entry)),
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      logDebug('[popup] action popup clear failed:', outcome.reason?.message);
    }
  }
}

function releasePreparedActionPopup(token, targetTabId = null) {
  if (!token || !chrome.action?.setPopup) return Promise.resolve();
  return queuePreparedActionPopupUpdate(async () => {
    const clearDetails = [];
    if (preparedActionPopupGlobalOwner === token) {
      preparedActionPopupGlobalOwner = null;
      clearDetails.push({ popup: '' });
    }
    if (Number.isFinite(targetTabId)) {
      const owner = preparedActionPopupTabOwners.get(targetTabId);
      if (owner === undefined || owner === token) {
        preparedActionPopupTabOwners.delete(targetTabId);
        clearDetails.push({ tabId: targetTabId, popup: '' });
      }
    }
    for (const [tabId, owner] of preparedActionPopupTabOwners) {
      if (owner !== token) continue;
      preparedActionPopupTabOwners.delete(tabId);
      clearDetails.push({ tabId, popup: '' });
    }
    await applyPreparedActionPopupClears(clearDetails);
  });
}

function resetPreparedActionPopups() {
  if (!chrome.action?.setPopup) return Promise.resolve();
  return queuePreparedActionPopupUpdate(async () => {
    const clearDetails = [
      { popup: '' },
      ...[...preparedActionPopupTabOwners.keys()].map((tabId) => ({
        tabId,
        popup: '',
      })),
    ];
    preparedActionPopupGlobalOwner = null;
    preparedActionPopupTabOwners.clear();
    await applyPreparedActionPopupClears(clearDetails);
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (
    acceptPopupNoteSession(port, {
      save: handleUpdateNote,
      remove: handleDeleteNote,
      enqueue: (request) => enqueueDesktopCommand('updateNote', request),
      async onError(error, tabId) {
        logError('[popup] Note save on close failed:', error);
        await notifyTabUserActionError(tabId, error);
      },
    })
  )
    return;
  const prefix = 'popup-bootstrap:';
  if (typeof port.name !== 'string' || !port.name.startsWith(prefix)) return;
  const [token, encodedTabId = ''] = port.name.slice(prefix.length).split(':');
  const parsedTabId = Number(encodedTabId);
  const targetTabId =
    encodedTabId && Number.isSafeInteger(parsedTabId) && parsedTabId > 0
      ? parsedTabId
      : null;
  void releasePreparedActionPopup(token, targetTabId);
  const entry = pendingPopupBootstraps.get(token);
  if (!entry) return;
  entry.lifecycleConnected = true;
  port.onDisconnect.addListener(() => {
    deletePopupBootstrap(token, entry);
  });
});

function setPreparedActionPopup(token, tabId, popupPath) {
  return queuePreparedActionPopupUpdate(async () => {
    if (Number.isFinite(tabId)) {
      await chrome.action.setPopup({ tabId, popup: popupPath });
      preparedActionPopupTabOwners.set(tabId, token);
      return;
    }
    await chrome.action.setPopup({ popup: popupPath });
    preparedActionPopupGlobalOwner = token;
  });
}

function snapshotViewerSlugFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const viewer = new URL(chrome.runtime.getURL('snapshot-viewer.html'));
  if (parsed.origin === viewer.origin && parsed.pathname === viewer.pathname) {
    return parsed.searchParams.get('slug');
  }
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

async function loadingTabPageIdentity(tab) {
  let pageIdentity = null;
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      injectImmediately: true,
      func: () => ({
        documentUrl: window.location.href,
        embeddedSlug:
          document.querySelector('meta[name="x-browser-recall-slug"]')
            ?.content ?? null,
        embeddedUrl:
          document.querySelector('meta[name="x-browser-recall-url"]')
            ?.content ?? null,
      }),
    });
    pageIdentity = execution?.result ?? null;
  } catch {
    // A loading tab may not have committed an injectable document yet. Its
    // browser-reported URL is still the authoritative identity available now.
  }

  const currentTab = await chrome.tabs.get(tab.id);
  // Document inspection is asynchronous: always validate it against a fresh
  // tab snapshot so a navigation cannot make the popup use stale identity.
  if (currentTab.url !== tab.url || currentTab.status !== tab.status) {
    return { currentTab, identity: null };
  }

  if (pageIdentity?.documentUrl === tab.url && pageIdentity.embeddedSlug) {
    return {
      currentTab,
      identity: {
        success: true,
        embedded: true,
        slug: pageIdentity.embeddedSlug,
        url: pageIdentity.embeddedUrl,
      },
    };
  }
  return {
    currentTab,
    identity: {
      success: true,
      embedded: false,
      slug: generateSlugFromUrl(tab.url),
      url: tab.url,
    },
  };
}

async function fileSnapshotPageIdentity(tab) {
  if (typeof chrome.extension?.isAllowedFileSchemeAccess === 'function') {
    const allowed = await new Promise((resolve, reject) => {
      chrome.extension.isAllowedFileSchemeAccess((isAllowed) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(isAllowed === true);
      });
    });
    if (!allowed) {
      const error = new Error(
        tr(
          'extensionSnapshotFileAccessRequired',
          'Browser Recall needs Chrome\'s "Allow access to file URLs" setting to read this saved snapshot.',
        ),
      );
      error.code = 'snapshot-file-access-required';
      throw error;
    }
  }
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    injectImmediately: true,
    func: () => {
      const slugMetadata = document.querySelectorAll(
        'meta[name="x-browser-recall-slug"]',
      );
      const urlMetadata = document.querySelectorAll(
        'meta[name="x-browser-recall-url"]',
      );
      return {
        documentUrl: window.location.href,
        slugCount: slugMetadata.length,
        urlCount: urlMetadata.length,
        slug: slugMetadata[0]?.content ?? null,
        url: urlMetadata[0]?.content ?? null,
      };
    },
  });
  const inspected = execution?.result;
  const currentTab = await chrome.tabs.get(tab.id);
  if (currentTab.url !== tab.url || inspected?.documentUrl !== tab.url) {
    throw new Error('Snapshot file navigated while identity was resolving');
  }
  if (
    inspected.slugCount !== 1 ||
    inspected.urlCount !== 1 ||
    typeof inspected.slug !== 'string' ||
    !inspected.slug ||
    typeof inspected.url !== 'string' ||
    !inspected.url
  ) {
    throw new Error('Snapshot file does not contain canonical page identity');
  }
  return {
    success: true,
    embedded: true,
    slug: inspected.slug,
    url: inspected.url,
  };
}

async function resolveTabPageIdentity(tab, navigationRetries = 0) {
  requireNavigationDelivery(tab.id, tab.url);
  let effectiveUrl = tab.url;
  let effectiveSlug = null;
  let effectiveTitle = typeof tab.title === 'string' ? tab.title : '';

  const reportedUrl = tabReportedUrls.get(tab.id);
  if (reportedUrl && isSameDocumentPageUrl(reportedUrl, tab.url)) {
    effectiveUrl = reportedUrl;
  }

  const viewerSlug = snapshotViewerSlugFromUrl(tab.url);
  if (viewerSlug) {
    const pageInfo = await handleGetPageInfo({ slug: viewerSlug });
    if (!pageInfo?.success || !pageInfo.entry?.url) {
      throw new Error(
        pageInfo?.error || 'Snapshot viewer page identity is unavailable',
      );
    }
    effectiveSlug = viewerSlug;
    effectiveUrl = pageInfo.entry.url;
    if (pageInfo.entry.title) effectiveTitle = pageInfo.entry.title;
  } else if (tab.id != null) {
    let identity;
    if (tab.url.startsWith('file:')) {
      identity = await fileSnapshotPageIdentity(tab);
    } else if (tab.status === 'loading') {
      const loadingIdentity = await loadingTabPageIdentity(tab);
      if (!loadingIdentity.identity) {
        if (navigationRetries >= POPUP_IDENTITY_NAVIGATION_RETRIES) {
          throw new Error(
            'Page kept navigating while popup identity was resolving',
          );
        }
        return resolveTabPageIdentity(
          loadingIdentity.currentTab,
          navigationRetries + 1,
        );
      }
      identity = loadingIdentity.identity;
      if (typeof loadingIdentity.currentTab.title === 'string') {
        effectiveTitle = loadingIdentity.currentTab.title;
      }
    } else {
      identity = await chrome.tabs.sendMessage(tab.id, {
        action: 'getPageIdentity',
      });
    }
    if (
      identity?.success !== true ||
      typeof identity.embedded !== 'boolean' ||
      typeof identity.slug !== 'string' ||
      !identity.slug ||
      typeof identity.url !== 'string' ||
      !identity.url
    ) {
      throw new Error('Page identity response is invalid');
    }
    if (identity.embedded) {
      effectiveSlug = identity.slug;
      effectiveUrl = identity.url;
      const pageInfo = await handleGetPageInfo({ slug: identity.slug });
      if (!pageInfo?.success || !pageInfo.entry?.url) {
        throw new Error(
          pageInfo?.error || 'Embedded page identity is unavailable',
        );
      }
      if (pageInfo.entry.url !== identity.url) {
        throw new Error('Embedded page identity does not match desktop data');
      }
      if (pageInfo.entry.title) {
        effectiveTitle = pageInfo.entry.title;
      }
    } else {
      const expectedSlug = generateSlugFromUrl(identity.url);
      if (identity.url !== tab.url || identity.slug !== expectedSlug) {
        throw new Error('Page identity does not match the active tab');
      }
      effectiveUrl = identity.url;
      effectiveSlug = identity.slug;
    }
  }

  return {
    slug: effectiveSlug ?? generateSlugFromUrl(effectiveUrl),
    url: effectiveUrl,
    title: effectiveTitle,
  };
}

async function handleResolvePopupPageIdentity(request) {
  if (!Number.isSafeInteger(request.tabId) || request.tabId < 0) {
    throw new Error('resolvePopupPageIdentity requires a valid tabId');
  }
  const tab = await chrome.tabs.get(request.tabId);
  if (popupTabIsUnavailable(tab)) {
    throw new Error('Popup page identity is unavailable for this tab');
  }
  return {
    success: true,
    identity: await resolveTabPageIdentity(tab),
  };
}

async function preparePopupBootstrapForTab(tab) {
  if (popupTabIsUnavailable(tab)) {
    return {
      mode: 'unavailable',
      message: tr('extensionNotAvailablePage', 'Not available for this page'),
    };
  }

  const workspace = await getWorkspaceState();
  if (workspace?.mode === 'private') {
    return { mode: 'private', tab };
  }

  let identity;
  try {
    identity = await resolveTabPageIdentity(tab);
  } catch (error) {
    const identityError = String(
      error?.message || error || 'Popup page identity failed',
    );
    return {
      mode: 'data-unavailable',
      tab,
      error: userActionErrorMessage(error),
      diagnostic: {
        reason: [
          'snapshot-file-access-required',
          'navigation-delivery-failed',
        ].includes(error?.code)
          ? error.code
          : 'popup-page-identity-failed',
        url: tab.url,
        error: identityError,
      },
    };
  }
  const preparedTab = {
    id: tab.id,
    url: tab.url,
    title: tab.title || '',
    _effectiveSlug: identity.slug,
    _effectiveUrl: identity.url,
    _effectiveTitle: identity.title,
  };

  const summary = await handleGetPageSummary({
    url: identity.url,
    title: identity.title,
  });
  const connector = await getConnectorBridgeState();
  if (!summary?.success) {
    if (connector?.state !== 'connected' || !connector?.deviceId) {
      return { mode: 'connector-diagnostic', connector };
    }
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
  identity.title = summary.displayTitle;
  preparedTab._effectiveTitle = identity.title;
  if (summary.access?.blacklisted && !summary.access?.hasVisitHistory) {
    return { mode: 'blacklisted', connector, tab: preparedTab, identity };
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
  const title = typeof tab?.title === 'string' ? tab.title : '';
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
  const mutationRevision = popupBootstrapMutationRevision;
  const bootstrap = await preparePopupBootstrapWithTimeout(tab);
  const token = storePopupBootstrap({
    bootstrap,
    mutationRevision,
    targetTabId: tab?.id,
  });
  return {
    bootstrap,
    popupPath: popupBootstrapPath(token),
  };
}

function initialPopupBootstrap(tab) {
  if (popupTabIsUnavailable(tab)) {
    return {
      mode: 'unavailable',
      message: tr('extensionNotAvailablePage', 'Not available for this page'),
    };
  }
  return {
    mode: 'connector-diagnostic',
    connector: { state: 'starting' },
    tab: {
      id: tab.id,
      url: tab.url,
      title: tab.title || '',
    },
  };
}

function beginPopupOpenPayload(tab, options = {}) {
  const mutationRevision = popupBootstrapMutationRevision;
  const bootstrap = initialPopupBootstrap(tab);
  const preparation =
    bootstrap.mode === 'connector-diagnostic'
      ? Promise.resolve(options.preparationGate).then(() =>
          options.preparedBootstrap
            ? options.preparedBootstrap
            : preparePopupBootstrapWithTimeout(tab),
        )
      : null;
  const token = storePopupBootstrap({
    bootstrap,
    mutationRevision,
    targetTabId: tab?.id,
    preparation,
    refreshAfterMutation: !options.preparedBootstrap,
  });
  return {
    token,
    popupPath: popupBootstrapPath(token, options.actionTabId),
  };
}

async function openPreparedActionPopup(tab, options = {}) {
  const tabId = Number.isFinite(tab?.id) ? tab.id : undefined;
  const { token, popupPath } = beginPopupOpenPayload(tab, {
    ...options,
    actionTabId: tabId,
  });
  if (!chrome.action?.setPopup || !chrome.action?.openPopup) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(popupPath) });
    return { presentation: 'tab' };
  }
  try {
    await setPreparedActionPopup(token, tabId, popupPath);
    await chrome.action.openPopup();
    return { presentation: 'popup' };
  } catch (error) {
    await releasePreparedActionPopup(token);
    // Preserve the one-shot bootstrap when the host rejects its native popup;
    // the same prepared extension page remains valid as a deterministic tab.
    logDebug(
      '[popup] native action popup failed; opening an extension tab:',
      error.message,
    );
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(popupPath) });
      return { presentation: 'tab', actionError: error.message };
    } catch (tabError) {
      throw new AggregateError(
        [error, tabError],
        `Could not open Browser Recall popup: ${error.message}; tab fallback failed: ${tabError.message}`,
      );
    }
  } finally {
    // Some engines resolve/callback openPopup before its document connects the
    // lifecycle port. If that never happens, clear the otherwise stale mapping.
    setTimeout(() => {
      const entry = pendingPopupBootstraps.get(token);
      if (entry && !entry.lifecycleConnected) {
        void releasePreparedActionPopup(token);
      }
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
    return {
      success: true,
      mode: bootstrap.mode,
      error: bootstrap.error ?? null,
      popupPath,
    };
  },
  async open(request = {}) {
    const preparationGate = createPopupPreparationGateForTest(
      request.holdPreparation,
    );
    let preparedBootstrap = null;
    if (request.terminalConnectorState !== undefined) {
      if (request.terminalConnectorState !== 'offline') {
        throw new Error('Unsupported popup terminal connector state');
      }
      preparedBootstrap = {
        mode: 'connector-diagnostic',
        connector: { state: 'offline', hasToken: true },
      };
    }
    const tab = Number.isFinite(request.tabId)
      ? await chrome.tabs.get(request.tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    await openPreparedActionPopup(tab, {
      preparationGate,
      preparedBootstrap,
    });
    return { success: true };
  },
  async releasePreparation() {
    const gate = popupPreparationGateForTest;
    if (!gate) {
      return { success: false, error: 'Popup preparation gate is not active' };
    }
    popupPreparationGateForTest = null;
    gate.release();
    return { success: true };
  },
  async begin(request = {}) {
    const preparationGate = createPopupPreparationGateForTest(
      request.holdPreparation,
    );
    const tab = Number.isFinite(request.tabId)
      ? await chrome.tabs.get(request.tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const { popupPath } = beginPopupOpenPayload(tab, { preparationGate });
    return { success: true, popupPath };
  },
  async reset() {
    popupPreparationGateForTest?.release();
    popupPreparationGateForTest = null;
    pendingPopupBootstraps.clear();
    await resetPreparedActionPopups();
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
    notes = desktopResp.notes;
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
    snapshots = desktopResp.snapshots;
  } catch (error) {
    return { success: false, error: error.message };
  }
  logDebug(
    `[I/O] listSnapshots(${request.slug}): ${snapshots.length} from entity in ${(performance.now() - t0).toFixed(1)}ms`,
  );
  return { success: true, snapshots };
}

async function requestSnapshotHtml(request) {
  try {
    const desktopResp = await requestDesktopSnapshotHtml(
      request.slug,
      request.timestamp,
    );
    if (desktopResp.success !== true) {
      return {
        success: false,
        error: desktopResp.error,
      };
    }
    const identity = validateSnapshotIdentity(desktopResp.html, {
      slug: request.slug,
    });
    if (generateSlugFromUrl(identity.url) !== request.slug) {
      throw new Error(
        'snapshot identity URL does not match the requested page slug',
      );
    }
    return {
      success: true,
      html: prepareSnapshotHtml(desktopResp.html),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

async function handleGetSnapshotUrl(request) {
  const response = await requestSnapshotHtml(request);
  if (!response.success) return response;
  return {
    success: true,
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(response.html),
  };
}

function handleGetSnapshotHtml(request) {
  return requestSnapshotHtml(request);
}

async function handleOpenSnapshot(request) {
  const viewerUrl = chrome.runtime.getURL(
    `snapshot-viewer.html?slug=${encodeURIComponent(request.slug)}&ts=${request.timestamp}`,
  );
  const tab = await chrome.tabs.create({ url: viewerUrl });
  return { success: true, tabId: tab.id };
}

async function handleOpenExtensionFileAccessSettings() {
  const tab = await chrome.tabs.create({
    url: `chrome://extensions/?id=${chrome.runtime.id}`,
  });
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
  if (request.key === 'colorScheme') {
    await chrome.storage.session.set({ colorScheme: request.value });
  }
  return { success: true };
}

// ─── Message Handlers: Note Mutations ────────────────────────────────

async function handleCreateNote(request, sender) {
  const response = await runDesktopCommand('createNote', {
    pageSlug: request.pageSlug ?? null,
    url: request.url ?? sender?.tab?.url ?? null,
    title: request.title ?? null,
    excerpt: request.excerpt,
    note: request.note ?? null,
    cssPath: request.cssPath,
  });
  if (!response.success) return response;
  return response;
}

async function handleDeleteNote(request) {
  if (request.noteEditSessionId) {
    return mutatePopupNoteSession(request.noteEditSessionId, 'deleteNote');
  }
  const response = await runDesktopCommand('deleteNote', {
    noteSlug: request.noteSlug,
  });
  if (!response.success) return response;
  return response;
}

async function handleUpdateNote(request) {
  if (request.noteEditSessionId) {
    return mutatePopupNoteSession(
      request.noteEditSessionId,
      'updateNote',
      request.note,
    );
  }
  const response = await runDesktopCommand('updateNote', {
    noteSlug: request.noteSlug,
    note: request.note,
  });
  if (!response.success) return response;
  return response;
}

// ─── Message Handlers: List Mutations ────────────────────────────────

async function handleToggleListPin(request) {
  const response = await runDesktopCommand('toggleListPin', {
    listId: request.listId,
    url: request.url ?? null,
    title: request.title ?? null,
    id: request.id ?? null,
  });
  if (!response.success) return response;
  return response;
}

async function handleAddListPins(request) {
  const command = {
    listId: request.listId,
    urls: request.urls,
  };
  if (Object.prototype.hasOwnProperty.call(request, 'titles')) {
    command.titles = request.titles;
  }
  const response = await runDesktopCommand('addListPins', command);
  if (!response.success) return response;
  return response;
}

async function handleSaveListMeta(request) {
  const response = await runDesktopCommand('saveListMeta', {
    listId: request.listId ?? null,
    name: request.name ?? null,
    parentPath: request.parentPath ?? null,
  });
  if (!response.success) return response;
  return response;
}

async function handleCreateListAndPin(request) {
  const response = await runDesktopCommand('createListAndPin', {
    name: request.name,
    url: request.url,
    title: request.title ?? null,
  });
  if (!response.success) return response;
  return response;
}

async function handleDeleteList(request) {
  const response = await runDesktopCommand('deleteList', {
    listId: request.listId,
  });
  if (!response.success) return response;
  return response;
}

async function handleUpdateListTree(request) {
  const response = await runDesktopCommand('updateListTree', {
    tree: request.tree,
  });
  if (!response.success) return response;
  return response;
}

async function handleDeleteSnapshot(request) {
  const response = await runDesktopCommand('deleteSnapshot', {
    slug: request.slug,
    timestamp: request.timestamp,
  });
  if (!response.success) return response;
  return response;
}

async function resetEphemeralConnectorStateForTest() {
  tabReportedUrls.clear();
  pendingNavigations.clear();
  clearLocalFailure();
}

globalThis.browserRecallBackgroundTestControl = {
  clearDesktopBuffer,
  flushDesktopBuffer,
  getConnectorBridgeState,
  resetEphemeralConnectorState: resetEphemeralConnectorStateForTest,
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
  if (typeof request.paused !== 'boolean') {
    throw new Error('setRecordingPaused requires a boolean paused value');
  }
  const paused = request.paused;
  await chrome.storage.session.set({
    workspace: {
      mode: paused ? 'private' : 'default',
    },
  });
  popupBootstrapMutationRevision += 1;
  await badgeController.setRecordingPaused(paused);
  return { success: true };
}

// ─── Message Dispatch ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, rawSendResponse) => {
  // Skip Save Page WE messages (they use `type` field, handled by separate listener)
  if (request.type && !request.action) return false;
  // Snapshot viewers receive these targeted extension-page broadcasts. The
  // background must not claim the response channel itself.
  if (
    request.targetTabId != null &&
    [
      'highlightSelection',
      'getHighlightMarkupState',
      'hideHighlightMarkup',
      'showHighlightMarkup',
    ].includes(request.action)
  ) {
    return false;
  }
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
        case 'resolvePopupPageIdentity':
          sendResponse(await handleResolvePopupPageIdentity(request));
          break;
        case 'getPageInfo':
          sendResponse(await handleGetPageInfo(request));
          break;
        case 'getPageSummary':
          sendResponse(await handleGetPageSummary(request));
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
        case 'flushDesktopQueue':
          sendResponse(await handleDrainDesktopQueue());
          break;
        case 'getDesktopConnectorState':
          sendResponse(await handleGetDesktopConnectorState());
          break;
        case 'connectDesktopBridge':
          sendResponse(await handleConnectDesktopBridge());
          break;
        case 'consumePopupBootstrap':
          sendResponse(await handleConsumePopupBootstrap(request));
          break;
        case 'awaitPopupBootstrap':
          sendResponse(await handleAwaitPopupBootstrap(request));
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
        case 'openExtensionFileAccessSettings':
          sendResponse(await handleOpenExtensionFileAccessSettings());
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
        case 'createListAndPin':
          sendResponse(await handleCreateListAndPin(request));
          break;
        case 'deleteList':
          sendResponse(await handleDeleteList(request));
          break;
        case 'updateListTree':
          sendResponse(await handleUpdateListTree(request));
          break;
        // Filesystem
        case 'deleteSnapshot':
          sendResponse(await handleDeleteSnapshot(request));
          break;
        default:
          sendResponse({
            success: false,
            error: `Unknown action: ${request.action}`,
          });
      }
    } catch (error) {
      logError('Error handling message:', error);
      sendResponse({
        success: false,
        error: error.message,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      });
    }
  })();

  if (usePromiseResponse) return responsePromise;
  return true;
});
