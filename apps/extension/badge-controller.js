import { getBrowserCapabilities } from './browser-capabilities.js';

const FIREFOX_PAGE_MARKER_ICON_SIZES = [16, 48, 128];

export function createBadgeController({
  api = chrome,
  capabilities = getBrowserCapabilities(),
  logDebug = () => {},
  normalIconPaths,
  syncDesktopConnectorPauseState,
  readCacheable,
  generateSlugFromUrl,
  pageKey,
  notePrefix,
  snapshotPrefix,
  listPrefix,
  getBadgeAccentColor = async () => '#078C9B',
}) {
  let connectorState = { state: 'starting' };
  let globalConnectorBadgeActive = false;
  let servicePaused = false;
  let servicePauseTitle = 'Browser Recall is paused';
  let spinnerInterval = null;
  const firefoxPageMarkerIconCache = new Map();

  function isConnectorUsable(connector = connectorState) {
    return (
      connector?.state === 'connected' &&
      Boolean(connector.deviceId) &&
      !connector.refuseMode
    );
  }

  function shouldShowConnectorBadge(connector = connectorState) {
    if (isConnectorUsable(connector)) return false;
    if (connector.refuseMode) return true;
    if (
      ['starting', 'connecting'].includes(connector.state) &&
      ['socket_closed', 'manual_reconnect_exhausted'].includes(
        connector.lastDiagnostic?.code,
      )
    ) {
      return true;
    }
    return [
      'offline',
      'auth_failed',
      'pair_denied',
      'paused',
    ].includes(connector.state);
  }

  function shouldClearConnectorBadge(connector = connectorState) {
    return ['connected', 'pair_pending'].includes(connector.state);
  }

  function desktopConnectorBadgeTitle(connector = {}) {
    if (connector.refuseMode) return 'Browser Recall Desktop queue is full';
    if (connector.lastError) return connector.lastError;
    switch (connector.state) {
      case 'connected':
        return 'Browser Recall Desktop connected';
      case 'pair_pending':
        return 'Browser Recall Desktop approval pending';
      case 'pair_denied':
        return 'Browser Recall Desktop approval denied';
      case 'auth_failed':
        return 'Browser Recall Desktop token rejected';
      case 'paused':
        return 'Browser Recall Desktop is paused';
      case 'connecting':
      case 'starting':
        return 'Looking for Browser Recall Desktop';
      case 'offline':
      default:
        return 'Browser Recall Desktop is offline';
    }
  }

  async function clearGlobalConnectorBadge() {
    if (servicePaused) return;
    await api.action.setTitle({ title: 'Browser Recall' });
    await api.action.setBadgeText({ text: '' });
    await api.action.setIcon({ path: normalIconPaths });
    globalConnectorBadgeActive = false;
  }

  async function clearActivePageMarker({ inheritGlobalBadge = false } = {}) {
    try {
      const [tab] = await api.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id > 0) await clearPageMarkerBadge(tab.id, { inheritGlobalBadge });
    } catch (error) {
      logDebug('[badge] active page marker clear failed:', error.message);
    }
  }

  async function applyGlobalConnectorBadge(connector) {
    if (servicePaused) return;
    await api.action.setTitle({
      title: desktopConnectorBadgeTitle(connector),
    });
    await api.action.setBadgeBackgroundColor({
      color: '#B85040',
    });
    await api.action.setBadgeText({
      text: '!',
    });
    await api.action.setIcon({
      path: normalIconPaths,
    });
    globalConnectorBadgeActive = true;
    await clearActivePageMarker({ inheritGlobalBadge: true });
  }

  async function setConnectorState(connector = {}) {
    connectorState = connector;
    if (servicePaused) return;
    if (shouldShowConnectorBadge(connector)) {
      await applyGlobalConnectorBadge(connector);
      return;
    }
    if (shouldClearConnectorBadge(connector)) {
      await clearGlobalConnectorBadge();
    }
  }

  async function clearPageMarkerBadge(tabId, { inheritGlobalBadge = false } = {}) {
    if (servicePaused) {
      await api.action.setTitle({ title: servicePauseTitle, tabId });
      await api.action.setBadgeBackgroundColor({
        color: '#B85040',
        tabId,
      });
      await api.action.setBadgeText({ text: '!', tabId });
      await api.action.setIcon({ path: normalIconPaths, tabId });
      return;
    }

    if (inheritGlobalBadge && globalConnectorBadgeActive) {
      await api.action.setTitle({
        title: desktopConnectorBadgeTitle(connectorState),
        tabId,
      });
      await api.action.setBadgeBackgroundColor({
        color: '#B85040',
        tabId,
      });
      await api.action.setBadgeText({
        text: '!',
        tabId,
      });
      await api.action.setIcon({ path: normalIconPaths, tabId });
      return;
    }

    await api.action.setTitle({ title: 'Browser Recall', tabId });
    await api.action.setBadgeText({
      text: '',
      tabId,
    });
    await api.action.setIcon({ path: normalIconPaths, tabId });
  }

  async function applyPageMarkerBadge(tabId, color) {
    if (servicePaused) return;
    if (capabilities.usesIconPageMarker && supportsIconPageMarker()) {
      const imageData = await firefoxPageMarkerIconData(color);
      await api.action.setBadgeText({ text: '', tabId });
      await api.action.setIcon({ imageData, tabId });
      return;
    }
    await api.action.setBadgeBackgroundColor({ color, tabId });
    await api.action.setBadgeText({ text: ' ', tabId });
  }

  function supportsIconPageMarker() {
    return (
      typeof OffscreenCanvas === 'function' ||
      (typeof document !== 'undefined' &&
        typeof document.createElement === 'function')
    );
  }

  async function firefoxPageMarkerIconData(color) {
    if (firefoxPageMarkerIconCache.has(color)) {
      return firefoxPageMarkerIconCache.get(color);
    }
    const imageData = {};
    for (const size of FIREFOX_PAGE_MARKER_ICON_SIZES) {
      imageData[size] = await drawFirefoxPageMarkerIcon(size, color);
    }
    firefoxPageMarkerIconCache.set(color, imageData);
    return imageData;
  }

  async function drawFirefoxPageMarkerIcon(size, color) {
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(size, size)
        : document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    drawBaseIcon(ctx, size);
    const radius = Math.max(4, Math.round(size * 0.21));
    const border = Math.max(1, Math.round(size * 0.04));
    const center = size - radius - border;
    ctx.fillStyle = 'rgba(15, 15, 13, 0.95)';
    ctx.beginPath();
    ctx.arc(center, center, radius + border, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fill();
    return ctx.getImageData(0, 0, size, size);
  }

  function drawBaseIcon(ctx, size) {
    const scale = size / 128;
    const px = (value) => value * scale;
    ctx.fillStyle = '#078C9B';
    ctx.beginPath();
    ctx.arc(px(64), px(64), px(57), 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#F2E8C9';
    ctx.lineWidth = Math.max(2, px(8));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(px(43), px(78));
    ctx.lineTo(px(64), px(52));
    ctx.lineTo(px(88), px(69));
    ctx.stroke();

    drawIconNode(ctx, px(43), px(78), px(14), px(5));
    drawIconNode(ctx, px(64), px(52), px(12), px(4.5));
    drawIconNode(ctx, px(88), px(69), px(13), px(5));
  }

  function drawIconNode(ctx, x, y, outerRadius, innerRadius) {
    ctx.fillStyle = '#F2E8C9';
    ctx.beginPath();
    ctx.arc(x, y, outerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#078C9B';
    ctx.beginPath();
    ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  function isPageBadgeUrl(url) {
    return typeof url === 'string' && url.startsWith('http');
  }

  async function updateBadgeForTab(tabId, url) {
    try {
      if (!isPageBadgeUrl(url)) {
        await clearPageMarkerBadge(tabId, {
          inheritGlobalBadge: globalConnectorBadgeActive,
        });
        return;
      }

      if (!isConnectorUsable()) {
        await clearPageMarkerBadge(tabId, {
          inheritGlobalBadge: globalConnectorBadgeActive,
        });
        return;
      }
      syncDesktopConnectorPauseState(connectorState);

      const slug = generateSlugFromUrl(url);
      const page = await readCacheable(pageKey(slug));
      if (!page) {
        await clearPageMarkerBadge(tabId);
        return;
      }
      const childIds = page.childIds || [];
      const hasNoteRefs = childIds.some((c) => c.startsWith(notePrefix));
      const hasSnapshotRefs = childIds.some((c) => c.startsWith(snapshotPrefix));
      const hasNotes = hasNoteRefs || hasSnapshotRefs;
      const hasLists = page.parentIds?.some((id) => id.startsWith(listPrefix));
      if (!hasNotes && !hasLists) {
        await clearPageMarkerBadge(tabId);
        return;
      }
      const color =
        hasNotes && hasLists ? '#9C27B0' : hasNotes ? '#4A90D9' : '#4CAF50';
      await applyPageMarkerBadge(tabId, color);
    } catch {
      // Non-critical; badge updates should never break navigation.
    }
  }

  function collectBadgeUrlsFromEntry(entry) {
    const urls = new Set();
    if (entry?.url?.startsWith('http')) urls.add(entry.url);
    for (const item of entry?.items || []) {
      if (typeof item === 'string' && item.startsWith('http')) urls.add(item);
    }
    return [...urls];
  }

  async function refreshBadgesForUrls(urls) {
    if (urls.length > 0) {
      try {
        const tabs = await api.tabs.query({ url: urls });
        for (const tab of tabs) {
          if (tab?.id > 0) void updateBadgeForTab(tab.id, tab.url);
        }
      } catch (error) {
        logDebug('[badge] badge query failed:', error.message);
      }
    }

    try {
      const [tab] = await api.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id > 0) void updateBadgeForTab(tab.id, tab.url);
    } catch (error) {
      logDebug('[badge] active-tab badge refresh failed:', error.message);
    }
  }

  async function refreshActiveTabBadge() {
    try {
      const [tab] = await api.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (tab?.id > 0) await updateBadgeForTab(tab.id, tab.url);
    } catch (error) {
      logDebug('[badge] active-tab badge refresh failed:', error.message);
    }
  }

  function refreshBadgesForEntry(entry) {
    const urls = collectBadgeUrlsFromEntry(entry);
    if (urls.length === 0) return;
    void refreshBadgesForUrls(urls);
  }

  function scheduleConnectorBadgeRefresh(connector) {
    void (async () => {
      await setConnectorState(connector);
      if (isConnectorUsable(connector)) await refreshActiveTabBadge();
    })().catch((error) => {
      logDebug('[badge] connector badge refresh failed:', error.message);
    });
  }

  function clearNewTabBadge(tab) {
    if (tab?.id > 0) {
      clearPageMarkerBadge(tab.id, {
        inheritGlobalBadge: globalConnectorBadgeActive,
      }).catch((error) => {
        logDebug('[badge] new-tab badge clear failed:', error.message);
      });
    }
  }

  async function setServicePaused({ title } = {}) {
    servicePaused = true;
    servicePauseTitle = title || servicePauseTitle;
    await api.action.setTitle({ title: servicePauseTitle });
    await api.action.setIcon({ path: normalIconPaths });
    await api.action.setBadgeBackgroundColor({ color: '#B85040' });
    await api.action.setBadgeText({ text: '!' });
    await clearActivePageMarker();
  }

  async function setServiceActive() {
    servicePaused = false;
    await clearGlobalConnectorBadge();
    await setConnectorState(connectorState);
    if (isConnectorUsable(connectorState)) await refreshActiveTabBadge();
  }

  async function startSpinnerBadge(tabId) {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    await api.action.setBadgeBackgroundColor({
      color: await getBadgeAccentColor(),
      tabId,
    });
    await api.action.setBadgeText({ text: frames[0], tabId });
    spinnerInterval = setInterval(() => {
      i = (i + 1) % frames.length;
      api.action
        .setBadgeText({ text: frames[i], tabId })
        .catch((error) =>
          logDebug('[spinner] badge update failed:', error.message),
        );
    }, 100);
  }

  async function stopSpinnerBadge(tabId, url) {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    if (url) {
      await updateBadgeForTab(tabId, url);
      return;
    }
    await api.action.setBadgeText({ text: '', tabId });
  }

  return {
    clearNewTabBadge,
    refreshActiveTabBadge,
    refreshBadgesForEntry,
    refreshBadgesForUrls,
    scheduleConnectorBadgeRefresh,
    setConnectorState,
    setServiceActive,
    setServicePaused,
    startSpinnerBadge,
    stopSpinnerBadge,
    updateBadgeForTab,
  };
}
