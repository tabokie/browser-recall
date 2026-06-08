// Options page for Browser Recall
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { HistoryEntry, SearchEngine } from './search-runtime.js';
import {
  getQueueContentMap,
  buildHistoryForEngine,
  extractHistoryQueue,
} from './search-helpers.js';
import {
  generateSlugFromUrl,
  generateSlugFromTitle,
  escapeHtml,
  BODY_WORD_LIMIT,
  DEFAULT_URL_BLACKLIST,
  collectVisitDateKeys,
} from './utils.js';
import {
  loadSettingsValue,
  saveSettingsValue,
  readDesktopValue,
  reloadApp,
  sendAction,
} from './desktop-bridge.js';
import { matchKeywordRule } from './rule-engine.js';
import { formatHighlightExcerpt } from './highlight-format.js';
import { attentionStrength, aggregateAttention } from './attention-utils.js';
import {
  initCharts,
  renderTimeChart,
  renderTimeChartInto,
  bindChartBarClick,
  syncChartHighlights,
  applyDateFilter,
} from './time-chart.js';
import { VirtualScroller } from './virtual-scroller.js';
import {
  entityTypeLabel,
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
import { logDebug, logError } from './logger.js';
import { applyTheme } from './theme.js';

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function revealApp() {
  document.documentElement.style.opacity = '';
}
// parseBookmarkHtml imported dynamically inside the block below

// ─── Utility ─────────────────────────────────────────────────────────

function autoResizeTextarea(textarea) {
  textarea.style.height = '0';
  textarea.style.height = textarea.scrollHeight + 'px';
}

function scrollableForAxis(start, axis) {
  let el = start instanceof Element ? start : start?.parentElement;
  for (; el && el !== document; el = el.parentElement) {
    const style = getComputedStyle(el);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;

    if (axis === 'y') {
      if (el.scrollHeight > el.clientHeight + 1) return el;
    } else if (el.scrollWidth > el.clientWidth + 1) {
      return el;
    }
  }
  return null;
}

function isScrollableElement(el) {
  if (!(el instanceof Element)) return false;
  return (
    el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1
  );
}

function wheelDeltaPixels(event, axis) {
  let delta = axis === 'x' ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) {
    delta *= 16;
  } else if (event.deltaMode === 2) {
    delta *= axis === 'x' ? window.innerWidth : window.innerHeight;
  }
  return delta;
}

function canScrollInDirection(el, axis, delta) {
  if (!el || delta === 0) return false;
  if (axis === 'y') {
    if (delta < 0) return el.scrollTop > 0;
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  if (delta < 0) return el.scrollLeft > 0;
  return el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

function resetMainScroll() {
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

function consumeRelatedTopReset() {
  const shouldReset = resetRelatedScrollOnNextRender;
  if (shouldReset) {
    resetMainScroll();
    resetRelatedScrollOnNextRender = false;
  }
  return shouldReset;
}

function preventDesktopOverscroll(event) {
  const wantsX = event.deltaX !== 0;
  const wantsY = event.deltaY !== 0;
  if (!wantsX && !wantsY) return;

  const scrollableX = wantsX ? scrollableForAxis(event.target, 'x') : null;
  const scrollableY = wantsY ? scrollableForAxis(event.target, 'y') : null;
  const canScrollX =
    wantsX &&
    canScrollInDirection(scrollableX, 'x', wheelDeltaPixels(event, 'x'));
  const canScrollY =
    wantsY &&
    canScrollInDirection(scrollableY, 'y', wheelDeltaPixels(event, 'y'));

  if (canScrollX || canScrollY) return;

  event.preventDefault();
}

const scrollActivityTimers = new WeakMap();
const MAIN_SCROLLBAR_HOVER_WIDTH = 12;

function markActiveScrollbar(event) {
  const el = event.target;
  if (!isScrollableElement(el)) return;

  el.classList.add('is-scrolling');
  const existingTimer = scrollActivityTimers.get(el);
  if (existingTimer) clearTimeout(existingTimer);
  scrollActivityTimers.set(
    el,
    setTimeout(() => {
      el.classList.remove('is-scrolling');
      scrollActivityTimers.delete(el);
    }, 700),
  );
}

function updateMainScrollbarHover(event) {
  const main = document.querySelector('.main');
  if (!main) return;
  const rect = main.getBoundingClientRect();
  const isScrollable = main.scrollHeight > main.clientHeight + 1;
  const insideMain =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  const inScrollbarArea =
    insideMain && event.clientX >= rect.right - MAIN_SCROLLBAR_HOVER_WIDTH;
  main.classList.toggle(
    'is-scrollbar-hovered',
    isScrollable && inScrollbarArea,
  );
}

function clearMainScrollbarHover() {
  document.querySelector('.main')?.classList.remove('is-scrollbar-hovered');
}

document.addEventListener('wheel', preventDesktopOverscroll, {
  capture: true,
  passive: false,
});
document.addEventListener('scroll', markActiveScrollbar, {
  capture: true,
  passive: true,
});
document.addEventListener('pointermove', updateMainScrollbarHover, {
  capture: true,
  passive: true,
});
document.addEventListener('pointerleave', clearMainScrollbarHover, {
  capture: true,
  passive: true,
});
window.addEventListener('blur', clearMainScrollbarHover);

// ─── Error UI ────────────────────────────────────────────────────────

const ERROR_CODE_MESSAGES = {
  fs_error: { text: 'Storage access failed', action: 'resume' },
  replay_error: { text: 'Replay worker failed', action: 'resume' },
  manual_pause: { text: 'Browser Recall is paused', action: 'resume' },
  session_quota: { text: 'Session storage full', action: 'reload' },
  local_quota: { text: 'Local storage full', action: 'reload' },
};

function showServiceErrorBanner(svcErr) {
  const banner = document.getElementById('serviceErrorBanner');
  const msgEl = document.getElementById('serviceErrorMessage');
  const reloadBtn = document.getElementById('serviceErrorReloadBtn');
  const resumeBtn = document.getElementById('serviceErrorResumeBtn');
  if (!banner || !msgEl) return;

  const info = ERROR_CODE_MESSAGES[svcErr.code] || {
    text: svcErr.message || 'Service unavailable',
    action: 'resume',
  };
  msgEl.textContent = info.text;

  reloadBtn.style.display = info.action === 'reload' ? '' : 'none';
  resumeBtn.style.display = info.action === 'resume' ? '' : 'none';

  reloadBtn.onclick = () => reloadApp();
  resumeBtn.onclick = async () => {
    try {
      await sendAction({ action: 'resumeService' });
      await refreshDesktopConnectorState();
      banner.style.display = 'none';
    } catch {}
  };

  banner.style.display = 'flex';
}

// Listen for serviceError changes while options page is open (service pauses mid-session).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if ('serviceError' in changes) {
      const svcErr = changes.serviceError.newValue;
      const banner = document.getElementById('serviceErrorBanner');
      if (!banner) return;
      if (svcErr) {
        showServiceErrorBanner(svcErr);
      } else {
        banner.style.display = 'none';
      }
    }
  });

function showFatalError(message) {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:999999;background:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  overlay.innerHTML = `
    <div style="color:#b41e1e;font-size:18px;font-weight:600;">Storage Unavailable</div>
    <div style="color:#555;font-size:14px;max-width:480px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:8px;padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:13px;">Reload Extension</button>
  `;
  document.body.appendChild(overlay);
  overlay
    .querySelector('#fatalReloadBtn')
    .addEventListener('click', () => chrome.runtime.reload());
}

let _errorBubbleTimer = null;
function showErrorBubble(
  message,
  { suffix = ' \u2014 please reload the extension.' } = {},
) {
  let bubble = document.getElementById('errorBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'errorBubble';
    bubble.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message + suffix;
  bubble.style.opacity = '1';
  clearTimeout(_errorBubbleTimer);
  _errorBubbleTimer = setTimeout(() => {
    bubble.style.opacity = '0';
  }, 4000);
}

let _blockedBubbleTimer = null;
function showBlockedBubble(message) {
  let bubble = document.getElementById('blockedBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'blockedBubble';
    bubble.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(120,120,120,0.88);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = '\u2715 ' + message;
  bubble.style.opacity = '1';
  clearTimeout(_blockedBubbleTimer);
  _blockedBubbleTimer = setTimeout(() => {
    bubble.style.opacity = '0';
  }, 2000);
}

let _infoBubbleTimer = null;
function showInfoBubble(message) {
  let bubble = document.getElementById('infoBubble');
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = 'infoBubble';
    bubble.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:var(--bg-surface-solid, rgba(255,255,255,0.75));color:var(--text-secondary, #5E4D3E);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;border:1px solid var(--border-glass, rgba(255,255,255,0.55));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 2px 8px rgba(0,0,0,0.08);opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;';
    document.body.appendChild(bubble);
  }
  bubble.textContent = message;
  bubble.style.opacity = '1';
  clearTimeout(_infoBubbleTimer);
  _infoBubbleTimer = setTimeout(() => {
    bubble.style.opacity = '0';
  }, 3000);
}

function applyDesktopConnectorUi(connector = {}) {
  const pairPending = desktopPairInFlight || connector.state === 'pair_pending';

  for (const id of ['selectDirBtn', 'onboardingDirBtn']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = pairPending;
    if (id === 'onboardingDirBtn') {
      button.textContent = 'Choose Data Folder';
    } else {
      button.textContent = pairPending
        ? 'Waiting for approval...'
        : 'Pair from Browser Popup';
    }
  }
}

async function refreshDesktopConnectorState() {
  try {
    const connector = await sendAction({
      action: 'getDesktopConnectorState',
    });
    applyDesktopConnectorUi(connector);
    return connector;
  } catch (error) {
    applyDesktopConnectorUi({
      state: 'offline',
      hasToken: false,
      lastError: error.message || 'Desktop bridge unavailable.',
    });
    return null;
  }
}

async function completeOnboarding() {
  if (onboardingCompletionPromise) return onboardingCompletionPromise;
  onboardingCompletionPromise = (async () => {
    const el = document.getElementById('onboarding');
    const startBtn = document.getElementById('onboardingStartBtn');
    const launchAtLoginInput = document.getElementById(
      'onboardingLaunchAtLogin',
    );
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
    try {
      await sendAction({
        action: 'completeDesktopSetup',
        launchAtLogin:
          !!launchAtLoginInput &&
          !launchAtLoginInput.disabled &&
          launchAtLoginInput.checked,
      });
      await chrome.storage.session.set({
        colorScheme: onboardingSelectedScheme,
      });
      await saveSettingsValue('colorScheme', onboardingSelectedScheme);
    } catch (error) {
      onboardingCompletionPromise = null;
      startBtn.disabled = false;
      startBtn.textContent = 'Get Started';
      const dirStatus = document.getElementById('onboardingDirStatus');
      if (dirStatus) {
        dirStatus.textContent = `Could not start setup: ${error.message}`;
      }
      throw error;
    }

    el.classList.add('fade-out');
    await new Promise((resolve) => {
      el.addEventListener('transitionend', resolve, { once: true });
    });
    el.style.display = 'none';
    document.querySelector('.sidebar').style.display = '';
    await initializeMain();
  })();
  return onboardingCompletionPromise;
}

async function initializeOnboardingLaunchAtLogin() {
  const input = document.getElementById('onboardingLaunchAtLogin');
  const row = document.getElementById('onboardingLaunchAtLoginRow');
  const unsupported = document.getElementById(
    'onboardingLaunchAtLoginUnsupported',
  );
  if (!input || !row || !unsupported) return;
  try {
    const shell = await sendAction({ action: 'getDesktopShellState' });
    const supported = !!shell.loginItemSupported;
    input.disabled = !supported;
    input.checked = supported ? shell.launchAtLogin !== false : false;
    row.classList.toggle('disabled', !supported);
    unsupported.style.display = supported ? 'none' : 'block';
    if (!shell.setupComplete && shell.dataDir) {
      const dirBtn = document.getElementById('onboardingDirBtn');
      if (dirBtn) {
        dirBtn.textContent = 'Change Data Folder';
      }
      setOnboardingDataFolderConfigured(true, shell.dataDir);
    }
  } catch (error) {
    input.checked = true;
    logDebug(
      '[onboarding] failed to load launch-at-login state:',
      error.message,
    );
  }
}

function showOnboardingIntro() {
  const setupCard = document.getElementById('onboardingSetupCard');
  const introCard = document.getElementById('onboardingIntroCard');
  if (!onboardingDataFolderConfigured) return;
  setupCard.style.display = 'none';
  introCard.style.display = 'block';
  introCard.classList.add('slide-in');
}

function setOnboardingDataFolderConfigured(configured, dataFolder = '') {
  onboardingDataFolderConfigured = configured;
  if (dataFolder) {
    onboardingDataFolderPath = dataFolder;
  }
  const forwardBtn = document.getElementById('onboardingForwardBtn');
  if (forwardBtn) {
    forwardBtn.hidden = !configured;
  }
  const dirStatus = document.getElementById('onboardingDirStatus');
  if (dirStatus && configured && onboardingDataFolderPath) {
    dirStatus.textContent = `Data folder: ${onboardingDataFolderPath}`;
  }
}

async function chooseDesktopDataFolderForOnboarding() {
  const dirBtn = document.getElementById('onboardingDirBtn');
  const dirStatus = document.getElementById('onboardingDirStatus');
  const forwardBtn = document.getElementById('onboardingForwardBtn');
  const hadSelectedFolder = onboardingDataFolderConfigured;
  dirBtn.disabled = true;
  dirBtn.textContent = 'Choosing...';
  forwardBtn.hidden = true;
  dirStatus.textContent =
    'Select the folder where Browser Recall should store its local data.';
  try {
    const result = await sendAction({ action: 'chooseDesktopDataFolder' });
    if (result?.cancelled) {
      dirStatus.textContent = 'Choose a data folder to continue.';
      dirBtn.disabled = false;
      dirBtn.textContent = hadSelectedFolder
        ? 'Change Data Folder'
        : 'Choose Data Folder';
      setOnboardingDataFolderConfigured(hadSelectedFolder);
      return;
    }
    dirStatus.textContent = `Data folder: ${result.dataFolder}`;
    dirBtn.disabled = false;
    dirBtn.textContent = 'Change Data Folder';
    setOnboardingDataFolderConfigured(true, result.dataFolder);
    showOnboardingIntro();
  } catch (error) {
    dirStatus.textContent = `Could not use that folder: ${error.message}`;
    dirBtn.disabled = false;
    dirBtn.textContent = hadSelectedFolder
      ? 'Change Data Folder'
      : 'Choose Data Folder';
    setOnboardingDataFolderConfigured(hadSelectedFolder);
  }
}

function bindWindowDragRegions() {
  const TRAFFIC_LIGHT_SAFE_WIDTH = 104;
  const TOP_DRAG_HEIGHT = 32;
  const interactiveSelector = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '[role="button"]',
    '.main-title',
    '.color-dot',
  ].join(',');
  const dragWindow = () => {
    return sendAction({ action: 'startWindowDrag' });
  };
  const toggleFullscreen = () => {
    return sendAction({ action: 'toggleWindowFullscreen' });
  };
  let suppressNextDblClick = false;
  let lastDragClick = null;
  const DOUBLE_CLICK_MS = 420;
  const DOUBLE_CLICK_DISTANCE = 6;
  const DRAG_START_DISTANCE = 3;
  const toggleFullscreenFromMouseDown = () => {
    suppressNextDblClick = true;
    setTimeout(() => {
      suppressNextDblClick = false;
    }, 400);
    return toggleFullscreen();
  };
  const shouldIgnoreDrag = (event) => {
    return event.button !== 0 || event.target.closest(interactiveSelector);
  };
  const isTopDocumentDragZone = (event) => {
    return (
      event.clientY <= TOP_DRAG_HEIGHT &&
      event.clientX >= TRAFFIC_LIGHT_SAFE_WIDTH
    );
  };
  const isDoubleDragClick = (event) => {
    const now = performance.now();
    const previous = lastDragClick;
    lastDragClick = {
      time: now,
      x: event.clientX,
      y: event.clientY,
    };
    if (!previous || now - previous.time > DOUBLE_CLICK_MS) {
      return false;
    }
    return (
      Math.abs(event.clientX - previous.x) <= DOUBLE_CLICK_DISTANCE &&
      Math.abs(event.clientY - previous.y) <= DOUBLE_CLICK_DISTANCE
    );
  };
  const shouldToggleFullscreenOnMouseDown = (event) => {
    return event.detail === 2 || isDoubleDragClick(event);
  };
  const beginPotentialDrag = (event) => {
    const startX = event.clientX;
    const startY = event.clientY;
    let consumed = false;
    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mouseup', onMouseUp, true);
    };
    const onMouseMove = (moveEvent) => {
      if (consumed) {
        return;
      }
      if (
        Math.abs(moveEvent.clientX - startX) < DRAG_START_DISTANCE &&
        Math.abs(moveEvent.clientY - startY) < DRAG_START_DISTANCE
      ) {
        return;
      }
      consumed = true;
      cleanup();
      dragWindow()?.catch?.(() => {});
    };
    const onMouseUp = () => {
      cleanup();
    };
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
  };
  const handleDragZoneMouseDown = (event, stopPropagation = false) => {
    if (shouldIgnoreDrag(event)) {
      return;
    }
    event.preventDefault();
    if (stopPropagation) {
      event.stopPropagation();
    }
    if (shouldToggleFullscreenOnMouseDown(event)) {
      toggleFullscreenFromMouseDown()?.catch?.(() => {});
      return;
    }
    if (event.detail > 1) {
      return;
    }
    beginPotentialDrag(event);
  };
  document
    .querySelectorAll('.sidebar-header, .main-header')
    .forEach((region) => {
      region.addEventListener('mousedown', (event) => {
        handleDragZoneMouseDown(event, true);
      });
      region.addEventListener('dblclick', (event) => {
        if (shouldIgnoreDrag(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (suppressNextDblClick) {
          return;
        }
        toggleFullscreen()?.catch?.(() => {});
      });
    });
  document.addEventListener('mousedown', (event) => {
    if (shouldIgnoreDrag(event) || !isTopDocumentDragZone(event)) {
      return;
    }
    handleDragZoneMouseDown(event);
  });
  document.addEventListener('dblclick', (event) => {
    if (shouldIgnoreDrag(event) || !isTopDocumentDragZone(event)) {
      return;
    }
    event.preventDefault();
    if (suppressNextDblClick) {
      return;
    }
    toggleFullscreen()?.catch?.(() => {});
  });
}

// --- State ---
let currentSortState = { column: null, direction: null };
let pinnedSortState = { column: null, direction: null };
let relatedSortState = { column: null, direction: null };
let currentExtraColumns = [];
let pinnedExtraColumns = [];
let relatedExtraColumns = [];
// --- Demand-loaded history ---
const HISTORY_MAX_FILES = 100; // cap total loaded files
const DEFAULT_AVG_ENTRY_SIZE = 200;
const historyState = {
  fileBatch: 10, // files per load (configurable in settings)
  files: [], // all JSONL filenames, newest-first
  loadedFiles: new Set(), // filenames already merged into allEntries
  byUrl: new Map(), // url → history entry (deduped, newest wins)
  allEntries: [], // all loaded entries (not deduped), for date-boundary rendering
  loading: false, // guard against concurrent loads
  fileSizes: {}, // filename → total byte size (for chart estimation)
  devices: [], // device IDs discovered from logs/<device> directories
  avgEntrySize: DEFAULT_AVG_ENTRY_SIZE, // calibrated from loaded batches
  batchRawCount: 0, // total raw entries from loaded JSONL files
  _mutationWatermark: 0, // newest history log timestamp merged from live mutations
};
let activeView = { type: 'category', value: 'all' }; // or { type: 'search', query: '...' } or { type: 'list', query: '...', id: '...' } or { type: 'explore', query: '...', filter: '...' }
let pendingShellRoute = window.__BR_STATE__?.route || null;
let applyingShellRoute = false;
let allListPins = {}; // listId -> [{ url, title, pinnedAt }]
let lastClickedRow = null; // for shift-click range select
const cardDataByUrl = new Map(); // url → { attDetail, timestamps } for detail overlay
const listNameById = new Map(); // listId → display name, populated by renderLists()
let listsReadyPromise = Promise.resolve();
let marqueeActive = false; // suppress click during marquee drag
let queueContentMap = {}; // slug -> markdown from pending queue entries
let draggedSidebarListId = null;
let sidebarDragScrollFrame = 0;
let sidebarDragScrollVelocity = 0;
let desktopPairInFlight = false;
let onboardingSelectedScheme = 'amber';
let onboardingCompletionPromise = null;
let onboardingDataFolderConfigured = false;
let onboardingDataFolderPath = '';
// pinnedFilterCtx removed — pinned section no longer has related pages
// Page data cached in chrome.storage.session (managed by background).
// Keys: 'page:{slug}' for pages.

// --- Search/filter state ---
let committedSearchQuery = ''; // committed query that participates in search/filtering
let draftSearchInput = ''; // uncommitted text; becomes active only on Enter
let filterState = createDefaultFilterState();
let filterVisible = false;

const KEYWORD_FIELDS = ['title', 'url', 'captures', 'highlights', 'notes'];
const KEYWORD_FIELD_LABELS = {
  title: 'Title',
  url: 'Address',
  captures: 'Captures',
  highlights: 'Highlights',
  notes: 'Notes',
};

function normalizeFieldToArray(field) {
  if (!field || field === 'any') return [...KEYWORD_FIELDS];
  if (Array.isArray(field)) return field;
  return [field];
}

// Range filter field configs: fallback min/max/step, format for labels
function daysAgoToDate(v) {
  const d = new Date(Date.now() - v * 86400000);
  return d.toISOString().slice(0, 10);
}
const RANGE_CONFIGS = {
  lastVisit: {
    min: 0,
    max: 365,
    step: 1,
    format: daysAgoToDate,
    isDaysAgo: true,
  },
  firstVisit: {
    min: 0,
    max: 365,
    step: 1,
    format: daysAgoToDate,
    isDaysAgo: true,
  },
};
let cachedFieldRanges = null; // { field: { min, max } } — computed from data

// Compute actual data ranges for date range fields (lightweight scan)
function computeFieldRanges(entries) {
  const byUrl = new Map();
  for (const i of entries) {
    if (!byUrl.has(i.url)) byUrl.set(i.url, []);
    byUrl.get(i.url).push(i);
  }
  const ranges = {};
  for (const key of Object.keys(RANGE_CONFIGS)) {
    ranges[key] = { min: Infinity, max: -Infinity };
  }
  for (const [, group] of byUrl) {
    const timestamps = group.map((i) => i.timestamp);
    const lastVisit = (Date.now() - Math.max(...timestamps)) / 86400000;
    const firstVisit = (Date.now() - Math.min(...timestamps)) / 86400000;
    const vals = { lastVisit, firstVisit };
    for (const [key, v] of Object.entries(vals)) {
      if (v < ranges[key].min) ranges[key].min = v;
      if (v > ranges[key].max) ranges[key].max = v;
    }
  }
  for (const [field, r] of Object.entries(ranges)) {
    const step = RANGE_CONFIGS[field].step;
    r.min = Math.floor(r.min / step) * step;
    r.max = Math.ceil(r.max / step) * step;
    if (r.min >= r.max) r.max = r.min + step;
  }
  return ranges;
}

function getFieldRanges() {
  if (cachedFieldRanges) return cachedFieldRanges;
  if (historyState.byUrl.size === 0 && historyState.files.length === 0)
    return null;
  cachedFieldRanges =
    historyState.byUrl.size > 0
      ? computeFieldRanges(Array.from(historyState.byUrl.values()))
      : Object.fromEntries(
          Object.keys(RANGE_CONFIGS).map((k) => [
            k,
            { min: RANGE_CONFIGS[k].min, max: RANGE_CONFIGS[k].max },
          ]),
        );
  // Extend date ranges to cover all known files (even unloaded ones)
  if (historyState.files.length > 0) {
    const oldestFile = historyState.files[historyState.files.length - 1]; // files are newest-first
    const oldestDate = oldestFile.replace('.jsonl', '');
    const oldestDaysAgo = Math.ceil(
      (Date.now() - new Date(oldestDate + 'T00:00:00Z').getTime()) / 86400000,
    );
    for (const key of ['lastVisit', 'firstVisit']) {
      if (oldestDaysAgo > cachedFieldRanges[key].max) {
        cachedFieldRanges[key].max = oldestDaysAgo;
      }
    }
  }
  return cachedFieldRanges;
}

// Get effective min/max for a range field: data-driven if available, else static fallback
function getRangeConfig(field) {
  const cfg = RANGE_CONFIGS[field];
  const dataRanges = getFieldRanges();
  const dr = dataRanges?.[field];
  return {
    ...cfg,
    min: dr ? dr.min : cfg.min,
    max: dr ? dr.max : cfg.max,
  };
}

// --- Search Module ---
/**
 * Fetch a URL and extract body text (first BODY_WORD_LIMIT words).
 * Returns '' on timeout, network error, or non-HTML content.
 */
async function fetchPageBody(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (
      !resp.ok ||
      !(resp.headers.get('content-type') || '').includes('text/html')
    )
      return '';
    const html = await resp.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, BODY_WORD_LIMIT)
      .join(' ');
  } catch {
    return '';
  }
}

// --- Progressive search ---
const searchState = {
  generation: 0, // generation counter — stale phase callbacks are discarded
  results: [], // master result array, mutated by mergeSearchResults
  resultIndex: new Map(), // url → index into results[] for O(1) dedup in mergeSearchResults
  pendingPhases: 0, // count of in-flight phases — spinner shown while > 0
};
let resetRelatedScrollOnNextRender = false;
let preserveRelatedScrollOnNextRender = false;

function prepareRelatedChartDateFilter(contextKey) {
  const chartEl = document.getElementById('relatedChart');
  if (!chartEl) return null;
  if (chartEl._dateFilterContext !== contextKey) {
    chartEl._dateFilterContext = contextKey;
    chartEl._activeDates = new Set();
    chartEl._dateSelectionToken = Symbol('chart-date-context');
  }
  return chartEl;
}

function applyPersistedRelatedDateFilter() {
  const chartEl = document.getElementById('relatedChart');
  const resultsEl = document.getElementById('relatedResults');
  if (!chartEl || !resultsEl) return;
  if (!(chartEl._activeDates instanceof Set) || chartEl._activeDates.size === 0)
    return;
  applyDateFilter(chartEl, resultsEl);
  syncChartHighlights();
}

function exploreDateFilterContext() {
  return `explore:${committedSearchQuery.trim()}`;
}

// Run a limited-concurrency pool of async tasks, calling onResult after each completes.
async function runPool(tasks, concurrency, onResult) {
  let idx = 0;
  async function next() {
    while (idx < tasks.length) {
      const i = idx++;
      const result = await tasks[i]();
      await onResult(result);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(next());
  }
  await Promise.all(workers);
}

let latestHistorySearchId = null;

function tauriCoreInvoke(command, payload) {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(command, payload);
  }
  if (window.__TAURI_INTERNALS__?.invoke) {
    return window.__TAURI_INTERNALS__.invoke(command, payload);
  }
  return null;
}

function tauriEventListen(eventName, handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(eventName, handler);
  }
  if (window.__TAURI_INTERNALS__?.event?.listen) {
    return window.__TAURI_INTERNALS__.event.listen(eventName, handler);
  }
  return null;
}

function canStreamDesktopHistorySearch() {
  return Boolean(
    window.__BROWSER_RECALL_DESKTOP__ &&
    (window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke) &&
    (window.__TAURI__?.event?.listen ||
      window.__TAURI_INTERNALS__?.event?.listen),
  );
}

function cancelActiveHistorySearch() {
  if (!latestHistorySearchId || !canStreamDesktopHistorySearch()) return;
  const searchId = latestHistorySearchId;
  latestHistorySearchId = null;
  Promise.resolve(
    tauriCoreInvoke('cancel_history_search', {
      request: { searchId },
    }),
  ).catch((error) => {
    logDebug('[search] cancel history search failed:', error.message);
  });
}

