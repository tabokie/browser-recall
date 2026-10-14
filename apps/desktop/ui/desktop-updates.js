import { sendAction } from './desktop-bridge.js';

export function createDesktopUpdates({ tr, openSettings, showError }) {
  const notice = document.getElementById('desktopUpdateNotice');
  const check = document.getElementById('desktopUpdateCheck');
  const install = document.getElementById('desktopUpdateInstall');
  const status = document.getElementById('desktopUpdateStatus');
  let current = null;
  let revision = 0;

  function render() {
    if (!current) return;
    document.getElementById('desktopUpdateVersion').textContent =
      current.currentVersion;
    const busy = ['checking', 'downloading', 'installing'].includes(
      current.phase,
    );
    check.disabled = busy;
    install.disabled = busy;
    install.hidden = current.version === null;
    notice.style.display = current.phase === 'available' ? '' : 'none';
    const labels = {
      idle: ['desktopUpdatesAutomatic', 'Checks for updates automatically'],
      checking: ['desktopUpdateChecking', 'Checking for updates…'],
      current: ['desktopUpdateCurrent', 'Browser Recall is up to date'],
      available: ['desktopUpdateAvailable', 'Update available'],
      downloading: ['desktopUpdateDownloading', 'Downloading update…'],
      installing: [
        'desktopUpdateInstalling',
        'Installing update and restarting…',
      ],
    };
    const label = labels[current.phase];
    status.textContent =
      current.phase === 'error' ? current.error : tr(...label);
    if (current.version && current.phase === 'available')
      status.textContent += ` (${current.version})`;
    if (current.phase === 'downloading' && current.totalBytes) {
      status.textContent += ` ${Math.min(100, Math.floor((current.downloadedBytes / current.totalBytes) * 100))}%`;
    }
  }

  function accept(update) {
    if (
      !update ||
      typeof update !== 'object' ||
      typeof update.currentVersion !== 'string' ||
      !update.currentVersion ||
      ![
        'idle',
        'checking',
        'current',
        'available',
        'downloading',
        'installing',
        'error',
      ].includes(update.phase) ||
      !Number.isSafeInteger(update.downloadedBytes) ||
      update.downloadedBytes < 0 ||
      (update.totalBytes !== null &&
        (!Number.isSafeInteger(update.totalBytes) || update.totalBytes < 0)) ||
      !['version', 'notes', 'error'].every(
        (key) => update[key] === null || typeof update[key] === 'string',
      ) ||
      (update.phase === 'available' && !update.version) ||
      (update.phase === 'error' && !update.error)
    ) {
      throw new Error('Desktop update state is invalid');
    }
    current = update;
    render();
  }

  async function refresh() {
    const expectedRevision = revision;
    const response = await sendAction({ action: 'getDesktopUpdateState' });
    if (revision === expectedRevision) accept(response.update);
  }

  check.addEventListener('click', async () => {
    check.disabled = true;
    try {
      const response = await sendAction({ action: 'checkDesktopUpdate' });
      accept(response.update);
    } catch (error) {
      showError(error.message);
      await refresh().catch((error) => showError(error.message));
    } finally {
      render();
    }
  });
  install.addEventListener('click', async () => {
    install.disabled = true;
    try {
      await sendAction({ action: 'installDesktopUpdate' });
    } catch (error) {
      showError(error.message);
      await refresh().catch((error) => showError(error.message));
    } finally {
      render();
    }
  });
  notice.addEventListener('click', async () => {
    await openSettings();
    document
      .getElementById('desktopUpdatesSection')
      .closest('.modal-group')
      .scrollIntoView({ block: 'start' });
  });

  return {
    render,
    refresh,
    async start() {
      await window.__TAURI__.event.listen('desktop-update-state', (event) => {
        revision += 1;
        try {
          accept(event.payload);
        } catch (error) {
          showError(error.message);
        }
      });
      await refresh();
    },
  };
}
