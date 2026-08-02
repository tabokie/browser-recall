export function createBadgeController({
  api = chrome,
  logDebug = () => {},
  normalIconPaths,
  stoppedRecordingIconPaths = normalIconPaths,
  specialListIconPaths = normalIconPaths,
  specialNoteIconPaths = normalIconPaths,
  specialMixedIconPaths = normalIconPaths,
  readPageMarkers,
  readRecordingPausedState = async () => false,
  resolveTabUrl = (_tabId, url) => url,
  getBadgeAccentColor = async () => '#078C9B',
}) {
  const tr = (key, fallback, substitutions) =>
    api.i18n?.getMessage?.(
      key,
      substitutions === undefined
        ? undefined
        : Array.isArray(substitutions)
          ? substitutions
          : [substitutions],
    ) || fallback;
  let connectorState = { state: 'starting' };
  let globalConnectorBadgeActive = false;
  let recordingPaused = false;
  let recordingPauseHydrated = false;
  let servicePaused = false;
  let servicePauseTitle = tr(
    'extensionBrowserRecallPaused',
    'Browser Recall is paused',
  );
  let spinnerInterval = null;

  async function queryActiveTab() {
    const [tab] = await api.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab;
  }

  async function applyRecordingPausedBadge(tabId) {
    await api.action.setTitle({
      title: tr(
        'extensionBrowserRecallRecordingPaused',
        'Browser Recall recording is paused',
      ),
      ...(tabId ? { tabId } : {}),
    });
    await api.action.setBadgeText({ text: '', ...(tabId ? { tabId } : {}) });
    await api.action.setIcon({
      path: stoppedRecordingIconPaths,
      ...(tabId ? { tabId } : {}),
    });
  }

  async function applyServicePausedBadge(tabId) {
    await api.action.setTitle({
      title: servicePauseTitle,
      ...(tabId ? { tabId } : {}),
    });
    await api.action.setIcon({
      path: normalIconPaths,
      ...(tabId ? { tabId } : {}),
    });
    await api.action.setBadgeBackgroundColor({
      color: '#B85040',
      ...(tabId ? { tabId } : {}),
    });
    await api.action.setBadgeText({
      text: '!',
      ...(tabId ? { tabId } : {}),
    });
  }

  async function hydrateRecordingPauseState() {
    if (recordingPauseHydrated) return;
    try {
      recordingPaused = (await readRecordingPausedState()) === true;
      recordingPauseHydrated = true;
      if (recordingPaused) await applyRecordingPausedBadge();
    } catch (error) {
      logDebug('[badge] recording pause hydrate failed:', error.message);
    }
  }

  function isConnectorUsable(connector = connectorState) {
    return connector?.state === 'connected' && Boolean(connector.deviceId);
  }

  function shouldShowConnectorBadge(connector = connectorState) {
    if (isConnectorUsable(connector)) return false;
    if (
      ['starting', 'connecting'].includes(connector.state) &&
      ['socket_closed', 'manual_reconnect_exhausted'].includes(
        connector.lastDiagnostic?.code,
      )
    ) {
      return true;
    }
    return ['offline', 'auth_failed', 'pair_denied', 'paused'].includes(
      connector.state,
    );
  }

  function shouldClearConnectorBadge(connector = connectorState) {
    return ['connected', 'pair_pending'].includes(connector.state);
  }

  function desktopConnectorBadgeTitle(connector = {}) {
    if (connector.lastError) return connector.lastError;
    switch (connector.state) {
      case 'connected':
        return tr(
          'extensionBrowserRecallDesktopConnected',
          'Browser Recall Desktop connected',
        );
      case 'pair_pending':
        return tr(
          'extensionBrowserRecallApprovalPending',
          'Browser Recall Desktop approval pending',
        );
      case 'pair_denied':
        return tr(
          'extensionBrowserRecallApprovalDenied',
          'Browser Recall Desktop approval denied',
        );
      case 'auth_failed':
        return tr(
          'extensionBrowserRecallTokenRejected',
          'Browser Recall Desktop token rejected',
        );
      case 'paused':
        return tr(
          'extensionBrowserRecallDesktopPaused',
          'Browser Recall Desktop is paused',
        );
      case 'connecting':
      case 'starting':
        return tr(
          'extensionLookingForDesktop',
          'Looking for Browser Recall Desktop',
        );
      case 'offline':
      default:
        return tr(
          'extensionBrowserRecallDesktopOffline',
          'Browser Recall Desktop is offline',
        );
    }
  }

  async function clearGlobalConnectorBadge() {
    await hydrateRecordingPauseState();
    if (recordingPaused) return;
    if (servicePaused) return;
    await api.action.setTitle({
      title: tr('extensionName', 'Browser Recall'),
    });
    await api.action.setBadgeText({ text: '' });
    await api.action.setIcon({ path: normalIconPaths });
    globalConnectorBadgeActive = false;
  }

  async function clearActivePageMarker({ inheritGlobalBadge = false } = {}) {
    try {
      const tab = await queryActiveTab();
      if (tab?.id > 0)
        await clearPageMarkerBadge(tab.id, { inheritGlobalBadge });
    } catch (error) {
      logDebug('[badge] active page marker clear failed:', error.message);
    }
  }

  async function applyGlobalConnectorBadge(connector) {
    await hydrateRecordingPauseState();
    if (recordingPaused) return;
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
    await hydrateRecordingPauseState();
    if (recordingPaused) return;
    if (servicePaused) return;
    if (shouldShowConnectorBadge(connector)) {
      await applyGlobalConnectorBadge(connector);
      return;
    }
    if (shouldClearConnectorBadge(connector)) {
      await clearGlobalConnectorBadge();
      if (isConnectorUsable(connector)) await refreshActiveTabBadge();
    }
  }

  async function clearPageMarkerBadge(
    tabId,
    { inheritGlobalBadge = false } = {},
  ) {
    await hydrateRecordingPauseState();
    if (recordingPaused) {
      await applyRecordingPausedBadge(tabId);
      return;
    }

    if (servicePaused) {
      await applyServicePausedBadge(tabId);
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

    await api.action.setTitle({
      title: tr('extensionName', 'Browser Recall'),
      tabId,
    });
    await api.action.setBadgeText({
      text: '',
      tabId,
    });
    await api.action.setIcon({ path: normalIconPaths, tabId });
  }

  function pageMarkerIconPaths({ hasNotes, hasLists } = {}) {
    if (hasNotes && hasLists) return specialMixedIconPaths;
    if (hasNotes) return specialNoteIconPaths;
    if (hasLists) return specialListIconPaths;
    return normalIconPaths;
  }

  async function applyPageMarkerBadge(tabId, iconPaths) {
    await hydrateRecordingPauseState();
    if (recordingPaused) {
      await applyRecordingPausedBadge(tabId);
      return;
    }
    if (servicePaused) return;
    await api.action.setBadgeText({ text: '', tabId });
    await api.action.setIcon({ path: iconPaths, tabId });
  }

  async function applyPageMarkerErrorBadge(tabId, error) {
    await hydrateRecordingPauseState();
    if (recordingPaused) {
      await applyRecordingPausedBadge(tabId);
      return;
    }
    if (servicePaused) {
      await applyServicePausedBadge(tabId);
      return;
    }
    const unavailableTitle = tr(
      'extensionDesktopPageDataUnavailable',
      'Browser Recall page state unavailable',
    );
    const message = error?.message || unavailableTitle;
    await api.action.setTitle({
      title: `${unavailableTitle}: ${message}`,
      tabId,
    });
    await api.action.setBadgeBackgroundColor({
      color: '#B85040',
      tabId,
    });
    await api.action.setBadgeText({ text: '!', tabId });
    await api.action.setIcon({ path: normalIconPaths, tabId });
  }

  function isPageBadgeUrl(url) {
    return typeof url === 'string' && url.startsWith('http');
  }

  async function updateBadgeForTab(tabId, url) {
    try {
      const badgeUrl = await resolveTabUrl(tabId, url);
      if (!isPageBadgeUrl(badgeUrl)) {
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
      const markers = await readPageMarkers(badgeUrl);
      if (!markers) {
        await clearPageMarkerBadge(tabId);
        return;
      }
      const { hasNotes, hasLists } = markers;
      if (!hasNotes && !hasLists) {
        await clearPageMarkerBadge(tabId);
        return;
      }
      await applyPageMarkerBadge(
        tabId,
        pageMarkerIconPaths({ hasNotes, hasLists }),
      );
    } catch (error) {
      logDebug('[badge] page badge update failed:', error.message);
      try {
        await applyPageMarkerErrorBadge(tabId, error);
      } catch (badgeError) {
        logDebug('[badge] page badge error state failed:', badgeError.message);
      }
    }
  }

  function collectBadgeUrlsFromEntry(entry) {
    const urls = new Set();
    if (entry?.url?.startsWith('http')) urls.add(entry.url);
    for (const url of entry.urls ?? []) {
      if (typeof url === 'string' && url.startsWith('http')) urls.add(url);
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
      const tab = await queryActiveTab();
      if (tab?.id > 0) void updateBadgeForTab(tab.id, tab.url);
    } catch (error) {
      logDebug('[badge] active-tab badge refresh failed:', error.message);
    }
  }

  async function refreshActiveTabBadge() {
    try {
      const tab = await queryActiveTab();
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
    await hydrateRecordingPauseState();
    servicePaused = true;
    servicePauseTitle = title || servicePauseTitle;
    if (recordingPaused) {
      await applyRecordingPausedBadge();
      await clearActivePageMarker();
      return;
    }
    await applyServicePausedBadge();
    await clearActivePageMarker();
  }

  async function setServiceActive() {
    await hydrateRecordingPauseState();
    servicePaused = false;
    await clearGlobalConnectorBadge();
    await setConnectorState(connectorState);
    if (isConnectorUsable(connectorState)) await refreshActiveTabBadge();
  }

  async function setRecordingPaused(paused) {
    recordingPauseHydrated = true;
    recordingPaused = paused === true;
    if (recordingPaused) {
      await applyRecordingPausedBadge();
      await clearActivePageMarker();
      return;
    }
    if (servicePaused) {
      await applyServicePausedBadge();
      await clearActivePageMarker();
      return;
    }
    await api.action.setIcon({ path: normalIconPaths });
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
    setRecordingPaused,
    setServiceActive,
    setServicePaused,
    startSpinnerBadge,
    stopSpinnerBadge,
    updateBadgeForTab,
  };
}