async function runStreamingHistorySearch(query, gen) {
  if (!canStreamDesktopHistorySearch()) return false;

  const searchId = `${gen}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  latestHistorySearchId = searchId;
  let completed = false;
  let unlisten = null;
  const finish = ({ completePhase } = { completePhase: true }) => {
    if (completed) return;
    completed = true;
    if (latestHistorySearchId === searchId) latestHistorySearchId = null;
    Promise.resolve(unlisten?.()).catch((error) => {
      logDebug('[search] history listener cleanup failed:', error.message);
    });
    if (completePhase) phaseComplete(gen);
  };

  unlisten = await tauriEventListen('bridge-search-history', async (event) => {
    const payload = event?.payload || {};
    if (payload.searchId !== searchId) return;
    if (payload.type === 'historySearchChunk') {
      if (gen !== searchState.generation) return;
      mergeSearchResults(
        buildDesktopHistoryResults(payload.results),
        'history',
        gen,
      );
      await renderProgressiveResults(gen);
      return;
    }
    if (payload.type === 'historySearchDone') {
      const current = gen === searchState.generation;
      if (current && !payload.success && !payload.cancelled && payload.error) {
        logDebug(
          '[Phase1] Desktop streaming history search failed:',
          payload.error,
        );
      }
      finish({ completePhase: current });
    }
  });

  try {
    await tauriCoreInvoke('search_history_stream', {
      request: { searchId, query },
    });
    return true;
  } catch (error) {
    if (latestHistorySearchId === searchId) latestHistorySearchId = null;
    Promise.resolve(unlisten?.()).catch(() => {});
    throw error;
  }
}

// Merge new results into searchState.results. Dedup by URL, take max score, track sources.
function mergeSearchResults(newResults, source, gen) {
  if (gen !== searchState.generation) return; // stale generation — discard
  for (const r of newResults) {
    if (!r.url) continue;
    const idx = searchState.resultIndex.get(r.url);
    if (idx !== undefined) {
      const existing = searchState.results[idx];
      const nextScore = r.score || 0;
      const existingScore = existing.score || 0;
      const isVisitSource = source === 'history' || source === 'title';
      const existingHasVisitSource =
        existing.matchSources?.has('history') ||
        existing.matchSources?.has('title');
      if (isVisitSource) {
        const nextTimestamp = r.timestamp || existing.timestamp || Date.now();
        const existingTimestamp = existingHasVisitSource
          ? existing.timestamp || 0
          : 0;
        if (
          !existingHasVisitSource ||
          nextScore > existingScore ||
          (nextScore === existingScore && nextTimestamp > existingTimestamp)
        ) {
          existing.score = Math.max(nextScore, existingScore);
          existing.timestamp = nextTimestamp;
          existing.latestTs = nextTimestamp;
          existing.title = r.title || existing.title || '';
          existing.timestamps = r.timestamps || [nextTimestamp];
          delete existing._maxTs;
          delete existing._minTs;
        } else if (nextTimestamp > existingTimestamp) {
          existing.timestamp = nextTimestamp;
          existing.latestTs = nextTimestamp;
          if (!existing.title && r.title) existing.title = r.title;
          if (Array.isArray(r.timestamps)) {
            existing.timestamps = [
              ...new Set([...(existing.timestamps || []), ...r.timestamps]),
            ].sort((left, right) => right - left);
          }
          delete existing._maxTs;
          delete existing._minTs;
        }
      } else if (nextScore > existingScore) {
        existing.score = nextScore;
        if (!existing.title && r.title) existing.title = r.title;
      }
      if (
        r.createdAt &&
        (!existing.createdAt || r.createdAt < existing.createdAt)
      )
        existing.createdAt = r.createdAt;
      if (!existing.matchSources) existing.matchSources = new Set();
      existing.matchSources.add(source);
      if (r.deviceIds) {
        if (!existing.deviceIds) existing.deviceIds = new Set();
        for (const id of r.deviceIds) existing.deviceIds.add(id);
      }
    } else {
      const entry = {
        url: r.url,
        title: r.title || '',
        user_title: r.user_title,
        slug: r.slug || generateSlugFromUrl(r.url),
        timestamp: r.timestamp || Date.now(),
        score: r.score || 0,
        createdAt: r.createdAt || 0,
        attScore: r.attScore || 0,
        attDetail: r.attDetail || null,
        notes: r.notes || [],
        timestamps: r.timestamps || [r.timestamp || Date.now()],
        latestTs: r.timestamp || Date.now(),
        deviceIds: r.deviceIds,
        matchSources: new Set([source]),
      };
      searchState.resultIndex.set(r.url, searchState.results.length);
      searchState.results.push(entry);
    }
  }
}

// Enrich new entries and render the current searchState.results to the virtual scroller.
async function renderProgressiveResults(gen) {
  if (gen !== searchState.generation) return;
  // Enrich all entries that haven't been enriched yet
  const unenriched = searchState.results.filter((r) => !r._enriched);
  if (unenriched.length > 0) {
    await enrichFromEntityStorage(unenriched);
    for (const r of unenriched) r._enriched = true;
  }
  // Apply filters
  let results = searchState.results;
  if (!isDefaultFilterState(filterState)) {
    const notFilterEnriched = results.filter((r) => !r._filterEnriched);
    if (notFilterEnriched.length > 0) {
      await enrichForFilters(notFilterEnriched);
      for (const r of notFilterEnriched) r._filterEnriched = true;
    }
    results = await applyFilters([...results]);
  }

  const relatedContainer = document.getElementById('relatedResults');
  if (preserveRelatedScrollOnNextRender && searchState.pendingPhases > 0) {
    return;
  }

  // Show "No results" when all phases are done and nothing matched
  if (results.length === 0) {
    preserveRelatedScrollOnNextRender = false;
    const vs = getOrCreateRelatedScroller();
    vs._headerHtml =
      searchState.pendingPhases <= 0
        ? '<div class="no-results">No results</div>'
        : '';
    vs.updateData([], () => '');
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column
    ? relatedSortState
    : { column: 'relevance', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map((r) => r.attScore), 0.1);

  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = '';
  const preserveScroll = preserveRelatedScrollOnNextRender;
  if (preserveScroll) {
    await waitForMainViewport();
  }
  preserveRelatedScrollOnNextRender = false;
  vs.updateData(
    sorted,
    (r) =>
      resultRowHtml(r.user_title || r.title, r.url, {
        attScore: r.attScore,
        maxAtt,
        attDetail: r.attDetail,
        notes: r.notes,
        timestamps: r.timestamps,
        visitDates: r.visitDates,
        context: 'related',
        childIds: r.childIds,
        parentIds: r.parentIds,
        likes: r.likes,
        matchSources: r.matchSources,
        hasHighlightNotes: r.hasHighlightNotes,
      }),
    { preserveScroll },
  );
  relatedContainer.dataset.searchCount = String(searchState.results.length);
  // Update time chart
  const chartData = sorted.map((r) => ({
    url: r.url,
    timestamp: r.timestamps?.[0] || Date.now(),
    timestamps: r.timestamps,
    visitDates: r.visitDates,
    attention: '',
  }));
  const relatedChart = prepareRelatedChartDateFilter(
    exploreDateFilterContext(),
  );
  relatedChart._onDateSelect = null;
  renderTimeChartInto(
    relatedChart,
    document.getElementById('relatedChartBars'),
    chartData,
    'Explore results',
  );
  bindChartBarClick(relatedChart, document.getElementById('relatedResults'));
  applyPersistedRelatedDateFilter();
}

function showSearchSpinner() {
  const el = document.getElementById('contentSearchSpinner');
  if (el) el.style.display = '';
}
function hideSearchSpinner() {
  const el = document.getElementById('contentSearchSpinner');
  if (el) el.style.display = 'none';
}

async function waitForMainViewport() {
  const main = document.querySelector('.main');
  if (!main || main.clientHeight > 0) return;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (main.clientHeight > 0) return;
  }
}

function phaseComplete(gen) {
  if (gen !== searchState.generation) return;
  searchState.pendingPhases--;
  if (searchState.pendingPhases <= 0) {
    hideSearchSpinner();
    void renderProgressiveResults(gen);
  }
}

function buildDesktopHistoryResults(results) {
  return (results || []).map((result) => ({
    url: result.url,
    title: result.title,
    slug: generateSlugFromUrl(result.url),
    timestamp: result.timestamp,
    score: result.score || 0,
    timestamps: [result.timestamp],
  }));
}

function buildNoteSearchResults(results) {
  const now = Date.now();
  return (results || []).map((result) => ({
    url: result.url,
    title: '',
    slug: generateSlugFromUrl(result.url),
    timestamp: now,
    score: 1.0,
    timestamps: [now],
  }));
}

async function buildSnapshotSearchResults(matches) {
  const slugs = (matches || []).map((match) => match.slug).filter(Boolean);
  if (slugs.length === 0) return [];
  const pages = await Promise.all(
    slugs.map((slug) => readDesktopValue(pageKey(slug))),
  );
  const now = Date.now();
  const results = [];
  for (let i = 0; i < slugs.length; i++) {
    const page = pages[i];
    if (!page?.url) continue;
    results.push({
      url: page.url,
      title: page.title || '',
      slug: slugs[i],
      timestamp: now,
      score: 1.0,
      timestamps: [now],
    });
  }
  return results;
}

// Phase 1: daemon-backed history search plus pending connector queue search.
async function runPhase1(query, gen) {
  let streamingStarted = false;
  try {
    const { desktopCommandBuffer = [] } = await chrome.storage.local.get([
      'desktopCommandBuffer',
    ]);
    const pendingHistoryEntries = extractHistoryQueue(desktopCommandBuffer);
    queueContentMap = getQueueContentMap(pendingHistoryEntries);
    if (pendingHistoryEntries.length > 0) {
      const engine = new SearchEngine();
      buildHistoryForEngine(
        HistoryEntry,
        engine,
        pendingHistoryEntries,
        queueContentMap,
      );
      const bufferResults = await engine.search(query, 0);
      mergeSearchResults(bufferResults, 'history', gen);
      await renderProgressiveResults(gen);
    }

    streamingStarted = await runStreamingHistorySearch(query, gen);
    if (streamingStarted) return;
  } catch (e) {
    logDebug('[Phase1] JSONL search failed:', e.message);
  } finally {
    if (!streamingStarted) phaseComplete(gen);
  }
}

// Phase 2a: note search.
async function runPhase2a(query, gen) {
  try {
    try {
      const desktopResp = await sendAction({
        action: 'searchNotes',
        query,
      });
      if (Array.isArray(desktopResp.results)) {
        mergeSearchResults(
          buildNoteSearchResults(desktopResp.results),
          'note',
          gen,
        );
        await renderProgressiveResults(gen);
      }
    } catch (error) {
      logDebug('[Phase2a] Desktop note search unavailable:', error.message);
    }
  } catch (e) {
    logDebug('[Phase2a] Note search failed:', e.message);
  } finally {
    phaseComplete(gen);
  }
}

// Phase 2b: snapshot search with limited concurrency.
async function runPhase2b(query, gen) {
  try {
    try {
      const desktopResp = await sendAction({
        action: 'searchSnapshots',
        query,
      });
      if (Array.isArray(desktopResp.results)) {
        const snapshotResults = await buildSnapshotSearchResults(
          desktopResp.results,
        );
        mergeSearchResults(snapshotResults, 'snapshot', gen);
        await renderProgressiveResults(gen);
      }
    } catch (error) {
      logDebug('[Phase2b] Desktop snapshot search unavailable:', error.message);
    }
  } catch (e) {
    logDebug('[Phase2b] Snapshot search failed:', e.message);
  } finally {
    phaseComplete(gen);
  }
}

// Lightweight title/URL scorer for Phase 0 (mirrors the search module content-score weights).
function phase0Score(item, words) {
  let score = 0;
  const title = (item.user_title || item.title || '').toLowerCase();
  const url = (item.url || '').toLowerCase();
  for (const { q, exact } of words) {
    const ql = q.toLowerCase();
    if (exact) {
      const escaped = ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`);
      if (re.test(title)) score += 2.0;
      else if (re.test(url)) score += 0.5;
    } else {
      if (title.includes(ql)) score += 2.0;
      else if (url.includes(ql)) score += 0.5;
    }
  }
  return words.length > 0 ? score / words.length : 0;
}

// Four-phase progressive search orchestrator.
// Phase 0: instant exact/substring in-memory matching. Phase 1: JSONL streaming.
// Phase 2a: notes. Phase 2b: snapshots streaming.
async function runProgressiveSearch(allQueries) {
  cancelActiveHistorySearch();
  const vs = document.getElementById('relatedResults')?._virtualScroller;
  if (vs) vs.onLoadMore = null;
  const gen = ++searchState.generation;
  searchState.results = [];
  searchState.resultIndex.clear();
  searchState.pendingPhases = 3;
  showSearchSpinner();
  const query = allQueries.join(' ');

  // Phase 0: instant exact/substring matching over already-loaded rows.
  const words = parseSearchWords(query);
  const phase0Entries = historyState.allEntries.filter(
    (item) => item.url && wordsMatchItem(words, item),
  );
  const phase0Results = processHistoryForDisplay(phase0Entries, {
    globalDedup: true,
  }).map((item) => ({
    ...item,
    score: phase0Score(item, words),
    matchSources: new Set(['title']),
  }));
  mergeSearchResults(phase0Results, 'title', gen);
  await renderProgressiveResults(gen);

  // Fire Phase 1, 2a, 2b concurrently (with per-type concurrency limits)
  runPhase1(query, gen);
  runPhase2a(query, gen);
  runPhase2b(query, gen);
}

// --- Demand-loaded history ---

async function initHistoryFiles() {
  await refreshHistoryMetadata();

  queueContentMap = {};
}

async function refreshHistoryMetadata() {
  const resp = await sendAction({
    action: 'listHistoryFiles',
    includeSizes: true,
  });
  historyState.files = Array.isArray(resp.files) ? resp.files : [];
  historyState.fileSizes = resp.sizes || {};
  historyState.devices = Array.isArray(resp.devices) ? resp.devices : [];
  return resp;
}

async function loadHistoryEntriesForDate(dateStr) {
  const resp = await sendAction({
    action: 'loadHistoryBatch',
    files: [`${dateStr}.jsonl`],
  });
  return resp.entries || [];
}

