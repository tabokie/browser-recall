// Popup — current-page dashboard
import {
  generateSlugFromUrl,
  escapeHtml,
  isInternalBrowserUrl,
} from './utils.js';
import { formatHighlightExcerpt } from './highlight-format.js';
import { logDebug, logError } from './logger.js';
import { applyTheme } from './theme.js';
import { pageKey } from './entity-types.js';
import { formatDesktopConnectorState } from './connector-diagnostics.js';
import {
  hasConnectorStateStorageChange,
  readCachedConnectorState,
  requestConnectorBridgeConnect,
  requestConnectorState,
} from './connector/state.js';
import {
  applyPaperErrorPopoutStyle,
  paperErrorPopoutCss,
} from './extension-ui-tokens.js';
import {
  initializeExtensionI18n,
  localizeDocument,
  tr,
} from '../../packages/core/i18n.js';

const currentPage = {
  slug: '',
  notes: [],
  entry: null,
  summary: null,
  url: '',
  title: '',
  tab: null,
  generation: 0,
  loadInFlight: null,
  pageSummaryState: 'idle',
};
let frozenChipOrder = null; // Array of list slugs — frozen on first render to keep order stable
let _noteSaveTimeout = null;
let desktopConnectInFlight = false;
const recordingUiState = {
  hydrated: false,
  paused: false,
  pending: false,
};
const popupShellState = {
  surface: 'dashboard',
};
const popupUiMutationState = {
  active: false,
  silentActive: false,
  queued: 0,
  action: null,
};
const boundListSearchCaptureInputs = new WeakSet();
let popupUiMutationQueue = Promise.resolve();
let popupUiMutationActiveIdleResolvers = [];
let focusedAutosaveQueue = Promise.resolve();
let listChipsClickBound = false;

function resetCurrentPageIdentity({ slug, url, title, tab }) {
  Object.assign(
    currentPage,
    { slug, url, title, tab },
    {
      entry: null,
      summary: null,
      notes: [],
    },
  );
}

function nextCurrentPageGeneration() {
  return ++currentPage.generation;
}

// ─── Error UI ────────────────────────────────────────────────────────

function showFatalError(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:999999;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  overlay.innerHTML = `
    <div style="color:#b41e1e;font-size:14px;font-weight:600;">${escapeHtml(tr('extensionStorageUnavailable', 'Storage Unavailable', undefined))}</div>
    <div style="color:#555;font-size:12px;max-width:360px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:6px;padding:4px 12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;">${escapeHtml(tr('extensionReloadExtension', 'Reload Extension', undefined))}</button>
  `;
  document.body.appendChild(overlay);
  overlay
    .querySelector('#fatalReloadBtn')
    .addEventListener('click', () => chrome.runtime.reload());
  revealPopup();
}

let _errorBubbleTimer = null;

function revealPopup() {
  document.documentElement.removeAttribute('data-popup-hidden');
  document.documentElement.style.opacity = '';
}

function setPopupCompact(compact) {
  document.body?.classList.toggle('popup-compact', compact);
}

function renderPopupShell(options = {}) {
  const { reveal = true } = options;
  const loading = document.getElementById('loading');
  const setup = document.getElementById('setup-required');
  const dashboard = document.getElementById('dashboard');
  const content = document.getElementById('dashboardContent');
  const surface = popupShellState.surface;
  const setupVisible = surface === 'setup';
  const dashboardVisible = surface !== 'setup';
  const contentVisible = surface === 'dashboard' || surface === 'diagnostic';
  const compact =
    surface === 'banner' ||
    surface === 'diagnostic' ||
    surface === 'dashboard-loading';

  if (loading) loading.style.display = 'none';
  if (setup) setup.style.display = setupVisible ? 'block' : 'none';
  if (dashboard) dashboard.style.display = dashboardVisible ? 'flex' : 'none';
  if (content) content.style.display = contentVisible ? 'block' : 'none';
  setPopupCompact(compact);
  applyRecordingBarState();
  if (reveal) revealPopup();
}

function setPopupSurface(surface, options = {}) {
  popupShellState.surface = surface;
  renderPopupShell(options);
}

function isPopupUiMutating() {
  return (
    popupUiMutationState.active ||
    popupUiMutationState.silentActive ||
    popupUiMutationState.queued > 0
  );
}

function hasActivePopupUiMutation() {
  return popupUiMutationState.active || popupUiMutationState.silentActive;
}

function isPopupUiVisuallyMutating() {
  return popupUiMutationState.active || popupUiMutationState.queued > 0;
}

function setPopupElementDisabled(element, disabled) {
  if (!element) return;
  if ('disabled' in element) {
    element.disabled = disabled;
  }
  element.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

function setPopupRoleElementDisabled(element, disabled) {
  if (!element) return;
  element.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if (disabled) {
    if (
      !Object.prototype.hasOwnProperty.call(element.dataset, 'prevTabindex')
    ) {
      element.dataset.prevTabindex = element.getAttribute('tabindex') ?? '';
    }
    element.tabIndex = -1;
    return;
  }
  if (Object.prototype.hasOwnProperty.call(element.dataset, 'prevTabindex')) {
    const previous = element.dataset.prevTabindex;
    if (previous === '') element.removeAttribute('tabindex');
    else element.setAttribute('tabindex', previous);
    delete element.dataset.prevTabindex;
  }
}

function setPopupInteractionDisabled(disabled) {
  const doc = globalThis.document;
  if (!doc) return;

  doc
    .querySelectorAll(
      [
        '#captureBtn',
        '#setupRequiredBtn',
        '#setupDesktopConnectBtn',
        '#captureOnceBtn',
        '.section-action',
        '.capture-once-btn',
        '.delete-btn',
        '.note-action-btn',
        '.page-note-add',
        '.page-note-edit-textarea',
        '.highlight-note-edit-textarea',
        '.page-title-input',
        '#listSearchInput',
      ].join(','),
    )
    .forEach((element) => {
      if (element.id === 'recordingToggle') return;
      setPopupElementDisabled(element, disabled);
    });

  doc
    .querySelectorAll(
      '.list-chip, .list-add-btn, .list-picker-option, .page-title',
    )
    .forEach((element) => setPopupRoleElementDisabled(element, disabled));
}

function updatePopupUiMutationState() {
  const pending = isPopupUiMutating();
  document.body?.classList.toggle(
    'popup-ui-mutating',
    isPopupUiVisuallyMutating(),
  );
  setPopupInteractionDisabled(pending);
  applyRecordingBarState();
}

async function runPopupUiMutationNow(action, task) {
  if (popupUiMutationState.active) return false;
  popupUiMutationState.active = true;
  popupUiMutationState.action = action;
  updatePopupUiMutationState();
  try {
    await task();
    return true;
  } finally {
    popupUiMutationState.active = false;
    popupUiMutationState.action = null;
    updatePopupUiMutationState();
    const resolvers = popupUiMutationActiveIdleResolvers;
    popupUiMutationActiveIdleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }
}

function runPopupUiMutation(action, task) {
  if (isPopupUiMutating()) return Promise.resolve(false);
  return runPopupUiMutationNow(action, task);
}

async function runSilentPopupUiMutation(action, task) {
  if (isPopupUiMutating()) return false;
  popupUiMutationState.silentActive = true;
  popupUiMutationState.action = action;
  updatePopupUiMutationState();
  try {
    await task();
    return true;
  } finally {
    popupUiMutationState.silentActive = false;
    popupUiMutationState.action = null;
    updatePopupUiMutationState();
    const resolvers = popupUiMutationActiveIdleResolvers;
    popupUiMutationActiveIdleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }
}

function waitForActivePopupUiMutation() {
  if (!hasActivePopupUiMutation()) return Promise.resolve();
  return new Promise((resolve) => {
    popupUiMutationActiveIdleResolvers.push(resolve);
  });
}

function enqueuePopupUiMutation(action, task) {
  popupUiMutationState.queued++;
  updatePopupUiMutationState();
  const runWhenIdle = async () => {
    while (hasActivePopupUiMutation()) {
      await waitForActivePopupUiMutation();
    }
    return runPopupUiMutationNow(action, async () => {
      await task();
    });
  };
  const queued = popupUiMutationQueue.then(runWhenIdle, runWhenIdle);
  popupUiMutationQueue = queued
    .catch(() => {})
    .finally(() => {
      popupUiMutationState.queued = Math.max(
        0,
        popupUiMutationState.queued - 1,
      );
      updatePopupUiMutationState();
    });
  return queued;
}

function enqueueFocusedAutosave(task) {
  const runWhenCommandIdle = async () => {
    while (hasActivePopupUiMutation()) {
      await waitForActivePopupUiMutation();
    }
    await task();
  };
  const queued = focusedAutosaveQueue.then(
    runWhenCommandIdle,
    runWhenCommandIdle,
  );
  focusedAutosaveQueue = queued.catch(() => {});
  return queued;
}

function hideElement(id) {
  const element = document.getElementById(id);
  if (element) element.style.display = 'none';
}

function renderConnectorDiagnostic(connector = {}, options = {}) {
  const { reveal = true } = options;
  hideElement('blacklisted');
  setPopupSurface('setup', { reveal });
  clearSetupDiagnostic();
  applyDesktopConnectorUi(connector);

  const formatted = formatDesktopConnectorState(connector);
  const title = document.getElementById('setupRequiredTitle');
  if (title) title.textContent = formatted.status;

  const openButton = document.getElementById('setupRequiredBtn');
  if (openButton && !openButton.dataset.bound) {
    openButton.dataset.bound = '1';
    openButton.addEventListener('click', () => {
      openDesktopApp();
    });
  }
}

function renderBannerOnly() {
  setPopupSurface('banner');
}

function renderPageDiagnostic({ title, message, detail = null, actions = [] }) {
  hideElement('blacklisted');
  setPopupSurface('diagnostic');
  resetDashboardSections();
  const section = document.getElementById('pageDiagnosticSection');
  const titleEl = document.getElementById('pageDiagnosticTitle');
  const messageEl = document.getElementById('pageDiagnosticMessage');
  const detailEl = document.getElementById('pageDiagnosticDetail');
  const actionsEl = document.getElementById('pageDiagnosticActions');
  const pageHeader = document.getElementById('pageHeader');
  if (section) section.style.display = '';
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  const detailText = formatSetupDiagnostic(detail);
  if (detailEl) {
    detailEl.textContent = detailText;
    detailEl.style.display = detailText ? 'block' : 'none';
  }
  if (actionsEl) {
    actionsEl.innerHTML = '';
    actionsEl.style.display = actions.length > 0 ? 'flex' : 'none';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = action.id;
      button.className = action.className || 'page-diagnostic-link';
      button.textContent = action.label;
      if (action.onClick) button.addEventListener('click', action.onClick);
      actionsEl.appendChild(button);
    }
  }
  if (pageHeader) pageHeader.style.display = 'none';
}

function showSetupRequired(connector = {}, options = {}) {
  renderConnectorDiagnostic(connector, options);
}

function showUnavailablePage(
  message = tr(
    'extensionNotAvailablePage',
    'Not available for this page',
    undefined,
  ),
) {
  renderPageDiagnostic({ title: message, message: '' });
}

function openDesktopApp(route = 'open') {
  window.open(`browser-recall://${route}`);
  window.close();
}

