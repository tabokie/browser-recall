// Popup — current-page dashboard
import {
  generateSlugFromUrl,
  escapeHtml,
  isInternalBrowserUrl,
} from './utils.js';
import { logDebug, logError } from './logger.js';
import { applyTheme } from './theme.js';
import { pageKey } from './entity-types.js';
import {
  hasConnectorStateStorageChange,
  readCachedConnectorState,
  requestConnectorBridgeConnect,
  requestConnectorState,
} from './connector/state.js';

let currentSlug = '';
let currentNotes = [];
let currentEntry = null;
let currentPageSummary = null;
let currentUrl = '';
let currentTitle = '';
let currentTab = null;
let detachedContent = null; // holds dashboardContent when recording is paused
let frozenChipOrder = null; // Array of list slugs — frozen on first render to keep order stable
let _noteSaveTimeout = null;
let desktopConnectInFlight = false;
let dashboardGeneration = 0;
let dashboardLoadInFlight = null;

// ─── Error UI ────────────────────────────────────────────────────────

function showFatalError(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:999999;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  overlay.innerHTML = `
    <div style="color:#b41e1e;font-size:14px;font-weight:600;">Storage Unavailable</div>
    <div style="color:#555;font-size:12px;max-width:360px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:6px;padding:4px 12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:12px;">Reload Extension</button>
  `;
  document.body.appendChild(overlay);
  overlay
    .querySelector('#fatalReloadBtn')
    .addEventListener('click', () => chrome.runtime.reload());
  revealPopup();
}

let _errorBubbleTimer = null;

function revealPopup() {
  document.documentElement.style.opacity = '';
}

function revealSetupIfStillWaiting() {
  if (document.documentElement.style.opacity !== '0') return;
  if (document.getElementById('setup-required')?.style.display === 'block') {
    revealPopup();
  }
}

function showSetupRequired(connector = {}, options = {}) {
  const { reveal = true } = options;
  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklisted').style.display = 'none';
  document.getElementById('dashboard').style.display = 'none';
  clearSetupDiagnostic();
  const el = document.getElementById('setup-required');
  el.style.display = 'block';
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
  if (reveal) revealPopup();
}

function showUnavailablePage(message = 'Not available for this page') {
  const loading = document.getElementById('loading');
  loading.textContent = message;
  loading.style.display = 'flex';
  document.getElementById('setup-required').style.display = 'none';
  clearSetupDiagnostic();
  document.getElementById('blacklisted').style.display = 'none';
  document.getElementById('dashboard').style.display = 'none';
  revealPopup();
}

function openDesktopApp(route = 'open') {
  window.open(`browser-recall://${route}`);
  window.close();
}

function showErrorBubble(message) {
  let displayMessage = message;
  if (globalThis.browserRecallWebExtension?.isRuntimeFailure?.(message)) {
    displayMessage =
      'Extension context invalidated. Please refresh the page and try again.';
  } else {
    displayMessage = message + ' — please reload the extension.';
  }
  let bubble = document.getElementById('errorBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'errorBubble';
    bubble.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:6px 14px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:360px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = displayMessage;
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => {
    bubble.style.opacity = '0';
  }, 4000);
}

function autoResizeTextarea(textarea) {
  textarea.style.height = '0';
  textarea.style.height = textarea.scrollHeight + 'px';
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

function formatConnectorDiagnostic(diagnostic) {
  if (!diagnostic?.code) return '';
  switch (diagnostic.code) {
    case 'no_ports_reachable': {
      const summary = formatPortFailures(diagnostic.failures);
      return summary
        ? `Last check: no usable desktop connection (${summary}).`
        : 'Last check: no usable desktop connection.';
    }
    case 'manual_reconnect_exhausted': {
      const seconds = diagnostic.elapsedMs
        ? `${Math.round(diagnostic.elapsedMs / 1000)}s`
        : 'the retry window';
      const summary = formatPortFailures(diagnostic.failures);
      const reason = summary
        ? ` Last port failures: ${summary}.`
        : diagnostic.lastDiagnostic
          ? ` Last diagnostic: ${diagnostic.lastDiagnostic}.`
          : '';
      return `Last check: desktop connection did not succeed in ${seconds}.${reason}`;
    }
    case 'manual_status_failed':
      return diagnostic.message
        ? `Last check: status refresh failed (${diagnostic.message}).`
        : 'Last check: status refresh failed.';
    case 'socket_closed':
      return diagnostic.state
        ? `Last check: socket closed (${diagnostic.state}).`
        : 'Last check: socket closed.';
    case 'auth_fail':
      return 'Last check: desktop rejected the saved token.';
    case 'pair_denied':
      return 'Last check: desktop approval was denied.';
    case 'status_after_auth_failed':
      return diagnostic.message
        ? `Last check: authenticated, but status failed (${diagnostic.message}).`
        : 'Last check: authenticated, but status failed.';
    default:
      if (diagnostic.message) return `Last check: ${diagnostic.message}`;
      return `Last check: ${diagnostic.code.replaceAll('_', ' ')}.`;
  }
}

function formatPortFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  return failures
    .slice(0, 5)
    .map((failure) => `${failure.port}: ${failure.code}`)
    .join(', ');
}