async function loadHistoryBatch() {
  const nextFiles = historyState.files
    .filter((file) => !historyState.loadedFiles.has(file))
    .slice(0, HISTORY_MAX_FILES - historyState.loadedFiles.size);
  if (
    historyState.loading ||
    nextFiles.length === 0 ||
    historyState.loadedFiles.size >= HISTORY_MAX_FILES
  )
    return [];
  historyState.loading = true;
  const batch = nextFiles.slice(0, historyState.fileBatch);
  try {
    const t0 = performance.now();
    const resp = await sendAction({ action: 'loadHistoryBatch', files: batch });
    const batchEntries = resp.entries;
    const newItems = [];
    // Entries within a day file arrive oldest→newest. This isn't a full replay,
    // but we simulate replay semantics: newer values always win, and older
    // values are only kept when the newer entry omits the field (the "omit
    // unchanged fields" optimisation in background.js means later entries
    // often lack a title when it hasn't changed since the previous write).
    for (const item of batchEntries) {
      // Skip non-visit entries (settings, list ops, etc.)
      if (
        item.action &&
        item.action !== 'visit_page' &&
        item.action !== 'leave_page'
      )
        continue;
      if (!item.url) continue;
      if (item.timestamp > historyState._mutationWatermark) {
        historyState._mutationWatermark = item.timestamp;
      }
      historyState.allEntries.push(item);
      const existing = historyState.byUrl.get(item.url);
      if (!existing) {
        historyState.byUrl.set(item.url, item);
      } else {
        if (item.title) existing.title = item.title;
        if (item.user_title) existing.user_title = item.user_title;
      }
      newItems.push(item);
    }
    logDebug(
      `[I/O] loadHistoryBatch: ${batch.length} files, ${batchEntries.length} items, ${newItems.length} new in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    for (const file of batch) historyState.loadedFiles.add(file);
    if (newItems.length > 0) cachedFieldRanges = null;
    // Calibrate avg entry size from loaded file data
    historyState.batchRawCount += batchEntries.length;
    const loadedSize = [...historyState.loadedFiles].reduce(
      (sum, f) => sum + (historyState.fileSizes[f] || 0),
      0,
    );
    if (loadedSize > 0 && historyState.batchRawCount > 0) {
      historyState.avgEntrySize = loadedSize / historyState.batchRawCount;
    }
    historyState.loading = false;
    return newItems;
  } catch (error) {
    logDebug('Error loading history batch:', error.message);
    historyState.loading = false;
    return [];
  }
}

// Load history files until a specific date is covered (single batch).
async function loadHistoryUntilDate(dateStr) {
  const targetFile = dateStr + '.jsonl';
  const targetIdx = historyState.files.indexOf(targetFile);
  if (targetIdx < 0 || historyState.loadedFiles.has(targetFile)) return; // already loaded or not found
  const needed = historyState.files
    .slice(0, targetIdx + 1)
    .filter((file) => !historyState.loadedFiles.has(file)).length;
  const saved = historyState.fileBatch;
  historyState.fileBatch = needed;
  await loadHistoryBatch();
  historyState.fileBatch = saved;
}

function resetHistory() {
  historyState.files = [];
  historyState.loadedFiles = new Set();
  historyState.byUrl.clear();
  historyState.allEntries = [];
  historyState.loading = false;
  historyState.fileSizes = {};
  historyState.devices = [];
  historyState.avgEntrySize = DEFAULT_AVG_ENTRY_SIZE;
  historyState.batchRawCount = 0;
  historyState._mutationWatermark = 0;
  cachedFieldRanges = null;
  allListPins = {};

  queueContentMap = {};
  cancelActiveHistorySearch();
  searchState.generation++; // invalidate any in-flight progressive search
  searchState.results = [];
  searchState.pendingPhases = 0;
  hideSearchSpinner();
}

// Estimate visit counts for unloaded JSONL files from file sizes.
// Returns Map<dateStr, estimatedCount> for dates not yet loaded.
function getEstimatedByDay() {
  const estimated = new Map();
  for (const filename of historyState.files) {
    if (historyState.loadedFiles.has(filename)) continue;
    const dateStr = filename.replace('.jsonl', '');
    const size = historyState.fileSizes[filename] || 0;
    if (size > 0) {
      estimated.set(
        dateStr,
        Math.max(1, Math.round(size / historyState.avgEntrySize)),
      );
    }
  }
  return estimated;
}

function getActivePinListId() {
  if (activeView.type === 'list') return activeView.id;
  return null;
}

function slugFromPinId(id) {
  if (id.startsWith(PAGE_PREFIX)) return entitySlug(id);
  if (id.startsWith(NOTE_PREFIX)) return entitySlug(id);
}

// Resolve an array of pins to display-ready objects with title/url populated.
// Loads entity context, resolves each pin via resolvePageRef, falls back to
// historyState.byUrl for pins with null entity title.
// Returns { pinsResolved, pageSnap } — pageSnap is needed by enrichPinResult.
async function resolvePinsForDisplay(pins) {
  const { pageSnap, noteSnap } = await loadPinContext(pins);
  const pinsResolved = pins.map((p) => {
    const ref = resolvePageRef(p.id, pageSnap, noteSnap);
    let url = ref?.url || null;
    let title = ref?.title || null;
    if (!title && url) {
      const hist = historyState.byUrl.get(url);
      if (hist?.title) title = hist.title;
    }
    return {
      ...p,
      url,
      title,
      user_title: ref?.user_title || null,
      isNote: ref?.isNote || false,
      childIds: ref?.childIds || [],
      parentIds: ref?.parentIds || [],
    };
  });
  return { pinsResolved, pageSnap };
}

// Resolve a typed page reference to entity-like data, or null.
// page:<slug> → page entity from pageSnap. note:<slug> → note entity.
function resolvePageRef(refId, pageSnap, noteSnap) {
  if (!refId) return null;
  if (refId.startsWith(PAGE_PREFIX)) {
    return pageSnap?.get(entitySlug(refId)) || null;
  }
  if (refId.startsWith(NOTE_PREFIX)) {
    const note = noteSnap?.get(entitySlug(refId));
    if (!note) return null;
    return {
      url: null,
      title: formatHighlightExcerpt(note.excerpt) || 'Note',
      user_title: null,
      isNote: true,
      note,
    };
  }
  return null;
}

// Load page entities for a set of pins from Desktop.
async function loadPinContext(pins) {
  const pagePinSlugs = [];
  const notePinSlugs = [];
  for (const p of pins) {
    if (p.id?.startsWith(PAGE_PREFIX)) pagePinSlugs.push(entitySlug(p.id));
    else if (p.id?.startsWith(NOTE_PREFIX)) notePinSlugs.push(entitySlug(p.id));
  }
  const pageSnap = new Map();
  if (pagePinSlugs.length > 0) {
    const pages = await Promise.all(
      pagePinSlugs.map((s) => readDesktopValue(pageKey(s))),
    );
    for (let i = 0; i < pagePinSlugs.length; i++) {
      if (pages[i]) pageSnap.set(pagePinSlugs[i], pages[i]);
    }
  }
  const noteSnap = new Map();
  if (notePinSlugs.length > 0) {
    const notes = await Promise.all(
      notePinSlugs.map((s) => readDesktopValue(noteKey(s))),
    );
    for (let i = 0; i < notePinSlugs.length; i++) {
      if (notes[i]) noteSnap.set(notePinSlugs[i], notes[i]);
    }
  }
  return { pageSnap, noteSnap };
}

async function toggleResultPin(listId, url, title) {
  await sendAction({ action: 'toggleListPin', listId, url });
  // Invalidate local cache — the entity now has the authoritative pin state.
  // The mutation notification will also invalidate, but callers that call
  // refreshPins() inline need the cache cleared before that runs.
  delete allListPins[listId];
}

// --- Layout switching (list vs normal vs recycle bin) ---
function showListLayout() {
  document.getElementById('timeChart').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('listLayout').classList.add('visible');
  document.getElementById('recycleBinLayout').classList.remove('visible');
  document.getElementById('queryBuilder').style.display = 'none';
  document.getElementById('inboxToggleBtn').style.display = 'none';
  document.getElementById('inboxPanel').style.display = 'none';
  document.getElementById('inboxToggleBtn').classList.remove('active');
  cancelRuleEdit();
}

function showNormalLayout() {
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('listLayout').classList.remove('visible');
  document.getElementById('recycleBinLayout').classList.remove('visible');
  document.getElementById('inboxToggleBtn').style.display = 'none';
  document.getElementById('inboxPanel').style.display = 'none';
  document.getElementById('inboxToggleBtn').classList.remove('active');
}

function showRecycleBinLayout() {
  document.getElementById('timeChart').classList.remove('visible');
  document.getElementById('resultsWrapper').style.display = 'none';
  document.getElementById('listLayout').classList.remove('visible');
  document.getElementById('recycleBinLayout').classList.add('visible');
  document.getElementById('queryBuilder').style.display = 'none';
  document.getElementById('inboxToggleBtn').style.display = 'none';
  document.getElementById('inboxPanel').style.display = 'none';
  document.getElementById('inboxToggleBtn').classList.remove('active');
}

// --- Recycle Bin ---

let recycleBinRenderSeq = 0;
let recycleBinBadgeSeq = 0;
let recycleBinEmptyBound = false;

async function readOrphanedManifestFresh() {
  const resp = await sendAction({
    action: 'readDesktopValue',
    key: 'manifest:orphaned',
    includeDeleted: true,
  });
  return resp?.value || { timestamp: 0, entries: [] };
}

async function isRestorableRecycleEntry(entry) {
  const key = entry?.key || '';
  if (key.startsWith(SNAPSHOT_PREFIX)) return true;
  if (!key.startsWith(NOTE_PREFIX) && !key.startsWith(LIST_PREFIX)) return true;

  try {
    const resp = await sendAction({
      action: 'readDesktopValue',
      key,
      includeDeleted: true,
    });
    const entity = resp?.value;
    if (!entity) return false;
    if (key.startsWith(NOTE_PREFIX)) {
      return entity.deletionReason !== 'replaced' && !entity.replacedBy;
    }
    return entity.deleted === true;
  } catch {
    return false;
  }
}

async function loadRecycleBinEntries() {
  const orphaned = await readOrphanedManifestFresh();
  const entries = orphaned?.entries || [];
  const flags = await Promise.all(entries.map(isRestorableRecycleEntry));
  return entries.filter((_, index) => flags[index]);
}

async function showRecycleBin() {
  bindRecycleBinEmptyButton();
  const renderSeq = ++recycleBinRenderSeq;
  activeView = { type: 'recycle-bin' };
  updateSidebarActive();
  updateMainTitle('Recycle Bin');
  showRecycleBinLayout();

  const itemsEl = document.getElementById('recycleBinItems');
  const emptyEl = document.getElementById('recycleBinEmpty');
  const headerEl = document.querySelector('.recycle-bin-header');

  let entries = [];
  try {
    entries = await loadRecycleBinEntries();
  } catch (error) {
    showErrorBubble(`Failed to load recycle bin: ${error.message}`, {
      suffix: '',
    });
  }
  if (renderSeq !== recycleBinRenderSeq || activeView.type !== 'recycle-bin') {
    return;
  }
  itemsEl.innerHTML = '';

  if (entries.length === 0) {
    emptyEl.style.display = '';
    headerEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  headerEl.style.display = '';
  const emptyBtn = document.querySelector('.empty-bin-btn');
  if (emptyBtn) emptyBtn.disabled = false;

  for (const { key } of entries) {
    const typeLabel = entityTypeLabel(key);
    const typeCls = 'type-' + typeLabel.toLowerCase();

    // Load entity to get human-readable display name
    let displayName = key;
    if (key.startsWith(SNAPSHOT_PREFIX)) {
      const snapStem = entitySlug(key);
      const lastDash = snapStem.lastIndexOf('-');
      const pageSlug = snapStem.slice(0, lastDash);
      const ts = parseInt(snapStem.slice(lastDash + 1), 10);
      // Try to load page entity for a human title
      try {
        const pageResp = await sendAction({
          action: 'readDesktopValue',
          key: pageKey(pageSlug),
          includeDeleted: true,
        });
        if (
          renderSeq !== recycleBinRenderSeq ||
          activeView.type !== 'recycle-bin'
        ) {
          return;
        }
        displayName = `${pageResp?.value?.title || pageSlug} — ${new Date(ts).toLocaleString()}`;
      } catch {
        if (
          renderSeq !== recycleBinRenderSeq ||
          activeView.type !== 'recycle-bin'
        ) {
          return;
        }
        displayName = `${pageSlug} — ${new Date(ts).toLocaleString()}`;
      }
    } else {
      try {
        const resp = await sendAction({
          action: 'readDesktopValue',
          key,
          includeDeleted: true,
        });
        if (
          renderSeq !== recycleBinRenderSeq ||
          activeView.type !== 'recycle-bin'
        ) {
          return;
        }
        const entity = resp?.value;
        if (entity) {
          if (key.startsWith(NOTE_PREFIX)) {
            const raw = entity.excerpt;
            const excerptText = Array.isArray(raw)
              ? raw.join(' ')
              : typeof raw === 'string'
                ? raw
                : '';
            if (excerptText) displayName = excerptText.substring(0, 80);
            else if (entity.note)
              displayName =
                (entity.excerpt === null ? 'Page note: ' : '') +
                entity.note.substring(0, 60);
            else if (entity.url) displayName = `Note on ${entity.url}`;
            else displayName = `Note (${entitySlug(key)})`;
          } else if (key.startsWith(LIST_PREFIX)) {
            displayName = entity.name || key;
          } else if (key.startsWith(PAGE_PREFIX)) {
            displayName = entity.title || entity.url || key;
          } else {
            displayName = entity.name || entity.title || entity.slug || key;
          }
        }
      } catch {}
    }
    if (
      renderSeq !== recycleBinRenderSeq ||
      activeView.type !== 'recycle-bin'
    ) {
      return;
    }

    const card = document.createElement('div');
    card.className = 'recycle-card';
    card.dataset.key = key;
    card.innerHTML = `
      <span class="entity-type-badge ${typeCls}">${escapeHtml(typeLabel)}</span>
      <div class="recycle-card-info">
        <div class="recycle-card-name">${escapeHtml(displayName)}</div>
        <div class="recycle-card-key">${escapeHtml(key)}</div>
      </div>
      <button class="restore-btn">Restore</button>
    `;
    card.querySelector('.restore-btn').addEventListener('click', async () => {
      const button = card.querySelector('.restore-btn');
      button.disabled = true;
      try {
        if (key.startsWith(SNAPSHOT_PREFIX)) {
          const snapSlug = entitySlug(key);
          await sendAction({ action: 'restoreSnapshot', snapSlug });
        } else if (key.startsWith(NOTE_PREFIX)) {
          const slug = entitySlug(key);
          await sendAction({ action: 'restoreNote', noteSlug: slug });
        } else if (key.startsWith(LIST_PREFIX)) {
          const id = entitySlug(key);
          await sendAction({ action: 'restoreList', listId: id });
        }
        await updateRecycleBinBadge();
        await showRecycleBin();
      } catch (error) {
        button.disabled = false;
        showErrorBubble(`Failed to restore item: ${error.message}`, {
          suffix: '',
        });
      }
    });
    itemsEl.appendChild(card);
  }
}

function bindRecycleBinEmptyButton() {
  const emptyBtn = document.querySelector('.empty-bin-btn');
  if (recycleBinEmptyBound) return;
  if (!emptyBtn) return;
  recycleBinEmptyBound = true;
  emptyBtn.addEventListener('click', async () => {
    emptyBtn.disabled = true;
    const itemsEl = document.getElementById('recycleBinItems');
    const emptyEl = document.getElementById('recycleBinEmpty');
    const headerEl = document.querySelector('.recycle-bin-header');
    try {
      await sendAction({ action: 'permanentDeleteAll' });
      recycleBinRenderSeq++;
      itemsEl.innerHTML = '';
      emptyEl.style.display = '';
      headerEl.style.display = 'none';
      const btn = document.getElementById('recycleBinBtn');
      const badge = document.getElementById('recycleBinCount');
      badge.textContent = '';
      btn.style.display = 'none';
      await updateRecycleBinBadge();
      if (activeView.type === 'recycle-bin') await showRecycleBin();
    } catch (error) {
      emptyBtn.disabled = false;
      showErrorBubble(`Failed to empty recycle bin: ${error.message}`, {
        suffix: '',
      });
    }
  });
}

async function updateRecycleBinBadge() {
  const badgeSeq = ++recycleBinBadgeSeq;
  const entries = await loadRecycleBinEntries().catch((error) => {
    logDebug('Recycle bin badge refresh failed:', error.message);
    return [];
  });
  if (badgeSeq !== recycleBinBadgeSeq) return;
  const count = entries.length;
  const btn = document.getElementById('recycleBinBtn');
  const badge = document.getElementById('recycleBinCount');
  badge.textContent = count > 0 ? String(count) : '';
  btn.style.display = count > 0 ? 'flex' : 'none';
}

// Search parsing and matching functions

function parseSearchWords(query) {
  if (!query || !query.trim()) return [];
  const words = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    if (m[1]) words.push({ q: m[1], exact: true });
    else words.push({ q: m[2], exact: false });
  }
  return words;
}

function matchesExactWithBoundary(text, q) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function wordsMatchItem(words, item) {
  if (words.length === 0) return true;
  return words.every(({ q, exact }) => {
    const fields = [item.user_title, item.title, item.url];
    return fields.some((f) => {
      if (!f) return false;
      if (exact) return matchesExactWithBoundary(f, q);
      return f.toLowerCase().includes(q.toLowerCase());
    });
  });
}

function createDefaultFilterState() {
  return {
    firstSeen: { lo: null, hi: null }, // null = unbounded (days ago)
    lastSeen: { lo: null, hi: null },
    devices: {}, // { deviceId: true } — only stores enabled devices; empty = show all
    lists: {}, // { listSlug: true } — only stores enabled lists; empty = show all
    hasHighlights: null, // null=any, true=require
    hasSnapshots: null,
    liked: null,
    visitedMultipleTimes: null,
  };
}

function isDefaultFilterState(state) {
  return (
    state.firstSeen.lo === null &&
    state.firstSeen.hi === null &&
    state.lastSeen.lo === null &&
    state.lastSeen.hi === null &&
    Object.keys(state.devices || {}).length === 0 &&
    Object.keys(state.lists || {}).length === 0 &&
    state.hasHighlights === null &&
    state.hasSnapshots === null &&
    state.liked === null &&
    state.visitedMultipleTimes === null
  );
}

async function applyFilters(results) {
  if (isDefaultFilterState(filterState)) return results;
  const now = Date.now();
  const enabledDevices = Object.entries(filterState.devices || {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const enabledLists = Object.entries(filterState.lists || {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return results.filter((item) => {
    // Device filter: when bubbles are active, only show items from at least one enabled device
    if (enabledDevices.length > 0) {
      if (!item.deviceIds || !enabledDevices.some((d) => item.deviceIds.has(d)))
        return false;
    }
    // List filter: when list bubbles active, only show items belonging to at least one enabled list
    if (enabledLists.length > 0) {
      const itemListSlugs = (item.parentIds || [])
        .filter((pid) => pid.startsWith(LIST_PREFIX) && !isSystemList(pid))
        .map((pid) => entitySlug(pid));
      if (!enabledLists.some((ls) => itemListSlugs.includes(ls))) return false;
    }
    // Time filters (days ago)
    if (filterState.lastSeen.lo !== null || filterState.lastSeen.hi !== null) {
      const lastTs = item.timestamps?.[0] || now;
      const daysAgo = (now - lastTs) / 86400000;
      if (filterState.lastSeen.lo !== null && daysAgo < filterState.lastSeen.lo)
        return false;
      if (filterState.lastSeen.hi !== null && daysAgo > filterState.lastSeen.hi)
        return false;
    }
    if (
      filterState.firstSeen.lo !== null ||
      filterState.firstSeen.hi !== null
    ) {
      const firstTs =
        item.firstTimestamp ||
        item.timestamps?.[item.timestamps.length - 1] ||
        now;
      const daysAgo = (now - firstTs) / 86400000;
      if (
        filterState.firstSeen.lo !== null &&
        daysAgo < filterState.firstSeen.lo
      )
        return false;
      if (
        filterState.firstSeen.hi !== null &&
        daysAgo > filterState.firstSeen.hi
      )
        return false;
    }
    // Page-specific booleans
    if (filterState.hasHighlights === true) {
      if (!item.notes || !item.notes.some((n) => n.excerpt !== null))
        return false;
    }
    if (filterState.hasSnapshots === true) {
      if (
        !item.childIds ||
        !item.childIds.some((id) => id.startsWith(SNAPSHOT_PREFIX))
      )
        return false;
    }
    if (filterState.liked === true) {
      if (!item.likes || item.likes <= 0) return false;
    }
    if (filterState.visitedMultipleTimes === true) {
      if (!item.visitCount || item.visitCount <= 1) return false;
    }
    return true;
  });
}

function saveFilterState() {
  const key =
    activeView.type === 'explore'
      ? 'exploreFilterState'
      : 'listFilterState:' + activeView.id;
  chrome.storage.session.set({ [key]: filterState });
}

async function loadFilterState() {
  const key =
    activeView.type === 'explore'
      ? 'exploreFilterState'
      : 'listFilterState:' + activeView.id;
  try {
    const data = await chrome.storage.session.get(key);
    if (data[key]) {
      filterState = data[key];
      if (!filterState.devices) filterState.devices = {};
      if (!filterState.lists) filterState.lists = {};
      return;
    }
  } catch {
    /* session miss */
  }
  filterState = createDefaultFilterState();
}

// --- Sort helpers ---
function getSortState(context) {
  if (context === 'pinned') return pinnedSortState;
  if (context === 'related') return relatedSortState;
  return currentSortState;
}

function setSortState(context, state) {
  if (context === 'pinned') pinnedSortState = state;
  else if (context === 'related') relatedSortState = state;
  else currentSortState = state;
}

function getExtraColumns(context) {
  if (context === 'pinned') return pinnedExtraColumns;
  if (context === 'related') return relatedExtraColumns;
  return currentExtraColumns;
}

function setExtraColumns(context, cols) {
  if (context === 'pinned') pinnedExtraColumns = cols;
  else if (context === 'related') relatedExtraColumns = cols;
  else currentExtraColumns = cols;
}

function getAvailableExtras(context) {
  if (context === 'pinned') return ['firstVisit', 'pinTime'];
  return ['firstVisit'];
}

const COLUMN_LABELS = {
  title: 'Title',
  relevance: 'Rel',
  lastVisit: 'Last Visit',
  firstVisit: 'First Visit',
  attention: 'Att',
  pinTime: 'Pin Time',
};

function applySortOrder(items, sortState) {
  if (!sortState || !sortState.column) return items;
  const { column, direction } = sortState;
  const dir = direction === 'asc' ? 1 : -1;

  // Precompute timestamp extremes once instead of per-comparison O(T) scans
  const needsTs =
    column === 'lastVisit' || column === 'firstVisit' || column === 'relevance';
  if (needsTs) {
    for (const item of items) {
      if (item._maxTs === undefined) {
        const ts = item.timestamps;
        if (ts && ts.length > 0) {
          let lo = ts[0],
            hi = ts[0];
          for (let i = 1; i < ts.length; i++) {
            if (ts[i] < lo) lo = ts[i];
            if (ts[i] > hi) hi = ts[i];
          }
          item._maxTs = hi;
          item._minTs = lo;
        } else {
          item._maxTs = item.latestTs || 0;
          item._minTs = item.latestTs || 0;
        }
      }
    }
  }

  return [...items].sort((a, b) => {
    let av, bv;
    switch (column) {
      case 'title':
        av = (a.user_title || a.title || '').toLowerCase();
        bv = (b.user_title || b.title || '').toLowerCase();
        return dir * av.localeCompare(bv);
      case 'lastVisit':
        return dir * ((a._maxTs || 0) - (b._maxTs || 0));
      case 'firstVisit':
        return dir * ((a._minTs || 0) - (b._minTs || 0));
      case 'attention':
        av = a.attScore || 0;
        bv = b.attScore || 0;
        return dir * (av - bv);
      case 'pinTime':
        av = a.pinnedAt || 0;
        bv = b.pinnedAt || 0;
        return dir * (av - bv);
      case 'totalVisits':
        av = a.visitCount || (a.timestamps ? a.timestamps.length : 0);
        bv = b.visitCount || (b.timestamps ? b.timestamps.length : 0);
        return dir * (av - bv);
      case 'relevance':
        av = a.score || 0;
        bv = b.score || 0;
        if (av !== bv) return dir * (av - bv);
        av = a._maxTs || a.latestTs || a.timestamp || 0;
        bv = b._maxTs || b.latestTs || b.timestamp || 0;
        return bv - av;
      default:
        return 0;
    }
  });
}

// --- Column headers ---
function columnHeaderHtml(context, opts = {}) {
  const sortState = getSortState(context);
  const extraCols = getExtraColumns(context);
  const { hasDelete = false, hasPin = false, showRelevance = false } = opts;

  function arrow(col) {
    if (sortState.column !== col) return '';
    return sortState.direction === 'desc' ? ' \u25BC' : ' \u25B2';
  }

  function activeClass(col) {
    return sortState.column === col ? ' active-sort' : '';
  }

  let html = `<div class="column-header-row" data-context="${context}">`;
  html += `<div class="col-spacer"></div>`;
  html += `<div class="col-header col-title${activeClass('title')}" data-col="title">${COLUMN_LABELS.title}${arrow('title')}</div>`;

  if (showRelevance) {
    html += `<div class="col-header col-rel${activeClass('relevance')}" data-col="relevance">${COLUMN_LABELS.relevance}${arrow('relevance')}</div>`;
  }

  html += `<div class="col-header col-time${activeClass('lastVisit')}" data-col="lastVisit">${COLUMN_LABELS.lastVisit}${arrow('lastVisit')}</div>`;

  if (extraCols.includes('firstVisit')) {
    html += `<div class="col-header col-time${activeClass('firstVisit')}" data-col="firstVisit">${COLUMN_LABELS.firstVisit}${arrow('firstVisit')}</div>`;
  }

  html += `<div class="col-header col-att${activeClass('attention')}" data-col="attention">${COLUMN_LABELS.attention}${arrow('attention')}</div>`;

  if (extraCols.includes('pinTime')) {
    html += `<div class="col-header col-time${activeClass('pinTime')}" data-col="pinTime">${COLUMN_LABELS.pinTime}${arrow('pinTime')}</div>`;
  }

  const availableExtras = getAvailableExtras(context);
  if (availableExtras.length > 0) {
    html += `<button class="col-add-btn" data-context="${context}" title="Add columns">+</button>`;
  }

  if (hasDelete) html += `<div class="col-action-spacer"></div>`;
  if (hasPin) html += `<div class="col-action-spacer"></div>`;

  html += `</div>`;
  return html;
}

function bindColumnHeaderClicks(container) {
  if (container._colHeaderDelegationBound) return;
  container._colHeaderDelegationBound = true;

  container.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.col-add-btn');
    if (addBtn) {
      e.stopPropagation();
      const context = addBtn.dataset.context;
      showColumnPopover(addBtn, context);
      return;
    }

    const header = e.target.closest('.col-header');
    if (!header) return;
    const col = header.dataset.col;
    const headerRow = header.closest('.column-header-row');
    if (!headerRow) return;
    const context = headerRow.dataset.context;
    const sortState = getSortState(context);

    let newState;
    if (sortState.column === col) {
      if (sortState.direction === 'desc') {
        newState = { column: col, direction: 'asc' };
      } else {
        newState = { column: null, direction: null };
      }
    } else {
      newState = { column: col, direction: 'desc' };
    }

    setSortState(context, newState);
    resortActiveScroller(context);
  });
}

let activePopover = null;

function showColumnPopover(anchorBtn, context) {
  if (activePopover) {
    activePopover.remove();
    activePopover = null;
  }

  const availableExtras = getAvailableExtras(context);
  const currentExtras = getExtraColumns(context);

  const popover = document.createElement('div');
  popover.className = 'col-popover';

  for (const col of availableExtras) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = currentExtras.includes(col);
    checkbox.dataset.col = col;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + COLUMN_LABELS[col]));
    popover.appendChild(label);

    checkbox.addEventListener('change', () => {
      const extras = getExtraColumns(context);
      if (checkbox.checked) {
        if (!extras.includes(col)) extras.push(col);
      } else {
        const idx = extras.indexOf(col);
        if (idx !== -1) extras.splice(idx, 1);
        const st = getSortState(context);
        if (st.column === col) {
          setSortState(context, { column: null, direction: null });
        }
      }
      setExtraColumns(context, extras);
      popover.remove();
      activePopover = null;
      refreshCurrentView();
    });
  }

  const rect = anchorBtn.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = rect.bottom + 4 + 'px';
  popover.style.right = window.innerWidth - rect.right + 'px';

  document.body.appendChild(popover);
  activePopover = popover;

  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorBtn) {
      popover.remove();
      activePopover = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

// Show chart frame immediately (rows fill in after data loads)
function renderResultsSkeleton(opts = {}) {
  const chartEl = document.getElementById('timeChart');
  chartEl.querySelector('.chart-bars').innerHTML = '';
  chartEl.classList.add('visible');

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = '';
  vs.setData([], () => '');
}

// Show list chart frames immediately
function renderListSkeleton() {
  const relatedChart = document.getElementById('relatedChart');
  relatedChart.querySelector('.chart-bars').innerHTML = '';
  relatedChart.classList.add('visible');
  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = '';
  vs.setData([], () => '');
}

function refreshCurrentView() {
  if (activeView.type === 'category') {
    showCategory(activeView.value);
  } else if (activeView.type === 'list') {
    showList({ slug: activeView.id, name: activeView.name });
  } else if (activeView.type === 'explore') {
    showExplore();
  } else if (activeView.type === 'recycle-bin') {
    showRecycleBin();
  }
}

function resortActiveScroller(context) {
  if (context === 'pinned') {
    refreshCurrentView();
    return;
  }
  const vs =
    context === 'related' ? relatedVirtualScroller : globalVirtualScroller;
  if (!vs || vs.data.length === 0) {
    refreshCurrentView();
    return;
  }

  const sortState = getSortState(context);
  const effectiveSort = sortState.column
    ? sortState
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder([...vs._fullData], effectiveSort);

  vs.updateData(sorted);
}

// --- Category filters ---
function filterByCategory(entries, category) {
  const now = Date.now();
  switch (category) {
    case 'today': {
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      return entries.filter((i) => i.timestamp >= startOfDay);
    }
    case 'week': {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      return entries.filter((i) => i.timestamp >= weekAgo);
    }
    case 'highlighted':
      return entries.filter((i) => i.likes > 0);
    case 'all':
    default:
      return entries;
  }
}

// Time chart tooltips initialized via initCharts() in initialize()

// --- Display ---
async function showCategory(category) {
  activeView = { type: 'category', value: category };
  updateSidebarActive();
  const categoryLabels = {
    all: 'History',
    today: 'Today',
    week: 'This Week',
    highlighted: 'Highlighted',
    explore: 'Explore',
  };
  updateMainTitle(categoryLabels[category] || category);
  document.getElementById('queryBuilder').style.display = 'none';

  renderResultsSkeleton();
  showNormalLayout();

  // Demand-load history
  await initHistoryFiles();
  await loadHistoryBatch();
  const allEntries = [...historyState.allEntries];
  allEntries.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = filterByCategory(allEntries, category);
  const estimatedByDay = category === 'all' ? getEstimatedByDay() : undefined;
  renderTimeChart(filtered, estimatedByDay);
  await displayHistoryRows(filtered);

  // Wire up demand-loading on scroll
  const vs = getOrCreateGlobalScroller();
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (newItems.length > 0) {
      const newFiltered = filterByCategory(newItems, activeView.value);
      if (newFiltered.length > 0) {
        const sort = currentSortState.column
          ? currentSortState
          : { column: 'lastVisit', direction: 'desc' };
        const newEntries = processHistoryForDisplay(newFiltered);
        vs.appendData(applySortOrder(newEntries, sort));
        // Enrich in background — re-render visible rows when done
        enrichFromEntityStorage(newEntries, { includeVisitDates: false }).then(
          () => vs.refreshVisible(),
        );
      }
      // Re-render chart with all loaded history + updated estimates
      const allLoaded = [...historyState.allEntries];
      const allFiltered = filterByCategory(allLoaded, activeView.value);
      const updatedEstimates =
        activeView.value === 'all' ? getEstimatedByDay() : undefined;
      renderTimeChart(allFiltered, updatedEstimates);
    }
  };
}

// --- Query builder: Predicate matchers ---
function parseKeywordQuery(value) {
  const m = value.match(/^"(.+)"$/);
  if (m) return { q: m[1], exact: true };
  return { q: value, exact: false };
}

function textMatches(text, q, exact) {
  if (!text) return false;
  if (exact) return matchesExactWithBoundary(text, q);
  return text.toLowerCase().includes(q.toLowerCase());
}

function matchKeyword(item, field, value) {
  if (!value) return false;
  const { q, exact } = parseKeywordQuery(value);
  const fields = normalizeFieldToArray(field);
  if (
    fields.includes('title') &&
    (textMatches(item.user_title, q, exact) ||
      textMatches(item.title, q, exact))
  )
    return true;
  if (fields.includes('url') && textMatches(item.url, q, exact)) return true;
  // 'captures' field search is handled by Phase 2b (snapshot search) in progressive search
  if (
    fields.includes('highlights') &&
    item.notes &&
    item.notes.some((n) => {
      if (n.excerpt === null) return false; // skip global notes
      const quotes = Array.isArray(n.excerpt) ? n.excerpt : [];
      return quotes.some((t) => textMatches(t, q, exact));
    })
  )
    return true;
  if (
    fields.includes('notes') &&
    item.notes &&
    item.notes.some((n) => textMatches(n.note, q, exact))
  )
    return true;
  return false;
}

// --- Query builder: Tree manipulation (n-ary operators) ---

// --- Stream-evaluate a qbTree against all JSONL files ---
// Deduplicates per-day: the same URL visited on different days produces separate
// results. Consumers must not assume results are unique by URL/slug.

// Save the committed search query to session storage (per-view, ephemeral)
function saveSearchQuery() {
  const viewKey =
    activeView.type === 'explore'
      ? 'explore'
      : activeView.type === 'list'
        ? listKey(activeView.id)
        : null;
  if (!viewKey) return;
  chrome.storage.session
    .set({ [`searchQueries:${viewKey}`]: committedSearchQuery.trim() })
    .catch(() => {});
}

// Load the committed search query from session storage for the current view
async function loadSearchQuery() {
  const viewKey =
    activeView.type === 'explore'
      ? 'explore'
      : activeView.type === 'list'
        ? listKey(activeView.id)
        : null;
  if (!viewKey) return [];
  const data = await chrome.storage.session.get(`searchQueries:${viewKey}`);
  return data[`searchQueries:${viewKey}`] || [];
}

function committedQueryFromSession(value) {
  if (Array.isArray(value)) {
    return value.find((query) => String(query || '').trim())?.trim() || '';
  }
  return String(value || '').trim();
}

// --- Query builder: Rendering ---

// Shared pin enrichment: merges cached page data, attention scores, and pin timestamps.
// Uses historyState.byUrl fallback for attention when page entity lacks it (showList behavior).
function enrichPinResult(r, pins, pageSnap) {
  if (!r.url && !r.slug) return r;
  const slug = r.slug || generateSlugFromUrl(r.url);
  const cached = pageSnap.get(slug);
  const source = cached && cached.watermark > (r.watermark || 0) ? cached : r;
  let attSource = source.attDetail || source;
  // Fallback: use attention from loaded history when page lacks it
  if (
    attSource.scrollDepth === undefined &&
    attSource.timeOnPage === undefined
  ) {
    const histEntry = historyState.byUrl.get(r.url);
    if (histEntry) attSource = histEntry;
  }
  const attScore = attentionStrength(attSource) || source.attScore || 0;
  const rSlug = slug;
  const pin = pins.find((p) => slugFromPinId(p.id) === rSlug);
  const enriched = {
    ...r,
    slug,
    attScore,
    attDetail: attSource,
    notes: source.notes || r.notes || [],
    timestamps: [source.watermark || r.watermark || r.pinnedAt || Date.now()],
    visitDates: cached?.visitDates || source.visitDates || r.visitDates,
    pinnedAt: pin ? pin.pinnedAt : r.pinnedAt || null,
    pinSource: pin?.source || r.pinSource || null,
  };
  if (source.user_title) enriched.user_title = source.user_title;
  return enriched;
}

// Summarize a query tree into a short display name for lists

async function showExplore() {
  const _t0 = performance.now();
  const _timer = (label) =>
    logDebug(
      `[explore-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`,
    );

  activeView = { type: 'explore', name: null };
  updateSidebarActive();
  updateMainTitle('Explore');

  showListLayout();
  resetMainScroll();
  preserveRelatedScrollOnNextRender = false;
  resetRelatedScrollOnNextRender = true;
  renderListSkeleton();

  try {
    committedSearchQuery = committedQueryFromSession(await loadSearchQuery());
    draftSearchInput = committedSearchQuery;

    await renderListSearchFilters();
    _timer('renderListSearchFilters');
  } catch (error) {
    logError('Explore load error:', error);
    document.getElementById('relatedResults').innerHTML =
      `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
  document.body.dataset.ready = 'true';
  revealApp();
}

// Incremental refresh after pin toggle — preserves scroll position and search state.
async function refreshPins() {
  if (activeView.type === 'explore') {
    runSearchFilterPipeline();
  } else if (activeView.type === 'list') {
    const listId = activeView.id;
    if (!allListPins[listId]) {
      const entity = await readDesktopValue(listKey(listId));
      allListPins[listId] = entity?.pins || [];
    }
    const pins = allListPins[listId];
    updatePinCount(listId, pins.length);
    if (pins.length === 0) {
      document.getElementById('relatedResults').innerHTML =
        '<div class="no-results">No pinned pages</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      const { pinsResolved, pageSnap } = await resolvePinsForDisplay(pins);
      const enriched = pinsResolved.map((r) =>
        enrichPinResult(r, pins, pageSnap),
      );
      await renderListPinView(enriched, listId);
    }
  }
}

async function showList(list) {
  const displayName = listDisplayName(list);
  activeView = { type: 'list', id: list.slug, name: list.name || null };
  committedSearchQuery = committedQueryFromSession(await loadSearchQuery());
  draftSearchInput = committedSearchQuery;
  updateSidebarActive();
  updateMainTitle(displayName);

  // Enable click rename on list title
  const titleEl = document.getElementById('mainTitle');
  function attachTitleClick(currentName) {
    titleEl.onclick = () => {
      enterTitleEditMode(
        currentName,
        async (newName) => {
          list.name = newName;
          await sendAction({
            action: 'saveListMeta',
            listId: list.slug,
            name: newName,
          });
          await renderLists();
          activeView.name = newName;
          updateMainTitle(newName);
          attachTitleClick(newName);
        },
        () => {
          updateMainTitle(currentName);
          attachTitleClick(currentName);
        },
      );
    };
  }
  attachTitleClick(displayName);
  showListLayout();
  resetMainScroll();
  preserveRelatedScrollOnNextRender = false;
  resetRelatedScrollOnNextRender = true;
  renderListSkeleton();

  try {
    const listId = list.slug;

    await loadFilterState();

    // Always fetch pins from entity storage
    const listEntity = await readDesktopValue(listKey(listId));
    allListPins[listId] = listEntity?.pins || [];
    const pins = allListPins[listId];
    updatePinCount(listId, pins.length);

    // Render rules section
    renderRulesSection(listId, listEntity?.rules || []);

    if (pins.length === 0) {
      listPinsData = [];
      listPinsListId = listId;
      await renderSearchPanel();
      document.getElementById('relatedResults').innerHTML =
        '<div class="no-results">No pinned pages</div>';
      document.getElementById('relatedChart').classList.remove('visible');
    } else {
      const { pinsResolved, pageSnap } = await resolvePinsForDisplay(pins);
      const enriched = pinsResolved.map((r) =>
        enrichPinResult(r, pins, pageSnap),
      );
      await renderListPinView(enriched, listId);
    }
  } catch (error) {
    logError('List load error:', error);
    document.getElementById('relatedResults').innerHTML =
      `<div class="no-results">${escapeHtml('Error: ' + error.message)}</div>`;
  }
}

// ─── Rules section ──────────────────────────────────────────────────

function ruleDescription(rule) {
  const c = rule.config || {};
  if (rule.type === 'keyword') {
    return c.pattern || '';
  } else if (rule.type === 'function') {
    return c.description || '(custom function)';
  }
  return rule.type || 'unknown';
}

function renderRulesSection(listId, rules) {
  const inboxBtn = document.getElementById('inboxToggleBtn');
  const panel = document.getElementById('inboxPanel');

  if (listId.startsWith('system/')) {
    inboxBtn.style.display = 'none';
    panel.style.display = 'none';
    return;
  }

  inboxBtn.style.display = '';
  if (rules.length > 0) {
    inboxBtn.classList.add('has-rules');
  } else {
    inboxBtn.classList.remove('has-rules');
  }

  renderRulesList(listId, rules);
}

function renderRulesList(listId, rules) {
  const container = document.getElementById('rulesList');
  if (rules.length === 0) {
    container.innerHTML = '';
    return;
  }
  const typeLabel = (t) => t;
  container.innerHTML = rules
    .map((rule) => {
      return `<div class="rule-entry" data-rule-id="${escapeHtml(rule.id)}">
      <div class="rule-header">
        <span class="rule-type-badge rule-type-${escapeHtml(rule.type)}">${escapeHtml(typeLabel(rule.type))}</span>
        <span class="rule-desc">${escapeHtml(ruleDescription(rule))}</span>
        <button class="rule-action-btn rule-edit" title="Edit">&#x270E;</button>
        <button class="rule-action-btn rule-remove" title="Remove">&times;</button>
      </div>
    </div>`;
    })
    .join('');

  container.querySelectorAll('.rule-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entry = btn.closest('.rule-entry');
      const ruleId = entry.dataset.ruleId;
      const rule = rules.find((r) => r.id === ruleId);
      if (rule) startRuleEdit(listId, ruleId, rule);
    });
  });

  container.querySelectorAll('.rule-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = btn.closest('.rule-entry');
      const ruleId = entry.dataset.ruleId;
      try {
        await sendAction({ action: 'removeRule', listId, ruleId });
        await refreshRulesForActiveList();
      } catch (err) {
        showErrorBubble('Failed to remove rule: ' + err.message);
      }
    });
  });
}

async function refreshRulesForActiveList() {
  if (activeView.type !== 'list') return;
  const listId = activeView.id;
  const listEntity = await readDesktopValue(listKey(listId));
  renderRulesSection(listId, listEntity?.rules || []);
}

// ─── Inline rule editing state ───
let previewResults = [];
let previewPinsResults = [];
let previewHistoryRunning = false;
let previewPinsRunning = false;
let previewAbort = null;

function previewEntriesLocally(rule, entries) {
  if (rule?.type !== 'keyword') return null;
  return (entries || []).map((entry) => {
    const pageData = {
      title: entry.title || '',
      url: entry.url || '',
    };
    if (entry.bodyPreview || entry.body) {
      pageData.body = entry.bodyPreview || entry.body;
    }
    return {
      url: entry.url,
      title: entry.title || '',
      match: matchKeywordRule(rule, pageData) === 1,
    };
  });
}

function collectPinnedPreviewEntries() {
  return Array.from(document.querySelectorAll('.result-row[data-url]'))
    .map((row) => ({
      url: row.dataset.url || '',
      title: row.querySelector('.result-title')?.textContent?.trim() || '',
    }))
    .filter((entry) => entry.url && entry.title);
}

async function previewRuleEntries(rule, entries) {
  const localResults = previewEntriesLocally(rule, entries);
  if (localResults) {
    return { success: true, results: localResults };
  }
  return await sendAction({ action: 'previewRule', rule, entries });
}

function renderPreviewSection(results, listEl, countEl, running) {
  const matches = results.filter((r) => r.match);
  const spinnerHtml = running
    ? ' <span class="spinner spinner-sm"></span>'
    : '';
  countEl.innerHTML = `${matches.length} matches (${results.length} checked)${spinnerHtml}`;
  if (matches.length === 0) {
    listEl.innerHTML = running
      ? ''
      : '<div class="rules-preview-empty">No matches</div>';
    return;
  }
  listEl.innerHTML = matches
    .map(
      (r) =>
        `<div class="rules-preview-item">
      <span class="rules-preview-title">${escapeHtml(r.title || r.url)}</span>
    </div>`,
    )
    .join('');
}

function rerenderPreview() {
  if (previewResults.length > 0 || previewHistoryRunning) {
    renderPreviewSection(
      previewResults,
      document.getElementById('rulesPreviewList'),
      document.getElementById('rulesPreviewCount'),
      previewHistoryRunning,
    );
  }
  if (previewPinsResults.length > 0 || previewPinsRunning) {
    renderPreviewSection(
      previewPinsResults,
      document.getElementById('rulesPinsPreviewList'),
      document.getElementById('rulesPinsPreviewCount'),
      previewPinsRunning,
    );
  }
}

/** Build rule object from the currently active edit row. Returns { rule } or { error }. */
function buildRuleFromEditRow() {
  const editRow = document.querySelector('.rule-entry.rule-editing');
  if (!editRow) return { error: 'No edit row' };
  const activeType =
    editRow.querySelector('.rule-type-option.active')?.dataset.type ||
    'keyword';
  const inputVal = editRow.querySelector('.rule-edit-input').value.trim();
  if (activeType === 'keyword') {
    if (!inputVal) return { error: 'Pattern is required' };
    return {
      rule: {
        type: 'keyword',
        config: { pattern: inputVal },
      },
    };
  } else if (activeType === 'function') {
    const fnSource =
      editRow.querySelector('.rule-fn-input')?.value.trim() || '';
    if (!fnSource) return { error: 'Function body is required' };
    return {
      rule: {
        type: 'function',
        config: { description: inputVal || '(custom)', fnSource },
      },
    };
  }
  return { error: 'Unknown rule type' };
}

function cancelRuleEdit() {
  previewResults = [];
  previewPinsResults = [];
  document.getElementById('rulesPreview').style.display = 'none';
  document.getElementById('rulesPinsPreview').style.display = 'none';
  document.getElementById('rulesFormError').style.display = 'none';
  refreshRulesForActiveList();
}

const JS_KEYWORDS = new Set([
  'break',
  'case',
  'catch',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'of',
  'return',
  'switch',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'await',
  'async',
  'class',
]);
const JS_LITERALS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'this',
]);
const JS_TOKEN_RE =
  /\/\/.*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/(?:[^/\\]|\\.)+\/[gimsuy]*|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[a-zA-Z_$][\w$]*|[^\s]/g;

function highlightJS(src) {
  return src.replace(JS_TOKEN_RE, (tok) => {
    if (tok.startsWith('//') || tok.startsWith('/*'))
      return `<span class="tok-comment">${escapeHtml(tok)}</span>`;
    if (tok[0] === '"' || tok[0] === "'" || tok[0] === '`')
      return `<span class="tok-string">${escapeHtml(tok)}</span>`;
    if (tok[0] === '/' && tok.length > 1 && tok[1] !== '/')
      return `<span class="tok-regex">${escapeHtml(tok)}</span>`;
    if (/^\d/.test(tok))
      return `<span class="tok-number">${escapeHtml(tok)}</span>`;
    if (JS_KEYWORDS.has(tok))
      return `<span class="tok-keyword">${escapeHtml(tok)}</span>`;
    if (JS_LITERALS.has(tok))
      return `<span class="tok-literal">${escapeHtml(tok)}</span>`;
    return escapeHtml(tok);
  });
}

function syncHighlight(textarea, pre) {
  pre.innerHTML = highlightJS(textarea.value) + '\n';
}

function buildEditRowHTML(type, config) {
  const isKeyword = (type || 'keyword') === 'keyword';
  const inputValue = isKeyword
    ? config?.pattern || ''
    : config?.description || '';
  const inputPlaceholder = isKeyword ? 'keyword or /regex/' : 'description';
  const fnSource = config?.fnSource || '';
  return `<div class="rule-entry rule-editing">
    <div class="rule-edit-main">
      <div class="rule-type-toggle">
        <span class="rule-type-option ${isKeyword ? 'active' : ''}" data-type="keyword">Keyword</span>
        <span class="rule-type-option ${!isKeyword ? 'active' : ''}" data-type="function">Function</span>
      </div>
      <input class="rule-edit-input" type="text" value="${escapeHtml(inputValue)}" placeholder="${inputPlaceholder}">
      <button class="rule-preview-btn">Preview</button>
      <button class="rule-cancel-btn" title="Cancel">&times;</button>
      <button class="rule-save-btn" title="Save (Enter)">OK</button>
    </div>
    <div class="rule-fn-editor" style="${isKeyword ? 'display:none' : ''}">
      <pre class="rule-fn-highlight" aria-hidden="true"></pre>
      <textarea class="rule-fn-input" rows="20" placeholder="// page = { title, url, body }\nreturn page.title.length > 50;" spellcheck="false">${escapeHtml(fnSource)}</textarea>
    </div>
  </div>`;
}

function attachEditRowHandlers(editRow, listId, existingRuleId) {
  // Type toggle
  editRow.querySelectorAll('.rule-type-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      editRow
        .querySelectorAll('.rule-type-option')
        .forEach((o) => o.classList.remove('active'));
      opt.classList.add('active');
      const type = opt.dataset.type;
      const input = editRow.querySelector('.rule-edit-input');
      input.placeholder =
        type === 'keyword' ? 'keyword or /regex/' : 'description';
      editRow.querySelector('.rule-fn-editor').style.display =
        type === 'function' ? '' : 'none';
    });
  });

  // Save handler (shared by button click and Enter key)
  async function saveCurrentRule() {
    const errorEl = document.getElementById('rulesFormError');
    errorEl.style.display = 'none';
    const built = buildRuleFromEditRow();
    if (built.error) {
      errorEl.textContent = built.error;
      errorEl.style.display = '';
      return;
    }
    try {
      if (existingRuleId) {
        await sendAction({
          action: 'removeRule',
          listId,
          ruleId: existingRuleId,
        });
      }
      await sendAction({ action: 'addRule', listId, rule: built.rule });
      cancelRuleEdit();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = '';
    }
  }

  editRow
    .querySelector('.rule-save-btn')
    .addEventListener('click', saveCurrentRule);

  // Cancel
  editRow
    .querySelector('.rule-cancel-btn')
    .addEventListener('click', () => cancelRuleEdit());

  // Preview
  editRow
    .querySelector('.rule-preview-btn')
    .addEventListener('click', () => runPreview());

  // Enter key saves (but not inside the function textarea — let Enter create newlines there)
  editRow.addEventListener('keydown', (e) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.target.classList.contains('rule-fn-input')
    ) {
      e.preventDefault();
      saveCurrentRule();
    }
  });

  // Syntax highlight sync
  const fnTextarea = editRow.querySelector('.rule-fn-input');
  const fnPre = editRow.querySelector('.rule-fn-highlight');
  syncHighlight(fnTextarea, fnPre);
  fnTextarea.addEventListener('input', () => syncHighlight(fnTextarea, fnPre));
  fnTextarea.addEventListener('scroll', () => {
    fnPre.scrollTop = fnTextarea.scrollTop;
    fnPre.scrollLeft = fnTextarea.scrollLeft;
  });

  // Focus input
  editRow.querySelector('.rule-edit-input').focus();
}