function showErrorBubble(message, options = {}) {
  const { appendReloadHint = true } = options;
  let displayMessage = message;
  if (globalThis.browserRecallWebExtension?.isRuntimeFailure?.(message)) {
    displayMessage = tr(
      'extensionContextInvalidated',
      'Extension context invalidated. Please refresh the page and try again.',
      undefined,
    );
  } else if (!appendReloadHint) {
    displayMessage =
      message || tr('extensionActionFailed', 'Action failed', undefined);
  } else {
    displayMessage = tr(
      'extensionActionFailedReload',
      `${message} - please reload the extension.`,
      [message],
    );
  }
  let bubble = document.getElementById('errorBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'errorBubble';
    bubble.style.cssText = paperErrorPopoutCss({ includeFade: true });
    applyPaperErrorPopoutStyle(bubble);
    document.body.appendChild(bubble);
  }
  bubble.textContent = displayMessage;
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => {
    bubble.style.opacity = '0';
  }, 4000);
}

function userActionErrorMessage(
  message,
  fallback = tr('extensionActionFailed', 'Action failed', undefined),
) {
  if (globalThis.browserRecallWebExtension?.isRuntimeFailure?.(message)) {
    return tr(
      'extensionConnectionResetActionFailed',
      'Browser Recall action failed because the extension connection was reset. Reload this page and try again.',
      undefined,
    );
  }
  return message || fallback;
}

async function notifyActivePageError(
  message,
  fallback = tr('extensionActionFailed', 'Action failed', undefined),
) {
  return notifyPageError({ message, fallback });
}

async function notifyPageError({
  tabId = null,
  message,
  fallback = tr('extensionActionFailed', 'Action failed', undefined),
}) {
  const displayMessage = userActionErrorMessage(message, fallback);
  try {
    let targetTabId = tabId;
    if (!targetTabId) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      targetTabId = tab?.id;
    }
    if (!targetTabId)
      throw new Error(tr('extensionNoTargetTab', 'No target tab', undefined));
    await chrome.tabs.sendMessage(targetTabId, {
      action: 'showErrorNotification',
      message: displayMessage,
    });
  } catch {
    showErrorBubble(displayMessage, { appendReloadHint: false });
  }
}

function autoResizeTextarea(textarea) {
  textarea.style.height = '0';
  textarea.style.height = textarea.scrollHeight + 'px';
}

function isImeCompositionKeyEvent(event) {
  return event.isComposing || event.keyCode === 229;
}

function isEditableEventTarget(target) {
  const ElementCtor = target?.ownerDocument?.defaultView?.Element;
  if (!ElementCtor || !(target instanceof ElementCtor)) return false;
  if (target.closest('input, textarea, select')) return true;
  return Boolean(
    target.closest('[contenteditable=""], [contenteditable="true"]'),
  );
}

function isPrintableKeyEvent(event) {
  return (
    event.key?.length === 1 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !isImeCompositionKeyEvent(event)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function applyDesktopConnectorUi(connector = {}) {
  const formatted = formatDesktopConnectorState(connector);
  const connectIds = ['setupDesktopConnectBtn'];
  const pending = desktopConnectInFlight || connector.state === 'pair_pending';
  const checking = desktopConnectInFlight;

  const title = document.getElementById('setupRequiredTitle');
  if (title) title.textContent = formatted.status;
  const meta = document.getElementById('setupRequiredMeta');
  if (meta) meta.textContent = formatted.meta;

  for (const id of connectIds) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.disabled = pending;
    element.textContent = pending
      ? tr('extensionWaitingApproval', 'Waiting for Approval', undefined)
      : tr('extensionCheckAgain', 'Check Again', undefined);
    element.classList.toggle('is-checking', checking);
  }
}

function showDesktopConnectorError(message) {
  applyDesktopConnectorUi({ state: 'offline', hasToken: false });
  const title = document.getElementById('setupRequiredTitle');
  if (title)
    title.textContent = tr(
      'extensionDesktopOffline',
      'Desktop Offline',
      undefined,
    );
  const meta = document.getElementById('setupRequiredMeta');
  if (meta)
    meta.textContent =
      message ||
      tr(
        'extensionStartDesktopCapture',
        'Start Browser Recall Desktop to resume live capture.',
        undefined,
      );
}

function showDesktopUnavailable(
  message = tr(
    'extensionDesktopOfflineMixed',
    'Browser Recall Desktop is offline.',
    undefined,
  ),
) {
  const defaultOfflineMessage = tr(
    'extensionDesktopOfflineMixed',
    'Browser Recall Desktop is offline.',
    undefined,
  );
  renderConnectorDiagnostic({ state: 'offline', hasToken: true });
  const title = document.getElementById('setupRequiredTitle');
  if (title) {
    title.textContent =
      message === defaultOfflineMessage
        ? tr('extensionDesktopOffline', 'Desktop Offline', undefined)
        : message;
  }
  const meta = document.getElementById('setupRequiredMeta');
  if (meta)
    meta.textContent = tr(
      'extensionStartDesktopCapture',
      'Start Browser Recall Desktop to resume live capture.',
      undefined,
    );
}

function showDesktopDataUnavailable(
  message = tr(
    'extensionDesktopPageDataUnavailable',
    'Desktop page data unavailable.',
    undefined,
  ),
  diagnostic = null,
) {
  renderPageDiagnostic({
    title: tr(
      'extensionPageDataUnavailable',
      'Page Data Unavailable',
      undefined,
    ),
    message,
    detail: diagnostic,
  });
}

function clearSetupDiagnostic() {
  const el = document.getElementById('setupDiagnostic');
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
}

function renderSetupDiagnostic(diagnostic) {
  const el = document.getElementById('setupDiagnostic');
  if (!el) return;
  const text = formatSetupDiagnostic(diagnostic);
  if (!text) {
    clearSetupDiagnostic();
    return;
  }
  el.textContent = text;
  el.style.display = 'block';
}

function formatSetupDiagnostic(diagnostic) {
  if (!diagnostic) return '';
  const lines = [];
  if (diagnostic.reason) lines.push(`reason: ${diagnostic.reason}`);
  if (diagnostic.url) lines.push(`url: ${diagnostic.url}`);
  if (diagnostic.summary) {
    lines.push(`success: ${diagnostic.summary.success ? 'yes' : 'no'}`);
    lines.push(`hasPage: ${diagnostic.summary.page ? 'yes' : 'no'}`);
    if (diagnostic.summary.error)
      lines.push(`summaryError: ${diagnostic.summary.error}`);
  }
  if (diagnostic.connector) {
    lines.push(`connector: ${diagnostic.connector.state || 'unknown'}`);
    lines.push(`deviceId: ${diagnostic.connector.deviceId || 'none'}`);
    lines.push(`pendingCommands: ${diagnostic.connector.pendingCommands ?? 0}`);
    lines.push(`pendingBytes: ${diagnostic.connector.pendingBytes ?? 0}`);
    if (diagnostic.connector.lastError)
      lines.push(`connectorError: ${diagnostic.connector.lastError}`);
  }
  if (diagnostic.error) lines.push(`error: ${diagnostic.error}`);
  return lines.join('\n');
}

function showSection(id) {
  const section = document.getElementById(id);
  if (section) section.style.display = '';
}

function hideSection(id) {
  const section = document.getElementById(id);
  if (section) section.style.display = 'none';
}

function resetDashboardSections() {
  closeListPicker();
  for (const id of [
    'pageDiagnosticSection',
    'visitsLikesSection',
    'listSection',
    'notesSection',
    'snapshotSection',
  ]) {
    hideSection(id);
    document.getElementById(id)?.classList.remove('is-empty');
  }
  const pageHeader = document.getElementById('pageHeader');
  if (pageHeader) pageHeader.style.display = '';
  const pageDiagnosticDetail = document.getElementById('pageDiagnosticDetail');
  if (pageDiagnosticDetail) {
    pageDiagnosticDetail.style.display = 'none';
    pageDiagnosticDetail.textContent = '';
  }
  const pageDiagnosticActions = document.getElementById(
    'pageDiagnosticActions',
  );
  if (pageDiagnosticActions) {
    pageDiagnosticActions.style.display = 'none';
    pageDiagnosticActions.innerHTML = '';
  }
  const attention = document.getElementById('attentionGrid');
  if (attention) attention.innerHTML = '';
  const listChips = document.getElementById('listChips');
  if (listChips) listChips.innerHTML = '';
  const listCount = document.getElementById('listCount');
  if (listCount) listCount.textContent = '00';
  const pageNote = document.getElementById('pageNoteWrap');
  if (pageNote) pageNote.innerHTML = '';
  const highlights = document.getElementById('highlightList');
  if (highlights) highlights.innerHTML = '';
  const annotationCount = document.getElementById('annotationCount');
  if (annotationCount) annotationCount.textContent = '00';
  const snapshots = document.getElementById('snapshotList');
  if (snapshots) snapshots.innerHTML = '';
  const snapshotCount = document.getElementById('snapshotCount');
  if (snapshotCount) snapshotCount.textContent = '00';
}

function clearPageDiagnosticSection() {
  hideSection('pageDiagnosticSection');
  document
    .getElementById('pageDiagnosticSection')
    ?.classList.remove('is-empty');
  const pageHeader = document.getElementById('pageHeader');
  if (pageHeader) pageHeader.style.display = '';
  const pageDiagnosticDetail = document.getElementById('pageDiagnosticDetail');
  if (pageDiagnosticDetail) {
    pageDiagnosticDetail.style.display = 'none';
    pageDiagnosticDetail.textContent = '';
  }
  const pageDiagnosticActions = document.getElementById(
    'pageDiagnosticActions',
  );
  if (pageDiagnosticActions) {
    pageDiagnosticActions.style.display = 'none';
    pageDiagnosticActions.innerHTML = '';
  }
}

async function refreshDesktopConnectorState() {
  try {
    const connector = await requestConnectorState();
    applyDesktopConnectorUi(connector);
    return connector;
  } catch (error) {
    showDesktopConnectorError(
      error.message ||
        tr(
          'extensionDesktopBridgeUnavailable',
          'Desktop bridge unavailable.',
          undefined,
        ),
    );
    return null;
  }
}

async function getCachedDesktopConnectorState() {
  return readCachedConnectorState();
}

function setupRequiredVisible() {
  return popupShellState.surface === 'setup';
}

async function loadDashboardIfConnected(connector) {
  if (connector?.state !== 'connected' || !connector?.deviceId) return false;
  if (currentPage.loadInFlight) {
    await currentPage.loadInFlight;
    return true;
  }
  currentPage.loadInFlight = loadConnectedDashboard(connector).finally(() => {
    currentPage.loadInFlight = null;
  });
  await currentPage.loadInFlight;
  return true;
}

function refreshDesktopConnectorStateInBackground() {
  void (async () => {
    const connector = await refreshDesktopConnectorState();
    await loadDashboardIfConnected(connector);
  })().catch((error) => {
    logDebug('[popup] background connector refresh failed:', error.message);
  });
}

async function connectDesktopBridge() {
  if (desktopConnectInFlight) return;
  desktopConnectInFlight = true;
  applyDesktopConnectorUi({ state: 'connecting' });
  try {
    const connector = await requestConnectorBridgeConnect();
    applyDesktopConnectorUi(connector);
  } catch (error) {
    showDesktopConnectorError(
      error.message ||
        tr('extensionRefreshFailed', 'Failed to refresh.', undefined),
    );
  } finally {
    desktopConnectInFlight = false;
    const connector = await refreshDesktopConnectorState();
    await loadDashboardIfConnected(connector);
  }
}

// Render snapshots section
function renderSnapshots(snapshots) {
  const container = document.getElementById('snapshotList');
  const count = document.getElementById('snapshotCount');
  const section = document.getElementById('snapshotSection');
  if (count)
    count.textContent = String(snapshots?.length || 0).padStart(2, '0');
  if (!snapshots || snapshots.length === 0) {
    container.innerHTML = '';
    section?.classList.add('is-empty');
    showSection('snapshotSection');
    return;
  }
  section?.classList.remove('is-empty');

  container.innerHTML = snapshots
    .map(
      (snap) => `
    <div class="snapshot-row" role="button" tabindex="0" data-ts="${snap.timestamp}">
      <span class="snapshot-time">${escapeHtml(formatTimestamp(snap.timestamp))}</span>
      <span class="snapshot-badges">
        ${snap.hasMd ? `<span class="badge md" data-ts="${snap.timestamp}">Markdown</span>` : ''}
        ${snap.hasHtml ? `<span class="badge html" data-ts="${snap.timestamp}">HTML</span>` : ''}
        <button class="delete-btn" data-ts="${snap.timestamp}" title="${escapeHtml(tr('extensionDeleteSnapshot', 'Delete snapshot', undefined))}">&times;</button>
      </span>
    </div>
  `,
    )
    .join('');

  // Attach delete handlers
  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void runPopupUiMutation('delete-snapshot', async () => {
        const ts = parseInt(btn.dataset.ts, 10);
        await chrome.runtime.sendMessage({
          action: 'deleteSnapshot',
          slug: currentPage.slug,
          timestamp: ts,
        });
        await refreshCurrentPageSummary();
      }).catch((error) => showErrorBubble(error.message));
    });
  });

  container.querySelectorAll('.snapshot-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const ts = parseInt(row.dataset.ts, 10);
      await chrome.runtime.sendMessage({
        action: 'openSnapshot',
        slug: currentPage.slug,
        timestamp: ts,
      });
    });
  });
  showSection('snapshotSection');
}

