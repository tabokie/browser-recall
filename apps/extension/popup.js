// Popup — current-page dashboard
import {
  generateSlugFromUrl,
  escapeHtml,
  isInternalBrowserUrl,
} from './utils.js';
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

const extensionSurface = globalThis.browserRecallExtensionSurface;
if (
  !extensionSurface?.highlightEntryHtml ||
  !extensionSurface?.openHighlightNoteEditor
) {
  throw new Error(
    'Browser Recall highlight entry helper was not loaded before popup.js',
  );
}
extensionSurface.installHighlightEntryStyles(document);

const currentPage = {
  slug: '',
  notes: [],
  entry: null,
  summary: null,
  url: '',
  title: '',
  tab: null,
  markupHidden: false,
  markupStateAvailable: false,
  generation: 0,
  loadInFlight: null,
  pageSummaryState: 'idle',
};
let frozenChipOrder = null; // Array of list slugs — frozen on first render to keep order stable
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
let listChipsClickBound = false;
let liveListRefreshQueued = false;
let pendingLiveListMutation = null;

function resetCurrentPageIdentity({ slug, url, title, tab }) {
  Object.assign(
    currentPage,
    { slug, url, title, tab },
    {
      entry: null,
      summary: null,
      notes: [],
      markupHidden: false,
      markupStateAvailable: false,
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
        '.markup-toggle-btn',
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
  setPopupInteractionDisabled(pending);
  applyRecordingBarState();
}

function finishPopupUiMutation(stateKey) {
  popupUiMutationState[stateKey] = false;
  popupUiMutationState.action = null;
  updatePopupUiMutationState();
  const resolvers = popupUiMutationActiveIdleResolvers;
  popupUiMutationActiveIdleResolvers = [];
  resolvers.forEach((resolve) => resolve());
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
    finishPopupUiMutation('active');
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
    finishPopupUiMutation('silentActive');
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
  // Keep a fulfilled serialization tail; callers receive `queued` and observe
  // the rejection from their own mutation.
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

function hideElement(id) {
  const element = document.getElementById(id);
  if (element) element.style.display = 'none';
}

function renderConnectorDiagnostic(connector, options = {}) {
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)) {
    throw new Error('Connector diagnostic requires connector state');
  }
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

function showSetupRequired(connector, options = {}) {
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

function applyDesktopConnectorUi(connector) {
  const formatted = formatDesktopConnectorState(connector);
  const pending = desktopConnectInFlight || connector.state === 'pair_pending';
  const checking = desktopConnectInFlight;

  const title = document.getElementById('setupRequiredTitle');
  if (title) title.textContent = formatted.status;
  const meta = document.getElementById('setupRequiredMeta');
  if (meta) meta.textContent = formatted.meta;

  const connectButton = document.getElementById('setupDesktopConnectBtn');
  if (!connectButton) return;
  connectButton.disabled = pending;
  connectButton.textContent = pending
    ? tr('extensionWaitingApproval', 'Waiting for Approval', undefined)
    : tr('extensionCheckAgain', 'Check Again', undefined);
  connectButton.classList.toggle('is-checking', checking);
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
    lines.push(`pendingCommands: ${diagnostic.connector.pendingCommands}`);
    lines.push(`pendingBytes: ${diagnostic.connector.pendingBytes}`);
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

function clearPageDiagnosticContent() {
  const pageHeader = document.getElementById('pageHeader');
  if (pageHeader) pageHeader.style.display = '';
  const detail = document.getElementById('pageDiagnosticDetail');
  if (detail) {
    detail.style.display = 'none';
    detail.textContent = '';
  }
  const actions = document.getElementById('pageDiagnosticActions');
  if (actions) {
    actions.style.display = 'none';
    actions.innerHTML = '';
  }
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
  clearPageDiagnosticContent();
  const attention = document.getElementById('attentionGrid');
  if (attention) attention.innerHTML = '';
  const listChips = document.getElementById('listChips');
  if (listChips) listChips.innerHTML = '';
  const listCount = document.getElementById('listCount');
  if (listCount) listCount.textContent = '00';
  const markupControls = document.getElementById('markupControls');
  if (markupControls) markupControls.innerHTML = '';
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
  clearPageDiagnosticContent();
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
    throw error;
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
  if (!Array.isArray(snapshots)) {
    throw new Error('Popup snapshot projection must be an array');
  }
  const container = document.getElementById('snapshotList');
  const count = document.getElementById('snapshotCount');
  const section = document.getElementById('snapshotSection');
  if (count) count.textContent = String(snapshots.length).padStart(2, '0');
  if (snapshots.length === 0) {
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
        const response = await chrome.runtime.sendMessage({
          action: 'deleteSnapshot',
          slug: currentPage.slug,
          timestamp: ts,
        });
        requireSuccessfulResponse(response, 'deleteSnapshot');
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

  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.visitDates)) {
    throw new Error('Popup page projection is missing visitDates');
  }
  const visitDates = entry.visitDates;
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

async function refreshHighlightMarkupState() {
  const tabId = currentPage.tab?.id;
  if (!Number.isInteger(tabId)) {
    throw new Error(tr('extensionNoTargetTab', 'No target tab', undefined));
  }
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {
      action: 'getHighlightMarkupState',
    });
  } catch (error) {
    // This tab RPC gates only the markup toggle. Authoritative notes come from
    // the desktop and must still render when a loading/restricted tab has no
    // content-script receiver.
    if (globalThis.browserRecallWebExtension?.isRuntimeFailure?.(error)) {
      currentPage.markupStateAvailable = false;
      return false;
    }
    throw error;
  }
  requireSuccessfulResponse(response, 'getHighlightMarkupState');
  if (typeof response.hidden !== 'boolean') {
    throw new Error('getHighlightMarkupState response missing hidden');
  }
  currentPage.markupHidden = response.hidden;
  currentPage.markupStateAvailable = true;
  return true;
}

function renderMarkupControls() {
  const wrap = document.getElementById('markupControls');
  if (!currentPage.markupStateAvailable) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `<button class="markup-toggle-btn" id="hideMarkupBtn" aria-pressed="false">${escapeHtml(tr('extensionHideMarkup', 'Hide markup'))}</button>`;
  const markupButton = wrap.querySelector('#hideMarkupBtn');
  const renderMarkupButtonState = () => {
    markupButton.classList.toggle('is-markup-hidden', currentPage.markupHidden);
    markupButton.setAttribute(
      'aria-pressed',
      currentPage.markupHidden ? 'true' : 'false',
    );
    markupButton.textContent = currentPage.markupHidden
      ? tr('extensionShowMarkup', 'Show markup')
      : tr('extensionHideMarkup', 'Hide markup');
  };
  renderMarkupButtonState();
  markupButton.addEventListener('click', () => {
    void runPopupUiMutation('hide-highlight-markup', async () => {
      const tabId = currentPage.tab?.id;
      if (!Number.isInteger(tabId)) {
        throw new Error(tr('extensionNoTargetTab', 'No target tab', undefined));
      }
      const action = currentPage.markupHidden
        ? 'showHighlightMarkup'
        : 'hideHighlightMarkup';
      const response = await chrome.tabs.sendMessage(tabId, { action });
      requireSuccessfulResponse(response, action);
      currentPage.markupHidden = !currentPage.markupHidden;
      renderMarkupButtonState();
    }).catch((error) => showErrorBubble(error.message));
  });
}

function renderNotes(notes) {
  const container = document.getElementById('highlightList');
  const section = document.getElementById('notesSection');
  if (!Array.isArray(notes)) {
    throw new Error('Popup note projection must be an array');
  }
  currentPage.notes = notes;
  renderMarkupControls();
  const textNotes = currentPage.notes;
  section?.classList.toggle('is-empty', textNotes.length === 0);
  const count = document.getElementById('annotationCount');
  if (count) count.textContent = String(textNotes.length).padStart(2, '0');

  if (textNotes.length === 0) {
    container.innerHTML = '';
    hideSection('notesSection');
    return;
  }

  container.innerHTML = textNotes
    .map((note) =>
      extensionSurface.highlightEntryHtml(note, {
        deleteTitle: tr(
          'extensionDeleteHighlight',
          'Delete highlight',
          undefined,
        ),
        editTitle: tr('extensionEditNote', 'Edit note', undefined),
      }),
    )
    .join('');

  bindHighlightActions(container);
  showSection('notesSection');
}

function bindHighlightActions(container) {
  container.querySelectorAll('.note-action-btn.delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      void runPopupUiMutation('delete-note', async () => {
        const noteSlug = btn.closest('.highlight-item')?.dataset.noteSlug;
        if (!noteSlug) return;
        const response = await chrome.runtime.sendMessage({
          action: 'deleteNote',
          noteSlug,
        });
        requireSuccessfulResponse(response, 'deleteNote');
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab?.id) {
          chrome.tabs
            .sendMessage(tab.id, { action: 'removeHighlightMark', noteSlug })
            .catch((error) =>
              logDebug(
                '[popup] Highlight removal message had no receiver:',
                error.message,
              ),
            );
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
      if (!btn.classList.contains('edit')) return;
      const item = btn.closest('.highlight-item');
      const noteSlug = item?.dataset.noteSlug;
      const note = currentPage.notes.find((n) => n.slug === noteSlug);
      if (!note) return;
      openHighlightNoteEditor(item, note);
    });
  });
}