function startRuleEdit(listId, ruleId, rule) {
  // Close any existing edit row (synchronous — no async refresh)
  const existing = document.querySelector('.rule-entry.rule-editing');
  if (existing) existing.remove();
  previewResults = [];
  previewPinsResults = [];
  document.getElementById('rulesPreview').style.display = 'none';
  document.getElementById('rulesPinsPreview').style.display = 'none';
  document.getElementById('rulesFormError').style.display = 'none';

  const container = document.getElementById('rulesList');
  if (ruleId) {
    // Replace existing display row with edit row
    const displayRow = container.querySelector(
      `.rule-entry[data-rule-id="${ruleId}"]`,
    );
    if (displayRow) {
      displayRow.insertAdjacentHTML(
        'afterend',
        buildEditRowHTML(rule.type, rule.config),
      );
      displayRow.remove();
    }
  } else {
    // Append new edit row
    container.insertAdjacentHTML('beforeend', buildEditRowHTML('keyword', {}));
  }
  const editRow = container.querySelector('.rule-entry.rule-editing');
  attachEditRowHandlers(editRow, listId, ruleId);
}

async function runPreviewAgainstHistory(rule, signal) {
  const MAX_CHECKED = 100;
  const MAX_MATCHES = 20;
  const BATCH_SIZE = 20;
  const previewListEl = document.getElementById('rulesPreviewList');
  const previewCountEl = document.getElementById('rulesPreviewCount');

  previewHistoryRunning = true;
  rerenderPreview();

  let matchCount = 0;
  let checked = 0;
  const seenUrls = new Set();

  const today = new Date();
  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    if (signal?.aborted) break;
    if (checked >= MAX_CHECKED || matchCount >= MAX_MATCHES) break;
    const d = new Date(today);
    d.setDate(d.getDate() - dayOffset);
    const dateKey = d.toISOString().slice(0, 10);
    const dayEntries = await loadHistoryEntriesForDate(dateKey);
    const visits = dayEntries
      .filter(
        (e) =>
          (!e.action || e.action === 'visit_page') &&
          e.url &&
          e.title &&
          !seenUrls.has(e.url),
      )
      .reverse();
    const uniqueVisits = [];
    for (const v of visits) {
      if (!seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        uniqueVisits.push(v);
      }
    }
    if (uniqueVisits.length === 0) continue;

    for (let i = 0; i < uniqueVisits.length; i += BATCH_SIZE) {
      if (signal?.aborted) break;
      if (checked >= MAX_CHECKED || matchCount >= MAX_MATCHES) break;
      const remaining = Math.min(BATCH_SIZE, MAX_CHECKED - checked);
      const batch = uniqueVisits.slice(i, i + remaining);
      const entries = [];
      if (rule?.type === 'keyword') {
        for (const entry of batch) {
          entries.push({
            timestamp: entry.timestamp,
            action: entry.action || 'visit_page',
            url: entry.url,
            title: entry.title || '',
          });
        }
      } else {
        const bodies = await Promise.all(
          batch.map((e) =>
            e.bodyPreview
              ? Promise.resolve(e.bodyPreview)
              : fetchPageBody(e.url),
          ),
        );
        for (let j = 0; j < batch.length; j++) {
          if (!bodies[j]) continue;
          entries.push({
            timestamp: batch[j].timestamp,
            action: batch[j].action || 'visit_page',
            url: batch[j].url,
            title: batch[j].title || '',
            bodyPreview: bodies[j],
          });
        }
      }
      if (entries.length === 0) continue;
      const resp = await previewRuleEntries(rule, entries);
      for (const r of resp.results || []) {
        previewResults.push(r);
        checked++;
        if (r.match) matchCount++;
      }
      rerenderPreview();
    }
  }
  previewHistoryRunning = false;
  if (checked === 0 && !signal?.aborted) {
    previewCountEl.textContent = '';
    previewListEl.innerHTML =
      '<div class="rules-preview-empty">No visits found to match against</div>';
  } else {
    rerenderPreview();
  }
}

async function runPreviewAgainstPins(rule, listId, signal) {
  const BATCH_SIZE = 5;
  const pinsPreviewEl = document.getElementById('rulesPinsPreview');
  const pinsPreviewListEl = document.getElementById('rulesPinsPreviewList');
  const pinsPreviewCountEl = document.getElementById('rulesPinsPreviewCount');

  const pinMeta = collectPinnedPreviewEntries();

  if (pinMeta.length === 0) {
    const listEntity = await readDesktopValue(listKey(listId));
    for (const pin of listEntity?.pins || []) {
      if (signal?.aborted) break;
      const page = await readDesktopValue(pin.id);
      if (!page?.url) continue;
      const title = page.user_title || page.title || '';
      if (!title) continue;
      pinMeta.push({ url: page.url, title });
    }
  }
  if (pinMeta.length === 0) return;

  pinsPreviewEl.style.display = '';
  previewPinsRunning = true;
  rerenderPreview();

  let checked = 0;
  for (let i = 0; i < pinMeta.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = pinMeta.slice(i, i + BATCH_SIZE);
    const bodies = await Promise.all(batch.map((e) => fetchPageBody(e.url)));
    const entries = [];
    for (let j = 0; j < batch.length; j++) {
      const entry = {
        url: batch[j].url,
        title: batch[j].title,
      };
      if (bodies[j]) {
        entry.bodyPreview = bodies[j];
      }
      entries.push(entry);
      checked++;
    }
    if (entries.length > 0) {
      const resp = await previewRuleEntries(rule, entries);
      for (const r of resp.results || []) {
        previewPinsResults.push(r);
      }
    }
    rerenderPreview();
  }

  previewPinsRunning = false;
  if (checked === 0 && !signal?.aborted) {
    pinsPreviewCountEl.textContent = '';
    pinsPreviewListEl.innerHTML =
      '<div class="rules-preview-empty">No pinned pages available for preview</div>';
  } else {
    rerenderPreview();
  }
}

function cancelPreview() {
  if (previewAbort) {
    previewAbort.abort();
    previewAbort = null;
  }
}