// Render attention section (flat fields on history entry)
function renderVisitsAndLikes(entry) {
  const section = document.getElementById('visitsLikesSection');
  const container = document.getElementById('attentionGrid');
  if (!section || !container) return;

  const items = [];

  const visitDates = entry?.visitDates || [];
  if (visitDates.length > 0) {
    const parse = (yyyymmdd) => {
      const y = Math.floor(yyyymmdd / 10000);
      const m = Math.floor((yyyymmdd % 10000) / 100) - 1;
      const d = yyyymmdd % 100;
      return new Date(y, m, d);
    };
    const fmtDate = (d) =>
      d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    const sorted = [...visitDates].sort((a, b) => a - b);
    const first = parse(sorted[0]);
    items.push(
      `<span class="attention-item"><strong>${escapeHtml(tr('extensionFirst', 'First'))}</strong><span class="metric-value">${fmtDate(first)}</span></span>`,
    );
  }

  const likes = entry?.likes || 0;
  if (likes > 0) {
    items.push(
      `<span class="attention-item"><strong>${escapeHtml(tr('extensionLiked', 'Liked', undefined))}</strong><span class="metric-value">${likes}</span></span>`,
    );
  }

  if (items.length > 0) {
    container.innerHTML = items.join('');
    showSection('visitsLikesSection');
  } else {
    hideSection('visitsLikesSection');
  }
}

const ICON_EDIT =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>';
const ICON_DELETE =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

function renderPageNoteWrap(globalNote) {
  const wrap = document.getElementById('pageNoteWrap');
  const noteText = globalNote?.note || '';
  const noteSlug = globalNote?.slug || '';

  if (!noteText && !noteSlug) {
    wrap.innerHTML = `<button class="page-note-add" id="pageNoteAddBtn">${escapeHtml(tr('extensionAddPageNote', '+ Page note'))}</button>`;
    wrap.querySelector('#pageNoteAddBtn').addEventListener('click', () => {
      openPageNoteEditor(wrap, '', '');
    });
  } else {
    wrap.innerHTML = `<div class="page-note-display">
      <span class="note-body">${escapeHtml(noteText)}</span>
      <button class="note-action-btn edit" title="${escapeHtml(tr('extensionEdit', 'Edit', undefined))}">${ICON_EDIT}</button>
    </div>`;
    wrap
      .querySelector('.note-action-btn.edit')
      .addEventListener('click', () => {
        openPageNoteEditor(wrap, noteText, noteSlug);
      });
  }
  wrap.dataset.noteSlug = noteSlug;
}

function openPageNoteEditor(wrap, text, slug) {
  document.getElementById('notesSection')?.classList.remove('is-empty');
  wrap.innerHTML = `<textarea class="page-note-edit-textarea" placeholder="${escapeHtml(tr('extensionAddPageNoteEsc', 'Add a page note... Esc to save.', undefined))}">${escapeHtml(text)}</textarea>`;
  const ta = wrap.querySelector('textarea');
  ta.dataset.noteSlug = slug;
  autoResizeTextarea(ta);
  ta.focus();

  let saveTimeout = null;
  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => savePageNoteWithoutLock(ta), 500);
  });
  ta.addEventListener('blur', () => {
    clearTimeout(saveTimeout);
    savePageNote(ta).then(() => {
      const notes = currentPage.notes;
      const note = notes.find((n) => n.excerpt === null);
      if (note) {
        note.note = ta.value;
        note.slug = ta.dataset.noteSlug;
      } else if (ta.value && ta.dataset.noteSlug) {
        notes.push({
          excerpt: null,
          note: ta.value,
          slug: ta.dataset.noteSlug,
        });
      }
      if (!ta.value) {
        currentPage.notes = currentPage.notes.filter((n) => n.excerpt !== null);
      }
      renderPageNoteWrap(currentPage.notes.find((n) => n.excerpt === null));
    });
  });
}

async function sendPageNoteSave(ta) {
  const note = ta.value;
  const noteSlug = ta.dataset.noteSlug;
  if (noteSlug) {
    const resp = await chrome.runtime.sendMessage({
      action: 'updateNote',
      noteSlug,
      note,
    });
    if (resp?.noteSlug && resp.noteSlug !== noteSlug) {
      ta.dataset.noteSlug = resp.noteSlug;
    }
  } else if (note) {
    const resp = await chrome.runtime.sendMessage({
      action: 'createNote',
      pageSlug: currentPage.slug,
      url: currentPage.url,
      excerpt: null,
      note,
      cssPath: null,
    });
    if (resp?.noteSlug) {
      ta.dataset.noteSlug = resp.noteSlug;
    }
  }
}

async function savePageNote(ta) {
  return enqueuePopupUiMutation('save-page-note', async () => {
    await sendPageNoteSave(ta);
  }).catch((error) => {
    logError('[popup] Page note save error:', error);
  });
}

async function savePageNoteWithoutLock(ta) {
  return enqueueFocusedAutosave(async () => {
    await sendPageNoteSave(ta);
  }).catch((error) => {
    logError('[popup] Page note save error:', error);
  });
}

function renderNotes(notes) {
  if (_noteSaveTimeout) {
    clearTimeout(_noteSaveTimeout);
    _noteSaveTimeout = null;
  }
  const container = document.getElementById('highlightList');
  const section = document.getElementById('notesSection');
  currentPage.notes = Array.isArray(notes) ? notes : [];

  const globalNote = currentPage.notes.find((n) => n.excerpt === null);
  renderPageNoteWrap(globalNote);

  const textNotes = currentPage.notes.filter((n) => n.excerpt !== null);
  const hasPageNote = Boolean(globalNote?.note || globalNote?.slug);
  section?.classList.toggle('is-empty', !hasPageNote && textNotes.length === 0);
  const count = document.getElementById('annotationCount');
  if (count) count.textContent = String(textNotes.length).padStart(2, '0');

  if (textNotes.length === 0) {
    container.innerHTML = '';
    showSection('notesSection');
    return;
  }

  container.innerHTML = textNotes
    .map((n, index) => {
      const displayText = formatHighlightExcerpt(n.excerpt);
      const noteText = n.note || '';
      const noteDisplay = noteText
        ? `<span class="highlight-note-text">${escapeHtml(noteText)}</span>`
        : `<span class="highlight-note-placeholder">${escapeHtml(tr('extensionNoAnnotation', 'No annotation', undefined))}</span>`;
      return `
      <div class="highlight-item" data-note-slug="${escapeHtml(n.slug)}" data-note-index="${String(index + 1).padStart(2, '0')}">
        <div class="highlight-header">
          <div class="highlight-excerpt">${escapeHtml(displayText)}</div>
          <button class="note-action-btn delete" data-note-slug="${escapeHtml(n.slug)}" title="${escapeHtml(tr('extensionDeleteHighlight', 'Delete highlight', undefined))}">${ICON_DELETE}</button>
        </div>
        <div class="highlight-body">
          <div class="highlight-note-row">
            ${noteDisplay}
            <button class="note-action-btn edit" title="${escapeHtml(tr('extensionEditNote', 'Edit note', undefined))}">${ICON_EDIT}</button>
          </div>
        </div>
      </div>`;
    })
    .join('');

  bindHighlightActions(container);
  showSection('notesSection');
}

function bindHighlightActions(container) {
  container.querySelectorAll('.note-action-btn.delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      void runPopupUiMutation('delete-note', async () => {
        const noteSlug = btn.dataset.noteSlug;
        if (!noteSlug) return;
        try {
          await chrome.runtime.sendMessage({ action: 'deleteNote', noteSlug });
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (tab?.id)
            chrome.tabs
              .sendMessage(tab.id, { action: 'removeHighlightMark', noteSlug })
              .catch(() => {});
        } catch (e) {
          logError('[popup] Delete note error:', e);
        }
        currentPage.notes = currentPage.notes.filter(
          (n) => n.slug !== noteSlug,
        );
        renderNotes(currentPage.notes);
      }).catch((error) => showErrorBubble(error.message));
    });
  });

  container.querySelectorAll('.note-action-btn.edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.highlight-item');
      const noteSlug = item?.dataset.noteSlug;
      const note = currentPage.notes.find((n) => n.slug === noteSlug);
      if (!note) return;
      openHighlightNoteEditor(item, note);
    });
  });
}

function openHighlightNoteEditor(item, note) {
  const body = item.querySelector('.highlight-body');
  body.innerHTML = `<textarea class="highlight-note-edit-textarea" placeholder="${escapeHtml(tr('extensionAddNote', 'Add a note...', undefined))}">${escapeHtml(note.note || '')}</textarea>`;
  const ta = body.querySelector('textarea');
  autoResizeTextarea(ta);
  ta.focus();

  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
    note.note = ta.value;
    clearTimeout(_noteSaveTimeout);
    _noteSaveTimeout = setTimeout(async () => {
      const slug = item.dataset.noteSlug;
      logDebug(`[popup] Saving note for slug=${slug}`);
      try {
        await saveHighlightNoteWithoutLock({ item, note, textarea: ta, slug });
      } catch (error) {
        logError('[popup] Note save error:', error);
      }
    }, 500);
  });

  ta.addEventListener('blur', () => {
    renderNotes(currentPage.notes);
  });
}

