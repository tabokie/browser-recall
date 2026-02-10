// Options page for Portal extension
// Manages filesystem storage configuration and settings

const fsStorage = new FileSystemStorage();

// Load settings and update UI
async function loadSettings() {
  await updateStorageStatus();
  await updateStatistics();

  chrome.storage.local.get(['settings'], (result) => {
    const settings = result.settings || {};

    document.getElementById('captureContent').checked = settings.captureContent !== false;
    document.getElementById('captureAttention').checked = settings.captureAttention !== false;
    document.getElementById('archiveQuality').value = settings.archiveQuality || 'medium';
  });
}

// Update storage location display
async function updateStorageStatus() {
  const info = await fsStorage.getDirectoryInfo();

  const locationDiv = document.getElementById('storageLocation');
  const statusSpan = document.getElementById('storageStatus');
  const pathContainer = document.getElementById('storagePathContainer');
  const pathSpan = document.getElementById('storagePath');
  const selectBtn = document.getElementById('selectDirBtn');
  const changeBtn = document.getElementById('changeDirBtn');

  if (info && info.hasPermission) {
    locationDiv.className = 'storage-location';
    statusSpan.textContent = 'Connected';
    statusSpan.style.color = '#137333';
    pathContainer.style.display = 'block';
    pathSpan.textContent = info.name + '/';

    selectBtn.style.display = 'none';
    changeBtn.style.display = 'inline-block';
  } else {
    locationDiv.className = 'storage-location not-configured';
    statusSpan.textContent = 'Not configured - please select a directory';
    statusSpan.style.color = '#c5221f';
    pathContainer.style.display = 'none';

    selectBtn.style.display = 'inline-block';
    changeBtn.style.display = 'none';
  }
}

// Update statistics
async function updateStatistics() {
  try {
    // Try to load interactions from filesystem
    const interactions = await fsStorage.loadAllInteractions();

    document.getElementById('totalInteractions').textContent = interactions.length;

    const today = new Date().setHours(0, 0, 0, 0);
    const todayCount = interactions.filter(i => i.timestamp >= today).length;
    document.getElementById('todayInteractions').textContent = todayCount;
  } catch (error) {
    console.log('Could not load from filesystem:', error.message);
    document.getElementById('totalInteractions').textContent = '0';
    document.getElementById('todayInteractions').textContent = '0';
  }

  // Show buffer size
  chrome.storage.local.get(['writeBuffer'], (result) => {
    const buffer = result.writeBuffer || [];
    document.getElementById('bufferSize').textContent = buffer.length;
  });
}

// Select directory (first time or after clear)
document.getElementById('selectDirBtn').addEventListener('click', async () => {
  try {
    const result = await fsStorage.selectDirectory();

    if (result.success) {
      await updateStorageStatus();
      showStatus(`Storage location set: ${result.name}`, 'success');

      // Notify offscreen document
      chrome.runtime.sendMessage({ action: 'initializeFilesystem' });
    } else if (result.error !== 'User cancelled') {
      showStatus(`Error: ${result.error}`, 'error');
    }
  } catch (error) {
    showStatus(`Error selecting directory: ${error.message}`, 'error');
  }
});

// Change directory
document.getElementById('changeDirBtn').addEventListener('click', async () => {
  if (!confirm('Change storage directory? This will migrate all existing data to the new location.')) {
    return;
  }

  const changeDirBtn = document.getElementById('changeDirBtn');
  changeDirBtn.disabled = true;
  changeDirBtn.textContent = 'Changing...';

  try {
    // Load existing data (metadata + content)
    const oldInteractions = await fsStorage.loadAllInteractions();
    let oldContentMap = {};
    try {
      oldContentMap = await fsStorage.loadAllContent();
    } catch (error) {
      console.log('Could not load old content:', error.message);
    }

    // Also extract inline content from old-format interactions
    for (const interaction of oldInteractions) {
      if (interaction.content && interaction.slug && !oldContentMap[interaction.slug]) {
        oldContentMap[interaction.slug] = interaction.content;
      }
    }

    console.log(`Loaded ${oldInteractions.length} interactions and ${Object.keys(oldContentMap).length} content files from old location`);

    // Select new directory
    const result = await fsStorage.selectDirectory();

    if (!result.success) {
      if (result.error !== 'User cancelled') {
        showStatus(`Error: ${result.error}`, 'error');
      }
      changeDirBtn.disabled = false;
      changeDirBtn.textContent = 'Change Directory';
      return;
    }

    // Migrate data to new location (including content files)
    if (oldInteractions.length > 0) {
      showStatus(`Migrating ${oldInteractions.length} interactions...`, 'warning');

      const migrateResult = await fsStorage.writeAllInteractions(oldInteractions, oldContentMap);

      if (migrateResult.success) {
        showStatus(`Successfully migrated ${oldInteractions.length} interactions to ${result.name}`, 'success');
      } else {
        showStatus(`Error migrating data: ${migrateResult.error}`, 'error');
      }
    } else {
      showStatus(`Storage location changed to: ${result.name}`, 'success');
    }

    await updateStorageStatus();
    await updateStatistics();

    // Notify offscreen document
    chrome.runtime.sendMessage({ action: 'initializeFilesystem' });

  } catch (error) {
    showStatus(`Error changing directory: ${error.message}`, 'error');
  }

  changeDirBtn.disabled = false;
  changeDirBtn.textContent = 'Change Directory';
});

// Save settings on change
['captureContent', 'captureAttention', 'archiveQuality'].forEach(id => {
  const element = document.getElementById(id);
  element.addEventListener('change', () => {
    chrome.storage.local.get(['settings'], (result) => {
      const settings = result.settings || {};

      if (id === 'archiveQuality') {
        settings[id] = element.value;
      } else {
        settings[id] = element.checked;
      }

      chrome.storage.local.set({ settings });
      showStatus('Settings saved', 'success');
    });
  });
});

// Clear all data
document.getElementById('clearBtn').addEventListener('click', async () => {
  if (!confirm('WARNING: This will DELETE ALL FILES in your storage directory!\n\nThis cannot be undone. Are you absolutely sure?')) {
    return;
  }

  if (!confirm('Final confirmation: Delete all interaction history files?')) {
    return;
  }

  const clearBtn = document.getElementById('clearBtn');
  clearBtn.disabled = true;
  clearBtn.textContent = 'Clearing...';

  try {
    const info = await fsStorage.getDirectoryInfo();

    if (!info || !info.hasPermission) {
      showStatus('No storage directory configured', 'error');
      clearBtn.disabled = false;
      clearBtn.textContent = 'Clear All Data';
      return;
    }

    // Delete all .jsonl files and README
    await fsStorage.loadDirectoryHandle();
    let deletedCount = 0;

    for await (const entry of fsStorage.directoryHandle.values()) {
      if (entry.kind === 'file' && (entry.name.endsWith('.jsonl') || entry.name === 'README.md')) {
        await fsStorage.directoryHandle.removeEntry(entry.name);
        deletedCount++;
      }
    }

    // Delete pages/ directory recursively
    try {
      await fsStorage.directoryHandle.removeEntry('pages', { recursive: true });
      deletedCount++;
    } catch (error) {
      // pages/ directory may not exist
    }

    // Clear write buffer
    await chrome.storage.local.set({ writeBuffer: [] });

    showStatus(`Cleared ${deletedCount} files/directories`, 'success');
    await updateStatistics();

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

// Refresh statistics every 10 seconds
setInterval(updateStatistics, 10000);

// Call on page load
loadSettings();
