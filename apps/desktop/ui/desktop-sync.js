import { sendAction } from './desktop-bridge.js';
import { tr } from '../../../packages/core/i18n.js';

import settingsMarkup from './desktop-sync-markup.js';

export function createDesktopSync({
  saveSettingsValue,
  setAddonOpen,
  settingsValue,
  showStatus,
}) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = './desktop-sync.css';
  document.head.append(stylesheet);
  document.getElementById('desktopSyncSettings').outerHTML = settingsMarkup;

  document.getElementById('syncEnabled').addEventListener('change', () => {
    setAddonOpen(
      document.getElementById('syncConfigFields'),
      document.getElementById('syncEnabled').checked,
    );
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

  document
    .getElementById('syncCancelBtn')
    .addEventListener('click', async () => {
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
          status.textContent = d.paused
            ? tr('desktopPausedLower', 'paused')
            : '';
        } catch (e) {
          showStatus(
            tr('desktopToggleFailed', `Toggle failed: ${e.message}`, [
              e.message,
            ]),
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

  async function restoreSettings(settings) {
    const syncEnabled = settingsValue(settings, 'syncEnabled');
    document.getElementById('syncEnabled').checked = syncEnabled;
    setAddonOpen(document.getElementById('syncConfigFields'), syncEnabled);
    document
      .getElementById('syncIntervalMinutes')
      ?.closest('.option')
      ?.remove();
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
    if (syncEnabled) refreshSyncDevices();
  }

  return { saveSettings: saveSyncSettings, restoreSettings };
}