function openHighlightNoteEditor(item, note) {
  extensionSurface.openHighlightNoteEditor({
    item,
    note,
    placeholder: tr('extensionAddNote', 'Add a note...', undefined),
    confirmTitle: tr('commonConfirm', 'Confirm', undefined),
    editTitle: tr('extensionEditNote', 'Edit note', undefined),
    save: (nextNote) =>
      runPopupUiMutation('save-highlight-note', async () => {
        const response = requireSuccessfulResponse(
          await chrome.runtime.sendMessage({
            action: 'updateNote',
            noteSlug: item.dataset.noteSlug,
            note: nextNote,
          }),
          'updateNote',
        );
        if (typeof response.noteSlug !== 'string' || !response.noteSlug) {
          throw new Error('updateNote response missing noteSlug');
        }
        return response;
      }),
    onSaved(response) {
      note.slug = response.noteSlug;
      renderNotes(currentPage.notes);
    },
    onError(error) {
      showErrorBubble(error.message);
    },
  });
}

// Lists — pin current page to lists
function applyPinStateToLists(lists, listId, pinned) {
  if (!Array.isArray(lists)) return;
  const list = lists.find((candidate) => candidate.slug === listId);
  if (!list) return;
  list.containsPage = pinned;
  if (pinned) list.lastActivity = Date.now();
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
  const nextCount = lists.filter((list) => list.containsPage).length;
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
      const lists = currentPage.summary?.lists || [];
      openListPicker(lists);
    }).catch((err) => showErrorBubble(err.message));
  }
}