async function runPreview() {
  if (previewAbort) {
    cancelPreview();
    return;
  }

  const errorEl = document.getElementById('rulesFormError');
  const previewEl = document.getElementById('rulesPreview');
  const previewListEl = document.getElementById('rulesPreviewList');
  const previewCountEl = document.getElementById('rulesPreviewCount');
  const pinsPreviewEl = document.getElementById('rulesPinsPreview');
  const pinsPreviewListEl = document.getElementById('rulesPinsPreviewList');
  errorEl.style.display = 'none';
  previewEl.style.display = 'none';
  previewListEl.innerHTML = '';
  pinsPreviewEl.style.display = 'none';
  pinsPreviewListEl.innerHTML = '';

  const built = buildRuleFromEditRow();
  if (built.error) {
    errorEl.textContent = built.error;
    errorEl.style.display = '';
    return;
  }

  const ac = new AbortController();
  previewAbort = ac;

  const previewBtn = document.querySelector('.rule-preview-btn');
  if (previewBtn) {
    previewBtn.textContent = 'Cancel Preview';
  }
  previewEl.style.display = '';

  previewResults = [];
  previewPinsResults = [];
  const keywordPinPreview = previewEntriesLocally(
    built.rule,
    collectPinnedPreviewEntries(),
  );
  if (keywordPinPreview && keywordPinPreview.length > 0) {
    document.getElementById('rulesPinsPreview').style.display = '';
    previewPinsResults = keywordPinPreview;
    rerenderPreview();
  }

  try {
    await runPreviewAgainstHistory(built.rule, ac.signal);

    if (!ac.signal.aborted) {
      const listId =
        activeView.type === 'list'
          ? activeView.id
          : document.querySelector('.sidebar-item.active[data-list-id]')
              ?.dataset.listId || null;
      if (listId && !keywordPinPreview) {
        await runPreviewAgainstPins(built.rule, listId, ac.signal);
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      previewEl.style.display = '';
      previewListEl.innerHTML = `<div class="rules-preview-error">${escapeHtml(err.message)}</div>`;
      previewCountEl.textContent = '';
      if (previewPinsResults.length === 0) {
        pinsPreviewEl.style.display = 'none';
      }
    }
  } finally {
    previewHistoryRunning = false;
    previewPinsRunning = false;
    previewAbort = null;
    if (previewBtn) {
      previewBtn.textContent = 'Preview';
    }
    rerenderPreview();
  }
}

function initRulesPanel() {
  document.getElementById('rulesAddBtn').addEventListener('click', () => {
    if (activeView.type !== 'list') return;
    startRuleEdit(activeView.id, null, null);
  });

  document.getElementById('inboxToggleBtn').addEventListener('click', () => {
    const panel = document.getElementById('inboxPanel');
    const btn = document.getElementById('inboxToggleBtn');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    btn.classList.toggle('active', !visible);
  });
}

// Module-level storage for list pin data (used by search filtering)
let listPinsData = [];
let listPinsListId = null;

// Render all pins into #relatedResults with search filtering support
async function renderListPinView(allPins, listId) {
  listPinsData = allPins;
  listPinsListId = listId;
  await renderSearchPanel();
  await runListPinFilter();
}

// Run the active view's search pipeline after an explicit commit/filter change.
function runActiveSearchPipeline() {
  if (activeView.type === 'explore') {
    if (runActiveSearchPipeline._preserveScroll) {
      preserveRelatedScrollOnNextRender = true;
    }
    runSearchFilterPipeline();
  } else if (activeView.type === 'list') {
    if (runActiveSearchPipeline._preserveScroll) {
      preserveRelatedScrollOnNextRender = true;
    }
    runListPinFilter();
  }
  runActiveSearchPipeline._preserveScroll = false;
}

// Filter list pins by the committed query, then apply filters
async function runListPinFilter() {
  const allQueries = committedSearchQuery.trim()
    ? [committedSearchQuery.trim()]
    : [];

  let filtered;
  if (allQueries.length === 0 || allQueries.every((q) => !q.trim())) {
    filtered = listPinsData;
  } else {
    filtered = listPinsData.filter((r) => {
      return allQueries.some((query) => {
        const words = parseSearchWords(query);
        return wordsMatchItem(words, r);
      });
    });
  }

  // Apply structured filters (same as explore)
  if (!isDefaultFilterState(filterState)) {
    await enrichForFilters(filtered);
  }
  filtered = await applyFilters(filtered);

  renderFilteredPins(filtered, listPinsListId, allQueries.join(' '));
}

function disableRelatedVirtualScrollerForDirectRender(container) {
  if (container._virtualScroller) {
    container._virtualScroller.data = [];
    container._virtualScroller._fullData = [];
    container._virtualScroller.renderedRange = { start: -1, end: -1 };
    container._virtualScroller.onLoadMore = null;
  }
  container._virtualScroller = null;
  container.style.paddingTop = '0px';
  container.style.paddingBottom = '';
}

// Render filtered pin results directly so list selection can operate on every row.
function renderFilteredPins(pins, listId, searchQuery) {
  const relatedContainer = document.getElementById('relatedResults');
  disableRelatedVirtualScrollerForDirectRender(relatedContainer);

  if (pins.length === 0) {
    consumeRelatedTopReset();
    relatedContainer.innerHTML = searchQuery.trim()
      ? '<div class="no-results">No matching pins</div>'
      : '<div class="no-results">No pinned pages</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column
    ? relatedSortState
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder([...pins], effectiveSort);
  const maxAtt = Math.max(...sorted.map((r) => r.attScore), 0.1);

  const preserveScroll = preserveRelatedScrollOnNextRender;
  preserveRelatedScrollOnNextRender = false;
  const renderAtTop = preserveScroll ? false : consumeRelatedTopReset();
  if (renderAtTop) {
    document.querySelector('.main').scrollTop = 0;
  }
  const previousScrollTop = document.querySelector('.main').scrollTop;
  relatedContainer.innerHTML = sorted
    .map((r) =>
      resultRowHtml(r.user_title || r.title, r.url, {
        pinned: true,
        attScore: r.attScore,
        maxAtt,
        attDetail: r.attDetail,
        notes: r.notes,
        timestamps: r.timestamps,
        visitDates: r.visitDates,
        context: 'related',
        pinnedAt: r.pinnedAt,
        pinSource: r.pinSource,
        childIds: r.childIds,
        parentIds: r.parentIds,
        excludeListId: listId,
        likes: r.likes,
        hasHighlightNotes: r.hasHighlightNotes,
      }),
    )
    .join('');
  if (preserveScroll)
    document.querySelector('.main').scrollTop = previousScrollTop;
  bindPinClicks(relatedContainer, listId);

  // Time chart for pins
  const chartData = sorted.map((r) => ({
    url: r.url,
    timestamp: r.timestamps?.[0] || r.pinnedAt || Date.now(),
    timestamps: r.timestamps,
    visitDates: r.visitDates,
    attention: '',
  }));
  const relatedChart = prepareRelatedChartDateFilter(
    `list:${listId}:${searchQuery.trim()}`,
  );
  relatedChart._onDateSelect = null;
  renderTimeChartInto(
    relatedChart,
    document.getElementById('relatedChartBars'),
    chartData,
    'Pinned pages',
  );
  bindChartBarClick(relatedChart, relatedContainer);
  applyPersistedRelatedDateFilter();
}

// renderPinnedWithRelated removed — pinned section only shows pinned rows

// recalculateRelatedResults removed — pinned section no longer has related pages

async function renderListSearchFilters() {
  await initHistoryFiles();
  await loadHistoryBatch();

  await loadFilterState();
  await renderSearchPanel();
  await runSearchFilterPipeline();
}

// Convert raw history entries to display entries with date-boundary dedup.
// Each URL appears at most once per calendar day, sorted newest-first.
function processHistoryForDisplay(entries, { globalDedup = false } = {}) {
  // Sort newest first
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  const results = [];
  const globalIndex = globalDedup ? new Map() : null; // url → index in results
  const seenByDay = globalDedup ? null : new Map(); // YYYYMMDD → Set<url>

  for (const item of sorted) {
    const d = new Date(item.timestamp);
    const day =
      d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

    if (globalDedup) {
      if (globalIndex.has(item.url)) {
        const existing = results[globalIndex.get(item.url)];
        existing.timestamps.push(item.timestamp);
        if (item.deviceId) existing.deviceIds.add(item.deviceId);
        continue;
      }
      globalIndex.set(item.url, results.length);
    } else {
      if (!seenByDay.has(day)) seenByDay.set(day, new Set());
      const daySet = seenByDay.get(day);
      if (daySet.has(item.url)) continue;
      daySet.add(item.url);
    }
    const deviceIds = new Set();
    if (item.deviceId) deviceIds.add(item.deviceId);
    results.push({
      url: item.url,
      title: item.title || historyState.byUrl.get(item.url)?.title || '',
      user_title:
        item.user_title || historyState.byUrl.get(item.url)?.user_title,
      slug: item.slug || generateSlugFromUrl(item.url),
      timestamp: item.timestamp,
      day,
      attScore: attentionStrength(item),
      attDetail: item,
      notes: [],
      timestamps: [item.timestamp],
      latestTs: item.timestamp,
      deviceIds,
      dateScope: globalDedup ? 'page' : 'row',
    });
  }
  return results;
}

// Batch-fetch page entities for all unique slugs in entries, enrich with entity titles.
async function enrichFromEntityStorage(entries, opts = {}) {
  const { includeVisitDates = true } = opts;
  const allSlugs = [...new Set(entries.map((r) => r.slug).filter(Boolean))];
  if (allSlugs.length === 0) return;
  const loaded = await Promise.all(
    allSlugs.map((s) => readDesktopValue(pageKey(s))),
  );
  const pages = {};
  for (let i = 0; i < allSlugs.length; i++) {
    if (loaded[i]) pages[allSlugs[i]] = loaded[i];
  }
  // Collect all unique note refs across all pages for batch loading
  const allNoteRefs = new Set();
  for (const slug of allSlugs) {
    const page = pages[slug];
    if (!page?.childIds) continue;
    for (const id of page.childIds) {
      if (id.startsWith(NOTE_PREFIX)) allNoteRefs.add(id);
    }
  }
  // Batch-load note entities to determine which pages have highlight notes
  const noteMap = new Map();
  if (allNoteRefs.size > 0) {
    const noteKeys = [...allNoteRefs];
    const noteEntities = await Promise.all(
      noteKeys.map((k) => readDesktopValue(k)),
    );
    for (let i = 0; i < noteKeys.length; i++) {
      if (noteEntities[i]) noteMap.set(noteKeys[i], noteEntities[i]);
    }
  }

  for (const entry of entries) {
    const page = pages[entry.slug];
    if (!page) continue;
    if (!entry.title && page.title) entry.title = page.title;
    if (!entry.user_title && page.user_title)
      entry.user_title = page.user_title;
    if (page.childIds) entry.childIds = page.childIds;
    if (page.parentIds) entry.parentIds = page.parentIds;
    if (page.likes) entry.likes = page.likes;
    if (page.createdAt && !entry.createdAt) entry.createdAt = page.createdAt;
    if (includeVisitDates && entry.dateScope !== 'row' && page.visitDates) {
      entry.visitDates = page.visitDates;
    }
    // Check if any child note is a non-deleted highlight note (excerpt !== null)
    const noteRefs = (page.childIds || []).filter((id) =>
      id.startsWith(NOTE_PREFIX),
    );
    entry.hasHighlightNotes = noteRefs.some((ref) => {
      const note = noteMap.get(ref);
      return note && note.excerpt !== null && !note.deleted;
    });
  }
}

// Enrich results with page entity fields needed by filters (notes, childIds, visitCount).
// Only called when non-default filters are active.
async function enrichForFilters(entries) {
  const slugs = [...new Set(entries.map((r) => r.slug).filter(Boolean))];
  if (slugs.length === 0) return;
  const loaded = await Promise.all(
    slugs.map((s) => readDesktopValue(pageKey(s))),
  );
  const pages = {};
  for (let i = 0; i < slugs.length; i++) {
    if (loaded[i]) pages[slugs[i]] = loaded[i];
  }
  // Batch-load all note entities referenced by childIds
  const allNoteRefs = new Set();
  for (const slug of slugs) {
    const page = pages[slug];
    if (!page?.childIds) continue;
    for (const id of page.childIds) {
      if (id.startsWith(NOTE_PREFIX)) allNoteRefs.add(id);
    }
  }
  const noteMap = new Map();
  if (allNoteRefs.size > 0) {
    const noteKeys = [...allNoteRefs];
    const noteEntities = await Promise.all(
      noteKeys.map((k) => readDesktopValue(k)),
    );
    for (let i = 0; i < noteKeys.length; i++) {
      if (noteEntities[i]) noteMap.set(noteKeys[i], noteEntities[i]);
    }
  }
  // Pre-compute URL→visit-count map once (O(N)) instead of per-entry scan (O(N²))
  let visitCountMap = null;
  for (const entry of entries) {
    const page = pages[entry.slug];
    if (!page) continue;
    if (page.childIds) {
      entry.childIds = page.childIds;
      const noteRefs = page.childIds.filter((id) => id.startsWith(NOTE_PREFIX));
      const notes = noteRefs
        .map((ref) => noteMap.get(ref))
        .filter((n) => n && !n.deleted);
      if (notes.length > 0) entry.notes = notes;
    }
    if (page.parentIds) entry.parentIds = page.parentIds;
    if (entry.dateScope !== 'row' && page.visitDates) {
      entry.visitDates = page.visitDates;
    }
    if (page.timestamps && Object.keys(page.timestamps).length > 0) {
      if (!entry.deviceIds || entry.deviceIds.size === 0) {
        entry.deviceIds = new Set(Object.keys(page.timestamps));
      }
      const tsValues = Object.values(page.timestamps).filter(
        (ts) => typeof ts === 'number',
      );
      if (
        tsValues.length > 0 &&
        (!Array.isArray(entry.timestamps) || entry.timestamps.length === 0)
      ) {
        entry.timestamps = tsValues.sort((a, b) => b - a);
        entry.latestTs = entry.timestamps[0];
        entry.timestamp = entry.latestTs;
        delete entry._maxTs;
        delete entry._minTs;
      }
    }
    if (entry.visitCount === undefined) {
      if (!visitCountMap) {
        visitCountMap = new Map();
        for (const h of historyState.allEntries) {
          if (h.url)
            visitCountMap.set(h.url, (visitCountMap.get(h.url) || 0) + 1);
        }
      }
      entry.visitCount = visitCountMap.get(entry.url) || 0;
    }
  }
}

async function displayHistoryRows(entries) {
  if (!entries || entries.length === 0) {
    displayMessage('No history entries found');
    return;
  }

  const displayEntries = processHistoryForDisplay(entries);

  // When sort is null, default to lastVisit desc
  const effectiveSort = currentSortState.column
    ? currentSortState
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(displayEntries, effectiveSort);
  const maxAtt = Math.max(...sorted.map((e) => e.attScore), 0.1);

  const vs = getOrCreateGlobalScroller();
  vs._headerHtml = '';
  const renderFn = (e) =>
    resultRowHtml(e.user_title || e.title, e.url, {
      attScore: e.attScore,
      maxAtt,
      attDetail: e.attDetail,
      notes: e.notes,
      timestamps: e.timestamps,
      context: 'global',
      childIds: e.childIds,
      parentIds: e.parentIds,
      likes: e.likes,
      hasHighlightNotes: e.hasHighlightNotes,
    });
  vs.setData(sorted, renderFn);

  // Enrich in background — mutates entries in place, then re-render visible rows
  enrichFromEntityStorage(displayEntries, { includeVisitDates: false }).then(
    () => vs.refreshVisible(),
  );
}

const PIN_SVG =
  '<svg viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z"/></svg>';
const DELETE_SVG =
  '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function buildDetailHtml(url, attDetail, notes, likes = 0) {
  let html = `<div class="detail-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>`;

  const hasMetrics = attDetail || likes > 0;
  if (hasMetrics) {
    html += '<div class="detail-metrics">';
    if (attDetail?.timeOnPage) {
      const mins = Math.round(attDetail.timeOnPage / 60000);
      if (mins > 0)
        html += `<span class="detail-metric"><strong>${mins}m</strong> on page</span>`;
    }
    if (attDetail?.scrollDepth) {
      html += `<span class="detail-metric"><strong>${Math.round(attDetail.scrollDepth)}%</strong> scrolled</span>`;
    }
    if (attDetail?.clicks) {
      html += `<span class="detail-metric"><strong>${attDetail.clicks}</strong> clicks</span>`;
    }
    if (likes > 0) {
      html += `<span class="detail-metric"><strong>${likes}</strong> ${likes === 1 ? 'like' : 'likes'}</span>`;
    }
    html += '</div>';
  }

  if (notes && notes.length > 0) {
    html += '<div class="detail-notes">';
    for (const n of notes.slice(0, 5)) {
      if (n.excerpt === null) continue; // skip global notes
      const text = formatHighlightExcerpt(n.excerpt);
      if (text)
        html += `<div class="detail-note-item">${escapeHtml(text)}</div>`;
    }
    html += '</div>';
  }

  return html;
}

function bindDetailUrlHandlers(container) {
  container.querySelectorAll('.detail-url a[href]').forEach((link) => {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = link.getAttribute('href');
      if (!url) return;
      try {
        await chrome.tabs.create({ url });
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  });
}

// Lazy-load extra detail data (notes, lists, snapshots) when detail is expanded
async function loadExtraDetail(url) {
  const slug = generateSlugFromUrl(url);

  // Load notes for this page
  const notesResp = await sendAction({ action: 'loadPageNotes', slug });
  const notes = notesResp.notes || [];

  const snapResp = await sendAction({ action: 'listSnapshots', slug });
  const snapshots = snapResp.snapshots || [];

  // Load page entity for likes
  const pageEntity = await readDesktopValue(pageKey(slug));
  const likes = pageEntity?.likes || 0;

  // Page entities materialize list membership via parentIds.
  const lists = await loadLists();
  const belongedLists = [];
  const knownLists = new Map(lists.map((lst) => [lst.slug, lst]));
  for (const parentId of pageEntity?.parentIds || []) {
    if (!parentId.startsWith(LIST_PREFIX) || isSystemList(parentId)) continue;
    const listSlug = entitySlug(parentId);
    const list =
      knownLists.get(listSlug) || (await readDesktopValue(listKey(listSlug)));
    if (list && !list.deleted) belongedLists.push(listDisplayName(list));
  }

  return {
    notes,
    snapshots,
    belongedLists,
    slug,
    likes,
    visitDates: pageEntity?.visitDates || [],
  };
}

function renderVisitDatesHtml(visitDates, cardTimestamp) {
  const fmtDate = (ts) =>
    new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  if (visitDates.length > 0) {
    const parse = (yyyymmdd) => {
      const y = Math.floor(yyyymmdd / 10000);
      const m = Math.floor((yyyymmdd % 10000) / 100) - 1;
      const d = yyyymmdd % 100;
      return new Date(y, m, d).getTime();
    };
    const sorted = [...visitDates].sort((a, b) => a - b);
    const first = parse(sorted[0]);
    const last = parse(sorted[sorted.length - 1]);
    let html = `<div class="detail-section detail-visit-dates"><span class="detail-visit-line"><span class="detail-section-label">First visited:</span> ${escapeHtml(fmtDate(first))}</span>`;
    if (sorted.length > 1) {
      html += `<span class="detail-visit-line"><span class="detail-section-label">Last visited:</span> ${escapeHtml(fmtDate(last))}</span>`;
    }
    html += '</div>';
    return html;
  }

  if (cardTimestamp) {
    return `<div class="detail-section detail-visit-dates"><span class="detail-visit-line">${escapeHtml(fmtDate(cardTimestamp))}</span></div>`;
  }

  return '';
}

const DETAIL_ICON_EDIT =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>';
const DETAIL_ICON_DELETE =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';

function renderExtraDetailHtml(extra, cardTimestamp) {
  let html = '';

  html += renderVisitDatesHtml(extra.visitDates, cardTimestamp);

  if (extra.belongedLists.length > 0) {
    html += '<div class="detail-section">';
    html += extra.belongedLists
      .map((t) => `<span class="detail-list-tag">${escapeHtml(t)}</span>`)
      .join(' ');
    html += '</div>';
  }

  const globalNote = extra.notes.find((n) => n.excerpt === null);
  const pageNoteText = globalNote?.note || '';
  const pageNoteSlug = globalNote?.slug || '';
  html += `<div class="detail-section"><div class="detail-page-note-wrap" data-note-slug="${escapeHtml(pageNoteSlug)}" data-page-slug="${escapeHtml(extra.slug)}">`;
  if (!pageNoteText && !pageNoteSlug) {
    html += `<button class="detail-page-note-add">+ Add page note</button>`;
  } else {
    html += `<div class="detail-page-note-display">
      <span class="note-body">${escapeHtml(pageNoteText)}</span>
      <button class="detail-note-action-btn edit" title="Edit">${DETAIL_ICON_EDIT}</button>
    </div>`;
  }
  html += `</div></div>`;

  const highlightNotes = extra.notes.filter(
    (n) => !n.deleted && n.excerpt !== null,
  );
  if (highlightNotes.length > 0) {
    html += `<div class="detail-section detail-notes-section" data-slug="${escapeHtml(extra.slug)}">`;
    for (const n of highlightNotes.slice(0, 20)) {
      const noteSlug = n.slug || '';
      const noteText = n.note || '';
      const rawQuote = formatHighlightExcerpt(n.excerpt);
      const noteBody = noteText
        ? `<span class="detail-note-content">${escapeHtml(noteText)}</span>`
        : `<em>No annotation</em>`;
      html += `<div class="detail-note-entry" data-note-slug="${escapeHtml(noteSlug)}">
        <div class="detail-note-header">
          <div class="detail-note-excerpt">${escapeHtml(rawQuote)}</div>
          <button class="detail-note-action-btn delete" title="Delete highlight">${DETAIL_ICON_DELETE}</button>
        </div>
        <div class="detail-note-body">
          ${noteBody}
          <button class="detail-note-action-btn edit" title="Edit note">${DETAIL_ICON_EDIT}</button>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  if (extra.snapshots.length > 0) {
    html += '<div class="detail-section">';
    html += `<div class="detail-snapshots" data-slug="${escapeHtml(extra.slug)}">`;
    for (const s of extra.snapshots) {
      const date = new Date(s.timestamp).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      html += `<div class="detail-snapshot-row" data-ts="${s.timestamp}">`;
      html += `<span class="detail-snapshot-time">${escapeHtml(date)}</span>`;
      html += '<span class="detail-snapshot-badges">';
      if (s.hasMd)
        html += `<span class="detail-snapshot-badge md" data-ts="${s.timestamp}">Markdown</span>`;
      if (s.hasHtml)
        html += `<span class="detail-snapshot-badge html" data-ts="${s.timestamp}">HTML</span>`;
      html += `<button class="detail-snapshot-delete" data-ts="${s.timestamp}" title="Delete snapshot">&times;</button>`;
      html += '</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  return html;
}

function bindNoteDeleteButtons(container) {
  container
    .querySelectorAll('.detail-note-action-btn.delete')
    .forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entry = btn.closest('.detail-note-entry');
        const section = btn.closest('.detail-notes-section');
        const noteSlug = entry?.dataset.noteSlug;

        if (!noteSlug) return;

        try {
          await sendAction({
            action: 'deleteNote',
            noteSlug,
          });
        } catch (err) {
          logError('Delete note error:', err);
          return;
        }

        entry.remove();
        if (
          section &&
          section.querySelectorAll('.detail-note-entry').length === 0
        ) {
          section.remove();
        }
      });
    });

  container
    .querySelectorAll('.detail-note-entry .detail-note-action-btn.edit')
    .forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const entry = btn.closest('.detail-note-entry');
        const noteSlug = entry?.dataset.noteSlug;
        if (!noteSlug) return;
        openDetailNoteEditor(entry, noteSlug);
      });
    });
}

function openDetailNoteEditor(entry, noteSlug) {
  const body = entry.querySelector('.detail-note-body');
  const contentEl = body.querySelector('.detail-note-content, em');
  const currentText =
    contentEl?.textContent === 'No annotation'
      ? ''
      : contentEl?.textContent || '';
  body.innerHTML = `<textarea class="detail-note-edit-textarea" placeholder="Add a note...">${escapeHtml(currentText)}</textarea>`;
  const ta = body.querySelector('textarea');
  autoResizeTextarea(ta);
  ta.focus();

  let saveTimeout = null;
  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const resp = await sendAction({
          action: 'updateNote',
          noteSlug,
          note: ta.value,
        });
        if (resp?.noteSlug && resp.noteSlug !== noteSlug) {
          entry.dataset.noteSlug = resp.noteSlug;
          noteSlug = resp.noteSlug;
        }
      } catch (err) {
        logError('[options] Note save error:', err);
      }
    }, 500);
  });

  ta.addEventListener('blur', () => {
    clearTimeout(saveTimeout);
    sendAction({ action: 'updateNote', noteSlug, note: ta.value })
      .then((resp) => {
        if (resp?.noteSlug && resp.noteSlug !== noteSlug) {
          entry.dataset.noteSlug = resp.noteSlug;
        }
      })
      .catch(() => {});
    const noteText = ta.value;
    const noteBody = noteText
      ? `<span class="detail-note-content">${escapeHtml(noteText)}</span>`
      : `<em>No annotation</em>`;
    body.innerHTML = `${noteBody}
      <button class="detail-note-action-btn edit" title="Edit note">${DETAIL_ICON_EDIT}</button>`;
    bindNoteDeleteButtons(
      entry.closest('.detail-notes-section') || entry.parentElement,
    );
  });
}

function bindSnapshotClickHandlers(container) {
  container.querySelectorAll('.detail-snapshot-row').forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const slug = row.closest('.detail-snapshots')?.dataset.slug;
      const ts = parseInt(row.dataset.ts, 10);
      if (!slug || !ts) return;
      await sendAction({
        action: 'openSnapshot',
        slug,
        timestamp: ts,
      });
    });
  });
  container.querySelectorAll('.detail-snapshot-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.detail-snapshot-row');
      const section = btn.closest('.detail-snapshots');
      const slug = section?.dataset.slug;
      const ts = parseInt(btn.dataset.ts, 10);
      if (!slug || !ts) return;
      try {
        await sendAction({
          action: 'deleteSnapshot',
          slug,
          timestamp: ts,
        });
      } catch (err) {
        logError('Delete snapshot error:', err);
        return;
      }
      row.remove();
      if (
        section &&
        section.querySelectorAll('.detail-snapshot-row').length === 0
      ) {
        section.closest('.detail-section')?.remove();
      }
      await updateRecycleBinBadge();
      if (activeView.type === 'recycle-bin') await showRecycleBin();
    });
  });
}

function bindPageNoteHandler(container, url) {
  const wrap = container.querySelector('.detail-page-note-wrap');
  if (!wrap) return;

  const addBtn = wrap.querySelector('.detail-page-note-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openDetailPageNoteEditor(wrap, '', wrap.dataset.noteSlug || '', url);
    });
  }

  const editBtn = wrap.querySelector(
    '.detail-page-note-display .detail-note-action-btn.edit',
  );
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      const bodyEl = wrap.querySelector('.note-body');
      openDetailPageNoteEditor(
        wrap,
        bodyEl?.textContent || '',
        wrap.dataset.noteSlug || '',
        url,
      );
    });
  }
}

function openDetailPageNoteEditor(wrap, text, noteSlug, url) {
  const pageSlug = wrap.dataset.pageSlug;
  wrap.innerHTML = `<textarea class="detail-page-note-textarea" placeholder="Add a page note...">${escapeHtml(text)}</textarea>`;
  const ta = wrap.querySelector('textarea');
  autoResizeTextarea(ta);
  ta.focus();

  let saveTimeout = null;
  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(
      () => saveDetailPageNote(ta, wrap, pageSlug, url),
      500,
    );
  });

  ta.addEventListener('blur', () => {
    clearTimeout(saveTimeout);
    saveDetailPageNote(ta, wrap, pageSlug, url).then(() => {
      const noteText = ta.value;
      const currentSlug = wrap.dataset.noteSlug || '';
      if (!noteText && !currentSlug) {
        wrap.innerHTML = `<button class="detail-page-note-add">+ Add page note</button>`;
        bindPageNoteHandler(
          wrap.closest('.detail-section').parentElement || wrap.parentElement,
          url,
        );
      } else if (noteText) {
        wrap.innerHTML = `<div class="detail-page-note-display">
          <span class="note-body">${escapeHtml(noteText)}</span>
          <button class="detail-note-action-btn edit" title="Edit">${DETAIL_ICON_EDIT}</button>
        </div>`;
        bindPageNoteHandler(
          wrap.closest('.detail-section').parentElement || wrap.parentElement,
          url,
        );
      } else {
        wrap.innerHTML = `<button class="detail-page-note-add">+ Add page note</button>`;
        bindPageNoteHandler(
          wrap.closest('.detail-section').parentElement || wrap.parentElement,
          url,
        );
      }
    });
  });
}

async function saveDetailPageNote(ta, wrap, pageSlug, url) {
  const note = ta.value;
  const noteSlug = wrap.dataset.noteSlug;
  try {
    if (noteSlug) {
      const resp = await sendAction({ action: 'updateNote', noteSlug, note });
      if (resp?.noteSlug && resp.noteSlug !== noteSlug) {
        wrap.dataset.noteSlug = resp.noteSlug;
      }
    } else if (note) {
      const resp = await sendAction({
        action: 'createNote',
        pageSlug,
        url,
        excerpt: null,
        note,
        cssPath: null,
      });
      if (resp?.noteSlug) {
        wrap.dataset.noteSlug = resp.noteSlug;
      }
    }
  } catch (err) {
    logError('[options] Page note save error:', err);
  }
}

function attentionLevel(normalized) {
  if (!normalized || normalized <= 0) return '';
  if (normalized >= 0.75) return 'high';
  if (normalized >= 0.4) return 'med';
  return 'low';
}

function resultRowHtml(title, url, opts = {}) {
  const safeUrl = escapeHtml(url || '<unknown>');
  const {
    pinned,
    deletable = false,
    attScore = 0,
    maxAtt = 1,
    attDetail = null,
    notes = [],
    timestamps = [],
    visitDates = [],
    context = 'global',
    pinnedAt,
    pinSource,
    cssClass,
    childIds = [],
    parentIds = [],
    excludeListId,
    likes = 0,
    matchSources,
    hasHighlightNotes,
  } = opts;

  const lastVisit =
    timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;

  let site = '';
  try {
    const parsed = new URL(url);
    site =
      parsed.protocol === 'file:'
        ? 'file'
        : parsed.hostname.replace(/^www\./, '');
  } catch {}

  const safeTitle = escapeHtml(title || site || url || '<unknown>');

  const dates = collectVisitDateKeys({ visitDates, timestamps }).join(',');

  const hasNotes = hasHighlightNotes === true;
  const hasSnaps = childIds.some((id) => id.startsWith(SNAPSHOT_PREFIX));
  const belongedListNames = [];
  for (const pid of parentIds) {
    if (!pid.startsWith(LIST_PREFIX) || isSystemList(pid)) continue;
    const listSlug = entitySlug(pid);
    if (excludeListId && listSlug === excludeListId) continue;
    const name = listNameById.get(listSlug);
    if (name) belongedListNames.push(name);
  }
  const attLvl = attentionLevel(normalized);
  if (url)
    cardDataByUrl.set(url, {
      attDetail: attDetail
        ? {
            timeOnPage: attDetail.timeOnPage,
            scrollDepth: attDetail.scrollDepth,
            clicks: attDetail.clicks,
          }
        : null,
      timestamps,
    });
  const attCtrlHtml = `<div class="att-ctrl${attLvl ? ' ' + attLvl : ''}" data-url="${safeUrl}" data-title="${safeTitle}"><span class="att-ctrl-dot"></span><button class="att-ctrl-btn" title="View details"><span class="att-ctrl-icon" aria-hidden="true">⋯</span></button></div>`;
  const listTagsHtml = belongedListNames
    .map((n) => `<span class="card-tag card-tag-list">${escapeHtml(n)}</span>`)
    .join('');
  const isLiked = likes > 0;
  const isAuto = pinSource === 'auto';
  const matchNoteHit = matchSources && matchSources.has('note');
  const matchSnapHit = matchSources && matchSources.has('snapshot');
  const hasExtras =
    hasNotes ||
    hasSnaps ||
    isLiked ||
    isAuto ||
    listTagsHtml ||
    matchNoteHit ||
    matchSnapHit;
  const extrasHtml = hasExtras
    ? `<div class="card-extras">${isAuto ? '<span class="card-tag card-tag-auto">auto</span>' : ''}${isLiked ? '<span class="card-tag card-tag-liked">liked</span>' : ''}${hasNotes ? '<span class="card-tag card-tag-note">note</span>' : ''}${hasSnaps ? '<span class="card-tag card-tag-snap">snapshot</span>' : ''}${matchNoteHit ? '<span class="card-tag card-tag-match-note">matched in note</span>' : ''}${matchSnapHit ? '<span class="card-tag card-tag-match-snap">matched in snapshot</span>' : ''}${listTagsHtml}</div>`
    : '';
  const cardActionsHtml = deletable
    ? `<div class="card-actions"><button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="Delete">${DELETE_SVG}</button></div>`
    : '';

  return `<div class="result-item${cssClass ? ' ' + cssClass : ''}" draggable="true">
    <div class="result-row" data-url="${safeUrl}" data-title="${safeTitle}" data-dates="${dates}">
      <div class="card-row">
        <div class="result-title">${safeTitle}</div>
        <span class="result-site">${escapeHtml(site)}</span>
        <span class="result-time">${escapeHtml(lastVisit)}</span>
        ${attCtrlHtml}
      </div>
      ${cardActionsHtml}
    </div>
    ${extrasHtml}
  </div>`;
}

function bindResultDelegation(container) {
  if (container._resultDelegationBound) return;
  container._resultDelegationBound = true;

  container.addEventListener('selectstart', (e) => {
    if (e.target.closest('.result-item')) e.preventDefault();
  });

  container.addEventListener('click', (e) => {
    if (e.target.closest('.att-ctrl-btn')) {
      e.stopPropagation();
      const ctrl = e.target.closest('.att-ctrl');
      if (ctrl) {
        const { attDetail = null, timestamps = [] } =
          cardDataByUrl.get(ctrl.dataset.url) || {};
        const cardTs = timestamps.length > 0 ? Math.max(...timestamps) : null;
        openPageDetailCard(
          ctrl.dataset.url,
          ctrl.dataset.title,
          attDetail,
          cardTs,
        );
      }
      return;
    }
    if (e.target.closest('.card-actions') || e.target.closest('.att-ctrl')) {
      e.stopPropagation();
      return;
    }

    const item = e.target.closest('.result-item');
    if (!item || marqueeActive) return;
    const row = item.querySelector('.result-row');
    if (!row) return;

    const allRows = [...container.querySelectorAll('.result-row')];
    if (e.shiftKey && lastClickedRow) {
      const anchorIdx = allRows.indexOf(lastClickedRow);
      const curIdx = allRows.indexOf(row);
      if (anchorIdx !== -1 && curIdx !== -1) {
        const [lo, hi] =
          anchorIdx < curIdx ? [anchorIdx, curIdx] : [curIdx, anchorIdx];
        if (!e.ctrlKey && !e.metaKey)
          allRows.forEach((r) => r.classList.remove('selected'));
        for (let i = lo; i <= hi; i++) allRows[i].classList.add('selected');
      }
    } else if (e.ctrlKey || e.metaKey) {
      row.classList.toggle('selected');
      lastClickedRow = row;
    } else {
      const clickedOnlySelected =
        row.classList.contains('selected') &&
        allRows.filter((r) => r.classList.contains('selected')).length === 1;
      container._virtualScroller?.clearSelection?.();
      allRows.forEach((r) => r.classList.remove('selected'));
      if (clickedOnlySelected) {
        lastClickedRow = null;
      } else {
        row.classList.add('selected');
        lastClickedRow = row;
      }
    }
    syncChartHighlights();
  });

  container.addEventListener('dblclick', (e) => {
    if (
      e.target.closest('.result-pin') ||
      e.target.closest('.card-actions') ||
      e.target.closest('.att-ctrl')
    )
      return;
    const item = e.target.closest('.result-item');
    if (!item) return;
    const row = item.querySelector('.result-row');
    if (!row) return;
    chrome.tabs.create({ url: row.dataset.url });
  });

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.result-item');
    const row = item?.querySelector('.result-row');
    if (!row) return;
    // Include all selected rows if the dragged row is part of a selection
    const selected = container.querySelectorAll('.result-row.selected');
    const items =
      selected.length > 0 && row.classList.contains('selected')
        ? [...selected].map((r) => ({
            url: r.dataset.url,
            title: r.dataset.title,
          }))
        : [{ url: row.dataset.url, title: row.dataset.title }];
    e.dataTransfer.setData('text/plain', JSON.stringify({ items }));
    e.dataTransfer.effectAllowed = 'copy';
    if (items.length > 1 && typeof e.dataTransfer.setDragImage === 'function') {
      const preview = document.createElement('div');
      preview.className = 'result-drag-preview';
      preview.innerHTML = items
        .slice(0, 6)
        .map(
          (dragItem) =>
            `<div class="result-drag-preview-row">${escapeHtml(dragItem.title || dragItem.url || '')}</div>`,
        )
        .join('');
      if (items.length > 6) {
        preview.insertAdjacentHTML(
          'beforeend',
          `<div class="result-drag-preview-more">+${items.length - 6} more</div>`,
        );
      }
      document.body.appendChild(preview);
      e.dataTransfer.setDragImage(preview, 16, 16);
      requestAnimationFrame(() => preview.remove());
    }
  });
}

function openPageDetailCard(
  url,
  title,
  attDetail = null,
  cardTimestamp = null,
) {
  closePageDetailCard();

  const overlay = document.createElement('div');
  overlay.id = 'pageDetailOverlay';
  overlay.className = 'page-detail-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePageDetailCard();
  });

  const card = document.createElement('div');
  card.className = 'page-detail-card';
  card.innerHTML = `
    <div class="page-detail-header">
      <div class="page-detail-title">${escapeHtml(title || url)}</div>
      <button class="page-detail-close" title="Close">×</button>
    </div>
    <div class="page-detail-body"><div class="page-detail-loading"><span class="spinner"></span></div></div>
  `;
  card
    .querySelector('.page-detail-close')
    .addEventListener('click', closePageDetailCard);
  card.querySelector('.page-detail-title').addEventListener('click', () => {
    startEditingDetailTitle(card, url);
  });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  // Allow one frame for backdrop-filter compositing before fading in
  requestAnimationFrame(() => overlay.classList.add('visible'));

  if (!url || url === '<unknown>') {
    const body = card.querySelector('.page-detail-body');
    body.innerHTML =
      '<div style="padding:16px;color:var(--text-muted)">Page details unavailable</div>';
  } else {
    loadExtraDetail(url)
      .then((extra) => {
        const body = card.querySelector('.page-detail-body');
        let html = buildDetailHtml(url, attDetail, [], extra.likes || 0);
        const extraHtml = renderExtraDetailHtml(extra, cardTimestamp);
        body.innerHTML =
          html +
          (extraHtml ? `<div class="detail-extra">${extraHtml}</div>` : '');
        bindDetailUrlHandlers(body);
        bindNoteDeleteButtons(body);
        bindSnapshotClickHandlers(body);
        bindPageNoteHandler(body, url);
      })
      .catch(() => {
        const body = card.querySelector('.page-detail-body');
        if (body)
          body.innerHTML =
            '<div style="padding:16px;color:var(--text-muted)">Failed to load page details</div>';
      });
  }

  const onEsc = (e) => {
    if (e.key === 'Escape') closePageDetailCard();
  };
  overlay._escHandler = onEsc;
  document.addEventListener('keydown', onEsc);
}

function startEditingDetailTitle(card, url) {
  const titleEl = card.querySelector('.page-detail-title');
  if (!titleEl || titleEl.tagName === 'INPUT') return;
  const currentTitle = titleEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'page-detail-title-input';
  input.value = currentTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  async function saveTitle() {
    const newTitle = input.value.trim() || currentTitle;
    const newTitleEl = document.createElement('div');
    newTitleEl.className = 'page-detail-title';
    newTitleEl.textContent = newTitle;
    newTitleEl.addEventListener('click', () =>
      startEditingDetailTitle(card, url),
    );
    input.replaceWith(newTitleEl);

    if (newTitle !== currentTitle) {
      try {
        await sendAction({ action: 'renamePage', url, userTitle: newTitle });
      } catch (err) {
        logError('[options] Failed to save user title:', err);
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

function closePageDetailCard() {
  const overlay = document.getElementById('pageDetailOverlay');
  if (overlay) {
    if (overlay._escHandler)
      document.removeEventListener('keydown', overlay._escHandler);
    overlay.remove();
  }
}

function parseShellRoute(route) {
  const [path = '', query = ''] = String(route || '').split('?');
  return {
    path,
    params: new URLSearchParams(query),
  };
}

async function openPageDetailFromRoute(url) {
  if (!url) return;
  if (activeView.type !== 'explore') {
    await showExplore();
  }
  const slug = generateSlugFromUrl(url);
  const page = await readDesktopValue(pageKey(slug), true).catch(() => null);
  const title = page?.user_title || page?.title || url;
  const timestamps = Object.values(page?.timestamps || {});
  const cardTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;
  openPageDetailCard(url, title, null, cardTimestamp);
}

async function applyPendingShellRoute() {
  if (
    applyingShellRoute ||
    !pendingShellRoute ||
    document.body.dataset.ready !== 'true'
  ) {
    return;
  }
  applyingShellRoute = true;
  const route = pendingShellRoute;
  pendingShellRoute = null;
  try {
    const { path, params } = parseShellRoute(route);
    if (path === 'settings') {
      await openSettingsModal();
      return;
    }
    if (path === 'open') {
      closeSettingsModal();
      const url = params.get('url');
      if (url) {
        await openPageDetailFromRoute(url);
      } else if (activeView.type !== 'explore') {
        await showExplore();
      }
    }
  } catch (error) {
    logDebug('[shell-route] failed to apply route:', route, error.message);
  } finally {
    applyingShellRoute = false;
  }
}

window.__renderBrowserRecall = () => {
  pendingShellRoute = window.__BR_STATE__?.route || null;
  void applyPendingShellRoute();
};

function bindPinClicks(container, listId) {
  // Use delegation — store listId on container for the handler
  container._pinListId = listId;
  if (container._pinDelegationBound) return;
  container._pinDelegationBound = true;

  container.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.result-pin');
    if (!pinBtn) return;
    e.stopPropagation();
    const url = pinBtn.dataset.pinUrl;
    const title = pinBtn.dataset.pinTitle;
    const cid = container._pinListId;
    await toggleResultPin(cid, url, title);
    refreshPins();
  });
}

// Virtual scroller instances for main results and list explore results
let globalVirtualScroller = null;
let relatedVirtualScroller = null;

function getOrCreateGlobalScroller() {
  const containerEl = document.getElementById('results');
  if (!globalVirtualScroller) {
    const scrollEl = document.querySelector('.main');
    globalVirtualScroller = new VirtualScroller(scrollEl, containerEl);
    bindResultDelegation(containerEl);
    bindColumnHeaderClicks(containerEl);
  }
  // Always refresh pin target for the active view
  bindPinClicks(containerEl, getActivePinListId());
  return globalVirtualScroller;
}

function getOrCreateRelatedScroller() {
  if (!relatedVirtualScroller) {
    const scrollEl = document.querySelector('.main');
    const containerEl = document.getElementById('relatedResults');
    relatedVirtualScroller = new VirtualScroller(scrollEl, containerEl);
    bindResultDelegation(containerEl);
    bindColumnHeaderClicks(containerEl);
  }
  return relatedVirtualScroller;
}

function displayMessage(msg) {
  document.getElementById('timeChart').classList.remove('visible');
  // Reset virtual scroller state so it doesn't re-render over the message
  if (globalVirtualScroller) {
    globalVirtualScroller.data = [];
    globalVirtualScroller.renderedRange = { start: -1, end: -1 };
  }
  const container = document.getElementById('results');
  container.style.paddingTop = '0px';
  container.style.paddingBottom = '0px';
  container.innerHTML = `<div class="no-results">${escapeHtml(msg)}</div>`;
}

function listDisplayName(list) {
  return list.name;
}

function updateMainTitle(text) {
  const titleEl = document.getElementById('mainTitle');
  const inputEl = document.getElementById('mainTitleInput');
  const confirmBtn = document.getElementById('confirmTitleBtn');
  // Exit any edit mode and show normal title
  titleEl.textContent = text;
  titleEl.style.display = '';
  titleEl.ondblclick = null;
  titleEl.onclick = null;
  inputEl.style.display = 'none';
  confirmBtn.style.display = 'none';
}

function updatePinCount(listId, count) {
  const item = document.querySelector(
    `.sidebar-item[data-list-id="${listId}"]`,
  );
  if (!item) return;
  const el = item.querySelector('.pin-count');
  if (el) el.textContent = count > 0 ? count : '';
}

function enterTitleEditMode(prefill, onConfirm, onCancel) {
  const titleEl = document.getElementById('mainTitle');
  const inputEl = document.getElementById('mainTitleInput');
  const confirmBtn = document.getElementById('confirmTitleBtn');

  titleEl.style.display = 'none';
  inputEl.value = prefill;
  inputEl.style.display = '';
  confirmBtn.style.display = 'flex';
  inputEl.focus();
  inputEl.select();

  let settled = false;

  function confirm() {
    if (settled) return;
    settled = true;
    cleanup();
    onConfirm(inputEl.value.trim() || prefill);
  }

  function cancel() {
    if (settled) return;
    settled = true;
    cleanup();
    if (onCancel) onCancel();
  }

  function cleanup() {
    confirmBtn.removeEventListener('click', confirm);
    inputEl.removeEventListener('keydown', onKey);
    inputEl.removeEventListener('blur', onBlur);
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  function onBlur() {
    setTimeout(() => {
      if (!settled && document.activeElement !== confirmBtn) {
        confirm();
      }
    }, 100);
  }

  confirmBtn.addEventListener('click', confirm);
  inputEl.addEventListener('keydown', onKey);
  inputEl.addEventListener('blur', onBlur);
}

function updateSidebarActive() {
  document
    .querySelectorAll('.sidebar-item')
    .forEach((item) => item.classList.remove('active'));
  document.getElementById('exploreBtn').classList.remove('active');
  document.getElementById('recycleBinBtn').classList.remove('active');

  if (activeView.type === 'category') {
    const el = document.querySelector(
      `.sidebar-item[data-category="${activeView.value}"]`,
    );
    if (el) el.classList.add('active');
  } else if (activeView.type === 'list') {
    const el = document.querySelector(
      `.sidebar-item[data-list-id="${activeView.id}"]`,
    );
    if (el) el.classList.add('active');
  } else if (activeView.type === 'explore') {
    document.getElementById('exploreBtn').classList.add('active');
  } else if (activeView.type === 'recycle-bin') {
    document.getElementById('recycleBinBtn').classList.add('active');
  }
}

// --- Lists (pinned searches) ---
async function loadListTree() {
  const order = await readDesktopValue('manifest:list-order');
  return buildTreeFromManifest(order?.tree || []);
}
async function buildTreeFromManifest(treeNodes) {
  const nodes = [];
  for (const treeNode of treeNodes) {
    const key = treeNode.id;
    const entity = await readDesktopValue(key);
    if (!entity || entity.deleted) continue;
    const slug = entity.slug || entitySlug(key);
    const children = treeNode.children?.length
      ? await buildTreeFromManifest(treeNode.children)
      : [];
    const node = { slug, name: entity.name || slug, children };
    nodes.push(node);
  }
  return nodes;
}
// Flatten the list tree for filter and lookup code that needs a linear view.
async function loadLists() {
  const tree = await loadListTree();
  const flat = [];
  function walk(nodes) {
    for (const n of nodes) {
      flat.push({ slug: n.slug, name: n.name });
      walk(n.children);
    }
  }
  walk(tree);
  return flat;
}

// saveLists removed — use saveListMeta/deleteList messages instead

// Fold state: slug → boolean (true = expanded). Persisted in session storage.
let listFoldState = {};

async function loadFoldState() {
  try {
    const { listFoldState: saved } = await chrome.storage.session.get([
      'listFoldState',
    ]);
    if (saved) listFoldState = saved;
  } catch (e) {
    /* ignore */
  }
}

function saveFoldState() {
  chrome.storage.session.set({ listFoldState }).catch(() => {});
}

async function renderLists() {
  const tree = await loadListTree();
  listNameById.clear();
  (function walkTree(nodes) {
    for (const n of nodes) {
      listNameById.set(n.slug, n.name);
      if (n.children?.length) walkTree(n.children);
    }
  })(tree);
  const listEl = document.getElementById('listsList');
  const empty = document.getElementById('listsEmpty');

  // Remove existing list items and children containers (keep the empty placeholder)
  listEl
    .querySelectorAll('.sidebar-item, .sidebar-children')
    .forEach((el) => el.remove());

  if (tree.length === 0) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  renderTreeLevel(listEl, tree, 0);
  updateSidebarActive();
}

function renderTreeLevel(container, nodes, depth) {
  for (const node of nodes) {
    const item = createSidebarItem(node, depth);
    container.appendChild(item);

    if (node.children.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'sidebar-children';
      childContainer.dataset.parentSlug = node.slug;
      const expanded = listFoldState[node.slug] !== false; // default expanded
      childContainer.style.display = expanded ? '' : 'none';
      renderTreeLevel(childContainer, node.children, depth + 1);
      container.appendChild(childContainer);
    }
  }
}

function createSidebarItemDOM(node, depth) {
  const item = document.createElement('div');
  item.className = 'sidebar-item';
  item.setAttribute('role', 'button');
  item.tabIndex = 0;
  item.dataset.listId = node.slug;
  const inset =
    parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--sidebar-item-inset',
      ),
    ) || 10;
  item.style.paddingLeft = inset + depth * 16 + 'px';

  const hasChildren = node.children.length > 0;
  const expanded = listFoldState[node.slug] !== false;

  const chevronSvg =
    '<svg viewBox="0 0 8 8"><path d="M2 1l4 3-4 3z" fill="currentColor"/></svg>';
  item.innerHTML = `
    ${
      hasChildren
        ? `<button class="fold-toggle${expanded ? ' expanded' : ''}" title="${expanded ? 'Collapse' : 'Expand'}">${chevronSvg}</button>`
        : '<span class="fold-spacer"></span>'
    }
    <span class="label">${escapeHtml(listDisplayName(node))}</span>
    <span class="pin-count"></span>
    <button class="remove-list" title="Remove list">&times;</button>
  `;

  if (hasChildren) {
    item.querySelector('.fold-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const newExpanded = listFoldState[node.slug] === false;
      listFoldState[node.slug] = newExpanded;
      saveFoldState();
      const childContainer = item.nextElementSibling;
      if (childContainer?.classList.contains('sidebar-children')) {
        childContainer.style.display = newExpanded ? '' : 'none';
      }
      const btn = item.querySelector('.fold-toggle');
      btn.classList.toggle('expanded', newExpanded);
      btn.title = newExpanded ? 'Collapse' : 'Expand';
    });
  }

  item.addEventListener('click', (e) => {
    if (e.target.closest('.remove-list') || e.target.closest('.fold-toggle'))
      return;
    showList(node);
  });

  item.querySelector('.remove-list').addEventListener('click', async (e) => {
    e.stopPropagation();
    await sendAction({
      action: 'deleteList',
      listId: node.slug,
    });
    delete allListPins[node.slug];
    await renderLists();
    await updateRecycleBinBadge();
    if (activeView.type === 'recycle-bin') await showRecycleBin();
    if (activeView.type === 'list' && activeView.id === node.slug) {
      showExplore();
    }
  });

  return item;
}

async function handleSidebarDrop(draggedId, targetSlug, relY, tree) {
  // Remove dragged node from tree (keeping its subtree)
  let draggedNode = null;
  function extractNode(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === listKey(draggedId)) {
        draggedNode = nodes.splice(i, 1)[0];
        return true;
      }
      if (nodes[i].children && extractNode(nodes[i].children)) return true;
    }
    return false;
  }
  extractNode(tree);
  if (!draggedNode) draggedNode = { id: listKey(draggedId) };

  if (relY >= 0.25 && relY <= 0.75) {
    // Nest as child of target
    function appendToTarget(nodes) {
      for (const n of nodes) {
        if (n.id === listKey(targetSlug)) {
          if (!n.children) n.children = [];
          n.children.push(draggedNode);
          return true;
        }
        if (n.children && appendToTarget(n.children)) return true;
      }
      return false;
    }
    if (!appendToTarget(tree)) tree.push(draggedNode);
  } else {
    // Reorder above/below sibling
    function insertNear(nodes) {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === listKey(targetSlug)) {
          const idx = relY < 0.25 ? i : i + 1;
          nodes.splice(idx, 0, draggedNode);
          return true;
        }
        if (nodes[i].children && insertNear(nodes[i].children)) return true;
      }
      return false;
    }
    if (!insertNear(tree)) tree.push(draggedNode);
  }

  await sendAction({ action: 'updateListTree', tree });
  await renderLists();
}

function stopSidebarDragAutoScroll() {
  sidebarDragScrollVelocity = 0;
  if (sidebarDragScrollFrame) {
    cancelAnimationFrame(sidebarDragScrollFrame);
    sidebarDragScrollFrame = 0;
  }
}

function updateSidebarDragAutoScroll(clientY) {
  const sidebar = document.querySelector('.sidebar-content');
  if (!sidebar) return;
  const rect = sidebar.getBoundingClientRect();
  const edge = Math.min(72, rect.height / 3);
  let velocity = 0;
  if (clientY < rect.top + edge) {
    velocity = -Math.ceil(((rect.top + edge - clientY) / edge) * 18);
  } else if (clientY > rect.bottom - edge) {
    velocity = Math.ceil(((clientY - (rect.bottom - edge)) / edge) * 18);
  }
  sidebarDragScrollVelocity = velocity;
  if (!velocity) return;
  if (sidebarDragScrollFrame) return;
  const tick = () => {
    if (!sidebarDragScrollVelocity) {
      sidebarDragScrollFrame = 0;
      return;
    }
    sidebar.scrollTop += sidebarDragScrollVelocity;
    sidebarDragScrollFrame = requestAnimationFrame(tick);
  };
  sidebarDragScrollFrame = requestAnimationFrame(tick);
}

function bindSidebarDragAutoScroll() {
  const sidebar = document.querySelector('.sidebar-content');
  if (!sidebar || sidebar._dragAutoScrollBound) return;
  sidebar._dragAutoScrollBound = true;
  sidebar.addEventListener('dragover', (e) => {
    updateSidebarDragAutoScroll(e.clientY);
  });
  sidebar.addEventListener('dragleave', (e) => {
    if (!sidebar.contains(e.relatedTarget)) stopSidebarDragAutoScroll();
  });
  sidebar.addEventListener('drop', () => stopSidebarDragAutoScroll());
  sidebar.addEventListener('dragend', () => stopSidebarDragAutoScroll());
}

function bindSidebarItemDragDrop(item, node) {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    draggedSidebarListId = node.slug;
    e.dataTransfer.setData('application/x-list-reorder', node.slug);
    e.dataTransfer.setData('text/plain', node.slug);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    draggedSidebarListId = null;
    stopSidebarDragAutoScroll();
    item.classList.remove('dragging');
    document
      .querySelectorAll('.reorder-above, .reorder-below, .nest-target')
      .forEach((el) => {
        el.classList.remove('reorder-above', 'reorder-below', 'nest-target');
      });
  });

  let dragCounter = 0;
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (
      draggedSidebarListId ||
      e.dataTransfer.types.includes('application/x-list-reorder')
    ) {
      const draggedId =
        draggedSidebarListId ||
        e.dataTransfer.getData('application/x-list-reorder') ||
        e.dataTransfer.getData('text/plain');
      if (draggedId === node.slug) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.dataTransfer.dropEffect = 'move';
      const rect = item.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      item.classList.remove('reorder-above', 'reorder-below', 'nest-target');
      if (relY < 0.25) {
        item.classList.add('reorder-above');
      } else if (relY > 0.75) {
        item.classList.add('reorder-below');
      } else {
        item.classList.add('nest-target');
      }
    } else {
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  item.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (
      !draggedSidebarListId &&
      !e.dataTransfer.types.includes('application/x-list-reorder')
    ) {
      dragCounter++;
      item.classList.add('drag-over');
    }
  });
  item.addEventListener('dragleave', (e) => {
    if (
      draggedSidebarListId ||
      e.dataTransfer.types.includes('application/x-list-reorder')
    ) {
      item.classList.remove('reorder-above', 'reorder-below', 'nest-target');
    } else {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        item.classList.remove('drag-over');
      }
    }
  });
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    item.classList.remove(
      'drag-over',
      'reorder-above',
      'reorder-below',
      'nest-target',
    );

    if (
      draggedSidebarListId ||
      e.dataTransfer.types.includes('application/x-list-reorder')
    ) {
      const draggedId =
        draggedSidebarListId ||
        e.dataTransfer.getData('application/x-list-reorder') ||
        e.dataTransfer.getData('text/plain');
      if (draggedId === node.slug) return;

      const rect = item.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;

      const order = await readDesktopValue('manifest:list-order');
      const tree = JSON.parse(JSON.stringify(order?.tree || []));
      await handleSidebarDrop(draggedId, node.slug, relY, tree);
    } else {
      // Pin drop
      dragCounter = 0;
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        const items = data.items || [{ url: data.url, title: data.title }];
        if (!allListPins[node.slug]) allListPins[node.slug] = [];
        const pins = allListPins[node.slug];
        const newUrls = [];
        const titles = [];
        for (const { url, title } of items) {
          const pinId = pageKey(generateSlugFromUrl(url));
          if (url && !pins.some((p) => p.id === pinId)) {
            pins.push({ id: pinId, pinnedAt: Date.now() });
            newUrls.push(url);
            titles.push(title || null);
          }
        }
        if (newUrls.length > 0) {
          const msg = {
            action: 'addListPins',
            listId: node.slug,
            urls: newUrls,
          };
          if (titles.some(Boolean)) msg.titles = titles;
          await sendAction(msg);
          if (activeView.type === 'list' && activeView.id === node.slug) {
            showList(node);
          }
        }
      } catch (err) {
        logError('Drop error:', err);
      }
    }
  });
}

function createSidebarItem(node, depth) {
  const item = createSidebarItemDOM(node, depth);
  bindSidebarItemDragDrop(item, node);
  return item;
}

// --- Utility ---
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// --- Event listeners: Sidebar categories ---
document.querySelectorAll('.sidebar-item[data-category]').forEach((item) => {
  item.addEventListener('click', () => {
    showCategory(item.dataset.category);
  });
});

// --- Event listeners: Explore button ---
document.getElementById('exploreBtn').addEventListener('click', () => {
  showExplore();
});

bindSidebarDragAutoScroll();

// --- Event listeners: Create List button ---
document.getElementById('createListBtn').addEventListener('click', () => {
  // Remove any existing inline input
  const existing = document.querySelector('.inline-list-create');
  if (existing) {
    existing.remove();
    return;
  }
  const listEl = document.getElementById('listsList');
  const input = document.createElement('input');
  input.className = 'inline-list-create';
  input.placeholder = 'List name...';
  listEl.prepend(input);
  input.focus();

  async function commitCreate() {
    const name = input.value.trim();
    input.remove();
    if (!name) return;
    // Desktop replay owns list placement.
    await sendAction({ action: 'saveListMeta', name });
    await renderLists();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitCreate();
    else if (e.key === 'Escape') input.remove();
  });
  input.addEventListener('blur', () => {
    // Small delay to allow Enter keydown to fire before blur removes input
    setTimeout(() => {
      if (document.querySelector('.inline-list-create')) input.remove();
    }, 150);
  });
});

// --- Event listeners: Recycle Bin button ---
document.getElementById('recycleBinBtn').addEventListener('click', () => {
  showRecycleBin();
});

// --- Marquee drag-select from results background ---
function initMarqueeForElements(wrapper, container) {
  let band = null;
  let startX = 0;
  let startY = 0;
  let didDrag = false;

  function ensureBand() {
    band = wrapper.querySelector('.select-band');
    if (!band) {
      band = document.createElement('div');
      band.className = 'select-band';
      wrapper.appendChild(band);
    }
    return band;
  }

  wrapper.addEventListener('mousedown', (e) => {
    // Only start marquee from the background, not from interactive content
    if (e.target.closest('.result-item, .column-header-row')) return;

    e.preventDefault();
    const wrapperRect = wrapper.getBoundingClientRect();
    startX = e.clientX - wrapperRect.left;
    startY = e.clientY - wrapperRect.top;
    didDrag = false;
    marqueeActive = true;

    const b = ensureBand();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (!additive) {
      container
        .querySelectorAll('.result-row.selected')
        .forEach((r) => r.classList.remove('selected'));
    }

    const onMouseMove = (ev) => {
      const currentWrapperRect = wrapper.getBoundingClientRect();
      const currentX = ev.clientX - currentWrapperRect.left;
      const currentY = ev.clientY - currentWrapperRect.top;
      const minX = Math.min(startX, currentX);
      const maxX = Math.max(startX, currentX);
      const minY = Math.min(startY, currentY);
      const maxY = Math.max(startY, currentY);

      if (Math.abs(currentY - startY) > 3 || Math.abs(currentX - startX) > 3)
        didDrag = true;

      b.style.display = 'block';
      b.style.left = minX + 'px';
      b.style.top = minY + 'px';
      b.style.width = maxX - minX + 'px';
      b.style.height = maxY - minY + 'px';

      container.querySelectorAll('.result-row').forEach((row) => {
        const rowRect = row.getBoundingClientRect();
        const rowTop = rowRect.top - currentWrapperRect.top;
        const rowBottom = rowTop + rowRect.height;

        if (rowBottom > minY && rowTop < maxY) {
          row.classList.add('selected');
        } else if (!additive) {
          row.classList.remove('selected');
        }
      });
    };

    const onMouseUp = () => {
      b.style.display = 'none';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      syncChartHighlights();

      setTimeout(() => {
        marqueeActive = false;
      }, 0);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Init marquee for global results
initMarqueeForElements(
  document.getElementById('resultsWrapper'),
  document.getElementById('results'),
);
// Init marquee for list results
initMarqueeForElements(
  document.getElementById('relatedResultsWrapper'),
  document.getElementById('relatedResults'),
);

// --- Settings modal ---
document.getElementById('settingsBtn').addEventListener('click', async () => {
  await openSettingsModal();
});

document.getElementById('settingsClose').addEventListener('click', () => {
  closeSettingsModal();
});

document.getElementById('settingsModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    closeSettingsModal();
  }
});

async function openSettingsModal() {
  document.getElementById('settingsModal').classList.add('open');
  updateStorageStatus();
  updateStatistics();
  renderBlacklist();
  renderTrimRules();
  await refreshDesktopShellSettings();
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.remove('open');
  saveSyncSettings();
}

async function refreshDesktopShellSettings() {
  try {
    const shell = await sendAction({ action: 'getDesktopShellState' });
    const loginToggle = document.getElementById('launchAtLoginToggle');
    const loginOption = document.getElementById('launchAtLoginOption');
    const loginUnsupported = document.getElementById(
      'launchAtLoginUnsupported',
    );
    const loginItemSupported = !!shell.loginItemSupported;
    loginToggle.checked = !!shell.launchAtLogin;
    loginToggle.disabled = !loginItemSupported;
    loginOption.classList.toggle('disabled', !loginItemSupported);
    loginUnsupported.style.display = loginItemSupported ? 'none' : 'block';
    document.getElementById('debugLoggingToggle').checked =
      !!shell.debugLogging;
    await chrome.storage.session.set({ debugLogging: !!shell.debugLogging });
    renderPairedBrowsers(shell.pairedBrowsers || []);
  } catch (error) {
    logDebug('[desktop-shell] failed to load shell settings:', error.message);
  }
}

function renderPairedBrowsers(browsers) {
  const list = document.getElementById('pairedBrowsersList');
  const activeToday = (browsers || []).filter(isBrowserActiveToday);
  if (activeToday.length === 0) {
    list.innerHTML =
      '<div style="color: var(--text-muted)">No browsers active today.</div>';
    return;
  }
  list.innerHTML = activeToday
    .map((browser) => {
      const lastSeen = browser.lastSeen
        ? new Date(browser.lastSeen).toLocaleString()
        : 'Unknown';
      const profile = browser.browserProfile || 'Default profile';
      const browserName = formatBrowserName(browser.browserName);
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="min-width:0;">
            <div style="font-weight:600;color:var(--text-primary);">
              ${escapeHtml(browserName)}
              ${browser.connected ? '<span style="color: var(--accent-primary); font-weight: 500;">· connected</span>' : ''}
            </div>
            <div style="color:var(--text-muted);font-size:11px;">
              ${escapeHtml(profile)} · ${escapeHtml(browser.browserId)} · last seen ${escapeHtml(lastSeen)}
            </div>
          </div>
          <button
            class="section-action paired-browser-revoke"
            data-browser-id="${escapeHtml(browser.browserId)}"
            data-extension-id="${escapeHtml(browser.extensionId)}"
            style="padding:3px 8px;flex-shrink:0;"
          >
            Revoke
          </button>
        </div>
      `;
    })
    .join('');

  list.querySelectorAll('.paired-browser-revoke').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await sendAction({
          action: 'revokePairedBrowser',
          browserId: button.dataset.browserId,
          extensionId: button.dataset.extensionId,
        });
        await refreshDesktopShellSettings();
      } catch (error) {
        showStatus(`Failed to revoke browser: ${error.message}`, 'error');
        button.disabled = false;
      }
    });
  });
}