async function saveHighlightNoteWithoutLock({ item, note, textarea, slug }) {
  return enqueueFocusedAutosave(async () => {
    const resp = await chrome.runtime.sendMessage({
      action: 'updateNote',
      noteSlug: slug,
      note: textarea.value,
    });
    if (resp?.noteSlug && resp.noteSlug !== slug) {
      item.dataset.noteSlug = resp.noteSlug;
      note.slug = resp.noteSlug;
    }
  });
}

// Lists — pin current page to lists
async function loadLists() {
  for (const waitMs of [0, 80, 200]) {
    if (waitMs > 0) await delay(waitMs);
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getPopupLists',
      });
      if (!response?.success) continue;
      const lists = response.lists || [];
      currentPage.summary = {
        ...(currentPage.summary || {}),
        lists,
      };
      return lists;
    } catch (error) {
      logDebug('[popup] getPopupLists failed:', error.message);
    }
  }

  return currentPage.summary?.lists || [];
}

async function loadListPins(lists = null) {
  lists = lists || (await loadLists());
  const allPins = {};
  for (const list of lists) {
    if (list?.pins?.length > 0) allPins[list.slug] = list.pins;
  }
  return allPins;
}

function isPagePinned(allPins, listId, url) {
  const pins = allPins[listId] || [];
  const slug = generateSlugFromUrl(url);
  const pageId = pageKey(slug);
  return pins.some((p) => p.id === pageId || p.url === url);
}

function applyPinStateToLists(lists, listId, pinned) {
  if (!Array.isArray(lists) || !currentPage.url) return;
  const list = lists.find((candidate) => candidate.slug === listId);
  if (!list) return;
  const slug = generateSlugFromUrl(currentPage.url);
  const id = pageKey(slug);
  const pins = Array.isArray(list.pins) ? [...list.pins] : [];
  const existingIndex = pins.findIndex(
    (pin) => pin.id === id || pin.url === currentPage.url,
  );
  if (pinned) {
    if (existingIndex < 0) {
      pins.push({
        id,
        url: currentPage.url,
        title: currentPage.title || currentPage.tab?.title || '',
        pinnedAt: Date.now(),
      });
    }
  } else if (existingIndex >= 0) {
    pins.splice(existingIndex, 1);
  }
  list.pins = pins;
}

function applyPinStateToPinMap(allPins, listId, pinned) {
  if (!allPins || !currentPage.url) return;
  const slug = generateSlugFromUrl(currentPage.url);
  const id = pageKey(slug);
  const pins = Array.isArray(allPins[listId]) ? [...allPins[listId]] : [];
  const existingIndex = pins.findIndex(
    (pin) => pin.id === id || pin.url === currentPage.url,
  );
  if (pinned) {
    if (existingIndex < 0) {
      pins.push({
        id,
        url: currentPage.url,
        title: currentPage.title || currentPage.tab?.title || '',
        pinnedAt: Date.now(),
      });
    }
  } else if (existingIndex >= 0) {
    pins.splice(existingIndex, 1);
  }
  if (pins.length > 0) allPins[listId] = pins;
  else delete allPins[listId];
}

function applyLocalListPinState(listId, pinned) {
  applyPinStateToLists(currentPage.summary?.lists, listId, pinned);
}

function escapeCssSelector(value) {
  if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
    return globalThis.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => {
    return `\\${character.codePointAt(0).toString(16)} `;
  });
}

function syncListChipToggle(listId, pinned) {
  const chip = document.querySelector(
    `#listChips .list-chip[data-list-id="${escapeCssSelector(listId)}"]`,
  );
  if (!chip) return false;
  chip.classList.toggle('selected', pinned);
  syncListCountFromSummary();
  return true;
}

function syncListCountFromSummary() {
  const listCount = document.getElementById('listCount');
  if (!listCount) return;
  const lists = Array.isArray(currentPage.summary?.lists)
    ? currentPage.summary.lists
    : [];
  const nextCount = lists.reduce((count, list) => {
    const pins = Array.isArray(list?.pins) ? list.pins : [];
    const slug = generateSlugFromUrl(currentPage.url || '');
    const pageId = pageKey(slug);
    const pinned = pins.some(
      (pin) => pin.id === pageId || pin.url === currentPage.url,
    );
    return count + (pinned ? 1 : 0);
  }, 0);
  listCount.textContent = String(nextCount).padStart(2, '0');
}

function syncListPickerOptionToggle(listId, pinned) {
  const option = document.querySelector(
    `#listPickerHost.list-picker .list-picker-option[data-list-id="${escapeCssSelector(listId)}"]`,
  );
  if (!option) return false;
  option.classList.toggle('selected', pinned);
  const check = option.querySelector('.list-picker-row-check');
  if (check) check.innerHTML = pinned ? '&#10003;' : '';
  return true;
}

function handleListChipsClick(event) {
  const target = event.target?.closest?.('.list-chip, #listAddBtn');
  if (!target || !event.currentTarget?.contains?.(target)) return;
  if (target.classList.contains('list-chip')) {
    event.preventDefault();
    void runSilentPopupUiMutation('toggle-list-pin', async () => {
      const listId = target.dataset.listId;
      await toggleListPin(listId);
    }).catch((err) => showErrorBubble(err.message));
    return;
  }
  if (target.id === 'listAddBtn') {
    event.stopPropagation();
    void runPopupUiMutation('open-list-picker', async () => {
      if (listPickerElement()) {
        closeListPicker();
        return;
      }
      try {
        const freshLists = await loadLists();
        const freshPins = await loadListPins(freshLists);
        openListPicker(freshLists, freshPins);
      } catch (err) {
        showErrorBubble(err.message);
        openListPicker(currentPage.summary?.lists || [], {});
      }
    }).catch((err) => showErrorBubble(err.message));
  }
}

async function renderListChips(listOverride = null) {
  const container = document.getElementById('listChips');
  const lists = listOverride || (await loadLists());
  const allPins = await loadListPins(lists);

  // Partition into lists containing this page vs. others
  const containsPage = [];
  const others = [];
  for (const list of lists) {
    if (isPagePinned(allPins, list.slug, currentPage.url)) {
      containsPage.push(list);
    } else {
      others.push(list);
    }
  }
  const listCount = document.getElementById('listCount');
  if (listCount) {
    listCount.textContent = String(containsPage.length).padStart(2, '0');
  }

  // Sort others by most recent activity
  const othersRanked = others.map((list) => {
    const pins = allPins[list.slug] || [];
    const maxPinnedAt = pins.reduce(
      (max, p) => Math.max(max, p.pinnedAt || 0),
      0,
    );
    return { list, lastActivity: maxPinnedAt || 0 };
  });
  othersRanked.sort((a, b) => b.lastActivity - a.lastActivity);

  let displayLists;
  if (!frozenChipOrder) {
    // First render: pinned lists first, then fill remaining slots with active lists
    const remaining = Math.max(0, 10 - containsPage.length);
    displayLists = [
      ...containsPage,
      ...othersRanked.slice(0, remaining).map((r) => r.list),
    ];
    frozenChipOrder = displayLists.map((l) => l.slug);
  } else {
    // Subsequent renders: use frozen order, but ensure newly-pinned lists are visible
    const bySlug = new Map(lists.map((l) => [l.slug, l]));
    displayLists = frozenChipOrder
      .filter((slug) => bySlug.has(slug))
      .map((slug) => bySlug.get(slug));
    for (const list of containsPage) {
      if (!frozenChipOrder.includes(list.slug)) {
        displayLists.push(list);
        frozenChipOrder.push(list.slug);
      }
    }
    const displayed = new Set(displayLists.map((list) => list.slug));
    let remainingSlots = Math.max(0, 10 - displayLists.length);
    for (const { list } of othersRanked) {
      if (remainingSlots <= 0) break;
      if (displayed.has(list.slug)) continue;
      displayLists.push(list);
      frozenChipOrder.push(list.slug);
      displayed.add(list.slug);
      remainingSlots--;
    }
  }

  const existingChips = [...container.querySelectorAll('.list-chip')];
  const canPatchInPlace =
    existingChips.length === displayLists.length &&
    existingChips.every(
      (chip, index) => chip.dataset.listId === displayLists[index]?.slug,
    ) &&
    container.querySelector('.list-add-btn');

  if (canPatchInPlace) {
    existingChips.forEach((chip, index) => {
      const list = displayLists[index];
      const pinned = isPagePinned(allPins, list.slug, currentPage.url);
      chip.classList.toggle('selected', pinned);
      chip.dataset.listId = list.slug;
      chip.textContent = list.name;
    });
  } else {
    let html = displayLists
      .map((list) => {
        const pinned = isPagePinned(allPins, list.slug, currentPage.url);
        return `<span class="list-chip${pinned ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${list.slug}">${escapeHtml(list.name)}</span>`;
      })
      .join('');

    html += `<span class="list-add-btn" id="listAddBtn" title="${escapeHtml(tr('extensionAddToList', 'Add to list', undefined))}">+</span>`;

    container.innerHTML = html;
  }

  if (!listChipsClickBound) {
    container.addEventListener('click', handleListChipsClick);
    listChipsClickBound = true;
  }
  showSection('listSection');
  ensureListSearchCapture();
  focusListSearchCapture();
}

async function sendListPinToggle(listId) {
  return chrome.runtime.sendMessage({
    action: 'toggleListPin',
    listId,
    url: currentPage.url,
    title: currentPage.title || currentPage.tab?.title || '',
  });
}

async function toggleListPin(listId) {
  const response = await sendListPinToggle(listId);
  if (
    response &&
    response.success !== false &&
    typeof response.pinned === 'boolean'
  ) {
    applyLocalListPinState(listId, response.pinned);
    syncListChipToggle(listId, response.pinned);
  }
  await refreshCurrentPageSummary({
    renderSections: false,
    renderLists: false,
  });
  return response;
}

function borderBlockSize(element) {
  const style = getComputedStyle(element);
  return (
    Number.parseFloat(style.borderTopWidth) +
    Number.parseFloat(style.borderBottomWidth)
  );
}