async function renderListChips(listOverride = null) {
  const container = document.getElementById('listChips');
  const lists = listOverride ?? currentPage.summary?.lists;
  if (!Array.isArray(lists)) {
    throw new Error('Popup list projection must be an array');
  }

  // Partition into lists containing this page vs. others
  const containsPage = [];
  const others = [];
  for (const list of lists) {
    if (list.containsPage) {
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
    return { list, lastActivity: list.lastActivity || 0 };
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
      const pinned = list.containsPage;
      chip.classList.toggle('selected', pinned);
      chip.dataset.listId = list.slug;
      chip.textContent = list.name;
    });
  } else {
    let html = displayLists
      .map((list) => {
        const pinned = list.containsPage;
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

function requireListPinToggleResponse(response) {
  requireSuccessfulResponse(response, 'toggleListPin');
  if (typeof response.pinned !== 'boolean') {
    throw new Error('toggleListPin response missing boolean pinned');
  }
  return response.pinned;
}

function requireSuccessfulResponse(response, action) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`${action} returned no response`);
  }
  if (response.success !== true) {
    throw new Error(response.error || `${action} failed`);
  }
  return response;
}

async function toggleListPin(listId) {
  const response = await sendListPinToggle(listId);
  const pinned = requireListPinToggleResponse(response);
  applyLocalListPinState(listId, pinned);
  syncListChipToggle(listId, pinned);
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
  if (!wrap || !picker) return null;
  const input = picker.querySelector('#listSearchInput');
  if (!wrap.isConnected || !picker.isConnected || !input) return null;
  const gap = 5;
  const listMaxHeight = 160;
  const listMinHeight = 48;
  const fixedTop = Number.isFinite(options.fixedTop) ? options.fixedTop : null;
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
  const hasBelowSpace = belowSpace >= listMinHeight;
  let pickerTop = belowTop;
  let listHeight = Math.min(preferredListHeight, Math.max(0, belowSpace));

  if (fixedTop !== null) {
    pickerTop = fixedTop;
    listHeight = Math.min(
      preferredListHeight,
      Math.max(
        0,
        viewportHeight - pickerTop - inputHeight - gap - pickerFrameHeight,
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
  return pickerTop;
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

function openListPicker(lists, options = {}) {
  const { initialQuery = '', inputElement = null } = options;
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
  let activePickerIndex = -1;
  let pickerScrollTop = 0;
  let fixedPickerTop = null;

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
    const pickerTop = positionListPickerOverlay(wrap, picker, {
      fixedTop: fixedPickerTop,
      listContentHeight: renderedHeight || optionsEl.scrollHeight,
    });
    if (fixedPickerTop === null && pickerTop !== null) {
      fixedPickerTop = pickerTop;
    }
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
      const pinned = requireListPinToggleResponse(response);
      applyLocalListPinState(listId, pinned);
      applyPinStateToLists(pickerLists, listId, pinned);
      const chipSynced = syncListChipToggle(listId, pinned);
      const pickerSynced = syncListPickerOptionToggle(listId, pinned);
      if (!chipSynced || !pickerSynced) {
        await renderListChips(currentPage.summary?.lists || pickerLists);
      }
      return true;
    } catch (err) {
      showErrorBubble(err.message);
      return true;
    }
  }

  function renderPickerRows() {
    if (!isCurrentPicker()) return;
    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? pickerLists.filter((c) => c.name.toLowerCase().startsWith(query))
      : pickerLists;

    let rowsHtml = filtered
      .map((c) => {
        const pinned = c.containsPage;
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

  return { input };
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
  if (!currentPage.summary) {
    await popupInitialization;
    if (!currentPage.summary || popupShellState.surface !== 'dashboard') return;
  }
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
  try {
    const lists = currentPage.summary?.lists || [];
    const pickerController = openListPicker(lists, { inputElement });
    if (initialQuery && pickerController?.input && !inputElement) {
      pickerController.input.value = initialQuery;
      pickerController.input.dispatchEvent(
        new Event('input', { bubbles: true }),
      );
      setListSearchInputCursorToEnd(pickerController.input);
    }
  } catch (error) {
    showErrorBubble(error.message);
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
  const lists = currentPage.summary?.lists || [];
  if (lists.some((c) => c.name === name)) return;

  const resp = await chrome.runtime.sendMessage({
    action: 'createListAndPin',
    name,
    url: currentPage.url,
    title: currentPage.title || currentPage.tab?.title || '',
  });
  requireSuccessfulResponse(resp, 'createListAndPin');
  const listId = resp?.listId;
  if (!listId || resp.pinned !== true) {
    throw new Error('Desktop did not create and pin the list');
  }

  const list = {
    slug: listId,
    name,
    containsPage: true,
    lastActivity: Date.now(),
  };
  lists.push(list);
  await renderListChips(lists);

  logDebug('[popup] Created list and pinned page:', name, listId);
}

// Recording pause state is session-only and shared with content/background code
// through the single `workspace: { mode }` schema.
async function loadRecordingState() {
  if (recordingUiState.hydrated) {
    return { paused: recordingUiState.paused };
  }
  const { workspace } = await chrome.storage.session.get(['workspace']);
  if (
    workspace !== undefined &&
    (!workspace ||
      typeof workspace !== 'object' ||
      Array.isArray(workspace) ||
      (workspace.mode !== 'default' && workspace.mode !== 'private'))
  ) {
    throw new Error('Stored recording state must have mode default or private');
  }
  recordingUiState.paused = workspace?.mode === 'private';
  recordingUiState.hydrated = true;
  applyRecordingBarState();
  return { paused: recordingUiState.paused };
}

async function saveRecordingState(paused) {
  requireSuccessfulResponse(
    await chrome.runtime.sendMessage({
      action: 'setRecordingPaused',
      paused,
    }),
    'setRecordingPaused',
  );
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
      const response = await chrome.runtime.sendMessage({
        action: 'recordPageActivity',
        url,
        title: currentPage.tab.title || null,
        slug: generateSlugFromUrl(url),
        isInitialLoad: true,
      });
      requireSuccessfulResponse(response, 'recordPageActivity');
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
        const response = await chrome.runtime.sendMessage({
          action: 'recordPageActivity',
          url: currentPage.entry.url,
          user_title: newTitle,
        });
        requireSuccessfulResponse(response, 'recordPageActivity');
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
      if (resp?.success === true) {
        await refreshCurrentPageSummary();
        if (resp.warning) {
          await notifyActivePageError(resp.warning, resp.warning);
        }
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
  const title = tab._effectiveTitle || tab.title || '';
  const slug = tab._effectiveSlug || generateSlugFromUrl(effectiveUrl);
  return { slug, url: effectiveUrl, title };
}

function transientPageView(slug, summary) {
  return {
    slug,
    url: summary.url,
    title: summary.displayTitle,
    visitDates: [],
    hasSnapshots: false,
    transient: true,
  };
}

function validatePopupSummary(summary) {
  if (
    summary?.success !== true ||
    typeof summary.url !== 'string' ||
    typeof summary.displayTitle !== 'string' ||
    typeof summary.access?.blacklisted !== 'boolean' ||
    typeof summary.access?.hasVisitHistory !== 'boolean' ||
    !Array.isArray(summary.notes) ||
    !Array.isArray(summary.snapshots) ||
    !Array.isArray(summary.lists) ||
    (summary.page !== null &&
      (typeof summary.page !== 'object' || Array.isArray(summary.page)))
  ) {
    throw new Error('Desktop returned an incomplete popup summary');
  }
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
      title: currentPage.title || tab.title || '',
    });
    if (generation !== currentPage.generation) return false;
    logDebug('[popup] getPageSummary response:', summary);

    if (summary?.success) {
      validatePopupSummary(summary);
      if (summary.access.blacklisted && !summary.access.hasVisitHistory) {
        currentPage.pageSummaryState = 'succeeded';
        renderBlacklistDiagnostic(
          tab,
          summary.url || currentPage.url || tab.url,
        );
        return false;
      }
      if (resetSections) resetDashboardSections();
      else clearPageDiagnosticSection();
      const page = summary.page || transientPageView(slug, summary);
      const title = page.user_title ? page.user_title : summary.displayTitle;
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
        if (summary.notes.length > 0) {
          await refreshHighlightMarkupState();
          if (generation !== currentPage.generation) return false;
        }
        renderNotes(summary.notes);
      }
      logDebug(
        `[popup] Loaded ${summary.notes.length} notes, ${summary.snapshots.length} snapshots, ${summary.lists.length} lists`,
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
        showSetupRequired(connector);
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
      showSetupRequired(connector);
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
  if (renderLists) {
    followUps.unshift(renderListChips(currentPage.summary?.lists || []));
  }
  await Promise.all(followUps);
}

function listMutationTargetsCurrentPage(request) {
  if (request?.type === 'lists') return true;
  if (request?.type !== 'pins') return false;
  const urls = [request.url, ...(request.urls || [])].filter(
    (url) => typeof url === 'string' && url,
  );
  if (urls.length === 0) return true;
  return urls.some((url) => generateSlugFromUrl(url) === currentPage.slug);
}

function scheduleLiveListRefresh(request) {
  if (!currentPage.slug) {
    pendingLiveListMutation = request;
    return;
  }
  if (!listMutationTargetsCurrentPage(request) || liveListRefreshQueued) return;
  liveListRefreshQueued = true;
  void enqueuePopupUiMutation('refresh-live-list-mutation', async () => {
    liveListRefreshQueued = false;
    await refreshCurrentPageSummary({
      renderSections: false,
      renderLists: true,
    });
  }).catch((error) => {
    liveListRefreshQueued = false;
    logDebug('[popup] live list refresh failed:', error.message);
  });
}

function schedulePendingLiveListRefresh() {
  const request = pendingLiveListMutation;
  pendingLiveListMutation = null;
  if (request) scheduleLiveListRefresh(request);
}

chrome.runtime.onMessage.addListener((request) => {
  if (request?.action === 'mutation') scheduleLiveListRefresh(request);
});

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
  frame(() => {
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

async function finishDashboardRender(tab, generation) {
  await renderRecordingBar();
  if (generation !== currentPage.generation) return;
  showDashboardUI({ updateRecordingBar: false });
  scheduleDelayedTitleCheck(tab, tab.title || '');
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
  await renderListChips(currentPage.summary.lists);
  if (generation !== currentPage.generation) return;
  await finishDashboardRender(tab, generation);
  schedulePendingLiveListRefresh();
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

function isSnapshotViewerUrl(url) {
  return url.startsWith(chrome.runtime.getURL('snapshot-viewer.html'));
}

async function resolveEffectiveUrl(tab) {
  const response = await chrome.runtime.sendMessage({
    action: 'resolvePopupPageIdentity',
    tabId: tab.id,
  });
  const identity = response?.identity;
  if (
    response?.success !== true ||
    !identity ||
    typeof identity.slug !== 'string' ||
    !identity.slug ||
    typeof identity.url !== 'string' ||
    !identity.url ||
    typeof identity.title !== 'string'
  ) {
    throw new Error(
      response?.error || 'Popup page identity response is invalid',
    );
  }
  tab._effectiveSlug = identity.slug;
  tab._effectiveUrl = identity.url;
  tab._effectiveTitle = identity.title;
}

async function handlePrivateMode(tab) {
  const { paused } = await loadRecordingState();
  if (!paused) return false;
  currentPage.tab = tab;
  renderBannerOnly();
  revealPopup();
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
              const activityResponse = await chrome.runtime.sendMessage({
                action: 'recordPageActivity',
                url: effectiveUrl,
                title: tab.title || null,
                slug,
                isInitialLoad: true,
                bypassBlacklist: true,
              });
              requireSuccessfulResponse(activityResponse, 'recordPageActivity');
              const resp = await chrome.runtime.sendMessage({
                action: 'captureCurrentPageFromPopup',
              });
              if (resp?.success === true && resp.warning) {
                await notifyPageError({
                  tabId: tab.id,
                  message: resp.warning,
                  fallback: resp.warning,
                });
              } else if (resp?.success !== true) {
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
  return new URL(window.location.href).searchParams.get('bootstrap');
}

async function consumePopupBootstrap() {
  const token = popupBootstrapToken();
  if (!token) return null;
  // Background prepared the popup model before opening this URL. The token is
  // an in-memory one-shot handoff, not extension-side product persistence.
  const response = await chrome.runtime.sendMessage({
    action: 'consumePopupBootstrap',
    token,
  });
  if (response?.success !== true) {
    throw new Error(response?.error || 'Popup bootstrap consume failed');
  }
  if (
    !response.bootstrap ||
    typeof response.bootstrap !== 'object' ||
    Array.isArray(response.bootstrap)
  ) {
    throw new Error('Popup bootstrap response is missing its prepared model');
  }
  return response.bootstrap;
}

async function renderPreparedDashboard(bootstrap) {
  const generation = nextCurrentPageGeneration();
  const tab = bootstrap.tab;
  const identity = bootstrap.identity;
  const summary = bootstrap.summary;
  if (!tab || !identity || typeof identity !== 'object') {
    throw new Error('Prepared popup is missing tab identity');
  }
  if (
    typeof identity.slug !== 'string' ||
    typeof identity.url !== 'string' ||
    typeof identity.title !== 'string'
  ) {
    throw new Error('Prepared popup identity is incomplete');
  }
  validatePopupSummary(summary);
  const slug = identity.slug;
  const url = identity.url;
  const page = summary.page || transientPageView(slug, summary);
  const title = page.user_title || summary.displayTitle;

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
  renderSnapshots(summary.snapshots);
  if (summary.notes.length > 0) {
    await refreshHighlightMarkupState();
    if (generation !== currentPage.generation) return;
  }
  renderNotes(summary.notes);
  await renderListChips(summary.lists);
  if (generation !== currentPage.generation) return;
  await finishDashboardRender(tab, generation);
  schedulePendingLiveListRefresh();
}

async function renderPreparedPopup(bootstrap) {
  if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) {
    throw new Error('Prepared popup model must be an object');
  }
  if (typeof bootstrap.mode !== 'string') {
    throw new Error('Prepared popup model is missing its mode');
  }
  if (bootstrap.connector) applyDesktopConnectorUi(bootstrap.connector);

  switch (bootstrap.mode) {
    case 'setup':
      showSetupRequired(bootstrap.connector);
      return;
    case 'unavailable':
      if (typeof bootstrap.message !== 'string' || !bootstrap.message) {
        throw new Error('Unavailable popup model is missing its message');
      }
      showUnavailablePage(bootstrap.message);
      return;
    case 'private': {
      if (!bootstrap.tab || typeof bootstrap.tab !== 'object') {
        throw new Error('Private popup model is missing its tab');
      }
      currentPage.tab = bootstrap.tab;
      renderBannerOnly();
      revealPopup();
      return;
    }
    case 'blacklisted': {
      if (
        !bootstrap.tab ||
        typeof bootstrap.tab !== 'object' ||
        typeof bootstrap.identity?.url !== 'string' ||
        !bootstrap.identity.url
      ) {
        throw new Error('Blacklisted popup model is missing its page identity');
      }
      renderBlacklistDiagnostic(bootstrap.tab, bootstrap.identity.url);
      return;
    }
    case 'data-unavailable':
      if (typeof bootstrap.error !== 'string' || !bootstrap.error) {
        throw new Error('Data-unavailable popup model is missing its error');
      }
      showDesktopDataUnavailable(bootstrap.error, bootstrap.diagnostic);
      return;
    case 'dashboard':
      await renderPreparedDashboard(bootstrap);
      return;
    default:
      throw new Error(`Unknown prepared popup mode: ${bootstrap.mode}`);
  }
}

// Initialize popup
async function loadConnectedDashboard(connector) {
  await verifyDeviceIdentity(connector);

  const tab = await resolveActiveTab();
  if (!tab) return;
  await resolveEffectiveUrl(tab);
  if (await handlePrivateMode(tab)) return;
  setPopupSurface('dashboard-shell', { reveal: false });
  await showDashboard(tab);
}

async function initPopup() {
  await initializeExtensionI18n();
  localizeDocument();
  await applyTheme();
  const bootstrap = await consumePopupBootstrap();
  if (bootstrap) {
    await renderPreparedPopup(bootstrap);
    return;
  }

  const connector = await refreshDesktopConnectorState();
  if (connector.state !== 'connected' || !connector.deviceId) {
    showSetupRequired(connector);
    return;
  }

  await loadConnectedDashboard(connector);
}
ensureListSearchCapture();
listSearchInput().focus({ preventScroll: true });
const popupInitialization = initPopup();
popupInitialization.catch((err) => showFatalError(err.message));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!hasConnectorStateStorageChange(changes)) return;
  void (async () => {
    const connector = setupRequiredVisible()
      ? await refreshDesktopConnectorState()
      : await getCachedDesktopConnectorState();
    applyDesktopConnectorUi(connector);
    if (setupRequiredVisible()) {
      await loadDashboardIfConnected(connector);
    }
  })();
});