function isBrowserActiveToday(browser) {
  if (browser.connected) return true;
  if (!browser.lastSeen) return false;
  const seen = new Date(browser.lastSeen);
  const now = new Date();
  return (
    seen.getFullYear() === now.getFullYear() &&
    seen.getMonth() === now.getMonth() &&
    seen.getDate() === now.getDate()
  );
}

function formatBrowserName(name) {
  const value = String(name || '').trim();
  if (!value) return 'Browser';
  const normalized = value.toLowerCase();
  if (normalized === 'edg' || normalized === 'edge') return 'Microsoft Edge';
  if (normalized === 'chrome') return 'Google Chrome';
  return value;
}

// --- Settings: Storage ---
async function updateStorageStatus() {
  let info = null;
  let connector = null;
  try {
    const [dirResp, connectorResp] = await Promise.all([
      sendAction({ action: 'getDirectoryInfo' }).catch(() => ({ info: null })),
      sendAction({ action: 'getDesktopConnectorState' }).catch(() => null),
    ]);
    info = dirResp?.info || null;
    connector = connectorResp;
  } catch {}

  const row = document.getElementById('storageLocation');
  const pathEl = document.getElementById('storagePath');
  const deviceNameEl = document.getElementById('storageDeviceName');
  const selectBtn = document.getElementById('selectDirBtn');
  const paired = Boolean(connector?.deviceId || (info && info.hasPermission));

  if (paired) {
    row.classList.remove('not-configured');
    pathEl.textContent =
      connector?.dataFolder || info?.path || info?.name || 'Data folder ready';
    if (deviceNameEl) {
      deviceNameEl.textContent = connector?.deviceId
        ? `Device ${connector.deviceId}`
        : 'Device identity unavailable';
    }
    if (selectBtn) {
      selectBtn.style.display =
        connector?.state === 'connected' ? 'none' : 'inline-block';
      selectBtn.textContent =
        connector?.state === 'pair_pending'
          ? 'Waiting for approval...'
          : 'Pair from Browser Popup';
      selectBtn.disabled =
        desktopPairInFlight || connector?.state === 'pair_pending';
    }
  } else {
    row.classList.add('not-configured');
    pathEl.textContent = 'Device not configured';
    if (deviceNameEl) {
      deviceNameEl.textContent = '';
    }
    if (selectBtn) {
      selectBtn.style.display = 'inline-block';
      selectBtn.textContent =
        connector?.state === 'pair_pending'
          ? 'Waiting for approval...'
          : 'Pair from Browser Popup';
      selectBtn.disabled =
        desktopPairInFlight || connector?.state === 'pair_pending';
    }
  }
}

async function updateStatistics() {
  const result = await chrome.storage.local.get(['desktopCommandBuffer']);
  document.getElementById('bufferSize').textContent = (
    result.desktopCommandBuffer || []
  ).length;

  updateCacheSize();
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Desktop owns entity reads; only the connector queue remains in extension storage.
const SESSION_CACHE_KEYS = [];
const LOCAL_CACHE_KEYS = [
  { key: 'desktopCommandBuffer', label: 'Connector Write Queue' },
];
const CACHE_KEYS = [...SESSION_CACHE_KEYS, ...LOCAL_CACHE_KEYS];

async function updateCacheSize() {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(SESSION_CACHE_KEYS.map((c) => c.key)),
    chrome.storage.local.get(LOCAL_CACHE_KEYS.map((c) => c.key)),
  ]);
  const data = { ...sessionData, ...localData };

  let totalBytes = 0;
  for (const { key } of CACHE_KEYS) {
    const val = data[key];
    if (val !== undefined) totalBytes += new Blob([JSON.stringify(val)]).size;
  }

  document.getElementById('cacheSize').textContent = formatBytes(totalBytes);
}

document
  .getElementById('flushBufferBtn')
  .addEventListener('click', async () => {
    const btn = document.getElementById('flushBufferBtn');
    btn.disabled = true;
    btn.textContent = 'Flushing...';

    try {
      const resp = await sendAction({
        action: 'flushDesktopQueue',
      });
      btn.textContent =
        resp.remaining > 0 ? `${resp.remaining} remaining` : 'Flushed!';
      await updateStatistics();
    } catch (e) {
      btn.textContent = 'Error: ' + e.message;
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Flush to Disk';
    }, 2000);
  });

document.getElementById('clearCacheBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearCacheBtn');
  btn.disabled = true;
  btn.textContent = 'Reloading...';

  try {
    const sessionKeysToRemove = SESSION_CACHE_KEYS.map((c) => c.key);
    await chrome.storage.session.remove(sessionKeysToRemove);

    await sendAction({ action: 'flushDesktopQueue' });

    // Reload the page to reflect new data
    location.reload();
    return;
  } catch (error) {
    showStatus('Cache clear failed: ' + error.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Clear Cache & Reload';
  updateCacheSize();
});

document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    const result = await refreshDesktopConnectorState();
    if (result?.state === 'connected') {
      await updateStorageStatus();
      showStatus(
        'Chrome is already paired with Browser Recall Desktop',
        'success',
      );
      resetHistory();
      showCategory(activeView.type === 'category' ? activeView.value : 'all');
    } else if (result?.state === 'pair_pending') {
      showStatus(
        'Approve the pairing request in Browser Recall Desktop',
        'success',
      );
    } else {
      showStatus(
        'Open the Browser Recall popup in Chrome and click Pair with desktop.',
        'success',
      );
    }
  } catch (error) {
    showStatus(`Desktop bridge check failed: ${error.message}`, 'error');
  }
});

document.getElementById('themeSelect').addEventListener('change', async () => {
  const theme = document.getElementById('themeSelect').value;
  await chrome.storage.session.set({ theme });
  await saveSettingsValue('theme', theme);
  await applyTheme();
});

// Color scheme picker
function applyColorScheme(scheme) {
  if (scheme && scheme !== 'amber') {
    document.documentElement.setAttribute('data-color-scheme', scheme);
  } else {
    document.documentElement.removeAttribute('data-color-scheme');
  }
  document.querySelectorAll('.color-dot').forEach((d) => {
    d.classList.toggle('active', d.dataset.scheme === scheme);
  });
}

document
  .getElementById('colorSchemePicker')
  .addEventListener('click', async (e) => {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    const scheme = dot.dataset.scheme;
    applyColorScheme(scheme);
    await chrome.storage.session.set({ colorScheme: scheme });
    await saveSettingsValue('colorScheme', scheme);
  });

document
  .getElementById('historyFileBatch')
  .addEventListener('change', async () => {
    const val =
      parseInt(document.getElementById('historyFileBatch').value) || 10;
    historyState.fileBatch = Math.max(1, val);
    document.getElementById('historyFileBatch').value = historyState.fileBatch;
    await saveSettingsValue('historyFileBatch', historyState.fileBatch);
    showStatus('Settings saved', 'success');
  });

document
  .getElementById('captureSnapshotVideo')
  .addEventListener('change', async () => {
    await saveSettingsValue(
      'captureSnapshotVideo',
      document.getElementById('captureSnapshotVideo').checked,
    );
    showStatus('Settings saved', 'success');
  });

async function saveDesktopShellSettings() {
  const loginToggle = document.getElementById('launchAtLoginToggle');
  await sendAction({
    action: 'updateDesktopShellSettings',
    launchAtLogin: !loginToggle.disabled && loginToggle.checked,
    debugLogging: document.getElementById('debugLoggingToggle').checked,
  });
}

for (const id of ['launchAtLoginToggle', 'debugLoggingToggle']) {
  document.getElementById(id).addEventListener('change', async () => {
    try {
      await saveDesktopShellSettings();
    } catch (error) {
      showStatus(`Desktop setting failed: ${error.message}`, 'error');
      await refreshDesktopShellSettings();
    }
  });
}

// Addon toggle helpers
function setAddonOpen(bodyEl, open) {
  if (open) bodyEl.classList.add('open');
  else bodyEl.classList.remove('open');
}

// Sync settings
document.getElementById('syncEnabled').addEventListener('change', () => {
  setAddonOpen(
    document.getElementById('syncConfigFields'),
    document.getElementById('syncEnabled').checked,
  );
});

// Excluded Sites toggle
document
  .getElementById('blacklistEnabled')
  .addEventListener('change', async () => {
    const enabled = document.getElementById('blacklistEnabled').checked;
    setAddonOpen(document.getElementById('blacklistBody'), enabled);
    await saveSettingsValue('blacklistEnabled', enabled);
  });

// Title Cleanup toggle
document
  .getElementById('titleCleanupEnabled')
  .addEventListener('change', async () => {
    const enabled = document.getElementById('titleCleanupEnabled').checked;
    setAddonOpen(document.getElementById('titleCleanupBody'), enabled);
    await saveSettingsValue('titleCleanupEnabled', enabled);
  });

// Save current sync settings from form fields. Returns false if validation fails.
async function saveSyncSettings() {
  const enabled = document.getElementById('syncEnabled').checked;
  const retention =
    parseInt(document.getElementById('syncRetentionDays').value) || 7;

  if (enabled) {
    const repoUrl = document.getElementById('syncRepoUrl').value.trim();
    if (!repoUrl) {
      showStatus('Repository address is required', 'error');
      return false;
    }
    const authState = await sendAction({ action: 'getSyncAuthState' });
    if (!authState.hasToken) {
      showStatus(
        'GitHub not connected — click "Connect with GitHub" first',
        'error',
      );
      return false;
    }
    await saveSettingsValue('syncRepoUrl', repoUrl);
  }

  await saveSettingsValue('syncEnabled', enabled);
  await saveSettingsValue('syncMethod', 'github');
  await saveSettingsValue('syncRetentionDays', Math.max(1, retention));
  await sendAction({ action: 'updateSyncSettings' });
  return true;
}

document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  const cancelBtn = document.getElementById('syncCancelBtn');
  const statusEl = document.getElementById('syncStatus');
  btn.disabled = true;
  btn.textContent = 'Syncing\u2026';
  cancelBtn.style.display = '';
  statusEl.textContent = '';
  try {
    if (!(await saveSyncSettings())) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = 'Fix settings before syncing';
      return;
    }
    // Phase 1: list devices immediately so the section appears
    try {
      const devResp = await sendAction({ action: 'syncListDevices' });
      if (devResp.devices?.length)
        renderSyncDevices(devResp.devices, devResp.localDeviceId, true);
    } catch {
      /* best-effort */
    }

    // Phase 2: actual push + pull
    const result = await sendAction({ action: 'syncNow' });
    if (result.skipped) {
      statusEl.style.color = '';
      statusEl.textContent = result.error || 'Sync skipped';
    } else if (result.error) {
      statusEl.style.color = '#c62828';
      if (result.authExpired) {
        statusEl.textContent =
          'GitHub authorization expired — please reconnect.';
        syncShowAuthState('disconnected');
      } else if (result.disabled) {
        statusEl.textContent = `Sync disabled: ${result.error}`;
      } else {
        statusEl.textContent = `Error (will retry): ${result.error}`;
      }
    } else {
      statusEl.style.color = '';
      statusEl.textContent = '';
    }
    // Phase 3: refresh with final push/pull timestamps
    refreshSyncDevices();
  } catch (e) {
    statusEl.style.color = '#c62828';
    statusEl.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Now';
    cancelBtn.style.display = 'none';
  }
});

document.getElementById('syncCancelBtn').addEventListener('click', async () => {
  const cancelBtn = document.getElementById('syncCancelBtn');
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling\u2026';
  try {
    await sendAction({ action: 'cancelSync' });
  } catch {
    /* best-effort */
  }
});

// ─── Synced Devices List ─────────────────────────────────────────────

function formatTimeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function renderSyncDevices(devices, localDeviceId, syncing) {
  const section = document.getElementById('syncDevicesSection');
  const list = document.getElementById('syncDevicesList');
  if (!devices || devices.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  list.innerHTML = '';
  for (const d of devices) {
    const isLocal = d.deviceId === localDeviceId;
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;';

    const id = document.createElement('span');
    id.style.cssText = 'font-family:monospace;';
    id.textContent = d.deviceId;
    row.appendChild(id);

    if (isLocal) {
      const tag = document.createElement('span');
      tag.textContent = '(current)';
      tag.style.color = 'var(--text-muted)';
      row.appendChild(tag);
    }

    const status = document.createElement('span');
    status.style.cssText =
      'color:var(--text-muted);margin-left:auto;margin-right:6px;white-space:nowrap;';
    if (d.paused) {
      status.textContent = 'paused';
    } else if (syncing) {
      status.textContent = isLocal ? 'pushing\u2026' : 'pulling\u2026';
    } else if (isLocal) {
      status.textContent = d.lastPushed
        ? `pushed ${formatTimeAgo(d.lastPushed)}`
        : '';
    } else {
      status.textContent = d.lastPulled
        ? `pulled ${formatTimeAgo(d.lastPulled)}`
        : '';
    }
    row.appendChild(status);

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = d.paused ? '\u25b6' : '\u23f8';
    toggleBtn.title = d.paused ? 'Resume sync' : 'Pause sync';
    toggleBtn.style.cssText =
      'background:none;border:none;cursor:pointer;font-size:12px;color:var(--text-muted);padding:0 2px;line-height:1;';
    toggleBtn.addEventListener('click', async () => {
      toggleBtn.disabled = true;
      try {
        const resp = await sendAction({
          action: 'toggleSyncDevicePaused',
          deviceId: d.deviceId,
        });
        d.paused = resp.paused;
        toggleBtn.textContent = d.paused ? '\u25b6' : '\u23f8';
        toggleBtn.title = d.paused ? 'Resume sync' : 'Pause sync';
        status.textContent = d.paused ? 'paused' : '';
      } catch (e) {
        showStatus(`Toggle failed: ${e.message}`, 'error');
      } finally {
        toggleBtn.disabled = false;
      }
    });
    row.appendChild(toggleBtn);

    list.appendChild(row);
  }
}

async function refreshSyncDevices() {
  try {
    const resp = await sendAction({ action: 'getSyncDevices' });
    renderSyncDevices(resp.devices, resp.localDeviceId, false);
  } catch {
    document.getElementById('syncDevicesSection').style.display = 'none';
  }
}

// ─── GitHub Auth UI ──────────────────────────────────────────────────

function syncShowAuthState(state, detail) {
  document.getElementById('syncAuthDisconnected').style.display =
    state === 'disconnected' ? '' : 'none';
  document.getElementById('syncAuthConnected').style.display =
    state === 'connected' ? '' : 'none';
  if (state === 'connected' && detail) {
    document.getElementById('syncAuthDetail').textContent = detail;
  }
}

document
  .getElementById('syncPatSaveBtn')
  .addEventListener('click', async () => {
    const btn = document.getElementById('syncPatSaveBtn');
    const token = document.getElementById('syncPatInput').value.trim();
    if (!token) {
      showStatus('Token is required', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Connecting\u2026';
    try {
      const remember = document.getElementById('syncRememberToken').checked;
      const response = await sendAction({
        action: 'setSyncToken',
        token,
        remember,
        authMethod: 'pat',
      });
      const login = response.githubUser;
      syncShowAuthState('connected', `as @${login}`);
      document.getElementById('syncPatInput').value = '';
    } catch (e) {
      showStatus(`Invalid token: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });

document
  .getElementById('syncDisconnectBtn')
  .addEventListener('click', async () => {
    await sendAction({ action: 'clearSyncToken' });
    syncShowAuthState('disconnected');
    document.getElementById('syncDevicesSection').style.display = 'none';
    document.getElementById('syncDevicesList').innerHTML = '';
    showStatus(
      'Disconnected. <a href="https://github.com/settings/tokens" target="_blank" style="color:#1a73e8;">Manage tokens on GitHub</a>',
      'success',
    );
  });

document
  .getElementById('syncRememberToken')
  .addEventListener('change', async () => {
    const remember = document.getElementById('syncRememberToken').checked;
    await sendAction({ action: 'toggleSyncRemember', remember });
  });

document
  .getElementById('syncCheckDevicesBtn')
  .addEventListener('click', async () => {
    const btn = document.getElementById('syncCheckDevicesBtn');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    await refreshSyncDevices();
    btn.textContent = 'Check Devices';
    btn.disabled = false;
  });

// Clear all data
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (
    !confirm(
      'Warning: this will delete all files in your storage directory.\n\nThis cannot be undone. Are you absolutely sure?',
    )
  ) {
    return;
  }
  if (!confirm('Final confirmation: Delete all history files?')) {
    return;
  }

  const clearBtn = document.getElementById('clearBtn');
  clearBtn.disabled = true;
  clearBtn.textContent = 'Clearing...';

  try {
    const resp = await sendAction({ action: 'clearAllData' });
    showStatus(
      `Cleared ${resp.deletedCount || 0} files/directories`,
      'success',
    );
    await updateStatistics();
    resetHistory();
    showExplore();
  } catch (error) {
    showStatus(`Error clearing data: ${error.message}`, 'error');
  }

  clearBtn.disabled = false;
  clearBtn.textContent = 'Clear All Data';
});

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  setTimeout(() => {
    status.className = 'status';
  }, 5000);
}

// --- Hint tooltips ---
{
  const float = document.getElementById('hintTipFloat');
  document.addEventListener(
    'mouseenter',
    (e) => {
      const hint =
        e.target instanceof Element ? e.target.closest('.hint-icon') : null;
      if (!hint) return;
      const tip = hint.querySelector('.hint-tip');
      if (!tip) return;
      float.textContent = tip.textContent;
      float.style.display = 'block';
      float.style.visibility = 'hidden';
      const r = hint.getBoundingClientRect();
      let left = r.right + 6;
      let top = r.top + r.height / 2 - float.offsetHeight / 2;
      if (left + float.offsetWidth > window.innerWidth - 8) {
        left = r.left - float.offsetWidth - 6;
      }
      top = Math.max(
        4,
        Math.min(top, window.innerHeight - float.offsetHeight - 4),
      );
      float.style.left = left + 'px';
      float.style.top = top + 'px';
      float.style.visibility = 'visible';
    },
    true,
  );
  document.addEventListener(
    'mouseleave',
    (e) => {
      if (e.target instanceof Element && e.target.closest('.hint-icon')) {
        float.style.display = 'none';
      }
    },
    true,
  );
}

// --- Import Bookmarks ---
document.getElementById('bookmarkImportBtn').addEventListener('click', () => {
  document.getElementById('bookmarkImportPanel').style.display = 'block';
});
document
  .getElementById('bookmarkImportCancelBtn')
  .addEventListener('click', () => {
    document.getElementById('bookmarkImportPanel').style.display = 'none';
  });
{
  const fileInput = document.getElementById('bookmarkFileInput');
  const treeContainer = document.getElementById('bookmarkTreeContainer');
  const importBtn = document.getElementById('importBookmarksBtn');
  const progressEl = document.getElementById('importProgress');
  const failuresEl = document.getElementById('importFailures');

  let parsedTree = null;
  let parseBookmarkHtml = null;

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!parseBookmarkHtml) {
      const mod = await import('./bookmark-parser.js');
      parseBookmarkHtml = mod.parseBookmarkHtml;
    }
    const text = await file.text();
    parsedTree = parseBookmarkHtml(text);
    renderBookmarkTree(parsedTree);
    importBtn.disabled = true; // nothing checked yet
    progressEl.textContent = '';
    failuresEl.innerHTML = '';
  });

  function renderBookmarkTree(root) {
    treeContainer.innerHTML = '';
    treeContainer._items = [];
    if (root.bookmarks.length > 0) {
      const rootItem = createTreeItem(
        {
          title: '(Root bookmarks)',
          bookmarks: root.bookmarks,
          skipped: root.skipped || [],
          children: [],
          bookmarkCount: root.bookmarks.length,
          subfolderCount: 0,
        },
        0,
      );
      treeContainer.appendChild(rootItem.el);
      treeContainer._items.push(rootItem);
    }
    for (const folder of root.children) {
      const item = createTreeItem(folder, 0);
      treeContainer.appendChild(item.el);
      treeContainer._items.push(item);
    }
  }

  function createTreeItem(folder, depth) {
    const wrapper = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'bookmark-tree-item';
    row.style.paddingLeft = depth * 16 + 'px';

    // Toggle arrow
    const toggle = document.createElement('button');
    toggle.className =
      'bm-toggle' + (folder.children.length === 0 ? ' leaf' : '');
    row.appendChild(toggle);

    // Checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    row.appendChild(cb);

    // Label
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = folder.title;
    row.appendChild(label);

    // Count
    const count = document.createElement('span');
    count.className = 'bm-count';
    const parts = [];
    if (folder.bookmarkCount > 0)
      parts.push(
        `${folder.bookmarkCount} bookmark${folder.bookmarkCount !== 1 ? 's' : ''}`,
      );
    if (folder.subfolderCount > 0)
      parts.push(
        `${folder.subfolderCount} subfolder${folder.subfolderCount !== 1 ? 's' : ''}`,
      );
    count.textContent = parts.length > 0 ? `(${parts.join(', ')})` : '(empty)';
    row.appendChild(count);

    wrapper.appendChild(row);

    // Children container
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'bookmark-tree-children';
    const childItems = [];
    for (const child of folder.children) {
      const childItem = createTreeItem(child, depth + 1);
      childrenContainer.appendChild(childItem.el);
      childItems.push(childItem);
    }
    wrapper.appendChild(childrenContainer);

    // Toggle expand/collapse
    if (folder.children.length > 0) {
      toggle.classList.add('expanded');
      toggle.addEventListener('click', () => {
        const collapsed = childrenContainer.classList.toggle('collapsed');
        toggle.classList.toggle('expanded', !collapsed);
      });
    }

    // Checkbox: tri-state propagation
    cb.addEventListener('change', () => {
      // Propagate down: check/uncheck all descendants
      setSubtreeChecked(childItems, cb.checked);
      updateImportButton();
    });

    function getChecked() {
      return cb.checked;
    }
    function getIndeterminate() {
      return cb.indeterminate;
    }
    function setChecked(val) {
      cb.checked = val;
      cb.indeterminate = false;
    }
    function setIndeterminate() {
      cb.indeterminate = true;
      cb.checked = false;
    }

    function updateFromChildren() {
      if (childItems.length === 0) return;
      const allChecked = childItems.every(
        (c) => c.getChecked() && !c.getIndeterminate(),
      );
      const noneChecked = childItems.every(
        (c) => !c.getChecked() && !c.getIndeterminate(),
      );
      if (allChecked) setChecked(true);
      else if (noneChecked) setChecked(false);
      else setIndeterminate();
    }

    // Wire children to update parent
    for (const child of childItems) {
      child.onchange = () => {
        updateFromChildren();
        updateImportButton();
      };
    }

    // Notify parent on change
    let onchange = null;
    cb.addEventListener('change', () => {
      if (item.onchange) item.onchange();
    });

    const item = {
      el: wrapper,
      folder,
      getChecked,
      getIndeterminate,
      setChecked,
      children: childItems,
      get onchange() {
        return onchange;
      },
      set onchange(fn) {
        onchange = fn;
      },
    };
    return item;
  }

  function setSubtreeChecked(items, checked) {
    for (const item of items) {
      item.setChecked(checked);
      setSubtreeChecked(item.children, checked);
    }
  }

  function updateImportButton() {
    const items = treeContainer.querySelectorAll(
      '.bookmark-tree-item input[type="checkbox"]',
    );
    const anyChecked = Array.from(items).some((cb) => cb.checked);
    importBtn.disabled = !anyChecked;
  }

  function collectCheckedTree(items) {
    const result = [];
    for (const item of items) {
      if (item.getChecked() && !item.getIndeterminate()) {
        // Fully checked — include this folder with all descendants
        result.push({
          title: item.folder.title,
          bookmarks: item.folder.bookmarks,
          skipped: item.folder.skipped || [],
          children: collectAllChildren(item.children),
        });
      } else if (item.getIndeterminate()) {
        // Partially checked — skip this folder, flatten selected children
        result.push(...collectCheckedTree(item.children));
      }
    }
    return result;
  }

  function collectAllChildren(items) {
    return items.map((item) => ({
      title: item.folder.title,
      bookmarks: item.folder.bookmarks,
      skipped: item.folder.skipped || [],
      children: collectAllChildren(item.children),
    }));
  }

  function renderBookmarkImportFailures(failures) {
    failuresEl.innerHTML = '';
    if (!failures || failures.length === 0) return;

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${failures.length} item${failures.length !== 1 ? 's' : ''} skipped`;
    details.appendChild(summary);
    const list = document.createElement('ul');
    list.style.cssText = 'margin:4px 0;padding-left:20px;';
    for (const failure of failures) {
      const li = document.createElement('li');
      li.textContent = `${failure.title || failure.url} — ${failure.reason}`;
      list.appendChild(li);
    }
    details.appendChild(list);
    failuresEl.appendChild(details);
  }

  importBtn.addEventListener('click', async () => {
    const selected = collectCheckedTree(treeContainer._items || []);
    if (selected.length === 0) return;

    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    progressEl.textContent = 'Importing bookmarks into Browser Recall...';
    failuresEl.innerHTML = '';
    try {
      const result = await sendAction({
        action: 'importBookmarks',
        tree: selected,
      });
      progressEl.textContent = `Done! Imported ${result.listCount} list${result.listCount !== 1 ? 's' : ''} with ${result.bookmarkCount} bookmark${result.bookmarkCount !== 1 ? 's' : ''}.`;
      renderBookmarkImportFailures(result.failures || []);
    } catch (error) {
      progressEl.textContent = `Import failed: ${error.message}`;
    } finally {
      importBtn.textContent = 'Import Selected';
      importBtn.disabled = false;
    }
  });
}

// ─── Import History ──────────────────────────────────────────────────
document.getElementById('historyImportBtn').addEventListener('click', () => {
  document.getElementById('historyImportPanel').style.display = 'block';
});

document
  .getElementById('historyImportCancelBtn')
  .addEventListener('click', () => {
    document.getElementById('historyImportPanel').style.display = 'none';
    document.getElementById('historyImportProgress').textContent = '';
    document.getElementById('historyImportSummary').textContent = '';
    document.getElementById('historyImportFailures').innerHTML = '';
  });

{
  const fileInput = document.getElementById('historyFileInput');
  const importBtn = document.getElementById('importHistoryBtn');
  const summaryEl = document.getElementById('historyImportSummary');
  const progressEl = document.getElementById('historyImportProgress');
  const failuresEl = document.getElementById('historyImportFailures');

  let normalizedEntries = [];
  let parseFailures = [];

  function normalizeHistoryTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim()) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber) && asNumber > 0)
        return Math.trunc(asNumber);
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function collectHistoryImportTimestamps(rawEntry) {
    const timestamps = new Set();
    for (const value of rawEntry.visitTimes || []) {
      const normalized = normalizeHistoryTimestamp(value);
      if (normalized) timestamps.add(normalized);
    }
    for (const visit of rawEntry.visits || []) {
      const normalized = normalizeHistoryTimestamp(
        visit?.visitTime ?? visit?.timestamp ?? visit?.lastVisitTime,
      );
      if (normalized) timestamps.add(normalized);
    }
    for (const key of ['visitTime', 'timestamp', 'lastVisitTime']) {
      const normalized = normalizeHistoryTimestamp(rawEntry[key]);
      if (normalized) timestamps.add(normalized);
    }
    return [...timestamps].sort((left, right) => left - right);
  }

  function renderHistoryImportFailures(failures) {
    failuresEl.innerHTML = '';
    if (!failures || failures.length === 0) return;

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${failures.length} item${failures.length !== 1 ? 's' : ''} skipped`;
    details.appendChild(summary);
    const list = document.createElement('ul');
    list.style.cssText = 'margin:4px 0;padding-left:20px;';
    for (const failure of failures) {
      const li = document.createElement('li');
      li.textContent = `${failure.title || failure.url || 'entry'} — ${failure.reason}`;
      list.appendChild(li);
    }
    details.appendChild(list);
    failuresEl.appendChild(details);
  }

  function normalizeHistoryImportPayload(payload) {
    const rawEntries = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.entries)
        ? payload.entries
        : Array.isArray(payload?.history)
          ? payload.history
          : null;
    if (!rawEntries) {
      throw new Error('Expected a JSON array or an object with `entries`.');
    }

    const failures = [];
    const entries = [];
    for (const rawEntry of rawEntries) {
      const url = String(rawEntry?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        failures.push({
          url,
          title: rawEntry?.title || '',
          reason: url
            ? 'unsupported or invalid web address'
            : 'missing web address',
        });
        continue;
      }
      const visitTimes = collectHistoryImportTimestamps(rawEntry);
      if (visitTimes.length === 0) {
        failures.push({
          url,
          title: rawEntry?.title || '',
          reason: 'missing visit timestamp',
        });
        continue;
      }
      entries.push({
        url,
        title:
          typeof rawEntry?.title === 'string' && rawEntry.title.trim()
            ? rawEntry.title.trim()
            : null,
        referrerUrl:
          typeof rawEntry?.referrerUrl === 'string' &&
          rawEntry.referrerUrl.trim()
            ? rawEntry.referrerUrl.trim()
            : typeof rawEntry?.referrer_url === 'string' &&
                rawEntry.referrer_url.trim()
              ? rawEntry.referrer_url.trim()
              : null,
        visitTimes,
      });
    }
    return { entries, failures };
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    normalizedEntries = [];
    parseFailures = [];
    importBtn.disabled = true;
    summaryEl.textContent = '';
    progressEl.textContent = '';
    failuresEl.innerHTML = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = normalizeHistoryImportPayload(parsed);
      normalizedEntries = normalized.entries;
      parseFailures = normalized.failures;
      const visitCount = normalizedEntries.reduce(
        (sum, entry) => sum + entry.visitTimes.length,
        0,
      );
      summaryEl.textContent =
        normalizedEntries.length > 0
          ? `Ready to import ${visitCount} visit${visitCount !== 1 ? 's' : ''} across ${normalizedEntries.length} page${normalizedEntries.length !== 1 ? 's' : ''}.`
          : 'No importable history entries found in this file.';
      renderHistoryImportFailures(parseFailures);
      importBtn.disabled = normalizedEntries.length === 0;
    } catch (error) {
      summaryEl.textContent = `Could not parse history JSON: ${error.message}`;
      renderHistoryImportFailures([
        { reason: 'invalid JSON or unsupported history export format' },
      ]);
    }
  });

  importBtn.addEventListener('click', async () => {
    if (normalizedEntries.length === 0) return;

    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
    progressEl.textContent = 'Importing browser history into Browser Recall...';
    try {
      const result = await sendAction({
        action: 'importHistory',
        entries: normalizedEntries,
      });
      progressEl.textContent =
        `Done! Imported ${result.visitCount} visit${result.visitCount !== 1 ? 's' : ''}` +
        ` across ${result.pageCount} page${result.pageCount !== 1 ? 's' : ''}.`;
      const skippedCount = (result.skippedCount || 0) + parseFailures.length;
      if (skippedCount > 0) {
        summaryEl.textContent = `${skippedCount} item${skippedCount !== 1 ? 's' : ''} skipped during parsing or import.`;
      }
      renderHistoryImportFailures(parseFailures);
    } catch (error) {
      progressEl.textContent = `Import failed: ${error.message}`;
    } finally {
      importBtn.textContent = 'Import History';
      importBtn.disabled = normalizedEntries.length === 0;
    }
  });
}

// --- URL Blacklist ---
async function loadBlacklist() {
  const list = await loadSettingsValue('urlBlacklist', null);
  return list ?? [...DEFAULT_URL_BLACKLIST];
}

async function saveBlacklist(list) {
  await saveSettingsValue('urlBlacklist', list);
}

function renderSettingsList({
  containerId,
  loadFn,
  saveFn,
  renderItemHtml,
  emptyMessage,
  rerender,
}) {
  return (async () => {
    const items = await loadFn();
    const container = document.getElementById(containerId);

    if (items.length === 0) {
      container.innerHTML = `<div class="blacklist-empty">${escapeHtml(emptyMessage)}</div>`;
      return;
    }

    container.innerHTML = items
      .map(
        (item, idx) =>
          `<div class="blacklist-entry">
        ${renderItemHtml(item)}
        <button class="blacklist-remove" data-index="${idx}" title="Remove">&times;</button>
      </div>`,
      )
      .join('');

    container.querySelectorAll('.blacklist-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const current = await loadFn();
        current.splice(parseInt(btn.dataset.index), 1);
        await saveFn(current);
        rerender();
      });
    });
  })();
}

async function renderBlacklist() {
  return renderSettingsList({
    containerId: 'blacklistEntries',
    loadFn: loadBlacklist,
    saveFn: saveBlacklist,
    renderItemHtml: (prefix) => `<span>${escapeHtml(prefix)}</span>`,
    emptyMessage: 'No blocked web address prefixes',
    rerender: renderBlacklist,
  });
}

document
  .getElementById('blacklistAddBtn')
  .addEventListener('click', async () => {
    const input = document.getElementById('blacklistInput');
    const prefix = input.value.trim();
    if (!prefix) return;

    const list = await loadBlacklist();
    if (list.includes(prefix)) {
      input.value = '';
      return;
    }

    list.push(prefix);
    await saveBlacklist(list);
    input.value = '';
    renderBlacklist();
  });

document.getElementById('blacklistInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('blacklistAddBtn').click();
});

// --- Title Trimming Rules ---
const TRIM_ACTION_LABELS = {
  remove_after_pipe: 'Remove after |',
  remove_brackets: 'Remove [brackets]',
  remove_parens: 'Remove (parens)',
};

async function loadTrimRules() {
  return await loadSettingsValue('titleTrimRules', []);
}

async function saveTrimRules(rules) {
  await saveSettingsValue('titleTrimRules', rules);
}

async function renderTrimRules() {
  return renderSettingsList({
    containerId: 'trimEntries',
    loadFn: loadTrimRules,
    saveFn: saveTrimRules,
    renderItemHtml: (rule) =>
      `<span>${escapeHtml(rule.urlPrefix)}</span>` +
      `<span class="trim-action-label">${escapeHtml(TRIM_ACTION_LABELS[rule.action] || rule.action)}</span>`,
    emptyMessage: 'No trimming rules',
    rerender: renderTrimRules,
  });
}

document.getElementById('trimAddBtn').addEventListener('click', async () => {
  const urlInput = document.getElementById('trimUrlInput');
  const actionSelect = document.getElementById('trimActionSelect');
  const prefix = urlInput.value.trim();
  if (!prefix) return;

  const rules = await loadTrimRules();
  // Don't add duplicate prefix+action
  if (
    rules.some((r) => r.urlPrefix === prefix && r.action === actionSelect.value)
  ) {
    urlInput.value = '';
    return;
  }

  rules.push({ urlPrefix: prefix, action: actionSelect.value });
  await saveTrimRules(rules);
  urlInput.value = '';
  renderTrimRules();
});

document.getElementById('trimUrlInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('trimAddBtn').click();
});

// --- Mutation notifications from background ---

function mergeHistoryEntry(entry, existing) {
  if (!existing || entry.timestamp > existing.timestamp) {
    // New entry wins — back-fill missing title/user_title from existing
    if (existing?.title && !entry.title) entry.title = existing.title;
    if (existing?.user_title && !entry.user_title)
      entry.user_title = existing.user_title;
    return { entry, updated: true };
  }
  // Existing wins — patch missing title onto existing from new entry
  let patched = false;
  if (entry.title && !existing.title) {
    existing.title = entry.title;
    patched = true;
  }
  if (entry.user_title && !existing.user_title) {
    existing.user_title = entry.user_title;
    patched = true;
  }
  return { entry: existing, updated: patched };
}

let mutationRefreshTimer = null;

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'mutation') return;

  const { type } = request;

  if (type === 'history') {
    // New page visit — merge into historyState.byUrl and historyState.allEntries
    clearTimeout(mutationRefreshTimer);
    mutationRefreshTimer = setTimeout(async () => {
      try {
        await refreshHistoryMetadata();
      } catch (error) {
        logDebug('history mutation file refresh failed:', error.message);
      }

      let todayEntries = [];
      try {
        todayEntries = await loadHistoryEntriesForDate(
          new Date().toISOString().slice(0, 10),
        );
      } catch (error) {
        logDebug('history mutation log refresh failed:', error.message);
        return;
      }
      const historyEntries = todayEntries.filter(
        (e) =>
          (e.action === 'visit_page' ||
            e.action === 'leave_page' ||
            !e.action) &&
          e.url,
      );
      // Only process entries newer than what we've already ingested
      const watermark = historyState._mutationWatermark || 0;
      let maxTs = watermark;
      let changed = false;
      for (const entry of historyEntries) {
        if (entry.timestamp <= watermark) continue;
        if (entry.timestamp > maxTs) maxTs = entry.timestamp;
        const existing = historyState.byUrl.get(entry.url);
        const { entry: merged, updated } = mergeHistoryEntry(entry, existing);
        if (updated) {
          historyState.byUrl.set(entry.url, merged);
          changed = true;
        }
        historyState.allEntries.push(entry);
      }
      historyState._mutationWatermark = maxTs;
      if (changed) {
        cachedFieldRanges = null;
        queueContentMap = getQueueContentMap(historyEntries);
        if (activeView.type === 'explore' || activeView.type === 'list') {
          runSearchFilterPipeline();
        } else {
          refreshCurrentView();
        }
      }
    }, 500);
  } else if (type === 'pins') {
    // List pins changed — invalidate caches and re-render active list.
    const activeListId = activeView.type === 'list' ? activeView.id : null;
    if (request.listId) {
      delete allListPins[request.listId];
      if (request.listId === activeListId) refreshCurrentView();
    } else {
      allListPins = {};
      if (activeListId) refreshCurrentView();
    }
  } else if (type === 'lists') {
    renderLists();
  } else if (type === 'settings') {
    // Settings changes that need UI updates handled here if needed
  } else if (type === 'note') {
    // Note created/deleted — invalidate cached notes and refresh view

    refreshCurrentView();
  } else if (type === 'rules') {
    // Rules changed — refresh rules panel if viewing the affected list
    if (activeView.type === 'list' && request.listId === activeView.id) {
      refreshRulesForActiveList();
    }
  } else if (type === 'orphaned') {
    // Orphaned list changed — refresh recycle bin if active, update badge
    updateRecycleBinBadge();
    if (activeView.type === 'recycle-bin') showRecycleBin();
  }
  // highlight, snapshot: Desktop-backed reads are refreshed on demand
});

// --- Visibility change: invalidate stale caches when tab regains focus ---
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // Invalidate pin caches (may have been modified in popup)
  allListPins = {};

  // Refresh sidebar lists (may have been created/deleted in popup)
  renderLists();

  // Re-list history files and merge any history written while this window was hidden.
  let historyChanged = false;
  try {
    const previousFiles = historyState.files;
    const filesResp = await refreshHistoryMetadata();
    const allFiles = filesResp.files;
    const existingFiles = new Set(previousFiles);
    const newFiles = allFiles.filter((f) => !existingFiles.has(f));
    if (newFiles.length > 0) {
      const batchResp = await sendAction({
        action: 'loadHistoryBatch',
        files: newFiles,
      });
      const newEntries = batchResp.entries;
      for (const item of newEntries) {
        if (
          item.action &&
          item.action !== 'visit_page' &&
          item.action !== 'leave_page'
        )
          continue;
        if (!item.url) continue;
        historyState.allEntries.push(item);
        if (item.timestamp > historyState._mutationWatermark) {
          historyState._mutationWatermark = item.timestamp;
        }
        const { entry: merged, updated } = mergeHistoryEntry(
          item,
          historyState.byUrl.get(item.url),
        );
        if (updated) {
          historyState.byUrl.set(item.url, merged);
          historyChanged = true;
        }
      }
      for (const file of newFiles) historyState.loadedFiles.add(file);
    }

    const todayEntries = await loadHistoryEntriesForDate(
      new Date().toISOString().slice(0, 10),
    );
    const watermark = historyState._mutationWatermark || 0;
    let maxTs = watermark;
    for (const item of todayEntries) {
      if (
        item.action &&
        item.action !== 'visit_page' &&
        item.action !== 'leave_page'
      )
        continue;
      if (!item.url || item.timestamp <= watermark) continue;
      if (item.timestamp > maxTs) maxTs = item.timestamp;
      const { entry: merged, updated } = mergeHistoryEntry(
        item,
        historyState.byUrl.get(item.url),
      );
      if (updated) {
        historyState.byUrl.set(item.url, merged);
        historyChanged = true;
      }
      historyState.allEntries.push(item);
    }
    historyState._mutationWatermark = maxTs;
  } catch (error) {
    logDebug('visibilitychange refresh failed:', error.message);
  }

  if (historyChanged) {
    cachedFieldRanges = null;
    if (activeView.type === 'explore' || activeView.type === 'list') {
      await waitForMainViewport();
      preserveRelatedScrollOnNextRender = true;
      runSearchFilterPipeline();
    } else {
      refreshCurrentView();
    }
  }
});

// --- Explore Search ---

async function renderSearchPanel() {
  const container = document.getElementById('listQueryBuilder');
  container.style.display = 'block';
  const isExplore = activeView.type === 'explore';
  const placeholder = isExplore ? 'Search...' : 'Filter pins...';

  const filterSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';

  let html = '<div class="search-filters-panel" id="searchFiltersPanel">';
  html += '<div class="search-draft">';
  html += `<input type="search" class="search-draft-input" id="searchDraftInput" placeholder="${placeholder}" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none">`;
  html += `<button class="filter-toggle-btn${filterVisible ? ' active' : ''}${!isDefaultFilterState(filterState) ? ' has-filters' : ''}" id="filterToggleBtn" title="Filters">${filterSvg}</button>`;
  html += '</div>';

  html += `<div class="filter-panel" id="filterPanel" style="display:${filterVisible ? 'flex' : 'none'}">`;
  html += await renderFilterPanelHtml();
  html += '</div>';

  html += '</div>';

  container.innerHTML = html;
  const draftEl = container.querySelector('#searchDraftInput');
  if (draftEl) draftEl.value = draftSearchInput;
  bindSearchEvents(container);
  if (filterVisible) bindFilterEvents(container);
}

async function renderFilterPanelHtml() {
  await listsReadyPromise;
  const hasFilters = !isDefaultFilterState(filterState);
  let html = `<div class="filter-panel-header"><div class="filter-panel-title">Filters</div><button class="filter-clear-btn" id="filterClearBtn" type="button"${hasFilters ? '' : ' disabled'}>Clear</button></div>`;
  const isListView = activeView.type === 'list';

  // Sort toggle (list view only)
  if (isListView) {
    const sortOptions = [
      { key: 'lastVisit', label: 'Last visit' },
      { key: 'firstVisit', label: 'First visit' },
      { key: 'pinTime', label: 'Pin time' },
      { key: 'title', label: 'Title' },
      { key: 'totalVisits', label: 'Visits' },
    ];
    const currentSort = relatedSortState.column || 'lastVisit';
    html +=
      '<div class="filter-section"><div class="filter-section-label">Sort by</div>';
    html += '<div class="sort-toggle">';
    for (const opt of sortOptions) {
      html += `<button class="sort-toggle-option${currentSort === opt.key ? ' active' : ''}" data-sort="${opt.key}">${escapeHtml(opt.label)}</button>`;
    }
    html += '</div></div>';
  }

  // Device bubbles
  const deviceIds = [...new Set(historyState.devices || [])].sort();
  if (deviceIds.length > 1) {
    html +=
      '<div class="filter-section"><div class="filter-section-label">Devices</div>';
    html += '<div class="filter-bubbles">';
    for (const did of deviceIds) {
      const active = filterState.devices?.[did] === true;
      html += `<button class="filter-bubble${active ? ' active' : ''}" data-device-id="${escapeHtml(did)}">${escapeHtml(did)}</button>`;
    }
    html += '</div></div>';
  }

  // List bubbles (explore view only, when lists exist)
  if (!isListView && listNameById.size > 0) {
    html +=
      '<div class="filter-section"><div class="filter-section-label">Lists</div>';
    html += '<div class="filter-bubbles">';
    for (const [slug, name] of listNameById) {
      const active = filterState.lists?.[slug] === true;
      html += `<button class="filter-bubble${active ? ' active' : ''}" data-list-slug="${escapeHtml(slug)}">${escapeHtml(name)}</button>`;
    }
    html += '</div></div>';
  }

  // Time filters
  html +=
    '<div class="filter-section"><div class="filter-section-label">Time</div>';
  html += renderDualRangeFilter('lastSeen', 'Last seen', filterState.lastSeen);
  html += renderDualRangeFilter(
    'firstSeen',
    'First seen',
    filterState.firstSeen,
  );
  html += '</div>';

  // Page-specific booleans
  html +=
    '<div class="filter-section"><div class="filter-section-label">Page properties</div>';
  html += '<div class="filter-checkboxes">';
  html += renderCheckboxFilter(
    'hasHighlights',
    'Has highlights',
    filterState.hasHighlights,
  );
  html += renderCheckboxFilter(
    'hasSnapshots',
    'Has snapshots',
    filterState.hasSnapshots,
  );
  html += renderCheckboxFilter('liked', 'Liked', filterState.liked);
  html += renderCheckboxFilter(
    'visitedMultipleTimes',
    'Visited multiple times',
    filterState.visitedMultipleTimes,
  );
  html += '</div>';
  html += '</div>';

  return html;
}

function renderDualRangeFilter(stateKey, label, state, rangeField) {
  const field =
    rangeField ||
    (stateKey === 'lastSeen'
      ? 'lastVisit'
      : stateKey === 'firstSeen'
        ? 'firstVisit'
        : 'timeOnPage');
  const cfg = getRangeConfig(field);
  const lo = state.lo !== null ? state.lo : cfg.min;
  const hi = state.hi !== null ? state.hi : cfg.max;
  const range = cfg.max - cfg.min;
  const loPercent = range > 0 ? ((lo - cfg.min) / range) * 100 : 0;
  const hiPercent = range > 0 ? ((cfg.max - hi) / range) * 100 : 0;

  // isDaysAgo: visually invert so left = older date, right = more recent date
  const inverted = cfg.isDaysAgo;
  const leftLabel = inverted ? cfg.format(hi) : cfg.format(lo);
  const rightLabel = inverted ? cfg.format(lo) : cfg.format(hi);
  const fillLeft = inverted ? hiPercent : loPercent;
  const fillRight = inverted ? loPercent : hiPercent;

  let html = `<div class="filter-range" data-key="${stateKey}">`;
  html += `<span class="filter-range-label">${escapeHtml(label)}</span>`;
  html += `<div class="qb-dual-range">`;
  html += `<span class="qb-dual-range-label qb-dual-range-lo-label">${leftLabel}</span>`;
  html += `<div class="qb-dual-range-track${inverted ? ' inverted' : ''}">`;
  html += `<div class="qb-dual-range-fill" style="left:${fillLeft}%;right:${fillRight}%"></div>`;
  html += `<input type="range" class="filter-range-lo" data-key="${stateKey}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${lo}">`;
  html += `<input type="range" class="filter-range-hi" data-key="${stateKey}" min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${hi}">`;
  html += `</div>`;
  html += `<span class="qb-dual-range-label qb-dual-range-hi-label">${rightLabel}</span>`;
  html += `</div></div>`;
  return html;
}

function renderCheckboxFilter(stateKey, label, value) {
  const checked = value === true ? ' checked' : '';
  return `<label class="filter-checkbox"><input type="checkbox" data-key="${stateKey}"${checked}> ${escapeHtml(label)}</label>`;
}

function updateFilterPanelActions(container) {
  const hasFilters = !isDefaultFilterState(filterState);
  const filterBtn = container.querySelector('#filterToggleBtn');
  if (filterBtn) filterBtn.classList.toggle('has-filters', hasFilters);
  const clearBtn = container.querySelector('#filterClearBtn');
  if (clearBtn) clearBtn.disabled = !hasFilters;
}

function bindSearchEvents(container) {
  // Draft input — search/filter only after Enter commits the query.
  const draftInput = container.querySelector('#searchDraftInput');
  if (draftInput) {
    draftInput.addEventListener('input', () => {
      draftSearchInput = draftInput.value;
    });
    draftInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const nextQuery = draftInput.value.trim();
        e.preventDefault();
        if (nextQuery === committedSearchQuery.trim()) return;
        const hadQuery = Boolean(committedSearchQuery.trim());
        committedSearchQuery = nextQuery;
        draftSearchInput = nextQuery;
        if (hadQuery && !committedSearchQuery) {
          runActiveSearchPipeline._preserveScroll = true;
        }
        await renderSearchPanel();
        saveSearchQuery();
        runActiveSearchPipeline();
        document
          .querySelector('#searchDraftInput')
          ?.focus({ preventScroll: true });
      }
    });
  }

  // Filter toggle
  const filterBtn = container.querySelector('#filterToggleBtn');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      filterVisible = !filterVisible;
      const panel = container.querySelector('#filterPanel');
      if (panel) {
        panel.style.display = filterVisible ? 'flex' : 'none';
        filterBtn.classList.toggle('active', filterVisible);
        if (filterVisible) bindFilterEvents(container);
      }
    });
  }
}