function appendConnectorDiagnostic(meta, connector) {
  if (!connector?.lastDiagnostic) return meta;
  const detail = formatConnectorDiagnostic(connector.lastDiagnostic);
  return detail ? `${meta} ${detail}` : meta;
}

function formatDesktopConnectorState(connector = {}) {
  const state = connector.state || 'offline';

  switch (state) {
    case 'connected':
      return {
        status: 'Desktop Connected',
        meta: connector.deviceId
          ? `Device ${connector.deviceId}`
          : 'Desktop connection active.',
        tone: '',
      };
    case 'paused':
      return {
        status: 'Desktop Paused',
        meta: appendConnectorDiagnostic(
          'Resume capture from desktop settings.',
          connector,
        ),
        tone: 'error',
      };
    case 'pair_pending':
      return {
        status: 'Approval Pending',
        meta: appendConnectorDiagnostic(
          'Approve this browser in the desktop app.',
          connector,
        ),
        tone: '',
      };
    case 'pair_denied':
      return {
        status: 'Approval Denied',
        meta: appendConnectorDiagnostic(
          'Check again to request approval.',
          connector,
        ),
        tone: 'error',
      };
    case 'auth_failed':
      return {
        status: 'Token Rejected',
        meta: appendConnectorDiagnostic(
          'Check again to request approval.',
          connector,
        ),
        tone: 'error',
      };
    case 'starting':
      return {
        status: 'Desktop Offline',
        meta: appendConnectorDiagnostic(
          'Start Browser Recall Desktop to resume live capture.',
          connector,
        ),
        tone: '',
      };
    case 'connecting':
      return {
        status: 'Desktop Offline',
        meta: appendConnectorDiagnostic(
          connector.hasToken
            ? 'Desktop approved, but connection failed.'
            : 'Start Browser Recall Desktop to resume live capture.',
          connector,
        ),
        tone: '',
      };
    case 'offline':
    default:
      if (connector.refuseMode) {
        return {
          status: 'Desktop Queue Full',
          meta: 'Open desktop to flush capture.',
          tone: 'error',
        };
      }
      return {
        status: 'Desktop Offline',
        meta: connector.hasToken
          ? appendConnectorDiagnostic(
              'Desktop approved, but connection failed.',
              connector,
            )
          : appendConnectorDiagnostic(
              'Start Browser Recall Desktop to resume live capture.',
              connector,
            ),
        tone: 'error',
      };
  }
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
    element.textContent = pending ? 'Waiting for Approval' : 'Check Again';
    element.classList.toggle('is-checking', checking);
  }
}

function showDesktopConnectorError(message) {
  applyDesktopConnectorUi({ state: 'offline', hasToken: false });
  const title = document.getElementById('setupRequiredTitle');
  if (title) title.textContent = 'Desktop Offline';
  const meta = document.getElementById('setupRequiredMeta');
  if (meta)
    meta.textContent =
      message || 'Start Browser Recall Desktop to resume live capture.';
}

function showDesktopUnavailable(
  message = 'Browser Recall Desktop is offline.',
) {
  showSetupRequired({ state: 'offline', hasToken: true });
  const title = document.getElementById('setupRequiredTitle');
  if (title) {
    title.textContent =
      message === 'Browser Recall Desktop is offline.'
        ? 'Desktop Offline'
        : message;
  }
  const meta = document.getElementById('setupRequiredMeta');
  if (meta)
    meta.textContent = 'Start Browser Recall Desktop to resume live capture.';
}