function positionListPickerOverlay(wrap, picker, options = {}) {
  if (!wrap || !picker) return;
  const input = picker.querySelector('#listSearchInput');
  if (!wrap.isConnected || !picker.isConnected || !input) return;
  const gap = 5;
  const listMaxHeight = 160;
  const listMinHeight = 48;
  const contentHeight =
    Number.isFinite(options.listContentHeight) && options.listContentHeight > 0
      ? options.listContentHeight
      : listMaxHeight;
  const preferredListHeight = Math.min(listMaxHeight, contentHeight);
  const wrapRect = wrap.getBoundingClientRect();
  const viewportWidth =
    document.documentElement.clientWidth || window.innerWidth || wrapRect.width;
  const viewportHeight =
    document.documentElement.clientHeight ||
    window.innerHeight ||
    wrapRect.bottom + listMaxHeight;
  const width = Math.max(1, Math.min(wrapRect.width, viewportWidth));
  const left = Math.max(0, Math.min(wrapRect.left, viewportWidth - width));

  picker.style.left = `${left}px`;
  picker.style.top = '0px';
  picker.style.width = `${width}px`;

  const inputHeight = input.getBoundingClientRect().height;
  const pickerFrameHeight = borderBlockSize(picker);
  const belowTop = Math.max(gap, wrapRect.bottom + gap);
  const belowSpace =
    viewportHeight - belowTop - inputHeight - gap - pickerFrameHeight;
  const aboveSpace = wrapRect.top - gap - inputHeight - gap - pickerFrameHeight;
  const hasBelowSpace = belowSpace >= listMinHeight;
  const hasAboveSpace = aboveSpace >= listMinHeight;
  let pickerTop = belowTop;
  let listHeight = Math.min(preferredListHeight, Math.max(0, belowSpace));
  picker.classList.remove('list-picker-above');

  if (!hasBelowSpace && hasAboveSpace) {
    picker.classList.add('list-picker-above');
    listHeight = Math.min(preferredListHeight, Math.max(0, aboveSpace));
    pickerTop = Math.max(
      gap,
      Math.min(
        wrapRect.top - gap - inputHeight - listHeight - pickerFrameHeight,
        viewportHeight - inputHeight - listHeight - pickerFrameHeight - gap,
      ),
    );
  } else if (!hasBelowSpace) {
    listHeight = Math.min(
      preferredListHeight,
      Math.max(0, viewportHeight - inputHeight - gap * 2 - pickerFrameHeight),
    );
    const blockHeight = inputHeight + listHeight + pickerFrameHeight;
    pickerTop = Math.max(
      gap,
      Math.min(belowTop, viewportHeight - blockHeight - gap),
    );
  }

  picker.style.top = `${pickerTop}px`;
  picker.style.setProperty('--list-picker-list-max-height', `${listHeight}px`);
}

function closeListPicker() {
  const existing = listPickerElement();
  const pickerInput = listPickerInput();
  if (pickerInput) {
    pickerInput.__browserRecallPickerAbort?.abort();
    pickerInput.__browserRecallPickerAbort = null;
    configureListSearchCaptureInput(pickerInput);
  }
  if (existing) {
    existing.className = 'list-picker-host';
    existing.removeAttribute('style');
    document.getElementById('listPickerOptions').innerHTML = '';
  }
  document.removeEventListener('click', pickerOutsideClickHandler);
  ensureListSearchCapture();
  focusListSearchCapture();
}

function pickerOutsideClickHandler(e) {
  const picker = listPickerElement();
  if (
    picker &&
    !picker.contains(e.target) &&
    e.target !== listSearchInput() &&
    e.target.id !== 'listAddBtn'
  ) {
    closeListPicker();
  }
}

function configureListPickerInput(input) {
  input.__browserRecallPickerAbort?.abort();
  const AbortControllerCtor =
    input.ownerDocument?.defaultView?.AbortController ||
    globalThis.AbortController;
  input.__browserRecallPickerAbort = new AbortControllerCtor();
  input.className = 'list-picker-input';
  input.type = 'text';
  input.tabIndex = 0;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'listPickerList');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  input.placeholder = tr(
    'extensionSearchOrCreate',
    'Search or create...',
    undefined,
  );
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.removeAttribute('aria-hidden');
  return input;
}

function isListSearchInputComposing(input) {
  return Boolean(input?.__browserRecallListSearchComposing);
}

function setListSearchInputCursorToEnd(input) {
  if (isListSearchInputComposing(input)) return;
  input.setSelectionRange(input.value.length, input.value.length);
}

function openListPicker(lists, allPins, options = {}) {
  const { initialQuery = '', loading = false, inputElement = null } = options;
  // Close if already open
  if (listPickerElement()) {
    closeListPicker();
    return null;
  }

  const wrap = document.querySelector('.list-chips-wrap');
  if (!wrap) return null;
  const input = inputElement || listSearchCaptureInput();
  if (!input) throw new Error('List search input is missing');
  const shouldRestoreFocus = document.activeElement !== input;
  const picker = document.getElementById('listPickerHost');
  if (!picker || !picker.contains(input)) {
    throw new Error('List picker host is missing its search input');
  }
  configureListPickerInput(input);
  picker.className = 'list-picker';
  positionListPickerOverlay(wrap, picker);

  const listEl = document.getElementById('listPickerList');
  const optionsEl = document.getElementById('listPickerOptions');
  const listRowEl = picker.querySelector('.list-picker-list-row');
  const scrollThumb = document.getElementById('listPickerScrollThumb');
  if (initialQuery) input.value = initialQuery;
  let pickerLists = lists;
  let pickerPins = allPins;
  let isLoading = loading;
  let activePickerIndex = -1;
  let pickerScrollTop = 0;

  function isCurrentPicker() {
    return (
      listPickerElement() === picker &&
      picker.isConnected &&
      picker.contains(input) &&
      input.classList.contains('list-picker-input')
    );
  }

  function positionPickerForRenderedRows() {
    if (!isCurrentPicker()) return;
    const renderedHeight = optionsEl.getBoundingClientRect().height;
    positionListPickerOverlay(wrap, picker, {
      listContentHeight: renderedHeight || optionsEl.scrollHeight,
    });
  }

  function scrollRangeForPicker() {
    return Math.max(0, optionsEl.scrollHeight - listEl.clientHeight);
  }

  function setPickerScrollTop(nextScrollTop) {
    const scrollRange = scrollRangeForPicker();
    pickerScrollTop = Math.max(0, Math.min(nextScrollTop, scrollRange));
    optionsEl.style.transform =
      pickerScrollTop > 0 ? `translateY(${-pickerScrollTop}px)` : '';
    updatePickerScrollThumb();
  }

  function updatePickerScrollThumb() {
    if (!scrollThumb) return;
    const scrollRange = scrollRangeForPicker();
    if (scrollRange <= 0 || listEl.clientHeight <= 0) {
      picker.classList.remove('list-picker-has-scroll');
      pickerScrollTop = 0;
      optionsEl.style.transform = '';
      return;
    }

    picker.classList.add('list-picker-has-scroll');
    const trackHeight = listEl.clientHeight;
    const thumbHeight = Math.max(
      12,
      scrollThumb.parentElement?.clientWidth || 0,
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop =
      maxThumbTop === 0
        ? 0
        : Math.round((pickerScrollTop / scrollRange) * maxThumbTop);

    scrollThumb.style.height = `${thumbHeight}px`;
    scrollThumb.style.top = `${thumbTop}px`;
  }

  function schedulePickerScrollThumbUpdate() {
    updatePickerScrollThumb();
    const raf =
      window.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    raf(updatePickerScrollThumb);
  }

  function pickerOptions() {
    return [...optionsEl.querySelectorAll('.list-picker-option')];
  }

  function setActivePickerIndex(index) {
    const options = pickerOptions();
    listEl.querySelectorAll('.list-picker-option.active').forEach((option) => {
      option.classList.remove('active');
      option.removeAttribute('aria-selected');
    });
    if (!options.length) {
      activePickerIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return null;
    }
    activePickerIndex =
      ((index % options.length) + options.length) % options.length;
    const option = options[activePickerIndex];
    option.classList.add('active');
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < pickerScrollTop) {
      setPickerScrollTop(optionTop);
    } else if (optionBottom > pickerScrollTop + listEl.clientHeight) {
      setPickerScrollTop(optionBottom - listEl.clientHeight);
    } else {
      updatePickerScrollThumb();
    }
    return option;
  }

  function moveActivePickerIndex(delta) {
    const options = pickerOptions();
    if (!options.length) return null;
    if (activePickerIndex < 0) {
      return setActivePickerIndex(delta > 0 ? 0 : options.length - 1);
    }
    return setActivePickerIndex(activePickerIndex + delta);
  }

  async function activatePickerOption(option) {
    if (!option) return false;
    try {
      if (option.classList.contains('list-picker-create')) {
        const inputVal = input.value.trim();
        if (!inputVal) return true;
        await createListAndPin(inputVal);
        closeListPicker();
        return true;
      }

      const listId = option.dataset.listId;
      if (!listId) return true;
      const response = await sendListPinToggle(listId);
      if (
        response &&
        response.success !== false &&
        typeof response.pinned === 'boolean'
      ) {
        applyLocalListPinState(listId, response.pinned);
        applyPinStateToLists(pickerLists, listId, response.pinned);
        applyPinStateToPinMap(pickerPins, listId, response.pinned);
      }
      const chipSynced =
        response?.pinned === undefined ||
        syncListChipToggle(listId, response.pinned);
      const pickerSynced = syncListPickerOptionToggle(listId, response?.pinned);
      if (!chipSynced || !pickerSynced) {
        await renderListChips(currentPage.summary?.lists || pickerLists);
      }
      await refreshCurrentPageSummary({
        renderSections: false,
        renderLists: false,
      });
      return true;
    } catch (err) {
      showErrorBubble(err.message);
      return true;
    }
  }

  function renderPickerRows() {
    if (!isCurrentPicker()) return;
    if (isLoading) {
      optionsEl.innerHTML = `<div style="padding: 8px 10px; font-size: 11px; color: #999; text-align: center;">${escapeHtml(tr('commonLoading', 'Loading...', undefined))}</div>`;
      activePickerIndex = -1;
      input.removeAttribute('aria-activedescendant');
      pickerScrollTop = 0;
      optionsEl.style.transform = '';
      positionPickerForRenderedRows();
      schedulePickerScrollThumbUpdate();
      return;
    }

    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? pickerLists.filter((c) => c.name.toLowerCase().includes(query))
      : pickerLists;

    let rowsHtml = filtered
      .map((c) => {
        const pinned = isPagePinned(pickerPins, c.slug, currentPage.url);
        return `<div class="list-picker-option list-picker-row${pinned ? ' selected' : ''}" id="listPickerOption-list-${escapeHtml(c.slug)}" role="option" data-list-id="${c.slug}">
        <span class="list-picker-row-check">${pinned ? '&#10003;' : ''}</span>
        <span>${escapeHtml(c.name)}</span>
      </div>`;
      })
      .join('');

    // Show create option if input doesn't exactly match any existing list
    const inputVal = input.value.trim();
    if (inputVal) {
      const exactMatch = pickerLists.some(
        (c) => c.name.toLowerCase() === inputVal.toLowerCase(),
      );
      if (!exactMatch) {
        rowsHtml += `<div class="list-picker-option list-picker-create" id="listPickerCreate" role="option">${escapeHtml(tr('extensionCreateListNamed', `Create "${inputVal}"`, [inputVal]))}</div>`;
      }
    }

    if (!rowsHtml) {
      rowsHtml = `<div style="padding: 8px 10px; font-size: 11px; color: #999; text-align: center;">${escapeHtml(tr('extensionNoLists', 'No lists', undefined))}</div>`;
    }

    optionsEl.innerHTML = rowsHtml;
    pickerScrollTop = 0;
    optionsEl.style.transform = '';
    positionPickerForRenderedRows();
    schedulePickerScrollThumbUpdate();
    if (activePickerIndex >= pickerOptions().length) activePickerIndex = -1;
    if (activePickerIndex >= 0) setActivePickerIndex(activePickerIndex);
    else input.removeAttribute('aria-activedescendant');

    // Attach click handlers to rows
    optionsEl.querySelectorAll('.list-picker-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const runMutation = row.classList.contains('list-picker-create')
          ? runPopupUiMutation
          : runSilentPopupUiMutation;
        void runMutation('activate-list-picker-option', async () => {
          await activatePickerOption(row);
        }).catch((err) => showErrorBubble(err.message));
      });
    });

    const createBtn = document.getElementById('listPickerCreate');
    if (createBtn) {
      createBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void runPopupUiMutation('activate-list-picker-option', async () => {
          await activatePickerOption(createBtn);
        }).catch((err) => showErrorBubble(err.message));
      });
    }
  }

  renderPickerRows();
  if (inputElement) {
    if (document.activeElement !== input) input.focus({ preventScroll: true });
  } else if (shouldRestoreFocus) {
    // Use setTimeout to avoid the click event that opened the picker from immediately focusing away.
    setTimeout(() => {
      input.focus();
      setListSearchInputCursorToEnd(input);
    }, 0);
  }

  input.addEventListener(
    'input',
    () => {
      activePickerIndex = -1;
      renderPickerRows();
    },
    { signal: input.__browserRecallPickerAbort.signal },
  );

  listRowEl.addEventListener(
    'wheel',
    (e) => {
      const scrollRange = scrollRangeForPicker();
      if (scrollRange <= 0) return;
      e.preventDefault();
      setPickerScrollTop(pickerScrollTop + e.deltaY);
    },
    { passive: false, signal: input.__browserRecallPickerAbort.signal },
  );

  async function handlePickerKeydown(e) {
    if (isImeCompositionKeyEvent(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActivePickerIndex(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActivePickerIndex(-1);
    } else if (e.key === 'Enter') {
      if (isPopupUiMutating()) {
        e.preventDefault();
        return;
      }
      const activeOption = listEl.querySelector('.list-picker-option.active');
      if (activeOption) {
        e.preventDefault();
        const runMutation = activeOption.classList.contains(
          'list-picker-create',
        )
          ? runPopupUiMutation
          : runSilentPopupUiMutation;
        await runMutation('activate-list-picker-option', async () => {
          await activatePickerOption(activeOption);
        });
        if (listPickerElement() && document.body.contains(input)) {
          input.focus({ preventScroll: true });
        }
        return;
      }
      const inputVal = input.value.trim();
      if (!inputVal) return;
      const exactMatch = pickerLists.find(
        (c) => c.name.toLowerCase() === inputVal.toLowerCase(),
      );
      const runMutation = exactMatch
        ? runSilentPopupUiMutation
        : runPopupUiMutation;
      await runMutation('activate-list-picker-option', async () => {
        try {
          if (exactMatch) {
            await toggleListPin(exactMatch.slug);
            if (
              !document.querySelector(
                `#listChips .list-chip[data-list-id="${escapeCssSelector(exactMatch.slug)}"]`,
              )
            ) {
              await renderListChips(currentPage.summary?.lists || pickerLists);
            }
            closeListPicker();
          } else {
            await createListAndPin(inputVal);
            closeListPicker();
          }
        } catch (err) {
          showErrorBubble(err.message);
        }
      });
    } else if (e.key === 'Escape') {
      closeListPicker();
    }
  }

  input.addEventListener('keydown', handlePickerKeydown, {
    signal: input.__browserRecallPickerAbort.signal,
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.target === input || !listPickerElement()) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
      if (isEditableEventTarget(e.target)) return;
      if (
        e.target !== document.body &&
        e.target !== document.documentElement &&
        !picker.contains(e.target) &&
        !e.target?.closest?.('.list-chip, .list-add-btn')
      ) {
        return;
      }
      void handlePickerKeydown(e);
    },
    { signal: input.__browserRecallPickerAbort.signal },
  );

  // Close on outside click (deferred to avoid catching the opening click)
  setTimeout(() => {
    document.addEventListener('click', pickerOutsideClickHandler);
  }, 0);

  return {
    input,
    setData(nextLists, nextPins) {
      if (!isCurrentPicker()) return;
      pickerLists = nextLists;
      pickerPins = nextPins;
      isLoading = false;
      renderPickerRows();
    },
  };
}

