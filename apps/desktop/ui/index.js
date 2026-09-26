// Options page for Browser Recall
// Bookmark-manager style UI with sidebar navigation, search, and settings modal
import { parseSearchQueryWords, scoreSearchFields } from './search-runtime.js';
import {
  generateSlugFromUrl,
  escapeHtml,
  BODY_WORD_LIMIT,
  collectVisitDateKeys,
} from './utils.js';
import {
  invalidateSettingsCache,
  loadListDisplay,
  loadListTreeProjection,
  loadAllPageContext,
  loadHighlightHistoryPage,
  loadDesktopConnectorState,
  loadDesktopShellState,
  loadDirectoryInfo,
  loadDeviceIdentity,
  loadPageContext,
  loadRecycleBin,
  loadSettings,
  loadSettingsValue,
  saveSettingsValue as persistSettingsValue,
  reloadApp,
  sendAction,
} from './desktop-bridge.js';
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
import { justify } from './vendor/justif/index.js';
import { hyphenateEnUS } from './vendor/justif/hyphenate/en-us.js';
import {
  canonicalRegisteredLocale,
  getActiveLocale,
  initializeCatalogI18n,
  localizeDocument,
  populateLocaleSelect,
  tr as translate,
} from '../../../packages/core/i18n.js';

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

// parseBookmarkHtml imported dynamically inside the block below

let desktopSystemLocale = null;

function tr(key, fallback, substitutions) {
  return translate(key, fallback, substitutions);
}

async function initializeDesktopLocalization({
  localeOverride = 'system',
} = {}) {
  if (!desktopSystemLocale) {
    const resp = await sendAction({ action: 'getDesktopSystemLocale' });
    if (typeof resp?.locale !== 'string' || !resp.locale.trim()) {
      throw new Error('Desktop system locale is unavailable');
    }
    desktopSystemLocale = resp.locale;
  }
  let selectedOverride = localeOverride;
  if (localeOverride !== 'system') {
    selectedOverride = canonicalRegisteredLocale(localeOverride);
    if (!selectedOverride) {
      throw new Error(`Unsupported locale override: ${String(localeOverride)}`);
    }
  }
  const effectiveLocale =
    selectedOverride !== 'system' ? selectedOverride : desktopSystemLocale;
  await initializeCatalogI18n({ locale: effectiveLocale });
  localizeDocument();
  const select = document.getElementById('localeSelect');
  populateLocaleSelect(select);
  if (select) select.value = selectedOverride;
}

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