function showDesktopDataUnavailable(
  message = 'Desktop page data unavailable.',
  diagnostic = null,
) {
  showSetupRequired({ state: 'connected' });
  const title = document.getElementById('setupRequiredTitle');
  if (title) title.textContent = 'Page Data Unavailable';
  const meta = document.getElementById('setupRequiredMeta');
  if (meta) meta.textContent = message;
  renderSetupDiagnostic(diagnostic);
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
  for (const id of [
    'visitsLikesSection',
    'listSection',
    'notesSection',
    'snapshotSection',
  ]) {
    hideSection(id);
    document.getElementById(id)?.classList.remove('is-empty');
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

async function refreshDesktopConnectorState() {
  try {
    const connector = await requestConnectorState();
    applyDesktopConnectorUi(connector);
    return connector;
  } catch (error) {
    showDesktopConnectorError(error.message || 'Desktop bridge unavailable.');
    return null;
  }
}

async function getCachedDesktopConnectorState() {
  return readCachedConnectorState();
}

function setupRequiredVisible() {
  return document.getElementById('setup-required')?.style.display === 'block';
}

async function loadDashboardIfConnected(connector) {
  if (connector?.state !== 'connected' || !connector?.deviceId) return false;
  if (dashboardLoadInFlight) {
    await dashboardLoadInFlight;
    return true;
  }
  dashboardLoadInFlight = loadConnectedDashboard(connector).finally(() => {
    dashboardLoadInFlight = null;
  });
  await dashboardLoadInFlight;
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
    showDesktopConnectorError(error.message || 'Failed to refresh.');
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
        <button class="delete-btn" data-ts="${snap.timestamp}" title="Delete snapshot">&times;</button>
      </span>
    </div>
  `,
    )
    .join('');

  // Attach delete handlers
  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ts = parseInt(btn.dataset.ts, 10);
      await chrome.runtime.sendMessage({
        action: 'deleteSnapshot',
        slug: currentSlug,
        timestamp: ts,
      });
      await refreshCurrentPageSummary();
    });
  });

  // Double-click to open snapshot in new tab
  container.querySelectorAll('.snapshot-row').forEach((row) => {
    row.addEventListener('dblclick', async () => {
      const ts = parseInt(row.dataset.ts, 10);
      await chrome.runtime.sendMessage({
        action: 'openSnapshot',
        slug: currentSlug,
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
      d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    const sorted = [...visitDates].sort((a, b) => a - b);
    const first = parse(sorted[0]);
    items.push(
      `<span class="attention-item"><strong>First</strong><span class="metric-value">${fmtDate(first)}</span></span>`,
    );
  }

  const likes = entry?.likes || 0;
  if (likes > 0) {
    items.push(
      `<span class="attention-item"><strong>Liked</strong><span class="metric-value">${likes}</span></span>`,
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
    wrap.innerHTML = `<button class="page-note-add" id="pageNoteAddBtn">+ Page note</button>`;
    wrap.querySelector('#pageNoteAddBtn').addEventListener('click', () => {
      openPageNoteEditor(wrap, '', '');
    });
  } else {
    wrap.innerHTML = `<div class="page-note-display">
      <span class="note-body">${escapeHtml(noteText)}</span>
      <button class="note-action-btn edit" title="Edit">${ICON_EDIT}</button>
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
  wrap.innerHTML = `<textarea class="page-note-edit-textarea" placeholder="Add a page note...">${escapeHtml(text)}</textarea>`;
  const ta = wrap.querySelector('textarea');
  ta.dataset.noteSlug = slug;
  autoResizeTextarea(ta);
  ta.focus();

  let saveTimeout = null;
  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => savePageNote(ta), 500);
  });
  ta.addEventListener('blur', () => {
    clearTimeout(saveTimeout);
    savePageNote(ta).then(() => {
      const note = currentNotes.find((n) => n.excerpt === null);
      if (note) {
        note.note = ta.value;
        note.slug = ta.dataset.noteSlug;
      } else if (ta.value && ta.dataset.noteSlug) {
        currentNotes.push({
          excerpt: null,
          note: ta.value,
          slug: ta.dataset.noteSlug,
        });
      }
      const globalNote = currentNotes.find((n) => n.excerpt === null);
      if (!ta.value) {
        currentNotes = currentNotes.filter((n) => n.excerpt !== null);
      }
      renderPageNoteWrap(currentNotes.find((n) => n.excerpt === null));
    });
  });
}