let listSearchShortcutOpening = false;

function shouldFocusListSearchCapture() {
  const doc = globalThis.document;
  if (!doc) return false;
  if (isPopupUiMutating()) return false;
  if (popupShellState.surface !== 'dashboard') return false;
  if (!doc.getElementById('dashboardContent')) return false;
  if (listPickerElement()) return false;
  if (!currentPage.url) return false;
  const input = listSearchCaptureInput();
  if (isEditableEventTarget(doc.activeElement) && doc.activeElement !== input)
    return false;
  return true;
}

function listSearchCaptureInput() {
  const input = listSearchInput();
  return input?.classList.contains('list-search-capture') ? input : null;
}

function listSearchInput() {
  return document.getElementById('listSearchInput');
}

function listPickerInput() {
  const input = listSearchInput();
  return input?.classList.contains('list-picker-input') ? input : null;
}

function listPickerElement() {
  const picker = document.getElementById('listPickerHost');
  return picker?.classList.contains('list-picker') ? picker : null;
}

function focusListSearchCapture() {
  if (!shouldFocusListSearchCapture()) return;
  const input = listSearchInput();
  if (!input) return;
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  if (input.value || isListSearchInputComposing(input)) {
    void openListPickerFromTyping(input.value, input);
  }
}

function configureListSearchCaptureInput(input) {
  input.className = 'list-search-capture';
  input.type = 'text';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.removeAttribute('role');
  input.removeAttribute('aria-controls');
  input.removeAttribute('aria-expanded');
  input.removeAttribute('aria-autocomplete');
  input.removeAttribute('aria-activedescendant');
  input.removeAttribute('placeholder');
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.value = '';
  input.__browserRecallListSearchComposing = false;
  return input;
}

function bindListSearchCapture() {
  const input = listSearchCaptureInput();
  if (!input || boundListSearchCaptureInputs.has(input)) return;
  boundListSearchCaptureInputs.add(input);
  input.addEventListener('input', (event) => {
    if (!input.classList.contains('list-search-capture')) return;
    if (!input.value) return;
    if (!currentPage.url || popupShellState.surface !== 'dashboard') return;
    void openListPickerFromTyping(input.value, input);
  });
  input.addEventListener('compositionstart', () => {
    input.__browserRecallListSearchComposing = true;
    if (!input.classList.contains('list-search-capture')) return;
    if (!currentPage.url || popupShellState.surface !== 'dashboard') return;
    void openListPickerFromTyping(input.value, input);
  });
  input.addEventListener('compositionend', () => {
    input.__browserRecallListSearchComposing = false;
  });
}

function ensureListSearchCapture() {
  const input = listSearchInput();
  if (!input) throw new Error('List search input is missing');
  bindListSearchCapture();
  return input;
}

async function openListPickerFromTyping(
  initialQuery = '',
  inputElement = null,
) {
  if (isPopupUiMutating()) return;
  const existingInput = listPickerInput();
  if (existingInput) {
    if (initialQuery) {
      existingInput.value = initialQuery;
      existingInput.dispatchEvent(new Event('input', { bubbles: true }));
      setListSearchInputCursorToEnd(existingInput);
    }
    existingInput.focus();
    return;
  }

  if (listSearchShortcutOpening) return;
  listSearchShortcutOpening = true;
  const pickerController = openListPicker(
    [],
    {},
    { loading: true, inputElement },
  );
  if (initialQuery && pickerController?.input && !inputElement) {
    pickerController.input.value = initialQuery;
    pickerController.input.dispatchEvent(new Event('input', { bubbles: true }));
    setListSearchInputCursorToEnd(pickerController.input);
  }
  try {
    const lists = await loadLists();
    const allPins = await loadListPins(lists);
    pickerController?.setData(lists, allPins);
  } catch (err) {
    showErrorBubble(err.message);
  } finally {
    listSearchShortcutOpening = false;
  }
}

function handleListSearchShortcut(event) {
  if (event.defaultPrevented) return;
  if (isPopupUiMutating()) return;
  if (!isPrintableKeyEvent(event)) return;
  if (isImeCompositionKeyEvent(event)) return;
  if (isEditableEventTarget(event.target)) return;
  if (popupShellState.surface !== 'dashboard') return;
  if (!document.getElementById('dashboardContent')) return;

  event.preventDefault();
  void openListPickerFromTyping(event.key);
}

async function createListAndPin(name) {
  const lists = await loadLists();
  if (lists.some((c) => c.name === name)) return;

  // saveListMeta's effectOf adds to tree manifest — no manual append needed.
  // Use the generatedId returned by the handler (replay engine generates its own ID).
  const resp = await chrome.runtime.sendMessage({
    action: 'saveListMeta',
    name,
  });
  const listId = resp?.listId;
  if (!listId) {
    logError('[popup] saveListMeta did not return listId');
    return;
  }

  await toggleListPin(listId);
  await renderListChips(await loadLists());

  logDebug('[popup] Created list and pinned page:', name, listId);
}

// Recording pause state (session-only, not persisted to disk). The storage key
// remains "workspace" so content/background private-mode checks stay compatible.
async function loadRecordingState() {
  if (recordingUiState.hydrated) {
    return { paused: recordingUiState.paused };
  }
  const { workspace } = await chrome.storage.session.get(['workspace']);
  recordingUiState.paused = workspace?.mode === 'private';
  recordingUiState.hydrated = true;
  applyRecordingBarState();
  return { paused: recordingUiState.paused };
}

async function saveRecordingState(paused) {
  await chrome.runtime.sendMessage({
    action: 'setRecordingPaused',
    paused,
  });
}

function applyRecordingBarState() {
  const bar = document.getElementById('recordingBar');
  const button = document.getElementById('recordingToggle');
  const label = document.getElementById('recordingLabel');
  if (!bar || !button || !label) return;

  const paused = recordingUiState.paused;
  const pending = recordingUiState.pending || isPopupUiMutating();
  bar.classList.toggle('is-paused', paused);
  button.disabled = pending;
  button.setAttribute('aria-disabled', pending ? 'true' : 'false');
  button.setAttribute('aria-pressed', paused ? 'true' : 'false');
  button.title = pending
    ? tr('extensionUpdatingTracing', 'Updating tracing', undefined)
    : paused
      ? tr('extensionResumeTracing', 'Resume tracing', undefined)
      : tr('extensionPauseTracing', 'Pause tracing', undefined);
  label.textContent = tr('extensionName', 'Browser Recall', undefined);
}

async function renderRecordingBar() {
  await loadRecordingState();
  applyRecordingBarState();
}

async function handleRecordingToggleClick() {
  await loadRecordingState();
  if (recordingUiState.pending) return;
  const paused = recordingUiState.paused;
  const nextPaused = !paused;
  recordingUiState.pending = true;
  applyRecordingBarState();
  try {
    await saveRecordingState(nextPaused);
    recordingUiState.paused = nextPaused;
    nextCurrentPageGeneration();
    applyRecordingBarState();

    // Resuming recording: record the current page visit and show details.
    if (paused && !nextPaused && currentPage.tab) {
      const url = currentPage.tab._effectiveUrl || currentPage.tab.url;
      await chrome.runtime.sendMessage({
        action: 'recordPageActivity',
        url,
        title: currentPage.tab.title || null,
        slug: generateSlugFromUrl(url),
        isInitialLoad: true,
      });
      await showDashboard(currentPage.tab, {
        hideContentUntilReady: true,
        compactUntilReady: true,
      });
      return;
    }

    if (paused && !nextPaused) {
      restoreDashboardContent();
      return;
    }

    // Pausing recording: hide page details while keeping the DOM stable.
    if (nextPaused) {
      renderBannerOnly();
    }
  } finally {
    recordingUiState.pending = false;
    applyRecordingBarState();
  }
}