function bindFilterEvents(container) {
  const clearBtn = container.querySelector('#filterClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (isDefaultFilterState(filterState)) return;
      filterState = createDefaultFilterState();
      saveFilterState();
      await renderSearchPanel();
      runActiveSearchPipeline();
    });
  }

  // Sort toggle (list view)
  container.querySelectorAll('.sort-toggle-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sortKey = btn.dataset.sort;
      // Toggle direction if clicking the already-active sort
      if (relatedSortState.column === sortKey) {
        relatedSortState.direction =
          relatedSortState.direction === 'desc' ? 'asc' : 'desc';
      } else {
        relatedSortState.column = sortKey;
        relatedSortState.direction = sortKey === 'title' ? 'asc' : 'desc';
      }
      // Update active class
      container
        .querySelectorAll('.sort-toggle-option')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      runActiveSearchPipeline();
    });
  });

  // Dual-range sliders
  container
    .querySelectorAll('.filter-range-lo, .filter-range-hi')
    .forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        const rangeDiv = input.closest('.filter-range');
        const loInput = rangeDiv.querySelector('.filter-range-lo');
        const hiInput = rangeDiv.querySelector('.filter-range-hi');
        let lo = parseFloat(loInput.value);
        let hi = parseFloat(hiInput.value);
        // Prevent crossover
        if (lo > hi) {
          if (input.classList.contains('filter-range-lo')) {
            lo = hi;
            loInput.value = lo;
          } else {
            hi = lo;
            hiInput.value = hi;
          }
        }
        const field =
          key === 'lastSeen'
            ? 'lastVisit'
            : key === 'firstSeen'
              ? 'firstVisit'
              : 'timeOnPage';
        const cfg = getRangeConfig(field);
        const inverted = cfg.isDaysAgo;
        const loPercent = ((lo - cfg.min) / (cfg.max - cfg.min)) * 100;
        const hiPercent = 100 - ((hi - cfg.min) / (cfg.max - cfg.min)) * 100;
        // Update fill bar
        const fill = rangeDiv.querySelector('.qb-dual-range-fill');
        if (fill) {
          fill.style.left = (inverted ? hiPercent : loPercent) + '%';
          fill.style.right = (inverted ? loPercent : hiPercent) + '%';
        }
        // Update labels (inverted: left=hi/older, right=lo/recent)
        const loLabel = rangeDiv.querySelector('.qb-dual-range-lo-label');
        const hiLabel = rangeDiv.querySelector('.qb-dual-range-hi-label');
        if (loLabel)
          loLabel.textContent = inverted ? cfg.format(hi) : cfg.format(lo);
        if (hiLabel)
          hiLabel.textContent = inverted ? cfg.format(lo) : cfg.format(hi);
        // Update state: null if at boundary (= unbounded)
        filterState[key] = {
          lo: lo > cfg.min ? lo : null,
          hi: hi < cfg.max ? hi : null,
        };
        saveFilterState();
        updateFilterPanelActions(container);
        runActiveSearchPipeline();
      });
    });

  // Checkbox filters
  container.querySelectorAll('.filter-checkbox input').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      filterState[key] = input.checked ? true : null;
      saveFilterState();
      updateFilterPanelActions(container);
      runActiveSearchPipeline();
    });
  });

  // Filter bubble toggles
  container.querySelectorAll('.filter-bubble').forEach((btn) => {
    btn.addEventListener('click', () => {
      const deviceId = btn.dataset.deviceId;
      const listSlug = btn.dataset.listSlug;
      if (deviceId) {
        if (!filterState.devices) filterState.devices = {};
        if (filterState.devices[deviceId] === true) {
          delete filterState.devices[deviceId];
          btn.classList.remove('active');
        } else {
          filterState.devices[deviceId] = true;
          btn.classList.add('active');
        }
      } else if (listSlug) {
        if (!filterState.lists) filterState.lists = {};
        if (filterState.lists[listSlug] === true) {
          delete filterState.lists[listSlug];
          btn.classList.remove('active');
        } else {
          filterState.lists[listSlug] = true;
          btn.classList.add('active');
        }
      }
      saveFilterState();
      updateFilterPanelActions(container);
      runActiveSearchPipeline();
    });
  });
}

// Entity-scan filter: scan page checkpoints instead of all history JSONL files.
// Page entities contain materialized state (childIds, visitDates, timestamps, etc.)
// sufficient to answer all filters without loading raw event logs.
async function runEntityScanFilter(pinnedSlugs) {
  showSearchSpinner();
  const resp = await sendAction({ action: 'loadAllPages' });
  if (!resp.pages) {
    hideSearchSpinner();
    return null;
  }

  const pages = resp.pages;
  const slugs = Object.keys(pages);

  // Batch-load note entities for hasHighlights check
  const allNoteRefs = new Set();
  for (const slug of slugs) {
    const page = pages[slug];
    if (!page?.childIds) continue;
    for (const id of page.childIds) {
      if (id.startsWith(NOTE_PREFIX)) allNoteRefs.add(id);
    }
  }
  const noteMap = new Map();
  if (allNoteRefs.size > 0) {
    const noteKeys = [...allNoteRefs];
    const noteEntities = await Promise.all(
      noteKeys.map((k) => readDesktopValue(k)),
    );
    for (let i = 0; i < noteKeys.length; i++) {
      if (noteEntities[i]) noteMap.set(noteKeys[i], noteEntities[i]);
    }
  }

  // Build display rows from page entities
  const now = Date.now();
  const seenUrls = new Set();
  const results = [];

  for (const slug of slugs) {
    const page = pages[slug];
    if (!page?.url || pinnedSlugs.has(slug)) continue;
    if (seenUrls.has(page.url)) continue;
    seenUrls.add(page.url);

    const timestamps = page.timestamps || {};
    const deviceTimestamps = Object.values(timestamps);
    const latestTs =
      deviceTimestamps.length > 0
        ? Math.max(...deviceTimestamps)
        : page.createdAt || now;

    const d = new Date(latestTs);
    const day =
      d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

    const noteRefs = (page.childIds || []).filter((id) =>
      id.startsWith(NOTE_PREFIX),
    );
    const notes = noteRefs
      .map((ref) => noteMap.get(ref))
      .filter((n) => n && !n.deleted);

    results.push({
      url: page.url,
      title: page.title || '',
      user_title: page.user_title,
      slug,
      timestamp: latestTs,
      day,
      attScore: attentionStrength(page),
      attDetail: page,
      notes,
      timestamps:
        deviceTimestamps.length > 0
          ? deviceTimestamps.sort((a, b) => b - a)
          : [latestTs],
      visitDates: page.visitDates || [],
      latestTs,
      deviceIds: new Set(Object.keys(timestamps)),
      childIds: page.childIds,
      parentIds: page.parentIds,
      likes: page.likes,
      createdAt: page.createdAt,
      hasHighlightNotes: noteRefs.some((ref) => {
        const note = noteMap.get(ref);
        return note && note.excerpt !== null && !note.deleted;
      }),
      visitCount: page.visitDates?.length || 1,
      firstTimestamp: page.createdAt || latestTs,
      timeOnPage: page.timeOnPage || 0,
      relevance: 0,
    });
  }

  // Merge pages from pending queue / already-loaded history that may not be on disk yet
  for (const item of historyState.allEntries) {
    if (!item.url) continue;
    const slug = item.slug || generateSlugFromUrl(item.url);
    if (pinnedSlugs.has(slug) || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    const deviceIds = new Set();
    if (item.deviceId) deviceIds.add(item.deviceId);
    results.push({
      url: item.url,
      title: item.title || '',
      user_title: item.user_title,
      slug,
      timestamp: item.timestamp,
      day: (() => {
        const d = new Date(item.timestamp);
        return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      })(),
      attScore: attentionStrength(item),
      attDetail: item,
      notes: [],
      timestamps: [item.timestamp],
      visitDates: [],
      latestTs: item.timestamp,
      deviceIds,
      relevance: 0,
    });
  }

  hideSearchSpinner();
  return results;
}

async function runSearchFilterPipeline() {
  if (activeView.type !== 'explore') return;
  cardDataByUrl.clear();

  const pinnedSlugs = new Set();

  const allQueries = committedSearchQuery.trim()
    ? [committedSearchQuery.trim()]
    : [];

  if (allQueries.length > 0 && allQueries.some((q) => q.trim())) {
    // Progressive multi-phase search: Phase 0 (in-memory) renders instantly,
    // then Phase 1 (JSONL), 2a (notes), 2b (snapshots) fire concurrently.
    await runProgressiveSearch(allQueries);
    return;
  }

  cancelActiveHistorySearch();
  // No search queries → show all history (demand-loaded)
  const hasActiveFilters = !isDefaultFilterState(filterState);

  let results;
  let entityScanUsed = false;
  if (hasActiveFilters) {
    // Entity-scan shortcut: scan page checkpoints instead of loading all JSONL files.
    results = await runEntityScanFilter(pinnedSlugs);
    if (results !== null) {
      entityScanUsed = true;
    } else {
      // Fallback: load all JSONL batches (e.g. filesystem not available)
      showSearchSpinner();
      while (
        historyState.loadedFiles.size <
        Math.min(historyState.files.length, HISTORY_MAX_FILES)
      ) {
        await loadHistoryBatch();
        await new Promise((r) => setTimeout(r, 0));
      }
      results = processHistoryForDisplay(
        historyState.allEntries.filter(
          (item) => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)),
        ),
      ).map((item) => ({ ...item, relevance: 0 }));
      await enrichFromEntityStorage(results);
      await enrichForFilters(results);
    }
    results = await applyFilters(results);
    hideSearchSpinner();
  } else {
    results = processHistoryForDisplay(
      historyState.allEntries.filter(
        (item) => item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)),
      ),
    ).map((item) => ({ ...item, relevance: 0 }));
  }

  const relatedContainer = document.getElementById('relatedResults');
  if (results.length === 0) {
    consumeRelatedTopReset();
    relatedContainer.innerHTML = '<div class="no-results">No results</div>';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column
    ? relatedSortState
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map((r) => r.attScore), 0.1);

  const vs = getOrCreateRelatedScroller();
  vs._headerHtml = '';
  const preserveScroll = preserveRelatedScrollOnNextRender;
  preserveRelatedScrollOnNextRender = false;
  const renderAtTop = preserveScroll ? false : consumeRelatedTopReset();
  const renderRow = (r) =>
    resultRowHtml(r.user_title || r.title, r.url, {
      attScore: r.attScore,
      maxAtt,
      attDetail: r.attDetail,
      notes: r.notes,
      timestamps: r.timestamps,
      visitDates: r.dateScope === 'row' ? undefined : r.visitDates,
      context: 'related',
      childIds: r.childIds,
      parentIds: r.parentIds,
      likes: r.likes,
      hasHighlightNotes: r.hasHighlightNotes,
    });
  if (renderAtTop) {
    vs.updateDataAtTop(sorted, renderRow);
  } else {
    vs.updateData(sorted, renderRow, { preserveScroll });
  }

  // When no active filters, enrich in background and refresh visible rows
  if (!hasActiveFilters) {
    enrichFromEntityStorage(results, { includeVisitDates: false }).then(() =>
      vs.refreshVisible(),
    );
  }

  // Demand-load more history when scrolling (for all-history mode).
  // Skip when entity scan was used — all matching pages are already loaded.
  vs.onLoadMore = entityScanUsed
    ? null
    : async () => {
        const hasActiveFilters = !isDefaultFilterState(filterState);
        if (hasActiveFilters) showSearchSpinner();
        let loaded = false;
        do {
          const newItems = await loadHistoryBatch();
          if (newItems.length === 0) break;
          loaded = true;
          if (hasActiveFilters) await new Promise((r) => setTimeout(r, 0));
          const filtered = newItems.filter(
            (item) =>
              item.url && !pinnedSlugs.has(generateSlugFromUrl(item.url)),
          );
          let newResults = processHistoryForDisplay(filtered).map((item) => ({
            ...item,
            relevance: 0,
          }));
          if (newResults.length > 0) {
            if (hasActiveFilters) {
              await enrichFromEntityStorage(newResults);
              await enrichForFilters(newResults);
              newResults = await applyFilters(newResults);
            }
            if (newResults.length > 0) {
              const sort = relatedSortState.column
                ? relatedSortState
                : { column: 'lastVisit', direction: 'desc' };
              vs.appendData(applySortOrder(newResults, sort));
              if (!hasActiveFilters) {
                enrichFromEntityStorage(newResults, {
                  includeVisitDates: false,
                }).then(() => vs.refreshVisible());
              }
              loaded = false;
            }
          }
        } while (
          hasActiveFilters &&
          loaded &&
          historyState.loadedFiles.size <
            Math.min(historyState.files.length, HISTORY_MAX_FILES)
        );
        if (hasActiveFilters) hideSearchSpinner();
      };

  // Time chart for explore results (with estimated bars for unloaded files)
  const chartData = results.map((r) => ({
    url: r.url,
    timestamp: r.timestamps?.[0] || Date.now(),
    timestamps: r.timestamps,
    visitDates: r.dateScope === 'row' ? undefined : r.visitDates,
    attention: '',
  }));
  const relatedChart = prepareRelatedChartDateFilter(
    exploreDateFilterContext(),
  );
  renderTimeChartInto(
    relatedChart,
    document.getElementById('relatedChartBars'),
    chartData,
    'Explore results',
    getEstimatedByDay(),
  );
  bindChartBarClick(relatedChart, document.getElementById('relatedResults'));
  applyPersistedRelatedDateFilter();

  // Demand-load data when an unloaded date bar is clicked
  relatedChart._onDateSelect = async (activeDates) => {
    if (activeDates.size === 0) return;
    const unloaded = [...activeDates].filter(
      (d) => !historyState.loadedFiles.has(d + '.jsonl'),
    );
    if (unloaded.length === 0) return;
    // Save active dates — runSearchFilterPipeline re-renders chart, destroying DOM state
    const savedDates = new Set(activeDates);
    relatedChart._activeDates = savedDates;
    unloaded.sort();
    await loadHistoryUntilDate(unloaded[0]);
    await runSearchFilterPipeline();
    relatedChart._activeDates = savedDates;
    applyPersistedRelatedDateFilter();
  };
}

// --- Focus Panel ---

async function openFocusPanel(url, title) {
  const overlay = document.getElementById('focusOverlay');
  const content = document.getElementById('focusContent');

  content.innerHTML =
    '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty"><span class="spinner"></span></div></div></div>';
  overlay.classList.add('visible');

  try {
    const resp = await sendAction({
      action: 'getPageRelations',
      url,
    });
    // Compute similar pages from loaded history
    const seedEntry = historyState.byUrl.get(url);
    let similar = [];
    if (seedEntry) {
      const seed = {
        ...seedEntry,
        timestamps: [seedEntry.timestamp || Date.now()],
        attScore: 0,
        attDetail: null,
        notes: [],
      };
      const candidates = Array.from(historyState.byUrl.values())
        .filter((i) => i.url !== url)
        .map((i) => ({
          ...i,
          timestamps: [i.timestamp || Date.now()],
          attScore: 0,
          attDetail: null,
          notes: [],
        }));
      similar = findRelatedPages([seed], candidates, 20);
    }

    renderFocusWaterfall(
      content,
      url,
      title,
      resp.parents,
      resp.children,
      similar,
    );
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml('Error: ' + error.message)}</div></div></div>`;
  }
}

async function openListFocusPanel(listId, listName) {
  const overlay = document.getElementById('focusOverlay');
  const content = document.getElementById('focusContent');

  content.innerHTML =
    '<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty"><span class="spinner"></span></div></div></div>';
  overlay.classList.add('visible');

  try {
    let pins = allListPins[listId];
    if (!pins) {
      const fpEntity = await readDesktopValue(listKey(listId));
      pins = fpEntity?.pins || [];
      allListPins[listId] = pins;
    }

    let html = '';

    // Pinned pages section
    html +=
      '<div class="focus-section"><div class="focus-section-label">Pinned</div><div class="focus-section-cards">';
    if (pins.length === 0) {
      html += '<div class="focus-empty">No pinned pages</div>';
    } else {
      const maxAtt = 0.1;
      const { pinsResolved } = await resolvePinsForDisplay(pins);
      html += pinsResolved
        .map((r) => {
          const title = r.user_title || r.title || '<unknown>';
          return resultRowHtml(title, r.url, {
            deletable: false,
            attScore: 0,
            maxAtt,
            timestamps: [r.pinnedAt || Date.now()],
            visitDates: r.visitDates,
            context: 'global',
            pinSource: r.source || null,
            childIds: r.childIds,
            parentIds: r.parentIds,
          });
        })
        .join('');
    }
    html += '</div></div>';

    content.innerHTML = html;

    // Bind event delegation for focus content cards
    bindFocusContentDelegation(content);
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml('Error: ' + error.message)}</div></div></div>`;
  }
}

function renderFocusWaterfall(content, url, title, parents, children, similar) {
  const maxAtt = 0.1;
  const focusOpts = {
    deletable: false,
    maxAtt,
    context: 'global',
    deletable: false,
  };

  function makeCard(cardUrl, cardTitle, opts = {}) {
    const hist = historyState.byUrl.get(cardUrl);
    let resolvedTitle =
      cardTitle || (hist ? hist.user_title || hist.title : null);
    if (!resolvedTitle) {
      try {
        resolvedTitle = new URL(cardUrl).hostname + new URL(cardUrl).pathname;
      } catch {
        resolvedTitle = cardUrl;
      }
    }
    const timestamps = hist ? [hist.timestamp || Date.now()] : [Date.now()];
    const attScore = 0;
    return resultRowHtml(resolvedTitle, cardUrl, {
      ...focusOpts,
      attScore,
      timestamps,
      visitDates: hist?.visitDates,
      ...opts,
    });
  }

  let html = '';

  // Parents section
  html +=
    '<div class="focus-section"><div class="focus-section-label">Parents</div><div class="focus-section-cards">';
  const hasParents = parents.referrers.length + parents.lists.length > 0;
  if (!hasParents) {
    html += '<div class="focus-empty">No known parents</div>';
  } else {
    html += parents.referrers.map((ref) => makeCard(ref, null)).join('');
  }
  html += '</div></div>';

  // Focused page
  html +=
    '<div class="focus-section"><div class="focus-section-label">Focus</div><div class="focus-section-cards">';
  html += makeCard(url, title, { cssClass: 'focus-highlight' });
  html += '</div></div>';

  // Children section
  html +=
    '<div class="focus-section"><div class="focus-section-label">Children</div><div class="focus-section-cards">';
  if (children.length === 0) {
    html += '<div class="focus-empty">No known children</div>';
  } else {
    html += children.map((childUrl) => makeCard(childUrl, null)).join('');
  }
  html += '</div></div>';

  // Similar section
  if (similar.length > 0) {
    html +=
      '<div class="focus-section"><div class="focus-section-label">Similar</div><div class="focus-section-cards">';
    html += similar.map((s) => makeCard(s.url, s.title)).join('');
    html += '</div></div>';
  }

  content.innerHTML = html;

  // Bind delegation for focus content
  bindFocusContentDelegation(content);
}

function bindFocusContentDelegation(content) {
  // Re-use result delegation for expand on focus cards
  bindResultDelegation(content);

  // Focus card row clicks (not on buttons) re-open focus for that URL
  if (content._focusDelegationBound) return;
  content._focusDelegationBound = true;

  // Pin clicks inside focus panel
  content.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('.result-pin');
    if (pinBtn) {
      e.stopPropagation();
      const url = pinBtn.dataset.pinUrl;
      const title = pinBtn.dataset.pinTitle;
      const cid = getActivePinListId();
      await toggleResultPin(cid, url, title);
      // Update pin button appearance
      pinBtn.classList.toggle('pinned');
      // Refresh background UI
      refreshPins();
      return;
    }
  });

  content.addEventListener('click', (e) => {
    // Skip if click was on a button or handled by result delegation
    if (
      e.target.closest('.result-expand') ||
      e.target.closest('.result-delete') ||
      e.target.closest('.result-pin') ||
      e.target.closest('.result-focus') ||
      e.target.closest('.card-actions')
    )
      return;

    const row = e.target.closest('.result-row');
    if (!row) return;

    // Don't re-focus the highlighted (focused) page
    const item = row.closest('.result-item');
    if (item && item.classList.contains('focus-highlight')) return;

    e.stopPropagation();
    openFocusPanel(row.dataset.url, row.dataset.title);
  });
}

// --- Initialize ---
// --- Sidebar resize ---
function initSidebarResize() {
  const handle = document.getElementById('sidebarResizeHandle');
  if (!handle) return;
  const sidebar = document.querySelector('.sidebar');
  let startX, startWidth;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('active');
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      sidebar.style.width =
        Math.max(180, Math.min(500, startWidth + ev.clientX - startX)) + 'px';
      sidebar.style.minWidth = sidebar.style.width;
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.session
        .set({ sidebarWidth: sidebar.offsetWidth })
        .catch(() => {});
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// --- Sidebar responsive toggle ---
function initSidebarToggle() {
  const toggle = document.getElementById('sidebarToggle');
  const overlay = document.getElementById('sidebarOverlay');
  const sidebar = document.querySelector('.sidebar');
  if (!toggle || !overlay || !sidebar) return;
  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('sidebar-open');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('sidebar-open');
  });
  // Close sidebar on narrow screens when navigating
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.sidebar-item') || e.target.closest('.explore-btn')) {
      sidebar.classList.remove('sidebar-open');
    }
  });
}

async function restoreSidebarWidth() {
  try {
    const { sidebarWidth } = await chrome.storage.session.get(['sidebarWidth']);
    if (sidebarWidth) {
      const sidebar = document.querySelector('.sidebar');
      sidebar.style.width = sidebarWidth + 'px';
      sidebar.style.minWidth = sidebarWidth + 'px';
    }
  } catch (e) {
    /* ignore */
  }
}

// ─── Onboarding ─────────────────────────────────────────────────────

function showOnboarding() {
  const el = document.getElementById('onboarding');
  el.style.display = 'flex';
  document.querySelector('.sidebar').style.display = 'none';

  const setupCard = document.getElementById('onboardingSetupCard');
  const introCard = document.getElementById('onboardingIntroCard');
  const dirBtn = document.getElementById('onboardingDirBtn');
  const dirStatus = document.getElementById('onboardingDirStatus');
  const forwardBtn = document.getElementById('onboardingForwardBtn');
  setupCard.style.display = 'block';
  introCard.style.display = 'none';
  introCard.classList.remove('slide-in');
  onboardingDataFolderConfigured = false;
  onboardingDataFolderPath = '';
  forwardBtn.hidden = true;
  onboardingSelectedScheme = 'amber';
  applyColorScheme(onboardingSelectedScheme);
  if (dirStatus) {
    dirStatus.textContent = '';
    dirStatus.style.color = 'var(--text-secondary, #5E4D3E)';
  }
  applyDesktopConnectorUi({ state: 'offline', hasToken: false });
  initializeOnboardingLaunchAtLogin();

  dirBtn.addEventListener('click', async () => {
    await chooseDesktopDataFolderForOnboarding();
  });
  forwardBtn.addEventListener('click', () => {
    showOnboardingIntro();
  });

  document
    .getElementById('onboardingStartBtn')
    .addEventListener('click', async () => {
      await completeOnboarding();
    });
  document.getElementById('onboardingBackBtn').addEventListener('click', () => {
    introCard.style.display = 'none';
    introCard.classList.remove('slide-in');
    setupCard.style.display = 'block';
  });

  document
    .getElementById('onboardingColorPicker')
    .addEventListener('click', (e) => {
      const dot = e.target.closest('.color-dot');
      if (!dot) return;
      onboardingSelectedScheme = dot.dataset.scheme;
      applyColorScheme(onboardingSelectedScheme);
      el.querySelectorAll('.color-dot').forEach((d) => {
        d.classList.toggle(
          'active',
          d.dataset.scheme === onboardingSelectedScheme,
        );
      });
    });
}

async function initialize() {
  bindWindowDragRegions();
  // Apply theme before any rendering to minimize flash
  let currentTheme = await applyTheme();

  const deviceResp = await sendAction({
    action: 'getDeviceId',
  });
  if (!deviceResp?.deviceId) {
    showOnboarding();
    await updateStorageStatus();
    document.body.dataset.ready = 'true';
    revealApp();
    return;
  }

  const persistedTheme = await loadSettingsValue('theme', 'system');
  await chrome.storage.session.set({ theme: persistedTheme });
  currentTheme = await applyTheme();

  await initializeMain(currentTheme);
}

async function initializeMain(currentTheme) {
  // Apply theme if not already done (e.g. coming from onboarding)
  if (!currentTheme) currentTheme = await applyTheme();

  const _t0 = performance.now();
  const _timer = (label) =>
    logDebug(
      `[init-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`,
    );

  // Check for service downtime (paused state) and show error banner if set
  try {
    const { serviceError: svcErr } = await chrome.storage.session.get([
      'serviceError',
    ]);
    if (svcErr) {
      showServiceErrorBanner(svcErr);
    }
  } catch {}

  // Verify device identity from daemon app config.
  const deviceResp = await sendAction({
    action: 'getDeviceId',
  });
  if (!deviceResp?.deviceId) {
    throw new Error(
      'Device identity unavailable. Try restarting Browser Recall.',
    );
  }

  // Theme select — reflects current value from applyTheme()
  document.getElementById('themeSelect').value = currentTheme;

  // Color scheme
  const savedScheme = await loadSettingsValue('colorScheme', 'amber');
  applyColorScheme(savedScheme);
  await chrome.storage.session.set({ colorScheme: savedScheme });

  // Load persisted settings from the daemon-backed store.
  historyState.fileBatch = await loadSettingsValue('historyFileBatch', 10);
  document.getElementById('historyFileBatch').value = historyState.fileBatch;
  document.getElementById('captureSnapshotVideo').checked =
    await loadSettingsValue('captureSnapshotVideo', false);

  // Addon toggles — infer enabled state from existing data when the toggle key is new
  const blacklistEnabledRaw = await loadSettingsValue('blacklistEnabled', null);
  const blacklistEnabled =
    blacklistEnabledRaw !== null
      ? blacklistEnabledRaw
      : (await loadSettingsValue('urlBlacklist', null)) !== null || true;
  document.getElementById('blacklistEnabled').checked = blacklistEnabled;
  setAddonOpen(document.getElementById('blacklistBody'), blacklistEnabled);

  const titleCleanupEnabledRaw = await loadSettingsValue(
    'titleCleanupEnabled',
    null,
  );
  const titleTrimRules = await loadSettingsValue('titleTrimRules', null);
  const titleCleanupEnabled =
    titleCleanupEnabledRaw !== null
      ? titleCleanupEnabledRaw
      : titleTrimRules !== null && titleTrimRules.length > 0;
  document.getElementById('titleCleanupEnabled').checked = titleCleanupEnabled;
  setAddonOpen(
    document.getElementById('titleCleanupBody'),
    titleCleanupEnabled,
  );

  // Sync settings
  const syncEnabled = await loadSettingsValue('syncEnabled', false);
  document.getElementById('syncEnabled').checked = syncEnabled;
  setAddonOpen(document.getElementById('syncConfigFields'), syncEnabled);
  document.getElementById('syncIntervalMinutes')?.closest('.option')?.remove();
  document.getElementById('syncMethod').value = 'github';
  document.getElementById('syncRepoUrl').value = await loadSettingsValue(
    'syncRepoUrl',
    '',
  );
  // Load GitHub auth state from background (token lives in session, not settings)
  try {
    const authState = await sendAction({ action: 'getSyncAuthState' });
    if (authState.hasToken) {
      const user = authState.githubUser ? `as @${authState.githubUser}` : '';
      syncShowAuthState('connected', user);
    } else {
      syncShowAuthState('disconnected');
    }
    document.getElementById('syncRememberToken').checked =
      authState.rememberToken;
  } catch {
    syncShowAuthState('disconnected');
  }
  document.getElementById('syncRetentionDays').value = await loadSettingsValue(
    'syncRetentionDays',
    7,
  );
  if (syncEnabled) refreshSyncDevices();
  _timer('loadSettings');

  // Initialize chart tooltips
  initCharts();
  _timer('initCharts');

  // Load fold state and restore sidebar width before rendering lists
  await loadFoldState();
  restoreSidebarWidth();
  initSidebarResize();
  initSidebarToggle();
  _timer('sidebarInit');

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  listsReadyPromise = renderLists().catch((err) => showFatalError(err.message));
  renderBlacklist();
  renderTrimRules();
  initRulesPanel();
  _timer('renderSidebar (fire-and-forget)');

  // Load metadata (history is demand-loaded in showCategory, pins loaded per-list)
  await initHistoryFiles();
  _timer('parallel metadata load');
  updateRecycleBinBadge();
  await showExplore();
  await applyPendingShellRoute();
}

initialize().catch((err) => {
  document.body.dataset.ready = 'true';
  revealApp();
  showFatalError(err.message);
});

function getActiveContainer() {
  return activeView.type === 'category'
    ? document.getElementById('results')
    : document.getElementById('relatedResults');
}

function isTextEditingTarget(target = document.activeElement) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
}

function isKeyboardActivationTarget(target = document.activeElement) {
  const tag = target?.tagName;
  return (
    isTextEditingTarget(target) ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    tag === 'SELECT' ||
    target?.closest?.('button, a, [role="button"], [role="link"]')
  );
}

function selectedRowsInActiveContainer() {
  const container = getActiveContainer();
  return container
    ? [...container.querySelectorAll('.result-row.selected')]
    : [];
}

async function openUrlsInBrowser(urls) {
  for (const url of urls) {
    await chrome.tabs.create({ url });
  }
}

// --- Keyboard open for selected result rows ---
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)
    return;
  if (isKeyboardActivationTarget(e.target)) return;

  const urls = [
    ...new Set(selectedRowsInActiveContainer().map((row) => row.dataset.url)),
  ].filter(Boolean);
  if (urls.length === 0) return;

  e.preventDefault();
  await openUrlsInBrowser(urls);
});

// --- Keyboard delete for selected result rows ---
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // Don't intercept when typing in an input/textarea
  if (isTextEditingTarget()) return;

  // Determine which container has selected rows
  const isListView = activeView.type === 'list';
  const selected = selectedRowsInActiveContainer();
  if (selected.length === 0) return;

  e.preventDefault();

  if (!isListView) {
    showInfoBubble('Cannot delete history');
    return;
  }

  // Unpin each selected row from the active list
  const listId = activeView.id;
  for (const row of selected) {
    const url = row.dataset.url;
    const title = row.dataset.title;
    if (url) await toggleResultPin(listId, url, title);
  }
  preserveRelatedScrollOnNextRender = true;
  refreshPins();
});

// --- Ctrl+C / Ctrl+V for page copy-paste ---
document.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (isTextEditingTarget()) return;

  const key = e.key.toLowerCase();

  if (key === 'c') {
    // Copy selected rows as readable text with angle-bracket URLs
    const selected = selectedRowsInActiveContainer();
    if (selected.length === 0) return;

    e.preventDefault();
    const lines = [...selected].map((r) => {
      const title = (r.dataset.title || '').replace(/[<>]/g, '');
      const url = r.dataset.url || '';
      return title ? `${title} <${url}>` : `<${url}>`;
    });
    await navigator.clipboard.writeText(lines.join('\n'));
  }

  if (key === 'v') {
    if (activeView.type !== 'list') {
      e.preventDefault();
      showInfoBubble('Can only paste into a list');
      return;
    }

    e.preventDefault();
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    // Extract URLs from angle-bracket format: <url>
    const urls = [];
    for (const m of text.matchAll(/<([^>]+)>/g)) {
      const candidate = m[1].trim();
      if (candidate.includes('://')) urls.push(candidate);
    }
    if (urls.length === 0) return;

    const listId = activeView.id;
    await sendAction({
      action: 'addListPins',
      listId,
      urls: urls,
    });
    refreshPins();
  }

  if (key === 'a') {
    e.preventDefault();
    if (activeView.type === 'list') {
      getActiveContainer()
        ?.querySelectorAll('.result-row')
        .forEach((row) => row.classList.add('selected'));
      syncChartHighlights();
    } else if (
      activeView.type === 'explore' &&
      searchState.results.length > 0
    ) {
      if (searchState.results.length > 100) {
        showErrorBubble('Too many results to select (limit: 100)', {
          suffix: '',
        });
      } else {
        relatedVirtualScroller?.selectAll();
      }
    } else {
      showBlockedBubble('Select all is not available here');
    }
  }
});