async function savePageNote(ta) {
  const note = ta.value;
  const noteSlug = ta.dataset.noteSlug;
  try {
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
        pageSlug: currentSlug,
        url: currentUrl,
        excerpt: null,
        note,
        cssPath: null,
      });
      if (resp?.noteSlug) {
        ta.dataset.noteSlug = resp.noteSlug;
      }
    }
  } catch (error) {
    logError('[popup] Page note save error:', error);
  }
}

function renderNotes(notes) {
  if (_noteSaveTimeout) {
    clearTimeout(_noteSaveTimeout);
    _noteSaveTimeout = null;
  }
  const container = document.getElementById('highlightList');
  const section = document.getElementById('notesSection');
  currentNotes = notes || [];

  const globalNote = currentNotes.find((n) => n.excerpt === null);
  renderPageNoteWrap(globalNote);

  const textNotes = currentNotes.filter((n) => n.excerpt !== null);
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
      const displayText = Array.isArray(n.excerpt)
        ? n.excerpt.join(' ')
        : n.excerpt;
      const noteText = n.note || '';
      const noteDisplay = noteText
        ? `<span class="highlight-note-text">${escapeHtml(noteText)}</span>`
        : `<span class="highlight-note-placeholder">No annotation</span>`;
      return `
      <div class="highlight-item" data-note-slug="${escapeHtml(n.slug)}" data-note-index="${String(index + 1).padStart(2, '0')}">
        <div class="highlight-header">
          <div class="highlight-excerpt">${escapeHtml(displayText)}</div>
          <button class="note-action-btn delete" data-note-slug="${escapeHtml(n.slug)}" title="Delete highlight">${ICON_DELETE}</button>
        </div>
        <div class="highlight-body">
          <div class="highlight-note-row">
            ${noteDisplay}
            <button class="note-action-btn edit" title="Edit note">${ICON_EDIT}</button>
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
    btn.addEventListener('click', async () => {
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
      currentNotes = currentNotes.filter((n) => n.slug !== noteSlug);
      renderNotes(currentNotes);
    });
  });

  container.querySelectorAll('.note-action-btn.edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.highlight-item');
      const noteSlug = item?.dataset.noteSlug;
      const note = currentNotes.find((n) => n.slug === noteSlug);
      if (!note) return;
      openHighlightNoteEditor(item, note);
    });
  });
}

function openHighlightNoteEditor(item, note) {
  const body = item.querySelector('.highlight-body');
  body.innerHTML = `<textarea class="highlight-note-edit-textarea" placeholder="Add a note...">${escapeHtml(note.note || '')}</textarea>`;
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
        const resp = await chrome.runtime.sendMessage({
          action: 'updateNote',
          noteSlug: slug,
          note: ta.value,
        });
        if (resp?.noteSlug && resp.noteSlug !== slug) {
          item.dataset.noteSlug = resp.noteSlug;
          note.slug = resp.noteSlug;
        }
      } catch (error) {
        logError('[popup] Note save error:', error);
      }
    }, 500);
  });

  ta.addEventListener('blur', () => {
    renderNotes(currentNotes);
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
      currentPageSummary = {
        ...(currentPageSummary || {}),
        lists,
      };
      return lists;
    } catch (error) {
      logDebug('[popup] getPopupLists failed:', error.message);
    }
  }

  return currentPageSummary?.lists || [];
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

async function renderListChips() {
  const container = document.getElementById('listChips');
  const lists = await loadLists();
  const allPins = await loadListPins(lists);

  // Partition into lists containing this page vs. others
  const containsPage = [];
  const others = [];
  for (const list of lists) {
    if (isPagePinned(allPins, list.slug, currentUrl)) {
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

  let html = displayLists
    .map((list) => {
      const pinned = isPagePinned(allPins, list.slug, currentUrl);
      return `<span class="list-chip${pinned ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${list.slug}">${escapeHtml(list.name)}</span>`;
    })
    .join('');

  html += `<span class="list-add-btn" id="listAddBtn" title="Add to list">+</span>`;

  container.innerHTML = html;

  // Toggle existing chips
  container.querySelectorAll('.list-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      try {
        const listId = chip.dataset.listId;
        await toggleListPin(listId);
        renderListChips();
      } catch (err) {
        showErrorBubble(err.message);
      }
    });
  });

  // + button opens picker dropdown
  document.getElementById('listAddBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (document.getElementById('listPicker')) {
      closeListPicker();
      return;
    }
    try {
      const freshLists = await loadLists();
      const freshPins = await loadListPins(freshLists);
      openListPicker(freshLists, freshPins);
    } catch (err) {
      showErrorBubble(err.message);
      openListPicker(lists, allPins);
    }
  });
  showSection('listSection');
}

async function toggleListPin(listId) {
  await chrome.runtime.sendMessage({
    action: 'toggleListPin',
    listId,
    url: currentUrl,
    title: currentTitle || currentTab?.title || '',
  });
  await refreshCurrentPageSummary();
}

function closeListPicker() {
  const existing = document.getElementById('listPicker');
  if (existing) existing.remove();
  document.removeEventListener('click', pickerOutsideClickHandler);
}

function pickerOutsideClickHandler(e) {
  const picker = document.getElementById('listPicker');
  if (picker && !picker.contains(e.target) && e.target.id !== 'listAddBtn') {
    closeListPicker();
  }
}

function openListPicker(lists, allPins) {
  // Close if already open
  if (document.getElementById('listPicker')) {
    closeListPicker();
    return;
  }

  const wrap = document.querySelector('.list-chips-wrap');
  const picker = document.createElement('div');
  picker.className = 'list-picker';
  picker.id = 'listPicker';
  picker.innerHTML = `
    <input class="list-picker-input" id="listPickerInput" placeholder="Search or create..." />
    <div class="list-picker-list" id="listPickerList"></div>
  `;
  wrap.appendChild(picker);

  const input = document.getElementById('listPickerInput');
  const listEl = document.getElementById('listPickerList');

  function renderPickerRows() {
    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? lists.filter((c) => c.name.toLowerCase().includes(query))
      : lists;

    let rowsHtml = filtered
      .map((c) => {
        const pinned = isPagePinned(allPins, c.slug, currentUrl);
        return `<div class="list-picker-row${pinned ? ' selected' : ''}" role="button" tabindex="0" data-list-id="${c.slug}">
        <span class="list-picker-row-check">${pinned ? '&#10003;' : ''}</span>
        <span>${escapeHtml(c.name)}</span>
      </div>`;
      })
      .join('');

    // Show create option if input doesn't exactly match any existing list
    const inputVal = input.value.trim();
    if (inputVal) {
      const exactMatch = lists.some(
        (c) => c.name.toLowerCase() === inputVal.toLowerCase(),
      );
      if (!exactMatch) {
        rowsHtml += `<div class="list-picker-create" id="listPickerCreate" role="button" tabindex="0">Create "${escapeHtml(inputVal)}"</div>`;
      }
    }

    if (!rowsHtml) {
      rowsHtml = `<div style="padding: 8px 10px; font-size: 11px; color: #999; text-align: center;">No lists</div>`;
    }

    listEl.innerHTML = rowsHtml;

    // Attach click handlers to rows
    listEl.querySelectorAll('.list-picker-row').forEach((row) => {
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const listId = row.dataset.listId;
          await toggleListPin(listId);
          // Refresh allPins and re-render rows in place
          const freshPins = await loadListPins();
          Object.assign(allPins, freshPins);
          renderPickerRows();
          renderListChips();
        } catch (err) {
          showErrorBubble(err.message);
        }
      });
    });

    const createBtn = document.getElementById('listPickerCreate');
    if (createBtn) {
      createBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await createListAndPin(inputVal);
          closeListPicker();
          renderListChips();
        } catch (err) {
          showErrorBubble(err.message);
        }
      });
    }
  }

  renderPickerRows();
  // Use setTimeout to avoid the click event that opened the picker from immediately focusing away
  setTimeout(() => input.focus(), 0);

  input.addEventListener('input', renderPickerRows);

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const inputVal = input.value.trim();
      if (!inputVal) return;
      try {
        const exactMatch = lists.find(
          (c) => c.name.toLowerCase() === inputVal.toLowerCase(),
        );
        if (exactMatch) {
          await toggleListPin(exactMatch.slug);
          closeListPicker();
          renderListChips();
        } else {
          await createListAndPin(inputVal);
          closeListPicker();
          renderListChips();
        }
      } catch (err) {
        showErrorBubble(err.message);
      }
    } else if (e.key === 'Escape') {
      closeListPicker();
    }
  });

  // Close on outside click (deferred to avoid catching the opening click)
  setTimeout(() => {
    document.addEventListener('click', pickerOutsideClickHandler);
  }, 0);
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
  await refreshCurrentPageSummary();

  logDebug('[popup] Created list and pinned page:', name, listId);
}

// Recording pause state (session-only, not persisted to disk). The storage key
// remains "workspace" so content/background private-mode checks stay compatible.
async function loadRecordingState() {
  const { workspace } = await chrome.storage.session.get(['workspace']);
  return { paused: workspace?.mode === 'private' };
}

async function saveRecordingState(paused) {
  await chrome.storage.session.set({
    workspace: {
      mode: paused ? 'private' : 'default',
    },
  });
}

async function renderRecordingBar() {
  const { paused } = await loadRecordingState();
  const bar = document.getElementById('recordingBar');
  const button = document.getElementById('recordingToggle');
  const label = document.getElementById('recordingLabel');

  bar.classList.toggle('is-paused', paused);
  button.setAttribute('aria-pressed', paused ? 'true' : 'false');
  button.title = paused ? 'Resume tracing' : 'Pause tracing';
  label.textContent = 'BROWSER RECALL';
}

// Recording toggle handler
document
  .getElementById('recordingToggle')
  .addEventListener('click', async () => {
    const { paused } = await loadRecordingState();
    const nextPaused = !paused;
    await saveRecordingState(nextPaused);
    dashboardGeneration++;
    await renderRecordingBar();

    // Resuming recording: record the current page visit and show details.
    if (paused && !nextPaused && currentTab) {
      reattachDashboardContent();
      const url = currentTab._effectiveUrl || currentTab.url;
      await chrome.runtime.sendMessage({
        action: 'recordPageActivity',
        url,
        title: currentTab.title || null,
        slug: generateSlugFromUrl(url),
        isInitialLoad: true,
      });
      await showDashboard(currentTab);
      return;
    }

    // Pausing recording: remove page details from DOM.
    if (nextPaused) {
      const content = document.getElementById('dashboardContent');
      if (content) {
        detachedContent = content;
        content.remove();
      }
    }
  });

// Title editing
function startEditingTitle() {
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

    if (newTitle !== currentTitle && currentEntry) {
      currentEntry.user_title = newTitle;
      try {
        await chrome.runtime.sendMessage({
          action: 'recordPageActivity',
          url: currentEntry.url,
          user_title: newTitle,
        });
        logDebug('[popup] User title updated to:', newTitle);
      } catch (error) {
        logError('[popup] Failed to save user title:', error);
      }
    }
  }

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', (e) => {
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

// Open the desktop app to Explore. Page detail can be inaccurate before checkpointing.
document.querySelector('.recording-copy').addEventListener('click', () => {
  openDesktopApp();
});

for (const id of ['setupDesktopConnectBtn']) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.addEventListener('click', () => {
    void connectDesktopBridge();
  });
}

// Capture button handler
document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

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
      if (/extension context invalidated/i.test(resp?.error || '')) {
        showErrorBubble(resp.error);
      } else {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab)
          chrome.tabs
            .sendMessage(tab.id, {
              action: 'showErrorNotification',
              message: resp?.error || 'Capture failed',
            })
            .catch(() => {});
      }
    }
  } catch (error) {
    logError('[popup] Capture error:', error);
    if (/extension context invalidated/i.test(error.message || '')) {
      showErrorBubble(error.message);
      btn.disabled = false;
      btn.textContent = 'CAPTURE FRAME';
      return;
    }
    const [tab] = await chrome.tabs
      .query({ active: true, currentWindow: true })
      .catch(() => []);
    if (tab)
      chrome.tabs
        .sendMessage(tab.id, {
          action: 'showErrorNotification',
          message: error.message || 'Capture failed',
        })
        .catch(() => {});
  }

  btn.disabled = false;
  btn.textContent = 'CAPTURE FRAME';
});

// ─── showDashboard phases ────────────────────────────────────────────

function reattachDashboardContent() {
  if (detachedContent && !document.getElementById('dashboardContent')) {
    document.getElementById('dashboard').appendChild(detachedContent);
    detachedContent = null;
  }
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
  const url = summary.url || currentUrl || tab._effectiveUrl || tab.url;
  return {
    slug,
    url,
    title: currentTitle || tab.title || '<unknown>',
    visitDates: [],
    childIds: [],
    parentIds: [],
  };
}

async function fetchAndRenderPageData(tab, slug) {
  const generation = dashboardGeneration;
  currentEntry = null;

  try {
    logDebug(`[popup] Fetching page summary for url=${currentUrl || tab.url}`);
    const summary = await chrome.runtime.sendMessage({
      action: 'getPageSummary',
      url: currentUrl || tab.url,
    });
    if (generation !== dashboardGeneration) return false;
    logDebug('[popup] getPageSummary response:', summary);

    if (summary?.success) {
      const page = summary.page || pageSummaryFallback(tab, slug, summary);
      currentPageSummary = { ...summary, page };
      currentEntry = page;
      currentTitle = page.user_title
        ? page.user_title
        : await trimDisplayTitle(
            page.title || tab.title || '<unknown>',
            page.url || currentUrl || tab.url,
          );
      document.getElementById('pageTitle').textContent = currentTitle;
      if (page.url) {
        currentUrl = page.url;
        document.getElementById('pageUrl').textContent = page.url;
      }
      renderVisitsAndLikes(page);
      renderSnapshots(summary.snapshots);
      renderNotes(summary.notes);
      logDebug(
        `[popup] Loaded ${summary.notes?.length || 0} notes, ${summary.snapshots?.length || 0} snapshots, ${summary.lists?.length || 0} lists`,
      );
    } else {
      logDebug('[popup] getPageSummary returned failure:', summary);
      const connector = await refreshDesktopConnectorState();
      if (connector?.state === 'connected' && connector?.deviceId) {
        showDesktopDataUnavailable(
          summary?.error || 'Desktop page summary failed.',
          {
            reason: 'popup-page-summary-failed',
            summary,
            connector,
            url: currentUrl || tab.url,
          },
        );
      } else {
        showSetupRequired(connector || { state: 'offline', hasToken: true });
      }
      return false;
    }
  } catch (error) {
    if (generation !== dashboardGeneration) return false;
    logError('[popup] Could not load page summary:', error);
    const connector = await refreshDesktopConnectorState();
    if (connector?.state === 'connected' && connector?.deviceId) {
      showDesktopDataUnavailable(
        error.message || 'Desktop page summary failed.',
        {
          reason: 'popup-page-summary-error',
          error: error.message || String(error),
          connector,
          url: currentUrl || tab.url,
        },
      );
    } else {
      showSetupRequired(connector || { state: 'offline', hasToken: true });
    }
    return false;
  }
  return true;
}

async function refreshCurrentPageSummary() {
  if (!currentTab || !currentUrl) return;
  const generation = ++dashboardGeneration;
  const { paused } = await loadRecordingState();
  if (paused || !document.getElementById('dashboardContent')) {
    await renderRecordingBar();
    return;
  }
  const updated = await fetchAndRenderPageData(currentTab, currentSlug);
  if (!updated || generation !== dashboardGeneration) return;
  await Promise.all([renderListChips(), renderRecordingBar()]);
}

function showDashboardUI() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklisted').style.display = 'none';
  document.getElementById('setup-required').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
  document.getElementById('dashboardContent').style.display = 'block';
  revealPopup();

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
  });
}

function scheduleDelayedTitleCheck(tab, initialTitle) {
  if (currentEntry?.user_title) return;
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
      if (currentEntry) currentEntry.title = freshTitle;
      logDebug('[popup] Auto-updated title to:', freshTitle);
    } catch (error) {
      logDebug('[popup] Title re-check failed:', error);
    }
  }, 1000);
}

// Show dashboard for a tab: set up state, fetch data, render sections
async function showDashboard(tab) {
  const generation = ++dashboardGeneration;
  const previousSlug = currentSlug;
  reattachDashboardContent();

  const { slug, url, title } = await resolvePageIdentity(tab);
  if (generation !== dashboardGeneration) return;
  if (slug !== previousSlug) frozenChipOrder = null;
  currentUrl = url;
  currentTitle = title;
  currentSlug = slug;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageUrl').textContent = url;
  resetDashboardSections();
  showDashboardUI();
  void renderRecordingBar();
  scheduleDelayedTitleCheck(tab, tab.title || '');

  const updated = await fetchAndRenderPageData(tab, slug);
  if (!updated || generation !== dashboardGeneration) return;
  await renderListChips();
  if (generation !== dashboardGeneration) return;
}

// ─── Init phases ─────────────────────────────────────────────────────

async function verifyDeviceIdentity(connector) {
  if (connector?.deviceId) return connector.deviceId;
  throw new Error(
    'Browser Recall Desktop is not connected yet. Start the desktop app and refresh from the popup.',
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
    showUnavailablePage('Not available for this page');
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
  void tab;
  const { paused } = await loadRecordingState();
  if (!paused) return false;
  await renderRecordingBar();
  const content = document.getElementById('dashboardContent');
  detachedContent = content;
  content.remove();
  document.getElementById('loading').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
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
    throw new Error(response.error || 'Desktop popup access check failed');
  }
  if (!response?.blacklisted || response?.hasVisitHistory) return false;

  document.getElementById('loading').style.display = 'none';
  document.getElementById('blacklistedUrl').textContent = tab.url;
  document.getElementById('blacklisted').style.display = 'block';
  revealPopup();
  document
    .getElementById('blacklistSettingsLink')
    .addEventListener('click', () => {
      openDesktopApp('settings');
    });

  document
    .getElementById('captureOnceBtn')
    .addEventListener('click', async () => {
      const btn = document.getElementById('captureOnceBtn');
      btn.disabled = true;
      btn.textContent = 'Capturing...';

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
          chrome.tabs
            .sendMessage(tab.id, {
              action: 'showErrorNotification',
              message: resp.error || 'Capture failed',
            })
            .catch(() => {});
        }
        logDebug('[popup] Capture once completed for blacklisted page');
      } catch (error) {
        logError('[popup] Capture once failed:', error);
        chrome.tabs
          .sendMessage(tab.id, {
            action: 'showErrorNotification',
            message: error.message || 'Capture failed',
          })
          .catch(() => {});
      }

      await showDashboard(tab);
    });

  return true;
}

// Initialize popup
async function loadConnectedDashboard(connector) {
  await verifyDeviceIdentity(connector);
  document.getElementById('setup-required').style.display = 'none';

  const tab = await resolveActiveTab();
  if (!tab) return;
  currentTab = tab;
  await resolveEffectiveUrl(tab);
  if (await handlePrivateMode(tab)) return;
  if (await handleBlacklist(tab)) return;
  await showDashboard(tab);
}

async function initPopup() {
  await applyTheme();
  showSetupRequired({ state: 'connecting' }, { reveal: false });
  const revealTimer = setTimeout(revealSetupIfStillWaiting, 250);
  try {
    const cachedConnector = await getCachedDesktopConnectorState();
    if (
      cachedConnector?.state === 'connected' &&
      cachedConnector.deviceId &&
      !cachedConnector.refuseMode
    ) {
      clearTimeout(revealTimer);
      void refreshDesktopConnectorState().catch((error) => {
        logDebug('[popup] background connector refresh failed:', error.message);
      });
      await loadConnectedDashboard(cachedConnector);
      return;
    }
    if (cachedConnector && cachedConnector.state !== 'starting') {
      clearTimeout(revealTimer);
      showSetupRequired(cachedConnector);
      refreshDesktopConnectorStateInBackground();
      return;
    }

    const connector = await refreshDesktopConnectorState();
    clearTimeout(revealTimer);
    if (connector?.state !== 'connected' || !connector?.deviceId) {
      showSetupRequired(connector || { state: 'offline' });
      return;
    }

    await loadConnectedDashboard(connector);
  } catch (error) {
    clearTimeout(revealTimer);
    throw error;
  }
}
initPopup().catch((err) => showFatalError(err.message));

let mutationRefreshTimer = null;

function currentPageAffectedByMutation(message) {
  if (!currentUrl || !currentSlug) return false;

  if (message.url && message.url !== currentUrl) return false;
  if (message.pageSlug && message.pageSlug !== currentSlug) return false;
  if (message.slug && message.slug !== currentSlug) return false;

  switch (message.type) {
    case 'history':
    case 'lists':
    case 'note':
    case 'pins':
    case 'settings':
    case 'snapshot':
      return true;
    default:
      return false;
  }
}

function scheduleMutationRefresh() {
  if (mutationRefreshTimer) clearTimeout(mutationRefreshTimer);
  mutationRefreshTimer = setTimeout(() => {
    mutationRefreshTimer = null;
    void refreshCurrentPageSummary();
  }, 50);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== 'mutation') return false;
  if (currentPageAffectedByMutation(message)) {
    scheduleMutationRefresh();
  }
  return false;
});

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