// Recording toggle handler
document.getElementById('recordingToggle').addEventListener('click', () => {
  void runPopupUiMutation('recording-toggle', handleRecordingToggleClick).catch(
    (error) => {
      logError('[popup] Recording toggle failed:', error);
    },
  );
});

// Title editing
function startEditingTitle() {
  if (isPopupUiMutating()) return;
  const titleEl = document.getElementById('pageTitle');
  const currentTitle = titleEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'page-title-input';
  input.value = currentTitle;

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function saveTitle() {
    const newTitle = input.value.trim() || currentTitle;
    const newTitleEl = document.createElement('div');
    newTitleEl.className = 'page-title';
    newTitleEl.id = 'pageTitle';
    newTitleEl.textContent = newTitle;
    newTitleEl.addEventListener('click', startEditingTitle);
    input.replaceWith(newTitleEl);

    if (newTitle !== currentTitle && currentPage.entry) {
      currentPage.entry.user_title = newTitle;
      currentPage.title = newTitle;
      await enqueuePopupUiMutation('save-title', async () => {
        await chrome.runtime.sendMessage({
          action: 'recordPageActivity',
          url: currentPage.entry.url,
          user_title: newTitle,
        });
        logDebug('[popup] User title updated to:', newTitle);
      }).catch((error) => {
        logError('[popup] Failed to save user title:', error);
      });
    }
  }

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', (e) => {
    if (isImeCompositionKeyEvent(e)) return;
    if (e.key === 'Enter') {
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentTitle;
      input.blur();
    }
  });
}

document
  .getElementById('pageTitle')
  .addEventListener('click', startEditingTitle);
document.addEventListener('keydown', handleListSearchShortcut);

document.getElementById('pageUrl').addEventListener('click', async () => {
  if (!currentPage.url) return;
  await chrome.tabs.create({ url: currentPage.url });
});

// Open the desktop app to Explore. Page detail can be inaccurate before checkpointing.
document.querySelector('.recording-copy').addEventListener('click', () => {
  openDesktopApp();
});

for (const id of ['setupDesktopConnectBtn']) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.addEventListener('click', () => {
    void runPopupUiMutation('connect-desktop', connectDesktopBridge).catch(
      (error) => showErrorBubble(error.message),
    );
  });
}

// Capture button handler
document.getElementById('captureBtn').addEventListener('click', () => {
  void runPopupUiMutation('capture-frame', async () => {
    const btn = document.getElementById('captureBtn');
    btn.disabled = true;
    btn.textContent = tr('extensionCapturing', 'Capturing...', undefined);

    try {
      logDebug('[popup] Capturing snapshot...');
      const resp = await chrome.runtime.sendMessage({
        action: 'captureCurrentPageFromPopup',
      });
      logDebug('[popup] Capture response:', resp);
      if (resp && resp.success) {
        await refreshCurrentPageSummary();
      } else {
        logDebug('[popup] Capture failed:', resp);
        await notifyActivePageError(
          resp?.error,
          tr('extensionCaptureFailed', 'Capture failed', undefined),
        );
      }
    } catch (error) {
      logError('[popup] Capture error:', error);
      await notifyActivePageError(
        error.message,
        tr('extensionCaptureFailed', 'Capture failed', undefined),
      );
    }

    btn.disabled = false;
    btn.textContent = tr('extensionCaptureFrame', 'CAPTURE FRAME', undefined);
  }).catch((error) => showErrorBubble(error.message));
});

// ─── showDashboard phases ────────────────────────────────────────────

function restoreDashboardContent() {
  const diagnosticVisible =
    document.getElementById('pageDiagnosticSection')?.style.display !== 'none';
  setPopupSurface(diagnosticVisible ? 'diagnostic' : 'dashboard');
}

async function resolvePageIdentity(tab) {
  const effectiveUrl = tab._effectiveUrl || tab.url;
  let title = tab._effectiveTitle || tab.title || '<unknown>';
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'trimTitle',
      title,
      url: effectiveUrl,
    });
    if (resp?.title) title = resp.title;
  } catch {}
  const slug = tab._effectiveSlug || generateSlugFromUrl(effectiveUrl);
  return { slug, url: effectiveUrl, title };
}

async function trimDisplayTitle(title, url) {
  const fallback = title || '<unknown>';
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'trimTitle',
      title: fallback,
      url,
    });
    return resp?.title || fallback;
  } catch {
    return fallback;
  }
}

function pageSummaryFallback(tab, slug, summary = {}) {
  const url = summary.url || currentPage.url || tab._effectiveUrl || tab.url;
  return {
    slug,
    url,
    title: currentPage.title || tab.title || '<unknown>',
    visitDates: [],
    childIds: [],
    parentIds: [],
  };
}

async function fetchAndRenderPageData(tab, slug, options = {}) {
  const { resetSections = true, renderSections = true } = options;
  const generation = currentPage.generation;
  currentPage.entry = null;
  currentPage.pageSummaryState = 'loading';

  try {
    logDebug(
      `[popup] Fetching page summary for url=${currentPage.url || tab.url}`,
    );
    const summary = await chrome.runtime.sendMessage({
      action: 'getPageSummary',
      url: currentPage.url || tab.url,
    });
    if (generation !== currentPage.generation) return false;
    logDebug('[popup] getPageSummary response:', summary);

    if (summary?.success) {
      if (resetSections) resetDashboardSections();
      else clearPageDiagnosticSection();
      const page = summary.page || pageSummaryFallback(tab, slug, summary);
      const title = page.user_title
        ? page.user_title
        : await trimDisplayTitle(
            page.title || tab.title || '<unknown>',
            page.url || currentPage.url || tab.url,
          );
      if (generation !== currentPage.generation) return false;
      currentPage.summary = { ...summary, page };
      currentPage.entry = page || null;
      currentPage.pageSummaryState = 'succeeded';
      currentPage.title = title || '';
      if (page.url) currentPage.url = page.url;
      document.getElementById('pageTitle').textContent = currentPage.title;
      if (currentPage.url) {
        document.getElementById('pageUrl').textContent = currentPage.url;
      }
      if (renderSections) {
        renderVisitsAndLikes(page);
        renderSnapshots(summary.snapshots);
        renderNotes(summary.notes);
      }
      logDebug(
        `[popup] Loaded ${summary.notes?.length || 0} notes, ${summary.snapshots?.length || 0} snapshots, ${summary.lists?.length || 0} lists`,
      );
    } else {
      currentPage.pageSummaryState = 'failed';
      logDebug('[popup] getPageSummary returned failure:', summary);
      const connector = await refreshDesktopConnectorState();
      if (connector?.state === 'connected' && connector?.deviceId) {
        showDesktopDataUnavailable(
          summary?.error ||
            tr(
              'extensionDesktopPageDataUnavailable',
              'Desktop page data unavailable.',
              undefined,
            ),
          {
            reason: 'popup-page-summary-failed',
            summary,
            connector,
            url: currentPage.url || tab.url,
          },
        );
      } else {
        showSetupRequired(connector || { state: 'offline', hasToken: true });
      }
      return false;
    }
  } catch (error) {
    if (generation !== currentPage.generation) return false;
    currentPage.pageSummaryState = 'failed';
    logError('[popup] Could not load page summary:', error);
    const connector = await refreshDesktopConnectorState();
    if (connector?.state === 'connected' && connector?.deviceId) {
      showDesktopDataUnavailable(
        error.message ||
          tr(
            'extensionDesktopPageDataUnavailable',
            'Desktop page data unavailable.',
            undefined,
          ),
        {
          reason: 'popup-page-summary-error',
          error: error.message || String(error),
          connector,
          url: currentPage.url || tab.url,
        },
      );
    } else {
      showSetupRequired(connector || { state: 'offline', hasToken: true });
    }
    return false;
  }
  return true;
}

async function refreshCurrentPageSummary(options = {}) {
  const { renderSections = true, renderLists = true } = options;
  if (!currentPage.tab || !currentPage.url) return;
  const { paused } = await loadRecordingState();
  if (
    paused ||
    recordingUiState.pending ||
    !['dashboard', 'diagnostic'].includes(popupShellState.surface) ||
    !document.getElementById('dashboardContent')
  ) {
    await renderRecordingBar();
    return;
  }
  const generation = nextCurrentPageGeneration();
  const updated = await fetchAndRenderPageData(
    currentPage.tab,
    currentPage.slug,
    {
      resetSections: false,
      renderSections,
    },
  );
  if (!updated || generation !== currentPage.generation) return;
  const followUps = [renderRecordingBar()];
  if (renderLists) followUps.unshift(renderListChips());
  await Promise.all(followUps);
}

function renderPageDashboardShell(options = {}) {
  const { updateRecordingBar = true } = options;
  hideElement('blacklisted');
  setPopupSurface('dashboard');
  if (updateRecordingBar) void renderRecordingBar();
}

function showDashboardUI(options = {}) {
  renderPageDashboardShell(options);
  ensureListSearchCapture();
  focusListSearchCapture();
  const frame =
    globalThis.requestAnimationFrame ||
    globalThis.window?.requestAnimationFrame ||
    ((callback) => setTimeout(callback, 0));
  const doc = document;
  frame(() => {
    doc
      .querySelectorAll(
        '.page-note-edit-textarea, .highlight-note-edit-textarea',
      )
      .forEach((ta) => autoResizeTextarea(ta));
    focusListSearchCapture();
  });
}

function scheduleDelayedTitleCheck(tab, initialTitle) {
  if (currentPage.entry?.user_title) return;
  setTimeout(async () => {
    try {
      const [freshTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!freshTab || freshTab.id !== tab.id) return;

      const freshTitle = freshTab.title || '';
      if (freshTitle === initialTitle) return;

      const titleEl = document.getElementById('pageTitle');
      if (!titleEl || titleEl.textContent !== initialTitle) return;

      titleEl.textContent = freshTitle;
      await chrome.runtime.sendMessage({
        action: 'recordPageActivity',
        url: tab.url,
        title: freshTitle,
      });
      if (currentPage.entry) currentPage.entry.title = freshTitle;
      logDebug('[popup] Auto-updated title to:', freshTitle);
    } catch (error) {
      logDebug('[popup] Title re-check failed:', error);
    }
  }, 1000);
}

// Show dashboard for a tab: set up state, fetch data, render sections
async function showDashboard(tab, options = {}) {
  const { hideContentUntilReady = false, compactUntilReady = false } = options;
  const generation = nextCurrentPageGeneration();
  const previousSlug = currentPage.slug;
  if (hideContentUntilReady) {
    setPopupSurface('dashboard-loading');
  }
  if (compactUntilReady) setPopupCompact(true);

  const { slug, url, title } = await resolvePageIdentity(tab);
  if (generation !== currentPage.generation) return;
  if (slug !== previousSlug) frozenChipOrder = null;
  resetCurrentPageIdentity({ slug, url, title, tab });
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageUrl').textContent = url;
  resetDashboardSections();

  const updated = await fetchAndRenderPageData(tab, slug, {
    resetSections: false,
  });
  if (!updated || generation !== currentPage.generation) return;
  const summaryLists = Array.isArray(currentPage.summary?.lists)
    ? currentPage.summary.lists
    : null;
  await renderListChips(summaryLists || (await loadLists()));
  if (generation !== currentPage.generation) return;
  await renderRecordingBar();
  if (generation !== currentPage.generation) return;
  showDashboardUI({ updateRecordingBar: false });
  scheduleDelayedTitleCheck(tab, tab.title || '');
}