function handoffNestedSettingsWheel(event, nestedScroller, deltaY) {
  if (!nestedScroller || deltaY === 0) return false;
  const modalBody =
    event.target instanceof Element
      ? event.target.closest('#settingsModal .modal-body')
      : null;
  if (
    !modalBody ||
    nestedScroller === modalBody ||
    !canScrollInDirection(modalBody, 'y', deltaY)
  ) {
    return false;
  }

  event.preventDefault();
  modalBody.scrollTop += deltaY;
  return true;
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

function captureRelatedDomScrollAnchor(container) {
  const main = document.querySelector('.main');
  if (!main || !container || main.scrollTop <= 0) return null;
  const mainTop = main.getBoundingClientRect().top;
  const row = [...container.querySelectorAll('.result-row')].find(
    (candidate) => candidate.getBoundingClientRect().bottom > mainTop + 1,
  );
  if (!row?.dataset?.url) return { fallbackTop: main.scrollTop };
  return {
    key: row.dataset.url,
    offsetWithinViewport: row.getBoundingClientRect().top - mainTop,
    fallbackTop: main.scrollTop,
  };
}

function restoreRelatedDomScrollAnchor(container, anchor) {
  if (!anchor) return false;
  const main = document.querySelector('.main');
  if (!main || !container) return false;
  if (anchor.key) {
    const escapedKey =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(anchor.key)
        : String(anchor.key).replace(/["\\]/g, '\\$&');
    const row = container.querySelector(
      `.result-row[data-url="${escapedKey}"]`,
    );
    if (row) {
      const mainTop = main.getBoundingClientRect().top;
      const delta =
        row.getBoundingClientRect().top - mainTop - anchor.offsetWithinViewport;
      main.scrollTop = Math.max(0, main.scrollTop + delta);
      return true;
    }
  }
  if (Number.isFinite(anchor.fallbackTop)) {
    main.scrollTop = Math.max(0, anchor.fallbackTop);
    return true;
  }
  return false;
}

function preventDesktopOverscroll(event) {
  const wantsX = event.deltaX !== 0;
  const wantsY = event.deltaY !== 0;
  if (!wantsX && !wantsY) return;

  const scrollableX = wantsX ? scrollableForAxis(event.target, 'x') : null;
  const scrollableY = wantsY ? scrollableForAxis(event.target, 'y') : null;
  const deltaY = wantsY ? wheelDeltaPixels(event, 'y') : 0;
  const canScrollX =
    wantsX &&
    canScrollInDirection(scrollableX, 'x', wheelDeltaPixels(event, 'x'));
  const canScrollY = wantsY && canScrollInDirection(scrollableY, 'y', deltaY);

  if (canScrollX || canScrollY) return;
  if (handoffNestedSettingsWheel(event, scrollableY, deltaY)) return;

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
  fs_error: {
    text: () => tr('desktopStorageAccessFailed', 'Storage access failed'),
    action: 'resume',
  },
  replay_error: {
    text: () => tr('desktopReplayWorkerFailed', 'Replay worker failed'),
    action: 'resume',
  },
  manual_pause: {
    text: () => tr('extensionBrowserRecallPaused', 'Browser Recall is paused'),
    action: 'resume',
  },
  session_quota: {
    text: () => tr('desktopSessionStorageFull', 'Session storage full'),
    action: 'reload',
  },
  local_quota: {
    text: () => tr('desktopLocalStorageFull', 'Local storage full'),
    action: 'reload',
  },
};

function showServiceErrorBanner(svcErr) {
  const banner = document.getElementById('serviceErrorBanner');
  const msgEl = document.getElementById('serviceErrorMessage');
  const reloadBtn = document.getElementById('serviceErrorReloadBtn');
  const resumeBtn = document.getElementById('serviceErrorResumeBtn');
  if (!banner || !msgEl) return;

  const info = ERROR_CODE_MESSAGES[svcErr.code] || {
    text: () =>
      svcErr.message || tr('desktopServiceUnavailable', 'Service unavailable'),
    action: 'resume',
  };
  msgEl.textContent = info.text();

  reloadBtn.style.display = info.action === 'reload' ? '' : 'none';
  resumeBtn.style.display = info.action === 'resume' ? '' : 'none';

  reloadBtn.onclick = () => reloadApp();
  resumeBtn.onclick = async () => {
    try {
      await sendAction({ action: 'resumeService' });
      reloadApp();
    } catch (error) {
      msgEl.textContent = tr(
        'desktopErrorPrefix',
        `Could not resume service: ${error.message}`,
        [error.message],
      );
    }
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
    <div style="color:#b41e1e;font-size:18px;font-weight:600;">${escapeHtml(tr('desktopStorageUnavailable', 'Storage Unavailable'))}</div>
    <div style="color:#555;font-size:14px;max-width:480px;text-align:center;">${escapeHtml(message)}</div>
    <button id="fatalReloadBtn" style="margin-top:8px;padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-size:13px;">${escapeHtml(tr('desktopReloadExtension', 'Reload Extension'))}</button>
  `;
  document.body.appendChild(overlay);
  overlay
    .querySelector('#fatalReloadBtn')
    .addEventListener('click', () => chrome.runtime.reload());
}

const bubbleTimers = new Map();

function showTimedBubble({ id, style, text, duration }) {
  let bubble = document.getElementById(id);
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = id;
    bubble.style.cssText = style;
    document.body.appendChild(bubble);
  }
  bubble.textContent = text;
  bubble.style.opacity = '1';
  clearTimeout(bubbleTimers.get(id));
  bubbleTimers.set(
    id,
    setTimeout(() => {
      bubble.style.opacity = '0';
    }, duration),
  );
}

function showErrorBubble(
  message,
  { suffix = ' \u2014 please reload the extension.' } = {},
) {
  showTimedBubble({
    id: 'errorBubble',
    style:
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(180,30,30,0.92);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;',
    text: message + suffix,
    duration: 4000,
  });
}

function surfaceBackgroundError(context, error) {
  const message = error instanceof Error ? error.message : String(error);
  logError(`[options] ${context}:`, error);
  showErrorBubble(`${context}: ${message}`, { suffix: '' });
}

async function saveSettingsValue(key, value) {
  try {
    await persistSettingsValue(key, value);
  } catch (error) {
    invalidateSettingsCache();
    showErrorBubble(
      tr('desktopSettingFailed', `Desktop setting failed: ${error.message}`, [
        error.message,
      ]),
      { suffix: '' },
    );
    try {
      await hydrateStartupSettings(await applyTheme());
    } catch (restoreError) {
      showErrorBubble(
        tr(
          'desktopErrorPrefix',
          `Could not reload authoritative settings: ${restoreError.message}`,
          [restoreError.message],
        ),
        { suffix: '' },
      );
    }
    error.browserRecallSurfaced = true;
    throw error;
  }
}

function runSettingsChange(operation) {
  void operation().catch((error) => {
    if (!error.browserRecallSurfaced) {
      showErrorBubble(
        tr('desktopSettingFailed', `Desktop setting failed: ${error.message}`, [
          error.message,
        ]),
        { suffix: '' },
      );
    }
  });
}

function showBlockedBubble(message) {
  showTimedBubble({
    id: 'blockedBubble',
    style:
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(120,120,120,0.88);color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;',
    text: '\u2715 ' + message,
    duration: 2000,
  });
}

function showInfoBubble(message) {
  showTimedBubble({
    id: 'infoBubble',
    style:
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:var(--bg-surface-solid, rgba(255,255,255,0.75));color:var(--text-secondary, #5E4D3E);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:8px 18px;border-radius:6px;border:1px solid var(--border-glass, rgba(255,255,255,0.55));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 2px 8px rgba(0,0,0,0.08);opacity:0;transition:opacity 0.25s;pointer-events:none;max-width:480px;text-align:center;',
    text: message,
    duration: 3000,
  });
}

function applyDesktopConnectorUi() {
  for (const id of ['selectDirBtn', 'onboardingDirBtn']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = false;
    if (id === 'onboardingDirBtn') {
      button.textContent = tr('desktopChooseDataFolder', 'Choose Data Folder');
    } else {
      button.textContent = tr(
        'desktopPairFromBrowserPopup',
        'Pair from Browser Popup',
      );
    }
  }
}

async function refreshDesktopConnectorState() {
  const connector = await loadDesktopConnectorState();
  applyDesktopConnectorUi(connector);
  return connector;
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
    startBtn.textContent = tr('desktopStarting', 'Starting...');
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
      startBtn.textContent = tr('desktopGetStarted', 'Get Started');
      const dirStatus = document.getElementById('onboardingDirStatus');
      if (dirStatus) {
        dirStatus.textContent = tr(
          'desktopCouldNotStartSetup',
          `Could not start setup: ${error.message}`,
          [error.message],
        );
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
  const loginError = document.getElementById('onboardingLaunchAtLoginError');
  if (!input || !row || !unsupported || !loginError) return;
  const shell = await loadDesktopShellState();
  const supported = shell.loginItemSupported;
  input.disabled = !supported;
  input.checked = supported ? shell.launchAtLogin : false;
  row.classList.toggle('disabled', !supported);
  unsupported.style.display = supported ? 'none' : 'block';
  loginError.textContent = shell.loginItemError || '';
  loginError.style.display = shell.loginItemError ? 'block' : 'none';
  if (!shell.setupComplete && shell.dataDir) {
    const dirBtn = document.getElementById('onboardingDirBtn');
    if (dirBtn) {
      dirBtn.textContent = tr('desktopChangeDataFolder', 'Change Data Folder');
    }
    setOnboardingDataFolderConfigured(true, shell.dataDir);
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
    dirStatus.textContent = tr(
      'desktopDataFolder',
      `Data folder: ${onboardingDataFolderPath}`,
      [onboardingDataFolderPath],
    );
  }
}

async function chooseDesktopDataFolderForOnboarding() {
  const dirBtn = document.getElementById('onboardingDirBtn');
  const dirStatus = document.getElementById('onboardingDirStatus');
  const forwardBtn = document.getElementById('onboardingForwardBtn');
  const hadSelectedFolder = onboardingDataFolderConfigured;
  dirBtn.disabled = true;
  dirBtn.textContent = tr('desktopChoosing', 'Choosing...');
  forwardBtn.hidden = true;
  dirStatus.textContent = tr(
    'desktopSelectFolderPrompt',
    'Select the folder where Browser Recall should store its local data.',
  );
  try {
    const result = await sendAction({ action: 'chooseDesktopDataFolder' });
    if (result?.cancelled) {
      dirStatus.textContent = tr(
        'desktopChooseFolderContinue',
        'Choose a data folder to continue.',
      );
      dirBtn.disabled = false;
      dirBtn.textContent = hadSelectedFolder
        ? tr('desktopChangeDataFolder', 'Change Data Folder')
        : tr('desktopChooseDataFolder', 'Choose Data Folder');
      setOnboardingDataFolderConfigured(hadSelectedFolder);
      return;
    }
    dirStatus.textContent = tr(
      'desktopDataFolder',
      `Data folder: ${result.dataFolder}`,
      [result.dataFolder],
    );
    dirBtn.disabled = false;
    dirBtn.textContent = tr('desktopChangeDataFolder', 'Change Data Folder');
    setOnboardingDataFolderConfigured(true, result.dataFolder);
    showOnboardingIntro();
  } catch (error) {
    dirStatus.textContent = tr(
      'desktopCouldNotUseFolder',
      `Could not use that folder: ${error.message}`,
      [error.message],
    );
    dirBtn.disabled = false;
    dirBtn.textContent = hadSelectedFolder
      ? tr('desktopChangeDataFolder', 'Change Data Folder')
      : tr('desktopChooseDataFolder', 'Choose Data Folder');
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
    '.selectable-text',
    '.main-title',
    '.color-dot',
  ].join(',');
  const dragWindow = () => {
    return sendAction({ action: 'startWindowDrag' });
  };
  const toggleFullscreen = () => {
    const scrollPositions = [
      document.querySelector('.main'),
      document.querySelector('.sidebar-content'),
    ]
      .filter((element) => element?.scrollTop > 0)
      .map((element) => ({ element, scrollTop: element.scrollTop }));
    if (scrollPositions.length === 0) {
      return sendAction({ action: 'toggleWindowFullscreen' });
    }

    const RESIZE_SETTLE_MS = 300;
    const TRANSITION_TIMEOUT_MS = 1800;
    let restoreFrame = null;
    let settleTimer = null;
    let transitionTimer = null;
    let active = true;

    const restoreScrollPositions = () => {
      restoreFrame = null;
      if (!active) return;
      for (const { element, scrollTop } of scrollPositions) {
        if (!element.isConnected) continue;
        const maxScrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        if (maxScrollTop > 0) {
          element.scrollTop = Math.min(scrollTop, maxScrollTop);
        }
      }
    };
    const scheduleRestore = () => {
      restoreScrollPositions();
      if (restoreFrame === null) {
        restoreFrame = requestAnimationFrame(restoreScrollPositions);
      }
    };
    const cleanup = () => {
      if (!active) return;
      scheduleRestore();
      active = false;
      window.removeEventListener('resize', handleResize);
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (transitionTimer !== null) clearTimeout(transitionTimer);
    };
    const handleResize = () => {
      scheduleRestore();
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(cleanup, RESIZE_SETTLE_MS);
    };

    window.addEventListener('resize', handleResize);
    transitionTimer = setTimeout(cleanup, TRANSITION_TIMEOUT_MS);
    scheduleRestore();
    return sendAction({ action: 'toggleWindowFullscreen' }).catch((error) => {
      cleanup();
      throw error;
    });
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
const URL_SEARCH_SCORE = 0.5;
const SEARCH_SOURCE_PRIORITY = Object.freeze({
  snapshot: 1,
  note: 2,
  history: 3,
  title: 3,
});
const HISTORY_ACTIONS = new Set([
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
  'create_note',
  'delete_note',
  'restore_note',
  'replace_note',
  'create_snapshot',
  'delete_snapshot',
  'restore_snapshot',
  'permanent_delete',
]);
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
let activeView = { type: 'category', value: 'all' }; // or { type: 'list', id: '...' }, { type: 'explore' }, { type: 'highlights-history' }, or { type: 'recycle-bin' }
let pendingShellRoute = window.__BR_STATE__?.route || null;
let applyingShellRoute = false;
let shellReady = false;
let allListPins = {}; // listId -> [{ url, title, pinnedAt }]
let lastClickedRow = null; // for shift-click range select
const cardDataByUrl = new Map(); // url → { attDetail, timestamps } for detail overlay
const listNameById = new Map(); // listId → display name, populated by renderLists()
let marqueeActive = false; // suppress click during marquee drag
let draggedSidebarListId = null;
let sidebarDragScrollFrame = 0;
let sidebarDragScrollVelocity = 0;
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
let searchDraftPreviewActive = false;
let searchDraftOutsideClickBound = false;
let pendingSearchClearScrollAnchor = null;
let filterState = createDefaultFilterState();
let filterVisible = false;
const SEARCH_INPUT_PLACEHOLDER = 'Search...';

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

// --- Search Module ---
/** Fetch a URL and extract body text (first BODY_WORD_LIMIT words). */
async function fetchPageBody(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) {
    throw new Error(`Page body request failed for ${url}: HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get('content-type');
  if (typeof contentType !== 'string' || !contentType) {
    throw new Error(`Page body response for ${url} has no content type`);
  }
  if (!contentType.includes('text/html')) {
    return '';
  }
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
}

// --- Progressive search ---
const searchState = {
  generation: 0,
  results: [],
  resultIndex: new Map(),
  pendingPhases: 0,
  loadingRenderCommitted: false,
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
    const payload = event?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('History search event payload must be an object');
    }
    if (payload.searchId !== searchId) return;
    if (payload.type === 'historySearchChunk') {
      if (gen !== searchState.generation) return;
      mergeSearchResults(
        buildDesktopHistoryResults(payload.results),
        'history',
        gen,
      );
      await renderFirstAvailableSearchResults(gen);
      return;
    }
    if (payload.type === 'historySearchDone') {
      const current = gen === searchState.generation;
      if (current && !payload.success && !payload.cancelled && payload.error) {
        surfaceBackgroundError(
          'History search failed',
          new Error(payload.error),
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
    Promise.resolve(unlisten?.()).catch((cleanupError) => {
      logError(
        '[options] Failed to stop history search listener:',
        cleanupError,
      );
    });
    throw error;
  }
}

function searchSourcePriority(source) {
  if (!Object.prototype.hasOwnProperty.call(SEARCH_SOURCE_PRIORITY, source)) {
    throw new Error(`Unknown search result source: ${String(source)}`);
  }
  return SEARCH_SOURCE_PRIORITY[source];
}

// Merge new results into searchState.results. Dedup by URL, take max score, track sources.
function mergeSearchResults(newResults, source, gen) {
  if (gen !== searchState.generation) return; // stale generation — discard
  if (!Array.isArray(newResults)) {
    throw new Error(`${source} search results must be an array`);
  }
  const nextSourcePriority = searchSourcePriority(source);
  for (const [resultIndex, r] of newResults.entries()) {
    if (
      !r ||
      typeof r.url !== 'string' ||
      !r.url ||
      !Number.isFinite(r.timestamp) ||
      !Number.isFinite(r.score)
    ) {
      throw new Error(
        `${source} search result ${resultIndex} has an invalid URL, timestamp, or score`,
      );
    }
    const idx = searchState.resultIndex.get(r.url);
    if (idx !== undefined) {
      const existing = searchState.results[idx];
      const existingPriority = existing.sourcePriority || 0;
      const nextScore = r.score || 0;
      const existingScore = existing.score || 0;
      const isVisitSource = source === 'history' || source === 'title';
      const existingHasVisitSource =
        existing.matchSources?.has('history') ||
        existing.matchSources?.has('title');
      if (isVisitSource) {
        const nextTimestamp = r.timestamp;
        const existingTimestamp = existingHasVisitSource
          ? existing.timestamp || 0
          : 0;
        if (
          !existingHasVisitSource ||
          nextScore > existingScore ||
          (nextScore === existingScore && nextTimestamp > existingTimestamp)
        ) {
          existing.score =
            nextSourcePriority > existingPriority
              ? nextScore
              : Math.max(nextScore, existingScore);
          existing.timestamp = nextTimestamp;
          existing.latestTs = nextTimestamp;
          if (typeof r.title === 'string') existing.title = r.title;
          existing.timestamps = Array.isArray(r.timestamps)
            ? r.timestamps
            : [nextTimestamp];
          delete existing._maxTs;
          delete existing._minTs;
        } else if (nextTimestamp > existingTimestamp) {
          existing.timestamp = nextTimestamp;
          existing.latestTs = nextTimestamp;
          if (!existing.title && r.title) existing.title = r.title;
          if (Array.isArray(r.timestamps)) {
            existing.timestamps = [
              ...new Set([...(existing.timestamps ?? []), ...r.timestamps]),
            ].sort((left, right) => right - left);
          }
          delete existing._maxTs;
          delete existing._minTs;
        }
      } else if (nextSourcePriority >= existingPriority) {
        const nextTimestamp = r.timestamp;
        const existingTimestamp = existing.timestamp || 0;
        const shouldPromote =
          nextSourcePriority > existingPriority ||
          nextScore > existingScore ||
          (nextScore === existingScore && nextTimestamp > existingTimestamp);
        if (shouldPromote) {
          existing.score = nextScore;
          if (Number.isFinite(nextTimestamp) && nextTimestamp > 0) {
            existing.timestamp = nextTimestamp;
            existing.latestTs = nextTimestamp;
            existing.timestamps = Array.isArray(r.timestamps)
              ? r.timestamps
              : [nextTimestamp];
          }
          delete existing._maxTs;
          delete existing._minTs;
        }
        if (!existing.title && r.title) existing.title = r.title;
      }
      if (
        r.createdAt &&
        (!existing.createdAt || r.createdAt < existing.createdAt)
      )
        existing.createdAt = r.createdAt;
      if (!existing.matchSources) existing.matchSources = new Set();
      existing.matchSources.add(source);
      existing.sourcePriority = Math.max(existingPriority, nextSourcePriority);
      if (r.deviceIds) {
        if (!existing.deviceIds) existing.deviceIds = new Set();
        for (const id of r.deviceIds) existing.deviceIds.add(id);
      }
    } else {
      const entry = {
        url: r.url,
        title: typeof r.title === 'string' ? r.title : '',
        user_title: r.user_title,
        slug: r.slug || generateSlugFromUrl(r.url),
        timestamp: r.timestamp,
        score: r.score,
        createdAt: r.createdAt ?? null,
        attScore: r.attScore ?? 0,
        attDetail: r.attDetail ?? null,
        notes: r.notes ?? [],
        timestamps: Array.isArray(r.timestamps) ? r.timestamps : [r.timestamp],
        latestTs: r.timestamp,
        deviceIds: r.deviceIds,
        sourcePriority: nextSourcePriority,
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
    if (gen !== searchState.generation) return;
    for (const r of unenriched) r._enriched = true;
  }
  // Apply filters
  let results = searchState.results;
  if (!isDefaultFilterState(filterState)) {
    results = applyFilters([...results]);
    if (gen !== searchState.generation) return;
  }

  if (preserveRelatedScrollOnNextRender && searchState.pendingPhases > 0) {
    return;
  }

  const effectiveSort = relatedSortState.column
    ? relatedSortState
    : { column: 'relevance', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  renderDirectSearchResults(sorted);
}

async function renderFirstAvailableSearchResults(gen) {
  if (
    gen !== searchState.generation ||
    searchState.loadingRenderCommitted ||
    searchState.results.length === 0
  ) {
    return;
  }
  searchState.loadingRenderCommitted = true;
  await renderProgressiveResults(gen);
}

const searchMotionPreference = window.matchMedia(
  '(prefers-reduced-motion: reduce)',
);

function syncSearchSpinnerGeometry() {
  const spinner = document.getElementById('contentSearchSpinner');
  const path = spinner?.querySelector('rect');
  const control = spinner?.closest('.search-draft-control');
  if (!spinner || !path || !control) return;
  const { width, height } = control.getBoundingClientRect();
  if (width <= 0 || height <= 0) return;
  const svgWidth = width + 4;
  const svgHeight = height + 4;
  const pathWidth = svgWidth - 2;
  const pathHeight = svgHeight - 2;
  spinner.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  path.setAttribute('width', String(pathWidth));
  path.setAttribute('height', String(pathHeight));
  path.setAttribute('rx', String(pathHeight / 2));
  const perimeter = 2 * (pathWidth - pathHeight) + Math.PI * pathHeight;
  const segment = Math.min(48, perimeter * 0.12);
  path.setAttribute('stroke-dasharray', `${segment} ${perimeter - segment}`);
  path.getAnimations().forEach((animation) => animation.cancel());
  if (
    document.documentElement.dataset.searching === 'true' &&
    !searchMotionPreference.matches
  ) {
    path.animate(
      [{ strokeDashoffset: '0px' }, { strokeDashoffset: `${-perimeter}px` }],
      {
        duration: 1200,
        iterations: Infinity,
        easing: 'linear',
      },
    );
  }
}

function showSearchSpinner() {
  document.documentElement.dataset.searching = 'true';
  syncSearchSpinnerGeometry();
}
function hideSearchSpinner() {
  delete document.documentElement.dataset.searching;
  document
    .querySelectorAll('#contentSearchSpinner rect')
    .forEach((path) =>
      path.getAnimations().forEach((animation) => animation.cancel()),
    );
}

window.addEventListener('resize', syncSearchSpinnerGeometry);
searchMotionPreference.addEventListener('change', syncSearchSpinnerGeometry);

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

function clearProgressiveSearchState() {
  searchState.generation++;
  searchState.results = [];
  searchState.resultIndex.clear();
  searchState.pendingPhases = 0;
  searchState.loadingRenderCommitted = false;
  hideSearchSpinner();
}

function isActiveCategoryView(category) {
  return activeView.type === 'category' && activeView.value === category;
}

function isActiveExploreView() {
  return activeView.type === 'explore';
}

function markShellReady() {
  if (shellReady) return;
  shellReady = true;
  document.body.dataset.shellReady = 'true';
  void applyPendingShellRoute();
}

function markAppReady() {
  document.body.dataset.ready = 'true';
}

function shouldPreserveCommittedSearchOnVisibilityRefresh() {
  return activeView.type === 'explore' && Boolean(committedSearchQuery.trim());
}

function buildDesktopHistoryResults(results) {
  if (!Array.isArray(results)) {
    throw new Error('History search results must be an array');
  }
  return results.map((result, index) => {
    if (
      !result ||
      typeof result.url !== 'string' ||
      !result.url ||
      (result.title !== null && typeof result.title !== 'string') ||
      !Number.isFinite(result.timestamp) ||
      !Number.isFinite(result.score)
    ) {
      throw new Error(`History search result ${index} has an invalid shape`);
    }
    return {
      url: result.url,
      title: result.title,
      slug: generateSlugFromUrl(result.url),
      timestamp: result.timestamp,
      score: result.score,
      timestamps: [result.timestamp],
    };
  });
}

function latestTimestampFromPage(page) {
  if (
    !page ||
    typeof page !== 'object' ||
    !page.timestamps ||
    typeof page.timestamps !== 'object' ||
    Array.isArray(page.timestamps)
  ) {
    throw new Error('Page search context is missing canonical timestamps');
  }
  const timestamps = Object.values(page.timestamps);
  if (timestamps.length > 0) return Math.max(...timestamps);

  return page.createdAt;
}

async function buildNoteSearchResults(results) {
  if (!Array.isArray(results)) {
    throw new Error('Note search results must be an array');
  }
  for (const [index, result] of results.entries()) {
    if (
      !result ||
      typeof result.url !== 'string' ||
      !result.url ||
      typeof result.noteSlug !== 'string' ||
      !result.noteSlug ||
      !Number.isFinite(result.score)
    ) {
      throw new Error(`Note search result ${index} has an invalid shape`);
    }
  }
  if (results.length === 0) return [];
  const slugs = results.map((result) => generateSlugFromUrl(result.url));
  const contexts = await loadPageContext(slugs);
  const built = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const page = contexts[slugs[i]]?.page;
    if (!page) {
      throw new Error(`Note search result references missing page ${slugs[i]}`);
    }
    const timestamp = latestTimestampFromPage(page);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error(
        `Note search page ${slugs[i]} has no canonical timestamp`,
      );
    }
    built.push({
      url: result.url,
      title: page?.user_title || page?.title || '',
      slug: generateSlugFromUrl(result.url),
      timestamp,
      score: result.score,
      timestamps: [timestamp],
    });
  }
  return built;
}

async function buildSnapshotSearchResults(matches) {
  if (!Array.isArray(matches)) {
    throw new Error('Snapshot search results must be an array');
  }
  for (const [index, match] of matches.entries()) {
    if (
      !match ||
      typeof match.slug !== 'string' ||
      !match.slug ||
      !Number.isFinite(match.timestamp) ||
      !Number.isFinite(match.score)
    ) {
      throw new Error(`Snapshot search result ${index} has an invalid shape`);
    }
  }
  if (matches.length === 0) return [];
  const contexts = await loadPageContext(matches.map((match) => match.slug));
  const results = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const page = contexts[match.slug]?.page;
    if (!page?.url) {
      throw new Error(
        `Snapshot search result references missing page ${match.slug}`,
      );
    }
    results.push({
      url: page.url,
      title: page.title || '',
      slug: match.slug,
      timestamp: match.timestamp,
      score: match.score,
      timestamps: [match.timestamp],
    });
  }
  return results;
}

// Phase 1: daemon-backed history search.
async function runPhase1(query, gen) {
  let streamingStarted = false;
  try {
    streamingStarted = await runStreamingHistorySearch(query, gen);
    if (streamingStarted) return;
  } catch (error) {
    surfaceBackgroundError('History search failed', error);
  } finally {
    if (!streamingStarted) phaseComplete(gen);
  }
}

async function runDaemonContentSearch({
  query,
  gen,
  action,
  buildResults,
  source,
  phaseLabel,
}) {
  try {
    const response = await sendAction({ action, query });
    if (!Array.isArray(response.results)) {
      throw new Error(`${action} response results must be an array`);
    }
    const results = await buildResults(response.results);
    mergeSearchResults(results, source, gen);
    await renderFirstAvailableSearchResults(gen);
  } catch (error) {
    surfaceBackgroundError(`${phaseLabel} failed`, error);
  } finally {
    phaseComplete(gen);
  }
}

// Phase 2a: note search.
async function runPhase2a(query, gen) {
  return runDaemonContentSearch({
    query,
    gen,
    action: 'searchNotes',
    buildResults: buildNoteSearchResults,
    source: 'note',
    phaseLabel: '[Phase2a] Desktop note search',
  });
}

// Phase 2b: snapshot search.
async function runPhase2b(query, gen) {
  return runDaemonContentSearch({
    query,
    gen,
    action: 'searchSnapshots',
    buildResults: buildSnapshotSearchResults,
    source: 'snapshot',
    phaseLabel: '[Phase2b] Desktop snapshot search',
  });
}

// Lightweight identity scorer for Phase 0 using the shared search-runtime matcher.
function phase0Score(item, words) {
  return scoreSearchFields(words, [
    { text: item.title, weight: 2.0 },
    { text: item.user_title, weight: 2.0 },
    { text: item.url, weight: URL_SEARCH_SCORE },
  ]);
}

async function mergeHistoryMutationsIntoActiveSearch(entries) {
  const query = committedSearchQuery.trim();
  if (
    activeView.type !== 'explore' ||
    !query ||
    !Array.isArray(entries) ||
    entries.length === 0
  ) {
    return false;
  }

  const gen = searchState.generation;
  const words = parseSearchQueryWords(query);
  const matchingEntries = new Map();
  const removedTitleMatches = new Set();
  let changed = false;

  for (const entry of entries) {
    if (!entry?.url || !Number.isFinite(entry.timestamp)) continue;
    const existingIndex = searchState.resultIndex.get(entry.url);
    const isVisitObservation =
      entry.action === 'visit_page' || entry.action === 'leave_page';
    if (existingIndex !== undefined) {
      const existing = searchState.results[existingIndex];
      if (isVisitObservation && entry.timestamp > (existing.timestamp || 0)) {
        existing.timestamp = entry.timestamp;
        existing.latestTs = entry.timestamp;
        existing.timestamps = [
          ...new Set([entry.timestamp, ...(existing.timestamps || [])]),
        ].sort((left, right) => right - left);
        if (entry.title) existing.title = entry.title;
        if (entry.user_title) existing.user_title = entry.user_title;
        delete existing._maxTs;
        delete existing._minTs;
        changed = true;
      }
      if (entry.action === 'rename_page') {
        existing.user_title = entry.user_title;
        changed = true;
      }
      if (entry.deviceId) {
        if (!existing.deviceIds) existing.deviceIds = new Set();
        existing.deviceIds.add(entry.deviceId);
      }
      delete existing._enriched;
      delete existing.visitCount;
    }

    const latestVisit = historyState.byUrl.get(entry.url);
    const existingResult =
      existingIndex === undefined ? null : searchState.results[existingIndex];
    const candidate = latestVisit
      ? { ...latestVisit }
      : existingResult
        ? { ...existingResult }
        : null;
    if (candidate && entry.action === 'rename_page') {
      candidate.user_title = entry.user_title;
    }
    if (candidate && isVisitObservation && entry.title) {
      candidate.title = entry.title;
    }
    const score = candidate ? phase0Score(candidate, words) : null;
    if (score != null && Number.isFinite(candidate.timestamp)) {
      removedTitleMatches.delete(entry.url);
      matchingEntries.set(entry.url, { ...candidate, score });
    } else {
      matchingEntries.delete(entry.url);
      if (existingResult?.matchSources?.has('title')) {
        existingResult.matchSources.delete('title');
        if (existingResult.matchSources.size === 0) {
          removedTitleMatches.add(entry.url);
        }
        changed = true;
      }
    }
  }

  if (removedTitleMatches.size > 0) {
    searchState.results = searchState.results.filter(
      (result) => !removedTitleMatches.has(result.url),
    );
    searchState.resultIndex.clear();
    searchState.results.forEach((result, index) => {
      searchState.resultIndex.set(result.url, index);
    });
  }

  const matchingResults = processHistoryForDisplay(
    [...matchingEntries.values()],
    {
      globalDedup: true,
    },
  ).map((item) => ({
    ...item,
    matchSources: new Set(['title']),
  }));
  if (matchingResults.length > 0) {
    mergeSearchResults(matchingResults, 'title', gen);
    changed = true;
  }

  if (changed) {
    preserveRelatedScrollOnNextRender = true;
    await renderProgressiveResults(gen);
  }
  return true;
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
  searchState.loadingRenderCommitted = false;
  showSearchSpinner();
  const query = allQueries.join(' ');

  // Phase 0: instant shared-runtime matching over already-loaded rows.
  const phase0Words = parseSearchQueryWords(query);
  const phase0Entries = historyState.allEntries
    .map((item) => {
      if (!item.url) return null;
      const score = phase0Score(item, phase0Words);
      return score == null ? null : { ...item, score };
    })
    .filter(Boolean);
  const phase0Results = processHistoryForDisplay(phase0Entries, {
    globalDedup: true,
  }).map((item) => ({
    ...item,
    matchSources: new Set(['title']),
  }));
  mergeSearchResults(phase0Results, 'title', gen);
  await renderProgressiveResults(gen);
  searchState.loadingRenderCommitted = phase0Results.length > 0;

  // Fire Phase 1, 2a, 2b concurrently (with per-type concurrency limits)
  runPhase1(query, gen);
  runPhase2a(query, gen);
  runPhase2b(query, gen);
}

// --- Demand-loaded history ---

async function initHistoryFiles() {
  await refreshHistoryMetadata();
}

async function refreshHistoryMetadata() {
  const resp = await sendAction({
    action: 'listHistoryFiles',
    includeSizes: true,
  });
  if (!Array.isArray(resp.files) || !Array.isArray(resp.devices)) {
    throw new Error('History file response files and devices must be arrays');
  }
  if (
    !resp.sizes ||
    typeof resp.sizes !== 'object' ||
    Array.isArray(resp.sizes)
  ) {
    throw new Error('History file response sizes must be an object');
  }
  historyState.files = resp.files;
  historyState.fileSizes = resp.sizes;
  historyState.devices = resp.devices;
  return resp;
}

async function loadHistoryEntriesForDate(dateStr) {
  const resp = await sendAction({
    action: 'loadHistoryBatch',
    files: [`${dateStr}.jsonl`],
  });
  return validateHistoryEntries(resp.entries);
}

function validateHistoryEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('History batch response entries must be an array');
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`History entry ${index} must be an object`);
    }
    if (!HISTORY_ACTIONS.has(entry.action)) {
      throw new Error(
        `History entry ${index} has unsupported action ${String(entry.action)}`,
      );
    }
    if (!Number.isFinite(entry.timestamp)) {
      throw new Error(`History entry ${index} has no finite timestamp`);
    }
    if (typeof entry.deviceId !== 'string' || !entry.deviceId) {
      throw new Error(`History entry ${index} has no deviceId`);
    }
    if (entry.action === 'visit_page' || entry.action === 'leave_page') {
      if (typeof entry.url !== 'string' || !entry.url) {
        throw new Error(`History entry ${index} has no URL`);
      }
      if (entry.title !== null && typeof entry.title !== 'string') {
        throw new Error(
          `History entry ${index} title must be a string or null`,
        );
      }
    }
    return entry;
  });
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
    const batchEntries = validateHistoryEntries(resp.entries);
    const newItems = [];
    // Entries arrive oldest→newest. History rows consume only canonical page
    // visit/leave records; other replay actions remain available to callers
    // that explicitly request a raw history batch.
    for (const item of batchEntries) {
      if (item.action !== 'visit_page' && item.action !== 'leave_page')
        continue;
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
    // Calibrate avg entry size from loaded file data
    historyState.batchRawCount += batchEntries.length;
    const loadedSize = [...historyState.loadedFiles].reduce((sum, file) => {
      if (!Object.prototype.hasOwnProperty.call(historyState.fileSizes, file)) {
        throw new Error(`History file response is missing size for ${file}`);
      }
      return sum + historyState.fileSizes[file];
    }, 0);
    if (loadedSize > 0 && historyState.batchRawCount > 0) {
      historyState.avgEntrySize = loadedSize / historyState.batchRawCount;
    }
    historyState.loading = false;
    return newItems;
  } catch (error) {
    historyState.loading = false;
    showErrorBubble(
      tr('desktopErrorPrefix', `Error loading history: ${error.message}`, [
        error.message,
      ]),
      { suffix: '' },
    );
    throw error;
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
  try {
    await loadHistoryBatch();
  } finally {
    historyState.fileBatch = saved;
  }
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
  allListPins = {};

  cancelActiveHistorySearch();
  clearProgressiveSearchState();
}

// Estimate visit counts for unloaded JSONL files from file sizes.
// Returns Map<dateStr, estimatedCount> for dates not yet loaded.
function getEstimatedByDay() {
  const estimated = new Map();
  for (const filename of historyState.files) {
    if (historyState.loadedFiles.has(filename)) continue;
    const dateStr = filename.replace('.jsonl', '');
    if (
      !Object.prototype.hasOwnProperty.call(historyState.fileSizes, filename)
    ) {
      throw new Error(`History file response is missing size for ${filename}`);
    }
    const size = historyState.fileSizes[filename];
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

// Returns { pinsResolved, pageSnap } — pageSnap is needed by enrichPinResult.
async function resolvePinsForDisplay(pins) {
  const pageSnap = new Map(
    pins
      .filter((pin) => pin.kind === 'page')
      .map((pin) => [pin.slug, { ...pin, user_title: pin.userTitle || null }]),
  );
  const pinsResolved = pins.map((p) => {
    const title = p.title || null;
    const url = p.url || null;
    return {
      ...p,
      url,
      title,
      user_title: p.userTitle || null,
      isNote: p.isNote,
      hasSnapshots: p.hasSnapshots === true,
      hasHighlightNotes: p.hasHighlightNotes === true,
      listSlugs: p.listSlugs,
    };
  });
  return { pinsResolved, pageSnap };
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
  destroyHighlightHistoryJustification();
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
  destroyHighlightHistoryJustification();
  document.getElementById('resultsWrapper').style.display = '';
  document.getElementById('listLayout').classList.remove('visible');
  document.getElementById('recycleBinLayout').classList.remove('visible');
  document.getElementById('inboxToggleBtn').style.display = 'none';
  document.getElementById('inboxPanel').style.display = 'none';
  document.getElementById('inboxToggleBtn').classList.remove('active');
}

function showRecycleBinLayout() {
  destroyHighlightHistoryJustification();
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

async function loadRecycleBinEntries() {
  return loadRecycleBin();
}

async function showRecycleBin() {
  bindRecycleBinEmptyButton();
  const renderSeq = ++recycleBinRenderSeq;
  activeView = { type: 'recycle-bin' };
  updateSidebarActive();
  updateMainTitle(tr('desktopRecycleBin', 'Recycle Bin'));
  showRecycleBinLayout();

  const itemsEl = document.getElementById('recycleBinItems');
  const emptyEl = document.getElementById('recycleBinEmpty');
  const headerEl = document.querySelector('.recycle-bin-header');

  let entries = [];
  try {
    entries = await loadRecycleBinEntries();
  } catch (error) {
    showErrorBubble(
      tr(
        'desktopRecycleBinLoadFailed',
        `Failed to load recycle bin: ${error.message}`,
        [error.message],
      ),
      { suffix: '' },
    );
    return;
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

  for (const entry of entries) {
    const { key } = entry;
    const typeLabel = entityTypeLabel(key);
    const typeCls = 'type-' + typeLabel.toLowerCase();
    let displayName = entry.title || entry.url || entry.slug || key;
    if (entry.kind === 'snapshot' && entry.timestamp) {
      displayName = `${displayName} — ${new Date(entry.timestamp).toLocaleString()}`;
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
      <button class="restore-btn">${escapeHtml(tr('desktopRestore', 'Restore'))}</button>
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
        await refreshRecycleBinUi({ render: true });
      } catch (error) {
        button.disabled = false;
        showErrorBubble(
          tr(
            'desktopRestoreFailed',
            `Failed to restore item: ${error.message}`,
            [error.message],
          ),
          { suffix: '' },
        );
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
      await refreshRecycleBinUi();
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
  let entries;
  try {
    entries = await loadRecycleBinEntries();
  } catch (error) {
    surfaceBackgroundError('Recycle bin badge refresh failed', error);
    return;
  }
  if (badgeSeq !== recycleBinBadgeSeq) return;
  const count = entries.length;
  const btn = document.getElementById('recycleBinBtn');
  const badge = document.getElementById('recycleBinCount');
  badge.textContent = count > 0 ? String(count) : '';
  btn.style.display = count > 0 ? 'flex' : 'none';
}

async function refreshRecycleBinUi({ render = null } = {}) {
  await updateRecycleBinBadge();
  const shouldRender =
    render === null ? activeView.type === 'recycle-bin' : render;
  if (shouldRender) await showRecycleBin();
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
    devices: {}, // { deviceId: true } — only stores enabled devices; empty = show all
    hasHighlights: null, // null=any, true=require
    hasSnapshots: null,
    liked: null,
    visitedMultipleTimes: null,
  };
}

function validateFilterState(state, key) {
  const expectedKeys = [
    'devices',
    'hasHighlights',
    'hasSnapshots',
    'liked',
    'visitedMultipleTimes',
  ];
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    Object.keys(state).length !== expectedKeys.length ||
    expectedKeys.some(
      (field) => !Object.prototype.hasOwnProperty.call(state, field),
    )
  ) {
    throw new Error(`Stored filter state ${key} has an invalid shape`);
  }
  const devices = state.devices;
  if (
    !devices ||
    typeof devices !== 'object' ||
    Array.isArray(devices) ||
    Object.values(devices).some((value) => value !== true)
  ) {
    throw new Error(`Stored filter state ${key}.devices is invalid`);
  }
  for (const booleanKey of [
    'hasHighlights',
    'hasSnapshots',
    'liked',
    'visitedMultipleTimes',
  ]) {
    if (state[booleanKey] !== null && state[booleanKey] !== true) {
      throw new Error(`Stored filter state ${key}.${booleanKey} is invalid`);
    }
  }
  return state;
}

function isDefaultFilterState(state) {
  return (
    Object.keys(state.devices).length === 0 &&
    state.hasHighlights === null &&
    state.hasSnapshots === null &&
    state.liked === null &&
    state.visitedMultipleTimes === null
  );
}

function applyFilters(results) {
  if (isDefaultFilterState(filterState)) return results;
  const enabledDevices = Object.keys(filterState.devices);
  return results.filter((item) => {
    // Device filter: when bubbles are active, only show items from at least one enabled device
    if (enabledDevices.length > 0) {
      if (!item.deviceIds || !enabledDevices.some((d) => item.deviceIds.has(d)))
        return false;
    }
    // Page-specific booleans
    if (filterState.hasHighlights === true) {
      if (item.hasHighlightNotes !== true) return false;
    }
    if (filterState.hasSnapshots === true) {
      if (!item.hasSnapshots) return false;
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
  void chrome.storage.session.set({ [key]: filterState }).catch((error) => {
    surfaceBackgroundError('Filter state save failed', error);
  });
}

async function loadFilterState() {
  const key =
    activeView.type === 'explore'
      ? 'exploreFilterState'
      : 'listFilterState:' + activeView.id;
  const data = await chrome.storage.session.get(key);
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    filterState = validateFilterState(data[key], key);
    return;
  }
  filterState = createDefaultFilterState();
  await chrome.storage.session.set({ [key]: filterState });
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

const COLUMN_LABEL_KEYS = {
  title: ['desktopColumnTitle', 'Title'],
  relevance: ['desktopColumnRelevance', 'Rel'],
  lastVisit: ['desktopColumnLastVisit', 'Last Visit'],
  firstVisit: ['desktopColumnFirstVisit', 'First Visit'],
  attention: ['desktopColumnAttention', 'Att'],
  pinTime: ['desktopColumnPinTime', 'Pin Time'],
};

function columnLabel(column) {
  const label = COLUMN_LABEL_KEYS[column];
  if (!label) throw new Error(`Unknown result column: ${column}`);
  return tr(...label);
}

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
        av = a.sourcePriority || 0;
        bv = b.sourcePriority || 0;
        if (av !== bv) return dir * (av - bv);
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
  html += `<div class="col-header col-title${activeClass('title')}" data-col="title">${escapeHtml(columnLabel('title'))}${arrow('title')}</div>`;

  if (showRelevance) {
    html += `<div class="col-header col-rel${activeClass('relevance')}" data-col="relevance">${escapeHtml(columnLabel('relevance'))}${arrow('relevance')}</div>`;
  }

  html += `<div class="col-header col-time${activeClass('lastVisit')}" data-col="lastVisit">${escapeHtml(columnLabel('lastVisit'))}${arrow('lastVisit')}</div>`;

  if (extraCols.includes('firstVisit')) {
    html += `<div class="col-header col-time${activeClass('firstVisit')}" data-col="firstVisit">${escapeHtml(columnLabel('firstVisit'))}${arrow('firstVisit')}</div>`;
  }

  html += `<div class="col-header col-att${activeClass('attention')}" data-col="attention">${escapeHtml(columnLabel('attention'))}${arrow('attention')}</div>`;

  if (extraCols.includes('pinTime')) {
    html += `<div class="col-header col-time${activeClass('pinTime')}" data-col="pinTime">${escapeHtml(columnLabel('pinTime'))}${arrow('pinTime')}</div>`;
  }

  const availableExtras = getAvailableExtras(context);
  if (availableExtras.length > 0) {
    html += `<button class="col-add-btn" data-context="${context}" title="${escapeHtml(tr('desktopAddColumns', 'Add columns'))}">+</button>`;
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
    label.appendChild(document.createTextNode(` ${columnLabel(col)}`));
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
  } else if (isHighlightHistoryView()) {
    showHighlightsHistory();
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
  if (!isActiveCategoryView(category)) return;
  await loadHistoryBatch();
  if (!isActiveCategoryView(category)) return;
  const allEntries = [...historyState.allEntries];
  allEntries.sort((a, b) => b.timestamp - a.timestamp);
  const filtered = filterByCategory(allEntries, category);
  const estimatedByDay = category === 'all' ? getEstimatedByDay() : undefined;
  renderTimeChart(filtered, estimatedByDay);
  await displayHistoryRows(filtered);
  if (!isActiveCategoryView(category)) return;

  // Wire up demand-loading on scroll
  const vs = getOrCreateGlobalScroller();
  vs.onLoadMore = async () => {
    const newItems = await loadHistoryBatch();
    if (!isActiveCategoryView(category)) return;
    if (newItems.length > 0) {
      const newFiltered = filterByCategory(newItems, category);
      if (newFiltered.length > 0) {
        const sort = currentSortState.column
          ? currentSortState
          : { column: 'lastVisit', direction: 'desc' };
        const newEntries = processHistoryForDisplay(newFiltered);
        vs.appendData(applySortOrder(newEntries, sort));
        // Enrich in background — re-render visible rows when done
        enrichFromEntityStorage(newEntries, { includeVisitDates: false }).then(
          () => {
            if (isActiveCategoryView(category)) vs.refreshVisible();
          },
        );
      }
      // Re-render chart with all loaded history + updated estimates
      const allLoaded = [...historyState.allEntries];
      const allFiltered = filterByCategory(allLoaded, category);
      const updatedEstimates =
        category === 'all' ? getEstimatedByDay() : undefined;
      renderTimeChart(allFiltered, updatedEstimates);
    }
  };
}

const HIGHLIGHT_HISTORY_VIEW_TYPE = 'highlights-history';
const HIGHLIGHT_HISTORY_BATCH_SIZE = 100;
const HIGHLIGHT_HISTORY_LIST_SELECTOR =
  '#results > .highlight-history-list.detail-notes-section';
const HIGHLIGHT_HISTORY_TEXT_SELECTOR =
  '.highlight-history-entry .detail-note-excerpt, .highlight-history-entry .detail-note-content';
const highlightHistoryState = {
  renderSequence: 0,
  items: [],
  renderedCount: 0,
  seenNoteSlugs: new Set(),
  justificationControllers: new Map(),
};

function isHighlightHistoryView() {
  return activeView.type === HIGHLIGHT_HISTORY_VIEW_TYPE;
}

function isCurrentHighlightHistoryRender(renderSequence) {
  return (
    isHighlightHistoryView() &&
    renderSequence === highlightHistoryState.renderSequence
  );
}

function highlightHistoryTextElements(container) {
  if (container.matches?.(HIGHLIGHT_HISTORY_TEXT_SELECTOR)) return [container];
  return container.querySelectorAll(HIGHLIGHT_HISTORY_TEXT_SELECTOR);
}

function destroyHighlightHistoryJustification(
  elements = highlightHistoryState.justificationControllers.keys(),
) {
  const targets = [...elements];
  for (const element of targets) {
    const controller =
      highlightHistoryState.justificationControllers.get(element);
    if (!controller) continue;
    controller.destroy();
    highlightHistoryState.justificationControllers.delete(element);
  }
}

function applyHighlightHistoryJustification(container) {
  for (const paragraph of highlightHistoryTextElements(container)) {
    destroyHighlightHistoryJustification([paragraph]);
    const options = {
      hyphenate: hyphenateEnUS,
      hangingPunctuation: 'all-lines',
      lastLineMinWidth: 0.5,
      onSkip: (_skippedParagraph, reason) => {
        logDebug('Highlight history text kept native layout:', reason);
      },
    };
    if (paragraph.matches('.detail-note-content')) {
      options.pretolerance = -1;
    }
    const controller = justify(paragraph, options);
    highlightHistoryState.justificationControllers.set(paragraph, controller);
    controller.ready.catch((error) => {
      logError('Failed to finish highlight history text layout', error);
    });
  }
}

function highlightHistoryTextHtml(text) {
  return escapeHtml(text).replace(/\r\n?|\n/g, '<br>\n');
}

function detailNoteContentHtml(noteText, formatText = escapeHtml) {
  if (!noteText) return '';
  return `<span class="detail-note-content">${formatText(noteText)}</span>`;
}

function disableGlobalVirtualScrollerForDirectRender() {
  const container = document.getElementById('results');
  if (container._virtualScroller) {
    container._virtualScroller.destroy();
  }
  globalVirtualScroller = null;
  container.style.paddingTop = '0px';
  container.style.paddingBottom = '';
}

function highlightHistoryPageMetaHtml(item) {
  const { page, createdAt } = item;
  const url = new URL(page.url);
  const site =
    url.protocol === 'file:' ? 'file' : url.hostname.replace(/^www\./, '');
  const title = page.user_title || page.title || page.url;
  return `<div class="highlight-history-meta">
    <span class="highlight-history-page-title" data-url="${escapeHtml(page.url)}" role="link" tabindex="0"><span class="highlight-history-page-title-label">${escapeHtml(title)}</span></span>
    <span class="highlight-history-site">${escapeHtml(site)}</span>
    <span class="highlight-history-time">${escapeHtml(formatTime(createdAt))}</span>
  </div>`;
}

function highlightHistoryEntryHtml(item) {
  const { note } = item;
  const excerpt = formatHighlightExcerpt(note.excerpt);
  const noteBody = detailNoteContentHtml(note.note, highlightHistoryTextHtml);
  const contentClass = note.note
    ? 'highlight-history-content has-note'
    : 'highlight-history-content';
  return `<article class="highlight-history-entry detail-note-entry" data-note-slug="${escapeHtml(note.slug)}">
    <div class="${contentClass}">
      <div class="highlight-history-quote">
        <div class="detail-note-header">
          <div class="detail-note-excerpt">${highlightHistoryTextHtml(excerpt)}</div>
          <button class="detail-note-action-btn delete" title="${escapeHtml(tr('extensionDeleteHighlight', 'Delete highlight'))}">${DETAIL_ICON_DELETE}</button>
        </div>
      </div>
      <div class="detail-note-body">
        ${noteBody}
        <button class="detail-note-action-btn edit" title="${escapeHtml(tr('extensionEditNote', 'Edit note'))}">${DETAIL_ICON_EDIT}</button>
      </div>
    </div>
  </article>`;
}

function formatHighlightHistoryDate(timestamp) {
  const date = new Date(timestamp);
  return [
    String(date.getFullYear()).slice(-2),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('');
}

function appendHighlightHistoryDay(list, dateLabel) {
  list.insertAdjacentHTML(
    'beforeend',
    `<section class="highlight-history-day-section" data-highlight-history-date="${dateLabel}">
      <h2 class="highlight-history-date"><span class="highlight-history-date-label">${dateLabel}</span></h2>
      <div class="highlight-history-day-entries"></div>
    </section>`,
  );
  return list.lastElementChild;
}

function getHighlightHistoryDay(list, dateLabel) {
  const currentDay = list.lastElementChild;
  return currentDay?.dataset.highlightHistoryDate === dateLabel
    ? currentDay
    : appendHighlightHistoryDay(list, dateLabel);
}

function appendHighlightHistoryPageGroup(dayEntries, item) {
  dayEntries.insertAdjacentHTML(
    'beforeend',
    `<section class="highlight-history-page-group" data-highlight-history-page-url="${escapeHtml(item.page.url)}">
      ${highlightHistoryPageMetaHtml(item)}
      <div class="highlight-history-page-entries"></div>
    </section>`,
  );
  return dayEntries.lastElementChild;
}

function getHighlightHistoryPageGroup(daySection, item) {
  const dayEntries = daySection.querySelector('.highlight-history-day-entries');
  const existingGroup = [...dayEntries.children].find(
    (group) => group.dataset.highlightHistoryPageUrl === item.page.url,
  );
  return existingGroup || appendHighlightHistoryPageGroup(dayEntries, item);
}

function appendHighlightHistoryItems(list, items) {
  const entries = [];
  const pageGroups = new Set();
  for (const item of items) {
    const dateLabel = formatHighlightHistoryDate(item.createdAt);
    const daySection = getHighlightHistoryDay(list, dateLabel);
    const pageGroup = getHighlightHistoryPageGroup(daySection, item);
    const pageEntries = pageGroup.querySelector(
      '.highlight-history-page-entries',
    );
    pageEntries.insertAdjacentHTML(
      'beforeend',
      highlightHistoryEntryHtml(item),
    );
    entries.push(pageEntries.lastElementChild);
    pageGroups.add(pageGroup);
  }
  return { entries, pageGroups };
}

function renderHighlightHistoryEmptyState(container) {
  container.innerHTML = `<div class="no-results">${escapeHtml(tr('desktopNoResults', 'No results'))}</div>`;
}

function acceptHighlightHistoryPage(highlights) {
  const previous = highlightHistoryState.items.at(-1);
  let previousCreatedAt = previous?.createdAt ?? Number.POSITIVE_INFINITY;
  for (const [index, item] of highlights.entries()) {
    if (
      highlightHistoryState.seenNoteSlugs.has(item.note.slug) ||
      item.createdAt > previousCreatedAt
    ) {
      throw new Error(
        `getHighlightHistoryPage response item ${index} breaks cross-page identity or ordering`,
      );
    }
    highlightHistoryState.seenNoteSlugs.add(item.note.slug);
    previousCreatedAt = item.createdAt;
  }
  highlightHistoryState.items.push(...highlights);
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function renderNextHighlightHistoryBatch(
  batchSize = HIGHLIGHT_HISTORY_BATCH_SIZE,
) {
  if (!isHighlightHistoryView()) return;
  const list = document.querySelector(HIGHLIGHT_HISTORY_LIST_SELECTOR);
  if (
    !list ||
    highlightHistoryState.renderedCount >= highlightHistoryState.items.length
  ) {
    return;
  }
  const nextCount = Math.min(
    highlightHistoryState.renderedCount + batchSize,
    highlightHistoryState.items.length,
  );
  const appended = appendHighlightHistoryItems(
    list,
    highlightHistoryState.items.slice(
      highlightHistoryState.renderedCount,
      nextCount,
    ),
  );
  highlightHistoryState.renderedCount = nextCount;
  // Keep incremental rendering incremental: rebuilding earlier Justif DOM
  // makes batching quadratic and can invalidate an active text selection.
  for (const entry of appended.entries) {
    bindNoteDeleteButtons(entry);
    applyHighlightHistoryJustification(entry);
  }
  for (const pageGroup of appended.pageGroups) {
    bindHighlightHistoryPageTitles(pageGroup);
  }
}

function removeHighlightHistoryItem(noteSlug) {
  const index = highlightHistoryState.items.findIndex(
    (item) => item.note.slug === noteSlug,
  );
  if (index < 0) return;
  highlightHistoryState.items.splice(index, 1);
  if (index < highlightHistoryState.renderedCount) {
    highlightHistoryState.renderedCount -= 1;
  }
}

function updateHighlightHistoryItem(oldNoteSlug, newNoteSlug, noteText) {
  const item = highlightHistoryState.items.find(
    (candidate) => candidate.note.slug === oldNoteSlug,
  );
  if (!item) return;
  item.note.slug = newNoteSlug;
  item.note.note = noteText;
}

function activateHighlightsHistoryShell() {
  activeView = { type: HIGHLIGHT_HISTORY_VIEW_TYPE };
  updateSidebarActive();
  updateMainTitle(tr('desktopBook', 'Book'), 'desktopBook');
}

async function showHighlightsHistory({ activate = true } = {}) {
  const renderSequence = ++highlightHistoryState.renderSequence;
  if (activate) activateHighlightsHistoryShell();
  showNormalLayout();
  resetMainScroll();
  document.getElementById('queryBuilder').style.display = 'none';
  document.getElementById('timeChart').classList.remove('visible');
  disableGlobalVirtualScrollerForDirectRender();

  const container = document.getElementById('results');
  destroyHighlightHistoryJustification();
  container.innerHTML = '';
  highlightHistoryState.items = [];
  highlightHistoryState.renderedCount = 0;
  highlightHistoryState.seenNoteSlugs = new Set();
  container.innerHTML = `<div class="highlight-history-list detail-notes-section"><div class="highlight-history-loading no-results">${escapeHtml(tr('commonLoading', 'Loading...'))}</div></div>`;

  try {
    let cursor = null;
    do {
      const page = await loadHighlightHistoryPage(
        cursor,
        HIGHLIGHT_HISTORY_BATCH_SIZE,
      );
      if (!isCurrentHighlightHistoryRender(renderSequence)) return;
      document.querySelector('.highlight-history-loading')?.remove();
      acceptHighlightHistoryPage(page.highlights);
      renderNextHighlightHistoryBatch(page.highlights.length);
      cursor = page.nextCursor;
      if (cursor) await nextPaint();
    } while (cursor && isCurrentHighlightHistoryRender(renderSequence));

    if (
      isCurrentHighlightHistoryRender(renderSequence) &&
      highlightHistoryState.items.length === 0
    ) {
      renderHighlightHistoryEmptyState(container);
    }
  } catch (error) {
    if (!isCurrentHighlightHistoryRender(renderSequence)) return;
    surfaceBackgroundError('Failed to load highlight history', error);
    const message = `<div class="no-results">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div>`;
    if (highlightHistoryState.items.length === 0) container.innerHTML = message;
    else
      document
        .querySelector(HIGHLIGHT_HISTORY_LIST_SELECTOR)
        ?.insertAdjacentHTML('beforeend', message);
  }
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
  void chrome.storage.session
    .set({ [`searchQueries:${viewKey}`]: committedSearchQuery.trim() })
    .catch((error) =>
      surfaceBackgroundError('Could not save search state', error),
    );
}

// Load the committed search query from session storage for the current view
async function loadSearchQuery() {
  const viewKey =
    activeView.type === 'explore'
      ? 'explore'
      : activeView.type === 'list'
        ? listKey(activeView.id)
        : null;
  if (!viewKey) return '';
  const data = await chrome.storage.session.get(`searchQueries:${viewKey}`);
  const value = data[`searchQueries:${viewKey}`];
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new Error(`Stored search query for ${viewKey} must be a string`);
  }
  return value;
}

function committedQueryFromSession(value) {
  if (typeof value !== 'string') {
    throw new Error('Stored search query must be a string');
  }
  return value.trim();
}

// --- Query builder: Rendering ---

// Shared pin enrichment merges daemon page data, attention, and pin timestamps.
function enrichPinResult(r, pins, pageSnap) {
  if (!r.url && !r.slug) return r;
  const slug = r.slug || generateSlugFromUrl(r.url);
  const cached = pageSnap.get(slug);
  const source = cached && cached.watermark > (r.watermark || 0) ? cached : r;
  const attSource = source.attDetail || source;
  const attScore = attentionStrength(attSource) ?? source.attScore ?? 0;
  const rSlug = slug;
  const pin = pins.find((p) => p.slug === rSlug);
  const displayTimestamp = [source.watermark, r.watermark, r.pinnedAt].find(
    (timestamp) => Number.isFinite(timestamp),
  );
  const enriched = {
    ...r,
    slug,
    attScore,
    attDetail: attSource,
    notes: source.notes || r.notes || [],
    timestamps: displayTimestamp === undefined ? [] : [displayTimestamp],
    visitDates: cached?.visitDates || source.visitDates || r.visitDates,
    pinnedAt: pin ? pin.pinnedAt : r.pinnedAt || null,
    pinSource: pin?.source || r.pinSource || null,
  };
  if (source.user_title) enriched.user_title = source.user_title;
  return enriched;
}

// Summarize a query tree into a short display name for lists

function activateExploreShell() {
  activeView = { type: 'explore', name: null };
  updateSidebarActive();
  updateMainTitle(tr('desktopTimeline', 'Timeline'), 'desktopTimeline');
}

async function showExplore({
  hydrate = true,
  markReady = true,
  activate = true,
} = {}) {
  const _t0 = performance.now();
  const _timer = (label) =>
    logDebug(
      `[explore-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`,
    );

  if (activate) activateExploreShell();

  showListLayout();
  resetMainScroll();
  preserveRelatedScrollOnNextRender = false;
  resetRelatedScrollOnNextRender = true;
  renderListSkeleton();

  try {
    committedSearchQuery = committedQueryFromSession(await loadSearchQuery());
    draftSearchInput = committedSearchQuery;

    await loadFilterState();
    renderSearchPanel({ deferFilterPanel: true });
    markShellReady();
    _timer('renderSearchPanel');

    if (hydrate) {
      await hydrateExploreSearchResults();
      _timer('hydrateExploreSearchResults');
      if (markReady) markAppReady();
    }
  } catch (error) {
    logError('Explore load error:', error);
    document.getElementById('relatedResults').innerHTML =
      `<div class="no-results">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div>`;
    markShellReady();
    if (markReady) markAppReady();
  }
}

// Incremental refresh after pin toggle — preserves scroll position and search state.
async function refreshPins() {
  if (activeView.type === 'explore') {
    runSearchFilterPipeline();
  } else if (activeView.type === 'list') {
    const listId = activeView.id;
    if (!allListPins[listId]) {
      const projection = await loadListDisplay(listId);
      if (!projection) throw new Error(`List not found: ${listId}`);
      allListPins[listId] = projection.pins;
    }
    const pins = allListPins[listId];
    updatePinCount(listId, pins.length);
    if (pins.length === 0) {
      document.getElementById('relatedResults').innerHTML =
        `<div class="no-results">${escapeHtml(tr('desktopNoPinnedPages', 'No pinned pages'))}</div>`;
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

    const listProjection = await loadListDisplay(listId);
    if (!listProjection) throw new Error(`List not found: ${listId}`);
    allListPins[listId] = listProjection.pins;
    const pins = allListPins[listId];
    updatePinCount(listId, pins.length);

    // Render rules section
    renderRulesSection(listId, listProjection.rules);

    if (pins.length === 0) {
      listPinsData = [];
      listPinsListId = listId;
      renderSearchPanel();
      document.getElementById('relatedResults').innerHTML =
        `<div class="no-results">${escapeHtml(tr('desktopNoPinnedPages', 'No pinned pages'))}</div>`;
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
      `<div class="no-results">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div>`;
  }
}

// ─── Rules section ──────────────────────────────────────────────────

function ruleDescription(rule) {
  const c = rule.config;
  if (rule.type === 'keyword') {
    return c.pattern || '';
  } else if (rule.type === 'function') {
    return c.description || tr('desktopCustomFunction', '(custom function)');
  }
  return rule.type || tr('desktopUnknown', 'unknown');
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
  const typeLabel = (type) => {
    if (type === 'keyword') return tr('desktopKeyword', 'Keyword');
    if (type === 'function') return tr('desktopFunction', 'Function');
    return type;
  };
  container.innerHTML = rules
    .map((rule) => {
      return `<div class="rule-entry" data-rule-id="${escapeHtml(rule.id)}">
      <div class="rule-header">
        <span class="rule-type-badge rule-type-${escapeHtml(rule.type)}">${escapeHtml(typeLabel(rule.type))}</span>
        <span class="rule-desc">${escapeHtml(ruleDescription(rule))}</span>
        <button class="rule-action-btn rule-edit" title="${escapeHtml(tr('extensionEdit', 'Edit'))}">&#x270E;</button>
        <button class="rule-action-btn rule-remove" title="${escapeHtml(tr('commonRemove', 'Remove'))}">&times;</button>
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
        showErrorBubble(
          tr(
            'desktopRemoveRuleFailed',
            `Failed to remove rule: ${err.message}`,
            [err.message],
          ),
        );
      }
    });
  });
}

async function refreshRulesForActiveList() {
  if (activeView.type !== 'list') return;
  const listId = activeView.id;
  const listProjection = await loadListDisplay(listId);
  if (!listProjection) throw new Error(`List not found: ${listId}`);
  renderRulesSection(listId, listProjection.rules);
}

// ─── Inline rule editing state ───
let previewResults = [];
let previewPinsResults = [];
let previewHistoryRunning = false;
let previewPinsRunning = false;
let previewAbort = null;

function collectPinnedPreviewEntries() {
  return Array.from(document.querySelectorAll('.result-row[data-url]'))
    .map((row) => ({
      url: row.dataset.url || '',
      title: row.querySelector('.result-title')?.textContent?.trim() || '',
    }))
    .filter((entry) => entry.url && entry.title);
}

async function previewRuleEntries(rule, entries) {
  return await sendAction({ action: 'previewRule', rule, entries });
}

function renderPreviewSection(results, listEl, countEl, running) {
  const matches = results.filter((r) => r.match);
  const spinnerHtml = running
    ? ' <span class="spinner spinner-sm"></span>'
    : '';
  countEl.innerHTML = `${escapeHtml(
    tr(
      'desktopMatchesChecked',
      `${matches.length} matches (${results.length} checked)`,
      [matches.length, results.length],
    ),
  )}${spinnerHtml}`;
  if (matches.length === 0) {
    listEl.innerHTML = running
      ? ''
      : `<div class="rules-preview-empty">${escapeHtml(tr('desktopNoMatches', 'No matches'))}</div>`;
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
  if (!editRow) return { error: tr('desktopNoEditRow', 'No edit row') };
  const activeType =
    editRow.querySelector('.rule-type-option.active')?.dataset.type ||
    'keyword';
  const inputVal = editRow.querySelector('.rule-edit-input').value.trim();
  if (activeType === 'keyword') {
    if (!inputVal)
      return { error: tr('desktopPatternRequired', 'Pattern is required') };
    return {
      rule: {
        type: 'keyword',
        config: { pattern: inputVal },
      },
    };
  } else if (activeType === 'function') {
    const fnSource =
      editRow.querySelector('.rule-fn-input')?.value.trim() || '';
    if (!fnSource)
      return {
        error: tr('desktopFunctionBodyRequired', 'Function body is required'),
      };
    return {
      rule: {
        type: 'function',
        config: {
          description:
            inputVal || tr('desktopCustomFunction', '(custom function)'),
          fnSource,
        },
      },
    };
  }
  return { error: tr('desktopUnknownRuleType', 'Unknown rule type') };
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
  const inputPlaceholder = isKeyword
    ? tr('desktopRuleKeywordPlaceholder', 'keyword or /regex/')
    : tr('desktopRuleDescriptionPlaceholder', 'description');
  const fnSource = config?.fnSource || '';
  return `<div class="rule-entry rule-editing">
    <div class="rule-edit-main">
      <div class="rule-type-toggle">
        <span class="rule-type-option ${isKeyword ? 'active' : ''}" data-type="keyword">${escapeHtml(tr('desktopKeyword', 'Keyword'))}</span>
        <span class="rule-type-option ${!isKeyword ? 'active' : ''}" data-type="function">${escapeHtml(tr('desktopFunction', 'Function'))}</span>
      </div>
      <input class="rule-edit-input" type="text" value="${escapeHtml(inputValue)}" placeholder="${escapeHtml(inputPlaceholder)}">
      <button class="rule-preview-btn">${escapeHtml(tr('desktopPreview', 'Preview'))}</button>
      <button class="rule-cancel-btn" title="${escapeHtml(tr('commonCancel', 'Cancel'))}">&times;</button>
      <button class="rule-save-btn" title="${escapeHtml(tr('desktopSaveEnter', 'Save (Enter)'))}">OK</button>
    </div>
    <div class="rule-fn-editor" style="${isKeyword ? 'display:none' : ''}">
      <pre class="rule-fn-highlight" aria-hidden="true"></pre>
      <textarea class="rule-fn-input scroll-boundary-contained" rows="20" placeholder="// page = { title, url, body }\nreturn page.title !== null && page.title.length > 50;" spellcheck="false">${escapeHtml(fnSource)}</textarea>
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
        type === 'keyword'
          ? tr('desktopRuleKeywordPlaceholder', 'keyword or /regex/')
          : tr('desktopRuleDescriptionPlaceholder', 'description');
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
          e.action === 'visit_page' && e.url && e.title && !seenUrls.has(e.url),
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
            url: entry.url,
            title: entry.title,
            bodyPreview: null,
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
            url: batch[j].url,
            title: batch[j].title,
            bodyPreview: bodies[j],
          });
        }
      }
      if (entries.length === 0) continue;
      const resp = await previewRuleEntries(rule, entries);
      if (!Array.isArray(resp.results)) {
        throw new Error('previewRule response results must be an array');
      }
      for (const r of resp.results) {
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
    previewListEl.innerHTML = `<div class="rules-preview-empty">${escapeHtml(tr('desktopNoVisitsPreview', 'No visits found to match against'))}</div>`;
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
    const listProjection = await loadListDisplay(listId);
    if (!listProjection) throw new Error(`List not found: ${listId}`);
    for (const pin of listProjection.pins) {
      if (signal?.aborted) break;
      if (!pin.url) continue;
      const title = pin.userTitle || pin.title || '';
      if (!title) continue;
      pinMeta.push({ url: pin.url, title });
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
    const bodies =
      rule?.type === 'keyword'
        ? batch.map(() => '')
        : await Promise.all(batch.map((e) => fetchPageBody(e.url)));
    const entries = [];
    for (let j = 0; j < batch.length; j++) {
      const entry = {
        url: batch[j].url,
        title: batch[j].title,
        bodyPreview: bodies[j] || null,
      };
      entries.push(entry);
      checked++;
    }
    if (entries.length > 0) {
      const resp = await previewRuleEntries(rule, entries);
      if (!Array.isArray(resp.results)) {
        throw new Error('previewRule response results must be an array');
      }
      for (const r of resp.results) {
        previewPinsResults.push(r);
      }
    }
    rerenderPreview();
  }

  previewPinsRunning = false;
  if (checked === 0 && !signal?.aborted) {
    pinsPreviewCountEl.textContent = '';
    pinsPreviewListEl.innerHTML = `<div class="rules-preview-empty">${escapeHtml(tr('desktopNoPinnedPreview', 'No pinned pages available for preview'))}</div>`;
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
  previewResults = [];
  previewPinsResults = [];
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
    previewBtn.textContent = tr('desktopCancelPreview', 'Cancel Preview');
  }
  previewEl.style.display = '';

  try {
    await runPreviewAgainstHistory(built.rule, ac.signal);

    if (!ac.signal.aborted) {
      const listId =
        activeView.type === 'list'
          ? activeView.id
          : document.querySelector('.sidebar-item.active[data-list-id]')
              ?.dataset.listId || null;
      if (listId) {
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
      previewBtn.textContent = tr('desktopPreview', 'Preview');
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

let listPinsData = [];
let listPinsListId = null;

// Render all pins into #relatedResults with search filtering support
async function renderListPinView(allPins, listId) {
  listPinsData = allPins;
  listPinsListId = listId;
  renderSearchPanel();
  await runListPinFilter();
}

// Run the active view's search pipeline after an explicit commit/filter change.
function runActiveSearchPipeline() {
  searchDraftPreviewActive = false;
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
    await enrichFromEntityStorage(filtered);
  }
  filtered = applyFilters(filtered);

  renderFilteredPins(filtered, listPinsListId, allQueries.join(' '));
}

function disableRelatedVirtualScrollerForDirectRender(container) {
  if (container._virtualScroller) {
    container._virtualScroller.destroy();
  }
  relatedVirtualScroller = null;
  container.style.paddingTop = '0px';
  container.style.paddingBottom = '';
}

function renderDirectSearchResults(results) {
  const relatedContainer = document.getElementById('relatedResults');
  disableRelatedVirtualScrollerForDirectRender(relatedContainer);
  bindResultDelegation(relatedContainer);
  bindColumnHeaderClicks(relatedContainer);
  bindPinClicks(relatedContainer, getActivePinListId());

  const showNoResults = results.length === 0 && searchState.pendingPhases <= 0;
  relatedContainer.dataset.searchCount = String(results.length);

  if (results.length === 0) {
    if (searchState.pendingPhases > 0) {
      if (!preserveRelatedScrollOnNextRender) {
        relatedContainer.innerHTML = '';
      }
      document.getElementById('relatedChart').classList.remove('visible');
      return;
    }
    preserveRelatedScrollOnNextRender = false;
    consumeRelatedTopReset();
    relatedContainer.innerHTML = showNoResults
      ? `<div class="no-results">${escapeHtml(tr('desktopNoResults', 'No results'))}</div>`
      : '';
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const maxAtt = Math.max(...results.map((r) => r.attScore), 0.1);
  const preserveScroll = preserveRelatedScrollOnNextRender;
  preserveRelatedScrollOnNextRender = false;
  const renderAtTop = preserveScroll ? false : consumeRelatedTopReset();
  const main = document.querySelector('.main');
  const anchor = preserveScroll
    ? captureRelatedDomScrollAnchor(relatedContainer)
    : null;
  if (renderAtTop && main) main.scrollTop = 0;
  const previousScrollTop = main?.scrollTop || 0;
  const selectedUrls = new Set(
    [...relatedContainer.querySelectorAll('.result-row.selected')].map(
      (row) => row.dataset.url,
    ),
  );
  const lastClickedUrl =
    lastClickedRow && relatedContainer.contains(lastClickedRow)
      ? lastClickedRow.dataset.url
      : null;

  relatedContainer.innerHTML = results
    .map((r) =>
      resultRowHtml(r.user_title || r.title, r.url, {
        attScore: r.attScore,
        maxAtt,
        attDetail: r.attDetail,
        notes: r.notes,
        timestamps: r.timestamps,
        visitDates: r.visitDates,
        context: 'related',
        hasSnapshots: r.hasSnapshots,
        listSlugs: r.listSlugs,
        likes: r.likes,
        matchSources: r.matchSources,
        hasHighlightNotes: r.hasHighlightNotes,
      }),
    )
    .join('');
  for (const row of relatedContainer.querySelectorAll('.result-row')) {
    if (selectedUrls.has(row.dataset.url)) row.classList.add('selected');
  }
  lastClickedRow = lastClickedUrl
    ? [...relatedContainer.querySelectorAll('.result-row')].find(
        (row) => row.dataset.url === lastClickedUrl,
      ) || null
    : null;
  if (preserveScroll && main) {
    if (!restoreRelatedDomScrollAnchor(relatedContainer, anchor)) {
      main.scrollTop = previousScrollTop;
    }
  }

  const chartData = results.map((r) => ({
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
    tr('desktopExploreResults', 'Explore results'),
  );
  bindChartBarClick(relatedChart, relatedContainer);
  applyPersistedRelatedDateFilter();
  syncChartHighlights();
}

// Render filtered pin results directly so list selection can operate on every row.
function renderFilteredPins(pins, listId, searchQuery) {
  const relatedContainer = document.getElementById('relatedResults');
  disableRelatedVirtualScrollerForDirectRender(relatedContainer);

  if (pins.length === 0) {
    consumeRelatedTopReset();
    relatedContainer.innerHTML = searchQuery.trim()
      ? `<div class="no-results">${escapeHtml(tr('desktopNoMatchingPins', 'No matching pins'))}</div>`
      : `<div class="no-results">${escapeHtml(tr('desktopNoPinnedPages', 'No pinned pages'))}</div>`;
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
        hasSnapshots: r.hasSnapshots,
        listSlugs: r.listSlugs,
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
    tr('desktopPinnedPages', 'Pinned Pages'),
  );
  bindChartBarClick(relatedChart, relatedContainer);
  applyPersistedRelatedDateFilter();
}

// renderPinnedWithRelated removed — pinned section only shows pinned rows

// recalculateRelatedResults removed — pinned section no longer has related pages

async function hydrateExploreSearchResults() {
  await initHistoryFiles();
  if (!isActiveExploreView()) return;
  await loadHistoryBatch();
  if (!isActiveExploreView()) return;
  refreshFilterPanelIfHydrated();

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
        if (Number.isFinite(item.score)) {
          existing.score = Math.max(existing.score || 0, item.score);
        }
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
      score: Number.isFinite(item.score) ? item.score : undefined,
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

async function loadProjectedPages(slugs) {
  const contexts = await loadPageContext(slugs);
  const pages = {};
  for (const slug of slugs) {
    const context = contexts[slug];
    if (!context) continue;
    pages[slug] = context.page;
  }
  return { contexts, pages };
}

// Batch-fetch page entities for all unique slugs in entries, enrich with entity titles.
async function enrichFromEntityStorage(entries, opts = {}) {
  const { includeVisitDates = true } = opts;
  const allSlugs = [...new Set(entries.map((r) => r.slug).filter(Boolean))];
  if (allSlugs.length === 0) return;
  const { contexts, pages } = await loadProjectedPages(allSlugs);

  for (const entry of entries) {
    const page = pages[entry.slug];
    if (!page) continue;
    const context = contexts[entry.slug];
    if (!entry.title && page.title) entry.title = page.title;
    entry.user_title = page.user_title ?? null;
    entry.hasSnapshots = page.hasSnapshots === true;
    entry.listSlugs = context.lists.map((list) => list.slug);
    entry.likes = page.likes ?? 0;
    if (!entry.deviceIds || entry.deviceIds.size === 0) {
      entry.deviceIds = new Set(Object.keys(page.timestamps));
    }
    entry.attScore = attentionStrength(page);
    entry.attDetail = page;
    if (page.createdAt && !entry.createdAt) entry.createdAt = page.createdAt;
    if (includeVisitDates && entry.dateScope !== 'row' && page.visitDates) {
      entry.visitDates = page.visitDates;
    }
    entry.visitCount = page.visitDates.length;
    entry.hasHighlightNotes = context.notes.length > 0;
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
      hasSnapshots: e.hasSnapshots,
      listSlugs: e.listSlugs,
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
      } catch (error) {
        surfaceBackgroundError('Could not open URL', error);
      }
    });
  });
}

// Lazy-load extra detail data (notes, lists, snapshots) when detail is expanded
async function loadExtraDetail(url) {
  const slug = generateSlugFromUrl(url);

  // Load notes for this page
  const notesResp = await sendAction({ action: 'loadPageNotes', slug });
  if (!Array.isArray(notesResp.notes)) {
    throw new Error('loadPageNotes response notes must be an array');
  }
  const notes = notesResp.notes;

  const snapResp = await sendAction({ action: 'listSnapshots', slug });
  if (!Array.isArray(snapResp.snapshots)) {
    throw new Error('listSnapshots response snapshots must be an array');
  }
  const snapshots = snapResp.snapshots;

  const contexts = await loadPageContext([slug]);
  const context = contexts[slug];
  // Visit-only pages intentionally have no durable checkpoint. Rating, list
  // membership, or a child artifact would make the page durable, so their
  // absence is the authoritative empty state for a missing context.
  const likes = context?.page.likes ?? 0;
  const belongedLists = (context?.lists ?? [])
    .filter((list) => !isSystemList(listKey(list.slug)))
    .map(listDisplayName);

  return {
    notes,
    snapshots,
    belongedLists,
    slug,
    likes,
    visitDates: context?.page.visitDates ?? [],
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
    let html = `<div class="detail-section detail-visit-dates"><span class="detail-visit-line"><span class="detail-section-label">${escapeHtml(tr('desktopFirstVisited', 'First visited:'))}</span> ${escapeHtml(fmtDate(first))}</span>`;
    if (sorted.length > 1) {
      html += `<span class="detail-visit-line"><span class="detail-section-label">${escapeHtml(tr('desktopLastVisited', 'Last visited:'))}</span> ${escapeHtml(fmtDate(last))}</span>`;
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
  '<svg data-icon="edit" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3z"/></svg>';
const DETAIL_ICON_DELETE =
  '<svg data-icon="delete" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';
const DETAIL_ICON_CONFIRM =
  '<svg data-icon="checkmark" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"><path d="M2.5 8.5l3.2 3.2L13.5 4"/></svg>';

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

  const highlightNotes = extra.notes.filter((n) => !n.deleted);
  if (highlightNotes.length > 0) {
    html += `<div class="detail-section detail-notes-section" data-slug="${escapeHtml(extra.slug)}">`;
    for (const n of highlightNotes.slice(0, 20)) {
      const noteSlug = n.slug || '';
      const noteText = n.note || '';
      const rawQuote = formatHighlightExcerpt(n.excerpt);
      const noteBody = noteText
        ? `<span class="detail-note-content">${escapeHtml(noteText)}</span>`
        : '';
      html += `<div class="detail-note-entry" data-note-slug="${escapeHtml(noteSlug)}">
        <div class="detail-note-header">
          <div class="detail-note-excerpt">${escapeHtml(rawQuote)}</div>
          <button class="detail-note-action-btn delete" title="${escapeHtml(tr('extensionDeleteHighlight', 'Delete highlight'))}">${DETAIL_ICON_DELETE}</button>
        </div>
        <div class="detail-note-body">
          ${noteBody}
          <button class="detail-note-action-btn edit" title="${escapeHtml(tr('extensionEditNote', 'Edit note'))}">${DETAIL_ICON_EDIT}</button>
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
      html += `<button class="detail-snapshot-delete" data-ts="${s.timestamp}" title="${escapeHtml(tr('extensionDeleteSnapshot', 'Delete snapshot'))}">&times;</button>`;
      html += '</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  return html;
}

const pendingLocalNoteMutations = new Map();

function registerPendingLocalNoteMutation(noteSlug) {
  // Only suppress the authoritative mutation refresh when this view fully
  // reconciles every affected card locally. Shared page-detail editors must
  // still refresh dependent search, filter, and list state.
  if (!isHighlightHistoryView()) return null;
  const pending = { expected: null, observed: [] };
  const registration = { noteSlug, pending };
  pending.timeoutId = setTimeout(() => {
    const shouldRefresh = pending.observed.length > 0;
    if (clearPendingLocalNoteMutation(registration) && shouldRefresh) {
      refreshCurrentView();
    }
  }, 5000);
  pendingLocalNoteMutations.set(noteSlug, pending);
  return registration;
}

function pendingNoteMutationMatches(request, expected) {
  if (!expected) return false;
  if (expected.kind === 'delete') {
    return !request.oldNoteSlug && request.noteSlug === expected.noteSlug;
  }
  return (
    request.oldNoteSlug === expected.oldNoteSlug &&
    request.noteSlug === expected.noteSlug
  );
}

function currentPendingLocalNoteMutation(registration) {
  if (!registration) return null;
  const { noteSlug, pending } = registration;
  return pendingLocalNoteMutations.get(noteSlug) === pending ? pending : null;
}

function clearPendingLocalNoteMutation(registration) {
  const pending = currentPendingLocalNoteMutation(registration);
  if (!pending) return false;
  pendingLocalNoteMutations.delete(registration.noteSlug);
  clearTimeout(pending.timeoutId);
  return true;
}

function cancelPendingLocalNoteMutation(registration) {
  const pending = currentPendingLocalNoteMutation(registration);
  if (!pending) return;
  const shouldRefresh = pending.observed.length > 0;
  if (clearPendingLocalNoteMutation(registration) && shouldRefresh) {
    refreshCurrentView();
  }
}

function resolvePendingLocalNoteMutation(registration, expected) {
  const pending = currentPendingLocalNoteMutation(registration);
  if (!pending) return;
  pending.expected = expected;
  const matched = pending.observed.some((request) =>
    pendingNoteMutationMatches(request, expected),
  );
  const hasExternal = pending.observed.some(
    (request) => !pendingNoteMutationMatches(request, expected),
  );
  if (!expected || matched) {
    clearPendingLocalNoteMutation(registration);
  }
  if (hasExternal) refreshCurrentView();
}

function consumePendingLocalNoteMutation(request) {
  for (const noteSlug of [request.oldNoteSlug, request.noteSlug]) {
    if (!noteSlug) continue;
    const pending = pendingLocalNoteMutations.get(noteSlug);
    if (!pending) continue;
    if (!pending.expected) {
      pending.observed.push(request);
      return true;
    }
    if (pendingNoteMutationMatches(request, pending.expected)) {
      clearPendingLocalNoteMutation({ noteSlug, pending });
      return true;
    }
    return false;
  }
  return false;
}

function removeElementWithoutDescendants(element, selector) {
  if (element && !element.querySelector(selector)) element.remove();
}

function reconcileDeletedHighlightHistoryEntry({
  noteSlug,
  pageGroup,
  daySection,
}) {
  removeHighlightHistoryItem(noteSlug);
  removeElementWithoutDescendants(pageGroup, '.highlight-history-entry');
  removeElementWithoutDescendants(daySection, '.highlight-history-entry');
  renderNextHighlightHistoryBatch(1);
}

function removeEmptyDetailNoteSection(section, { isHighlightHistoryEntry }) {
  if (!section || section.querySelector('.detail-note-entry')) return;
  section.remove();
  if (isHighlightHistoryEntry && highlightHistoryState.items.length === 0) {
    renderHighlightHistoryEmptyState(document.getElementById('results'));
  }
}

async function deleteDetailNote(button, container) {
  const entry = button.closest('.detail-note-entry');
  const noteSlug = entry?.dataset.noteSlug;
  if (!noteSlug) return;

  const section = button.closest('.detail-notes-section');
  const daySection = button.closest('.highlight-history-day-section');
  const pageGroup = button.closest('.highlight-history-page-group');
  const isHighlightHistoryEntry =
    isHighlightHistoryView() && Boolean(container.closest('#results'));
  const pendingMutation = registerPendingLocalNoteMutation(noteSlug);

  try {
    await sendAction({ action: 'deleteNote', noteSlug });
    resolvePendingLocalNoteMutation(pendingMutation, {
      kind: 'delete',
      noteSlug,
    });
  } catch (error) {
    cancelPendingLocalNoteMutation(pendingMutation);
    logError('Delete note error:', error);
    return;
  }

  destroyHighlightHistoryJustification(
    entry.querySelectorAll('.detail-note-excerpt, .detail-note-content'),
  );
  entry.remove();
  if (isHighlightHistoryEntry) {
    reconcileDeletedHighlightHistoryEntry({
      noteSlug,
      pageGroup,
      daySection,
    });
  }
  removeEmptyDetailNoteSection(section, { isHighlightHistoryEntry });
  await refreshRecycleBinUi();
}

function bindNoteDeleteButtons(container) {
  container
    .querySelectorAll('.detail-note-action-btn.delete')
    .forEach((button) => {
      if (button.dataset.noteDeleteBound === 'true') return;
      button.dataset.noteDeleteBound = 'true';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        void deleteDetailNote(button, container);
      });
    });

  container
    .querySelectorAll('.detail-note-entry .detail-note-action-btn.edit')
    .forEach(bindDetailNoteEditButton);
}

function bindDetailNoteEditButton(button) {
  if (!button || button.dataset.noteEditBound === 'true') return;
  button.dataset.noteEditBound = 'true';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const entry = button.closest('.detail-note-entry');
    const noteSlug = entry?.dataset.noteSlug;
    if (!noteSlug) return;
    openDetailNoteEditor(entry, noteSlug);
  });
}

function selectionIntersectsElement(element) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return false;
  }
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

async function openHighlightHistoryPage(title) {
  const url = title.dataset.url;
  if (!url) return;
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    surfaceBackgroundError('Could not open URL', error);
  }
}

function bindHighlightHistoryPageTitles(container) {
  container
    .querySelectorAll('.highlight-history-page-title[data-url]')
    .forEach((title) => {
      if (title.dataset.openUrlBound === 'true') return;
      title.dataset.openUrlBound = 'true';
      title.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (event.detail > 0 && selectionIntersectsElement(title)) return;
        await openHighlightHistoryPage(title);
      });
      title.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.stopPropagation();
        await openHighlightHistoryPage(title);
      });
    });
}

function renderDetailNoteBody(body, noteText) {
  destroyHighlightHistoryJustification(
    body.querySelectorAll('.detail-note-content'),
  );
  const isHighlightHistoryEntry = body.closest('.highlight-history-entry');
  if (isHighlightHistoryEntry) {
    body
      .closest('.highlight-history-content')
      ?.classList.toggle('has-note', Boolean(noteText));
  }
  const noteBody = detailNoteContentHtml(
    noteText,
    isHighlightHistoryEntry ? highlightHistoryTextHtml : escapeHtml,
  );
  body.innerHTML = `${noteBody}
    <button class="detail-note-action-btn edit" title="${escapeHtml(tr('extensionEditNote', 'Edit note'))}">${DETAIL_ICON_EDIT}</button>`;
  bindDetailNoteEditButton(body.querySelector('.detail-note-action-btn.edit'));
  if (isHighlightHistoryEntry) {
    applyHighlightHistoryJustification(body);
  }
}

function expectedLocalNoteUpdate(response, requestedNoteSlug) {
  if (!response?.oldNoteSlug) return null;
  return {
    kind: 'update',
    oldNoteSlug: requestedNoteSlug,
    noteSlug: response.noteSlug,
  };
}

function reconcileSavedDetailNote({
  entry,
  requestedNoteSlug,
  currentNoteSlug,
  response,
  noteText,
}) {
  const updatedNoteSlug = response?.noteSlug || requestedNoteSlug;
  if (isHighlightHistoryView()) {
    updateHighlightHistoryItem(requestedNoteSlug, updatedNoteSlug, noteText);
  }
  if (!response?.noteSlug || response.noteSlug === currentNoteSlug) {
    return currentNoteSlug;
  }
  entry.dataset.noteSlug = response.noteSlug;
  return response.noteSlug;
}

function setDetailNoteEditorControlsDisabled(
  confirmButton,
  deleteButton,
  disabled,
) {
  confirmButton.disabled = disabled;
  if (deleteButton) deleteButton.disabled = disabled;
}

function focusEditableAtEnd(editor) {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function openDetailNoteEditor(entry, noteSlug) {
  const body = entry.querySelector('.detail-note-body');
  if (!body || body.querySelector('.detail-note-editor')) return;
  entry.querySelector('.highlight-history-content')?.classList.add('has-note');
  const contentEl = body.querySelector('.detail-note-content');
  destroyHighlightHistoryJustification(
    body.querySelectorAll('.detail-note-content'),
  );
  const currentText = contentEl?.textContent || '';
  body.innerHTML = `<span class="detail-note-editor" contenteditable="plaintext-only" role="textbox" aria-multiline="true" data-placeholder="${escapeHtml(tr('extensionAddNote', 'Add a note...'))}">${escapeHtml(currentText)}</span>
    <button class="detail-note-action-btn confirm" title="${escapeHtml(tr('commonConfirm', 'Confirm'))}">${DETAIL_ICON_CONFIRM}</button>`;
  const editor = body.querySelector('.detail-note-editor');
  const confirmButton = body.querySelector('.detail-note-action-btn.confirm');
  const deleteButton = entry.querySelector('.detail-note-action-btn.delete');
  let saving = false;
  let finished = false;

  const finishEditing = (noteText) => {
    if (finished) return;
    finished = true;
    renderDetailNoteBody(body, noteText);
  };

  const saveEditor = async () => {
    if (saving || finished) return;
    saving = true;
    setDetailNoteEditorControlsDisabled(confirmButton, deleteButton, true);
    const nextNote = editor.innerText.replace(/\r\n/g, '\n');
    const requestedNoteSlug = noteSlug;
    const pendingMutation = registerPendingLocalNoteMutation(noteSlug);
    try {
      const response = await sendAction({
        action: 'updateNote',
        noteSlug,
        note: nextNote,
      });
      resolvePendingLocalNoteMutation(
        pendingMutation,
        expectedLocalNoteUpdate(response, requestedNoteSlug),
      );
      noteSlug = reconcileSavedDetailNote({
        entry,
        requestedNoteSlug,
        currentNoteSlug: noteSlug,
        response,
        noteText: nextNote,
      });
      finishEditing(nextNote);
    } catch (error) {
      cancelPendingLocalNoteMutation(pendingMutation);
      surfaceBackgroundError('Could not save note', error);
      saving = false;
      setDetailNoteEditorControlsDisabled(confirmButton, deleteButton, false);
      editor.focus();
    }
  };

  confirmButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void saveEditor();
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      finishEditing(currentText);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveEditor();
    }
  });
  focusEditableAtEnd(editor);
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
      await refreshRecycleBinUi();
    });
  });
}

function attentionLevel(normalized) {
  if (!normalized || normalized <= 0) return '';
  if (normalized >= 0.75) return 'high';
  if (normalized >= 0.4) return 'med';
  return 'low';
}

function resultRowHtml(title, url, opts = {}) {
  if (typeof url !== 'string' || !url) {
    throw new Error('Result rows require a non-empty URL');
  }
  const safeUrl = escapeHtml(url);
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
    hasSnapshots = false,
    listSlugs = [],
    excludeListId,
    likes = 0,
    matchSources,
    hasHighlightNotes,
  } = opts;

  const lastVisit =
    timestamps.length > 0 ? formatTime(Math.max(...timestamps)) : '';
  const normalized = maxAtt > 0 ? attScore / maxAtt : 0;

  const parsed = new URL(url);
  const site =
    parsed.protocol === 'file:'
      ? 'file'
      : parsed.hostname.replace(/^www\./, '');

  const safeTitle = escapeHtml(title || site || url);

  const dates = collectVisitDateKeys({ visitDates, timestamps }).join(',');

  const hasNotes = hasHighlightNotes === true;
  const hasSnaps = hasSnapshots;
  const belongedListNames = [];
  for (const listSlug of listSlugs) {
    if (listSlug.startsWith('system/')) continue;
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
  const attCtrlHtml = `<div class="att-ctrl${attLvl ? ' ' + attLvl : ''}" data-url="${safeUrl}" data-title="${safeTitle}"><span class="att-ctrl-dot"></span><button class="att-ctrl-btn" title="${escapeHtml(tr('desktopViewDetails', 'View details'))}"><span class="att-ctrl-icon" aria-hidden="true">⋯</span></button></div>`;
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
    ? `<div class="card-extras">${isAuto ? `<span class="card-tag card-tag-auto">${escapeHtml(tr('desktopAutoTag', 'auto'))}</span>` : ''}${isLiked ? `<span class="card-tag card-tag-liked">${escapeHtml(tr('desktopLikedTag', 'liked'))}</span>` : ''}${hasNotes ? `<span class="card-tag card-tag-note">${escapeHtml(tr('desktopNoteTag', 'note'))}</span>` : ''}${hasSnaps ? `<span class="card-tag card-tag-snap">${escapeHtml(tr('desktopSnapshotTag', 'snapshot'))}</span>` : ''}${matchNoteHit ? `<span class="card-tag card-tag-match-note">${escapeHtml(tr('desktopMatchedInNoteTag', 'matched in note'))}</span>` : ''}${matchSnapHit ? `<span class="card-tag card-tag-match-snap">${escapeHtml(tr('desktopMatchedInSnapshotTag', 'matched in snapshot'))}</span>` : ''}${listTagsHtml}</div>`
    : '';
  const cardActionsHtml = deletable
    ? `<div class="card-actions"><button class="result-delete" data-delete-url="${safeUrl}" data-delete-title="${safeTitle}" title="${escapeHtml(tr('commonDelete', 'Delete'))}">${DELETE_SVG}</button></div>`
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
  if (typeof url !== 'string' || !url) {
    throw new Error('Page details require a non-empty URL');
  }
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
      <button class="page-detail-close" title="${escapeHtml(tr('commonClose', 'Close'))}">×</button>
    </div>
    <div class="page-detail-body scroll-boundary-contained"><div class="page-detail-loading"><span class="spinner"></span></div></div>
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

  loadExtraDetail(url)
    .then((extra) => {
      const body = card.querySelector('.page-detail-body');
      const html = buildDetailHtml(url, attDetail, [], extra.likes);
      const extraHtml = renderExtraDetailHtml(extra, cardTimestamp);
      body.innerHTML =
        html +
        (extraHtml ? `<div class="detail-extra">${extraHtml}</div>` : '');
      bindDetailUrlHandlers(body);
      bindNoteDeleteButtons(body);
      bindSnapshotClickHandlers(body);
    })
    .catch((error) => {
      surfaceBackgroundError('Failed to load page details', error);
      const body = card.querySelector('.page-detail-body');
      if (body)
        body.innerHTML = `<div style="padding:16px;color:var(--text-muted)">${escapeHtml(tr('desktopFailedToLoadPageDetails', 'Failed to load page details'))}</div>`;
    });

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
  const contexts = await loadPageContext([slug]);
  const page = contexts[slug]?.page;
  const title = page?.user_title || page?.title || url;
  const timestamps = Object.values(page?.timestamps || {});
  const cardTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;
  openPageDetailCard(url, title, null, cardTimestamp);
}

async function applyPendingShellRoute() {
  if (
    applyingShellRoute ||
    !pendingShellRoute ||
    document.body.dataset.shellReady !== 'true'
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
      if (!(await closeSettingsModal())) return;
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
  if (document.getElementById('settingsModal').classList.contains('open')) {
    void loadDesktopShellState()
      .then((shell) => renderPairedBrowsers(shell.pairedBrowsers))
      .catch((error) =>
        surfaceBackgroundError('Could not refresh paired browsers', error),
      );
  }
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

function updateMainTitle(text, i18nKey = null) {
  const titleEl = document.getElementById('mainTitle');
  const inputEl = document.getElementById('mainTitleInput');
  const confirmBtn = document.getElementById('confirmTitleBtn');
  // Exit any edit mode and show normal title
  if (i18nKey) titleEl.setAttribute('data-i18n', i18nKey);
  else titleEl.removeAttribute('data-i18n');
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
  document.getElementById('highlightsHistoryBtn').classList.remove('active');
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
  } else if (isHighlightHistoryView()) {
    document.getElementById('highlightsHistoryBtn').classList.add('active');
  } else if (activeView.type === 'recycle-bin') {
    document.getElementById('recycleBinBtn').classList.add('active');
  }
}

// --- Lists (pinned searches) ---
async function loadListTree() {
  return (await loadListTreeProjection()).tree;
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
  const { listFoldState: saved } = await chrome.storage.session.get([
    'listFoldState',
  ]);
  if (saved === undefined) return;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('Stored list fold state must be an object');
  }
  for (const [slug, expanded] of Object.entries(saved)) {
    if (!slug || typeof expanded !== 'boolean') {
      throw new Error(
        'Stored list fold state entries must map slugs to booleans',
      );
    }
  }
  listFoldState = saved;
}

function saveFoldState() {
  void chrome.storage.session
    .set({ listFoldState })
    .catch((error) =>
      surfaceBackgroundError('Could not save list fold state', error),
    );
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

  const collapseTitle = tr('desktopCollapse', 'Collapse');
  const expandTitle = tr('desktopExpand', 'Expand');
  item.innerHTML = `
    ${
      hasChildren
        ? `<button type="button" class="fold-toggle${expanded ? ' expanded' : ''}" title="${escapeHtml(expanded ? collapseTitle : expandTitle)}" aria-label="${escapeHtml(expanded ? collapseTitle : expandTitle)}" aria-expanded="${expanded}"></button>`
        : '<span class="list-leaf-dot" aria-hidden="true"></span>'
    }
    <span class="label">${escapeHtml(listDisplayName(node))}</span>
    <span class="pin-count"></span>
    <button class="remove-list" title="${escapeHtml(tr('commonRemove', 'Remove'))}">&times;</button>
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
      btn.title = newExpanded ? collapseTitle : expandTitle;
      btn.setAttribute('aria-label', newExpanded ? collapseTitle : expandTitle);
      btn.setAttribute('aria-expanded', String(newExpanded));
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
    await refreshRecycleBinUi();
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
      if (nodes[i].slug === draggedId) {
        draggedNode = nodes.splice(i, 1)[0];
        return true;
      }
      if (nodes[i].children && extractNode(nodes[i].children)) return true;
    }
    return false;
  }
  extractNode(tree);
  if (!draggedNode) draggedNode = { slug: draggedId, children: [] };

  if (relY >= 0.25 && relY <= 0.75) {
    // Nest as child of target
    function appendToTarget(nodes) {
      for (const n of nodes) {
        if (n.slug === targetSlug) {
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
        if (nodes[i].slug === targetSlug) {
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

      const order = await loadListTreeProjection();
      const tree = JSON.parse(JSON.stringify(order.order));
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
          const pinSlug = generateSlugFromUrl(url);
          if (
            url &&
            !pins.some((pin) => pin.kind === 'page' && pin.slug === pinSlug)
          ) {
            pins.push({ kind: 'page', slug: pinSlug, pinnedAt: Date.now() });
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

let primaryNavigationRenderSequence = 0;
const primaryNavigationButtonTransitionProperties = new Set([
  'background-color',
  'box-shadow',
  'color',
]);

function isPrimaryNavigationActivationTransition(animation, button, icon) {
  if (!(animation instanceof CSSTransition)) return false;
  const target = animation.effect?.target;
  return (
    (target === button &&
      primaryNavigationButtonTransitionProperties.has(
        animation.transitionProperty,
      )) ||
    (target === icon && animation.transitionProperty === 'color')
  );
}

async function renderPrimaryNavigationAfterActivation(
  button,
  isCurrentView,
  render,
) {
  const renderSequence = ++primaryNavigationRenderSequence;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (renderSequence !== primaryNavigationRenderSequence || !isCurrentView()) {
    return;
  }

  const icon = button.querySelector('.sidebar-hero-icon');
  const activationTransitions = button
    .getAnimations({ subtree: true })
    .filter((animation) => {
      const endTime = animation.effect?.getComputedTiming().endTime;
      return (
        isPrimaryNavigationActivationTransition(animation, button, icon) &&
        Number.isFinite(endTime) &&
        animation.playState !== 'idle' &&
        animation.playState !== 'paused'
      );
    });
  await Promise.allSettled(
    activationTransitions.map((animation) => animation.finished),
  );
  if (renderSequence !== primaryNavigationRenderSequence || !isCurrentView()) {
    return;
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (renderSequence !== primaryNavigationRenderSequence || !isCurrentView()) {
    return;
  }
  void render();
}

// --- Event listeners: primary sidebar destinations ---
document.getElementById('exploreBtn').addEventListener('click', () => {
  const button = document.getElementById('exploreBtn');
  activateExploreShell();
  void renderPrimaryNavigationAfterActivation(button, isActiveExploreView, () =>
    showExplore({ activate: false }),
  );
});

document
  .getElementById('highlightsHistoryBtn')
  .addEventListener('click', () => {
    const button = document.getElementById('highlightsHistoryBtn');
    activateHighlightsHistoryShell();
    void renderPrimaryNavigationAfterActivation(
      button,
      isHighlightHistoryView,
      () => showHighlightsHistory({ activate: false }),
    );
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
  input.placeholder = tr('desktopListNamePlaceholder', 'List name...');
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
    if (isHighlightHistoryView()) return;

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
        const card = row.closest('.result-item') || row;
        const cardRect = card.getBoundingClientRect();
        const cardTop = cardRect.top - currentWrapperRect.top;
        const cardBottom = cardTop + cardRect.height;
        const cardLeft = cardRect.left - currentWrapperRect.left;
        const cardRight = cardLeft + cardRect.width;

        if (
          cardRight > minX &&
          cardLeft < maxX &&
          cardBottom > minY &&
          cardTop < maxY
        ) {
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

document.getElementById('settingsClose').addEventListener('click', async () => {
  await closeSettingsModal();
});

document
  .getElementById('settingsModal')
  .addEventListener('click', async (e) => {
    if (e.target === e.currentTarget) {
      await closeSettingsModal();
    }
  });

async function openSettingsModal() {
  document.getElementById('settingsModal').classList.add('open');
  try {
    await Promise.all([
      updateStorageStatus(),
      updateStatistics(),
      renderBlacklist(),
      renderTrimRules(),
      refreshDesktopShellSettings(),
    ]);
  } catch (error) {
    showErrorBubble(error.message, { suffix: '' });
  }
}

async function closeSettingsModal() {
  try {
    if (!(await saveSyncSettings())) return false;
    document.getElementById('settingsModal').classList.remove('open');
    return true;
  } catch (error) {
    surfaceBackgroundError('Could not save sync settings', error);
    return false;
  }
}

async function refreshDesktopShellSettings() {
  const shell = await loadDesktopShellState();
  const loginToggle = document.getElementById('launchAtLoginToggle');
  const loginOption = document.getElementById('launchAtLoginOption');
  const loginUnsupported = document.getElementById('launchAtLoginUnsupported');
  const loginError = document.getElementById('launchAtLoginError');
  const loginItemSupported = shell.loginItemSupported;
  loginToggle.checked = shell.launchAtLogin;
  loginToggle.disabled = !loginItemSupported;
  loginOption.classList.toggle('disabled', !loginItemSupported);
  loginUnsupported.style.display = loginItemSupported ? 'none' : 'block';
  loginError.textContent = shell.loginItemError || '';
  loginError.style.display = shell.loginItemError ? 'block' : 'none';
  document.getElementById('debugLoggingToggle').checked = shell.debugLogging;
  await chrome.storage.session.set({ debugLogging: shell.debugLogging });
  renderPairedBrowsers(shell.pairedBrowsers);
}

function renderPairedBrowsers(browsers) {
  const list = document.getElementById('pairedBrowsersList');
  const activeToday = browsers.filter(isBrowserActiveToday);
  if (activeToday.length === 0) {
    list.innerHTML = `<div style="color: var(--text-muted)">${escapeHtml(tr('desktopNoBrowsersActiveToday', 'No browsers active today.'))}</div>`;
    return;
  }
  list.innerHTML = activeToday
    .map((browser) => {
      const lastSeen = new Date(browser.lastSeen).toLocaleString(
        getActiveLocale(),
      );
      const profile =
        browser.browserProfile === null
          ? ''
          : `${escapeHtml(browser.browserProfile)} · `;
      const browserName = formatBrowserName(browser.browserName);
      const connectionStatus = browser.connected
        ? tr('desktopConnected', 'Connected')
        : tr('desktopDisconnected', 'Disconnected');
      const connectionColor = browser.connected
        ? 'var(--accent-primary)'
        : 'var(--text-muted)';
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="min-width:0;">
            <div style="font-weight:600;color:var(--text-primary);">
              <span class="paired-browser-name">${escapeHtml(browserName)}</span>
              <span class="paired-browser-status" style="color: ${connectionColor}; font-weight: 500;">· ${escapeHtml(connectionStatus)}</span>
            </div>
            <div class="paired-browser-profile" style="color:var(--text-muted);font-size:11px;">
              ${profile}${escapeHtml(browser.browserId)} · ${escapeHtml(tr('desktopLastSeen', 'Last seen'))} ${escapeHtml(lastSeen)}
            </div>
          </div>
          <button
            class="section-action paired-browser-revoke"
            data-browser-id="${escapeHtml(browser.browserId)}"
            data-extension-id="${escapeHtml(browser.extensionId)}"
            style="padding:3px 8px;flex-shrink:0;"
          >
            ${escapeHtml(tr('desktopRevoke', 'Revoke'))}
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
        showStatus(
          tr(
            'desktopRevokeBrowserFailed',
            `Failed to revoke browser: ${error.message}`,
            [error.message],
          ),
          'error',
        );
        button.disabled = false;
      }
    });
  });
}

function isBrowserActiveToday(browser) {
  if (browser.connected) return true;
  const seen = new Date(browser.lastSeen);
  const now = new Date();
  return (
    seen.getFullYear() === now.getFullYear() &&
    seen.getMonth() === now.getMonth() &&
    seen.getDate() === now.getDate()
  );
}

function formatBrowserName(name) {
  const value = name.trim();
  const normalized = value.toLowerCase();
  if (normalized === 'edg' || normalized === 'edge') return 'Microsoft Edge';
  if (normalized === 'chrome') return 'Google Chrome';
  return value;
}

// --- Settings: Storage ---
async function updateStorageStatus() {
  const [info, connector] = await Promise.all([
    loadDirectoryInfo(),
    loadDesktopConnectorState(),
  ]);

  const row = document.getElementById('storageLocation');
  const pathEl = document.getElementById('storagePath');
  const deviceNameEl = document.getElementById('storageDeviceName');
  const selectBtn = document.getElementById('selectDirBtn');
  const paired = connector.state !== 'setup_required';

  if (paired) {
    if (!info || info.hasPermission !== true) {
      throw new Error('Configured desktop storage is not readable');
    }
    row.classList.remove('not-configured');
    pathEl.textContent = connector.dataFolder;
    if (deviceNameEl) {
      deviceNameEl.textContent = tr(
        'desktopDeviceId',
        `Device ${connector.deviceId}`,
        [connector.deviceId],
      );
    }
    if (selectBtn) {
      selectBtn.style.display =
        connector.state === 'connected' ? 'none' : 'inline-block';
      selectBtn.textContent = tr(
        'desktopPairFromBrowserPopup',
        'Pair from Browser Popup',
      );
      selectBtn.disabled = false;
    }
  } else {
    if (info !== null) {
      throw new Error(
        'Unconfigured desktop storage returned directory information',
      );
    }
    row.classList.add('not-configured');
    pathEl.textContent = tr(
      'desktopDeviceNotConfigured',
      'Device not configured',
    );
    if (deviceNameEl) {
      deviceNameEl.textContent = '';
    }
    if (selectBtn) {
      selectBtn.style.display = 'inline-block';
      selectBtn.textContent = tr(
        'desktopPairFromBrowserPopup',
        'Pair from Browser Popup',
      );
      selectBtn.disabled = false;
    }
  }
}

async function updateStatistics() {
  const result = await chrome.storage.local.get(['desktopCommandBuffer']);
  if (result.desktopCommandBuffer === undefined) {
    await chrome.storage.local.set({ desktopCommandBuffer: [] });
    document.getElementById('bufferSize').textContent = '0';
    updateCacheSize();
    return;
  }
  if (!Array.isArray(result.desktopCommandBuffer)) {
    throw new Error('Persisted connector write queue must be an array');
  }
  document.getElementById('bufferSize').textContent =
    result.desktopCommandBuffer.length;

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
    btn.textContent = tr('desktopFlushing', 'Flushing...');

    try {
      const resp = await sendAction({
        action: 'flushDesktopQueue',
      });
      btn.textContent =
        resp.remaining > 0
          ? tr('desktopRemainingWrites', `${resp.remaining} remaining`, [
              resp.remaining,
            ])
          : tr('desktopFlushed', 'Flushed!');
      await updateStatistics();
    } catch (e) {
      btn.textContent = tr('desktopErrorPrefix', `Error: ${e.message}`, [
        e.message,
      ]);
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = tr('commonFlush', 'Flush');
    }, 2000);
  });

document.getElementById('clearCacheBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearCacheBtn');
  btn.disabled = true;
  btn.textContent = tr('desktopReloading', 'Reloading...');

  try {
    const sessionKeysToRemove = SESSION_CACHE_KEYS.map((c) => c.key);
    await chrome.storage.session.remove(sessionKeysToRemove);

    await sendAction({ action: 'flushDesktopQueue' });

    // Reload the page to reflect new data
    location.reload();
    return;
  } catch (error) {
    showStatus(
      tr('desktopCacheClearFailed', `Cache clear failed: ${error.message}`, [
        error.message,
      ]),
      'error',
    );
  }

  btn.disabled = false;
  btn.textContent = tr('desktopClearReload', 'Clear & Reload');
  updateCacheSize();
});

document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    const result = await refreshDesktopConnectorState();
    if (result?.state === 'connected') {
      await updateStorageStatus();
      showStatus(
        tr(
          'desktopAlreadyPaired',
          'Chrome is already paired with Browser Recall Desktop',
        ),
        'success',
      );
      resetHistory();
      showCategory(activeView.type === 'category' ? activeView.value : 'all');
    } else {
      showStatus(
        tr(
          'desktopOpenPopupPair',
          'Open the Browser Recall popup in Chrome and click Pair with desktop.',
        ),
        'success',
      );
    }
  } catch (error) {
    showStatus(
      tr(
        'desktopBridgeCheckFailed',
        `Desktop bridge check failed: ${error.message}`,
        [error.message],
      ),
      'error',
    );
  }
});

document.getElementById('themeSelect').addEventListener('change', () => {
  runSettingsChange(async () => {
    const theme = document.getElementById('themeSelect').value;
    await saveSettingsValue('theme', theme);
    await chrome.storage.session.set({ theme });
    await applyTheme();
  });
});

document.getElementById('localeSelect').addEventListener('change', () => {
  runSettingsChange(async () => {
    const localeOverride = document.getElementById('localeSelect').value;
    await saveSettingsValue('localeOverride', localeOverride);
    reloadApp();
  });
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

document.getElementById('colorSchemePicker').addEventListener('click', (e) => {
  const dot = e.target.closest('.color-dot');
  if (!dot) return;
  runSettingsChange(async () => {
    const scheme = dot.dataset.scheme;
    await saveSettingsValue('colorScheme', scheme);
    applyColorScheme(scheme);
    await chrome.storage.session.set({ colorScheme: scheme });
  });
});

document.getElementById('historyFileBatch').addEventListener('change', () => {
  runSettingsChange(async () => {
    const input = document.getElementById('historyFileBatch');
    const val = Number.parseInt(input.value, 10);
    if (!Number.isInteger(val) || val < 1) {
      throw new Error('History file batch must be an integer of at least 1');
    }
    await saveSettingsValue('historyFileBatch', val);
    historyState.fileBatch = val;
    input.value = val;
    showStatus(tr('desktopSettingsSaved', 'Settings saved'), 'success');
  });
});

document
  .getElementById('captureSnapshotVideo')
  .addEventListener('change', () => {
    runSettingsChange(async () => {
      await saveSettingsValue(
        'captureSnapshotVideo',
        document.getElementById('captureSnapshotVideo').checked,
      );
      showStatus(tr('desktopSettingsSaved', 'Settings saved'), 'success');
    });
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
      showStatus(
        tr('desktopSettingFailed', `Desktop setting failed: ${error.message}`, [
          error.message,
        ]),
        'error',
      );
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
document.getElementById('blacklistEnabled').addEventListener('change', () => {
  runSettingsChange(async () => {
    const enabled = document.getElementById('blacklistEnabled').checked;
    await saveSettingsValue('blacklistEnabled', enabled);
    setAddonOpen(document.getElementById('blacklistBody'), enabled);
  });
});

// Title Cleanup toggle
document
  .getElementById('titleCleanupEnabled')
  .addEventListener('change', () => {
    runSettingsChange(async () => {
      const enabled = document.getElementById('titleCleanupEnabled').checked;
      await saveSettingsValue('titleCleanupEnabled', enabled);
      setAddonOpen(document.getElementById('titleCleanupBody'), enabled);
    });
  });

// Save current sync settings from form fields. Returns false if validation fails.
async function saveSyncSettings() {
  const enabled = document.getElementById('syncEnabled').checked;
  const retention = Number.parseInt(
    document.getElementById('syncRetentionDays').value,
    10,
  );
  if (!Number.isInteger(retention) || retention < 1) {
    showStatus(
      tr(
        'desktopSettingFailed',
        'Retention days must be an integer of at least 1',
      ),
      'error',
    );
    return false;
  }

  if (enabled) {
    const repoUrl = document.getElementById('syncRepoUrl').value.trim();
    if (!repoUrl) {
      showStatus(
        tr('desktopRepositoryRequired', 'Repository address is required'),
        'error',
      );
      return false;
    }
    const authState = await sendAction({ action: 'getSyncAuthState' });
    if (!authState.hasToken) {
      showStatus(
        tr(
          'desktopGithubNotConnected',
          'GitHub not connected - click "Connect with GitHub" first',
        ),
        'error',
      );
      return false;
    }
    await saveSettingsValue('syncRepoUrl', repoUrl);
  }

  await saveSettingsValue('syncEnabled', enabled);
  await saveSettingsValue('syncMethod', 'github');
  await saveSettingsValue('syncRetentionDays', retention);
  await sendAction({ action: 'updateSyncSettings' });
  return true;
}

document.getElementById('syncNowBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncNowBtn');
  const cancelBtn = document.getElementById('syncCancelBtn');
  const statusEl = document.getElementById('syncStatus');
  btn.disabled = true;
  btn.textContent = tr('desktopSyncing', 'Syncing...');
  cancelBtn.style.display = '';
  statusEl.textContent = '';
  try {
    if (!(await saveSyncSettings())) {
      statusEl.style.color = '#c62828';
      statusEl.textContent = tr(
        'desktopFixSettingsBeforeSync',
        'Fix settings before syncing',
      );
      return;
    }
    // Phase 1: list devices immediately so the section appears
    const devResp = await sendAction({ action: 'syncListDevices' });
    if (!Array.isArray(devResp.devices)) {
      throw new Error('Sync device response devices must be an array');
    }
    if (devResp.devices.length > 0) {
      renderSyncDevices(devResp.devices, devResp.localDeviceId, true);
    }

    // Phase 2: actual push + pull
    const result = await sendAction({ action: 'syncNow' });
    if (result.skipped) {
      statusEl.style.color = '';
      statusEl.textContent =
        result.error || tr('desktopSyncSkipped', 'Sync skipped');
    } else if (result.error) {
      statusEl.style.color = '#c62828';
      if (result.authExpired) {
        statusEl.textContent = tr(
          'desktopGithubAuthExpired',
          'GitHub authorization expired - please reconnect.',
        );
        syncShowAuthState('disconnected');
      } else if (result.disabled) {
        statusEl.textContent = tr(
          'desktopSyncDisabled',
          `Sync disabled: ${result.error}`,
          [result.error],
        );
      } else {
        statusEl.textContent = tr(
          'desktopSyncErrorRetry',
          `Error (will retry): ${result.error}`,
          [result.error],
        );
      }
    } else {
      statusEl.style.color = '';
      statusEl.textContent = '';
    }
    // Phase 3: refresh with final push/pull timestamps
    refreshSyncDevices();
  } catch (e) {
    statusEl.style.color = '#c62828';
    statusEl.textContent = tr('desktopErrorPrefix', `Error: ${e.message}`, [
      e.message,
    ]);
  } finally {
    btn.disabled = false;
    btn.textContent = tr('desktopSyncNow', 'Sync Now');
    cancelBtn.style.display = 'none';
  }
});

document.getElementById('syncCancelBtn').addEventListener('click', async () => {
  const cancelBtn = document.getElementById('syncCancelBtn');
  cancelBtn.disabled = true;
  cancelBtn.textContent = tr('desktopCancelling', 'Cancelling...');
  try {
    await sendAction({ action: 'cancelSync' });
  } catch (error) {
    showStatus(
      tr('desktopErrorPrefix', `Cancel failed: ${error.message}`, [
        error.message,
      ]),
      'error',
    );
  }
});

// ─── Synced Devices List ─────────────────────────────────────────────

function formatTimeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return tr('desktopJustNow', 'just now');
  const min = Math.floor(sec / 60);
  if (min < 60) return tr('desktopMinutesAgo', `${min}m ago`, [min]);
  const hr = Math.floor(min / 60);
  if (hr < 24) return tr('desktopHoursAgo', `${hr}h ago`, [hr]);
  const days = Math.floor(hr / 24);
  return tr('desktopDaysAgo', `${days}d ago`, [days]);
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
      tag.textContent = tr('desktopCurrentDevice', '(current)');
      tag.style.color = 'var(--text-muted)';
      row.appendChild(tag);
    }

    const status = document.createElement('span');
    status.style.cssText =
      'color:var(--text-muted);margin-left:auto;margin-right:6px;white-space:nowrap;';
    if (d.paused) {
      status.textContent = tr('desktopPausedLower', 'paused');
    } else if (syncing) {
      status.textContent = isLocal
        ? tr('desktopPushing', 'pushing...')
        : tr('desktopPulling', 'pulling...');
    } else if (isLocal) {
      status.textContent = d.lastPushed
        ? tr('desktopPushedAgo', `pushed ${formatTimeAgo(d.lastPushed)}`, [
            formatTimeAgo(d.lastPushed),
          ])
        : '';
    } else {
      status.textContent = d.lastPulled
        ? tr('desktopPulledAgo', `pulled ${formatTimeAgo(d.lastPulled)}`, [
            formatTimeAgo(d.lastPulled),
          ])
        : '';
    }
    row.appendChild(status);

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = d.paused ? '\u25b6' : '\u23f8';
    toggleBtn.title = d.paused
      ? tr('desktopResumeSync', 'Resume sync')
      : tr('desktopPauseSync', 'Pause sync');
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
        toggleBtn.title = d.paused
          ? tr('desktopResumeSync', 'Resume sync')
          : tr('desktopPauseSync', 'Pause sync');
        status.textContent = d.paused ? tr('desktopPausedLower', 'paused') : '';
      } catch (e) {
        showStatus(
          tr('desktopToggleFailed', `Toggle failed: ${e.message}`, [e.message]),
          'error',
        );
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
    if (!Array.isArray(resp.devices)) {
      throw new Error('Sync device response devices must be an array');
    }
    renderSyncDevices(resp.devices, resp.localDeviceId, false);
  } catch (error) {
    const section = document.getElementById('syncDevicesSection');
    section.style.display = '';
    document.getElementById('syncDevicesList').textContent = tr(
      'desktopErrorPrefix',
      `Could not load synced devices: ${error.message}`,
      [error.message],
    );
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
      showStatus(tr('desktopTokenRequired', 'Token is required'), 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = tr('desktopConnecting', 'Connecting...');
    try {
      const remember = document.getElementById('syncRememberToken').checked;
      const response = await sendAction({
        action: 'setSyncToken',
        token,
        remember,
        authMethod: 'pat',
      });
      const login = response.githubUser;
      syncShowAuthState(
        'connected',
        tr('desktopAsGithubUser', `as @${login}`, [login]),
      );
      document.getElementById('syncPatInput').value = '';
    } catch (e) {
      showStatus(
        tr('desktopInvalidToken', `Invalid token: ${e.message}`, [e.message]),
        'error',
      );
    } finally {
      btn.disabled = false;
      btn.textContent = tr('desktopConnect', 'Connect');
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
      tr(
        'desktopDisconnectedManageTokensHtml',
        'Disconnected. <a href="https://github.com/settings/tokens" target="_blank" style="color:#1a73e8;">Manage tokens on GitHub</a>',
      ),
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
    btn.textContent = tr('desktopChecking', 'Checking...');
    await refreshSyncDevices();
    btn.textContent = tr('desktopCheckDevices', 'Check Devices');
    btn.disabled = false;
  });

// Clear all data
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (
    !confirm(
      tr(
        'desktopClearAllDataWarning',
        'Warning: this will delete all files in your storage directory.\n\nThis cannot be undone. Are you absolutely sure?',
      ),
    )
  ) {
    return;
  }
  if (
    !confirm(
      tr(
        'desktopClearAllDataFinalConfirm',
        'Final confirmation: Delete all history files?',
      ),
    )
  ) {
    return;
  }

  const clearBtn = document.getElementById('clearBtn');
  clearBtn.disabled = true;
  clearBtn.textContent = tr('desktopClearing', 'Clearing...');

  try {
    const resp = await sendAction({ action: 'clearAllData' });
    showStatus(
      tr(
        'desktopClearedFiles',
        `Cleared ${resp.deletedCount || 0} files/directories`,
        [resp.deletedCount || 0],
      ),
      'success',
    );
    await updateStatistics();
    resetHistory();
    showExplore();
  } catch (error) {
    showStatus(
      tr('desktopClearDataFailed', `Error clearing data: ${error.message}`, [
        error.message,
      ]),
      'error',
    );
  }

  clearBtn.disabled = false;
  clearBtn.textContent = tr('desktopClearAllData', 'Clear All Data');
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

function renderImportFailures(container, failures, getName) {
  container.innerHTML = '';
  if (!failures || failures.length === 0) return;

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = tr(
    'desktopItemsSkipped',
    `${failures.length} item${failures.length !== 1 ? 's' : ''} skipped`,
    [failures.length],
  );
  details.appendChild(summary);

  const list = document.createElement('ul');
  list.style.cssText = 'margin:4px 0;padding-left:20px;';
  for (const failure of failures) {
    const item = document.createElement('li');
    item.textContent = `${getName(failure)} — ${failure.reason}`;
    list.appendChild(item);
  }
  details.appendChild(list);
  container.appendChild(details);
}

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
          skipped: root.skipped,
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
          skipped: item.folder.skipped,
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
      skipped: item.folder.skipped,
      children: collectAllChildren(item.children),
    }));
  }

  importBtn.addEventListener('click', async () => {
    if (!Array.isArray(treeContainer._items)) {
      throw new Error('Bookmark import tree has not been initialized');
    }
    const selected = collectCheckedTree(treeContainer._items);
    if (selected.length === 0) return;

    importBtn.disabled = true;
    importBtn.textContent = tr('desktopImporting', 'Importing...');
    progressEl.textContent = tr(
      'desktopImportBookmarksProgress',
      'Importing bookmarks into Browser Recall...',
    );
    failuresEl.innerHTML = '';
    try {
      const result = await sendAction({
        action: 'importBookmarks',
        tree: selected,
      });
      progressEl.textContent = tr(
        'desktopImportBookmarksDone',
        `Done! Imported ${result.listCount} list${result.listCount !== 1 ? 's' : ''} with ${result.bookmarkCount} bookmark${result.bookmarkCount !== 1 ? 's' : ''}.`,
        [result.listCount, result.bookmarkCount],
      );
      if (!Array.isArray(result.failures)) {
        throw new Error('importBookmarks response failures must be an array');
      }
      renderImportFailures(
        failuresEl,
        result.failures,
        (failure) => failure.title || failure.url,
      );
    } catch (error) {
      progressEl.textContent = tr(
        'desktopImportFailed',
        `Import failed: ${error.message}`,
        [error.message],
      );
    } finally {
      importBtn.textContent = tr('commonImportSelected', 'Import Selected');
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
    if (Number.isSafeInteger(value) && value > 0) return value;
    return null;
  }

  function collectHistoryImportTimestamps(rawEntry) {
    const timestamps = new Set();
    const visitTimes = rawEntry.visitTimes ?? [];
    if (!Array.isArray(visitTimes)) {
      throw new Error('History entry visitTimes must be an array');
    }
    for (const value of visitTimes) {
      const normalized = normalizeHistoryTimestamp(value);
      if (normalized) timestamps.add(normalized);
    }
    const normalized = normalizeHistoryTimestamp(rawEntry.lastVisitTime);
    if (normalized) timestamps.add(normalized);
    return [...timestamps].sort((left, right) => left - right);
  }

  function normalizeHistoryImportPayload(payload) {
    if (!Array.isArray(payload)) {
      throw new Error('History import must be a JSON array.');
    }

    const failures = [];
    const entries = [];
    const allowedFields = new Set([
      'url',
      'title',
      'lastVisitTime',
      'visitTimes',
      'referrerUrl',
    ]);
    for (const [index, rawEntry] of payload.entries()) {
      if (
        !rawEntry ||
        typeof rawEntry !== 'object' ||
        Array.isArray(rawEntry)
      ) {
        throw new Error(`History entry ${index} must be an object`);
      }
      for (const key of Object.keys(rawEntry)) {
        if (!allowedFields.has(key)) {
          throw new Error(
            `History entry ${index} has unsupported field ${key}`,
          );
        }
      }
      if (typeof rawEntry.url !== 'string') {
        throw new Error(`History entry ${index} URL must be a string`);
      }
      if (rawEntry.title !== undefined && typeof rawEntry.title !== 'string') {
        throw new Error(`History entry ${index} title must be a string`);
      }
      if (
        rawEntry.referrerUrl !== undefined &&
        typeof rawEntry.referrerUrl !== 'string'
      ) {
        throw new Error(`History entry ${index} referrerUrl must be a string`);
      }
      const url = rawEntry.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        failures.push({
          url,
          title: rawEntry.title ?? '',
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
          title: rawEntry.title ?? '',
          reason: 'missing visit timestamp',
        });
        continue;
      }
      entries.push({
        url,
        title:
          typeof rawEntry.title === 'string' && rawEntry.title.trim()
            ? rawEntry.title.trim()
            : null,
        referrerUrl:
          typeof rawEntry.referrerUrl === 'string' &&
          rawEntry.referrerUrl.trim()
            ? rawEntry.referrerUrl.trim()
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
          ? tr(
              'desktopHistoryReadyToImport',
              `Ready to import ${visitCount} visit${visitCount !== 1 ? 's' : ''} across ${normalizedEntries.length} page${normalizedEntries.length !== 1 ? 's' : ''}.`,
              [visitCount, normalizedEntries.length],
            )
          : tr(
              'desktopNoImportableHistory',
              'No importable history entries found in this file.',
            );
      renderImportFailures(
        failuresEl,
        parseFailures,
        (failure) => failure.title || failure.url || 'entry',
      );
      importBtn.disabled = normalizedEntries.length === 0;
    } catch (error) {
      summaryEl.textContent = tr(
        'desktopHistoryParseFailed',
        `Could not parse history JSON: ${error.message}`,
        [error.message],
      );
      renderImportFailures(
        failuresEl,
        [
          {
            reason: tr(
              'desktopHistoryInvalidJson',
              'invalid JSON or unsupported history export format',
            ),
          },
        ],
        (failure) => failure.title || failure.url || 'entry',
      );
    }
  });

  importBtn.addEventListener('click', async () => {
    if (normalizedEntries.length === 0) return;

    importBtn.disabled = true;
    importBtn.textContent = tr('desktopImporting', 'Importing...');
    progressEl.textContent = tr(
      'desktopImportBrowserHistoryProgress',
      'Importing browser history into Browser Recall...',
    );
    try {
      const result = await sendAction({
        action: 'importHistory',
        entries: normalizedEntries,
      });
      progressEl.textContent = tr(
        'desktopImportHistoryDone',
        `Done! Imported ${result.visitCount} visit${result.visitCount !== 1 ? 's' : ''} across ${result.pageCount} page${result.pageCount !== 1 ? 's' : ''}.`,
        [result.visitCount, result.pageCount],
      );
      const skippedCount = (result.skippedCount || 0) + parseFailures.length;
      if (skippedCount > 0) {
        summaryEl.textContent = tr(
          'desktopImportSkipped',
          `${skippedCount} item${skippedCount !== 1 ? 's' : ''} skipped during parsing or import.`,
          [skippedCount],
        );
      }
      renderImportFailures(
        failuresEl,
        parseFailures,
        (failure) => failure.title || failure.url || 'entry',
      );
    } catch (error) {
      progressEl.textContent = tr(
        'desktopImportFailed',
        `Import failed: ${error.message}`,
        [error.message],
      );
    } finally {
      importBtn.textContent = tr('commonImportHistory', 'Import History');
      importBtn.disabled = normalizedEntries.length === 0;
    }
  });
}

// --- URL Blacklist ---
async function loadBlacklist() {
  return loadSettingsValue('urlBlacklist');
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
        <button class="blacklist-remove" data-index="${idx}" title="${escapeHtml(tr('commonRemove', 'Remove'))}">&times;</button>
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
    emptyMessage: tr(
      'desktopNoBlockedPrefixes',
      'No blocked web address prefixes',
    ),
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
const TRIM_ACTION_LABEL_KEYS = {
  remove_after_pipe: ['desktopRemoveAfterPipe', 'Remove after |'],
  remove_brackets: ['desktopRemoveBrackets', 'Remove [brackets]'],
  remove_parens: ['desktopRemoveParens', 'Remove (parens)'],
};

function trimActionLabel(action) {
  const label = TRIM_ACTION_LABEL_KEYS[action];
  if (!label) throw new Error(`Unknown title trim action: ${action}`);
  return tr(...label);
}

async function loadTrimRules() {
  return loadSettingsValue('titleTrimRules');
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
      `<span class="trim-action-label">${escapeHtml(trimActionLabel(rule.action))}</span>`,
    emptyMessage: tr('desktopNoTrimmingRules', 'No trimming rules'),
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

function parsePreciseHistoryMutation(request) {
  if (request.historyEntry == null) return null;
  const entry = request.historyEntry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('History mutation entry must be an object');
  }
  if (
    !['visit_page', 'leave_page', 'rename_page', 'rate_page'].includes(
      entry.action,
    ) ||
    !Number.isFinite(entry.timestamp) ||
    typeof entry.url !== 'string' ||
    !entry.url ||
    (entry.title !== null && typeof entry.title !== 'string') ||
    (entry.userTitle !== null && typeof entry.userTitle !== 'string') ||
    (entry.scrollDepth !== null && !Number.isFinite(entry.scrollDepth)) ||
    (entry.timeOnPage !== null && !Number.isFinite(entry.timeOnPage)) ||
    (entry.likes !== null && !Number.isFinite(entry.likes)) ||
    typeof entry.deviceId !== 'string' ||
    !entry.deviceId
  ) {
    throw new Error('History mutation entry is incomplete');
  }
  if (request.url !== entry.url) {
    throw new Error('History mutation URL does not match its entry');
  }
  return {
    action: entry.action,
    timestamp: entry.timestamp,
    url: entry.url,
    title: entry.title,
    user_title: entry.userTitle,
    scrollDepth: entry.scrollDepth,
    timeOnPage: entry.timeOnPage,
    likes: entry.likes,
    deviceId: entry.deviceId,
  };
}

let mutationRefreshTimer = null;
const pendingHistoryMutationRequests = [];

chrome.runtime.onMessage.addListener((request) => {
  if (request.action !== 'mutation') return;

  const { type } = request;

  if (type === 'history') {
    pendingHistoryMutationRequests.push(request);
    // New page visit — merge into historyState.byUrl and historyState.allEntries
    clearTimeout(mutationRefreshTimer);
    mutationRefreshTimer = setTimeout(async () => {
      const pendingMutations = pendingHistoryMutationRequests.splice(0);
      try {
        await refreshHistoryMetadata();
      } catch (error) {
        surfaceBackgroundError('History metadata refresh failed', error);
      }

      const preciseEntries = [];
      let requiresHistoryRefresh = false;
      try {
        for (const mutation of pendingMutations) {
          const entry = parsePreciseHistoryMutation(mutation);
          if (entry) preciseEntries.push(entry);
          else requiresHistoryRefresh = true;
        }
      } catch (error) {
        surfaceBackgroundError('History mutation validation failed', error);
        return;
      }
      let historyEntries;
      if (!requiresHistoryRefresh && preciseEntries.length > 0) {
        historyEntries = preciseEntries;
      } else {
        let todayEntries = [];
        try {
          todayEntries = await loadHistoryEntriesForDate(
            new Date().toISOString().slice(0, 10),
          );
        } catch (error) {
          surfaceBackgroundError('History mutation refresh failed', error);
          return;
        }
        historyEntries = todayEntries.filter(
          (entry) =>
            (entry.action === 'visit_page' || entry.action === 'leave_page') &&
            entry.url,
        );
        historyEntries.push(
          ...preciseEntries.filter(
            (entry) =>
              entry.action !== 'visit_page' && entry.action !== 'leave_page',
          ),
        );
      }
      // Only process entries newer than what we've already ingested
      const watermark = historyState._mutationWatermark || 0;
      let maxTs = watermark;
      let changed = false;
      const changedEntries = [];
      for (const entry of historyEntries) {
        const isVisitObservation =
          entry.action === 'visit_page' || entry.action === 'leave_page';
        if (isVisitObservation && entry.timestamp <= watermark) continue;
        if (isVisitObservation && entry.timestamp > maxTs) {
          maxTs = entry.timestamp;
        }
        if (!isVisitObservation) {
          changed = true;
          changedEntries.push(entry);
          const existing = historyState.byUrl.get(entry.url);
          if (existing && entry.action === 'rename_page') {
            existing.user_title = entry.user_title;
          }
          continue;
        }
        const existing = historyState.byUrl.get(entry.url);
        const { entry: merged, updated } = mergeHistoryEntry(entry, existing);
        if (updated) {
          historyState.byUrl.set(entry.url, merged);
          changed = true;
          changedEntries.push(merged);
        }
        historyState.allEntries.push(entry);
      }
      historyState._mutationWatermark = maxTs;
      if (changed) {
        if (activeView.type === 'explore') {
          const mergedIntoSearch =
            await mergeHistoryMutationsIntoActiveSearch(changedEntries);
          if (!mergedIntoSearch) {
            // Opening a Timeline page reports a new visit while the window is
            // inactive. Refresh its data without losing the reading position.
            preserveRelatedScrollOnNextRender = true;
            runSearchFilterPipeline();
          }
        } else if (activeView.type === 'list') {
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
    invalidateSettingsCache();
  } else if (type === 'note') {
    // Local note commands already reconcile their card in place. Their daemon
    // mutation is an acknowledgement, not a reason to rebuild and scroll the
    // active view. Mutations from other surfaces still refresh authoritatively.
    if (!consumePendingLocalNoteMutation(request)) refreshCurrentView();
  } else if (type === 'rules') {
    // Rules changed — refresh rules panel if viewing the affected list
    if (activeView.type === 'list' && request.listId === activeView.id) {
      refreshRulesForActiveList();
    }
  } else if (type === 'orphaned') {
    // Orphaned list changed — refresh recycle bin if active, update badge
    refreshRecycleBinUi();
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
    if (activeView.type === 'explore' || activeView.type === 'list') {
      if (!shouldPreserveCommittedSearchOnVisibilityRefresh()) {
        await waitForMainViewport();
        preserveRelatedScrollOnNextRender = true;
        runSearchFilterPipeline();
      }
    } else {
      refreshCurrentView();
    }
  }
});

// --- Explore Search ---

function renderSearchDraftControlHtml() {
  const clearSvg =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  return `
    <div class="search-draft-control" id="searchDraftControl">
      <input type="search" class="search-draft-input" id="searchDraftInput" placeholder="${SEARCH_INPUT_PLACEHOLDER}" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none">
      <svg class="content-search-spinner" id="contentSearchSpinner" viewBox="0 0 100 34" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="98" height="32" rx="16"></rect>
      </svg>
      <button class="search-draft-clear" id="searchDraftClearBtn" type="button" title="${escapeHtml(tr('desktopClearSearch', 'Clear search'))}" aria-label="${escapeHtml(tr('desktopClearSearch', 'Clear search'))}">${clearSvg}</button>
    </div>
  `;
}

function ensureFilterPanelRendered(container) {
  const panel = container.querySelector('#filterPanel');
  if (!panel || panel.dataset.hydrated === 'true') return;
  panel.innerHTML = renderFilterPanelHtml();
  panel.dataset.hydrated = 'true';
}

function refreshFilterPanelIfHydrated() {
  const container = document.getElementById('listQueryBuilder');
  const panel = container?.querySelector('#filterPanel');
  if (!container || !panel || panel.dataset.hydrated !== 'true') return;
  panel.innerHTML = renderFilterPanelHtml();
  if (filterVisible) bindFilterEvents(container);
}

function renderSearchPanel({ deferFilterPanel = false } = {}) {
  const container = document.getElementById('listQueryBuilder');
  container.style.display = 'block';

  const filterSvg =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';

  let html = '<div class="search-filters-panel" id="searchFiltersPanel">';
  html += '<div class="search-draft">';
  html += renderSearchDraftControlHtml();
  html += `<button class="filter-toggle-btn${filterVisible ? ' active' : ''}${!isDefaultFilterState(filterState) ? ' has-filters' : ''}" id="filterToggleBtn" title="${escapeHtml(tr('desktopFilters', 'Filters'))}">${filterSvg}</button>`;
  html += '</div>';

  const shouldDeferFilterPanel = deferFilterPanel && !filterVisible;
  html += `<div class="filter-panel" id="filterPanel" data-hydrated="${shouldDeferFilterPanel ? 'false' : 'true'}" style="display:${filterVisible ? 'flex' : 'none'}">`;
  html += shouldDeferFilterPanel ? '' : renderFilterPanelHtml();
  html += '</div>';

  html += '</div>';

  container.innerHTML = html;
  syncSearchSpinnerGeometry();
  const draftEl = container.querySelector('#searchDraftInput');
  if (draftEl) draftEl.value = draftSearchInput;
  updateSearchDraftClearButton(container);
  bindSearchEvents(container);
  if (filterVisible) bindFilterEvents(container);
}

function renderFilterPanelHtml() {
  const hasFilters = !isDefaultFilterState(filterState);
  let html = `<div class="filter-panel-header"><div class="filter-panel-title">${escapeHtml(tr('desktopFilters', 'Filters'))}</div><button class="filter-clear-btn" id="filterClearBtn" type="button"${hasFilters ? '' : ' disabled'}>${escapeHtml(tr('commonClear', 'Clear'))}</button></div>`;
  const isListView = activeView.type === 'list';

  // Sort toggle (list view only)
  if (isListView) {
    const sortOptions = [
      { key: 'lastVisit', label: tr('desktopLastVisit', 'Last visit') },
      { key: 'firstVisit', label: tr('desktopFirstVisit', 'First visit') },
      { key: 'pinTime', label: tr('desktopPinTime', 'Pin time') },
      { key: 'title', label: tr('desktopColumnTitle', 'Title') },
      { key: 'totalVisits', label: tr('desktopVisits', 'Visits') },
    ];
    const currentSort = relatedSortState.column || 'lastVisit';
    html += `<div class="filter-section"><div class="filter-section-label">${escapeHtml(tr('desktopSortBy', 'Sort by'))}</div>`;
    html += '<div class="sort-toggle">';
    for (const opt of sortOptions) {
      html += `<button class="sort-toggle-option${currentSort === opt.key ? ' active' : ''}" data-sort="${opt.key}">${escapeHtml(opt.label)}</button>`;
    }
    html += '</div></div>';
  }

  // Device bubbles
  const deviceIds = [...new Set(historyState.devices)].sort();
  if (deviceIds.length > 1) {
    html += `<div class="filter-section"><div class="filter-section-label">${escapeHtml(tr('desktopDevices', 'Devices'))}</div>`;
    html += '<div class="filter-bubbles">';
    for (const did of deviceIds) {
      const active = filterState.devices?.[did] === true;
      html += `<button class="filter-bubble${active ? ' active' : ''}" data-device-id="${escapeHtml(did)}">${escapeHtml(did)}</button>`;
    }
    html += '</div></div>';
  }

  // Page-specific booleans
  html += `<div class="filter-section"><div class="filter-section-label">${escapeHtml(tr('desktopPageProperties', 'Page properties'))}</div>`;
  html += '<div class="filter-checkboxes">';
  html += renderCheckboxFilter(
    'hasHighlights',
    tr('desktopHasHighlights', 'Has highlights'),
    filterState.hasHighlights,
  );
  html += renderCheckboxFilter(
    'hasSnapshots',
    tr('desktopHasSnapshots', 'Has snapshots'),
    filterState.hasSnapshots,
  );
  html += renderCheckboxFilter(
    'liked',
    tr('extensionLiked', 'Liked'),
    filterState.liked,
  );
  html += renderCheckboxFilter(
    'visitedMultipleTimes',
    tr('desktopVisitedMultipleTimes', 'Visited on multiple days'),
    filterState.visitedMultipleTimes,
  );
  html += '</div>';
  html += '</div>';

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

function updateSearchDraftClearButton(container = document) {
  const draftInput = container.querySelector('#searchDraftInput');
  const clearBtn = container.querySelector('#searchDraftClearBtn');
  if (!draftInput || !clearBtn) return;
  clearBtn.classList.toggle('visible', Boolean(draftInput.value));
}

function showSearchDraftEmptyResults() {
  if (activeView.type !== 'explore' && activeView.type !== 'list') return;
  searchDraftPreviewActive = true;
  cancelActiveHistorySearch();
  clearProgressiveSearchState();

  const relatedContainer = document.getElementById('relatedResults');
  if (relatedContainer) {
    disableRelatedVirtualScrollerForDirectRender(relatedContainer);
    relatedContainer.dataset.searchCount = '0';
    relatedContainer.innerHTML = '';
  }
  const relatedChart = document.getElementById('relatedChart');
  if (relatedChart) relatedChart.classList.remove('visible');
}

function focusSearchDraftInputWithoutDraftMode() {
  const nextInput = document.querySelector('#searchDraftInput');
  if (!nextInput) return;
  if (document.activeElement === nextInput) return;
  nextInput.focus({ preventScroll: true });
}

async function clearSearchDraft(container) {
  await restoreDefaultSearchResults(container, { focusInput: true });
}

async function restoreDefaultSearchResults(
  container,
  { focusInput = false } = {},
) {
  committedSearchQuery = '';
  draftSearchInput = '';
  searchDraftPreviewActive = false;
  pendingSearchClearScrollAnchor = null;
  cancelActiveHistorySearch();
  clearProgressiveSearchState();
  const draftInput = container.querySelector('#searchDraftInput');
  if (draftInput) draftInput.value = '';
  updateSearchDraftClearButton(container);
  saveSearchQuery();
  runActiveSearchPipeline();
  if (focusInput) focusSearchDraftInputWithoutDraftMode();
}

async function exitSearchDraftFocus(container) {
  const draftInput = container.querySelector('#searchDraftInput');
  if (draftInput && document.activeElement === draftInput) {
    draftInput.blur();
  }
  await restoreDefaultSearchResults(container);
}

function activeSearchDraftOutsideTarget(target) {
  if (!searchDraftPreviewActive) return null;
  const activeInput = document.getElementById('searchDraftInput');
  if (!activeInput || document.activeElement !== activeInput) return null;
  if (target?.closest?.('.search-draft-control')) return null;
  return activeInput;
}

function bindSearchDraftOutsideClickExit() {
  if (searchDraftOutsideClickBound) return;
  searchDraftOutsideClickBound = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      const activeInput = activeSearchDraftOutsideTarget(e.target);
      if (!activeInput) return;
      if (activeInput.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        activeInput.focus({ preventScroll: true });
        return;
      }
      activeInput.blur();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const activeInput = activeSearchDraftOutsideTarget(e.target);
      if (!activeInput || !activeInput.value.trim()) return;
      e.preventDefault();
      e.stopPropagation();
      activeInput.focus({ preventScroll: true });
    },
    true,
  );
}

function commitSearchDraft(draftInput) {
  const nextQuery = draftInput.value.trim();
  const previousQuery = committedSearchQuery.trim();
  const hadQuery = Boolean(previousQuery);
  if (nextQuery === previousQuery && !searchDraftPreviewActive) return;
  if (nextQuery) pendingSearchClearScrollAnchor = null;
  committedSearchQuery = nextQuery;
  draftSearchInput = nextQuery;
  searchDraftPreviewActive = false;
  if (hadQuery && !committedSearchQuery) {
    runActiveSearchPipeline._preserveScroll = true;
  }
  renderSearchPanel();
  saveSearchQuery();
  runActiveSearchPipeline();
  focusSearchDraftInputWithoutDraftMode();
}

function bindSearchEvents(container) {
  // Draft input — search/filter only after Enter commits the query.
  const draftInput = container.querySelector('#searchDraftInput');
  if (draftInput) {
    draftInput.addEventListener('click', () => {
      showSearchDraftEmptyResults();
    });
    draftInput.addEventListener('input', () => {
      if (committedSearchQuery.trim() && !draftInput.value.trim()) {
        pendingSearchClearScrollAnchor = captureRelatedDomScrollAnchor(
          document.getElementById('relatedResults'),
        );
      }
      draftSearchInput = draftInput.value;
      updateSearchDraftClearButton(container);
      showSearchDraftEmptyResults();
    });
    draftInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        await exitSearchDraftFocus(container);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commitSearchDraft(draftInput);
      }
    });
    draftInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (!searchDraftPreviewActive) return;
        const nextFocus = document.activeElement;
        if (nextFocus?.closest?.('.search-draft-control')) return;
        restoreDefaultSearchResults(container).catch((error) => {
          logDebug(
            '[search] restore default after blur failed:',
            error.message,
          );
        });
      }, 0);
    });
  }

  const clearDraftBtn = container.querySelector('#searchDraftClearBtn');
  if (clearDraftBtn) {
    clearDraftBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearDraftBtn.addEventListener('click', async () => {
      await clearSearchDraft(container);
    });
  }

  bindSearchDraftOutsideClickExit();

  // Filter toggle
  const filterBtn = container.querySelector('#filterToggleBtn');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      filterVisible = !filterVisible;
      const panel = container.querySelector('#filterPanel');
      if (panel) {
        if (filterVisible) ensureFilterPanelRendered(container);
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
    clearBtn.addEventListener('click', () => {
      if (isDefaultFilterState(filterState)) return;
      filterState = createDefaultFilterState();
      saveFilterState();
      renderSearchPanel();
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

  // Device filter bubbles
  container
    .querySelectorAll('.filter-bubble[data-device-id]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const deviceId = btn.dataset.deviceId;
        if (filterState.devices[deviceId] === true) {
          delete filterState.devices[deviceId];
          btn.classList.remove('active');
        } else {
          filterState.devices[deviceId] = true;
          btn.classList.add('active');
        }
        saveFilterState();
        updateFilterPanelActions(container);
        runActiveSearchPipeline();
      });
    });
}

// Entity-scan filter: scan page checkpoints instead of all history JSONL files.
// Page projections contain the materialized visit state and page properties
// needed by filters without loading raw event logs.
async function runEntityScanFilter(pinnedSlugs) {
  showSearchSpinner();
  const contexts = await loadAllPageContext();
  const pages = Object.fromEntries(
    Object.entries(contexts).map(([slug, context]) => [slug, context.page]),
  );
  const slugs = Object.keys(contexts);

  // Build display rows from page entities
  const seenUrls = new Set();
  const results = [];

  for (const slug of slugs) {
    const page = pages[slug];
    if (pinnedSlugs.has(slug)) continue;
    if (seenUrls.has(page.url)) continue;
    seenUrls.add(page.url);

    const timestamps = page.timestamps;
    const deviceTimestamps = Object.values(timestamps);
    const latestTs =
      deviceTimestamps.length > 0
        ? Math.max(...deviceTimestamps)
        : page.createdAt;
    if (!Number.isFinite(latestTs) || latestTs <= 0) {
      throw new Error(`Page ${slug} has no canonical timestamp`);
    }

    const d = new Date(latestTs);
    const day =
      d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

    const notes = contexts[slug].notes;

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
      visitDates: page.visitDates,
      latestTs,
      deviceIds: new Set(Object.keys(timestamps)),
      hasSnapshots: page.hasSnapshots === true,
      listSlugs: contexts[slug].lists.map((list) => list.slug),
      likes: page.likes,
      createdAt: page.createdAt,
      hasHighlightNotes: notes.length > 0,
      visitCount: page.visitDates.length,
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
    // Page projections are the authoritative filter input.
    results = await runEntityScanFilter(pinnedSlugs);
    entityScanUsed = true;
    results = applyFilters(results);
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
    relatedContainer.innerHTML = `<div class="no-results">${escapeHtml(tr('desktopNoResults', 'No results'))}</div>`;
    document.getElementById('relatedChart').classList.remove('visible');
    return;
  }

  const effectiveSort = relatedSortState.column
    ? relatedSortState
    : { column: 'lastVisit', direction: 'desc' };
  const sorted = applySortOrder(results, effectiveSort);
  const maxAtt = Math.max(...sorted.map((r) => r.attScore), 0.1);

  const directRenderAnchor = preserveRelatedScrollOnNextRender
    ? pendingSearchClearScrollAnchor ||
      captureRelatedDomScrollAnchor(relatedContainer)
    : null;
  pendingSearchClearScrollAnchor = null;
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
      hasSnapshots: r.hasSnapshots,
      listSlugs: r.listSlugs,
      likes: r.likes,
      hasHighlightNotes: r.hasHighlightNotes,
    });
  if (renderAtTop) {
    vs.updateDataAtTop(sorted, renderRow);
  } else {
    vs.updateData(sorted, renderRow, { preserveScroll });
  }
  if (preserveScroll && directRenderAnchor) {
    restoreRelatedDomScrollAnchor(relatedContainer, directRenderAnchor);
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
              newResults = applyFilters(newResults);
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
    tr('desktopExploreResults', 'Explore results'),
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
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div></div></div>`;
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
      const projection = await loadListDisplay(listId);
      if (!projection) throw new Error(`List not found: ${listId}`);
      pins = projection.pins;
      allListPins[listId] = pins;
    }

    let html = '';

    // Pinned pages section
    html += `<div class="focus-section"><div class="focus-section-label">${escapeHtml(tr('desktopPinned', 'Pinned'))}</div><div class="focus-section-cards">`;
    if (pins.length === 0) {
      html += `<div class="focus-empty">${escapeHtml(tr('desktopNoPinnedPages', 'No pinned pages'))}</div>`;
    } else {
      const maxAtt = 0.1;
      const { pinsResolved } = await resolvePinsForDisplay(pins);
      html += pinsResolved
        .map((r) => {
          const title = r.user_title || r.title || r.url;
          return resultRowHtml(title, r.url, {
            deletable: false,
            attScore: 0,
            maxAtt,
            timestamps: [r.pinnedAt || Date.now()],
            visitDates: r.visitDates,
            context: 'global',
            pinSource: r.source || null,
            hasSnapshots: r.hasSnapshots,
            listSlugs: r.listSlugs,
          });
        })
        .join('');
    }
    html += '</div></div>';

    content.innerHTML = html;

    // Bind event delegation for focus content cards
    bindFocusContentDelegation(content);
  } catch (error) {
    content.innerHTML = `<div class="focus-section"><div class="focus-section-label"></div><div class="focus-section-cards"><div class="focus-empty">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div></div></div>`;
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
  html += `<div class="focus-section"><div class="focus-section-label">${escapeHtml(tr('desktopParents', 'Parents'))}</div><div class="focus-section-cards">`;
  const hasParents = parents.referrers.length + parents.lists.length > 0;
  if (!hasParents) {
    html += `<div class="focus-empty">${escapeHtml(tr('desktopNoKnownParents', 'No known parents'))}</div>`;
  } else {
    html += parents.referrers.map((ref) => makeCard(ref, null)).join('');
  }
  html += '</div></div>';

  // Focused page
  html += `<div class="focus-section"><div class="focus-section-label">${escapeHtml(tr('desktopFocus', 'Focus'))}</div><div class="focus-section-cards">`;
  html += makeCard(url, title, { cssClass: 'focus-highlight' });
  html += '</div></div>';

  // Children section
  html += `<div class="focus-section"><div class="focus-section-label">${escapeHtml(tr('desktopChildren', 'Children'))}</div><div class="focus-section-cards">`;
  if (children.length === 0) {
    html += `<div class="focus-empty">${escapeHtml(tr('desktopNoKnownChildren', 'No known children'))}</div>`;
  } else {
    html += children.map((childUrl) => makeCard(childUrl, null)).join('');
  }
  html += '</div></div>';

  // Similar section
  if (similar.length > 0) {
    html += `<div class="focus-section"><div class="focus-section-label">${escapeHtml(tr('desktopSimilar', 'Similar'))}</div><div class="focus-section-cards">`;
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
      syncSearchSpinnerGeometry();
    };
    const onUp = () => {
      handle.classList.remove('active');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.session
        .set({ sidebarWidth: sidebar.offsetWidth })
        .catch((error) =>
          surfaceBackgroundError('Could not save sidebar width', error),
        );
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
    if (
      e.target.closest(
        '.sidebar-item, .explore-btn, .highlights-history-btn, .recycle-btn',
      )
    ) {
      sidebar.classList.remove('sidebar-open');
    }
  });
}

async function restoreSidebarWidth() {
  const { sidebarWidth } = await chrome.storage.session.get(['sidebarWidth']);
  if (sidebarWidth !== undefined) {
    if (!Number.isFinite(sidebarWidth) || sidebarWidth <= 0) {
      throw new Error('Stored sidebar width must be a positive number');
    }
    const sidebar = document.querySelector('.sidebar');
    sidebar.style.width = sidebarWidth + 'px';
    sidebar.style.minWidth = sidebarWidth + 'px';
  }
}

// ─── Onboarding ─────────────────────────────────────────────────────

async function showOnboarding() {
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
  applyDesktopConnectorUi();
  await initializeOnboardingLaunchAtLogin();

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
  if (typeof window.browserRecallDesktopPlatformReady?.then !== 'function') {
    throw new Error(
      'Desktop platform adapter did not expose its ready promise',
    );
  }
  await window.browserRecallDesktopPlatformReady;
  bindWindowDragRegions();
  await initializeDesktopLocalization();
  // Apply theme before any rendering to minimize flash
  let currentTheme = await applyTheme();

  const deviceResp = await loadDeviceIdentity();
  if (!deviceResp.setupComplete) {
    await showOnboarding();
    markShellReady();
    await updateStorageStatus();
    markAppReady();
    return;
  }

  await initializeMain(currentTheme, deviceResp);
}

function settingsValue(settings, key) {
  if (!Object.prototype.hasOwnProperty.call(settings, key)) {
    throw new Error(`Desktop settings response is missing ${key}`);
  }
  return settings[key];
}

async function hydrateStartupSettings(currentTheme) {
  const settings = await loadSettings();
  await initializeDesktopLocalization({
    localeOverride: settingsValue(settings, 'localeOverride'),
  });
  const persistedTheme = settingsValue(settings, 'theme');
  await chrome.storage.session.set({ theme: persistedTheme });
  currentTheme = await applyTheme();
  document.getElementById('themeSelect').value = currentTheme;

  const savedScheme = settingsValue(settings, 'colorScheme');
  applyColorScheme(savedScheme);
  await chrome.storage.session.set({ colorScheme: savedScheme });

  historyState.fileBatch = settingsValue(settings, 'historyFileBatch');
  document.getElementById('historyFileBatch').value = historyState.fileBatch;
  document.getElementById('captureSnapshotVideo').checked = settingsValue(
    settings,
    'captureSnapshotVideo',
  );

  const blacklistEnabled = settingsValue(settings, 'blacklistEnabled');
  document.getElementById('blacklistEnabled').checked = blacklistEnabled;
  setAddonOpen(document.getElementById('blacklistBody'), blacklistEnabled);

  const titleCleanupEnabled = settingsValue(settings, 'titleCleanupEnabled');
  document.getElementById('titleCleanupEnabled').checked = titleCleanupEnabled;
  setAddonOpen(
    document.getElementById('titleCleanupBody'),
    titleCleanupEnabled,
  );

  const syncEnabled = settingsValue(settings, 'syncEnabled');
  document.getElementById('syncEnabled').checked = syncEnabled;
  setAddonOpen(document.getElementById('syncConfigFields'), syncEnabled);
  document.getElementById('syncIntervalMinutes')?.closest('.option')?.remove();
  document.getElementById('syncMethod').value = 'github';
  document.getElementById('syncRepoUrl').value = settingsValue(
    settings,
    'syncRepoUrl',
  );
  document.getElementById('syncRetentionDays').value = settingsValue(
    settings,
    'syncRetentionDays',
  );

  const authState = await sendAction({ action: 'getSyncAuthState' });
  if (typeof authState.hasToken !== 'boolean') {
    throw new Error('Sync auth response hasToken must be a boolean');
  }
  if (typeof authState.rememberToken !== 'boolean') {
    throw new Error('Sync auth response rememberToken must be a boolean');
  }
  if (authState.hasToken) {
    const user = authState.githubUser ? `as @${authState.githubUser}` : '';
    syncShowAuthState('connected', user);
  } else {
    syncShowAuthState('disconnected');
  }
  document.getElementById('syncRememberToken').checked =
    authState.rememberToken;

  renderBlacklist();
  renderTrimRules();
  if (syncEnabled) refreshSyncDevices();
}

async function initializeMain(currentTheme, deviceResp = null) {
  // Apply theme if not already done (e.g. coming from onboarding)
  if (!currentTheme) currentTheme = await applyTheme();

  const _t0 = performance.now();
  const _timer = (label) =>
    logDebug(
      `[init-timer] ${label}: ${(performance.now() - _t0).toFixed(0)}ms`,
    );

  // Check for service downtime (paused state) and show error banner if set.
  const [{ serviceError }, connector] = await Promise.all([
    chrome.storage.session.get(['serviceError']),
    loadDesktopConnectorState(),
  ]);
  let svcErr = serviceError;
  if (connector.state === 'paused') {
    if (!connector.lastError || !connector.lastErrorCode) {
      throw new Error('Paused desktop service is missing its diagnostic');
    }
    svcErr = {
      code: connector.lastErrorCode,
      message: connector.lastError,
    };
  }
  if (svcErr) {
    showServiceErrorBanner(svcErr);
  }
  if (connector.state === 'paused') {
    markShellReady();
    markAppReady();
    return;
  }

  // Verify device identity from daemon app config.
  deviceResp ||= await loadDeviceIdentity();
  if (!deviceResp.setupComplete) {
    throw new Error(
      tr(
        'desktopDeviceIdentityRestart',
        'Device identity unavailable. Try restarting Browser Recall.',
      ),
    );
  }

  // Theme select — reflects current value from applyTheme()
  document.getElementById('themeSelect').value = currentTheme;
  document.getElementById('syncIntervalMinutes')?.closest('.option')?.remove();

  // Initialize chart tooltips
  initCharts();
  _timer('initCharts');

  // Load fold state and restore sidebar width before rendering lists
  await loadFoldState();
  await restoreSidebarWidth();
  initSidebarResize();
  initSidebarToggle();
  _timer('sidebarInit');

  // Render sidebar concurrently with heavy data (don't block on sidebar)
  void renderLists().catch((err) => showFatalError(err.message));
  initRulesPanel();
  _timer('renderSidebar (fire-and-forget)');

  // Paint the main shell before daemon-backed settings and history hydration.
  updateRecycleBinBadge();
  await showExplore({ hydrate: false, markReady: false });

  try {
    await hydrateStartupSettings(currentTheme);
    _timer('hydrateSettings');
  } catch (error) {
    logDebug('[startup] settings hydration failed:', error.message);
    showFatalError(error.message);
  }

  try {
    await hydrateExploreSearchResults();
    _timer('hydrateExploreSearchResults');
  } catch (error) {
    logDebug('[startup] explore hydration failed:', error.message);
    document.getElementById('relatedResults').innerHTML =
      `<div class="no-results">${escapeHtml(tr('desktopErrorPrefix', `Error: ${error.message}`, [error.message]))}</div>`;
  }

  markAppReady();
  await applyPendingShellRoute();
}

initialize().catch((err) => {
  markShellReady();
  markAppReady();
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
    showInfoBubble(tr('desktopCannotDeleteHistory', 'Cannot delete history'));
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
      showInfoBubble(
        tr('desktopCanOnlyPasteIntoList', 'Can only paste into a list'),
      );
      return;
    }

    e.preventDefault();
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (error) {
      showErrorBubble(
        tr('desktopErrorPrefix', `Could not read clipboard: ${error.message}`, [
          error.message,
        ]),
        { suffix: '' },
      );
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
        showErrorBubble(
          tr(
            'desktopTooManyResults',
            'Too many results to select (limit: 100)',
          ),
          {
            suffix: '',
          },
        );
      } else {
        if (relatedVirtualScroller) {
          relatedVirtualScroller.selectAll();
        } else {
          getActiveContainer()
            ?.querySelectorAll('.result-row')
            .forEach((row) => row.classList.add('selected'));
        }
        syncChartHighlights();
      }
    } else {
      showBlockedBubble(
        tr('desktopSelectAllUnavailable', 'Select all is not available here'),
      );
    }
  }
});