// ─── Init phases ─────────────────────────────────────────────────────

async function verifyDeviceIdentity(connector) {
  if (connector?.deviceId) return connector.deviceId;
  throw new Error(
    tr(
      'extensionDesktopNotConnectedRefresh',
      'Browser Recall Desktop is not connected yet. Start the desktop app and refresh from the popup.',
      undefined,
    ),
  );
}

async function resolveActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab ||
    !tab.url ||
    isInternalBrowserUrl(tab.url) ||
    (tab.url.startsWith('chrome-extension://') && !isSnapshotViewerUrl(tab.url))
  ) {
    showUnavailablePage(
      tr('extensionNotAvailablePage', 'Not available for this page', undefined),
    );
    return null;
  }
  return tab;
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

function isSnapshotViewerUrl(url) {
  return Boolean(snapshotViewerSlugFromUrl(url));
}

async function resolveEffectiveUrl(tab) {
  let effectiveUrl = tab.url;
  let reportedUrl = null;
  try {
    const reported = await chrome.runtime.sendMessage({
      action: 'getReportedUrl',
      tabId: tab.id,
    });
    if (reported?.success && reported.url) {
      reportedUrl = reported.url;
      effectiveUrl = reported.url;
    }
  } catch {}

  if (tab.id != null) {
    const viewerSlug = snapshotViewerSlugFromUrl(tab.url);
    if (viewerSlug) {
      try {
        const pageInfo = await chrome.runtime.sendMessage({
          action: 'getPageInfo',
          slug: viewerSlug,
        });
        if (pageInfo?.success && pageInfo.entry?.url) {
          tab._effectiveSlug = viewerSlug;
          effectiveUrl = pageInfo.entry.url;
          if (pageInfo.entry.title) tab._effectiveTitle = pageInfo.entry.title;
        }
      } catch {}
      tab._effectiveUrl = effectiveUrl;
      return;
    }

    try {
      const identity = await chrome.tabs.sendMessage(tab.id, {
        action: 'getPageIdentity',
      });
      if (identity?.success && identity.embedded && identity.slug) {
        tab._effectiveSlug = identity.slug;
        if (identity.url) {
          effectiveUrl = identity.url;
        } else {
          const pageInfo = await chrome.runtime.sendMessage({
            action: 'getPageInfo',
            slug: identity.slug,
          });
          if (pageInfo?.success && pageInfo.entry?.url) {
            effectiveUrl = pageInfo.entry.url;
            if (pageInfo.entry.title)
              tab._effectiveTitle = pageInfo.entry.title;
          }
        }
      }
    } catch {}
  }

  tab._effectiveUrl = effectiveUrl;
}

async function handlePrivateMode(tab) {
  const { paused } = await loadRecordingState();
  if (!paused) return false;
  currentPage.tab = tab;
  renderBannerOnly();
  revealPopup();
  return true;
}

async function handleBlacklist(tab) {
  const effectiveUrl = tab._effectiveUrl || tab.url;
  const response = await chrome.runtime.sendMessage({
    action: 'getPopupAccessState',
    url: effectiveUrl,
  });
  if (response?.success === false) {
    throw new Error(
      response.error ||
        tr(
          'extensionDesktopPopupAccessFailed',
          'Desktop popup access check failed',
          undefined,
        ),
    );
  }
  if (!response?.blacklisted || response?.hasVisitHistory) return false;

  renderBlacklistDiagnostic(tab, effectiveUrl);
  return true;
}

function renderBlacklistDiagnostic(tab, effectiveUrl) {
  renderPageDiagnostic({
    title: tr('extensionBlacklisted', 'Blacklisted', undefined),
    message: tab.url,
    actions: [
      {
        id: 'captureOnceBtn',
        className: 'capture-once-btn',
        label: tr('extensionCaptureIt', 'Capture It', undefined),
        onClick: (event) => {
          const btn = event.currentTarget;
          void runPopupUiMutation('capture-blacklisted-page', async () => {
            btn.disabled = true;
            btn.textContent = tr(
              'extensionCapturing',
              'Capturing...',
              undefined,
            );

            try {
              const slug = generateSlugFromUrl(effectiveUrl);
              await chrome.runtime.sendMessage({
                action: 'recordPageActivity',
                url: effectiveUrl,
                title: tab.title || null,
                slug,
                isInitialLoad: true,
                bypassBlacklist: true,
              });
              const resp = await chrome.runtime.sendMessage({
                action: 'captureCurrentPageFromPopup',
              });
              if (resp && !resp.success) {
                await notifyPageError({
                  tabId: tab.id,
                  message: resp.error,
                  fallback: tr(
                    'extensionCaptureFailed',
                    'Capture failed',
                    undefined,
                  ),
                });
              }
              logDebug('[popup] Capture once completed for blacklisted page');
            } catch (error) {
              logError('[popup] Capture once failed:', error);
              await notifyPageError({
                tabId: tab.id,
                message: error.message,
                fallback: tr(
                  'extensionCaptureFailed',
                  'Capture failed',
                  undefined,
                ),
              });
            }

            await showDashboard(tab);
          }).catch((error) => showErrorBubble(error.message));
        },
      },
      {
        id: 'blacklistSettingsLink',
        label: tr('extensionManageSettings', 'Manage in Settings', undefined),
        onClick: () => openDesktopApp('settings'),
      },
    ],
  });
}

function popupBootstrapToken() {
  try {
    return new URL(window.location.href).searchParams.get('bootstrap');
  } catch {
    return null;
  }
}

async function consumePopupBootstrap() {
  const token = popupBootstrapToken();
  if (!token) return null;
  try {
    // Background prepared the popup model before opening this URL. The token is
    // an in-memory one-shot handoff, not extension-side product persistence.
    const response = await chrome.runtime.sendMessage({
      action: 'consumePopupBootstrap',
      token,
    });
    if (response?.success && response.bootstrap) return response.bootstrap;
  } catch (error) {
    logDebug('[popup] bootstrap consume failed:', error.message);
  }
  return null;
}

async function renderPreparedDashboard(bootstrap) {
  const generation = nextCurrentPageGeneration();
  const tab = bootstrap.tab;
  const identity = bootstrap.identity || {};
  const summary = bootstrap.summary || {};
  const slug = identity.slug || generateSlugFromUrl(identity.url || tab.url);
  const url = identity.url || summary.url || tab._effectiveUrl || tab.url;
  const page = summary.page || pageSummaryFallback(tab, slug, summary);
  const title =
    page.user_title ||
    identity.title ||
    page.title ||
    tab._effectiveTitle ||
    tab.title ||
    '<unknown>';

  if (slug !== currentPage.slug) frozenChipOrder = null;
  resetCurrentPageIdentity({ slug, url, title, tab });
  resetDashboardSections();
  currentPage.summary = { ...summary, success: true, page };
  currentPage.entry = page;
  currentPage.pageSummaryState = 'succeeded';
  if (page.url) currentPage.url = page.url;
  currentPage.title = title || '';

  document.getElementById('pageTitle').textContent = currentPage.title;
  document.getElementById('pageUrl').textContent = currentPage.url;
  renderVisitsAndLikes(page);
  renderSnapshots(summary.snapshots || []);
  renderNotes(summary.notes || []);
  await renderListChips(Array.isArray(summary.lists) ? summary.lists : []);
  if (generation !== currentPage.generation) return;
  await renderRecordingBar();
  if (generation !== currentPage.generation) return;
  showDashboardUI({ updateRecordingBar: false });
  scheduleDelayedTitleCheck(tab, tab.title || '');
}

async function renderPreparedPopup(bootstrap) {
  if (!bootstrap?.mode) return false;
  if (bootstrap.connector) applyDesktopConnectorUi(bootstrap.connector);

  switch (bootstrap.mode) {
    case 'setup':
      showSetupRequired(bootstrap.connector || { state: 'offline' });
      return true;
    case 'unavailable':
      showUnavailablePage(
        bootstrap.message ||
          tr(
            'extensionNotAvailablePage',
            'Not available for this page',
            undefined,
          ),
      );
      return true;
    case 'private': {
      currentPage.tab = bootstrap.tab || null;
      renderBannerOnly();
      revealPopup();
      return true;
    }
    case 'blacklisted':
      renderBlacklistDiagnostic(
        bootstrap.tab,
        bootstrap.identity?.url ||
          bootstrap.tab._effectiveUrl ||
          bootstrap.tab.url,
      );
      return true;
    case 'data-unavailable':
      showDesktopDataUnavailable(
        bootstrap.error ||
          tr(
            'extensionDesktopPageDataUnavailable',
            'Desktop page data unavailable.',
            undefined,
          ),
        bootstrap.diagnostic || null,
      );
      return true;
    case 'dashboard':
      await renderPreparedDashboard(bootstrap);
      return true;
    default:
      return false;
  }
}

// Initialize popup
async function loadConnectedDashboard(connector) {
  await verifyDeviceIdentity(connector);
  setPopupSurface('dashboard', { reveal: false });

  const tab = await resolveActiveTab();
  if (!tab) return;
  await resolveEffectiveUrl(tab);
  if (await handlePrivateMode(tab)) return;
  if (await handleBlacklist(tab)) return;
  await showDashboard(tab);
}

async function initPopup() {
  await initializeExtensionI18n();
  localizeDocument();
  await applyTheme();
  try {
    const bootstrap = await consumePopupBootstrap();
    if (bootstrap && (await renderPreparedPopup(bootstrap))) return;

    const cachedConnector = await getCachedDesktopConnectorState();
    if (
      cachedConnector?.state === 'connected' &&
      cachedConnector.deviceId &&
      !cachedConnector.refuseMode
    ) {
      void refreshDesktopConnectorState().catch((error) => {
        logDebug('[popup] background connector refresh failed:', error.message);
      });
      await loadConnectedDashboard(cachedConnector);
      return;
    }
    if (cachedConnector && cachedConnector.state !== 'starting') {
      showSetupRequired(cachedConnector);
      refreshDesktopConnectorStateInBackground();
      return;
    }

    const connector = await refreshDesktopConnectorState();
    if (connector?.state !== 'connected' || !connector?.deviceId) {
      showSetupRequired(connector || { state: 'offline' });
      return;
    }

    await loadConnectedDashboard(connector);
  } catch (error) {
    throw error;
  }
}
ensureListSearchCapture();
listSearchInput().focus({ preventScroll: true });
initPopup().catch((err) => showFatalError(err.message));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!hasConnectorStateStorageChange(changes)) return;
  void (async () => {
    const connector = setupRequiredVisible()
      ? await refreshDesktopConnectorState()
      : await getCachedDesktopConnectorState();
    if (!connector) return;
    applyDesktopConnectorUi(connector);
    if (setupRequiredVisible()) {
      await loadDashboardIfConnected(connector);
    }
  })();
});
